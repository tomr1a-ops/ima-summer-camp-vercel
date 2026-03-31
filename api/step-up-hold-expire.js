/**
 * Cron: cancel expired Step Up holds and decrement day capacity.
 * Authorization: Bearer CRON_SECRET (same as backup-cron).
 */
const { serviceClient } = require('./lib/supabase');
const { ENROLLMENT_STATUS } = require('./lib/enrollment-status');
const { syncConfirmedDayCounts } = require('./lib/capacity');
const { tryPromoteWaitlistAfterEnrollmentRemoved, notifyWaitlistOffer } = require('./lib/waitlist-service');
const { isMissingStepUpHoldExpiresColumn } = require('./lib/step-up-hold-column');

function json(res, code, body) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function bearer(req) {
  const h = req.headers.authorization || req.headers.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : '';
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  const secret = process.env.CRON_SECRET;
  if (!secret || bearer(req) !== secret) {
    return json(res, 403, { error: 'Forbidden' });
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    return json(res, 405, { error: 'Method not allowed' });
  }

  const nowIso = new Date().toISOString();
  const sb = serviceClient();

  try {
    const { data: expired, error: qe } = await sb
      .from('enrollments')
      .select('id, day_ids, week_id')
      .eq('status', ENROLLMENT_STATUS.PENDING_STEP_UP)
      .not('step_up_hold_expires_at', 'is', null)
      .lt('step_up_hold_expires_at', nowIso);
    if (qe && isMissingStepUpHoldExpiresColumn(qe)) {
      return json(res, 200, { ok: true, skipped: true, reason: 'step_up_hold_expires_at column missing' });
    }
    if (qe) throw qe;

    let released = 0;
    for (const row of expired || []) {
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
      if (ue) {
        console.error('[step-up-hold-expire] update', row.id, ue.message);
        continue;
      }
      if (!updated) continue;
      await syncConfirmedDayCounts(sb, updated.day_ids || [], []);
      released++;
      if (row.week_id) {
        try {
          const nid = await tryPromoteWaitlistAfterEnrollmentRemoved(sb, row.week_id);
          if (nid) await notifyWaitlistOffer(sb, nid);
        } catch (wlE) {
          console.error('[step-up-hold-expire] waitlist promote', wlE && wlE.message);
        }
      }
    }

    return json(res, 200, { ok: true, candidates: (expired || []).length, released });
  } catch (e) {
    console.error('[step-up-hold-expire]', e && e.message ? e.message : e);
    return json(res, 500, { error: e.message || 'Server error' });
  }
};
