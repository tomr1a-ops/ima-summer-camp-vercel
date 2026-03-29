const { clientForWeeksApi, resolveSupabaseUrl } = require('./lib/supabase');
const { setNoStoreJsonHeaders } = require('./lib/http-no-store');

/**
 * GET /api/weeks
 * Returns active camp weeks with nested Mon–Fri days for the checkout UI.
 *
 * Flow:
 * 1. Build a Supabase client via clientForWeeksApi() (anon key preferred; service key
 *    fallback if anon env vars are missing — same DB, bypasses RLS).
 * 2. Query public.weeks where is_active = true, ordered by week_number.
 * 3. Query public.days (all rows), ordered by date, bucketed by week_id in memory.
 * 4. Shape each week with days[], slots_left, at_capacity, disabled.
 *
 * Errors surface as JSON { error, requestId, ... } with HTTP 500; Vercel logs include
 * the same requestId for correlation.
 */
function newRequestId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function pickLoggableUrlHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return '(invalid url)';
  }
}

function serializeSupabaseError(e) {
  if (e == null) return { message: 'unknown' };
  if (typeof e !== 'object') return { message: String(e) };
  const out = {
    message: e.message,
    code: e.code,
    details: e.details,
    hint: e.hint,
  };
  if (e.status) out.status = e.status;
  return out;
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  setNoStoreJsonHeaders(res);
  const requestId = newRequestId();
  const exposeDetails = process.env.EXPOSE_WEEKS_ERROR_DETAILS === '1';

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(204).end();
  }
  if (req.method !== 'GET') {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: 'Method not allowed', requestId }));
  }

  try {
    let sb;
    let mode;
    let urlSource;
    let keySource;
    try {
      const resolved = clientForWeeksApi();
      sb = resolved.client;
      mode = resolved.mode;
      urlSource = resolved.urlSource;
      keySource = resolved.keySource;
    } catch (cfgErr) {
      console.error('[api/weeks]', requestId, 'CONFIG_ERROR', {
        message: cfgErr.message,
        code: cfgErr.code,
        stack: cfgErr.stack,
      });
      res.statusCode = 500;
      return res.end(
        JSON.stringify({
          error: cfgErr.message || 'Supabase configuration error',
          code: cfgErr.code || 'CONFIG',
          requestId,
          ...(exposeDetails && { debug: serializeSupabaseError(cfgErr) }),
        })
      );
    }

    const { url: resolvedUrl } = resolveSupabaseUrl();
    console.log('[api/weeks]', requestId, 'start', {
      mode,
      urlSource,
      keySource,
      supabaseHost: pickLoggableUrlHost(resolvedUrl),
    });

    if (mode === 'service_role_fallback') {
      console.warn(
        '[api/weeks]',
        requestId,
        'Using SERVICE ROLE for reads (anon env vars missing). Set NEXT_PUBLIC_SUPABASE_ANON_KEY + NEXT_PUBLIC_SUPABASE_URL for anon + RLS.'
      );
    }

    const { data: weeks, error: we } = await sb
      .from('weeks')
      .select('id,week_number,label,start_date,end_date,max_capacity,is_active,is_full')
      .eq('is_active', true)
      .order('week_number');

    if (we) {
      console.error('[api/weeks]', requestId, 'weeks_query_failed', serializeSupabaseError(we));
      const err = new Error(we.message || 'weeks query failed');
      err._supabase = we;
      throw err;
    }

    const { data: days, error: de } = await sb
      .from('days')
      .select('id,week_id,date,day_name,current_enrollment')
      .order('date');

    if (de) {
      console.error('[api/weeks]', requestId, 'days_query_failed', serializeSupabaseError(de));
      const err = new Error(de.message || 'days query failed');
      err._supabase = de;
      throw err;
    }

    const byWeek = {};
    (days || []).forEach((d) => {
      if (!byWeek[d.week_id]) byWeek[d.week_id] = [];
      byWeek[d.week_id].push(d);
    });

    /**
     * Week sold-out / portal blocking uses **days.current_enrollment** only (same as admin capacity bar).
     * Peak count across Mon–Fri for the week vs max_capacity; checkout still validates via capacity helpers.
     */
    const capDefault = 35;
    const payload = (weeks || []).map((w) => {
      const max = w.max_capacity || capDefault;
      const wdays = (byWeek[w.id] || []).map((d) => ({
        id: d.id,
        date: d.date,
        day_name: d.day_name,
        current_enrollment: d.current_enrollment,
        slots_left: Math.max(0, max - (d.current_enrollment || 0)),
        at_capacity: (d.current_enrollment || 0) >= max,
      }));
      let peakEnrolled = 0;
      wdays.forEach((d) => {
        peakEnrolled = Math.max(peakEnrolled, Number(d.current_enrollment) || 0);
      });
      const weekSoldOut = peakEnrolled >= max;
      const mergedFull = !!(w.is_full || weekSoldOut);
      return {
        ...w,
        is_full: mergedFull,
        week_peak_enrollment: peakEnrolled,
        distinct_camper_count: peakEnrolled,
        days: wdays,
        disabled: mergedFull || !w.is_active,
      };
    });

    console.log('[api/weeks]', requestId, 'ok', { weekCount: payload.length, dayRows: (days || []).length });

    res.statusCode = 200;
    return res.end(JSON.stringify({ weeks: payload }));
  } catch (e) {
    const sup = e && e._supabase;
    console.error('[api/weeks]', requestId, 'FATAL', {
      message: e.message,
      stack: e.stack,
      supabase: sup ? serializeSupabaseError(sup) : undefined,
    });
    res.statusCode = 500;
    const body = {
      error: e.message || 'Could not load weeks',
      requestId,
    };
    if (exposeDetails) {
      body.debug = sup ? serializeSupabaseError(sup) : { message: e.message, stack: e.stack };
    }
    return res.end(JSON.stringify(body));
  }
};
