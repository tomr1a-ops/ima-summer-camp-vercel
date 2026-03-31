const { serviceClient } = require('./supabase');
const { ENROLLMENT_STATUS } = require('./enrollment-status');
const { dayRate, weekRate, registrationFee } = require('./pricing');
const { subtractFamilyCampLedgerCents } = require('./family-camp-ledger');

/**
 * Set campers.extra_shirt_addon_paid from Stripe session metadata (same as finalize-batch-enrollments).
 * Runs for paid card checkout; idempotent. Verifies each camper belongs to the checkout parent.
 */
async function applyExtraShirtPaidFromStripeSession(sb, session, enrollmentRows) {
  const meta = session.metadata || {};
  const shirtCents = Number(meta.extra_shirt_cents || 0) || 0;
  const idsRaw = String(meta.extra_shirt_camper_ids || '').trim();
  if (shirtCents <= 0 || !idsRaw) return 0;
  const shirtIds = idsRaw.split(',').map((s) => s.trim()).filter(Boolean);
  if (!shirtIds.length) return 0;

  const parentId =
    (enrollmentRows && enrollmentRows[0] && enrollmentRows[0].parent_id) || meta.checkout_parent_id || null;
  if (!parentId) {
    console.warn('[confirm-stripe-session] extra shirt in metadata but no parent id');
    return 0;
  }

  const { data: campers, error } = await sb.from('campers').select('id, parent_id').in('id', shirtIds);
  if (error) throw error;
  let applied = 0;
  for (const c of campers || []) {
    if (String(c.parent_id) !== String(parentId)) {
      console.warn('[confirm-stripe-session] skip shirt: camper not owned by checkout parent', c.id);
      continue;
    }
    const { error: ue } = await sb.from('campers').update({ extra_shirt_addon_paid: true }).eq('id', c.id);
    if (ue) throw ue;
    applied += 1;
  }
  return applied;
}

/**
 * Idempotent: confirms pending enrollments for session.metadata.checkout_batch_id
 */
async function confirmStripeSession(stripe, session) {
  const sb = serviceClient();
  const batchId = session.metadata && session.metadata.checkout_batch_id;
  if (!batchId) {
    return { ok: false, reason: 'no_batch_id' };
  }

  const payStatus = session.payment_status || session.status;
  if (payStatus !== 'paid' && session.status !== 'complete') {
    return { ok: false, reason: 'not_paid' };
  }

  const { data: rows, error: qe } = await sb
    .from('enrollments')
    .select('id, day_ids, week_id, camper_id, parent_id, status, stripe_session_id')
    .eq('checkout_batch_id', batchId)
    .order('created_at', { ascending: true });
  if (qe) throw qe;
  const enrollmentRows = rows || [];

  const customerEmail =
    (session.customer_details && session.customer_details.email) ||
    session.customer_email ||
    '';

  await applyExtraShirtPaidFromStripeSession(sb, session, enrollmentRows);

  if (!enrollmentRows.length) {
    const shirtCents = Number((session.metadata && session.metadata.extra_shirt_cents) || 0) || 0;
    if (shirtCents > 0) {
      return { ok: true, shirtOnly: true, count: 0, email: customerEmail };
    }
    return { ok: false, reason: 'no_rows' };
  }

  if (
    enrollmentRows.every((r) => r.status === ENROLLMENT_STATUS.CONFIRMED && r.stripe_session_id === session.id)
  ) {
    return { ok: true, already: true, count: enrollmentRows.length, email: customerEmail };
  }

  const testPricing = session.metadata.test_pricing === 'true';
  const dr = dayRate(testPricing);
  const wr = weekRate(testPricing);
  const regDollars = registrationFee(testPricing);
  const modesStr = (session.metadata && session.metadata.booking_modes) || '';
  const bookingModes = modesStr ? modesStr.split(',').map((s) => s.trim()) : [];
  const paidReg = session.metadata.registration_fee_cents
    ? Number(session.metadata.registration_fee_cents) > 0
    : false;
  const regIdsRaw = String((session.metadata && session.metadata.registration_camper_ids) || '').trim();
  const regCamperMetaList = regIdsRaw ? regIdsRaw.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const regCampSet = new Set(regCamperMetaList.map((x) => String(x)));

  let didConfirmAny = false;
  for (let i = 0; i < enrollmentRows.length; i++) {
    const row = enrollmentRows[i];
    if (row.status === ENROLLMENT_STATUS.CONFIRMED && row.stripe_session_id === session.id) {
      continue;
    }

    const nDays = (row.day_ids || []).length;
    const mode = bookingModes[i] || 'daily';
    const camp = mode === 'full_week' ? wr : nDays * dr;
    const reg = i === 0 && paidReg ? regDollars : 0;
    const pricePaid = camp + reg;
    const rowGetsRegFlag =
      paidReg && (regCampSet.size ? regCampSet.has(String(row.camper_id)) : i === 0);

    const { data: updated, error: ue } = await sb
      .from('enrollments')
      .update({
        status: ENROLLMENT_STATUS.CONFIRMED,
        stripe_session_id: session.id,
        price_paid: pricePaid,
        registration_fee_paid: rowGetsRegFlag,
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

  const lc = Math.max(0, Math.round(Number(session.metadata && session.metadata.ledger_consume_cents) || 0));
  if (didConfirmAny && lc > 0 && enrollmentRows[0].parent_id) {
    await subtractFamilyCampLedgerCents(sb, enrollmentRows[0].parent_id, lc);
  }

  if (paidReg && didConfirmAny && enrollmentRows[0] && enrollmentRows[0].parent_id) {
    const parentId = enrollmentRows[0].parent_id;
    const idsToFlag =
      regCamperMetaList.length > 0
        ? regCamperMetaList
        : enrollmentRows[0].camper_id
          ? [String(enrollmentRows[0].camper_id)]
          : [];
    if (idsToFlag.length) {
      const { data: owned, error: ownErr } = await sb
        .from('campers')
        .select('id')
        .eq('parent_id', parentId)
        .in('id', idsToFlag);
      if (!ownErr && owned && owned.length) {
        const safeIds = owned.map((r) => r.id);
        const { error: cu } = await sb.from('campers').update({ registration_fee_paid: true }).in('id', safeIds);
        if (cu) throw cu;
      }
    }
  }

  return { ok: true, count: enrollmentRows.length, email: customerEmail };
}

module.exports = { confirmStripeSession };
