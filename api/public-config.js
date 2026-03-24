/**
 * Exposes public Supabase client settings to the browser (anon key only).
 * Set in Vercel: NEXT_PUBLIC_SUPABASE_ANON_KEY (required). URL defaults to IMA project.
 */
const DEFAULT_SUPABASE_URL = 'https://dzsrtmkyluqxgowfpuzh.supabase.co';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.SUPABASE_URL ||
    DEFAULT_SUPABASE_URL;
  const anonKey =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    '';

  res.status(200).json({
    url: url.trim(),
    anonKey: anonKey.trim(),
  });
};
