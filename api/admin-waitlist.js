/**
 * GET /api/admin-waitlist — per-week waitlist queue (admin only).
 */
const { serviceClient } = require('./lib/supabase');
const { requireAdmin } = require('./lib/auth');
const { setNoStoreJsonHeaders } = require('./lib/http-no-store');

function json(res, code, body) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  setNoStoreJsonHeaders(res);
  res.end(JSON.stringify(body));
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  setNoStoreJsonHeaders(res);
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    return res.status(204).end();
  }
  if (req.method !== 'GET') {
    return json(res, 405, { error: 'Method not allowed' });
  }

  try {
    await requireAdmin(req);
  } catch (e) {
    return json(res, e.statusCode || 500, { error: e.message || 'Unauthorized' });
  }

  try {
    const sb = serviceClient();
    const { data: weeks, error: we } = await sb
      .from('weeks')
      .select('id, label, week_number')
      .order('week_number', { ascending: true });
    if (we) throw we;

    const { data: wlRows, error: wle } = await sb
      .from('waitlist')
      .select('id, camper_id, week_id, parent_id, position, status, offered_at, expires_at, created_at')
      .order('week_id', { ascending: true })
      .order('position', { ascending: true })
      .order('created_at', { ascending: true });
    if (wle) throw wle;

    const camperIds = [...new Set((wlRows || []).map((r) => r.camper_id).filter(Boolean))];
    const parentIds = [...new Set((wlRows || []).map((r) => r.parent_id).filter(Boolean))];

    const camperMap = {};
    if (camperIds.length) {
      const { data: campers, error: ce } = await sb.from('campers').select('id, first_name, last_name').in('id', camperIds);
      if (ce) throw ce;
      (campers || []).forEach((c) => {
        camperMap[String(c.id)] = `${c.first_name || ''} ${c.last_name || ''}`.trim() || '—';
      });
    }

    const parentMap = {};
    if (parentIds.length) {
      const { data: profs, error: pe } = await sb.from('profiles').select('id, full_name, email').in('id', parentIds);
      if (pe) throw pe;
      (profs || []).forEach((p) => {
        parentMap[String(p.id)] = {
          name: (p.full_name && String(p.full_name).trim()) || '—',
          email: (p.email && String(p.email).trim()) || '',
        };
      });
    }

    const byWeek = {};
    (weeks || []).forEach((w) => {
      byWeek[String(w.id)] = {
        weekId: w.id,
        label: w.label,
        week_number: w.week_number,
        waitingCount: 0,
        entries: [],
      };
    });

    (wlRows || []).forEach((r) => {
      const wid = String(r.week_id);
      if (!byWeek[wid]) {
        byWeek[wid] = {
          weekId: r.week_id,
          label: '',
          week_number: null,
          waitingCount: 0,
          entries: [],
        };
      }
      if (r.status === 'waiting') byWeek[wid].waitingCount += 1;
      const pinfo = parentMap[String(r.parent_id)] || { name: '—', email: '' };
      byWeek[wid].entries.push({
        id: r.id,
        position: r.position,
        status: r.status,
        offered_at: r.offered_at,
        expires_at: r.expires_at,
        created_at: r.created_at,
        childName: camperMap[String(r.camper_id)] || '—',
        parentName: pinfo.name,
        parentEmail: pinfo.email,
      });
    });

    const weekList = (weeks || []).map((w) => {
      const b = byWeek[String(w.id)];
      return b || { weekId: w.id, label: w.label, week_number: w.week_number, waitingCount: 0, entries: [] };
    });

    const orphanWeekIds = Object.keys(byWeek).filter((id) => !(weeks || []).some((w) => String(w.id) === id));
    orphanWeekIds.forEach((id) => {
      weekList.push(byWeek[id]);
    });

    return json(res, 200, { weeks: weekList });
  } catch (e) {
    console.error('[admin-waitlist]', e && e.message ? e.message : e);
    return json(res, 500, { error: e.message || 'Server error' });
  }
};
