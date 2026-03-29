/**
 * Family-level prepaid "floating" credits: confirmed enrollments for a camper+week
 * that are NOT part of the current checkout request consume pool (week or day units)
 * applied to new booking lines in stable sort order.
 */

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

function applyPoolToBookings(sortedBookings, poolW, poolD, wr, dr) {
  let pw = poolW;
  let pd = poolD;
  const campLineCents = [];
  let campCentsTotal = 0;
  for (const b of sortedBookings) {
    const mode = b.pricingMode === 'full_week' ? 'full_week' : 'daily';
    if (mode === 'full_week') {
      if (pw > 0) {
        pw -= 1;
        campLineCents.push(0);
      } else {
        const c = Math.round(wr * 100);
        campCentsTotal += c;
        campLineCents.push(c);
      }
    } else {
      const n = (b.dayIds || []).length;
      const useD = Math.min(n, pd);
      pd -= useD;
      const chargeDays = n - useD;
      const c = Math.round(chargeDays * dr * 100);
      campCentsTotal += c;
      campLineCents.push(c);
    }
  }
  return { campLineCents, campCentsTotal, remainingWeeks: pw, remainingDays: pd };
}

/**
 * Load confirmed enrollments for parent's campers; return floating week/day pool + week meta for sorting.
 */
async function loadFloatingPrepaidPool(sb, parentId, bookingsArray, normCamperKeyFn, prepaidUiCoverageKeys) {
  const { data: campers, error: ce } = await sb.from('campers').select('id').eq('parent_id', parentId);
  if (ce) throw ce;
  const camperIds = (campers || []).map((c) => String(c.id));
  if (!camperIds.length) {
    return { poolW: 0, poolD: 0, weekMetaMap: new Map() };
  }

  const { data: enrollRows, error: ee } = await sb
    .from('enrollments')
    .select('camper_id,week_id,day_ids')
    .eq('parent_id', parentId)
    .eq('status', 'confirmed')
    .in('camper_id', camperIds);
  if (ee) throw ee;

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
  return { poolW, poolD, weekMetaMap };
}

module.exports = {
  normUuid,
  loadFloatingPrepaidPool,
  sortBookingsForCreditApply,
  applyPoolToBookings,
};
