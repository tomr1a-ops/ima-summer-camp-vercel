/**
 * GET /api/admin-session — profiles.role from DB (service role) + whether user may open admin portal.
 * Used by admin-login.html right after sign-in (client Supabase profile can lag RLS/session).
 */
const {
  getUserFromRequest,
  getProfileForUser,
  canAccessAdminPortal: checkAdminPortalAccess,
} = require('./lib/auth');
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
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });

  const { user } = await getUserFromRequest(req);
  if (!user) return json(res, 401, { error: 'Unauthorized' });

  let profile;
  try {
    profile = await getProfileForUser(user.id);
  } catch (e) {
    console.error('[admin-session]', e && e.message);
    return json(res, 500, { error: e.message || 'Server error' });
  }

  const roleNorm = profile ? String(profile.role || '').trim().toLowerCase() : '';
  const roleIsAdmin = roleNorm === 'admin';
  const canAccessAdminPortal = !!(profile && checkAdminPortalAccess(user, profile));

  return json(res, 200, {
    role: profile ? profile.role : null,
    roleIsAdmin,
    canAccessAdminPortal,
  });
};
