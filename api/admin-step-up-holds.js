/**
 * Admin-only: pending_step_up enrollments with camper, week, and parent (profile) for Step Up Holds UI.
 */
const { serviceClient } = require('./lib/supabase');
const { requireAdmin } = require('./lib/auth');
const { ENROLLMENT_STATUS } = require('./lib/enrollment-status');

function json(res, code, body) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.end(JSON.stringify(body));
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });

  try {
    await requireAdmin(req);
  } catch (e) {
    return json(res, e.statusCode || 500, { error: e.message || 'Unauthorized' });
  }

  const sb = serviceClient();

  const selectWithExpiry =
    'id,parent_id,camper_id,week_id,status,day_ids,guest_email,created_at,step_up_hold_expires_at,' +
    'campers(first_name,last_name),' +
    'weeks(label,week_number)';

  const selectBase =
    'id,parent_id,camper_id,week_id,status,day_ids,guest_email,created_at,' +
    'campers(first_name,last_name),' +
    'weeks(label,week_number)';

  try {
    let rows;
    let qe;
    const first = await sb
      .from('enrollments')
      .select(selectWithExpiry)
      .eq('status', ENROLLMENT_STATUS.PENDING_STEP_UP)
      .order('created_at', { ascending: false });
    rows = first.data;
    qe = first.error;
    if (qe) {
      const msg = (qe.message || '') + (qe.details || '');
      if (/step_up_hold_expires_at|column|schema cache/i.test(msg)) {
        const second = await sb
          .from('enrollments')
          .select(selectBase)
          .eq('status', ENROLLMENT_STATUS.PENDING_STEP_UP)
          .order('created_at', { ascending: false });
        rows = second.data;
        qe = second.error;
      }
    }
    if (qe) throw qe;

    const list = rows || [];
    const parentIds = [...new Set(list.map((r) => r.parent_id).filter(Boolean))];
    let profilesById = {};
    if (parentIds.length) {
      const { data: profs, error: pe } = await sb
        .from('profiles')
        .select('id,full_name,email')
        .in('id', parentIds);
      if (pe) throw pe;
      (profs || []).forEach((p) => {
        profilesById[String(p.id)] = { full_name: p.full_name, email: p.email };
      });
    }

    const holds = list.map((r) => ({
      ...r,
      profiles: r.parent_id ? profilesById[String(r.parent_id)] || null : null,
    }));

    return json(res, 200, { holds });
  } catch (e) {
    console.error('[admin-step-up-holds]', e && e.message ? e.message : e);
    return json(res, 500, { error: e.message || 'Server error' });
  }
};
