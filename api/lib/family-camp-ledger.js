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

/** @returns {Promise<'week'|'day'>} */
async function campCreditBucketForConfirmedRow(sb, row) {
  if (!row || !row.week_id) return 'day';
  const days = await loadOrderedDaysForWeek(sb, row.week_id);
  return enrollmentCoversFullWeek(row.day_ids || [], days) ? 'week' : 'day';
}

async function getFamilyCampLedgerBalances(sb, parentId) {
  if (!parentId) return { weekCents: 0, dayCents: 0 };
  const { data, error } = await sb
    .from('family_camp_credit_ledger')
    .select('balance_week_cents, balance_day_cents')
    .eq('parent_id', parentId)
    .maybeSingle();
  if (error) throw error;
  return {
    weekCents: Math.max(0, Math.round(Number(data && data.balance_week_cents) || 0)),
    dayCents: Math.max(0, Math.round(Number(data && data.balance_day_cents) || 0)),
  };
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

async function getReconciledFamilyCampLedgerBalances(sb, parentId) {
  const { weekCents, dayCents } = await getFamilyCampLedgerBalances(sb, parentId);
  const total = weekCents + dayCents;
  if (total <= 0) return { weekCents: 0, dayCents: 0 };
  const justified = await parentHasLedgerJustifyingCancelledEnrollment(sb, parentId);
  if (justified) return { weekCents, dayCents };
  try {
    await subtractFamilyCampLedgerSplit(sb, parentId, weekCents, dayCents);
    console.warn('[family-camp-ledger] cleared orphan week/day balances', { parentId, weekCents, dayCents });
  } catch (e) {
    console.error('[family-camp-ledger] orphan ledger clear failed', e && e.message);
  }
  return { weekCents: 0, dayCents: 0 };
}

/** @deprecated use getReconciledFamilyCampLedgerBalances */
async function getReconciledFamilyCampLedgerCents(sb, parentId) {
  const b = await getReconciledFamilyCampLedgerBalances(sb, parentId);
  return b.weekCents + b.dayCents;
}

async function addFamilyCampLedgerWeekCents(sb, parentId, cents) {
  const c = Math.max(0, Math.round(Number(cents) || 0));
  if (!parentId || c <= 0) return;
  const { error } = await sb.rpc('family_camp_ledger_add_week', { p_parent: parentId, p_cents: c });
  if (error) throw error;
}

async function addFamilyCampLedgerDayCents(sb, parentId, cents) {
  const c = Math.max(0, Math.round(Number(cents) || 0));
  if (!parentId || c <= 0) return;
  const { error } = await sb.rpc('family_camp_ledger_add_day', { p_parent: parentId, p_cents: c });
  if (error) throw error;
}

async function subtractFamilyCampLedgerSplit(sb, parentId, weekCents, dayCents) {
  const w = Math.max(0, Math.round(Number(weekCents) || 0));
  const d = Math.max(0, Math.round(Number(dayCents) || 0));
  if (!parentId || (w <= 0 && d <= 0)) return;
  const { error } = await sb.rpc('family_camp_ledger_subtract_split', {
    p_parent: parentId,
    p_week_cents: w,
    p_day_cents: d,
  });
  if (error) throw error;
}

/** @deprecated use subtractFamilyCampLedgerSplit */
async function subtractFamilyCampLedgerCents(sb, parentId, cents) {
  const c = Math.max(0, Math.round(Number(cents) || 0));
  if (!parentId || c <= 0) return;
  const { weekCents, dayCents } = await getFamilyCampLedgerBalances(sb, parentId);
  const fromWeek = Math.min(weekCents, c);
  let rest = c - fromWeek;
  const fromDay = Math.min(dayCents, rest);
  await subtractFamilyCampLedgerSplit(sb, parentId, fromWeek, fromDay);
}

module.exports = {
  campCreditCentsForConfirmedRow,
  campCreditBucketForConfirmedRow,
  getFamilyCampLedgerBalances,
  getReconciledFamilyCampLedgerBalances,
  getReconciledFamilyCampLedgerCents,
  addFamilyCampLedgerWeekCents,
  addFamilyCampLedgerDayCents,
  subtractFamilyCampLedgerSplit,
  subtractFamilyCampLedgerCents,
  enrollmentCoversFullWeek,
};
