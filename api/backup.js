/**
 * Admin Backup & Recovery — service role only for DB; admin JWT required for all routes.
 * POST { action: 'create' | 'preview' | 'restore' | 'saveSchedule', ... }
 * GET — backup_log history (last 10) + optional ?schedule=1 for backup_schedule
 */
const { serviceClient } = require('./lib/supabase');
const { requireAdmin } = require('./lib/auth');
const {
  EXPORT_TABLES,
  RESTORE_ORDER,
  onConflictFor,
  STUDIO_SCOPED,
} = require('./lib/backup-registry');

function json(res, code, body) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.end(JSON.stringify(body));
}

function parseBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (Buffer.isBuffer(req.body)) {
      try {
        return JSON.parse(req.body.toString('utf8') || '{}');
      } catch (e) {
        return {};
      }
    }
    if (typeof req.body === 'string') {
      try {
        return JSON.parse(req.body || '{}');
      } catch (e) {
        return {};
      }
    }
    if (typeof req.body === 'object') return req.body;
  }
  return {};
}

function studioIdFromEnv() {
  const v =
    process.env.NEXT_PUBLIC_STUDIO_ID ||
    process.env.STUDIO_ID ||
    process.env.PUBLIC_STUDIO_ID ||
    '';
  const s = String(v).trim();
  return s || null;
}

function isMissingTableError(e) {
  if (!e) return false;
  const msg = String(e.message || e.details || e.hint || '');
  const code = String(e.code || '');
  return (
    code === 'PGRST205' ||
    code === '42P01' ||
    /could not find the table|relation .* does not exist|schema cache/i.test(msg)
  );
}

async function fetchAllRows(sb, table, studioId) {
  const pageSize = 500;
  const out = [];
  let from = 0;
  const tryScoped = !!(studioId && STUDIO_SCOPED.has(table));

  while (true) {
    let q = sb.from(table).select('*').range(from, from + pageSize - 1);
    if (tryScoped) q = q.eq('studio_id', studioId);
    let { data, error } = await q;

    if (error && tryScoped && /studio_id|column|22P02|PGRST204/i.test(String(error.message || ''))) {
      ({ data, error } = await sb.from(table).select('*').range(from, from + pageSize - 1));
    }

    if (error) {
      if (isMissingTableError(error)) return { rows: null, missing: true };
      throw error;
    }
    const chunk = data || [];
    if (!chunk.length) break;
    out.push(...chunk);
    if (chunk.length < pageSize) break;
    from += pageSize;
  }
  return { rows: out, missing: false };
}

async function buildBackupPayload(sb) {
  const studioId = studioIdFromEnv();
  const tables = {};
  const rowCounts = {};
  let totalRows = 0;
  let presentTables = 0;

  for (const name of EXPORT_TABLES) {
    try {
      const { rows, missing } = await fetchAllRows(sb, name, studioId);
      if (missing) {
        tables[name] = [];
        rowCounts[name] = 0;
        continue;
      }
      tables[name] = rows;
      rowCounts[name] = rows.length;
      totalRows += rows.length;
      if (rows.length) presentTables++;
    } catch (e) {
      if (isMissingTableError(e)) {
        tables[name] = [];
        rowCounts[name] = 0;
      } else {
        throw e;
      }
    }
  }

  const payload = {
    backup_version: '1.0',
    studio_id: studioId || '',
    exported_at: new Date().toISOString(),
    table_count: EXPORT_TABLES.length,
    row_counts: rowCounts,
    tables,
  };
  return { payload, totalRows, presentTables };
}

async function insertBackupLog(sb, { fileName, tableCount, totalRows, status, notes, studioId }) {
  const row = {
    studio_id: studioId || null,
    file_name: fileName,
    table_count: tableCount,
    total_rows: totalRows,
    status: status || 'completed',
    notes: notes || null,
  };
  const { data, error } = await sb.from('backup_log').insert(row).select('id').maybeSingle();
  if (error) {
    console.warn('[backup] backup_log insert', error.message || error);
    return null;
  }
  return data && data.id ? data.id : null;
}

function validateBackupFile(obj) {
  if (!obj || typeof obj !== 'object') return { ok: false, error: 'Invalid JSON' };
  if (obj.backup_version !== '1.0') return { ok: false, error: 'Unknown backup_version' };
  if (!obj.tables || typeof obj.tables !== 'object') return { ok: false, error: 'Missing tables' };
  return { ok: true };
}

function previewBackup(obj) {
  const v = validateBackupFile(obj);
  if (!v.ok) return { error: v.error };
  let total = 0;
  const counts = {};
  const names = Object.keys(obj.tables);
  for (const k of names) {
    const rows = obj.tables[k];
    const n = Array.isArray(rows) ? rows.length : 0;
    counts[k] = n;
    total += n;
  }
  return {
    table_count: names.length,
    total_rows: total,
    exported_at: obj.exported_at || null,
    studio_id: obj.studio_id || null,
    row_counts: counts,
  };
}

const BATCH = 80;

async function upsertChunk(sb, table, rows, conflict) {
  const { error } = await sb.from(table).upsert(rows, { onConflict: conflict });
  if (error) throw error;
}

async function restoreTables(sb, backup, selectedSet) {
  const progress = [];
  let restoredRows = 0;
  let restoredTables = 0;

  const order = RESTORE_ORDER.filter((t) => EXPORT_TABLES.includes(t));
  const inBackup = new Set(Object.keys(backup.tables || {}));

  for (const table of order) {
    if (!inBackup.has(table)) {
      progress.push({ table, status: 'skipped', reason: 'not_in_file', done: 0, total: 0 });
      continue;
    }
    if (selectedSet && !selectedSet.has(table)) {
      progress.push({ table, status: 'skipped', reason: 'not_selected', done: 0, total: 0 });
      continue;
    }
    const rows = backup.tables[table];
    if (!Array.isArray(rows) || !rows.length) {
      progress.push({ table, status: 'skipped', reason: 'empty', done: 0, total: 0 });
      continue;
    }

    const conflict = onConflictFor(table);
    let done = 0;
    try {
      for (let i = 0; i < rows.length; i += BATCH) {
        const chunk = rows.slice(i, i + BATCH);
        await upsertChunk(sb, table, chunk, conflict);
        done += chunk.length;
      }
      restoredRows += done;
      restoredTables++;
      progress.push({ table, status: 'ok', done, total: rows.length });
    } catch (e) {
      progress.push({
        table,
        status: 'error',
        message: e.message || String(e),
        done,
        total: rows.length,
      });
      throw Object.assign(new Error(`Restore failed on ${table}: ${e.message || e}`), {
        progress,
      });
    }
  }

  return { progress, restoredRows, restoredTables };
}

const DEFAULT_SCHEDULE = {
  enabled: false,
  frequency: 'manual',
  timeUtc: '06:00',
  emailTo: '',
};

async function getBackupSchedule(sb) {
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

async function saveBackupSchedule(sb, schedule) {
  const merged = { ...DEFAULT_SCHEDULE, ...schedule };
  const row = {
    key: 'backup_schedule',
    value: merged,
    updated_at: new Date().toISOString(),
  };
  const { error } = await sb.from('app_settings').upsert(row, { onConflict: 'key' });
  if (error) throw error;
  return merged;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  const sb = serviceClient();

  if (req.method === 'GET') {
    try {
      await requireAdmin(req);
    } catch (e) {
      return json(res, e.statusCode || 500, { error: e.message || 'Unauthorized' });
    }
    try {
      const url = new URL(req.url || '', 'http://local');
      if (url.searchParams.get('schedule') === '1') {
        const schedule = await getBackupSchedule(sb);
        return json(res, 200, { schedule, studio_id: studioIdFromEnv() || '' });
      }
      if (url.searchParams.get('meta') === '1') {
        return json(res, 200, {
          export_tables: EXPORT_TABLES,
          restore_order: RESTORE_ORDER,
          studio_id: studioIdFromEnv() || '',
        });
      }
      const { data, error } = await sb
        .from('backup_log')
        .select('id, created_at, file_name, table_count, total_rows, status, notes')
        .order('created_at', { ascending: false })
        .limit(10);
      if (error) {
        if (isMissingTableError(error)) return json(res, 200, { history: [] });
        throw error;
      }
      return json(res, 200, { history: data || [] });
    } catch (e) {
      console.error('[backup] GET', e);
      return json(res, 500, { error: e.message || 'Server error' });
    }
  }

  if (req.method !== 'POST') {
    return json(res, 405, { error: 'Method not allowed' });
  }

  try {
    await requireAdmin(req);
  } catch (e) {
    return json(res, e.statusCode || 500, { error: e.message || 'Unauthorized' });
  }

  const body = parseBody(req);
  const action = body.action;

  try {
    if (action === 'saveSchedule') {
      const schedule = await saveBackupSchedule(sb, body.schedule || {});
      return json(res, 200, { ok: true, schedule });
    }

    if (action === 'preview') {
      const v = validateBackupFile(body.data);
      if (!v.ok) return json(res, 400, { error: v.error });
      const p = previewBackup(body.data);
      if (p.error) return json(res, 400, { error: p.error });
      return json(res, 200, { preview: p });
    }

    if (action === 'restore') {
      const v = validateBackupFile(body.data);
      if (!v.ok) return json(res, 400, { error: v.error });
      const selected = Array.isArray(body.tables) ? body.tables : null;
      const selectedSet = selected ? new Set(selected.map(String)) : null;

      let result;
      try {
        result = await restoreTables(sb, body.data, selectedSet);
      } catch (e) {
        const logId = await insertBackupLog(sb, {
          fileName: null,
          tableCount: 0,
          totalRows: 0,
          status: 'restore_failed',
          notes: e.message || String(e),
          studioId: studioIdFromEnv(),
        });
        return json(res, 500, {
          error: e.message || 'Restore failed',
          progress: e.progress || [],
          logId,
        });
      }

      const notes = `restored ${result.restoredTables} tables, ${result.restoredRows} rows`;
      let logId = null;
      try {
        logId = await insertBackupLog(sb, {
          fileName: null,
          tableCount: result.restoredTables,
          totalRows: result.restoredRows,
          status: 'restored',
          notes,
          studioId: studioIdFromEnv(),
        });
      } catch (e) {
        void e;
      }

      return json(res, 200, {
        ok: true,
        summary: notes,
        progress: result.progress,
        restoredTables: result.restoredTables,
        restoredRows: result.restoredRows,
        logId,
      });
    }

    if (action === 'create') {
      const { payload, totalRows } = await buildBackupPayload(sb);
      const d = new Date().toISOString().slice(0, 10);
      const fileName = `imaos-backup-${d}.json`;
      const nonEmptyTables = Object.keys(payload.row_counts).filter(
        (k) => payload.row_counts[k] > 0
      ).length;

      let logId = null;
      try {
        logId = await insertBackupLog(sb, {
          fileName,
          tableCount: nonEmptyTables,
          totalRows,
          status: 'completed',
          notes: null,
          studioId: studioIdFromEnv(),
        });
      } catch (logErr) {
        console.warn('[backup] log', logErr && logErr.message);
      }

      const jsonStr = JSON.stringify(payload, null, 2);

      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      if (logId) res.setHeader('X-Backup-Log-Id', String(logId));
      return res.end(jsonStr);
    }

    return json(res, 400, { error: 'Unknown action' });
  } catch (e) {
    console.error('[backup] POST', e);
    return json(res, 500, { error: e.message || 'Server error' });
  }
};
