const getRawBody = require('raw-body');
const { confirmStripeSession } = require('./lib/confirm-stripe-session');
const { sendCampPaymentEmails } = require('./lib/email');
const { serviceClient } = require('./lib/supabase');
const { ENROLLMENT_STATUS } = require('./lib/enrollment-status');

function stripeClient() {
  const k = String(process.env.STRIPE_SECRET_KEY || '').trim();
  if (!k) throw new Error('STRIPE_SECRET_KEY not configured');
  return require('stripe')(k);
}

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
    const stripe = stripeClient();
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

  if (event.type === 'checkout.session.expired') {
    const session = event.data.object;
    const batchId = session.metadata && session.metadata.checkout_batch_id;
    if (batchId) {
      try {
        const sb = serviceClient();
        const { error: delErr } = await sb
          .from('enrollments')
          .delete()
          .eq('checkout_batch_id', String(batchId))
          .eq('status', ENROLLMENT_STATUS.PENDING);
        if (delErr) {
          console.error('[webhook] checkout.session.expired delete pending', delErr.message);
        } else {
          console.log('[webhook] checkout.session.expired — released pending batch', batchId);
        }
      } catch (e) {
        console.error('[webhook] checkout.session.expired', e && e.message ? e.message : e);
      }
    }
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    try {
      const stripe = stripeClient();
      const result = await confirmStripeSession(stripe, session);
      if (result.ok) {
        try {
          console.log('[webhook] checkout.session.completed — sending parent confirmation (Resend) for', session.id);
          await sendCampPaymentEmails(stripe, session, result);
          console.log('[webhook] payment emails finished for session', session.id);
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
