/**
 * Shared week/day capacity checks for checkout and enrollment updates.
 */

/** Case-insensitive UUID/string compare (client may send different casing than Postgres). */
function normUuid(v) {
  if (v == null) return '';
  return String(v).trim().toLowerCase();
}

async function countDistinctCampersInWeek(sb, weekId, excludeEnrollmentId) {
  const { data: rpcData, error: rpcErr } = await sb.rpc('week_distinct_camper_count', {
    p_week_id: weekId,
    p_exclude_enrollment_id: excludeEnrollmentId || null,
  });
  if (!rpcErr && rpcData != null && Number.isFinite(Number(rpcData))) {
    return Number(rpcData);
  }
  let q = sb
    .from('enrollments')
    .select('camper_id')
    .eq('week_id', weekId)
    .in('status', ['pending', 'confirmed']);
  if (excludeEnrollmentId) q = q.neq('id', excludeEnrollmentId);
  const { data, error } = await q;
  if (error) throw error;
  return new Set((data || []).map((r) => r.camper_id).filter(Boolean)).size;
}

async function camperHasEnrollmentInWeek(sb, weekId, camperId, excludeEnrollmentId) {
  let q = sb
    .from('enrollments')
    .select('id')
    .eq('week_id', weekId)
    .eq('camper_id', camperId)
    .in('status', ['pending', 'confirmed']);
  if (excludeEnrollmentId) q = q.neq('id', excludeEnrollmentId);
  const { data, error } = await q.limit(1);
  if (error) throw error;
  return (data || []).length > 0;
}

/** e.g. "Monday Jun 8" from ISO date (YYYY-MM-DD). */
function formatConflictDayFromIso(dateStr) {
  if (!dateStr) return 'a day';
  const p = String(dateStr).split('-');
  const dt = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  if (Number.isNaN(dt.getTime())) return 'a day';
  const wd = dt.toLocaleDateString('en-US', { weekday: 'long' });
  const md = dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${wd} ${md}`.replace(/,\s*/g, ' ').trim();
}

/**
 * First camp day (chronological) that is both proposed and already confirmed for this camper/week.
 * Used for full-week vs partial-paid messaging.
 */
async function firstConfirmedOverlapDay(sb, weekId, camperId, proposedDayIds, excludeEnrollmentId) {
  let q = sb
    .from('enrollments')
    .select('id,day_ids')
    .eq('week_id', weekId)
    .eq('camper_id', camperId)
    .eq('status', 'confirmed');
  if (excludeEnrollmentId) q = q.neq('id', excludeEnrollmentId);
  const { data, error } = await q;
  if (error) throw error;
  const proposed = new Set((proposedDayIds || []).map((id) => String(id)));
  const confirmedDayIds = new Set();
  for (const r of data || []) {
    for (const d of r.day_ids || []) {
      confirmedDayIds.add(String(d));
    }
  }
  const allDays = await loadOrderedDaysForWeek(sb, weekId);
  for (const d of allDays) {
    const id = String(d.id);
    if (proposed.has(id) && confirmedDayIds.has(id)) return d;
  }
  return null;
}

/**
 * True if any proposed day is already covered by a confirmed enrollment for this camper/week
 * (excluding one row when editing via PUT).
 */
async function proposedOverlapsConfirmedDays(sb, weekId, camperId, proposedDayIds, excludeEnrollmentId) {
  const d = await firstConfirmedOverlapDay(sb, weekId, camperId, proposedDayIds, excludeEnrollmentId);
  return d != null;
}

async function loadOrderedDaysForWeek(sb, weekId) {
  const { data: rows, error } = await sb.from('days').select('*').eq('week_id', weekId).order('date', { ascending: true });
  if (error) throw error;
  return rows || [];
}

/**
 * Full validation for a proposed week + days + camper (new checkout or replacement set).
 * @param {object} opts
 * @param {'full_week'|'daily'} [opts.pricingMode='daily'] — full_week requires all Mon–Fri days for the week.
 */
async function validateBooking(sb, { weekId, dayIds, camperId, excludeEnrollmentId, pricingMode = 'daily' }) {
  const raw = Array.isArray(dayIds) ? dayIds : [];
  const ids = [...new Set(raw.map((id) => String(id).trim()).filter(Boolean))];
  if (!weekId || !ids.length) {
    const err = new Error('Week and at least one day required');
    err.statusCode = 400;
    throw err;
  }

  const { data: week, error: we } = await sb.from('weeks').select('*').eq('id', weekId).single();
  if (we || !week) {
    const err = new Error('Invalid week');
    err.statusCode = 400;
    throw err;
  }
  if (!week.is_active) {
    const err = new Error('Week not open: ' + week.label);
    err.statusCode = 400;
    throw err;
  }
  if (week.is_full) {
    const err = new Error('Week is full: ' + week.label);
    err.statusCode = 400;
    throw err;
  }

  if (pricingMode === 'full_week') {
    const allDays = await loadOrderedDaysForWeek(sb, weekId);
    if (allDays.length !== 5) {
      const err = new Error('Full week requires exactly five camp days');
      err.statusCode = 400;
      throw err;
    }
    const expectedIds = allDays.map((d) => normUuid(d.id)).sort().join(',');
    const gotIds = [...ids].map(normUuid).sort().join(',');
    if (expectedIds !== gotIds) {
      const err = new Error('Full week must include all Mon–Fri days for this week');
      err.statusCode = 400;
      throw err;
    }
  }

  const { data: dayRows, error: de } = await sb.from('days').select('*').in('id', ids);
  if (de || !dayRows || dayRows.length !== ids.length) {
    const err = new Error('Invalid day selection');
    err.statusCode = 400;
    throw err;
  }

  const max = week.max_capacity || 35;
  for (const d of dayRows) {
    if (normUuid(d.week_id) !== normUuid(weekId)) {
      const err = new Error('Day does not belong to selected week');
      err.statusCode = 400;
      throw err;
    }
    if ((d.current_enrollment || 0) >= max) {
      const err = new Error('A selected day is at capacity');
      err.statusCode = 400;
      throw err;
    }
  }

  const overlapDay = await firstConfirmedOverlapDay(sb, weekId, camperId, ids, excludeEnrollmentId);
  if (overlapDay) {
    let message =
      'This child is already registered for one or more of these days this week. Uncheck days you already paid for, or contact IMA to change a registration.';
    if (pricingMode === 'full_week') {
      const { data: camper, error: camperErr } = await sb
        .from('campers')
        .select('first_name')
        .eq('id', camperId)
        .maybeSingle();
      const fn =
        !camperErr && camper && camper.first_name && String(camper.first_name).trim()
          ? String(camper.first_name).trim()
          : 'This child';
      message = `${fn} already has ${formatConflictDayFromIso(overlapDay.date)} booked. Remove that day or choose individual days instead.`;
    }
    const err = new Error(message);
    err.statusCode = 400;
    throw err;
  }

  const inWeek = await countDistinctCampersInWeek(sb, weekId, excludeEnrollmentId);
  const camperAlready = await camperHasEnrollmentInWeek(sb, weekId, camperId, excludeEnrollmentId);
  if (!camperAlready && inWeek >= max) {
    const err = new Error('Week is full');
    err.statusCode = 400;
    throw err;
  }
}

/**
 * For confirmed enrollment edits within the same week: only new days need spare slots.
 */
async function validateAddedDaysOnly(sb, weekId, addedDayIds) {
  if (!addedDayIds.length) return;
  const { data: week, error: we } = await sb.from('weeks').select('max_capacity').eq('id', weekId).single();
  if (we || !week) {
    const err = new Error('Invalid week');
    err.statusCode = 400;
    throw err;
  }
  const max = week.max_capacity || 35;
  for (const dayId of addedDayIds) {
    const { data: d, error: de } = await sb.from('days').select('current_enrollment').eq('id', dayId).single();
    if (de || !d) {
      const err = new Error('Invalid day');
      err.statusCode = 400;
      throw err;
    }
    if ((d.current_enrollment || 0) >= max) {
      const err = new Error('A day is at capacity');
      err.statusCode = 400;
      throw err;
    }
  }
}

/**
 * Adjust days.current_enrollment when a confirmed enrollment's days or week change.
 */
async function syncConfirmedDayCounts(sb, oldDayIds, newDayIds) {
  const oldSet = new Set(oldDayIds || []);
  const newSet = new Set(newDayIds || []);
  const removed = [...oldSet].filter((id) => !newSet.has(id));
  const added = [...newSet].filter((id) => !oldSet.has(id));

  for (const dayId of removed) {
    const { data: d, error: de } = await sb.from('days').select('current_enrollment').eq('id', dayId).single();
    if (de) throw de;
    const next = Math.max(0, (d.current_enrollment || 0) - 1);
    const { error: ue } = await sb.from('days').update({ current_enrollment: next }).eq('id', dayId);
    if (ue) throw ue;
  }
  for (const dayId of added) {
    const { data: d, error: de } = await sb.from('days').select('current_enrollment').eq('id', dayId).single();
    if (de) throw de;
    const { error: ue } = await sb
      .from('days')
      .update({ current_enrollment: (d.current_enrollment || 0) + 1 })
      .eq('id', dayId);
    if (ue) throw ue;
  }
}

module.exports = {
  countDistinctCampersInWeek,
  camperHasEnrollmentInWeek,
  proposedOverlapsConfirmedDays,
  firstConfirmedOverlapDay,
  validateBooking,
  validateAddedDaysOnly,
  syncConfirmedDayCounts,
  loadOrderedDaysForWeek,
};
