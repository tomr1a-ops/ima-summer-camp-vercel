const { getUserFromRequest, upsertParentProfile } = require('./lib/auth');

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
 * POST — Create/update profiles row (service role upsert after JWT verification).
 * Use after sign-in when no profile row exists, or to sync name/phone.
 */
module.exports = async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

  const { user, token } = await getUserFromRequest(req);
  if (!user || !token) return json(res, 401, { error: 'Unauthorized' });

  let body = {};
  try {
    body = await readJsonBody(req);
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }

  try {
    const profile = await upsertParentProfile(user, {
      full_name: body.fullName || body.full_name,
      phone: body.phone,
    });
    return json(res, 200, { profile });
  } catch (e) {
    const code = e.statusCode && Number(e.statusCode) >= 400 ? e.statusCode : 500;
    console.error('[ensure-profile]', e);
    return json(res, code, { error: e.message || 'Server error' });
  }
};
