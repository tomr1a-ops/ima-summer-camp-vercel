const { randomUUID } = require('crypto');
/** Basil: required for wallet_options.link.display (reduces Link UI churn / amount flicker on hosted Checkout). */
const STRIPE_API_VERSION = '2025-04-30.basil';
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION });
const { serviceClient } = require('./lib/supabase');
const { getUserFromRequest, upsertParentProfile } = require('./lib/auth');
const { dayRate, weekRate, registrationFee, extraCampShirt } = require('./lib/pricing');
/** Full-week bookings that overlap a camper's already-confirmed days fail here with a specific message (see validateBooking in ./lib/capacity). */
const { validateBooking } = require('./lib/capacity');
const { sendCampPaymentEmails } = require('./lib/email');
const {
  loadFloatingPrepaidPool,
  sortBookingsForCreditApply,
  applyPoolToBookings,
} = require('./lib/family-prepaid-credits');
const { finalizePendingEnrollmentBatch } = require('./lib/finalize-batch-enrollments');
const { normCamperKey, normalizeIncomingBookings } = require('./lib/normalize-checkout-bookings');
const { isCampRegistrationFeePaid } = require('./lib/camper-registration-fee');
const {
  AGREEMENT_VERSION,
  clientIpFromRequest,
  insertAgreementRecord,
  sendAgreementAcknowledgmentEmailOnce,
} = require('./lib/agreement-record');

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

  const { testPricing, imaMember, registrationFeeForCamper, extraShirtByCamper, agreementAccepted, agreementVersion } =
    body;
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
  console.log('[create-checkout-session] start', {
    bookings: bookingsArray.length,
    shirtAddons: shirtIdsRequested.length,
  });
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

  if (agreementAccepted !== true) {
    return failCheckout(
      res,
      400,
      'AGREEMENT_REQUIRED',
      'Please read and confirm the agreement before continuing.'
    );
  }
  if (String(agreementVersion || '') !== AGREEMENT_VERSION) {
    return failCheckout(
      res,
      400,
      'AGREEMENT_VERSION',
      'Please refresh the page and accept the current camp agreement.'
    );
  }

  const { user, token } = await getUserFromRequest(req);
  let parentId = null;
  let profile = null;
  let sb = null;

  if (!user) {
    if (token) {
      return json(res, 401, {
        error: 'Your sign-in session expired. Refresh this page and try checkout again (you will stay signed in if your browser still has your session).',
      });
    }
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
  for (const b of bookingsArray) {
    if (!b.camperId) {
      return failCheckout(res, 400, 'MISSING_CAMPER', 'Each week needs a child selected (camperId on each booking).');
    }
  }
  const camperIdsToVerify = [
    ...new Set([
      ...bookingsArray.map((b) => b.camperId),
      ...shirtIdsRequested.map((id) => String(id).trim()).filter(Boolean),
    ]),
  ].filter(Boolean);
  if (camperIdsToVerify.length) {
    const { data: camperList, error: batchCe } = await sb
      .from('campers')
      .select('id, parent_id')
      .in('id', camperIdsToVerify);
    if (batchCe) {
      return failCheckout(res, 500, 'CAMPER_LOOKUP', batchCe.message || 'Camper lookup failed');
    }
    const byKey = new Map((camperList || []).map((r) => [normCamperKey(r.id), r]));
    for (const cid of camperIdsToVerify) {
      const row = byKey.get(normCamperKey(cid));
      if (!row) {
        return failCheckout(res, 400, 'CAMPER_NOT_FOUND', 'Camper not found', { camperId: cid });
      }
      if (String(row.parent_id) !== String(user.id)) {
        return failCheckout(res, 403, 'CAMPER_FORBIDDEN', 'Not your camper', { camperId: cid });
      }
    }
  }

  const dr = dayRate(tp);
  const wr = weekRate(tp);
  const regFee = registrationFee(tp);
  const shirtDollars = extraCampShirt(tp);
  const batchId = randomUUID();
  /** One entry per `bookingsArray` row — same order for Stripe metadata / finalize. */
  let bookingModes = [];

  /** Family pooled prepaid credits (confirmed weeks/days not in this cart) → reduce camp line charges. */
  let campLineCents = [];
  /** Cents drawn from family_camp_credit_ledger (cancelled-enrollment credits) this checkout. */
  let ledgerConsumedCents = 0;
  if (bookingsArray.length) {
    try {
      const prepaidCoverageKeys = Array.isArray(body.prepaidCoverageKeys) ? body.prepaidCoverageKeys : [];
      const { poolW, poolD, weekMetaMap, ledgerCents } = await loadFloatingPrepaidPool(
        sb,
        parentId,
        bookingsArray,
        normCamperKey,
        prepaidCoverageKeys
      );
      bookingsArray = sortBookingsForCreditApply(bookingsArray, weekMetaMap);
      const applied = applyPoolToBookings(bookingsArray, poolW, poolD, wr, dr, ledgerCents);
      campLineCents = applied.campLineCents;
      ledgerConsumedCents = applied.ledgerConsumedCents || 0;
    } catch (poolErr) {
      console.error('[create-checkout-session] prepaid pool', poolErr);
      return failCheckout(res, 500, 'PREPAID_POOL', 'Could not apply prepaid credits. Try again or contact IMA.', poolErr && poolErr.message);
    }
  }

  if (bookingsArray.length) {
    bookingModes = bookingsArray.map((b) => (b.pricingMode === 'full_week' ? 'full_week' : 'daily'));
    try {
      await Promise.all(
        bookingsArray.map((b, i) =>
          validateBooking(sb, {
            weekId: b.weekId,
            dayIds: Array.isArray(b.dayIds) ? b.dayIds : [],
            camperId: b.camperId,
            excludeEnrollmentId: null,
            pricingMode: bookingModes[i],
          })
        )
      );
    } catch (e) {
      return failCheckout(res, e.statusCode || 400, 'VALIDATE_BOOKING', e.message || String(e), {
        detail: e && e.message,
      });
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

  const regFeeChecks = await Promise.all(
    uniqueCampers.map(async (cid) => {
      if (regFeeWaivedByParentChoice(regFeeChoice, cid)) {
        return { cid, waived: true, paid: true };
      }
      const paid = await isCampRegistrationFeePaid(sb, cid);
      return { cid, waived: false, paid };
    })
  );

  const regLineItems = [];
  /** Campers who are paying registration in this session — stored on Stripe session for confirm → DB. */
  const registrationCamperIds = [];
  let regCentsTotal = 0;
  for (const r of regFeeChecks) {
    if (r.waived || r.paid) continue;
    const cents = Math.round(regFee * 100);
    regCentsTotal += cents;
    const row = (camperShirtRows || []).find((c) => normCamperKey(c.id) === normCamperKey(r.cid));
    const label =
      row && (row.first_name || row.last_name)
        ? `${row.first_name || ''} ${row.last_name || ''}`.trim()
        : 'Camper';
    regLineItems.push({ cents, label });
    registrationCamperIds.push(String(r.cid));
  }

  const uniqueWeekIds = [...new Set(bookingsArray.map((b) => String(b.weekId)))];
  const weekLabelById = new Map();
  if (uniqueWeekIds.length) {
    const { data: wkRows, error: wkErr } = await sb.from('weeks').select('id,label').in('id', uniqueWeekIds);
    if (wkErr) {
      return failCheckout(res, 500, 'WEEK_LABELS', wkErr.message || 'Could not load week labels');
    }
    (wkRows || []).forEach((w) => weekLabelById.set(String(w.id), w.label || 'Week'));
  }

  const line_items = [];
  let campCentsTotal = 0;
  for (let i = 0; i < bookingsArray.length; i++) {
    const b = bookingsArray[i];
    const mode = bookingModes[i];
    const n = (b.dayIds || []).length;
    const unitCents = campLineCents[i] != null ? campLineCents[i] : Math.round((mode === 'full_week' ? wr : n * dr) * 100);
    campCentsTotal += unitCents;
    if (unitCents <= 0) continue;
    const wlabel = weekLabelById.get(String(b.weekId)) || 'Week';
    if (mode === 'full_week') {
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

  for (const r of regFeeChecks) {
    if (r.waived || r.paid) continue;
    const cNorm = normCamperKey(r.cid);
    if (!registrationCamperIds.some((x) => normCamperKey(x) === cNorm)) {
      console.error('[checkout] registration fee missing for camper', {
        cid: String(r.cid),
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

  /** Batch insert — row order matches `booking_modes` / `camp_line_cents` (confirm uses row index). */
  if (bookingsArray.length) {
    const insertRows = bookingsArray.map((b) => ({
      parent_id: parentId,
      camper_id: b.camperId,
      week_id: b.weekId,
      day_ids: b.dayIds,
      price_paid: 0,
      registration_fee_paid: false,
      status: 'pending',
      checkout_batch_id: batchId,
    }));
    const { error: ie } = await sb.from('enrollments').insert(insertRows);
    if (ie) {
      console.error('[create-checkout-session] enrollment insert failed', ie);
      return failCheckout(res, 500, 'ENROLLMENT_INSERT', ie.message || 'Could not create enrollment', {
        code: ie.code,
        details: ie.details,
      });
    }
  }

  let agreementRecordId = null;
  try {
    const rec = await insertAgreementRecord(sb, {
      parentId,
      parentName: (profile && profile.full_name) || '',
      email: (profile && profile.email) || (user.email || ''),
      ipAddress: clientIpFromRequest(req),
      camperIds: camperIdsToVerify,
    });
    agreementRecordId = rec.id;
  } catch (arErr) {
    console.error('[create-checkout-session] agreement record', arErr);
    if (bookingsArray.length) {
      try {
        await sb.from('enrollments').delete().eq('checkout_batch_id', batchId);
      } catch (delE) {}
    }
    return failCheckout(
      res,
      500,
      'AGREEMENT_SAVE',
      'Could not save agreement acceptance. Try again.',
      arErr && arErr.message
    );
  }

  const totalDueCents = campCentsTotal + regCentsTotal + shirtCentsTotal;

  if (!line_items.length) {
    if (bookingsArray.length && totalDueCents === 0) {
      try {
        await finalizePendingEnrollmentBatch(sb, batchId, {
          stripeSessionId: null,
          customerEmail: (profile && profile.email) || null,
          testPricing: tp,
          campLineCents,
          bookingModes,
          registrationFeeCents: String(regCentsTotal),
          registrationCamperIds,
          extraShirtCents: String(shirtCentsTotal),
          extraShirtCamperIds: shirtCamperIds,
          ledgerConsumeCents: ledgerConsumedCents,
          ledgerParentId: parentId,
        });
      } catch (fz) {
        console.error('[create-checkout-session] zero-dollar finalize failed', fz);
        try {
          await sb.from('enrollments').delete().eq('checkout_batch_id', batchId);
        } catch (delE) {}
        return failCheckout(res, 500, 'FINALIZE_BATCH', fz.message || 'Could not complete registration', '');
      }
      if (agreementRecordId) {
        try {
          await sendAgreementAcknowledgmentEmailOnce(
            sb,
            agreementRecordId,
            (profile && profile.email) || user.email || ''
          );
        } catch (ackE) {
          console.error('[create-checkout-session] agreement ack email', ackE && ackE.message);
        }
      }
      return json(res, 200, {
        sessionId: null,
        checkoutUrl: null,
        batchId,
        zeroDollarComplete: true,
        totals: {
          camp: campCentsTotal / 100,
          registration: regCentsTotal / 100,
          extraShirts: shirtCentsTotal / 100,
          total: 0,
        },
      });
    }
    try {
      await sb.from('enrollments').delete().eq('checkout_batch_id', batchId);
    } catch (delE) {}
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
        /** Lets confirm-stripe-session verify extra-shirt campers when there are zero enrollment rows (shirt-only checkout). */
        checkout_parent_id: String(parentId),
        test_pricing: tp ? 'true' : 'false',
        registration_fee_cents: String(regCentsTotal),
        /** Comma-separated camper UUIDs charged registration this checkout (confirm marks all their rows in batch). */
        registration_camper_ids: registrationCamperIds.join(','),
        booking_modes: bookingModes.join(','),
        /** Actual camp line amounts (cents) per enrollment row after family prepaid credits. */
        camp_line_cents: campLineCents.length ? campLineCents.join(',') : '',
        ima_member: imaMember ? 'true' : 'false',
        extra_shirt_cents: String(shirtCentsTotal),
        extra_shirt_camper_ids: shirtCamperIds.join(','),
        ledger_consume_cents: String(ledgerConsumedCents || 0),
        agreement_record_id: agreementRecordId ? String(agreementRecordId) : '',
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

    /**
     * “Booking confirmed” emails require a paid session. Hosted Checkout is almost always unpaid here;
     * success.html → /api/confirm-checkout awaits sendCampPaymentEmails so the function doesn’t exit early.
     */
    try {
      if (session.payment_status === 'paid' || session.status === 'complete') {
        await sendCampPaymentEmails(stripe, session, {
          ok: true,
          email: emailForStripe || undefined,
          count: bookingsArray.length,
        });
        console.log('[create-checkout-session] paid booking emails sent (session already paid)', session.id);
      } else {
        console.log(
          '[create-checkout-session] paid booking emails deferred until payment (confirm-checkout); payment_status=%s',
          session.payment_status || 'n/a'
        );
      }
    } catch (paidEmailErr) {
      console.error(
        '[create-checkout-session] paid booking email error (non-fatal):',
        paidEmailErr && paidEmailErr.message ? paidEmailErr.message : paidEmailErr
      );
    }

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
