const { serviceClient } = require('./lib/supabase');
const { getUserFromRequest } = require('./lib/auth');
const { setNoStoreJsonHeaders } = require('./lib/http-no-store');
const {
  validateBooking,
  syncConfirmedDayCounts,
  loadOrderedDaysForWeek,
  camperHasEnrollmentInWeek,
} = require('./lib/capacity');
const {
  campCreditCentsForConfirmedRow,
  campCreditBucketForConfirmedRow,
  addFamilyCampLedgerWeekCents,
  addFamilyCampLedgerDayCents,
  ledgerPaymentMethodForEnrollment,
} = require('./lib/family-camp-ledger');
const { enrollmentQualifiesForCampCredit } = require('./lib/enrollment-credit-eligibility');
const { ENROLLMENT_STATUS } = require('./lib/enrollment-status');
const { tryPromoteWaitlistAfterEnrollmentRemoved, notifyWaitlistOffer } = require('./lib/waitlist-service');
const { weekRate } = require('./lib/pricing');
const { isMissingStepUpHoldExpiresColumn } = require('./lib/step-up-hold-column');

async function readJsonBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (Buffer.isBuffer(req.body)) {
      try {
        return JSON.parse(req.body.toString('utf8') || '{}');
      } catch {
        return {};
      }
    }
    if (typeof req.body === 'string') {
      try {
        return JSON.parse(req.body || '{}');
      } catch {
        return {};
      }
    }
    if (typeof req.body === 'object') return req.body;
  }
  const chunks = [];
  try {
    for await (const chunk of req) chunks.push(chunk);
  } catch {
    return {};
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  return JSON.parse(raw);
}

function enrollmentRowPaidViaStripe(row) {
  if (!row) return false;
  if (row.stripe_session_id != null && String(row.stripe_session_id).trim() !== '') return true;
  if (row.checkout_batch_id != null && String(row.checkout_batch_id).trim() !== '') return true;
  return false;
}

function rowStatusNorm(row) {
  return String(row && row.status != null ? row.status : '')
    .trim()
    .toLowerCase();
}

/** Full-week rows this portal rail may add/remove in one batch (credit card vs Step Up). */
function isPortalBatchManageableRow(row, paymentMethod) {
  if (!row) return false;
  const st = rowStatusNorm(row);
  if (st === 'cancelled') return false;
  const pm = paymentMethod === 'step_up' ? 'step_up' : 'credit_card';
  if (pm === 'credit_card') {
    if (st === ENROLLMENT_STATUS.PENDING_STEP_UP) return false;
    if (st === ENROLLMENT_STATUS.PENDING) return true;
    if (st === ENROLLMENT_STATUS.CONFIRMED) return enrollmentRowPaidViaStripe(row);
    return false;
  }
  if (st === ENROLLMENT_STATUS.PENDING) return false;
  if (st === ENROLLMENT_STATUS.PENDING_STEP_UP) return true;
  if (st === ENROLLMENT_STATUS.CONFIRMED) return !enrollmentRowPaidViaStripe(row);
  return false;
}

function rowCoversFullWeek(row, orderedDayIds) {
  if (!orderedDayIds || orderedDayIds.length !== 5) return false;
  const set = new Set((row.day_ids || []).map((x) => String(x)));
  return orderedDayIds.every((id) => set.has(String(id)));
}

async function inferPricingModeForWeek(sb, weekId, dayIds) {
  const ids = Array.isArray(dayIds) ? dayIds : [];
  const allDays = await loadOrderedDaysForWeek(sb, weekId);
  if (allDays.length !== 5 || ids.length !== 5) return 'daily';
  const expectedIds = allDays.map((d) => d.id).sort().join(',');
  const gotIds = [...ids].sort().join(',');
  return expectedIds === gotIds ? 'full_week' : 'daily';
}

/** @returns {Promise<number>} family camp ledger credits added (cents) from this cancellation */
async function cancelEnrollmentRow(sb, user, row, testPricing) {
  let ledgerCreditCents = 0;
  const st = rowStatusNorm(row);
  const tp = !!testPricing;
  if (st === ENROLLMENT_STATUS.CONFIRMED || st === ENROLLMENT_STATUS.PENDING_STEP_UP) {
    await syncConfirmedDayCounts(sb, row.day_ids || [], []);
    if (st === ENROLLMENT_STATUS.PENDING_STEP_UP) {
      const cents = await campCreditCentsForConfirmedRow(sb, row, tp);
      console.log('[portal-commit-weeks] cancel row step_up credit eval', {
        enrollmentId: row.id,
        cents,
        testPricing: tp,
        dayIdsLen: (row.day_ids || []).length,
      });
      if (cents > 0) {
        ledgerCreditCents += cents;
        const bucket = await campCreditBucketForConfirmedRow(sb, row);
        if (bucket === 'week') await addFamilyCampLedgerWeekCents(sb, user.id, cents, 'step_up');
        else await addFamilyCampLedgerDayCents(sb, user.id, cents, 'step_up');
        console.log('[portal-commit-weeks] ledger add step_up ok', { enrollmentId: row.id, cents, bucket });
      }
    } else {
      const qualifies = enrollmentQualifiesForCampCredit(row);
      const cents = await campCreditCentsForConfirmedRow(sb, row, tp);
      const bucket = await campCreditBucketForConfirmedRow(sb, row);
      const pm = ledgerPaymentMethodForEnrollment(row);
      console.log('[portal-commit-weeks] cancel row confirmed credit eval', {
        enrollmentId: row.id,
        rawStatus: row.status,
        normalizedStatus: st,
        qualifies,
        stripe: enrollmentRowPaidViaStripe(row),
        checkoutBatchId: row.checkout_batch_id,
        pricePaid: row.price_paid,
        cents,
        bucket,
        ledgerPm: pm,
        testPricing: tp,
      });
      const allowCredit = qualifies || enrollmentRowPaidViaStripe(row);
      if (cents > 0 && allowCredit) {
        ledgerCreditCents += cents;
        if (bucket === 'week') await addFamilyCampLedgerWeekCents(sb, user.id, cents, pm);
        else await addFamilyCampLedgerDayCents(sb, user.id, cents, pm);
        console.log('[portal-commit-weeks] ledger add confirmed ok', { enrollmentId: row.id, cents, bucket, pm });
      } else {
        console.log('[portal-commit-weeks] skip ledger confirmed', {
          enrollmentId: row.id,
          cents,
          qualifies,
          allowCredit,
          paidViaStripe: enrollmentRowPaidViaStripe(row),
        });
      }
    }
  }
  const { error: ue } = await sb
    .from('enrollments')
    .update({ status: ENROLLMENT_STATUS.CANCELLED })
    .eq('id', row.id);
  if (ue) throw ue;
  if (
    row.week_id &&
    (st === ENROLLMENT_STATUS.CONFIRMED ||
      st === ENROLLMENT_STATUS.PENDING_STEP_UP ||
      st === ENROLLMENT_STATUS.PENDING)
  ) {
    try {
      const nid = await tryPromoteWaitlistAfterEnrollmentRemoved(sb, row.week_id);
      if (nid) await notifyWaitlistOffer(sb, nid);
    } catch (wlE) {
      console.error('[portal-commit-weeks] waitlist', wlE && wlE.message);
    }
  }
  return ledgerCreditCents;
}

function pairKey(weekId, camperId) {
  return String(weekId) + '|' + String(camperId);
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  setNoStoreJsonHeaders(res);
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: 'Method not allowed' }));
  }

  try {
    const { user } = await getUserFromRequest(req);
    if (!user) {
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: 'Unauthorized' }));
    }

    const body = await readJsonBody(req);
    const selectedWeeks = body && body.selectedWeeks;
    if (!selectedWeeks || typeof selectedWeeks !== 'object' || Array.isArray(selectedWeeks)) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: 'selectedWeeks object required (weekId -> camperId[])' }));
    }

    const pmRaw = body && body.paymentMethod != null ? String(body.paymentMethod).trim().toLowerCase() : '';
    const paymentMethod = pmRaw === 'step_up' ? 'step_up' : 'credit_card';
    const testPricing = !!(body && body.testPricing);

    const sb = serviceClient();
    const { data: enrollments, error: enrErr } = await sb
      .from('enrollments')
      .select('*')
      .eq('parent_id', user.id)
      .order('created_at', { ascending: false });
    if (enrErr) throw enrErr;

    const dayListCache = new Map();
    async function dayIdsForWeek(weekId) {
      const k = String(weekId);
      if (dayListCache.has(k)) return dayListCache.get(k);
      const days = await loadOrderedDaysForWeek(sb, weekId);
      const ids = (days || []).map((d) => d.id);
      dayListCache.set(k, ids);
      return ids;
    }

    const desired = new Set();
    for (const wId of Object.keys(selectedWeeks)) {
      const arr = selectedWeeks[wId];
      if (!Array.isArray(arr)) continue;
      for (let i = 0; i < arr.length; i++) {
        desired.add(pairKey(wId, arr[i]));
      }
    }

    const manageableFullWeekRows = [];
    for (const row of enrollments || []) {
      if (!isPortalBatchManageableRow(row, paymentMethod)) continue;
      const dlist = await dayIdsForWeek(row.week_id);
      if (!rowCoversFullWeek(row, dlist)) continue;
      manageableFullWeekRows.push(row);
    }

    const currentKeys = new Set(manageableFullWeekRows.map((r) => pairKey(r.week_id, r.camper_id)));
    const toCancel = manageableFullWeekRows.filter((r) => !desired.has(pairKey(r.week_id, r.camper_id)));

    const toAdd = [];
    for (const key of desired) {
      if (currentKeys.has(key)) continue;
      const pipe = key.indexOf('|');
      const weekId = key.slice(0, pipe);
      const camperId = key.slice(pipe + 1);
      const { data: camper, error: ce } = await sb.from('campers').select('parent_id').eq('id', camperId).single();
      if (ce || !camper || String(camper.parent_id) !== String(user.id)) {
        res.statusCode = 403;
        return res.end(JSON.stringify({ error: 'Invalid camper in selection' }));
      }
      const hasOther = await camperHasEnrollmentInWeek(sb, weekId, camperId, null);
      if (hasOther) {
        res.statusCode = 400;
        return res.end(
          JSON.stringify({
            error:
              'One or more selections conflict with an existing registration (e.g. the other payment portal). Use camp registration to adjust.',
          })
        );
      }
      toAdd.push({ weekId, camperId });
    }

    console.log('[portal-commit-weeks] batch plan', {
      userId: user.id,
      paymentMethod,
      testPricing,
      selectedWeeksKeyCount: Object.keys(selectedWeeks).length,
      desiredPairs: desired.size,
      manageableRows: manageableFullWeekRows.length,
      toCancel: toCancel.map((r) => ({
        id: r.id,
        status: r.status,
        week_id: r.week_id,
        camper_id: r.camper_id,
      })),
      toAddCount: toAdd.length,
    });

    let netLedgerCreditCents = 0;
    for (let i = 0; i < toCancel.length; i++) {
      netLedgerCreditCents += await cancelEnrollmentRow(sb, user, toCancel[i], testPricing);
    }

    const wrVal = weekRate(testPricing);
    const holdExpiresIso = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    for (let j = 0; j < toAdd.length; j++) {
      const { weekId, camperId } = toAdd[j];
      const dayIds = await dayIdsForWeek(weekId);
      if (dayIds.length !== 5) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: 'Week must have five camp days' }));
      }
      const pricingMode = await inferPricingModeForWeek(sb, weekId, dayIds);
      await validateBooking(sb, {
        weekId,
        dayIds,
        camperId,
        excludeEnrollmentId: null,
        pricingMode,
      });
      if (paymentMethod === 'step_up') {
        const baseRow = {
          parent_id: user.id,
          camper_id: camperId,
          week_id: weekId,
          day_ids: dayIds,
          status: ENROLLMENT_STATUS.PENDING_STEP_UP,
          price_paid: wrVal,
          registration_fee_paid: false,
          stripe_session_id: null,
          step_up_hold_expires_at: holdExpiresIso,
        };
        let ins = await sb.from('enrollments').insert(baseRow);
        if (ins.error && isMissingStepUpHoldExpiresColumn(ins.error)) {
          const retryRow = Object.assign({}, baseRow);
          delete retryRow.step_up_hold_expires_at;
          ins = await sb.from('enrollments').insert(retryRow);
        }
        if (ins.error) throw ins.error;
        await syncConfirmedDayCounts(sb, [], dayIds);
      } else {
        const { error: insE } = await sb.from('enrollments').insert({
          parent_id: user.id,
          camper_id: camperId,
          week_id: weekId,
          day_ids: dayIds,
          status: ENROLLMENT_STATUS.PENDING,
          price_paid: 0,
          registration_fee_paid: false,
        });
        if (insE) throw insE;
      }
    }

    const outBody = { ok: true, netLedgerCreditCents };
    console.log('[portal-commit-weeks] batch done', outBody);
    res.statusCode = 200;
    return res.end(JSON.stringify(outBody));
  } catch (e) {
    const code = e.statusCode || 500;
    res.statusCode = code;
    return res.end(JSON.stringify({ error: e.message || 'Server error' }));
  }
};
