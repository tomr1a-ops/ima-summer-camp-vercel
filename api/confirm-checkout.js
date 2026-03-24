const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { confirmStripeSession } = require('./lib/confirm-stripe-session');

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

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: 'Method not allowed' }));
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: 'Invalid JSON' }));
  }
  const sessionId = body.sessionId || body.session_id;
  if (!sessionId) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: 'sessionId required' }));
  }
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['customer_details'],
    });
    const result = await confirmStripeSession(stripe, session);
    res.statusCode = 200;
    return res.end(JSON.stringify(result));
  } catch (e) {
    console.error(e);
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: e.message }));
  }
};
