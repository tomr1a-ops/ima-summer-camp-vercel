/**
 * GET /api/waitlist — parent’s active waitlist rows + queue ranks.
 * POST /api/waitlist — join waitlist { camperId, weekId } (week must be sold out).
 */
const { serviceClient } = require('./lib/supabase');
const { getUserFromRequest } = require('./lib/auth');
const { setNoStoreJsonHeaders } = require('./lib/http-no-store');
const {
  waitlistEntriesForParent,
  joinWaitlistRpc,
  weekPeakVsMax,
} = require('./lib/waitlist-service');

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  setNoStoreJsonHeaders(res);
  res.end(JSON.stringify(obj));
}

async function readJsonBody(req) {
  if (req.body !== undefined && req.body != null) {
    if (Buffer.isBuffer(req.body)) {
      try {
        return JSON.parse(req.body.toString('utf8') || '{}');
      } catch {
        return {};
      }
    }
    if (typeof req.body === 'string') {
      try {
        return JSON.parse(req.body || '{}');
      } catch {
        return {};
      }
    }
    if (typeof req.body === 'object') return req.body;
  }
  const chunks = [];
  try {
    for await (const chunk of req) chunks.push(chunk);
  } catch {
    return {};
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  setNoStoreJsonHeaders(res);
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(204).end();
  }

  try {
    const { user } = await getUserFromRequest(req);
    if (!user) {
      return json(res, 401, { error: 'Unauthorized' });
    }
    const sb = serviceClient();

    if (req.method === 'GET') {
      const entries = await waitlistEntriesForParent(sb, user.id);
      return json(res, 200, { entries });
    }

    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      const camperId = body.camperId != null ? String(body.camperId).trim() : '';
      const weekId = body.weekId != null ? String(body.weekId).trim() : '';
      if (!camperId || !weekId) {
        return json(res, 400, { error: 'camperId and weekId required' });
      }

      const { data: camper, error: ce } = await sb.from('campers').select('id, parent_id').eq('id', camperId).maybeSingle();
      if (ce) throw ce;
      if (!camper || String(camper.parent_id) !== String(user.id)) {
        return json(res, 403, { error: 'Invalid camper' });
      }

      const { data: week, error: we } = await sb
        .from('weeks')
        .select('id, is_active, is_no_camp, max_capacity, label')
        .eq('id', weekId)
        .maybeSingle();
      if (we) throw we;
      if (!week || !week.is_active) {
        return json(res, 400, { error: 'Week is not open for registration.' });
      }
      if (week.is_no_camp === true) {
        return json(res, 400, { error: 'No camp this week.' });
      }

      const { peak, max } = await weekPeakVsMax(sb, weekId);
      if (peak < max) {
        return json(res, 400, {
          error: 'This week still has open spots — register normally instead of joining the waitlist.',
        });
      }

      try {
        const { id, position } = await joinWaitlistRpc(sb, {
          camperId,
          weekId,
          parentId: user.id,
        });
        if (!id) {
          return json(res, 500, { error: 'Could not join waitlist. Try again.' });
        }
        const entries = await waitlistEntriesForParent(sb, user.id);
        return json(res, 201, { ok: true, id, position, entries });
      } catch (e) {
        const msg = e && e.message ? String(e.message) : '';
        if (msg.includes('already_enrolled') || msg.includes('already on waitlist')) {
          return json(res, 400, { error: 'This child is already registered or on the waitlist for this week.' });
        }
        console.error('[waitlist POST]', msg, e);
        return json(res, 500, { error: msg || 'Could not join waitlist' });
      }
    }

    return json(res, 405, { error: 'Method not allowed' });
  } catch (e) {
    console.error('[waitlist]', e && e.message ? e.message : e);
    return json(res, 500, { error: e.message || 'Server error' });
  }
};
