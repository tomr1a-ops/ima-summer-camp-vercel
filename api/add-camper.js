const { userScopedClient } = require('./lib/supabase');
const { getUserFromRequest, upsertParentProfile } = require('./lib/auth');

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

function serializeErr(e) {
  if (e == null) return 'Server error';
  if (typeof e === 'string') return e;
  if (e.message) return String(e.message);
  if (e.error_description) return String(e.error_description);
  try {
    return JSON.stringify(e);
  } catch {
    return 'Server error';
  }
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

module.exports = async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

  const { user, token } = await getUserFromRequest(req);
  if (!user || !token) return json(res, 401, { error: 'Sign in required' });

  let body = {};
  try {
    body = await readJsonBody(req);
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }

  const fn = String(body.firstName || '').trim();
  const ln = String(body.lastName || '').trim();
  const age = parseInt(body.age, 10);
  if (!fn || !ln || !Number.isFinite(age) || age < 3 || age > 18) {
    return json(res, 400, { error: 'Valid first name, last name, and age (3–18) required' });
  }

  try {
    await upsertParentProfile(user, {});
    const sb = userScopedClient(token);
    const { data, error } = await sb
      .from('campers')
      .insert({
        parent_id: user.id,
        first_name: fn,
        last_name: ln,
        age,
      })
      .select('id,first_name,last_name')
      .single();
    if (error) {
      console.error('[add-camper] insert', error);
      return json(res, 500, {
        error: error.message || 'Could not save camper',
        code: error.code,
        details: error.details,
      });
    }
    return json(res, 200, { camper: data });
  } catch (e) {
    console.error('[add-camper]', e);
    const code = e.statusCode && Number(e.statusCode) >= 400 ? e.statusCode : 500;
    return json(res, code, { error: serializeErr(e) });
  }
};
