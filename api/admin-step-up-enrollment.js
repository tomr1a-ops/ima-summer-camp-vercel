/**
 * Admin: mark Step Up hold as paid (confirmed + parent email) or release (cancelled + free capacity).
 */
const { serviceClient } = require('./lib/supabase');
const { requireAdmin } = require('./lib/auth');
const { ENROLLMENT_STATUS } = require('./lib/enrollment-status');
const { syncConfirmedDayCounts } = require('./lib/capacity');
const { sendStepUpMarkedPaidEmail } = require('./lib/email');
const { isMissingStepUpHoldExpiresColumn } = require('./lib/step-up-hold-column');
const { isCampRegistrationFeePaid } = require('./lib/camper-registration-fee');
const { registrationFee } = require('./lib/pricing');
const { tryPromoteWaitlistAfterEnrollmentRemoved, notifyWaitlistOffer } = require('./lib/waitlist-service');

function json(res, code, body) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    return {};
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

  try {
    await requireAdmin(req);
  } catch (e) {
    return json(res, e.statusCode || 500, { error: e.message || 'Unauthorized' });
  }

  const body = await readJsonBody(req);
  const enrollmentId = body && body.enrollmentId;
  const action = body && body.action;
  if (!enrollmentId || !action) {
    return json(res, 400, { error: 'enrollmentId and action required' });
  }

  const sb = serviceClient();
  const { data: row, error: fe } = await sb
    .from('enrollments')
    .select(
      'id, status, camper_id, parent_id, price_paid, registration_fee_paid, checkout_batch_id, day_ids, week_id'
    )
    .eq('id', enrollmentId)
    .maybeSingle();
  if (fe) return json(res, 500, { error: fe.message });
  if (!row || row.status !== ENROLLMENT_STATUS.PENDING_STEP_UP) {
    return json(res, 400, { error: 'Enrollment not found or not a Step Up hold' });
  }

  try {
    if (action === 'mark_paid') {
      const regAlreadyPaid = await isCampRegistrationFeePaid(sb, row.camper_id);
      const regDollars = regAlreadyPaid ? 0 : registrationFee(false);
      const prevPrice = Number(row.price_paid) || 0;
      const nextPrice = prevPrice + regDollars;
      /** Child has (or just received) one-time reg fee — flag row so admin + previews never look “unpaid”. */
      const registrationSatisfiedOnRow = regAlreadyPaid || regDollars > 0;

      const updateFields = {
        status: ENROLLMENT_STATUS.CONFIRMED,
        step_up_hold_expires_at: null,
        price_paid: nextPrice,
        registration_fee_paid: registrationSatisfiedOnRow,
      };

      let { data: updated, error: ue } = await sb
        .from('enrollments')
        .update(updateFields)
        .eq('id', row.id)
        .eq('status', ENROLLMENT_STATUS.PENDING_STEP_UP)
        .select('id')
        .maybeSingle();
      if (ue && isMissingStepUpHoldExpiresColumn(ue)) {
        const retryFields = {
          status: ENROLLMENT_STATUS.CONFIRMED,
          price_paid: nextPrice,
          registration_fee_paid: registrationSatisfiedOnRow,
        };
        const r2 = await sb
          .from('enrollments')
          .update(retryFields)
          .eq('id', row.id)
          .eq('status', ENROLLMENT_STATUS.PENDING_STEP_UP)
          .select('id')
          .maybeSingle();
        updated = r2.data;
        ue = r2.error;
      }
      if (ue) throw ue;
      if (!updated) return json(res, 200, { ok: true, already: true });

      if (row.camper_id) {
        if (regDollars > 0) {
          await sb.from('campers').update({ registration_fee_paid: true }).eq('id', row.camper_id);
          if (row.checkout_batch_id) {
            await sb
              .from('enrollments')
              .update({ registration_fee_paid: true })
              .eq('checkout_batch_id', row.checkout_batch_id)
              .eq('camper_id', row.camper_id);
          }
        } else if (regAlreadyPaid && row.checkout_batch_id) {
          /** Reg paid before Step Up (e.g. card); align sibling batch rows for admin/export. */
          await sb
            .from('enrollments')
            .update({ registration_fee_paid: true })
            .eq('checkout_batch_id', row.checkout_batch_id)
            .eq('camper_id', row.camper_id)
            .in('status', [ENROLLMENT_STATUS.CONFIRMED, ENROLLMENT_STATUS.PENDING_STEP_UP]);
        }
      }

      await sendStepUpMarkedPaidEmail(sb, row.id);
      return json(res, 200, {
        ok: true,
        pricePaid: nextPrice,
        registrationFeeApplied: regDollars,
      });
    }

    if (action === 'release_hold') {
      let { data: updated, error: ue } = await sb
        .from('enrollments')
        .update({
          status: ENROLLMENT_STATUS.CANCELLED,
          step_up_hold_expires_at: null,
        })
        .eq('id', row.id)
        .eq('status', ENROLLMENT_STATUS.PENDING_STEP_UP)
        .select('day_ids')
        .maybeSingle();
      if (ue && isMissingStepUpHoldExpiresColumn(ue)) {
        const r2 = await sb
          .from('enrollments')
          .update({ status: ENROLLMENT_STATUS.CANCELLED })
          .eq('id', row.id)
          .eq('status', ENROLLMENT_STATUS.PENDING_STEP_UP)
          .select('day_ids')
          .maybeSingle();
        updated = r2.data;
        ue = r2.error;
      }
      if (ue) throw ue;
      if (!updated) return json(res, 200, { ok: true, already: true });
      await syncConfirmedDayCounts(sb, updated.day_ids || [], []);
      if (row.week_id) {
        try {
          const nid = await tryPromoteWaitlistAfterEnrollmentRemoved(sb, row.week_id);
          if (nid) await notifyWaitlistOffer(sb, nid);
        } catch (wlE) {
          console.error('[admin-step-up-enrollment] waitlist promote', wlE && wlE.message);
        }
      }
      return json(res, 200, { ok: true });
    }

    return json(res, 400, { error: 'Unknown action' });
  } catch (e) {
    console.error('[admin-step-up-enrollment]', e && e.message ? e.message : e);
    return json(res, 500, { error: e.message || 'Server error' });
  }
};
