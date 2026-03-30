const { serviceClient } = require('./supabase');
const { dayRate, weekRate, registrationFee } = require('./pricing');
const { subtractFamilyCampLedgerCents } = require('./family-camp-ledger');

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
  if (!rows || !rows.length) {
    return { ok: false, reason: 'no_rows' };
  }

  if (rows.every((r) => r.status === 'confirmed' && r.stripe_session_id === session.id)) {
    return { ok: true, already: true, count: rows.length };
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

  const customerEmail =
    (session.customer_details && session.customer_details.email) ||
    session.customer_email ||
    '';

  let didConfirmAny = false;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.status === 'confirmed' && row.stripe_session_id === session.id) {
      continue;
    }

    const nDays = (row.day_ids || []).length;
    const mode = bookingModes[i] || 'daily';
    const camp = mode === 'full_week' ? wr : nDays * dr;
    const reg = i === 0 && paidReg ? regDollars : 0;
    const pricePaid = camp + reg;

    const { data: updated, error: ue } = await sb
      .from('enrollments')
      .update({
        status: 'confirmed',
        stripe_session_id: session.id,
        price_paid: pricePaid,
        registration_fee_paid: i === 0 && paidReg,
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

  const lc = Math.max(0, Math.round(Number(session.metadata && session.metadata.ledger_consume_cents) || 0));
  if (didConfirmAny && lc > 0 && rows[0].parent_id) {
    await subtractFamilyCampLedgerCents(sb, rows[0].parent_id, lc);
  }

  return { ok: true, count: rows.length, email: customerEmail };
}

module.exports = { confirmStripeSession };
