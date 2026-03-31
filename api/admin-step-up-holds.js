/**
 * Admin-only: pending_step_up enrollments with camper, week, and parent (profile) for Step Up Holds UI.
 */
const { serviceClient } = require('./lib/supabase');
const { requireAdmin } = require('./lib/auth');
const { ENROLLMENT_STATUS } = require('./lib/enrollment-status');
const { registrationFee } = require('./lib/pricing');

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
    'id,parent_id,camper_id,week_id,status,day_ids,guest_email,created_at,step_up_hold_expires_at,price_paid,registration_fee_paid,' +
    'campers(first_name,last_name,registration_fee_paid),' +
    'weeks(label,week_number)';

  const selectBase =
    'id,parent_id,camper_id,week_id,status,day_ids,guest_email,created_at,price_paid,registration_fee_paid,' +
    'campers(first_name,last_name,registration_fee_paid),' +
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

    const regFeeDollars = registrationFee(false);
    const listArr = list || [];
    const firstHoldRowIdByCamper = new Map();
    listArr.forEach((r) => {
      const cid = String(r.camper_id || '');
      if (!cid) return;
      const wn = Number(r.weeks && r.weeks.week_number) || 0;
      const prev = firstHoldRowIdByCamper.get(cid);
      if (prev == null || wn < prev.wn) {
        firstHoldRowIdByCamper.set(cid, { wn, id: String(r.id) });
      }
    });
    const holds = listArr.map((r) => {
      let camp = Number(r.price_paid);
      if (!Number.isFinite(camp) || camp < 0) camp = 0;
      const camper = r.campers || {};
      const camperRegPaid = camper.registration_fee_paid === true;
      const cid = String(r.camper_id || '');
      let regDollars = 0;
      if (!camperRegPaid && cid) {
        const first = firstHoldRowIdByCamper.get(cid);
        if (first && first.id === String(r.id)) {
          regDollars = regFeeDollars;
        }
      } else if (!r.camper_id) {
        regDollars = regFeeDollars;
      }
      const amount_owed = camp + regDollars;
      return {
        ...r,
        profiles: r.parent_id ? profilesById[String(r.parent_id)] || null : null,
        amount_owed,
      };
    });

    return json(res, 200, { holds });
  } catch (e) {
    console.error('[admin-step-up-holds]', e && e.message ? e.message : e);
    return json(res, 500, { error: e.message || 'Server error' });
  }
};
