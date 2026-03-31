/**
 * Waitlist: sold-out weeks, offers after capacity frees, 24h checkout window.
 */

const { dayOccupancyFromDaysTable, countDistinctCampersInWeek } = require('./capacity');

const OFFER_HOURS = 24;

async function weekPeakVsMax(sb, weekId) {
  const { data: week, error: we } = await sb.from('weeks').select('max_capacity,label').eq('id', weekId).maybeSingle();
  if (we) throw we;
  if (!week) return { peak: 0, max: 35, label: '' };
  const max = Number(week.max_capacity) > 0 ? Number(week.max_capacity) : 35;
  const { peak } = await dayOccupancyFromDaysTable(sb, weekId);
  return { peak, max, label: week.label || '' };
}

/** True when at least one more distinct camper could be added (peak headroom). */
async function weekHasOpenSlotForNewCamper(sb, weekId) {
  const { peak, max } = await weekPeakVsMax(sb, weekId);
  return peak < max;
}

async function countWaitingForWeek(sb, weekId) {
  const { count, error } = await sb
    .from('waitlist')
    .select('id', { count: 'exact', head: true })
    .eq('week_id', weekId)
    .eq('status', 'waiting');
  if (error) throw error;
  return Number(count) || 0;
}

/** Map week_id -> waiting count (single round-trip). */
async function waitingCountsByWeekIds(sb, weekIds) {
  const ids = [...new Set((weekIds || []).map((id) => String(id).trim()).filter(Boolean))];
  const out = {};
  ids.forEach((id) => {
    out[id] = 0;
  });
  if (!ids.length) return out;
  const { data, error } = await sb.from('waitlist').select('week_id').eq('status', 'waiting').in('week_id', ids);
  if (error) throw error;
  for (const row of data || []) {
    const w = String(row.week_id);
    out[w] = (out[w] || 0) + 1;
  }
  return out;
}

/**
 * Parent-visible waitlist rows with queue rank among `waiting` (1-based).
 */
async function waitlistEntriesForParent(sb, parentId) {
  const { data: rows, error } = await sb
    .from('waitlist')
    .select('id, camper_id, week_id, position, status, offered_at, expires_at, created_at')
    .eq('parent_id', parentId)
    .in('status', ['waiting', 'offered'])
    .order('created_at', { ascending: true });
  if (error) throw error;
  const list = rows || [];
  const weekIds = [...new Set(list.map((r) => String(r.week_id)))];
  const ranks = {};
  for (const wid of weekIds) {
    const { data: waitingRows, error: we } = await sb
      .from('waitlist')
      .select('id, created_at')
      .eq('week_id', wid)
      .eq('status', 'waiting')
      .order('created_at', { ascending: true });
    if (we) throw we;
    const sorted = [...(waitingRows || [])].sort(function (a, b) {
      const ta = new Date(a.created_at).getTime();
      const tb = new Date(b.created_at).getTime();
      if (ta !== tb) return ta - tb;
      return String(a.id).localeCompare(String(b.id));
    });
    sorted.forEach(function (w, idx) {
      ranks[String(w.id)] = idx + 1;
    });
  }
  return list.map((r) => ({
    ...r,
    queueRank: r.status === 'waiting' ? ranks[String(r.id)] || null : null,
  }));
}

async function verifyWaitlistOfferForCheckout(sb, { waitlistId, parentId, camperId, weekId }) {
  if (!waitlistId || !parentId || !camperId || !weekId) return null;
  const nowIso = new Date().toISOString();
  const { data: row, error } = await sb
    .from('waitlist')
    .select('id, parent_id, camper_id, week_id, status, expires_at')
    .eq('id', waitlistId)
    .maybeSingle();
  if (error) throw error;
  if (!row) return null;
  if (String(row.parent_id) !== String(parentId)) return null;
  if (String(row.camper_id) !== String(camperId)) return null;
  if (String(row.week_id) !== String(weekId)) return null;
  if (row.status !== 'offered') return null;
  if (!row.expires_at || String(row.expires_at) <= nowIso) return null;
  return row;
}

/** Run DB promotion (expires stale offered in-week, then first waiting → offered). Returns new offer id or null. */
async function promoteNextWaitlistOffer(sb, weekId) {
  const { data: offeredId, error } = await sb.rpc('waitlist_offer_next', {
    p_week_id: weekId,
    p_offer_hours: OFFER_HOURS,
  });
  if (error) {
    if (String(error.message || '').includes('waitlist_offer_next') || error.code === '42883') {
      console.warn('[waitlist] waitlist_offer_next RPC missing — run migration');
      return null;
    }
    throw error;
  }
  if (!offeredId) return null;
  return String(offeredId);
}

/**
 * After any enrollment is removed (confirmed / Step Up / pending): promote if days or distinct-camper headroom allows another signup.
 */
async function tryPromoteWaitlistAfterEnrollmentRemoved(sb, weekId) {
  const { peak, max } = await weekPeakVsMax(sb, weekId);
  const openDays = peak < max;
  let openDistinct = false;
  if (!openDays) {
    const distinct = await countDistinctCampersInWeek(sb, weekId, null);
    openDistinct = distinct < max;
  }
  if (!openDays && !openDistinct) return null;
  return promoteNextWaitlistOffer(sb, weekId);
}

async function loadWaitlistRowForEmail(sb, waitlistId) {
  const { data: w, error } = await sb
    .from('waitlist')
    .select('id, camper_id, week_id, parent_id, status, expires_at')
    .eq('id', waitlistId)
    .maybeSingle();
  if (error) throw error;
  if (!w) return null;
  const [{ data: camper }, { data: week }, { data: profile }] = await Promise.all([
    sb.from('campers').select('first_name, last_name').eq('id', w.camper_id).maybeSingle(),
    sb.from('weeks').select('label, week_number').eq('id', w.week_id).maybeSingle(),
    sb.from('profiles').select('email, full_name').eq('id', w.parent_id).maybeSingle(),
  ]);
  return {
    waitlist: w,
    camperName:
      camper && (camper.first_name || camper.last_name)
        ? `${camper.first_name || ''} ${camper.last_name || ''}`.trim()
        : 'Your child',
    weekLabel: (week && week.label) || 'Camp week',
    parentEmail: (profile && profile.email) || null,
    parentName: (profile && profile.full_name) || '',
  };
}

async function markWaitlistConverted(sb, waitlistIds, parentId) {
  const ids = [...new Set((waitlistIds || []).map((id) => String(id).trim()).filter(Boolean))];
  if (!ids.length) return;
  let q = sb.from('waitlist').update({ status: 'converted' }).in('id', ids).eq('status', 'offered');
  if (parentId) q = q.eq('parent_id', parentId);
  const { error } = await q;
  if (error) throw error;
}

/**
 * Cron: expire overdue offers; for each affected week try to offer next (no headroom check —
 * next family uses waitlist bypass at checkout).
 */
async function expireStaleOffersAndChain(sb) {
  const nowIso = new Date().toISOString();
  const { data: stale, error: se } = await sb
    .from('waitlist')
    .select('id, week_id')
    .eq('status', 'offered')
    .lte('expires_at', nowIso);
  if (se) throw se;
  const rows = stale || [];
  if (!rows.length) return { expired: 0, newOffers: [] };

  const { error: ue } = await sb.from('waitlist').update({ status: 'expired' }).eq('status', 'offered').lte('expires_at', nowIso);
  if (ue) throw ue;

  const weekSet = [...new Set(rows.map((r) => String(r.week_id)))];
  const newOffers = [];
  for (const wid of weekSet) {
    try {
      const nid = await promoteNextWaitlistOffer(sb, wid);
      if (nid) newOffers.push(nid);
    } catch (e) {
      console.error('[waitlist] chain offer after expiry', wid, e && e.message);
    }
  }
  return { expired: rows.length, newOffers };
}

async function joinWaitlistRpc(sb, { camperId, weekId, parentId }) {
  const { data, error } = await sb.rpc('waitlist_join', {
    p_camper_id: camperId,
    p_week_id: weekId,
    p_parent_id: parentId,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (row && row.entry_id != null) {
    return { id: String(row.entry_id), position: Number(row.entry_position) || 0 };
  }
  return { id: null, position: null };
}

async function notifyWaitlistOffer(sb, offeredWaitlistId) {
  if (!offeredWaitlistId) return;
  const { sendWaitlistSpotOfferEmail } = require('./email');
  try {
    const pack = await loadWaitlistRowForEmail(sb, offeredWaitlistId);
    if (!pack || !pack.parentEmail) {
      console.warn('[waitlist] offer email skip: no email', offeredWaitlistId);
      return;
    }
    await sendWaitlistSpotOfferEmail({
      parentEmail: pack.parentEmail,
      camperName: pack.camperName,
      weekLabel: pack.weekLabel,
      expiresAtIso: pack.waitlist.expires_at,
    });
  } catch (e) {
    console.error('[waitlist] notify offer email', e && e.message);
  }
}

module.exports = {
  OFFER_HOURS,
  weekHasOpenSlotForNewCamper,
  weekPeakVsMax,
  countWaitingForWeek,
  waitingCountsByWeekIds,
  waitlistEntriesForParent,
  verifyWaitlistOfferForCheckout,
  promoteNextWaitlistOffer,
  tryPromoteWaitlistAfterEnrollmentRemoved,
  loadWaitlistRowForEmail,
  markWaitlistConverted,
  expireStaleOffersAndChain,
  joinWaitlistRpc,
  notifyWaitlistOffer,
};
