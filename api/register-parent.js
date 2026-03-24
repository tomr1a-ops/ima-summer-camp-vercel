const { serviceClient } = require('./lib/supabase');
const { upsertParentProfile } = require('./lib/auth');

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

async function readJsonBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (Buffer.isBuffer(req.body)) {
      try {
        return JSON.parse(req.body.toString('utf8') || '{}');
      } catch {
        return {};
      }
    }
    if (typeof req.body === 'string') {
      try {
        return JSON.parse(req.body || '{}');
      } catch {
        return {};
      }
    }
    if (typeof req.body === 'object') return req.body;
  }
  const chunks = [];
  try {
    for await (const chunk of req) chunks.push(chunk);
  } catch {
    return {};
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * POST — Create a confirmed parent account (no email-confirmation step).
 * Client should signInWithPassword immediately after success.
 */
module.exports = async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

  let body = {};
  try {
    body = await readJsonBody(req);
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }

  const email = String(body.email || '')
    .trim()
    .toLowerCase();
  const password = String(body.password || '');
  const fullName = String(body.fullName || body.full_name || '').trim();
  const phone = String(body.phone || '').trim();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json(res, 400, { error: 'Invalid email' });
  }
  if (password.length < 8) {
    return json(res, 400, { error: 'Password must be at least 8 characters' });
  }
  if (!fullName) return json(res, 400, { error: 'Full name required' });
  if (!phone) return json(res, 400, { error: 'Phone required' });

  const sb = serviceClient();
  const { data: created, error: ce } = await sb.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName, phone },
  });

  if (ce) {
    const msg = ce.message || 'Registration failed';
    if (/already|registered|exists|duplicate/i.test(msg)) {
      return json(res, 409, { error: 'An account with this email already exists. Sign in instead.' });
    }
    return json(res, 400, { error: msg });
  }

  const user = created && created.user;
  if (!user || !user.id) {
    return json(res, 500, { error: 'Could not create account' });
  }

  const userForProfile = {
    id: user.id,
    email: user.email || email,
    user_metadata: { full_name: fullName, phone },
  };

  try {
    await upsertParentProfile(userForProfile, { full_name: fullName, phone });
  } catch (pe) {
    console.error('[register-parent] profile', pe);
    return json(res, 500, { error: pe.message || 'Could not save profile' });
  }

  return json(res, 200, { ok: true });
};
