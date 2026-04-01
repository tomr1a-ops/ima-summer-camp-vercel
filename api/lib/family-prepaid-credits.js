/**
 * Family-level prepaid "floating" credits: confirmed enrollments for a camper+week
 * that are NOT part of the current checkout request consume pool (week or day units)
 * applied to new booking lines in stable sort order.
 *
 * Plus optional `family_camp_credit_ledger` week/day balances (cents) from cancelled paid enrollments.
 */

const { getReconciledFamilyCampLedgerBalances, ledgerPaymentMethodForEnrollment } = require('./family-camp-ledger');
const { enrollmentQualifiesForCampCredit } = require('./enrollment-credit-eligibility');

function normUuid(v) {
  if (v == null) return '';
  return String(v).trim().toLowerCase();
}

function enrollmentCoversFullWeek(dayIds, weekDaysOrdered) {
  if (!weekDaysOrdered || weekDaysOrdered.length !== 5) return false;
  const ids = new Set((dayIds || []).map((d) => String(d)));
  return weekDaysOrdered.every((d) => ids.has(String(d.id)));
}

function coalesceConfirmedByCamperWeek(enrollRows, weekDaysByWeekId) {
  const groups = {};
  for (const row of enrollRows || []) {
    if (!row || row.camper_id == null || row.week_id == null) continue;
    const key = `${normUuid(row.camper_id)}|${String(row.week_id)}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(row);
  }
  const out = [];
  for (const key of Object.keys(groups)) {
    const group = groups[key];
    const wk = String(group[0].week_id);
    const weekDays = weekDaysByWeekId.get(wk) || [];
    const fullRow = group.find((r) => enrollmentCoversFullWeek(r.day_ids || [], weekDays));
    if (fullRow) {
      out.push({ camper_id: group[0].camper_id, week_id: wk, full: true, day_ids: [] });
    } else {
      const daySet = new Set();
      for (const r of group) {
        for (const d of r.day_ids || []) daySet.add(String(d));
      }
      out.push({ camper_id: group[0].camper_id, week_id: wk, full: false, day_ids: Array.from(daySet) });
    }
  }
  return out;
}

/**
 * @param {string[]} prepaidUiCoverageKeys normalized "camperKey|weekId" for confirmed rows the parent
 * already has reflected in the registration UI (matches client paidEnrollmentMatchesPicker). Those slots
 * must not count as "floating" prepaid to apply toward other weeks in checkout.
 */
function computeFloatingPool(coalesced, bookingsArray, normCamperKeyFn, prepaidUiCoverageKeys) {
  const cov = new Set((prepaidUiCoverageKeys || []).map((k) => String(k).trim().toLowerCase()));
  let poolW = 0;
  let poolD = 0;
  for (const e of coalesced) {
    const c = normCamperKeyFn(e.camper_id);
    const w = String(e.week_id);
    const slotKey = `${c}|${w}`.toLowerCase();
    if (cov.has(slotKey)) continue;
    const hasRequest = bookingsArray.some(
      (b) => normCamperKeyFn(b.camperId) === c && String(b.weekId) === w
    );
    if (hasRequest) continue;
    if (e.full) poolW += 1;
    else poolD += (e.day_ids || []).length;
  }
  return { poolW, poolD };
}

/**
 * @param {object[]} bookingsArray
 * @param {Map<string, { week_number?: number }>} weekMetaMap weekId -> { week_number }
 */
function sortBookingsForCreditApply(bookingsArray, weekMetaMap) {
  return [...bookingsArray].sort((a, b) => {
    const wa = weekMetaMap.get(String(a.weekId));
    const wb = weekMetaMap.get(String(b.weekId));
    const na = Number((wa && wa.week_number) || 0);
    const nb = Number((wb && wb.week_number) || 0);
    if (na !== nb) return na - nb;
    return normUuid(a.camperId).localeCompare(normUuid(b.camperId));
  });
}

/**
 * Turn leftover prepaid value (cents) into week + day counts for UI (greedy weeks first).
 */
function decomposeRemainingPrepaidCents(cents, wrC, drC) {
  let c = Math.max(0, Math.round(Number(cents) || 0));
  let w = 0;
  if (wrC > 0) {
    while (c >= wrC) {
      w += 1;
      c -= wrC;
    }
  }
  const d = drC > 0 ? Math.floor(c / drC) : 0;
  return { weeks: w, days: d };
}

/**
 * Apply floating prepaid to camp line items in sort order.
 * Week credits (enrollment full-week float + ledger week bucket) apply only to full_week lines.
 * Day credits apply only to daily lines. Buckets do not cross-apply.
 */
function applyPoolToBookings(sortedBookings, poolW, poolD, wr, dr, ledgerWeekCents = 0, ledgerDayCents = 0) {
  const wrC = Math.round(Number(wr) * 100);
  const drC = Math.round(Number(dr) * 100);
  let encWCents = Math.max(0, (Number(poolW) || 0) * wrC);
  let encDCents = Math.max(0, (Number(poolD) || 0) * drC);
  let ledW = Math.max(0, Math.round(Number(ledgerWeekCents) || 0));
  let ledD = Math.max(0, Math.round(Number(ledgerDayCents) || 0));
  const campLineCents = [];
  let campCentsTotal = 0;
  let ledgerWeekConsumedCents = 0;
  let ledgerDayConsumedCents = 0;
  for (const b of sortedBookings) {
    const mode = b.pricingMode === 'full_week' ? 'full_week' : 'daily';
    let needCents;
    if (mode === 'full_week') {
      needCents = wrC;
      const fromEnc = Math.min(encWCents, needCents);
      encWCents -= fromEnc;
      const remainder = needCents - fromEnc;
      const fromLed = Math.min(ledW, remainder);
      ledW -= fromLed;
      ledgerWeekConsumedCents += fromLed;
      const chargeCents = needCents - fromEnc - fromLed;
      campLineCents.push(chargeCents);
      campCentsTotal += chargeCents;
    } else {
      const n = (b.dayIds || []).length;
      needCents = n * drC;
      const fromEnc = Math.min(encDCents, needCents);
      encDCents -= fromEnc;
      const remainder = needCents - fromEnc;
      const fromLed = Math.min(ledD, remainder);
      ledD -= fromLed;
      ledgerDayConsumedCents += fromLed;
      const chargeCents = needCents - fromEnc - fromLed;
      campLineCents.push(chargeCents);
      campCentsTotal += chargeCents;
    }
  }
  const remainingWeekCents = encWCents + ledW;
  const remainingDayCents = encDCents + ledD;
  const remainingWeeks = wrC > 0 ? Math.floor(remainingWeekCents / wrC) : 0;
  const remainingDays = drC > 0 ? Math.floor(remainingDayCents / drC) : 0;
  const remainingPrepaidCents = remainingWeekCents + remainingDayCents;
  return {
    campLineCents,
    campCentsTotal,
    remainingWeeks,
    remainingDays,
    remainingWeekCents,
    remainingDayCents,
    remainingPrepaidCents,
    ledgerWeekConsumedCents,
    ledgerDayConsumedCents,
    ledgerConsumedCents: ledgerWeekConsumedCents + ledgerDayConsumedCents,
  };
}

/**
 * Load confirmed enrollments for parent's campers; return floating week/day pool + week meta for sorting.
 */
async function loadFloatingPrepaidPool(
  sb,
  parentId,
  bookingsArray,
  normCamperKeyFn,
  prepaidUiCoverageKeys,
  paymentMethod = 'credit_card'
) {
  const pm = paymentMethod === 'step_up' ? 'step_up' : 'credit_card';
  const { data: campers, error: ce } = await sb.from('campers').select('id').eq('parent_id', parentId);
  if (ce) throw ce;
  const camperIds = (campers || []).map((c) => String(c.id));
  const { weekCents: ledgerWeekCents, dayCents: ledgerDayCents } = await getReconciledFamilyCampLedgerBalances(
    sb,
    parentId,
    { paymentMethod: pm }
  );
  if (!camperIds.length) {
    return { poolW: 0, poolD: 0, weekMetaMap: new Map(), ledgerWeekCents, ledgerDayCents };
  }

  const { data: enrollRowsRaw, error: ee } = await sb
    .from('enrollments')
    .select('camper_id,week_id,day_ids,status,price_paid,stripe_session_id,checkout_batch_id')
    .eq('parent_id', parentId)
    .eq('status', 'confirmed')
    .in('camper_id', camperIds);
  if (ee) throw ee;

  const enrollRows = (enrollRowsRaw || []).filter(
    (r) => enrollmentQualifiesForCampCredit(r) && ledgerPaymentMethodForEnrollment(r) === pm
  );

  const weekIds = [...new Set((enrollRows || []).map((r) => String(r.week_id)))];
  const weekMetaMap = new Map();
  const weekDaysByWeekId = new Map();

  if (weekIds.length) {
    const [weeksRes, daysRes] = await Promise.all([
      sb.from('weeks').select('id,week_number').in('id', weekIds),
      sb
        .from('days')
        .select('id,week_id,date')
        .in('week_id', weekIds)
        .order('date', { ascending: true }),
    ]);
    const { data: weeks, error: we } = weeksRes;
    if (we) throw we;
    for (const w of weeks || []) {
      weekMetaMap.set(String(w.id), { week_number: w.week_number });
    }
    const { data: allDays, error: de } = daysRes;
    if (de) throw de;
    for (const wid of weekIds) weekDaysByWeekId.set(String(wid), []);
    for (const d of allDays || []) {
      const wid = String(d.week_id);
      const arr = weekDaysByWeekId.get(wid);
      if (arr) arr.push(d);
    }
  }

  const coalesced = coalesceConfirmedByCamperWeek(enrollRows || [], weekDaysByWeekId);
  const { poolW, poolD } = computeFloatingPool(
    coalesced,
    bookingsArray,
    normCamperKeyFn,
    prepaidUiCoverageKeys
  );
  return { poolW, poolD, weekMetaMap, ledgerWeekCents, ledgerDayCents };
}

module.exports = {
  normUuid,
  loadFloatingPrepaidPool,
  sortBookingsForCreditApply,
  applyPoolToBookings,
  decomposeRemainingPrepaidCents,
};
