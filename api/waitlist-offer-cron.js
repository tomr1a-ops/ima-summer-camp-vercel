/**
 * Hourly: expire waitlist offers past 24h, chain to next family, send emails.
 * Authorization: Bearer CRON_SECRET (same as backup-cron).
 */
const { expireStaleOffersAndChain, notifyWaitlistOffer } = require('./lib/waitlist-service');
const { serviceClient } = require('./lib/supabase');

function json(res, code, body) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function bearer(req) {
  const h = req.headers.authorization || req.headers.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : '';
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  const secret = process.env.CRON_SECRET;
  if (!secret || bearer(req) !== secret) {
    return json(res, 403, { error: 'Forbidden' });
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    return json(res, 405, { error: 'Method not allowed' });
  }

  try {
    const sb = serviceClient();
    const { expired, newOffers } = await expireStaleOffersAndChain(sb);
    for (const nid of newOffers || []) {
      try {
        await notifyWaitlistOffer(sb, nid);
      } catch (em) {
        console.error('[waitlist-offer-cron] email', nid, em && em.message);
      }
    }
    return json(res, 200, { ok: true, expired, newOfferCount: (newOffers || []).length });
  } catch (e) {
    console.error('[waitlist-offer-cron]', e && e.message ? e.message : e);
    return json(res, 500, { error: e.message || 'Server error' });
  }
};
