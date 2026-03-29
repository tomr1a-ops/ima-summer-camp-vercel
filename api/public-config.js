/**
 * Exposes public client settings to the browser (Supabase anon key + Stripe publishable key).
 * Vercel: NEXT_PUBLIC_SUPABASE_ANON_KEY (required), STRIPE_PUBLISHABLE_KEY or NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY.
 */
const { resolveSupabaseUrl, ANON_ENV_KEYS } = require('./lib/supabase');
const { setNoStoreJsonHeaders } = require('./lib/http-no-store');

/** Dashboard link to toggle Email "Confirm email" (project ref from *.supabase.co URL). */
function authProvidersHelpUrl(supabaseUrl) {
  const m = String(supabaseUrl || '')
    .trim()
    .match(/^https:\/\/([a-z0-9-]+)\.supabase\.co\/?$/i);
  if (!m) return null;
  return `https://supabase.com/dashboard/project/${m[1]}/auth/providers`;
}

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

  const u = url.trim();
  const stripePublishableKey = String(
    process.env.STRIPE_PUBLISHABLE_KEY ||
      process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ||
      ''
  ).trim();

  setNoStoreJsonHeaders(res);
  res.status(200).json({
    url: u,
    anonKey: anonKey.trim(),
    authProvidersHelpUrl: authProvidersHelpUrl(u),
    stripePublishableKey,
  });
};
