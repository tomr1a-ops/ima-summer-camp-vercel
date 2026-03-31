const { loadOrderedDaysForWeek } = require('./capacity');
const { dayRate, weekRate } = require('./pricing');
const { enrollmentCancelledJustifiesLedger } = require('./enrollment-credit-eligibility');

function enrollmentCoversFullWeek(dayIds, weekDaysOrdered) {
  if (!weekDaysOrdered || weekDaysOrdered.length !== 5) return false;
  const ids = new Set((dayIds || []).map((d) => String(d)));
  return weekDaysOrdered.every((d) => ids.has(String(d.id)));
}

/**
 * Camp line value only (cents) for a confirmed row — used when issuing credit on cancellation.
 * Uses current pricing tier (test vs live), not historical Stripe amounts.
 */
async function campCreditCentsForConfirmedRow(sb, row, testPricing = false) {
  if (!row || !row.week_id) return 0;
  const days = await loadOrderedDaysForWeek(sb, row.week_id);
  const wrC = Math.round(weekRate(testPricing) * 100);
  const drC = Math.round(dayRate(testPricing) * 100);
  if (enrollmentCoversFullWeek(row.day_ids || [], days)) return wrC;
  const n = (row.day_ids || []).length;
  return Math.max(0, n * drC);
}

async function getFamilyCampLedgerCents(sb, parentId) {
  if (!parentId) return 0;
  const { data, error } = await sb
    .from('family_camp_credit_ledger')
    .select('balance_cents')
    .eq('parent_id', parentId)
    .maybeSingle();
  if (error) throw error;
  return Math.max(0, Math.round(Number(data && data.balance_cents) || 0));
}

/**
 * Ledger only makes sense if at least one cancelled enrollment proves a paid-then-cancelled path
 * (same settlement signals as floating prepaid). Otherwise the row is orphan data — clear it.
 */
async function parentHasLedgerJustifyingCancelledEnrollment(sb, parentId) {
  if (!parentId) return false;
  const { data, error } = await sb
    .from('enrollments')
    .select('status,price_paid,stripe_session_id,checkout_batch_id')
    .eq('parent_id', parentId)
    .eq('status', 'cancelled')
    .limit(400);
  if (error) throw error;
  return (data || []).some((r) => enrollmentCancelledJustifiesLedger(r));
}

async function getReconciledFamilyCampLedgerCents(sb, parentId) {
  const raw = await getFamilyCampLedgerCents(sb, parentId);
  if (raw <= 0) return 0;
  const justified = await parentHasLedgerJustifyingCancelledEnrollment(sb, parentId);
  if (justified) return raw;
  try {
    await subtractFamilyCampLedgerCents(sb, parentId, raw);
    console.warn('[family-camp-ledger] cleared orphan balance_cents', { parentId, raw });
  } catch (e) {
    console.error('[family-camp-ledger] orphan ledger clear failed', e && e.message);
  }
  return 0;
}

async function addFamilyCampLedgerCents(sb, parentId, cents) {
  const c = Math.max(0, Math.round(Number(cents) || 0));
  if (!parentId || c <= 0) return;
  const { error } = await sb.rpc('family_camp_ledger_add', { p_parent: parentId, p_cents: c });
  if (error) throw error;
}

async function subtractFamilyCampLedgerCents(sb, parentId, cents) {
  const c = Math.max(0, Math.round(Number(cents) || 0));
  if (!parentId || c <= 0) return;
  const { error } = await sb.rpc('family_camp_ledger_subtract', { p_parent: parentId, p_cents: c });
  if (error) throw error;
}

module.exports = {
  campCreditCentsForConfirmedRow,
  getFamilyCampLedgerCents,
  getReconciledFamilyCampLedgerCents,
  addFamilyCampLedgerCents,
  subtractFamilyCampLedgerCents,
  enrollmentCoversFullWeek,
};
