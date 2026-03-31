/** Stable camper id key (UUID casing differs between client and DB). */
function normCamperKey(id) {
  if (id == null) return '';
  const s = String(id).trim();
  return s ? s.toLowerCase() : '';
}

/**
 * index.html uses camelCase; older clients may send snake_case. Coerce dayIds if sent as object map.
 */
function normalizeIncomingBookings(rawBookings) {
  if (!Array.isArray(rawBookings)) return [];
  const out = [];
  for (let i = 0; i < rawBookings.length; i++) {
    const b = rawBookings[i];
    if (!b || typeof b !== 'object') continue;
    const weekId = b.weekId != null ? b.weekId : b.week_id;
    const camperId = b.camperId != null ? b.camperId : b.camper_id;
    let dayIds = b.dayIds != null ? b.dayIds : b.day_ids;
    if (!Array.isArray(dayIds)) {
      if (dayIds && typeof dayIds === 'object') {
        dayIds = Object.keys(dayIds)
          .filter((k) => /^\d+$/.test(String(k)))
          .sort((a, b) => Number(a) - Number(b))
          .map((k) => dayIds[k]);
      } else {
        dayIds = [];
      }
    }
    const pm = b.pricingMode != null ? b.pricingMode : b.pricing_mode;
    const pricingMode =
      pm === 'full_week' || pm === 'weekly' || pm === 'full' || pm === 'fullWeek' ? 'full_week' : 'daily';

    const ck = normCamperKey(camperId);
    if (weekId == null || String(weekId).trim() === '' || !ck) continue;
    const idList = [...new Set(dayIds.map((id) => String(id).trim()).filter(Boolean))];
    out.push({
      weekId: String(weekId).trim(),
      camperId: ck,
      dayIds: idList,
      pricingMode,
    });
  }
  return out;
}

module.exports = { normCamperKey, normalizeIncomingBookings };
