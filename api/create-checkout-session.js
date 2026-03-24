const { randomUUID } = require('crypto');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { serviceClient } = require('./lib/supabase');
const { getUserFromRequest, getProfileForUser } = require('./lib/auth');
const { dayRate, registrationFee } = require('./lib/pricing');
const { validateBooking } = require('./lib/capacity');
const { sendResend } = require('./lib/email');

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

async function hasRegistrationFeePaid(sb, camperId) {
  const { count, error } = await sb
    .from('enrollments')
    .select('*', { count: 'exact', head: true })
    .eq('camper_id', camperId)
    .eq('status', 'confirmed')
    .eq('registration_fee_paid', true);
  if (error) throw error;
  return (count || 0) > 0;
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
  return JSON.parse(raw);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

  let body = {};
  try {
    body = await readJsonBody(req);
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }

  const { bookings, testPricing, guest } = body;
  const secret = process.env.STRIPE_SECRET_KEY || '';
  const isStripeTestKey = secret.startsWith('sk_test_');

  let tp = !!testPricing;
  if (tp && !isStripeTestKey) {
    return json(res, 403, { error: 'Test pricing requires Stripe test secret key.' });
  }

  if (!Array.isArray(bookings) || !bookings.length) {
    return json(res, 400, { error: 'No bookings' });
  }

  const sb = serviceClient();
  const { user } = await getUserFromRequest(req);
  let parentId = null;
  let profile = null;
  let guestEmailForStripe = null;
  let camperId = body.camperId || null;

  if (guest && guest.email && guest.firstName && guest.lastName && guest.age != null) {
    if (user) return json(res, 400, { error: 'Use camperId when signed in, not guest object' });
    const email = String(guest.email).trim().toLowerCase();
    guestEmailForStripe = email;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json(res, 400, { error: 'Invalid guest email' });
    }
    const age = parseInt(guest.age, 10);
    if (!Number.isFinite(age) || age < 3 || age > 18) {
      return json(res, 400, { error: 'Invalid child age' });
    }
    const { data: ins, error: insE } = await sb
      .from('campers')
      .insert({
        parent_id: null,
        first_name: String(guest.firstName).trim(),
        last_name: String(guest.lastName).trim(),
        age,
      })
      .select('id')
      .single();
    if (insE) return json(res, 500, { error: insE.message });
    camperId = ins.id;
    parentId = null;
  } else if (user) {
    profile = await getProfileForUser(user.id);
    if (!profile) return json(res, 403, { error: 'Profile missing' });
    parentId = user.id;
    if (!camperId) return json(res, 400, { error: 'camperId required when signed in' });
    const { data: camper, error: ce } = await sb.from('campers').select('id, parent_id').eq('id', camperId).single();
    if (ce || !camper) return json(res, 400, { error: 'Camper not found' });
    if (camper.parent_id !== user.id) return json(res, 403, { error: 'Not your camper' });
  } else {
    return json(res, 401, { error: 'Sign in and pick a camper, or use guest checkout (child + email).' });
  }

  const rate = dayRate(tp);
  const regFee = registrationFee(tp);
  const batchId = randomUUID();

  for (const b of bookings) {
    const weekId = b.weekId;
    const dayIds = Array.isArray(b.dayIds) ? b.dayIds : [];
    try {
      await validateBooking(sb, {
        weekId,
        dayIds,
        camperId,
        excludeEnrollmentId: null,
      });
    } catch (e) {
      return json(res, e.statusCode || 400, { error: e.message });
    }
  }

  const needsReg = !(await hasRegistrationFeePaid(sb, camperId));
  const regCents = needsReg ? Math.round(regFee * 100) : 0;

  const line_items = [];
  for (const b of bookings) {
    const n = (b.dayIds || []).length;
    const { data: week } = await sb.from('weeks').select('label').eq('id', b.weekId).single();
    line_items.push({
      price_data: {
        currency: 'usd',
        product_data: {
          name: `IMA Summer Camp — ${week ? week.label : 'Week'}`,
          description: `${n} day${n === 1 ? '' : 's'} × $${rate}`,
        },
        unit_amount: Math.round(n * rate * 100),
      },
      quantity: 1,
    });
  }

  if (regCents > 0) {
    line_items.push({
      price_data: {
        currency: 'usd',
        product_data: {
          name: 'One-Time Registration Fee',
          description: 'Impact Training Shirt + Protective Punching Gloves',
        },
        unit_amount: regCents,
      },
      quantity: 1,
    });
  }

  for (const b of bookings) {
    const { error: ie } = await sb.from('enrollments').insert({
      parent_id: parentId,
      camper_id: camperId,
      week_id: b.weekId,
      day_ids: b.dayIds,
      price_paid: 0,
      registration_fee_paid: false,
      status: 'pending',
      checkout_batch_id: batchId,
    });
    if (ie) return json(res, 500, { error: ie.message });
  }

  const baseUrl = (process.env.BASE_URL || '').replace(/\/$/, '');
  const emailForStripe = guestEmailForStripe || (profile && profile.email) || null;
  try {
    const sessionParams = {
      payment_method_types: ['card'],
      mode: 'payment',
      line_items,
      success_url: `${baseUrl}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/index.html`,
      metadata: {
        checkout_batch_id: batchId,
        test_pricing: tp ? 'true' : 'false',
        registration_fee_cents: String(regCents),
      },
    };
    if (emailForStripe) sessionParams.customer_email = emailForStripe;
    const session = await stripe.checkout.sessions.create(sessionParams);

    try {
      await sendResend({
        to: ['tom@imaimpact.com', 'coachshick@imaimpact.com'],
        subject: 'IMA — checkout session started',
        text:
          'Someone opened Stripe Checkout (payment may still be in progress).\n\n' +
          'Session: ' +
          session.id +
          '\nBatch: ' +
          batchId +
          '\nEmail: ' +
          (emailForStripe || 'n/a') +
          '\n',
      });
    } catch (notifyErr) {
      console.warn('Resend (checkout started):', notifyErr.message);
    }

    return json(res, 200, { sessionId: session.id, batchId });
  } catch (err) {
    console.error('Stripe error:', err.message);
    await sb.from('enrollments').delete().eq('checkout_batch_id', batchId);
    return json(res, 500, { error: err.message });
  }
};
