/**
 * Scheduled backup: Vercel Cron or external ping.
 * Authorization: Bearer CRON_SECRET (must match env CRON_SECRET).
 * Reads app_settings.backup_schedule; runs when enabled and frequency is not manual.
 */
const { serviceClient } = require('./lib/supabase');
const {
  EXPORT_TABLES,
} = require('./lib/backup-registry');

const DEFAULT_SCHEDULE = {
  enabled: false,
  frequency: 'manual',
  timeUtc: '06:00',
  emailTo: '',
};

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

async function getSchedule(sb) {
  const { data, error } = await sb.from('app_settings').select('value').eq('key', 'backup_schedule').maybeSingle();
  if (error || !data || data.value == null) return { ...DEFAULT_SCHEDULE };
  const v = data.value;
  if (typeof v === 'string') {
    try {
      return { ...DEFAULT_SCHEDULE, ...JSON.parse(v) };
    } catch (e) {
      return { ...DEFAULT_SCHEDULE };
    }
  }
  if (typeof v === 'object') return { ...DEFAULT_SCHEDULE, ...v };
  return { ...DEFAULT_SCHEDULE };
}

async function getLastAuto(sb) {
  const { data } = await sb.from('app_settings').select('value').eq('key', 'backup_last_auto_at').maybeSingle();
  if (!data || data.value == null) return null;
  if (typeof data.value === 'object' && data.value.at) return data.value.at;
  return String(data.value);
}

async function setLastAuto(sb, iso) {
  await sb.from('app_settings').upsert(
    {
      key: 'backup_last_auto_at',
      value: { at: iso },
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'key' }
  );
}

function hourMatches(timeUtc, nowUtc) {
  const parts = String(timeUtc || '06:00').split(':');
  const h = parseInt(parts[0], 10);
  if (isNaN(h)) return true;
  return nowUtc.getUTCHours() === h;
}

function shouldRunWeekly(lastIso, nowMs) {
  if (!lastIso) return true;
  const last = new Date(lastIso).getTime();
  return nowMs - last > 6.5 * 24 * 60 * 60 * 1000;
}

async function maybeEmailBackup(jsonStr, emailTo, fileName) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.BACKUP_EMAIL_FROM || 'onboarding@resend.dev';
  if (!key || !emailTo) return;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [emailTo],
        subject: `IMA scheduled backup ${fileName}`,
        html: '<p>Scheduled backup (see attachment).</p>',
        attachments: [
          {
            filename: fileName,
            content: Buffer.from(jsonStr, 'utf8').toString('base64'),
          },
        ],
      }),
    });
    if (!res.ok) console.warn('[backup-cron] Resend', res.status, await res.text());
  } catch (e) {
    console.warn('[backup-cron] Resend', e && e.message);
  }
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

  const sb = serviceClient();
  const schedule = await getSchedule(sb);

  if (!schedule.enabled || schedule.frequency === 'manual') {
    return json(res, 200, { skipped: true, reason: 'schedule_off_or_manual' });
  }

  const now = new Date();
  if (!hourMatches(schedule.timeUtc, now)) {
    return json(res, 200, { skipped: true, reason: 'hour_mismatch' });
  }

  const last = await getLastAuto(sb);
  if (schedule.frequency === 'daily' && last) {
    const lastD = new Date(last);
    if (lastD.toISOString().slice(0, 10) === now.toISOString().slice(0, 10)) {
      return json(res, 200, { skipped: true, reason: 'already_ran_today' });
    }
  }
  if (schedule.frequency === 'weekly' && !shouldRunWeekly(last, now.getTime())) {
    return json(res, 200, { skipped: true, reason: 'weekly_window' });
  }

  const studioIdFromEnv =
    process.env.NEXT_PUBLIC_STUDIO_ID || process.env.STUDIO_ID || '';
  const studioId = String(studioIdFromEnv).trim() || null;

  const fetchAllRows = async (table) => {
    const pageSize = 500;
    const out = [];
    let from = 0;
    const { STUDIO_SCOPED } = require('./lib/backup-registry');
    const tryScoped = !!(studioId && STUDIO_SCOPED.has(table));
    while (true) {
      let q = sb.from(table).select('*').range(from, from + pageSize - 1);
      if (tryScoped) q = q.eq('studio_id', studioId);
      let { data, error } = await q;
      if (error && tryScoped && /studio_id|column|22P02|PGRST204/i.test(String(error.message || ''))) {
        ({ data, error } = await sb.from(table).select('*').range(from, from + pageSize - 1));
      }
      if (error) {
        const msg = String(error.message || '');
        if (error.code === 'PGRST205' || /does not exist|schema cache/i.test(msg)) return [];
        throw error;
      }
      const chunk = data || [];
      if (!chunk.length) break;
      out.push(...chunk);
      if (chunk.length < pageSize) break;
      from += pageSize;
    }
    return out;
  };

  const tables = {};
  const rowCounts = {};
  let totalRows = 0;
  for (const name of EXPORT_TABLES) {
    try {
      const rows = await fetchAllRows(name);
      tables[name] = rows;
      rowCounts[name] = rows.length;
      totalRows += rows.length;
    } catch (e) {
      tables[name] = [];
      rowCounts[name] = 0;
    }
  }

  payload = {
    backup_version: '1.0',
    studio_id: studioId || '',
    exported_at: now.toISOString(),
    table_count: EXPORT_TABLES.length,
    row_counts: rowCounts,
    tables,
  };

  const d = now.toISOString().slice(0, 10);
  const fileName = `imaos-backup-${d}.json`;
  const jsonStr = JSON.stringify(payload, null, 2);
  const nonEmptyTables = Object.keys(rowCounts).filter((k) => rowCounts[k] > 0).length;

  try {
    await sb.from('backup_log').insert({
      studio_id: studioId,
      file_name: fileName,
      table_count: nonEmptyTables,
      total_rows: totalRows,
      status: 'completed',
      notes: 'cron',
    });
  } catch (e) {
    void e;
  }

  await setLastAuto(sb, now.toISOString());

  if (schedule.emailTo) {
    await maybeEmailBackup(jsonStr, schedule.emailTo, fileName);
  }

  return json(res, 200, {
    ok: true,
    fileName,
    totalRows,
    tablesWithData: nonEmptyTables,
  });
};
