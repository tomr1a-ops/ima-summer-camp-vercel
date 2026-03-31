(function () {
  const g = window;
  g.IMA = g.IMA || {};

  let clientPromise = null;
  let createClientFn = null;
  let publicConfigPromise = null;
  let loadSupabasePromise = null;

  const SUPABASE_ESM_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.48.1/+esm';
  const SUPABASE_UMD_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.48.1/dist/umd/supabase.min.js';

  function getCreateClientFromGlobal() {
    const s = g.supabase;
    if (!s) return null;
    if (typeof s.createClient === 'function') return s.createClient;
    return null;
  }

  /** localStorage is blocked in some private / strict mobile modes; use memory so sign-in still works for the session. */
  function getAuthStorage() {
    try {
      const t = '__ima_sb_ls__';
      g.localStorage.setItem(t, '1');
      g.localStorage.removeItem(t);
      return g.localStorage;
    } catch (e) {
      const mem = Object.create(null);
      return {
        getItem: function (k) {
          return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null;
        },
        setItem: function (k, v) {
          mem[k] = String(v);
        },
        removeItem: function (k) {
          delete mem[k];
        },
      };
    }
  }

  g.IMA.loadPublicConfig = async function () {
    if (!publicConfigPromise) {
      publicConfigPromise = (async function () {
        const res = await fetch('/api/public-config');
        if (!res.ok) throw new Error('Could not load configuration');
        const cfg = await res.json();
        g.IMA.__publicConfig = cfg;
        return cfg;
      })();
    }
    return publicConfigPromise;
  };

  /** Stripe.js publishable key from Vercel env (pk_test_… or pk_live_…), exposed via /api/public-config */
  g.IMA.getStripePublishableKey = async function () {
    const cfg = await g.IMA.loadPublicConfig();
    return String(cfg.stripePublishableKey || '').trim();
  };

  g.IMA.loadSupabase = async function () {
    if (createClientFn) return;
    if (!loadSupabasePromise) {
      loadSupabasePromise = (async function () {
        try {
          const mod = await import(SUPABASE_ESM_URL);
          if (mod && typeof mod.createClient === 'function') {
            createClientFn = mod.createClient;
            return;
          }
        } catch (e1) {
          void e1;
        }
        let fn = getCreateClientFromGlobal();
        if (fn) {
          createClientFn = fn;
          return;
        }
        await new Promise(function (resolve, reject) {
          const s = document.createElement('script');
          s.src = SUPABASE_UMD_URL;
          s.async = true;
          s.crossOrigin = 'anonymous';
          s.onload = function () {
            fn = getCreateClientFromGlobal();
            if (fn) {
              createClientFn = fn;
              resolve();
            } else {
              reject(new Error('Supabase loaded but sign-in library is incomplete.'));
            }
          };
          s.onerror = function () {
            reject(
              new Error(
                'Could not load sign-in (network or browser restriction). Try Safari/Chrome outside an in-app browser, or check your connection.'
              )
            );
          };
          document.head.appendChild(s);
        });
      })();
    }
    await loadSupabasePromise;
  };

  g.IMA.getSupabase = async function () {
    await g.IMA.loadSupabase();
    if (!createClientFn) throw new Error('Supabase library not available');
    if (clientPromise) return clientPromise;
    clientPromise = (async function () {
      const cfg = await g.IMA.loadPublicConfig();
      if (!cfg.url || !cfg.anonKey) {
        throw new Error('Supabase URL or anon key missing. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY on Vercel.');
      }
      g.IMA.authProvidersHelpUrl = cfg.authProvidersHelpUrl || null;
      return createClientFn(cfg.url, cfg.anonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          storage: getAuthStorage(),
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

  /**
   * Refresh JWT before POSTs to Vercel APIs (create-checkout-session, etc.).
   * Avoids 401 when the UI still looks signed in but access_token expired (common on mobile).
   */
  g.IMA.refreshSessionForApi = async function () {
    const sb = await g.IMA.getSupabase();
    const { data: ref, error: refErr } = await sb.auth.refreshSession();
    if (!refErr && ref.session && ref.session.access_token) {
      return { session: ref.session, accessToken: ref.session.access_token };
    }
    const { data, error } = await sb.auth.getSession();
    if (error || !data.session || !data.session.access_token) {
      return { session: null, accessToken: null };
    }
    return { session: data.session, accessToken: data.session.access_token };
  };

  g.IMA.getProfile = async function () {
    const session = await g.IMA.getSession();
    if (!session) return null;
    const sb = await g.IMA.getSupabase();
    const { data, error } = await sb
      .from('profiles')
      .select('id,email,full_name,phone,role,created_at,waiver_signed,waiver_signed_at')
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

  g.IMA.signOut = async function (redirectPath) {
    const sb = await g.IMA.getSupabase();
    await sb.auth.signOut();
    g.location.href =
      redirectPath != null && String(redirectPath).trim() !== '' ? String(redirectPath).trim() : '/login.html';
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

  /** Emails that always land on admin after login (in addition to profiles.role = admin). */
  g.IMA.ADMIN_LOGIN_EMAILS = ['tom@imaimpact.com', 'coachshick@imaimpact.com'];
  g.IMA.isAdminLoginEmail = function (email) {
    const e = String(email || '')
      .trim()
      .toLowerCase();
    return g.IMA.ADMIN_LOGIN_EMAILS.indexOf(e) !== -1;
  };

  /** Set by success.html after Stripe redirect; index consumes once to clear local checkout drafts. */
  g.IMA.POST_CHECKOUT_CLEAR_ENROLL_KEY = 'ima_post_checkout_clear_enroll';

  /** @returns {boolean} true if flag was present (and then removed) */
  g.IMA.consumePostCheckoutClearEnrollFlag = function () {
    try {
      const k = g.IMA.POST_CHECKOUT_CLEAR_ENROLL_KEY;
      const ls = localStorage.getItem(k) === '1';
      const ss = sessionStorage.getItem(k) === '1';
      if (!ls && !ss) return false;
      localStorage.removeItem(k);
      sessionStorage.removeItem(k);
      return true;
    } catch (e) {
      return false;
    }
  };
})();
