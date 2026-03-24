const { serviceClient } = require('./lib/supabase');
const { requireAdmin } = require('./lib/auth');

async function readJsonBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') {
      try {
        return JSON.parse(req.body || '{}');
      } catch {
        return {};
      }
    }
    if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  }
  const chunks = [];
  try {
    for await (const chunk of req) chunks.push(chunk);
  } catch {
    return {};
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  return JSON.parse(raw);
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(204).end();
  }

  try {
    await requireAdmin(req);
    const sb = serviceClient();
    const url = new URL(req.url || '', 'http://local');
    const dayId = url.searchParams.get('day_id');

    if (req.method === 'GET') {
      if (!dayId) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: 'day_id query required' }));
      }
      const { data, error } = await sb
        .from('attendance')
        .select('*, campers(first_name,last_name)')
        .eq('day_id', dayId);
      if (error) throw error;
      res.statusCode = 200;
      return res.end(JSON.stringify({ attendance: data || [] }));
    }

    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      const { enrollment_id, camper_id, day_id, present, notes } = body;
      if (!enrollment_id || !camper_id || !day_id) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: 'enrollment_id, camper_id, day_id required' }));
      }
      const { error } = await sb.from('attendance').upsert(
        {
          enrollment_id,
          camper_id,
          day_id,
          present: !!present,
          notes: notes || null,
          marked_at: new Date().toISOString(),
        },
        { onConflict: 'camper_id,day_id' }
      );
      if (error) throw error;
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true }));
    }

    res.statusCode = 405;
    return res.end(JSON.stringify({ error: 'Method not allowed' }));
  } catch (e) {
    const code = e.statusCode || 500;
    res.statusCode = code;
    return res.end(JSON.stringify({ error: e.message }));
  }
};
