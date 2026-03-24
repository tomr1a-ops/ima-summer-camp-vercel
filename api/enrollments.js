const { serviceClient } = require('./lib/supabase');
const { requireParent } = require('./lib/auth');
const { validateBooking, validateAddedDaysOnly, syncConfirmedDayCounts } = require('./lib/capacity');

async function readJsonBody(req) {
  if (req.body !== undefined && req.body !== null) {
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
  return JSON.parse(raw);
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(204).end();
  }

  try {
    const sb = serviceClient();
    const { user } = await requireParent(req);

    if (req.method === 'GET') {
      const { data, error } = await sb
        .from('enrollments')
        .select('*')
        .eq('parent_id', user.id)
        .order('created_at', { ascending: false });
      if (error) throw error;
      res.statusCode = 200;
      return res.end(JSON.stringify({ enrollments: data || [] }));
    }

    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      const { week_id, day_ids, camper_id } = body;
      if (!week_id || !camper_id || !Array.isArray(day_ids) || !day_ids.length) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: 'week_id, camper_id, day_ids required' }));
      }
      const { data: camper, error: ce } = await sb.from('campers').select('parent_id').eq('id', camper_id).single();
      if (ce || !camper || camper.parent_id !== user.id) {
        res.statusCode = 403;
        return res.end(JSON.stringify({ error: 'Invalid camper' }));
      }
      try {
        await validateBooking(sb, {
          weekId: week_id,
          dayIds: day_ids,
          camperId: camper_id,
          excludeEnrollmentId: null,
        });
      } catch (e) {
        res.statusCode = e.statusCode || 400;
        return res.end(JSON.stringify({ error: e.message }));
      }
      const { data, error } = await sb
        .from('enrollments')
        .insert({
          parent_id: user.id,
          camper_id,
          week_id,
          day_ids,
          status: 'pending',
          price_paid: 0,
          registration_fee_paid: false,
        })
        .select('id')
        .single();
      if (error) throw error;
      res.statusCode = 201;
      return res.end(JSON.stringify({ enrollment: data }));
    }

    if (req.method === 'PUT') {
      const body = await readJsonBody(req);
      const { id, day_ids, week_id } = body;
      if (!id) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: 'id required' }));
      }
      const { data: row, error: fe } = await sb
        .from('enrollments')
        .select('id,parent_id,status,week_id,day_ids,camper_id')
        .eq('id', id)
        .single();
      if (fe || !row || row.parent_id !== user.id) {
        res.statusCode = 403;
        return res.end(JSON.stringify({ error: 'Not found' }));
      }
      if (row.status === 'cancelled') {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: 'Cannot edit cancelled enrollment' }));
      }

      const newWeekId = week_id !== undefined && week_id !== null && week_id !== '' ? week_id : row.week_id;
      const newDayIds = Array.isArray(day_ids) ? day_ids : row.day_ids;
      if (!Array.isArray(newDayIds) || !newDayIds.length) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: 'day_ids must be a non-empty array' }));
      }

      const oldWeekId = row.week_id;
      const oldDayIds = row.day_ids || [];
      const weekChanged = String(newWeekId) !== String(oldWeekId);
      const oldSet = new Set(oldDayIds);
      const newSet = new Set(newDayIds);
      const addedDays = [...newSet].filter((d) => !oldSet.has(d));

      try {
        if (row.status === 'pending') {
          await validateBooking(sb, {
            weekId: newWeekId,
            dayIds: newDayIds,
            camperId: row.camper_id,
            excludeEnrollmentId: row.id,
          });
        } else if (row.status === 'confirmed') {
          if (weekChanged) {
            await validateBooking(sb, {
              weekId: newWeekId,
              dayIds: newDayIds,
              camperId: row.camper_id,
              excludeEnrollmentId: row.id,
            });
          } else {
            await validateAddedDaysOnly(sb, newWeekId, addedDays);
          }
        }
      } catch (e) {
        res.statusCode = e.statusCode || 400;
        return res.end(JSON.stringify({ error: e.message }));
      }

      const patch = { week_id: newWeekId, day_ids: newDayIds };
      const { error: ue } = await sb.from('enrollments').update(patch).eq('id', id);
      if (ue) throw ue;

      if (row.status === 'confirmed') {
        await syncConfirmedDayCounts(sb, oldDayIds, newDayIds);
      }

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
