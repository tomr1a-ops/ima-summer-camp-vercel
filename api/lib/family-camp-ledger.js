const { loadOrderedDaysForWeek } = require('./capacity');
const { dayRate, weekRate } = require('./pricing');

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
  addFamilyCampLedgerCents,
  subtractFamilyCampLedgerCents,
  enrollmentCoversFullWeek,
};
