/**
 * GET /api/admin-agreements — summer camp policy agreement_records (admin only).
 */
const { serviceClient } = require('./lib/supabase');
const { requireAdmin, logAdminAuthProbe } = require('./lib/auth');
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
    logAdminAuthProbe(req, 'admin-agreements');
    await requireAdmin(req);
  } catch (e) {
    return json(res, e.statusCode || 500, { error: e.message || 'Unauthorized' });
  }

  try {
    const sb = serviceClient();
    const { data: rows, error } = await sb
      .from('agreement_records')
      .select(
        'id, parent_id, parent_name, email, ip_address, agreed_at, agreement_version, camper_ids, acknowledgment_email_sent'
      )
      .order('agreed_at', { ascending: false })
      .limit(500);
    if (error) throw error;

    const allCamperIds = new Set();
    (rows || []).forEach((r) => {
      (r.camper_ids || []).forEach((id) => {
        if (id) allCamperIds.add(String(id));
      });
    });
    const camperLabels = {};
    const ids = [...allCamperIds];
    if (ids.length) {
      const { data: campers, error: ce } = await sb
        .from('campers')
        .select('id, first_name, last_name')
        .in('id', ids);
      if (!ce && campers) {
        campers.forEach((c) => {
          const nm = `${c.first_name || ''} ${c.last_name || ''}`.trim();
          camperLabels[String(c.id)] = nm || String(c.id);
        });
      }
    }

    const agreements = (rows || []).map((r) => {
      const names = (r.camper_ids || []).map((id) => camperLabels[String(id)] || String(id)).filter(Boolean);
      return {
        id: r.id,
        parent_id: r.parent_id,
        parent_name: r.parent_name,
        email: r.email,
        ip_address: r.ip_address,
        agreed_at: r.agreed_at,
        agreement_version: r.agreement_version,
        acknowledgment_email_sent: !!r.acknowledgment_email_sent,
        camper_count: (r.camper_ids || []).length,
        camper_names: names,
      };
    });

    return json(res, 200, { agreements });
  } catch (e) {
    console.error('[admin-agreements]', e && e.message ? e.message : e);
    return json(res, 500, { error: e.message || 'Failed to load agreements' });
  }
};
