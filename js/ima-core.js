(function () {
  const g = window;
  g.IMA = g.IMA || {};

  let clientPromise = null;
  let createClientFn = null;

  g.IMA.loadSupabase = async function () {
    if (createClientFn) return;
    const mod = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.48.1/+esm');
    createClientFn = mod.createClient;
  };

  g.IMA.getSupabase = async function () {
    await g.IMA.loadSupabase();
    if (!createClientFn) throw new Error('Supabase library not available');
    if (clientPromise) return clientPromise;
    clientPromise = (async function () {
      const res = await fetch('/api/public-config');
      if (!res.ok) throw new Error('Could not load configuration');
      const cfg = await res.json();
      if (!cfg.url || !cfg.anonKey) {
        throw new Error('Supabase URL or anon key missing. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY on Vercel.');
      }
      return createClientFn(cfg.url, cfg.anonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          storage: g.localStorage,
        },
      });
    })();
    return clientPromise;
  };

  g.IMA.getSession = async function () {
    const sb = await g.IMA.getSupabase();
    const { data, error } = await sb.auth.getSession();
    if (error) throw error;
    return data.session;
  };

  g.IMA.getProfile = async function () {
    const session = await g.IMA.getSession();
    if (!session) return null;
    const sb = await g.IMA.getSupabase();
    const { data, error } = await sb
      .from('profiles')
      .select('id,email,full_name,phone,role,created_at')
      .eq('id', session.user.id)
      .maybeSingle();
    if (error) throw error;
    return data;
  };

  g.IMA.requireAuth = async function (loginPath) {
    const session = await g.IMA.getSession();
    if (!session) {
      g.location.href = loginPath || '/login.html';
      return null;
    }
    return session;
  };

  g.IMA.signOut = async function () {
    const sb = await g.IMA.getSupabase();
    await sb.auth.signOut();
    g.location.href = '/login.html';
  };

  g.IMA.formatMoney = function (n) {
    const x = Number(n);
    if (!Number.isFinite(x)) return '—';
    return '$' + x.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  };

  g.IMA.formatDate = function (iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  };
})();
