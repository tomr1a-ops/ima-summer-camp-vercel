/**
 * Admin-only JSON via service role: week capacity, enrollment list, parent names, overview stats.
 * Needed when the signed-in user is allowlisted in the UI but profiles.role is still "parent"
 * (RLS would otherwise hide other families' enrollments in the browser).
 */
const { serviceClient } = require('./lib/supabase');
const { requireAdmin } = require('./lib/auth');
const { isMissingStepUpHoldExpiresColumn } = require('./lib/step-up-hold-column');

const ENR_SELECT_WITH_HOLD =
  'id,parent_id,camper_id,week_id,status,price_paid,registration_fee_paid,day_ids,guest_email,created_at,step_up_hold_expires_at, campers(first_name,last_name), weeks(label,week_number)';
const ENR_SELECT_BASE =
  'id,parent_id,camper_id,week_id,status,price_paid,registration_fee_paid,day_ids,guest_email,created_at, campers(first_name,last_name), weeks(label,week_number)';

function json(res, code, body) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.end(JSON.stringify(body));
}

function buildWeekCapacity(dayRows, enrRows) {
  const daysPeak = {};
  for (const d of dayRows || []) {
    const wid = d.week_id != null ? String(d.week_id) : '';
    if (!wid) continue;
    const n = Number(d.current_enrollment) || 0;
    daysPeak[wid] = Math.max(daysPeak[wid] || 0, n);
  }

  const perWeekDay = {};
  const distinctByWeek = {};
  for (const row of enrRows || []) {
    if (row.status === 'cancelled') continue;
    const wid = row.week_id != null ? String(row.week_id) : '';
    if (!wid) continue;
    if (row.camper_id) {
      if (!distinctByWeek[wid]) distinctByWeek[wid] = new Set();
      distinctByWeek[wid].add(String(row.camper_id));
    }
    const ids = row.day_ids || [];
    if (!ids.length) continue;
    if (!perWeekDay[wid]) perWeekDay[wid] = {};
    for (const did of ids) {
      const dk = String(did);
      perWeekDay[wid][dk] = (perWeekDay[wid][dk] || 0) + 1;
    }
  }

  const enrollmentDayPeak = {};
  Object.keys(perWeekDay).forEach((wid) => {
    const m = perWeekDay[wid];
    let mx = 0;
    Object.keys(m).forEach((dk) => {
      mx = Math.max(mx, m[dk] || 0);
    });
    enrollmentDayPeak[wid] = mx;
  });

  const distinctCampers = {};
  Object.keys(distinctByWeek).forEach((wid) => {
    distinctCampers[wid] = distinctByWeek[wid].size;
  });

  const weekIds = new Set([
    ...Object.keys(daysPeak),
    ...Object.keys(enrollmentDayPeak),
    ...Object.keys(distinctCampers),
  ]);

  const weekCapacity = {};
  weekIds.forEach((wid) => {
    const dp = daysPeak[wid] || 0;
    const ep = enrollmentDayPeak[wid] || 0;
    const dc = distinctCampers[wid] || 0;
    weekCapacity[wid] = Math.max(dp, ep, dc);
  });

  return weekCapacity;
}

function buildOverview(enrRows) {
  const confirmedCampers = new Set();
  let revenue = 0;
  let activeRows = 0;
  let cancelledRows = 0;
  for (const row of enrRows || []) {
    const st = row.status;
    if (st === 'confirmed') {
      activeRows++;
      if (row.camper_id) confirmedCampers.add(String(row.camper_id));
      revenue += Number(row.price_paid) || 0;
    } else if (st === 'pending' || st === 'pending_step_up') {
      activeRows++;
    } else if (st === 'cancelled') {
      cancelledRows++;
    }
  }
  return {
    enrolledCampersConfirmed: confirmedCampers.size,
    revenueConfirmed: revenue,
    activeEnrollmentRows: activeRows,
    cancelledRows,
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });

  try {
    await requireAdmin(req);
  } catch (e) {
    const code = e.statusCode || 500;
    return json(res, code, { error: e.message || 'Unauthorized' });
  }

  try {
    const sb = serviceClient();
    const { data: dayRows, error: de } = await sb.from('days').select('week_id, current_enrollment');
    if (de) throw de;

    let { data: enrRows, error: ee } = await sb
      .from('enrollments')
      .select(ENR_SELECT_WITH_HOLD)
      .order('created_at', { ascending: false });
    const retryNoHold =
      (ee && isMissingStepUpHoldExpiresColumn(ee)) || (ee && String(ee.code || '') === 'PGRST205');
    if (ee && retryNoHold) {
      console.warn('[admin-camp-snapshot] retrying enrollments select without step_up_hold_expires_at', ee.code, ee.message);
      const second = await sb.from('enrollments').select(ENR_SELECT_BASE).order('created_at', { ascending: false });
      enrRows = second.data;
      ee = second.error;
    }
    if (ee) throw ee;

    const weekCapacity = buildWeekCapacity(dayRows, enrRows || []);
    const overview = buildOverview(enrRows || []);

    const parentIds = [...new Set((enrRows || []).map((r) => r.parent_id).filter(Boolean))];
    let parentsById = {};
    if (parentIds.length) {
      const { data: profs, error: pe } = await sb
        .from('profiles')
        .select('id,full_name,email')
        .in('id', parentIds);
      if (pe) throw pe;
      (profs || []).forEach((p) => {
        parentsById[String(p.id)] = p;
      });
    }

    return json(res, 200, {
      weekCapacity,
      overview,
      enrollments: enrRows || [],
      parentsById,
    });
  } catch (e) {
    console.error('[admin-camp-snapshot]', e && e.message ? e.message : e);
    return json(res, 500, { error: e.message || 'Server error' });
  }
};
