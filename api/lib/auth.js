const { serviceClient } = require('./supabase');

function bearerToken(req) {
  const h = req.headers.authorization || req.headers.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

async function getUserFromRequest(req) {
  const token = bearerToken(req);
  if (!token) return { user: null, token: null };
  const sb = serviceClient();
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data.user) return { user: null, token: null };
  return { user: data.user, token };
}

async function getProfileForUser(userId) {
  const sb = serviceClient();
  const { data, error } = await sb
    .from('profiles')
    .select('id,email,full_name,phone,role')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function requireParent(req) {
  const { user, token } = await getUserFromRequest(req);
  if (!user) {
    const err = new Error('Unauthorized');
    err.statusCode = 401;
    throw err;
  }
  const profile = await getProfileForUser(user.id);
  if (!profile || profile.role !== 'parent') {
    const err = new Error('Parent access only');
    err.statusCode = 403;
    throw err;
  }
  return { user, profile, token };
}

async function requireAdmin(req) {
  const { user, token } = await getUserFromRequest(req);
  if (!user) {
    const err = new Error('Unauthorized');
    err.statusCode = 401;
    throw err;
  }
  const profile = await getProfileForUser(user.id);
  if (!profile || profile.role !== 'admin') {
    const err = new Error('Admin only');
    err.statusCode = 403;
    throw err;
  }
  return { user, profile, token };
}

module.exports = {
  bearerToken,
  getUserFromRequest,
  getProfileForUser,
  requireParent,
  requireAdmin,
};
