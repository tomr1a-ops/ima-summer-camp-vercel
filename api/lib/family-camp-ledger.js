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

/** Which ledger rail this enrollment's camp credits belong to. */
function ledgerPaymentMethodForEnrollment(row) {
  if (!row) return 'credit_card';
  const st = String(row.status || '');
  if (st === 'pending_step_up') return 'step_up';
  if (st === 'confirmed') {
    if (row.stripe_session_id != null && String(row.stripe_session_id).trim() !== '') return 'credit_card';
    return 'step_up';
  }
  return 'credit_card';
}

async function getFamilyCampLedgerBalancesAll(sb, parentId) {
  if (!parentId) {
    return {
      weekCentsCreditCard: 0,
      dayCentsCreditCard: 0,
      weekCentsStepUp: 0,
      dayCentsStepUp: 0,
    };
  }
  const { data, error } = await sb
    .from('family_camp_credit_ledger')
    .select(
      'balance_week_cents_credit_card, balance_day_cents_credit_card, balance_week_cents_step_up, balance_day_cents_step_up'
    )
    .eq('parent_id', parentId)
    .maybeSingle();
  if (error) throw error;
  return {
    weekCentsCreditCard: Math.max(0, Math.round(Number(data && data.balance_week_cents_credit_card) || 0)),
    dayCentsCreditCard: Math.max(0, Math.round(Number(data && data.balance_day_cents_credit_card) || 0)),
    weekCentsStepUp: Math.max(0, Math.round(Number(data && data.balance_week_cents_step_up) || 0)),
    dayCentsStepUp: Math.max(0, Math.round(Number(data && data.balance_day_cents_step_up) || 0)),
  };
}

/**
 * @param {{ paymentMethod?: 'step_up'|'credit_card' }} [opts] If set, only that rail's week/day cents (for checkout UI).
 */
async function getFamilyCampLedgerBalances(sb, parentId, opts) {
  const all = await getFamilyCampLedgerBalancesAll(sb, parentId);
  const pm = opts && opts.paymentMethod === 'step_up' ? 'step_up' : opts && opts.paymentMethod === 'credit_card' ? 'credit_card' : null;
  if (pm === 'step_up') {
    return { weekCents: all.weekCentsStepUp, dayCents: all.dayCentsStepUp };
  }
  if (pm === 'credit_card') {
    return { weekCents: all.weekCentsCreditCard, dayCents: all.dayCentsCreditCard };
  }
  return {
    weekCents: all.weekCentsCreditCard + all.weekCentsStepUp,
    dayCents: all.dayCentsCreditCard + all.dayCentsStepUp,
  };
}

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

async function getReconciledFamilyCampLedgerBalances(sb, parentId, opts) {
  const all = await getFamilyCampLedgerBalancesAll(sb, parentId);
  const total = all.weekCentsCreditCard + all.dayCentsCreditCard + all.weekCentsStepUp + all.dayCentsStepUp;
  if (total <= 0) {
    const pm = opts && opts.paymentMethod;
    if (pm === 'step_up') return { weekCents: 0, dayCents: 0 };
    if (pm === 'credit_card') return { weekCents: 0, dayCents: 0 };
    return { weekCents: 0, dayCents: 0 };
  }
  const justified = await parentHasLedgerJustifyingCancelledEnrollment(sb, parentId);
  if (justified) {
    return getFamilyCampLedgerBalances(sb, parentId, opts);
  }
  try {
    if (all.weekCentsCreditCard + all.dayCentsCreditCard > 0) {
      await subtractFamilyCampLedgerSplit(sb, parentId, all.weekCentsCreditCard, all.dayCentsCreditCard, 'credit_card');
    }
    if (all.weekCentsStepUp + all.dayCentsStepUp > 0) {
      await subtractFamilyCampLedgerSplit(sb, parentId, all.weekCentsStepUp, all.dayCentsStepUp, 'step_up');
    }
    console.warn('[family-camp-ledger] cleared orphan rail balances', { parentId, all });
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

async function addFamilyCampLedgerWeekCents(sb, parentId, cents, paymentMethod = 'credit_card') {
  const c = Math.max(0, Math.round(Number(cents) || 0));
  if (!parentId || c <= 0) return;
  const pm = paymentMethod === 'step_up' ? 'step_up' : 'credit_card';
  const { error } = await sb.rpc('family_camp_ledger_add_week', {
    p_parent: parentId,
    p_cents: c,
    p_payment_method: pm,
  });
  if (error) throw error;
}

async function addFamilyCampLedgerDayCents(sb, parentId, cents, paymentMethod = 'credit_card') {
  const c = Math.max(0, Math.round(Number(cents) || 0));
  if (!parentId || c <= 0) return;
  const pm = paymentMethod === 'step_up' ? 'step_up' : 'credit_card';
  const { error } = await sb.rpc('family_camp_ledger_add_day', {
    p_parent: parentId,
    p_cents: c,
    p_payment_method: pm,
  });
  if (error) throw error;
}

async function subtractFamilyCampLedgerSplit(sb, parentId, weekCents, dayCents, paymentMethod = 'credit_card') {
  const w = Math.max(0, Math.round(Number(weekCents) || 0));
  const d = Math.max(0, Math.round(Number(dayCents) || 0));
  if (!parentId || (w <= 0 && d <= 0)) return;
  const pm = paymentMethod === 'step_up' ? 'step_up' : 'credit_card';
  const { error } = await sb.rpc('family_camp_ledger_subtract_split', {
    p_parent: parentId,
    p_week_cents: w,
    p_day_cents: d,
    p_payment_method: pm,
  });
  if (error) throw error;
}

/** @deprecated use subtractFamilyCampLedgerSplit */
async function subtractFamilyCampLedgerCents(sb, parentId, cents) {
  const c = Math.max(0, Math.round(Number(cents) || 0));
  if (!parentId || c <= 0) return;
  const all = await getFamilyCampLedgerBalancesAll(sb, parentId);
  const fromWeekCc = Math.min(all.weekCentsCreditCard, c);
  let rest = c - fromWeekCc;
  const fromDayCc = Math.min(all.dayCentsCreditCard, rest);
  rest -= fromDayCc;
  const fromWeekSu = Math.min(all.weekCentsStepUp, rest);
  rest -= fromWeekSu;
  const fromDaySu = Math.min(all.dayCentsStepUp, rest);
  if (fromWeekCc + fromDayCc > 0) {
    await subtractFamilyCampLedgerSplit(sb, parentId, fromWeekCc, fromDayCc, 'credit_card');
  }
  if (fromWeekSu + fromDaySu > 0) {
    await subtractFamilyCampLedgerSplit(sb, parentId, fromWeekSu, fromDaySu, 'step_up');
  }
}

module.exports = {
  campCreditCentsForConfirmedRow,
  campCreditBucketForConfirmedRow,
  ledgerPaymentMethodForEnrollment,
  getFamilyCampLedgerBalances,
  getFamilyCampLedgerBalancesAll,
  getReconciledFamilyCampLedgerBalances,
  getReconciledFamilyCampLedgerCents,
  addFamilyCampLedgerWeekCents,
  addFamilyCampLedgerDayCents,
  subtractFamilyCampLedgerSplit,
  subtractFamilyCampLedgerCents,
  enrollmentCoversFullWeek,
};
