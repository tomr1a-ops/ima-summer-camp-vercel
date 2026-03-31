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
    .select('id,email,full_name,phone,role,waiver_signed,waiver_signed_at')
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
 * Greeting / display name for emails when profiles.full_name is empty (common for OAuth-only accounts).
 * Order: profile.full_name → auth user_metadata → friendly local-part of email.
 */
function resolveParentDisplayName(user, profile) {
  if (profile && String(profile.full_name || '').trim()) {
    return String(profile.full_name).trim();
  }
  if (user && user.user_metadata && typeof user.user_metadata === 'object') {
    const m = user.user_metadata;
    const parts = [m.first_name, m.last_name].map((x) => String(x || '').trim()).filter(Boolean);
    if (parts.length) return parts.join(' ');
    const metaName = String(m.full_name || m.name || m.display_name || '').trim();
    if (metaName) return metaName;
  }
  const em = resolveUserEmail(user);
  if (em) {
    const local = em.split('@')[0] || '';
    const cleaned = local.replace(/[.+_]/g, ' ').replace(/\s+/g, ' ').trim();
    if (cleaned) {
      return cleaned.replace(/\b\w/g, (ch) => ch.toUpperCase());
    }
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
  const fromAuthMeta = resolveParentDisplayName(user, existing);
  const row = {
    id: user.id,
    email,
    full_name: fnIn || (existing && existing.full_name) || fromAuthMeta || null,
    phone: phIn || (existing && existing.phone) || null,
    role: (existing && existing.role) || 'parent',
  };
  const { data: rows, error } = await sb
    .from('profiles')
    .upsert(row, { onConflict: 'id' })
    .select('id,email,full_name,phone,role,waiver_signed,waiver_signed_at');
  if (error) throw error;
  if (rows && rows[0]) return rows[0];
  const { data: again, error: e2 } = await sb
    .from('profiles')
    .select('id,email,full_name,phone,role,waiver_signed,waiver_signed_at')
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

/** Base list; merge with ADMIN_EMAIL_ALLOWLIST / IMA_ADMIN_EMAILS (comma-separated) in env. */
const ADMIN_LOGIN_EMAIL_BASE = ['tom@imaimpact.com', 'coachshick@imaimpact.com'];

let _adminEmailAllowlistCache = null;
function getAdminEmailAllowlist() {
  if (_adminEmailAllowlistCache) return _adminEmailAllowlistCache;
  const envRaw = process.env.ADMIN_EMAIL_ALLOWLIST || process.env.IMA_ADMIN_EMAILS || '';
  const fromEnv = envRaw
    .split(/[,;\s]+/)
    .map((s) => String(s || '').trim().toLowerCase())
    .filter(Boolean);
  _adminEmailAllowlistCache = [...new Set([...ADMIN_LOGIN_EMAIL_BASE.map((e) => e.toLowerCase()), ...fromEnv])];
  return _adminEmailAllowlistCache;
}

function isAdminLoginEmail(email) {
  const e = String(email || '')
    .trim()
    .toLowerCase();
  if (!e) return false;
  return getAdminEmailAllowlist().indexOf(e) !== -1;
}

/** Same rule as admin API routes: profiles.role admin, or allowlisted staff email (JWT or profile row). */
function canAccessAdminPortal(user, profile) {
  if (!profile) return false;
  const roleNorm = String(profile.role || '').trim().toLowerCase();
  if (roleNorm === 'admin') return true;
  const userEmail = resolveUserEmail(user);
  const profileEmail = profile.email ? String(profile.email).trim().toLowerCase() : '';
  return isAdminLoginEmail(userEmail) || isAdminLoginEmail(profileEmail);
}

function maskToken(t) {
  if (!t || typeof t !== 'string') return '(none)';
  if (t.length <= 14) return '(len=' + t.length + ')';
  return t.slice(0, 8) + '…' + t.slice(-4) + ' (len=' + t.length + ')';
}

/** Call from admin route handlers: logs Authorization presence before validation. */
function logAdminAuthProbe(req, routeLabel) {
  try {
    const raw = bearerToken(req);
    const path = (req && (req.url || req.path)) || '';
    console.log(
      '[admin-auth]',
      JSON.stringify({
        route: routeLabel || path,
        hasBearer: !!raw,
        tokenMask: maskToken(raw),
      })
    );
  } catch (e) {
    console.warn('[admin-auth] logAdminAuthProbe', e && e.message);
  }
}

async function requireAdmin(req) {
  const path = (req && (req.url || req.path)) || '';
  const rawTok = bearerToken(req);
  const { user, token } = await getUserFromRequest(req);
  if (!user) {
    console.warn(
      '[admin-auth]',
      JSON.stringify({
        path,
        step: 'jwt_invalid_or_missing_user',
        hasBearer: !!rawTok,
        tokenMask: maskToken(rawTok),
      })
    );
    const err = new Error('Unauthorized');
    err.statusCode = 401;
    throw err;
  }
  const profile = await getProfileForUser(user.id);
  const userEmail = resolveUserEmail(user);
  const profileEmail = profile && profile.email ? String(profile.email).trim().toLowerCase() : '';
  const adminByRole = profile ? String(profile.role || '').trim().toLowerCase() === 'admin' : false;
  const adminByEmail =
    profile && (isAdminLoginEmail(userEmail) || isAdminLoginEmail(profileEmail));
  const portalOk = profile && canAccessAdminPortal(user, profile);

  if (!profile) {
    console.warn(
      '[admin-auth]',
      JSON.stringify({
        path,
        step: 'no_profile_row',
        userId: user.id,
        userEmail,
        tokenMask: maskToken(rawTok),
      })
    );
    const err = new Error('Admin only');
    err.statusCode = 403;
    throw err;
  }
  if (!portalOk) {
    console.warn(
      '[admin-auth]',
      JSON.stringify({
        path,
        step: 'forbidden_not_admin',
        userId: user.id,
        userEmail,
        profileEmail,
        profileRole: profile.role,
        adminByRole,
        adminByEmail,
        allowlistCount: getAdminEmailAllowlist().length,
      })
    );
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
  resolveParentDisplayName,
  upsertParentProfile,
  requireParent,
  requireAdmin,
  isAdminLoginEmail,
  canAccessAdminPortal,
  logAdminAuthProbe,
  getAdminEmailAllowlist,
};
