const getRawBody = require('raw-body');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { confirmStripeSession } = require('./lib/confirm-stripe-session');
const { sendCampPaymentEmails } = require('./lib/email');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.end('Method not allowed');
  }

  const sig = req.headers['stripe-signature'];
  const whSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!whSecret) {
    res.statusCode = 500;
    return res.end('STRIPE_WEBHOOK_SECRET not configured');
  }

  let event;
  try {
    const buf = await getRawBody(req, {
      length: req.headers['content-length'],
      limit: '2mb',
    });
    event = stripe.webhooks.constructEvent(buf, sig, whSecret);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    res.statusCode = 400;
    return res.end(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    try {
      const result = await confirmStripeSession(stripe, session);
      if (result.ok) {
        /** Receipt + staff notify: loads enrollments by stripe_session_id + Stripe metadata (see lib/email.js). */
        await sendCampPaymentEmails(stripe, session, result);
      }
    } catch (e) {
      console.error('confirmStripeSession', e);
      res.statusCode = 500;
      return res.end('handler error');
    }
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ received: true }));
};
