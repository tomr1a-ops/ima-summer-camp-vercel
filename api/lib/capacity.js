/**
 * Shared week/day capacity checks for checkout and enrollment updates.
 */

async function countDistinctCampersInWeek(sb, weekId, excludeEnrollmentId) {
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
  const ids = Array.isArray(dayIds) ? dayIds : [];
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
    const expectedIds = allDays.map((d) => d.id).sort().join(',');
    const gotIds = [...ids].sort().join(',');
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
    if (d.week_id !== weekId) {
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
  validateBooking,
  validateAddedDaysOnly,
  syncConfirmedDayCounts,
};
