const { randomUUID } = require('crypto');
/** Basil: required for wallet_options.link.display (reduces Link UI churn / amount flicker on hosted Checkout). */
const STRIPE_API_VERSION = '2025-04-30.basil';
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION });
const { serviceClient } = require('./lib/supabase');
const { getUserFromRequest, upsertParentProfile } = require('./lib/auth');
const { dayRate, weekRate, registrationFee, extraCampShirt } = require('./lib/pricing');
/** Full-week bookings that overlap a camper's already-confirmed days fail here with a specific message (see validateBooking in ./lib/capacity). */
const { validateBooking } = require('./lib/capacity');
const { sendCheckoutStartedAdminNotify } = require('./lib/email');
const { formatMoney } = require('./lib/booking-email-summary');

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

/** Log + JSON error body (code helps client / support). */
function failCheckout(res, httpStatus, code, message, logDetail) {
  const detail = logDetail !== undefined ? logDetail : '';
  console.error('[create-checkout-session]', code || 'ERROR', message, detail);
  res.statusCode = httpStatus;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: message, code: code || 'ERROR' }));
}

/** Stable camper id key for maps (UUID casing differs between client and DB). */
function normCamperKey(id) {
  if (id == null) return '';
  const s = String(id).trim();
  return s ? s.toLowerCase() : '';
}

/**
 * Stripe requires absolute success/cancel URLs. Prefer BASE_URL, then VERCEL_URL, then request Host.
 */
function publicSiteBaseUrl(req) {
  const raw = (process.env.BASE_URL || '').trim().replace(/\/$/, '');
  if (raw) {
    if (/^https?:\/\//i.test(raw)) return raw;
    return `https://${raw}`;
  }
  const vercel = (process.env.VERCEL_URL || '').trim().replace(/\/$/, '');
  if (vercel) {
    if (/^https?:\/\//i.test(vercel)) return vercel;
    return `https://${vercel}`;
  }
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '')
    .split(',')[0]
    .trim();
  const proto = String(req.headers['x-forwarded-proto'] || 'https')
    .split(',')[0]
    .trim()
    .replace(/:$/, '');
  const p = proto === 'http' || proto === 'https' ? proto : 'https';
  if (host) return `${p}://${host}`;
  return '';
}

/**
 * index.html uses camelCase; older clients may send snake_case. Coerce dayIds if sent as object map.
 */
function normalizeIncomingBookings(rawBookings) {
  if (!Array.isArray(rawBookings)) return [];
  const out = [];
  for (let i = 0; i < rawBookings.length; i++) {
    const b = rawBookings[i];
    if (!b || typeof b !== 'object') {
      console.warn('[create-checkout-session] BOOKING_SKIP index=%s (not an object)', i);
      continue;
    }
    const weekId = b.weekId != null ? b.weekId : b.week_id;
    const camperId = b.camperId != null ? b.camperId : b.camper_id;
    let dayIds = b.dayIds != null ? b.dayIds : b.day_ids;
    if (!Array.isArray(dayIds)) {
      if (dayIds && typeof dayIds === 'object') {
        dayIds = Object.keys(dayIds)
          .filter((k) => /^\d+$/.test(String(k)))
          .sort((a, b) => Number(a) - Number(b))
          .map((k) => dayIds[k]);
      } else {
        dayIds = [];
      }
    }
    const pm = b.pricingMode != null ? b.pricingMode : b.pricing_mode;
    const pricingMode =
      pm === 'full_week' || pm === 'weekly' || pm === 'full' || pm === 'fullWeek' ? 'full_week' : 'daily';

    const ck = normCamperKey(camperId);
    if (weekId == null || String(weekId).trim() === '' || !ck) {
      console.warn('[create-checkout-session] BOOKING_SKIP index=%s missing weekId/camperId keys=%j', i, Object.keys(b));
      continue;
    }
    const idList = [...new Set(dayIds.map((id) => String(id).trim()).filter(Boolean))];
    out.push({
      weekId: String(weekId).trim(),
      camperId: ck,
      dayIds: idList,
      pricingMode,
    });
  }
  return out;
}

async function hasRegistrationFeePaid(sb, camperId) {
  const { data, error } = await sb
    .from('enrollments')
    .select('id')
    .eq('camper_id', String(camperId))
    .eq('status', 'confirmed')
    .eq('registration_fee_paid', true)
    .limit(1);
  if (error) throw error;
  return !!(data && data.length);
}

/** Normalize client map so lookups always use string keys (JSON keys are strings; camper ids may vary). */
function normalizeRegFeeChoice(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  Object.keys(raw).forEach((k) => {
    const nk = normCamperKey(k);
    if (nk) out[nk] = raw[k];
  });
  return out;
}

/** Camper ids (string) -> true when parent opted into an extra T-shirt add-on. */
function normalizeExtraShirtChoice(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  Object.keys(raw).forEach((k) => {
    const v = raw[k];
    const nk = normCamperKey(k);
    if (nk && (v === true || v === 1 || v === 'true' || v === '1')) out[nk] = true;
  });
  return out;
}

/**
 * Client sends registrationFeeForCamper[camperId]:
 *   true  = charge $65 registration if not already paid (non–IMA member)
 *   false = IMA member — waive registration for this checkout
 * Missing key defaults to charge (same as true).
 */
function regFeeWaivedByParentChoice(regFeeChoice, camperId) {
  if (!regFeeChoice) return false;
  const v = regFeeChoice[normCamperKey(camperId)];
  if (v == null) return false;
  if (v === false || v === 0) return true;
  if (typeof v === 'string' && (v.toLowerCase() === 'false' || v === '0')) return true;
  return false;
}

async function readJsonBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (Buffer.isBuffer(req.body)) {
      const s = req.body.toString('utf8');
      if (!s || !String(s).trim()) return {};
      return JSON.parse(s);
    }
    if (typeof req.body === 'string') {
      const s = req.body || '';
      if (!String(s).trim()) return {};
      return JSON.parse(s);
    }
    if (typeof req.body === 'object') return req.body;
  }
  const chunks = [];
  try {
    for await (const chunk of req) chunks.push(chunk);
  } catch (streamErr) {
    throw streamErr;
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!String(raw).trim()) return {};
  return JSON.parse(raw);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

  let body = {};
  try {
    body = await readJsonBody(req);
  } catch (parseErr) {
    return failCheckout(res, 400, 'INVALID_JSON', 'Invalid JSON', parseErr && parseErr.message ? parseErr.message : '');
  }

  try {
    console.log('[create-checkout-session] incoming body', JSON.stringify(body));
  } catch (logErr) {
    console.log('[create-checkout-session] incoming body (could not stringify)', typeof body);
  }

  const { testPricing, imaMember, registrationFeeForCamper, extraShirtByCamper } = body;
  const rawBookings = Array.isArray(body.bookings) ? body.bookings : [];
  let bookingsArray = normalizeIncomingBookings(rawBookings);
  if (rawBookings.length > 0 && bookingsArray.length === 0) {
    return failCheckout(
      res,
      400,
      'BOOKING_SHAPE',
      'Could not read week selections. Each booking needs weekId (or week_id), camperId (or camper_id), and dayIds (or day_ids array).',
      { sampleKeys: rawBookings[0] ? Object.keys(rawBookings[0]) : [] }
    );
  }
  const shirtChoice = normalizeExtraShirtChoice(extraShirtByCamper);
  const shirtIdsRequested = Object.keys(shirtChoice).filter((k) => shirtChoice[k] === true);
  const guest = body.guest;
  if (guest && typeof guest === 'object' && (guest.email || guest.firstName || guest.lastName || guest.age != null)) {
    return failCheckout(res, 400, 'GUEST_NOT_ALLOWED', 'Guest checkout is not available. Sign in with a parent account to complete registration.');
  }
  const secret = process.env.STRIPE_SECRET_KEY || '';
  const isStripeTestKey = secret.startsWith('sk_test_');

  let tp = !!testPricing;
  if (tp && !isStripeTestKey) {
    return json(res, 403, { error: 'Test pricing requires Stripe test secret key.' });
  }

  if (!bookingsArray.length && !shirtIdsRequested.length) {
    return failCheckout(
      res,
      400,
      'EMPTY_CART',
      'Add camp weeks or an extra T-shirt to checkout.',
      { hadBookingsKey: Object.prototype.hasOwnProperty.call(body, 'bookings'), bookingsType: typeof body.bookings }
    );
  }

  const { user, token } = await getUserFromRequest(req);
  let parentId = null;
  let profile = null;
  let sb = null;

  if (!user) {
    return json(res, 401, { error: 'Sign in with your parent account to register for camp.' });
  }
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
  if (bookingsArray.length) {
    for (const b of bookingsArray) {
      if (!b.camperId) {
        return failCheckout(res, 400, 'MISSING_CAMPER', 'Each week needs a child selected (camperId on each booking).');
      }
    }
    const seen = new Set();
    for (const b of bookingsArray) {
      const cid = b.camperId;
      if (seen.has(cid)) continue;
      seen.add(cid);
      const { data: camper, error: ce } = await sb.from('campers').select('id, parent_id').eq('id', cid).single();
      if (ce || !camper) {
        return failCheckout(res, 400, 'CAMPER_NOT_FOUND', 'Camper not found', { camperId: cid, supabase: ce && ce.message });
      }
      if (String(camper.parent_id) !== String(user.id)) {
        return failCheckout(res, 403, 'CAMPER_FORBIDDEN', 'Not your camper', { camperId: cid });
      }
    }
  } else {
    for (const cid of shirtIdsRequested) {
      const { data: camper, error: ce } = await sb.from('campers').select('id, parent_id').eq('id', cid).single();
      if (ce || !camper) {
        return failCheckout(res, 400, 'CAMPER_NOT_FOUND', 'Camper not found', { camperId: cid });
      }
      if (String(camper.parent_id) !== String(user.id)) {
        return failCheckout(res, 403, 'CAMPER_FORBIDDEN', 'Not your camper', { camperId: cid });
      }
    }
  }

  const dr = dayRate(tp);
  const wr = weekRate(tp);
  const regFee = registrationFee(tp);
  const shirtDollars = extraCampShirt(tp);
  const batchId = randomUUID();
  const bookingModes = [];

  if (bookingsArray.length) {
    for (const b of bookingsArray) {
      const weekId = b.weekId;
      const dayIds = Array.isArray(b.dayIds) ? b.dayIds : [];
      const pricingMode = b.pricingMode === 'full_week' ? 'full_week' : 'daily';
      const cid = b.camperId;
      try {
        await validateBooking(sb, {
          weekId,
          dayIds,
          camperId: cid,
          excludeEnrollmentId: null,
          pricingMode,
        });
      } catch (e) {
        return failCheckout(res, e.statusCode || 400, 'VALIDATE_BOOKING', e.message || String(e), {
          weekId,
          camperId: cid,
          pricingMode,
          dayCount: (dayIds || []).length,
        });
      }
      bookingModes.push(pricingMode);
    }
  }

  const uniqueCampers = [...new Set(bookingsArray.map((b) => String(b.camperId)).filter(Boolean))];
  const allShirtRelatedIds = [...new Set([...uniqueCampers, ...shirtIdsRequested.map(String)])].filter(Boolean);

  let camperShirtRows = [];
  if (allShirtRelatedIds.length) {
    const { data: rows, error: camperShirtErr } = await sb
      .from('campers')
      .select('id, extra_shirt_addon_paid, parent_id, first_name, last_name')
      .in('id', allShirtRelatedIds);
    if (camperShirtErr) {
      return json(res, 500, {
        error:
          'Could not load camper records for checkout. If this is new, run the latest Supabase migration (extra_shirt_addon_paid on campers).',
      });
    }
    camperShirtRows = rows || [];
  }
  const shirtAddonPaidByCamper = {};
  (camperShirtRows || []).forEach((r) => {
    shirtAddonPaidByCamper[String(r.id)] = !!r.extra_shirt_addon_paid;
  });
  const regFeeChoice = normalizeRegFeeChoice(registrationFeeForCamper);

  const regLineItems = [];
  /** Campers who are paying registration in this session — stored on Stripe session for confirm → DB. */
  const registrationCamperIds = [];
  let regCentsTotal = 0;
  for (const cid of uniqueCampers) {
    if (regFeeWaivedByParentChoice(regFeeChoice, cid)) {
      continue;
    }
    const needs = !(await hasRegistrationFeePaid(sb, cid));
    if (needs) {
      const cents = Math.round(regFee * 100);
      regCentsTotal += cents;
      const { data: cm } = await sb.from('campers').select('first_name,last_name').eq('id', cid).single();
      const label = cm ? `${cm.first_name} ${cm.last_name}`.trim() : 'Camper';
      regLineItems.push({ cents, label });
      registrationCamperIds.push(String(cid));
    }
  }

  const line_items = [];
  const checkoutCartLines = [];
  let campCentsTotal = 0;
  for (let i = 0; i < bookingsArray.length; i++) {
    const b = bookingsArray[i];
    const mode = bookingModes[i];
    const n = (b.dayIds || []).length;
    const { data: week } = await sb.from('weeks').select('label').eq('id', b.weekId).single();
    const wlabel = week ? week.label : 'Week';
    const crow = (camperShirtRows || []).find((r) => normCamperKey(r.id) === normCamperKey(b.camperId));
    const cname = crow
      ? `${crow.first_name || ''} ${crow.last_name || ''}`.trim() || 'Camper'
      : 'Camper';
    const sched = mode === 'full_week' ? 'Full week (Mon–Fri)' : `${n} day(s)`;
    checkoutCartLines.push(
      `${cname} — ${wlabel} — ${sched} — ${formatMoney(mode === 'full_week' ? wr : n * dr)}`
    );
    if (mode === 'full_week') {
      const unitCents = Math.round(wr * 100);
      campCentsTotal += unitCents;
      line_items.push({
        price_data: {
          currency: 'usd',
          product_data: {
            name: `IMA Summer Camp — ${wlabel} (full week)`,
            description: `Mon–Fri · $${wr}/week`,
          },
          unit_amount: unitCents,
        },
        quantity: 1,
      });
    } else {
      const unitCents = Math.round(n * dr * 100);
      campCentsTotal += unitCents;
      line_items.push({
        price_data: {
          currency: 'usd',
          product_data: {
            name: `IMA Summer Camp — ${wlabel}`,
            description: `${n} day${n === 1 ? '' : 's'} × $${dr}`,
          },
          unit_amount: unitCents,
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
    checkoutCartLines.push(`Registration (one-time) — ${r.label} — ${formatMoney(r.cents / 100)}`);
  }

  let shirtCentsTotal = 0;
  const shirtCamperIds = [];
  for (const cidStr of shirtIdsRequested) {
    const row = (camperShirtRows || []).find((r) => normCamperKey(r.id) === normCamperKey(cidStr));
    if (!row || String(row.parent_id) !== String(user.id)) {
      return failCheckout(res, 403, 'SHIRT_FORBIDDEN', 'Invalid extra shirt selection', { camperId: cidStr });
    }
    if (shirtAddonPaidByCamper[String(cidStr)]) continue;
    const cents = Math.round(shirtDollars * 100);
    shirtCentsTotal += cents;
    shirtCamperIds.push(String(cidStr));
    const label2 =
      row.first_name || row.last_name
        ? `${row.first_name || ''} ${row.last_name || ''}`.trim()
        : 'Camper';
    line_items.push({
      price_data: {
        currency: 'usd',
        product_data: {
          name: 'Extra camp T-shirt',
          description: `${label2} — additional shirt`,
        },
        unit_amount: cents,
      },
      quantity: 1,
    });
    checkoutCartLines.push(`Extra camp T-shirt — ${label2} — ${formatMoney(shirtDollars)}`);
  }

  const baseUrl = publicSiteBaseUrl(req);
  if (!baseUrl) {
    return failCheckout(
      res,
      500,
      'MISSING_BASE_URL',
      'Server configuration error: could not determine the public site URL for Stripe redirects. Set BASE_URL in Vercel (e.g. https://ima-summer-camp.vercel.app).',
    );
  }

  for (const cid of uniqueCampers) {
    if (regFeeChoice && regFeeWaivedByParentChoice(regFeeChoice, cid)) continue;
    const paid = await hasRegistrationFeePaid(sb, cid);
    if (paid) continue;
    const cNorm = normCamperKey(cid);
    if (!registrationCamperIds.some((x) => normCamperKey(x) === cNorm)) {
      console.error('[checkout] registration fee missing for camper', {
        cid: String(cid),
        cNorm,
        registrationCamperIds,
        regFeeChoice,
      });
      return failCheckout(
        res,
        500,
        'REG_FEE_MISMATCH',
        'The registration fee could not be added to this checkout (server mismatch). Refresh the page and try again, or contact IMA if this persists.',
      );
    }
  }

  /** One insert per row so DB row order matches `booking_modes` metadata (confirm uses row index). */
  for (const b of bookingsArray) {
    const cid = b.camperId;
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
    if (ie) {
      console.error('[create-checkout-session] enrollment insert failed', ie);
      return failCheckout(res, 500, 'ENROLLMENT_INSERT', ie.message || 'Could not create enrollment', {
        code: ie.code,
        details: ie.details,
      });
    }
  }

  if (!line_items.length) {
    return failCheckout(
      res,
      400,
      'NOTHING_TO_CHARGE',
      'Nothing to pay for in this checkout. Extra shirt may already be purchased — refresh the page.',
      { shirtRequested: shirtIdsRequested.length, shirtCharged: shirtCamperIds.length }
    );
  }

  const emailForStripe = (profile && profile.email) || null;
  try {
    const sessionParams = {
      ui_mode: 'hosted',
      payment_method_types: ['card'],
      mode: 'payment',
      line_items,
      success_url: `${baseUrl}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/index.html`,
      metadata: {
        checkout_batch_id: batchId,
        test_pricing: tp ? 'true' : 'false',
        registration_fee_cents: String(regCentsTotal),
        /** Comma-separated camper UUIDs charged registration this checkout (confirm marks all their rows in batch). */
        registration_camper_ids: registrationCamperIds.join(','),
        booking_modes: bookingModes.join(','),
        ima_member: imaMember ? 'true' : 'false',
        extra_shirt_cents: String(shirtCentsTotal),
        extra_shirt_camper_ids: shirtCamperIds.join(','),
      },
    };
    if (emailForStripe) sessionParams.customer_email = emailForStripe;

    /** Hosted Checkout: hide Stripe Link to reduce flaky UI (extension/CSP noise, amount flicker). */
    let session;
    try {
      session = await stripe.checkout.sessions.create({
        ...sessionParams,
        wallet_options: { link: { display: 'never' } },
      });
    } catch (err) {
      const param = err && err.param;
      const msg = err && err.message ? String(err.message) : '';
      const walletRejected = param === 'wallet_options' || /wallet_options/i.test(msg);
      if (walletRejected) {
        console.warn('create-checkout-session: wallet_options rejected; retrying without Link hide:', msg);
        session = await stripe.checkout.sessions.create(sessionParams);
      } else {
        throw err;
      }
    }

    const totalCents = campCentsTotal + regCentsTotal + shirtCentsTotal;
    /** Do not await — Resend can stall; the browser must get session JSON immediately. */
    void sendCheckoutStartedAdminNotify({
      parentName: (profile && profile.full_name && String(profile.full_name).trim()) || '',
      parentEmail: emailForStripe || 'n/a',
      sessionId: session.id,
      batchId,
      cartLines: checkoutCartLines,
      intendedTotal: totalCents / 100,
      registrationIncluded: regCentsTotal > 0,
    }).catch(function (notifyErr) {
      console.warn('[email] checkout started notify:', notifyErr && notifyErr.message ? notifyErr.message : notifyErr);
    });
    const checkoutUrl = session.url || null;
    if (!checkoutUrl) {
      console.warn('create-checkout-session: Stripe session missing url; client will use redirectToCheckout only');
    }
    return json(res, 200, {
      sessionId: session.id,
      checkoutUrl,
      batchId,
      totals: {
        camp: campCentsTotal / 100,
        registration: regCentsTotal / 100,
        extraShirts: shirtCentsTotal / 100,
        total: totalCents / 100,
      },
    });
  } catch (err) {
    console.error('[create-checkout-session] Stripe error:', err && err.message, err && err.stack);
    try {
      await sb.from('enrollments').delete().eq('checkout_batch_id', batchId);
    } catch (delErr) {
      console.error('[create-checkout-session] rollback delete failed', delErr);
    }
    return failCheckout(res, 500, 'STRIPE_ERROR', err && err.message ? err.message : String(err));
  }
};
