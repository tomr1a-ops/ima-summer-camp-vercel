/**
 * GET /api/admin-logins — auth users + profile names (admin only, service role).
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

const PROFILE_CHUNK = 150;
const USERS_PAGE = 200;

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
    logAdminAuthProbe(req, 'admin-logins');
    await requireAdmin(req);
  } catch (e) {
    return json(res, e.statusCode || 500, { error: e.message || 'Unauthorized' });
  }

  try {
    const sb = serviceClient();
    const users = [];
    let page = 1;
    for (;;) {
      const { data, error } = await sb.auth.admin.listUsers({ page, perPage: USERS_PAGE });
      if (error) throw error;
      const batch = (data && data.users) || [];
      users.push(...batch);
      if (batch.length < USERS_PAGE) break;
      page += 1;
    }

    const profileById = {};
    const ids = users.map((u) => u.id).filter(Boolean);
    for (let i = 0; i < ids.length; i += PROFILE_CHUNK) {
      const chunk = ids.slice(i, i + PROFILE_CHUNK);
      const { data: profs, error: pe } = await sb.from('profiles').select('id, full_name').in('id', chunk);
      if (pe) throw pe;
      (profs || []).forEach((p) => {
        profileById[String(p.id)] = p.full_name || '';
      });
    }

    const rows = users.map((u) => ({
      user_id: u.id,
      email: u.email || '',
      full_name: profileById[String(u.id)] || '',
      last_sign_in_at: u.last_sign_in_at || null,
      created_at: u.created_at || null,
    }));

    rows.sort((a, b) => {
      const aHas = a.last_sign_in_at ? 1 : 0;
      const bHas = b.last_sign_in_at ? 1 : 0;
      if (aHas !== bHas) return bHas - aHas;
      if (a.last_sign_in_at && b.last_sign_in_at) {
        const ta = new Date(a.last_sign_in_at).getTime();
        const tb = new Date(b.last_sign_in_at).getTime();
        if (tb !== ta) return tb - ta;
      }
      const ca = a.created_at ? new Date(a.created_at).getTime() : 0;
      const cb = b.created_at ? new Date(b.created_at).getTime() : 0;
      return cb - ca;
    });

    return json(res, 200, { logins: rows });
  } catch (e) {
    console.error('[admin-logins]', e && e.message ? e.message : e);
    return json(res, 500, { error: e.message || 'Failed to load logins' });
  }
};
