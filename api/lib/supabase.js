const { createClient } = require('@supabase/supabase-js');

/** Default project URL when env vars are not set (keys must still be in env). */
const DEFAULT_SUPABASE_URL = 'https://dzsrtmkyluqxgowfpuzh.supabase.co';

function serviceClient() {
  const url =
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    DEFAULT_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    throw new Error('Missing SUPABASE_SERVICE_KEY');
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

function anonClient() {
  const url =
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    DEFAULT_SUPABASE_URL;
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    '';
  if (!url || !key) throw new Error('Missing Supabase anon configuration');
  return createClient(url, key, { auth: { persistSession: false } });
}

module.exports = { serviceClient, anonClient };
