const { serviceClient } = require('./lib/supabase');
const { getUserFromRequest } = require('./lib/auth');
const { ENROLLMENT_STATUS } = require('./lib/enrollment-status');

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

async function readJsonBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') {
      try {
        return JSON.parse(req.body || '{}');
      } catch {
        return {};
      }
    }
    if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  }
  const chunks = [];
  try {
    for await (const chunk of req) chunks.push(chunk);
  } catch {
    return {};
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  return JSON.parse(raw);
}

/**
 * POST /api/abandon-checkout-batch
 * Parent returned from Stripe Checkout without paying (cancel link). Deletes `pending` rows for that batch
 * so capacity is not held by an abandoned card session.
 */
module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    return json(res, 405, { error: 'Method not allowed' });
  }
  const { user } = await getUserFromRequest(req);
  if (!user) {
    return json(res, 401, { error: 'Unauthorized' });
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  const batchId = body.batchId != null ? String(body.batchId).trim() : '';
  if (!batchId) {
    return json(res, 400, { error: 'batchId required' });
  }
  try {
    const sb = serviceClient();
    const { data: rows, error: qe } = await sb
      .from('enrollments')
      .select('id')
      .eq('checkout_batch_id', batchId)
      .eq('parent_id', user.id)
      .eq('status', ENROLLMENT_STATUS.PENDING);
    if (qe) throw qe;
    if (!rows || !rows.length) {
      return json(res, 200, { ok: true, deleted: 0 });
    }
    const { error: de } = await sb
      .from('enrollments')
      .delete()
      .eq('checkout_batch_id', batchId)
      .eq('parent_id', user.id)
      .eq('status', ENROLLMENT_STATUS.PENDING);
    if (de) throw de;
    return json(res, 200, { ok: true, deleted: rows.length });
  } catch (e) {
    console.error('[abandon-checkout-batch]', e && e.message ? e.message : e);
    return json(res, 500, { error: e.message || 'Could not release checkout' });
  }
};
