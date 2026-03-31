(function (g) {
  var IMA = g.IMA || (g.IMA = {});

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function ensureClientAndStudio() {
    await IMA.loadPublicConfig();
    if (!g.supabaseClient) {
      g.supabaseClient = await IMA.getSupabase();
    }
    var cfg = IMA.__publicConfig || {};
    if (!g.STUDIO_ID && cfg.studioId) {
      g.STUDIO_ID = String(cfg.studioId).trim();
    }
    return g.supabaseClient;
  }

  /**
   * @returns {Promise<Array<{ name: string, ok: boolean, count: number|null, error: string|null }>>}
   */
  IMA.runQuickSystemHealthChecks = async function () {
    var sb = await ensureClientAndStudio();
    var studioId = g.STUDIO_ID;
    var today = new Date().toISOString().split('T')[0];
    var weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    var tasks = [
      {
        name: 'Classes (upcoming)',
        run: function () {
          return sb
            .from('classes')
            .select('id', { count: 'exact', head: true })
            .gte('date', today)
            .eq('studio_id', studioId);
        },
      },
      {
        name: 'Studio config',
        run: function () {
          return sb.from('studio_config').select('id', { count: 'exact', head: true }).eq('id', studioId);
        },
      },
      {
        name: 'Recent reservations (7d)',
        run: function () {
          return sb
            .from('class_reservations')
            .select('id', { count: 'exact', head: true })
            .gte('created_at', weekAgo);
        },
      },
      {
        name: 'Active members',
        run: function () {
          return sb.from('members').select('id', { count: 'exact', head: true }).eq('status', 'active');
        },
      },
      {
        name: 'Prospects',
        run: function () {
          return sb.from('prospects').select('id', { count: 'exact', head: true });
        },
      },
      {
        name: 'App settings (imaos_config)',
        run: function () {
          return sb.from('app_settings').select('key', { count: 'exact', head: true }).eq('key', 'imaos_config');
        },
      },
    ];

    var out = [];
    for (var i = 0; i < tasks.length; i++) {
      var t = tasks[i];
      try {
        var res = await t.run();
        var err = res.error;
        var cnt = res.count;
        if (err) {
          out.push({ name: t.name, ok: false, count: null, error: err.message || String(err) });
        } else {
          var n = typeof cnt === 'number' ? cnt : 0;
          out.push({ name: t.name, ok: n > 0, count: n, error: null });
        }
      } catch (e) {
        out.push({
          name: t.name,
          ok: false,
          count: null,
          error: e && e.message ? e.message : String(e),
        });
      }
    }
    return out;
  };

  IMA.renderSystemHealthRows = function (container, results) {
    if (!container) return;
    if (!results || !results.length) {
      container.innerHTML = '<p class="empty-hint" style="margin:0">No results.</p>';
      return;
    }
    var parts = [];
    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      var ok = !!r.ok;
      var cls = ok ? 'good' : 'bad';
      var emoji = ok ? '✅' : '❌';
      var countLine =
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
