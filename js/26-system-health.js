(function (g) {
  var IMA = g.IMA || (g.IMA = {});

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function runSystemHealthChecks() {
    const sb = g.supabaseClient;
    if (!sb) throw new Error('supabaseClient not ready');
    const today = new Date().toISOString().split('T')[0];
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const results = [];

    const checks = [
      {
        name: 'Classes (future)',
        query: sb.from('classes').select('id', { count: 'exact', head: true }).gte('date', today),
      },
      {
        name: 'Active Members',
        query: sb.from('members').select('id', { count: 'exact', head: true }).eq('status', 'active'),
      },
      {
        name: 'Prospects',
        query: sb.from('prospects').select('id', { count: 'exact', head: true }),
      },
      {
        name: 'App Settings',
        query: sb.from('app_settings').select('key', { count: 'exact', head: true }).eq('key', 'imaos_config'),
      },
      {
        name: 'Reservations (7d)',
        query: sb
          .from('class_reservations')
          .select('id', { count: 'exact', head: true })
          .gte('created_at', weekAgo),
      },
    ];

    for (const check of checks) {
      try {
        const { count, error } = await check.query;
        const pass = !error && count > 0;
        results.push({
          name: check.name,
          count: error ? null : count,
          error: error ? error.message || String(error) : null,
          ok: pass,
        });
      } catch (e) {
        results.push({
          name: check.name,
          count: null,
          error: e && e.message ? e.message : String(e),
          ok: false,
        });
      }
    }
    return results;
  }

  IMA.runQuickSystemHealthChecks = runSystemHealthChecks;
  IMA.runSystemHealthChecks = runSystemHealthChecks;

  IMA.renderSystemHealthRows = function (container, rows) {
    if (!container) return;
    if (!rows || !rows.length) {
      container.innerHTML = '<p class="empty-hint" style="margin:0">No results.</p>';
      return;
    }
    const parts = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const ok = !!r.ok;
      const cls = ok ? 'good' : 'bad';
      const emoji = ok ? '✅' : '❌';
      const countLine =
        r.error != null
          ? 'count: — · error: ' + escapeHtml(r.error)
          : 'count: ' + escapeHtml(String(r.count != null ? r.count : '—'));
      parts.push(
        '<div class="health-check-row ' +
          cls +
          '"><span class="health-emoji">' +
          emoji +
          '</span><div class="health-meta"><div class="health-name">' +
          escapeHtml(r.name) +
          '</div><div class="health-count">' +
          countLine +
          '</div></div></div>'
      );
    }
    container.innerHTML = parts.join('');
  };
})(window);
