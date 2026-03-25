const { randomUUID } = require('crypto');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { serviceClient } = require('./lib/supabase');
const { getUserFromRequest, upsertParentProfile } = require('./lib/auth');
const { dayRate, weekRate, registrationFee } = require('./lib/pricing');
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

  const { bookings, testPricing, guest, imaMember } = body;
  const guestMode = !!(guest && guest.email && guest.firstName && guest.lastName && guest.age != null);
  const secret = process.env.STRIPE_SECRET_KEY || '';
  const isStripeTestKey = secret.startsWith('sk_test_');

  let tp = !!testPricing;
  if (tp && !isStripeTestKey) {
    return json(res, 403, { error: 'Test pricing requires Stripe test secret key.' });
  }

  if (!Array.isArray(bookings) || !bookings.length) {
    return json(res, 400, { error: 'No bookings' });
  }

  const { user, token } = await getUserFromRequest(req);
  let parentId = null;
  let profile = null;
  let guestEmailForStripe = null;
  let guestCamperId = null;
  let sb = null;

  if (guestMode) {
    if (user) return json(res, 400, { error: 'Use per-week camper selections when signed in, not guest object' });
    try {
      sb = serviceClient();
    } catch (e) {
      return json(res, 503, {
        error:
          'Guest checkout needs SUPABASE_SERVICE_ROLE_KEY on the server. Sign in with a parent account or add the service role key in Vercel.',
      });
    }
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
    guestCamperId = ins.id;
    parentId = null;
  } else if (user) {
    if (!token) return json(res, 401, { error: 'Sign in required' });
    try {
      sb = serviceClient();
    } catch (e) {
      return json(res, 503, {
        error:
          'Checkout needs SUPABASE_SERVICE_ROLE_KEY on the server. Add it in Vercel → Environment Variables → Production, then redeploy.',
        code: 'MISSING_SERVICE_ROLE',
      });
    }
    try {
      profile = await upsertParentProfile(user, {});
    } catch (pe) {
      return json(res, pe.statusCode || 500, { error: pe.message });
    }
    parentId = user.id;
    for (const b of bookings) {
      if (!b.camperId) {
        return json(res, 400, { error: 'Each week needs a child selected (camperId on each booking).' });
      }
    }
    const seen = new Set();
    for (const b of bookings) {
      const cid = b.camperId;
      if (seen.has(cid)) continue;
      seen.add(cid);
      const { data: camper, error: ce } = await sb.from('campers').select('id, parent_id').eq('id', cid).single();
      if (ce || !camper) return json(res, 400, { error: 'Camper not found' });
      if (camper.parent_id !== user.id) return json(res, 403, { error: 'Not your camper' });
    }
  } else {
    return json(res, 401, { error: 'Sign in to register, or use guest checkout (child + email).' });
  }

  const dr = dayRate(tp);
  const wr = weekRate(tp);
  const regFee = registrationFee(tp);
  const batchId = randomUUID();
  const bookingModes = [];

  for (const b of bookings) {
    const weekId = b.weekId;
    const dayIds = Array.isArray(b.dayIds) ? b.dayIds : [];
    const pricingMode = b.pricingMode === 'full_week' ? 'full_week' : 'daily';
    const cid = guestMode ? guestCamperId : b.camperId;
    try {
      await validateBooking(sb, {
        weekId,
        dayIds,
        camperId: cid,
        excludeEnrollmentId: null,
        pricingMode,
      });
    } catch (e) {
      return json(res, e.statusCode || 400, { error: e.message });
    }
    bookingModes.push(pricingMode);
  }

  const uniqueCampers = guestMode
    ? [guestCamperId]
    : [...new Set(bookings.map((b) => b.camperId).filter(Boolean))];
  const regLineItems = [];
  let regCentsTotal = 0;
  for (const cid of uniqueCampers) {
    const needs = !(await hasRegistrationFeePaid(sb, cid));
    if (needs) {
      const cents = Math.round(regFee * 100);
      regCentsTotal += cents;
      const { data: cm } = await sb.from('campers').select('first_name,last_name').eq('id', cid).single();
      const label = cm ? `${cm.first_name} ${cm.last_name}`.trim() : 'Camper';
      regLineItems.push({ cents, label });
    }
  }

  const line_items = [];
  for (let i = 0; i < bookings.length; i++) {
    const b = bookings[i];
    const mode = bookingModes[i];
    const n = (b.dayIds || []).length;
    const { data: week } = await sb.from('weeks').select('label').eq('id', b.weekId).single();
    const wlabel = week ? week.label : 'Week';
    if (mode === 'full_week') {
      line_items.push({
        price_data: {
          currency: 'usd',
          product_data: {
            name: `IMA Summer Camp — ${wlabel} (full week)`,
            description: `Mon–Fri · $${wr}/week`,
          },
          unit_amount: Math.round(wr * 100),
        },
        quantity: 1,
      });
    } else {
      line_items.push({
        price_data: {
          currency: 'usd',
          product_data: {
            name: `IMA Summer Camp — ${wlabel}`,
            description: `${n} day${n === 1 ? '' : 's'} × $${dr}`,
          },
          unit_amount: Math.round(n * dr * 100),
        },
        quantity: 1,
      });
    }
  }

  for (const r of regLineItems) {
    line_items.push({
      price_data: {
        currency: 'usd',
        product_data: {
          name: 'One-Time Registration Fee',
          description: `${r.label} — Impact Training Shirt + Protective Punching Gloves`,
        },
        unit_amount: r.cents,
      },
      quantity: 1,
    });
  }

  for (const b of bookings) {
    const cid = guestMode ? guestCamperId : b.camperId;
    const { error: ie } = await sb.from('enrollments').insert({
      parent_id: parentId,
      camper_id: cid,
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
        registration_fee_cents: String(regCentsTotal),
        booking_modes: bookingModes.join(','),
        ima_member: imaMember ? 'true' : 'false',
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
