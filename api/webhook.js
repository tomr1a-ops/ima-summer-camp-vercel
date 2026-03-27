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
        try {
          /** Parent confirmation + staff paid-booking emails (Resend). Failures are logged; we still 200 Stripe. */
          await sendCampPaymentEmails(stripe, session, result);
        } catch (emailErr) {
          console.error('[webhook] sendCampPaymentEmails failed:', emailErr && emailErr.message ? emailErr.message : emailErr);
        }
      } else {
        console.warn('[webhook] confirmStripeSession not ok:', result.reason || JSON.stringify(result));
      }
    } catch (e) {
      console.error('[webhook] confirmStripeSession failed:', e && e.message ? e.message : e);
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ error: 'confirm failed' }));
    }
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ received: true }));
};
