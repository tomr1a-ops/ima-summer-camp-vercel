const { serviceClient } = require('./lib/supabase');
const { getUserFromRequest } = require('./lib/auth');
const { setNoStoreJsonHeaders } = require('./lib/http-no-store');
const {
  validateBooking,
  validateAddedDaysOnly,
  syncConfirmedDayCounts,
  loadOrderedDaysForWeek,
} = require('./lib/capacity');
const { campCreditCentsForConfirmedRow, addFamilyCampLedgerCents } = require('./lib/family-camp-ledger');

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

async function requireAuthUser(req) {
  const { user } = await getUserFromRequest(req);
  if (!user) {
    const err = new Error('Unauthorized');
    err.statusCode = 401;
    throw err;
  }
  return user;
}

/** Infer full_week vs daily for validateBooking from day set vs week's Mon–Fri. */
async function inferPricingModeForWeek(sb, weekId, dayIds) {
  const ids = Array.isArray(dayIds) ? dayIds : [];
  const allDays = await loadOrderedDaysForWeek(sb, weekId);
  if (allDays.length !== 5 || ids.length !== 5) return 'daily';
  const expectedIds = allDays.map((d) => d.id).sort().join(',');
  const gotIds = [...ids].sort().join(',');
  return expectedIds === gotIds ? 'full_week' : 'daily';
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  setNoStoreJsonHeaders(res);
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(204).end();
  }

  try {
    const sb = serviceClient();

    if (req.method === 'GET') {
      const { user } = await getUserFromRequest(req);
      if (!user) {
        const err = new Error('Unauthorized');
        err.statusCode = 401;
        throw err;
      }
      const { data, error } = await sb
        .from('enrollments')
        .select('*')
        .eq('parent_id', user.id)
        .order('created_at', { ascending: false });
      if (error) throw error;
      res.statusCode = 200;
      return res.end(JSON.stringify({ enrollments: data || [] }));
    }

    const user = await requireAuthUser(req);

    /**
     * POST — create a pending enrollment (optional / admin flows).
     * Paid “add week” or “add days” from the camp site uses POST /api/create-checkout-session
     * (Stripe creates pending rows in the same batch as payment).
     */
    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      const { week_id, day_ids, camper_id } = body;
      if (!week_id || !camper_id || !Array.isArray(day_ids) || !day_ids.length) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: 'week_id, camper_id, day_ids required' }));
      }
      const { data: camper, error: ce } = await sb.from('campers').select('parent_id').eq('id', camper_id).single();
      if (ce || !camper || String(camper.parent_id) !== String(user.id)) {
        res.statusCode = 403;
        return res.end(JSON.stringify({ error: 'Invalid camper' }));
      }
      const pricingMode = await inferPricingModeForWeek(sb, week_id, day_ids);
      try {
        await validateBooking(sb, {
          weekId: week_id,
          dayIds: day_ids,
          camperId: camper_id,
          excludeEnrollmentId: null,
          pricingMode,
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
      if (fe || !row || String(row.parent_id) !== String(user.id)) {
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

      const pricingMode = await inferPricingModeForWeek(sb, newWeekId, newDayIds);

      try {
        if (row.status === 'pending') {
          await validateBooking(sb, {
            weekId: newWeekId,
            dayIds: newDayIds,
            camperId: row.camper_id,
            excludeEnrollmentId: row.id,
            pricingMode,
          });
        } else if (row.status === 'confirmed') {
          if (weekChanged) {
            await validateBooking(sb, {
              weekId: newWeekId,
              dayIds: newDayIds,
              camperId: row.camper_id,
              excludeEnrollmentId: row.id,
              pricingMode,
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

    if (req.method === 'DELETE') {
      let enrollmentId = null;
      try {
        const u = new URL(req.url || '/', 'http://x');
        enrollmentId = u.searchParams.get('id');
      } catch (eU) {}
      if (!enrollmentId) {
        const body = await readJsonBody(req);
        enrollmentId = body && body.id;
      }
      if (!enrollmentId) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: 'id required (query ?id= or JSON body)' }));
      }
      const { data: row, error: fe } = await sb
        .from('enrollments')
        .select('id,parent_id,status,day_ids,week_id')
        .eq('id', enrollmentId)
        .single();
      if (fe || !row || String(row.parent_id) !== String(user.id)) {
        res.statusCode = 403;
        return res.end(JSON.stringify({ error: 'Not found' }));
      }
      if (row.status === 'cancelled') {
        res.statusCode = 200;
        return res.end(JSON.stringify({ ok: true, already: true }));
      }
      if (row.status === 'confirmed') {
        await syncConfirmedDayCounts(sb, row.day_ids || [], []);
        try {
          const cents = await campCreditCentsForConfirmedRow(sb, row, false);
          if (cents > 0) await addFamilyCampLedgerCents(sb, user.id, cents);
        } catch (credErr) {
          console.error('[enrollments DELETE] family_camp_credit_ledger', credErr && credErr.message);
        }
      }
      const { error: ue } = await sb.from('enrollments').update({ status: 'cancelled' }).eq('id', enrollmentId);
      if (ue) throw ue;
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
