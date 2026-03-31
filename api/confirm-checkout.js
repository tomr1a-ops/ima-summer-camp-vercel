const { confirmStripeSession } = require('./lib/confirm-stripe-session');
const { sendCampPaymentEmails } = require('./lib/email');

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
    const sk = String(process.env.STRIPE_SECRET_KEY || '').trim();
    if (!sk) {
      res.statusCode = 503;
      return res.end(JSON.stringify({ error: 'Stripe is not configured on the server.' }));
    }
    const stripe = require('stripe')(sk);
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['customer_details', 'line_items'],
    });
    const result = await confirmStripeSession(stripe, session);
    if (result.ok) {
      try {
        await sendCampPaymentEmails(stripe, session, result);
        console.log('[confirm-checkout] payment emails finished for session', sessionId);
      } catch (mailErr) {
        console.error(
          '[confirm-checkout] payment emails error (non-fatal):',
          mailErr && mailErr.message ? mailErr.message : mailErr
        );
      }
    } else {
      console.log('[confirm-checkout] skip emails (confirm not ok)', sessionId, result && result.reason);
    }
    res.statusCode = 200;
    return res.end(JSON.stringify(result));
  } catch (e) {
    console.error(e);
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: e.message }));
  }
};
