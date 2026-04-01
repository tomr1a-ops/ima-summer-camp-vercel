const { dayRate, weekRate, registrationFee } = require('./pricing');
const { subtractFamilyCampLedgerSplit } = require('./family-camp-ledger');
const { ENROLLMENT_STATUS } = require('./enrollment-status');
const { isMissingStepUpHoldExpiresColumn } = require('./step-up-hold-column');
const { markWaitlistConverted } = require('./waitlist-service');
const { markProfileWaiverSigned } = require('./profile-waiver');

/**
 * After payment (Stripe) or $0 prepaid checkout: confirm pending rows, bump day counts,
 * mark registration/shirt flags. `campLineCents[i]` is actual camp charge in cents for row i.
 */
async function finalizePendingEnrollmentBatch(sb, batchId, options) {
  const {
    stripeSessionId,
    customerEmail,
    testPricing,
    campLineCents,
    bookingModes,
    registrationFeeCents,
    registrationCamperIds,
    extraShirtCents,
    extraShirtCamperIds,
    ledgerConsumeCents,
    ledgerConsumeWeekCents,
    ledgerConsumeDayCents,
    ledgerParentId,
    waitlistIds,
  } = options;

  const { data: rows, error: qe } = await sb
    .from('enrollments')
    .select('id, day_ids, week_id, camper_id, parent_id, status, stripe_session_id')
    .eq('checkout_batch_id', batchId)
    .order('created_at', { ascending: true });
  if (qe) throw qe;
  if (!rows || !rows.length) {
    return { ok: false, reason: 'no_rows' };
  }

  const dr = dayRate(testPricing);
  const wr = weekRate(testPricing);
  const regDollars = registrationFee(testPricing);
  const modes = bookingModes || [];
  const centsArr = Array.isArray(campLineCents) ? campLineCents : [];
  const paidReg = registrationFeeCents ? Number(registrationFeeCents) > 0 : false;

  let didConfirmAny = false;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.status === ENROLLMENT_STATUS.CONFIRMED) {
      continue;
    }

    const nDays = (row.day_ids || []).length;
    const mode = modes[i] || 'daily';
    const fallbackCamp = mode === 'full_week' ? wr : nDays * dr;
    let campDollars = fallbackCamp;
    if (centsArr.length > i && centsArr[i] != null && Number.isFinite(Number(centsArr[i]))) {
      campDollars = Number(centsArr[i]) / 100;
    }
    const reg = i === 0 && paidReg ? regDollars : 0;
    const pricePaid = campDollars + reg;

    const { data: updated, error: ue } = await sb
      .from('enrollments')
      .update({
        status: ENROLLMENT_STATUS.CONFIRMED,
        stripe_session_id: stripeSessionId || null,
        price_paid: pricePaid,
        registration_fee_paid: false,
        guest_email: row.parent_id ? null : customerEmail || null,
      })
      .eq('id', row.id)
      .eq('status', ENROLLMENT_STATUS.PENDING)
      .select('id')
      .maybeSingle();

    if (ue) throw ue;
    if (!updated) continue;
    didConfirmAny = true;

    for (const dayId of row.day_ids || []) {
      const { data: d0, error: de } = await sb.from('days').select('id, current_enrollment').eq('id', dayId).single();
      if (de) throw de;
      const next = (d0.current_enrollment || 0) + 1;
      const { error: incErr } = await sb.from('days').update({ current_enrollment: next }).eq('id', dayId);
      if (incErr) throw incErr;
    }
  }

  if (paidReg) {
    let regCampers = [];
    if (registrationCamperIds != null && registrationCamperIds.length) {
      regCampers = registrationCamperIds.map(String).filter(Boolean);
    }
    if (regCampers.length) {
      const { error: regUp } = await sb
        .from('enrollments')
        .update({ registration_fee_paid: true })
        .eq('checkout_batch_id', batchId)
        .in('camper_id', regCampers);
      if (regUp) throw regUp;
    } else if (rows[0]) {
      const { error: leg } = await sb.from('enrollments').update({ registration_fee_paid: true }).eq('id', rows[0].id);
      if (leg) throw leg;
    }
    const camperIdsForRegFlag =
      regCampers.length > 0 ? regCampers : rows[0] && rows[0].camper_id ? [String(rows[0].camper_id)] : [];
    if (camperIdsForRegFlag.length) {
      const { error: campReg } = await sb
        .from('campers')
        .update({ registration_fee_paid: true })
        .in('id', camperIdsForRegFlag);
      if (campReg) throw campReg;
    }
  }

  const shirtC = Number(extraShirtCents) || 0;
  if (shirtC > 0) {
    const shirtIds = (extraShirtCamperIds || []).map(String).filter(Boolean);
    for (const camId of shirtIds) {
      const { error: shirtUp } = await sb.from('campers').update({ extra_shirt_addon_paid: true }).eq('id', camId);
      if (shirtUp) throw shirtUp;
    }
  }

  const lc = Math.max(0, Math.round(Number(ledgerConsumeCents) || 0));
  let lw = Math.max(0, Math.round(Number(ledgerConsumeWeekCents) || 0));
  let ld = Math.max(0, Math.round(Number(ledgerConsumeDayCents) || 0));
  if (lw === 0 && ld === 0 && lc > 0) {
    lw = lc;
  }
  const lid = ledgerParentId || (rows[0] && rows[0].parent_id);
  if (didConfirmAny && (lw > 0 || ld > 0) && lid) {
    await subtractFamilyCampLedgerSplit(sb, lid, lw, ld, 'credit_card');
  }

  if (didConfirmAny && waitlistIds && waitlistIds.length && lid) {
    try {
      await markWaitlistConverted(sb, waitlistIds, lid);
    } catch (wlErr) {
      console.error('[finalizePendingEnrollmentBatch] waitlist converted', wlErr && wlErr.message);
    }
  }

  if (didConfirmAny && rows[0] && rows[0].parent_id) {
    try {
      await markProfileWaiverSigned(sb, rows[0].parent_id);
    } catch (wErr) {
      console.error('[finalizePendingEnrollmentBatch] waiver flag', wErr && wErr.message);
    }
  }

  return { ok: true, count: rows.length };
}

/**
 * Step Up for Students: no Stripe; status pending_step_up; day counts incremented; no reg/shirt flags on rows.
 * Ledger (family_camp_credit_ledger) consumed here when credits reduced camp lines — same as card/$0 finalize.
 */
async function finalizeStepUpReservationBatch(sb, batchId, options) {
  const {
    customerEmail,
    testPricing,
    campLineCents,
    bookingModes,
    ledgerConsumeCents,
    ledgerConsumeWeekCents,
    ledgerConsumeDayCents,
    ledgerParentId,
    waitlistIds,
    registrationFeeCents,
    registrationCamperIds,
    extraShirtCents,
    extraShirtCamperIds,
  } = options;

  const { data: rows, error: qe } = await sb
    .from('enrollments')
    .select('id, day_ids, week_id, camper_id, parent_id, status, stripe_session_id')
    .eq('checkout_batch_id', batchId)
    .order('created_at', { ascending: true });
  if (qe) throw qe;
  if (!rows || !rows.length) {
    return { ok: false, reason: 'no_rows' };
  }

  const dr = dayRate(testPricing);
  const wr = weekRate(testPricing);
  const modes = bookingModes || [];
  const centsArr = Array.isArray(campLineCents) ? campLineCents : [];
  const holdExpiresIso = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const paidReg = registrationFeeCents ? Number(registrationFeeCents) > 0 : false;
  let regCampers = [];
  if (registrationCamperIds != null && registrationCamperIds.length) {
    regCampers = registrationCamperIds.map(String).filter(Boolean);
  }

  let didAny = false;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.status === ENROLLMENT_STATUS.CONFIRMED || row.status === ENROLLMENT_STATUS.PENDING_STEP_UP) {
      continue;
    }

    const nDays = (row.day_ids || []).length;
    const mode = modes[i] || 'daily';
    const fallbackCamp = mode === 'full_week' ? wr : nDays * dr;
    let campDollars = fallbackCamp;
    if (centsArr.length > i && centsArr[i] != null && Number.isFinite(Number(centsArr[i]))) {
      campDollars = Number(centsArr[i]) / 100;
    }
    const pricePaid = campDollars;

    const baseUpdate = {
      status: ENROLLMENT_STATUS.PENDING_STEP_UP,
      stripe_session_id: null,
      price_paid: pricePaid,
      registration_fee_paid: false,
      guest_email: row.parent_id ? null : customerEmail || null,
    };
    let { data: updated, error: ue } = await sb
      .from('enrollments')
      .update({ ...baseUpdate, step_up_hold_expires_at: holdExpiresIso })
      .eq('id', row.id)
      .eq('status', ENROLLMENT_STATUS.PENDING)
      .select('id')
      .maybeSingle();

    if (ue && isMissingStepUpHoldExpiresColumn(ue)) {
      console.warn('[finalizeStepUpReservationBatch] retry update without step_up_hold_expires_at');
      const retry = await sb
        .from('enrollments')
        .update(baseUpdate)
        .eq('id', row.id)
        .eq('status', ENROLLMENT_STATUS.PENDING)
        .select('id')
        .maybeSingle();
      updated = retry.data;
      ue = retry.error;
    }
    if (ue) throw ue;
    if (!updated) continue;
    didAny = true;

    for (const dayId of row.day_ids || []) {
      const { data: d0, error: de } = await sb.from('days').select('id, current_enrollment').eq('id', dayId).single();
      if (de) throw de;
      const next = (d0.current_enrollment || 0) + 1;
      const { error: incErr } = await sb.from('days').update({ current_enrollment: next }).eq('id', dayId);
      if (incErr) throw incErr;
    }
  }

  if (didAny && paidReg && regCampers.length) {
    const { error: regUp } = await sb
      .from('enrollments')
      .update({ registration_fee_paid: true })
      .eq('checkout_batch_id', batchId)
      .in('camper_id', regCampers);
    if (regUp) throw regUp;
  }

  /**
   * Extra T-shirt $ is part of Step Up balance — merge into `price_paid` (same as shirt-only add-on path
   * in create-checkout-session). Previously only `campers.extra_shirt_addon_paid` was set, so admin/parent
   * totals diverged and `price_paid` stayed camp-only.
   */
  const shirtC = Number(extraShirtCents) || 0;
  const shirtIdsMerge = (extraShirtCamperIds || []).map(String).filter(Boolean);
  if (didAny && shirtC > 0 && shirtIdsMerge.length > 0) {
    const { data: upRows, error: uqe } = await sb
      .from('enrollments')
      .select('id, camper_id, price_paid')
      .eq('checkout_batch_id', batchId)
      .eq('status', ENROLLMENT_STATUS.PENDING_STEP_UP)
      .order('created_at', { ascending: true });
    if (uqe) throw uqe;
    const normCamper = (id) => String(id == null ? '' : id).trim();
    const byCamperFirst = new Map();
    for (const er of upRows || []) {
      const k = normCamper(er.camper_id);
      if (k && !byCamperFirst.has(k)) byCamperFirst.set(k, er);
    }
    let remainingCents = Math.round(shirtC);
    for (let i = 0; i < shirtIdsMerge.length; i++) {
      const nk = normCamper(shirtIdsMerge[i]);
      let er = byCamperFirst.get(nk);
      if (!er) {
        for (const [key, row] of byCamperFirst) {
          if (normCamper(key) === nk) {
            er = row;
            break;
          }
        }
      }
      if (!er) continue;
      const nLeft = shirtIdsMerge.length - i;
      const addCents = Math.floor(remainingCents / nLeft);
      remainingCents -= addCents;
      const addDollars = addCents / 100;
      const prev = Number(er.price_paid) || 0;
      const next = prev + addDollars;
      const { error: upE } = await sb
        .from('enrollments')
        .update({ price_paid: next })
        .eq('id', er.id)
        .eq('status', ENROLLMENT_STATUS.PENDING_STEP_UP);
      if (upE) throw upE;
      er.price_paid = next;
    }
    for (const camId of shirtIdsMerge) {
      const { error: shirtUp } = await sb.from('campers').update({ extra_shirt_addon_paid: true }).eq('id', camId);
      if (shirtUp) throw shirtUp;
    }
  }

  const lc = Math.max(0, Math.round(Number(ledgerConsumeCents) || 0));
  let lw = Math.max(0, Math.round(Number(ledgerConsumeWeekCents) || 0));
  let ld = Math.max(0, Math.round(Number(ledgerConsumeDayCents) || 0));
  if (lw === 0 && ld === 0 && lc > 0) {
    lw = lc;
  }
  const lid = ledgerParentId || (rows[0] && rows[0].parent_id);
  if (didAny && (lw > 0 || ld > 0) && lid) {
    await subtractFamilyCampLedgerSplit(sb, lid, lw, ld, 'step_up');
  }

  if (didAny && waitlistIds && waitlistIds.length && lid) {
    try {
      await markWaitlistConverted(sb, waitlistIds, lid);
    } catch (wlErr) {
      console.error('[finalizeStepUpReservationBatch] waitlist converted', wlErr && wlErr.message);
    }
  }

  if (didAny && rows[0] && rows[0].parent_id) {
    try {
      await markProfileWaiverSigned(sb, rows[0].parent_id);
    } catch (wErr) {
      console.error('[finalizeStepUpReservationBatch] waiver flag', wErr && wErr.message);
    }
  }

  return { ok: true, count: rows.length, didAny };
}

module.exports = { finalizePendingEnrollmentBatch, finalizeStepUpReservationBatch };
