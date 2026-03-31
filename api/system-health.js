/**
 * System health: SQL checks (IMAOS-style tables), optional Claude Haiku for failures,
 * logging, schedule + cache in app_settings, cron tick via x-system-health-cron-secret.
 */
const { serviceClient } = require('./lib/supabase');
const { requireAdmin } = require('./lib/auth');
const { sendResend } = require('./lib/email');

const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
const MAX_CLAUDE_PER_FULL = 10;

const DEFAULT_SCHEDULE = {
  quickEnabled: false,
  quickFrequency: 'manual',
  fullEnabled: false,
  fullFrequency: 'manual',
  emailOnFailure: false,
  alertEmail: '',
};

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
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function json(res, code, body) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.end(JSON.stringify(body));
}

function studioIdFromEnv() {
  return String(process.env.NEXT_PUBLIC_STUDIO_ID || process.env.STUDIO_ID || '').trim();
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function isoSevenDaysAgo() {
  return new Date(Date.now() - 7 * 86400000).toISOString();
}

async function getAppSettingJson(sb, key) {
  const { data, error } = await sb.from('app_settings').select('value').eq('key', key).maybeSingle();
  if (error) throw error;
  return data && data.value != null ? data.value : null;
}

async function setAppSettingJson(sb, key, value) {
  const row = {
    key,
    value,
    updated_at: new Date().toISOString(),
  };
  const { error } = await sb.from('app_settings').upsert(row, { onConflict: 'key' });
  if (error) throw error;
}

async function verifyCronRequest(sb, req) {
  const header = String(req.headers['x-system-health-cron-secret'] || '').trim();
  if (!header) return false;
  const env = String(process.env.SYSTEM_HEALTH_CRON_SECRET || '').trim();
  if (env && header === env) return true;
  try {
    const v = await getAppSettingJson(sb, 'system_health_cron_secret');
    const s = v && typeof v === 'object' && v.secret != null ? String(v.secret).trim() : '';
    return s && header === s;
  } catch {
    return false;
  }
}

function mergeSchedule(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  return {
    quickEnabled: Boolean(o.quickEnabled),
    quickFrequency: String(o.quickFrequency || DEFAULT_SCHEDULE.quickFrequency),
    fullEnabled: Boolean(o.fullEnabled),
    fullFrequency: String(o.fullFrequency || DEFAULT_SCHEDULE.fullFrequency),
    emailOnFailure: Boolean(o.emailOnFailure),
    alertEmail: String(o.alertEmail || '').trim(),
  };
}

function intervalMsQuick(freq) {
  switch (freq) {
    case 'hourly':
      return 3600000;
    case '6h':
      return 21600000;
    case '12h':
      return 43200000;
    case 'daily':
      return 86400000;
    default:
      return Infinity;
  }
}

function intervalMsFull(freq) {
  switch (freq) {
    case 'daily':
      return 86400000;
    case 'weekly':
      return 604800000;
    default:
      return Infinity;
  }
}

function shouldRunAutomatedQuick(schedule, cache) {
  if (!schedule.quickEnabled || schedule.quickFrequency === 'manual') return false;
  const last = cache && cache.quick && cache.quick.at ? cache.quick.at : null;
  if (!last) return true;
  const elapsed = Date.now() - new Date(last).getTime();
  return elapsed >= intervalMsQuick(schedule.quickFrequency);
}

function shouldRunAutomatedFull(schedule, cache) {
  if (!schedule.fullEnabled || schedule.fullFrequency === 'manual') return false;
  const last = cache && cache.full && cache.full.at ? cache.full.at : null;
  if (!last) return true;
  const elapsed = Date.now() - new Date(last).getTime();
  return elapsed >= intervalMsFull(schedule.fullFrequency);
}

async function countQuery(sb, run) {
  try {
    const { count, error } = await run();
    if (error) {
      return { count: null, ok: false, error: error.message || String(error) };
    }
    const n = count == null ? 0 : Number(count);
    return { count: n, ok: n > 0, error: null };
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e);
    return { count: null, ok: false, error: msg };
  }
}

async function runQuickSqlChecks(sb, studioId) {
  const today = todayIsoDate();
  const since = isoSevenDaysAgo();

  const checks = [];

  const c1 = await countQuery(sb, () =>
    sb
      .from('classes')
      .select('*', { count: 'exact', head: true })
      .eq('studio_id', studioId)
      .gte('date', today)
  );
  checks.push({
    name: 'Classes (upcoming)',
    table: 'classes',
    ...c1,
  });

  const c2 = await countQuery(sb, () =>
    sb.from('studio_config').select('*', { count: 'exact', head: true }).eq('id', studioId)
  );
  checks.push({
    name: 'Studio config',
    table: 'studio_config',
    ...c2,
  });

  const c3 = await countQuery(sb, () =>
    sb.from('class_reservations').select('*', { count: 'exact', head: true }).gte('created_at', since)
  );
  checks.push({
    name: 'Reservations (7 days)',
    table: 'class_reservations',
    ...c3,
  });

  const c4 = await countQuery(sb, () =>
    sb.from('members').select('*', { count: 'exact', head: true }).is('deleted_at', null)
  );
  checks.push({
    name: 'Members (active)',
    table: 'members',
    ...c4,
  });

  const c5 = await countQuery(sb, () => sb.from('prospects').select('*', { count: 'exact', head: true }));
  checks.push({
    name: 'Prospects',
    table: 'prospects',
    ...c5,
  });

  const c6 = await countQuery(sb, () =>
    sb.from('app_settings').select('*', { count: 'exact', head: true }).eq('key', 'imaos_config')
  );
  checks.push({
    name: 'App settings (imaos_config)',
    table: 'app_settings',
    ...c6,
  });

  return checks;
}

async function runFlowSimulations(sb, studioId, quickResults) {
  const flows = [];
  const today = todayIsoDate();

  let schedOk = true;
  let schedErr = null;
  try {
    const v = await getAppSettingJson(sb, 'system_health_schedule');
    if (v != null && typeof v !== 'object') schedOk = false;
  } catch (e) {
    schedOk = false;
    schedErr = e && e.message ? String(e.message) : String(e);
  }
  flows.push({
    name: 'Flow: schedule settings readable',
    table: 'app_settings',
    count: schedOk ? 1 : 0,
    ok: schedOk,
    error: schedErr,
  });

  let cacheOk = true;
  let cacheErr = null;
  try {
    await getAppSettingJson(sb, 'system_health_last_run');
  } catch (e) {
    cacheOk = false;
    cacheErr = e && e.message ? String(e.message) : String(e);
  }
  flows.push({
    name: 'Flow: last run cache readable',
    table: 'app_settings',
    count: cacheOk ? 1 : 0,
    ok: cacheOk,
    error: cacheErr,
  });

  const classesOk = quickResults.find((x) => x.name === 'Classes (upcoming)');
  if (classesOk && classesOk.ok) {
    const { data, error } = await sb
      .from('classes')
      .select('id')
      .eq('studio_id', studioId)
      .gte('date', today)
      .limit(1);
    const ok = !error && data && data.length > 0;
    flows.push({
      name: 'Flow: sample upcoming class row',
      table: 'classes',
      count: ok ? 1 : 0,
      ok,
      error: error ? error.message : null,
    });
  } else {
    flows.push({
      name: 'Flow: sample upcoming class row',
      table: 'classes',
      count: null,
      ok: true,
      error: null,
      skipped: true,
    });
  }

  const memOk = quickResults.find((x) => x.name === 'Members (active)');
  if (memOk && memOk.ok) {
    const { data, error } = await sb.from('members').select('id').is('deleted_at', null).limit(1);
    const ok = !error && data && data.length > 0;
    flows.push({
      name: 'Flow: sample member row',
      table: 'members',
      count: ok ? 1 : 0,
      ok,
      error: error ? error.message : null,
    });
  } else {
    flows.push({
      name: 'Flow: sample member row',
      table: 'members',
      count: null,
      ok: true,
      error: null,
      skipped: true,
    });
  }

  return flows;
}

async function claudeDiagnose(checkName, resultText) {
  const key = String(process.env.ANTHROPIC_API_KEY || '').trim();
  if (!key) return null;
  const prompt = `This health check failed in a martial arts studio management app. Check: ${checkName}. Result: ${resultText}. In one sentence, what is likely wrong and where should the developer look?`;
  const ac = new AbortController();
  const tid = setTimeout(() => ac.abort(), 25000);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ac.signal,
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 256,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      console.warn('[system-health] Claude HTTP', res.status, text.slice(0, 200));
      return null;
    }
    const body = JSON.parse(text);
    const block = body.content && body.content[0];
    if (block && block.text) return String(block.text).trim();
    return null;
  } catch (e) {
    console.warn('[system-health] Claude', e && e.message ? e.message : e);
    return null;
  } finally {
    clearTimeout(tid);
  }
}

async function logFailure(sb, row) {
  const { error } = await sb.from('system_health_log').insert({
    check_name: row.check_name,
    status: 'fail',
    count_result: row.count_result,
    ai_diagnosis: row.ai_diagnosis || null,
    resolved: false,
  });
  if (error) console.error('[system-health] log insert', error.message);
}

async function resolveCheckName(sb, checkName) {
  const now = new Date().toISOString();
  const { error } = await sb
    .from('system_health_log')
    .update({ resolved: true, resolved_at: now })
    .eq('check_name', checkName)
    .eq('resolved', false);
  if (error) console.error('[system-health] resolve', error.message);
}

async function processResults(sb, results, opts) {
  const { withAi, claudeRemainingRef } = opts;
  const enriched = [];

  for (const r of results) {
    let ai_diagnosis = null;
    if (!r.ok && withAi && claudeRemainingRef && claudeRemainingRef.n > 0) {
      const resultText =
        r.error != null
          ? `error: ${r.error}`
          : `count ${r.count == null ? 'null' : r.count} (expected > 0)`;
      claudeRemainingRef.n -= 1;
      ai_diagnosis = await claudeDiagnose(r.name, resultText);
    }

    const countVal = r.count == null ? null : Number(r.count);
    if (!r.ok) {
      await logFailure(sb, {
        check_name: r.name,
        count_result: Number.isFinite(countVal) ? countVal : null,
        ai_diagnosis,
      });
    } else {
      await resolveCheckName(sb, r.name);
    }

    enriched.push({
      name: r.name,
      table: r.table,
      count: r.count,
      ok: r.ok,
      error: r.error || null,
      ai_diagnosis: !r.ok ? ai_diagnosis : null,
      skipped: r.skipped || false,
    });
  }

  return enriched;
}

async function loadRecurringAndResolved(sb) {
  const { data: unresolved, error: e1 } = await sb
    .from('system_health_log')
    .select('check_name')
    .eq('resolved', false);
  if (e1) throw e1;
  const counts = {};
  for (const row of unresolved || []) {
    const k = row.check_name;
    counts[k] = (counts[k] || 0) + 1;
  }
  const recurring = Object.keys(counts)
    .filter((k) => counts[k] >= 3)
    .map((check_name) => ({ check_name, failure_count: counts[check_name] }));

  const { data: resolvedRows, error: e2 } = await sb
    .from('system_health_log')
    .select('check_name, count_result, resolved_at')
    .eq('resolved', true)
    .not('resolved_at', 'is', null)
    .order('resolved_at', { ascending: false })
    .limit(5);
  if (e2) throw e2;

  return { recurring, recentlyResolved: resolvedRows || [] };
}

async function maybeSendFailureEmail(schedule, payload) {
  if (!schedule.emailOnFailure || !schedule.alertEmail) return;
  const failed = (payload.checks || []).filter((c) => !c.ok && !c.skipped);
  const failedFlows = (payload.flows || []).filter((c) => !c.ok && !c.skipped);
  if (!failed.length && !failedFlows.length) return;
  const lines = [...failed, ...failedFlows].map(
    (c) => `- ${c.name}: ${c.error || `count=${c.count}`}`
  );
  await sendResend({
    to: schedule.alertEmail,
    subject: '[System Health] Check failures',
    text: `The following checks failed:\n${lines.join('\n')}\n\nRun: ${payload.type || 'unknown'} at ${payload.at}`,
  });
}

async function runAndPersist(sb, type, schedule) {
  const studioId = studioIdFromEnv();
  const at = new Date().toISOString();
  const cache = (await getAppSettingJson(sb, 'system_health_last_run')) || {};
  const withAi = type === 'full';
  const claudeRemainingRef = { n: withAi ? MAX_CLAUDE_PER_FULL : 0 };

  const quickChecks = await runQuickSqlChecks(sb, studioId);
  let flowResults = [];
  if (withAi) {
    flowResults = await runFlowSimulations(sb, studioId, quickChecks);
  }

  const checksOut = await processResults(
    sb,
    quickChecks.map((c) => ({ ...c, skipped: false })),
    { withAi, claudeRemainingRef }
  );
  let flowsOut = [];
  if (withAi) {
    flowsOut = await processResults(
      sb,
      flowResults.filter((f) => !f.skipped),
      { withAi, claudeRemainingRef }
    );
    const skipped = flowResults.filter((f) => f.skipped);
    for (const s of skipped) {
      flowsOut.push({
        name: s.name,
        table: s.table,
        count: s.count,
        ok: true,
        error: null,
        ai_diagnosis: null,
        skipped: true,
      });
    }
    flowsOut.sort((a, b) => a.name.localeCompare(b.name));
  }

  const payload = {
    at,
    type,
    studioId: studioId || null,
    checks: checksOut,
    flows: flowsOut,
  };

  const nextCache = { ...cache };
  if (type === 'quick') {
    nextCache.quick = payload;
  } else {
    nextCache.full = payload;
    nextCache.quick = {
      at,
      type: 'quick',
      studioId: studioId || null,
      checks: checksOut,
      flows: [],
    };
  }

  await setAppSettingJson(sb, 'system_health_last_run', nextCache);
  await maybeSendFailureEmail(schedule, payload);

  const meta = await loadRecurringAndResolved(sb);
  return { ...payload, recurring: meta.recurring, recentlyResolved: meta.recentlyResolved };
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Cache-Control', 'no-store');
    return res.end();
  }

  let sb;
  try {
    sb = serviceClient();
  } catch (e) {
    return json(res, 500, { error: e && e.message ? e.message : 'Supabase not configured' });
  }

  const isCron = await verifyCronRequest(sb, req);

  if (req.method === 'GET') {
    try {
      await requireAdmin(req);
      const schedule = mergeSchedule(await getAppSettingJson(sb, 'system_health_schedule'));
      const cache = (await getAppSettingJson(sb, 'system_health_last_run')) || {};
      const meta = await loadRecurringAndResolved(sb);
      return json(res, 200, {
        schedule,
        cache,
        recurringIssues: meta.recurring,
        recentlyResolved: meta.recentlyResolved,
      });
    } catch (e) {
      const code = e.statusCode || 500;
      return json(res, code, { error: e.message || 'Error' });
    }
  }

  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    return res.end(JSON.stringify({ error: 'Method not allowed' }));
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }

  try {
    if (isCron) {
      const schedule = mergeSchedule(await getAppSettingJson(sb, 'system_health_schedule'));
      const cache = (await getAppSettingJson(sb, 'system_health_last_run')) || {};
      const ran = { quick: false, full: false };
      let lastPayload = null;
      if (shouldRunAutomatedQuick(schedule, cache)) {
        lastPayload = await runAndPersist(sb, 'quick', schedule);
        ran.quick = true;
      }
      const cache2 = (await getAppSettingJson(sb, 'system_health_last_run')) || {};
      if (shouldRunAutomatedFull(schedule, cache2)) {
        lastPayload = await runAndPersist(sb, 'full', schedule);
        ran.full = true;
      }
      return json(res, 200, { ok: true, ran, result: lastPayload });
    }

    await requireAdmin(req);

    if (body && body.action === 'saveSchedule') {
      const schedule = mergeSchedule(body.schedule);
      await setAppSettingJson(sb, 'system_health_schedule', schedule);
      return json(res, 200, { ok: true, schedule });
    }

    const t = body && body.type;
    if (t === 'quick' || t === 'full') {
      const schedule = mergeSchedule(await getAppSettingJson(sb, 'system_health_schedule'));
      const result = await runAndPersist(sb, t, schedule);
      return json(res, 200, { ok: true, result });
    }

    return json(res, 400, { error: 'Invalid body: use type quick|full or action saveSchedule' });
  } catch (e) {
    const code = e.statusCode || 500;
    return json(res, code, { error: e.message || 'Error' });
  }
};
