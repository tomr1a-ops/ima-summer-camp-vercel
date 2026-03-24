/**
 * Exposes public Supabase client settings to the browser (anon key only).
 * Set in Vercel: NEXT_PUBLIC_SUPABASE_ANON_KEY (required). URL defaults to IMA project.
 */
const { resolveSupabaseUrl, ANON_ENV_KEYS } = require('./lib/supabase');

function firstAnonFromEnv() {
  for (const name of ANON_ENV_KEYS) {
    const v = process.env[name];
    if (v != null && String(v).trim() !== '') return { name, value: String(v).trim() };
  }
  return null;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { url } = resolveSupabaseUrl();
  const anonPick = firstAnonFromEnv();
  const anonKey = anonPick ? anonPick.value : '';

  res.status(200).json({
    url: url.trim(),
    anonKey: anonKey.trim(),
  });
};
