(function () {
  var CAMP_SCHEDULE_HOURS_LINE = 'Camp 9am–3pm · Complimentary drop-off from 8:30am';
  var LS_KEY_PREFIX = 'ima_cc_portal_selected_weeks_v1:';
  var weeksPayload = [];
  var campers = [];
  var session = null;
  var accessToken = '';
  var selectedWeeks = {};
  var pricing = { weekRate: 425, registrationFee: 65, perCamperNeedsReg: {}, test: false };

  function lsKey() {
    return LS_KEY_PREFIX + (session && session.user ? session.user.id : 'guest');
  }

  function loadSelectedFromStorage() {
    try {
      var raw = localStorage.getItem(lsKey());
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (o && o.selectedWeeks && typeof o.selectedWeeks === 'object') return o.selectedWeeks;
    } catch (e) {}
    return null;
  }

  function saveSelectedToStorage() {
    try {
      localStorage.setItem(
        lsKey(),
        JSON.stringify({ v: 1, selectedWeeks: selectedWeeks, savedAt: Date.now() })
      );
    } catch (e) {}
  }

  function clearStorage() {
    try {
      localStorage.removeItem(lsKey());
    } catch (e) {}
  }

  function noStoreFetch(url, opts) {
    opts = opts || {};
    var sep = url.indexOf('?') >= 0 ? '&' : '?';
    var busted = url + sep + '_nc=' + Date.now();
    var h = Object.assign({}, opts.headers || {});
    h['Cache-Control'] = 'no-cache';
    h['Pragma'] = 'no-cache';
    return fetch(busted, Object.assign({ cache: 'no-store', credentials: 'same-origin' }, opts, { headers: h }));
  }

  function enrollmentRowPaidViaStripe(row) {
    if (!row) return false;
    if (row.stripe_session_id != null && String(row.stripe_session_id).trim() !== '') return true;
    if (row.checkout_batch_id != null && String(row.checkout_batch_id).trim() !== '') return true;
    return false;
  }

  function isManageableCardRow(row) {
    if (!row) return false;
    var st = String(row.status || '');
    if (st === 'pending_step_up' || st === 'cancelled') return false;
    if (st === 'pending') return true;
    if (st === 'confirmed') return enrollmentRowPaidViaStripe(row);
    return false;
  }

  function rowCoversFullWeek(row, weekObj) {
    if (!weekObj || !weekObj.days || weekObj.days.length !== 5) return false;
    var set = new Set((row.day_ids || []).map(function (x) {
      return String(x);
    }));
    for (var i = 0; i < weekObj.days.length; i++) {
      if (!set.has(String(weekObj.days[i].id))) return false;
    }
    return true;
  }

  function weekById(id) {
    var sid = String(id);
    for (var i = 0; i < weeksPayload.length; i++) {
      if (String(weeksPayload[i].id) === sid) return weeksPayload[i];
    }
    return null;
  }

  function ensureWeekSet(wid) {
    var k = String(wid);
    if (!selectedWeeks[k]) selectedWeeks[k] = [];
    return selectedWeeks[k];
  }

  function isCamperSelectedForWeek(wid, cid) {
    var arr = selectedWeeks[String(wid)] || [];
    return arr.indexOf(String(cid)) !== -1;
  }

  function toggleCamperWeek(wid, cid, checked) {
    var k = String(wid);
    var id = String(cid);
    var arr = ensureWeekSet(k);
    var ix = arr.indexOf(id);
    if (checked) {
      if (ix === -1) arr.push(id);
    } else {
      if (ix !== -1) arr.splice(ix, 1);
    }
    if (!arr.length) delete selectedWeeks[k];
    saveSelectedToStorage();
    renderGrid();
    renderTotal();
  }

  function countSelections() {
    var n = 0;
    Object.keys(selectedWeeks).forEach(function (w) {
      n += (selectedWeeks[w] || []).length;
    });
    return n;
  }

  function uniqueCampersInSelection() {
    var s = new Set();
    Object.keys(selectedWeeks).forEach(function (w) {
      (selectedWeeks[w] || []).forEach(function (c) {
        s.add(String(c));
      });
    });
    return s;
  }

  function renderTotal() {
    var el = document.getElementById('cc-total');
    if (!el) return;
    var n = countSelections();
    var wr = Number(pricing.weekRate) || 0;
    var campSub = n * wr;
    var reg = 0;
    var regFee = Number(pricing.registrationFee) || 0;
    uniqueCampersInSelection().forEach(function (cid) {
      if (pricing.perCamperNeedsReg && pricing.perCamperNeedsReg[cid]) reg += regFee;
    });
    var total = campSub + reg;
    el.textContent =
      n === 0
        ? '$0.00 estimated (pick weeks below)'
        : '$' +
          total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) +
          ' estimated (camp ' +
          n +
          ' week' +
          (n === 1 ? '' : 's') +
          (reg > 0 ? ' + registration' : '') +
          '; final total at checkout)';
  }

  function renderGrid() {
    var mount = document.getElementById('cc-weeks-mount');
    if (!mount) return;
    mount.innerHTML = '';
    if (!weeksPayload.length) {
      mount.textContent = 'No camp weeks available.';
      return;
    }
    var grid = document.createElement('div');
    grid.className = 'cc-week-grid';
    weeksPayload.forEach(function (w) {
      if (w.is_no_camp) return;
      var wk = String(w.id);
      var full = !!(w.disabled || w.is_full);
      var card = document.createElement('div');
      card.className = 'cc-week-card' + (full ? ' cc-week-card--full' : '');
      var h = document.createElement('div');
      h.className = 'cc-week-card-head';
      h.innerHTML =
        '<div class="cc-week-title">' +
        escapeHtml(String(w.label || 'Week')) +
        '</div>' +
        (full ? '<span class="cc-sold-out">Sold out</span>' : '');
      card.appendChild(h);
      var kids = document.createElement('div');
      kids.className = 'cc-kids';
      campers.forEach(function (c) {
        var cid = String(c.id);
        var row = document.createElement('label');
        row.className = 'cc-kid-row';
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = isCamperSelectedForWeek(wk, cid);
        cb.disabled = full && !cb.checked;
        cb.addEventListener('change', function () {
          if (full && !cb.checked) return;
          if (full && cb.checked && !isCamperSelectedForWeek(wk, cid)) {
            cb.checked = false;
            return;
          }
          toggleCamperWeek(wk, cid, cb.checked);
        });
        var sp = document.createElement('span');
        sp.textContent = (c.first_name || '') + ' ' + (c.last_name || '');
        row.appendChild(cb);
        row.appendChild(sp);
        kids.appendChild(row);
      });
      card.appendChild(kids);
      var wrLine = Number(pricing.weekRate) || 0;
      var priceEl = document.createElement('div');
      priceEl.className = 'cc-week-price';
      priceEl.textContent =
        '$' +
        wrLine.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) +
        '/week · Mon–Fri';
      card.appendChild(priceEl);
      var hoursEl = document.createElement('div');
      hoursEl.className = 'cc-week-hours';
      hoursEl.textContent = CAMP_SCHEDULE_HOURS_LINE;
      card.appendChild(hoursEl);
      grid.appendChild(card);
    });
    mount.appendChild(grid);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function seedFromEnrollments(rows) {
    var seeded = {};
    (rows || []).forEach(function (row) {
      if (!isManageableCardRow(row)) return;
      var w = weekById(row.week_id);
      if (!w || !rowCoversFullWeek(row, w)) return;
      var wid = String(row.week_id);
      var cid = String(row.camper_id);
      if (!seeded[wid]) seeded[wid] = [];
      if (seeded[wid].indexOf(cid) === -1) seeded[wid].push(cid);
    });
    return seeded;
  }

  async function loadPricingOnce() {
    var ids = campers.map(function (c) {
      return String(c.id);
    });
    if (!ids.length) return;
    var params = new URLSearchParams();
    params.set('camperIds', ids.join(','));
    params.set('paymentMethod', 'credit_card');
    if (pricing.test) params.set('test', 'true');
    var res = await noStoreFetch('/api/preview-pricing?' + params.toString(), {
      headers: accessToken ? { Authorization: 'Bearer ' + accessToken } : {},
    });
    if (!res.ok) return;
    var j = await res.json();
    if (j.weekRate != null) pricing.weekRate = j.weekRate;
    if (j.registrationFee != null) pricing.registrationFee = j.registrationFee;
    pricing.perCamperNeedsReg = j.perCamperNeedsReg || {};
  }

  async function boot() {
    var errEl = document.getElementById('cc-msg');
    try {
      await IMA.getSupabase();
      session = await IMA.getSession();
      if (!session || !session.user) {
        location.replace('/login.html?return=' + encodeURIComponent('/cc-portal.html'));
        return;
      }
      if (typeof IMA.refreshSessionForApi === 'function') {
        try {
          var ref = await IMA.refreshSessionForApi();
          if (ref && ref.session) session = ref.session;
        } catch (eR) {}
      }
      accessToken = session.access_token || '';
      var sb = await IMA.getSupabase();
      var uid = session.user.id;
      var { data: campRows, error: cErr } = await sb
        .from('campers')
        .select('id,first_name,last_name')
        .eq('parent_id', uid);
      if (cErr) throw cErr;
      campers = campRows || [];
      if (!campers.length) {
        if (errEl) {
          errEl.className = 'cc-msg cc-msg--err';
          errEl.textContent = 'Add a child on My kids first, then return here.';
        }
        document.getElementById('cc-proceed') && (document.getElementById('cc-proceed').disabled = true);
        document.getElementById('cc-loading') && (document.getElementById('cc-loading').hidden = true);
        document.getElementById('cc-main') && (document.getElementById('cc-main').hidden = false);
        return;
      }

      var wRes = await noStoreFetch('/api/weeks');
      if (!wRes.ok) throw new Error('Could not load weeks');
      var wJ = await wRes.json();
      weeksPayload = wJ.weeks || [];

      var stored = loadSelectedFromStorage();
      if (stored) {
        selectedWeeks = stored;
      } else {
        var enrRes = await noStoreFetch('/api/enrollments', {
          headers: { Authorization: 'Bearer ' + accessToken },
        });
        if (!enrRes.ok) throw new Error('Could not load enrollments');
        var enrJ = await enrRes.json();
        selectedWeeks = seedFromEnrollments(enrJ.enrollments || []);
        saveSelectedToStorage();
      }

      var urlTest = new URLSearchParams(location.search).get('test') === 'true';
      try {
        if (!urlTest && localStorage.getItem('ima_stripe_test_ui') === '1') urlTest = true;
      } catch (eT) {}
      pricing.test = urlTest;

      await loadPricingOnce();
      renderGrid();
      renderTotal();
      document.getElementById('cc-loading') && (document.getElementById('cc-loading').hidden = true);
      document.getElementById('cc-main') && (document.getElementById('cc-main').hidden = false);
    } catch (e) {
      if (errEl) {
        errEl.className = 'cc-msg cc-msg--err';
        errEl.textContent = (e && e.message) || 'Could not load portal.';
      }
      document.getElementById('cc-loading') && (document.getElementById('cc-loading').hidden = true);
      document.getElementById('cc-main') && (document.getElementById('cc-main').hidden = false);
    }
  }

  document.getElementById('cc-proceed') &&
    document.getElementById('cc-proceed').addEventListener('click', async function () {
      var btn = document.getElementById('cc-proceed');
      var errEl = document.getElementById('cc-msg');
      if (!session || !accessToken) return;
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Saving…';
      }
      if (errEl) {
        errEl.className = 'cc-msg';
        errEl.textContent = '';
      }
      try {
        var commitBody = {
          selectedWeeks: selectedWeeks,
          paymentMethod: 'credit_card',
          testPricing: pricing.test,
        };
        console.log('[IMA cc-portal] POST /api/cc-portal-commit-weeks', commitBody);
        var res = await noStoreFetch('/api/cc-portal-commit-weeks', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + accessToken,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(commitBody),
        });
        var j = await res.json().catch(function () {
          return {};
        });
        console.log('[IMA cc-portal] response', res.status, j);
        if (!res.ok) {
          if (errEl) {
            errEl.className = 'cc-msg cc-msg--err';
            errEl.textContent = j.error || 'Could not save selections. Try again.';
          }
          if (btn) {
            btn.disabled = false;
            btn.textContent = 'Proceed to checkout';
          }
          return;
        }
        clearStorage();
        var id = encodeURIComponent(session.user.id);
        location.href = '/index.html?parent_id=' + id + '&paymentPortal=credit_card#schedule';
      } catch (e) {
        if (errEl) {
          errEl.className = 'cc-msg cc-msg--err';
          errEl.textContent = (e && e.message) || 'Network error.';
        }
        if (btn) {
          btn.disabled = false;
          btn.textContent = 'Proceed to checkout';
        }
      }
    });

  document.getElementById('cc-switch') &&
    document.getElementById('cc-switch').addEventListener('click', function (ev) {
      ev.preventDefault();
      location.href = '/portal-landing.html';
    });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
