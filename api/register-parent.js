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

function errText(e) {
  if (e == null) return 'Unknown error';
  if (typeof e === 'string') return e;
  if (e.message) return String(e.message);
  try {
    return JSON.stringify(e);
  } catch {
    return 'Unknown error';
  }
}

/**
 * POST — Create a confirmed parent account (no email-confirmation step).
 * Client should signInWithPassword immediately after success.
 */
module.exports = async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

  try {
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

    let sb;
    try {
      sb = serviceClient();
    } catch (cfgErr) {
      console.error('[register-parent] config', cfgErr);
      return json(res, 503, {
        error:
          'Server is missing Supabase credentials (service role key). Add SUPABASE_SERVICE_ROLE_KEY to this Vercel project.',
      });
    }

    const { data: created, error: ce } = await sb.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName, phone },
    });

    if (ce) {
      const msg = ce.message || 'Registration failed';
      const code = ce.code || ce.status;
      console.warn('[register-parent] createUser', msg, code);
      if (/already|registered|exists|duplicate|user_already_exists/i.test(msg + String(code))) {
        return json(res, 409, { error: 'An account with this email already exists. Sign in instead.' });
      }
      return json(res, 400, { error: msg, code: code || undefined });
    }

    const user = created && created.user;
    if (!user || !user.id) {
      console.error('[register-parent] empty user', created);
      return json(res, 500, {
        error:
          'Account was not created (empty response from auth). Check Supabase Auth logs and that signups are allowed.',
      });
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
      return json(res, 500, { error: errText(pe) });
    }

    return json(res, 200, { ok: true });
  } catch (e) {
    console.error('[register-parent] fatal', e);
    return json(res, 500, { error: errText(e) });
  }
};
