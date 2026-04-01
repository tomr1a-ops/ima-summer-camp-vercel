const { serviceClient } = require('./lib/supabase');
const { getUserFromRequest } = require('./lib/auth');
const { setNoStoreJsonHeaders } = require('./lib/http-no-store');
const { dayRate, weekRate } = require('./lib/pricing');
const { normCamperKey, normalizeIncomingBookings } = require('./lib/normalize-checkout-bookings');
const {
  loadFloatingPrepaidPool,
  sortBookingsForCreditApply,
  applyPoolToBookings,
} = require('./lib/family-prepaid-credits');

async function readJsonBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (Buffer.isBuffer(req.body)) {
      const s = req.body.toString('utf8');
      if (!s || !String(s).trim()) return {};
      return JSON.parse(s);
    }
    if (typeof req.body === 'string') {
      const s = req.body || '';
      if (!String(s).trim()) return {};
      return JSON.parse(s);
    }
    if (typeof req.body === 'object') return req.body;
  }
  const chunks = [];
  try {
    for await (const chunk of req) chunks.push(chunk);
  } catch (streamErr) {
    throw streamErr;
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!String(raw).trim()) return {};
  return JSON.parse(raw);
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  setNoStoreJsonHeaders(res);
  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: 'Method not allowed' }));
  }

  let body = {};
  try {
    body = await readJsonBody(req);
  } catch (e) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: 'Invalid JSON' }));
  }

  const { user, token } = await getUserFromRequest(req);
  if (!user || !token) {
    res.statusCode = 401;
    return res.end(JSON.stringify({ error: 'Sign in required' }));
  }

  let sb;
  try {
    sb = serviceClient();
  } catch (cfg) {
    res.statusCode = 503;
    return res.end(JSON.stringify({ error: cfg.message || 'Server misconfigured' }));
  }

  const tp = body && body.testPricing === true;
  const dr = dayRate(tp);
  const wr = weekRate(tp);
  const wrC = Math.round(Number(wr) * 100);
  const drC = Math.round(Number(dr) * 100);

  const rawBookings = Array.isArray(body.bookings) ? body.bookings : [];
  let bookingsArray = normalizeIncomingBookings(rawBookings);
  const prepaidCoverageKeys = Array.isArray(body.prepaidCoverageKeys) ? body.prepaidCoverageKeys : [];

  if (!bookingsArray.length) {
    res.statusCode = 200;
    return res.end(
      JSON.stringify({
        prepaidGrossCents: 0,
        ledgerWeekCents: 0,
        ledgerDayCents: 0,
        ledgerCents: 0,
        encPoolCents: 0,
        remainingPrepaidCents: 0,
        remainingWeekCents: 0,
        remainingDayCents: 0,
        remainingWeeks: 0,
        remainingDays: 0,
        lines: [],
      })
    );
  }

  const camperKeys = [...new Set(bookingsArray.map((b) => b.camperId).filter(Boolean))];
  const { data: camperList, error: batchCe } = await sb.from('campers').select('id, parent_id').in('id', camperKeys);
  if (batchCe) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: batchCe.message || 'Camper lookup failed' }));
  }
  const byKey = new Map((camperList || []).map((r) => [normCamperKey(r.id), r]));
  for (const cid of camperKeys) {
    const row = byKey.get(normCamperKey(cid));
    if (!row || String(row.parent_id) !== String(user.id)) {
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: 'Invalid camper in bookings' }));
    }
  }

  try {
    const { poolW, poolD, weekMetaMap, ledgerWeekCents, ledgerDayCents } = await loadFloatingPrepaidPool(
      sb,
      user.id,
      bookingsArray,
      normCamperKey,
      prepaidCoverageKeys
    );
    const sorted = sortBookingsForCreditApply(bookingsArray, weekMetaMap);
    const applied = applyPoolToBookings(sorted, poolW, poolD, wr, dr, ledgerWeekCents, ledgerDayCents);
    const encPoolCents = Math.max(0, (Number(poolW) || 0) * wrC + (Number(poolD) || 0) * drC);
    const ledSum = Math.max(0, Math.round(Number(ledgerWeekCents) || 0) + Math.round(Number(ledgerDayCents) || 0));
    const prepaidGrossCents = encPoolCents + ledSum;

    const lines = sorted.map((b, i) => {
      const mode = b.pricingMode === 'full_week' ? 'full_week' : 'daily';
      const needCents = mode === 'full_week' ? wrC : (b.dayIds || []).length * drC;
      const chargeCents =
        applied.campLineCents[i] != null && Number.isFinite(Number(applied.campLineCents[i]))
          ? Math.round(Number(applied.campLineCents[i]))
          : needCents;
      return {
        weekId: b.weekId,
        camperId: b.camperId,
        pricingMode: b.pricingMode,
        dayIds: b.dayIds || [],
        needCents,
        chargeCents,
        applyCents: Math.max(0, needCents - chargeCents),
      };
    });

    res.statusCode = 200;
    return res.end(
      JSON.stringify({
        prepaidGrossCents,
        ledgerWeekCents: Math.max(0, Math.round(Number(ledgerWeekCents) || 0)),
        ledgerDayCents: Math.max(0, Math.round(Number(ledgerDayCents) || 0)),
        ledgerCents: ledSum,
        encPoolCents,
        remainingPrepaidCents: Math.max(0, Math.round(Number(applied.remainingPrepaidCents) || 0)),
        remainingWeekCents: Math.max(0, Math.round(Number(applied.remainingWeekCents) || 0)),
        remainingDayCents: Math.max(0, Math.round(Number(applied.remainingDayCents) || 0)),
        remainingWeeks: applied.remainingWeeks | 0,
        remainingDays: applied.remainingDays | 0,
        ledgerWeekConsumedCents: Math.max(0, Math.round(Number(applied.ledgerWeekConsumedCents) || 0)),
        ledgerDayConsumedCents: Math.max(0, Math.round(Number(applied.ledgerDayConsumedCents) || 0)),
        lines,
      })
    );
  } catch (e) {
    console.error('[preview-prepaid-apply]', e);
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: e.message || 'Prepaid preview failed' }));
  }
};
