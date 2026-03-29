const { serviceClient, anonClient } = require('./supabase');

function bearerToken(req) {
  const h = req.headers.authorization || req.headers.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

async function getUserFromRequest(req) {
  const token = bearerToken(req);
  if (!token) return { user: null, token: null };
  try {
    const sb = anonClient();
    const { data, error } = await sb.auth.getUser(token);
    /* Keep `token` so callers can tell “Authorization sent but JWT invalid/expired” vs missing header. */
    if (error || !data.user) return { user: null, token };
    return { user: data.user, token };
  } catch (e) {
    console.warn('[auth] getUserFromRequest', e && e.message);
    return { user: null, token };
  }
}

/** Load profile by id using service role (JWT already validated by caller when userId comes from getUser). */
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

function resolveUserEmail(user) {
  if (!user) return '';
  const a = String(user.email || '')
    .trim()
    .toLowerCase();
  if (a) return a;
  const meta = user.user_metadata || {};
  const b = String(meta.email || meta.primary_email || meta.email_address || '')
    .trim()
    .toLowerCase();
  if (b) return b;
  const ids = user.identities || [];
  for (let i = 0; i < ids.length; i++) {
    const ie = ids[i] && ids[i].identity_data && ids[i].identity_data.email;
    if (ie) return String(ie).trim().toLowerCase();
  }
  return '';
}

/**
 * Ensures public.profiles has a row for this auth user (campers.parent_id FK targets profiles.id).
 * Uses the service role so INSERT succeeds even when RLS would block anon/JWT-only writes.
 * Preserves an existing role (e.g. admin); new rows default to parent.
 * @param {object} [extras] — optional full_name, phone (used after registration)
 */
async function upsertParentProfile(user, extras) {
  if (!user || !user.id) return null;
  const email = resolveUserEmail(user);
  if (!email) {
    const err = new Error(
      'Account email required to complete parent profile. Add an email to your account or sign in with a provider that supplies one.'
    );
    err.statusCode = 400;
    throw err;
  }
  const sb = serviceClient();
  const existing = await getProfileForUser(user.id);
  const fnIn = extras && extras.full_name != null ? String(extras.full_name).trim() : '';
  const phIn = extras && extras.phone != null ? String(extras.phone).trim() : '';
  const row = {
    id: user.id,
    email,
    full_name: fnIn || (existing && existing.full_name) || null,
    phone: phIn || (existing && existing.phone) || null,
    role: (existing && existing.role) || 'parent',
  };
  const { data: rows, error } = await sb
    .from('profiles')
    .upsert(row, { onConflict: 'id' })
    .select('id,email,full_name,phone,role');
  if (error) throw error;
  if (rows && rows[0]) return rows[0];
  const { data: again, error: e2 } = await sb
    .from('profiles')
    .select('id,email,full_name,phone,role')
    .eq('id', user.id)
    .maybeSingle();
  if (e2) throw e2;
  return again;
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
  resolveUserEmail,
  upsertParentProfile,
  requireParent,
  requireAdmin,
};
