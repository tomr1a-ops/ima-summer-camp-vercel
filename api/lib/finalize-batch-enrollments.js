const { dayRate, weekRate, registrationFee } = require('./pricing');
const { subtractFamilyCampLedgerCents } = require('./family-camp-ledger');

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
    ledgerParentId,
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
    if (row.status === 'confirmed') {
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
        status: 'confirmed',
        stripe_session_id: stripeSessionId || null,
        price_paid: pricePaid,
        registration_fee_paid: false,
        guest_email: row.parent_id ? null : customerEmail || null,
      })
      .eq('id', row.id)
      .eq('status', 'pending')
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
  const lid = ledgerParentId || (rows[0] && rows[0].parent_id);
  if (didConfirmAny && lc > 0 && lid) {
    await subtractFamilyCampLedgerCents(sb, lid, lc);
  }

  return { ok: true, count: rows.length };
}

module.exports = { finalizePendingEnrollmentBatch };
