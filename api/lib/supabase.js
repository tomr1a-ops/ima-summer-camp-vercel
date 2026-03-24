const { createClient } = require('@supabase/supabase-js');

/** Default project URL when env vars are not set (keys must still be in env). */
/** Fallback only when no URL env vars are set — must match your Supabase project ref. */
const DEFAULT_SUPABASE_URL = 'https://dzsrtnkyluqxgowfpuzh.supabase.co';

const URL_ENV_KEYS = [
  'SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_URL',
  'PUBLIC_SUPABASE_URL',
  'VITE_SUPABASE_URL',
  'EXPO_PUBLIC_SUPABASE_URL',
];

const ANON_ENV_KEYS = [
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_ANON_KEY',
  'PUBLIC_SUPABASE_ANON_KEY',
  'VITE_SUPABASE_ANON_KEY',
  'EXPO_PUBLIC_SUPABASE_ANON_KEY',
];

const SERVICE_ENV_KEYS = [
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_SERVICE_KEY',
  'SUPABASE_SECRET_SERVICE_ROLE_KEY',
];

function firstEnv(names) {
  for (const name of names) {
    const v = process.env[name];
    if (v != null && String(v).trim() !== '') {
      return { name, value: String(v).trim() };
    }
  }
  return null;
}

function resolveSupabaseUrl() {
  const found = firstEnv(URL_ENV_KEYS);
  if (found) return { url: found.value, source: found.name };
  return { url: DEFAULT_SUPABASE_URL, source: 'default_embedded_url' };
}

function serviceClient() {
  const { url } = resolveSupabaseUrl();
  const key = firstEnv(SERVICE_ENV_KEYS);
  if (!key) {
    throw new Error(
      'Missing Supabase service role key. Set one of: ' + SERVICE_ENV_KEYS.join(', ')
    );
  }
  return createClient(url, key.value, { auth: { persistSession: false } });
}

function anonClient() {
  const { url } = resolveSupabaseUrl();
  const key = firstEnv(ANON_ENV_KEYS);
  if (!key) {
    throw new Error('Missing Supabase anon key. Set one of: ' + ANON_ENV_KEYS.join(', '));
  }
  return createClient(url, key.value, { auth: { persistSession: false } });
}

/**
 * For /api/weeks: prefer anon + RLS. If anon vars are missing but the service key
 * exists (common misconfiguration), fall back so the catalog still loads.
 */
function clientForWeeksApi() {
  const { url, source: urlSource } = resolveSupabaseUrl();
  const anon = firstEnv(ANON_ENV_KEYS);
  if (anon) {
    return {
      client: createClient(url, anon.value, { auth: { persistSession: false } }),
      mode: 'anon',
      urlSource,
      keySource: anon.name,
    };
  }
  const svc = firstEnv(SERVICE_ENV_KEYS);
  if (svc) {
    return {
      client: createClient(url, svc.value, { auth: { persistSession: false } }),
      mode: 'service_role_fallback',
      urlSource,
      keySource: svc.name,
    };
  }
  const err = new Error(
    'No Supabase credentials. Set anon (' +
      ANON_ENV_KEYS.join(', ') +
      ') or service (' +
      SERVICE_ENV_KEYS.join(', ') +
      ')'
  );
  err.code = 'SUPABASE_CONFIG_MISSING';
  throw err;
}

module.exports = {
  serviceClient,
  anonClient,
  clientForWeeksApi,
  resolveSupabaseUrl,
  URL_ENV_KEYS,
  ANON_ENV_KEYS,
  SERVICE_ENV_KEYS,
  DEFAULT_SUPABASE_URL,
};
