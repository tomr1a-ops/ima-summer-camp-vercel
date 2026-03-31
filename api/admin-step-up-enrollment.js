/**
 * Admin: mark Step Up hold as paid (confirmed + parent email) or release (cancelled + free capacity).
 */
const { serviceClient } = require('./lib/supabase');
const { requireAdmin } = require('./lib/auth');
const { ENROLLMENT_STATUS } = require('./lib/enrollment-status');
const { syncConfirmedDayCounts } = require('./lib/capacity');
const { sendStepUpMarkedPaidEmail } = require('./lib/email');

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
    .select('id, status')
    .eq('id', enrollmentId)
    .maybeSingle();
  if (fe) return json(res, 500, { error: fe.message });
  if (!row || row.status !== ENROLLMENT_STATUS.PENDING_STEP_UP) {
    return json(res, 400, { error: 'Enrollment not found or not a Step Up hold' });
  }

  try {
    if (action === 'mark_paid') {
      const { data: updated, error: ue } = await sb
        .from('enrollments')
        .update({
          status: ENROLLMENT_STATUS.CONFIRMED,
          step_up_hold_expires_at: null,
        })
        .eq('id', row.id)
        .eq('status', ENROLLMENT_STATUS.PENDING_STEP_UP)
        .select('id')
        .maybeSingle();
      if (ue) throw ue;
      if (!updated) return json(res, 200, { ok: true, already: true });
      await sendStepUpMarkedPaidEmail(sb, row.id);
      return json(res, 200, { ok: true });
    }

    if (action === 'release_hold') {
      const { data: updated, error: ue } = await sb
        .from('enrollments')
        .update({
          status: ENROLLMENT_STATUS.CANCELLED,
          step_up_hold_expires_at: null,
        })
        .eq('id', row.id)
        .eq('status', ENROLLMENT_STATUS.PENDING_STEP_UP)
        .select('day_ids')
        .maybeSingle();
      if (ue) throw ue;
      if (!updated) return json(res, 200, { ok: true, already: true });
      await syncConfirmedDayCounts(sb, updated.day_ids || [], []);
      return json(res, 200, { ok: true });
    }

    return json(res, 400, { error: 'Unknown action' });
  } catch (e) {
    console.error('[admin-step-up-enrollment]', e && e.message ? e.message : e);
    return json(res, 500, { error: e.message || 'Server error' });
  }
};
