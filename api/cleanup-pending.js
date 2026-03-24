/**
 * Deletes stale pending enrollments (abandoned Stripe checkout).
 * Schedule via Vercel Cron. Set CRON_SECRET in project env; Vercel sends
 * Authorization: Bearer <CRON_SECRET> when CRON_SECRET is configured.
 */
const { serviceClient } = require('./lib/supabase');

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: 'Method not allowed' }));
  }

  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || '';
  if (!secret || auth !== `Bearer ${secret}`) {
    res.statusCode = 401;
    return res.end(JSON.stringify({ error: 'Unauthorized' }));
  }

  const hours = Math.max(1, parseInt(process.env.PENDING_CLEANUP_HOURS || '36', 10));
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  try {
    const sb = serviceClient();
    const { data: pending, error: fe } = await sb
      .from('enrollments')
      .select('id')
      .eq('status', 'pending')
      .is('stripe_session_id', null)
      .lt('created_at', cutoff);

    if (fe) throw fe;
    const ids = (pending || []).map((r) => r.id);
    if (!ids.length) {
      res.statusCode = 200;
      return res.end(JSON.stringify({ deleted: 0, cutoff, hours }));
    }

    const { error: de } = await sb.from('enrollments').delete().in('id', ids);
    if (de) throw de;

    res.statusCode = 200;
    return res.end(JSON.stringify({ deleted: ids.length, cutoff, hours }));
  } catch (e) {
    console.error(e);
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: e.message }));
  }
};
