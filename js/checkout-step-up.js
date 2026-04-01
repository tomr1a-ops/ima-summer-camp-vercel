/**
 * Standalone Step Up camp hold (no Stripe).
 * POST /api/create-checkout-session with paymentMethod step_up; redirect to success.html?step_up_hold=1.
 */
(function () {
  var CAMP_AGREEMENT_VERSION = '2.0';
  var CAMP_AGREEMENT_ACCEPT_SS = 'ima_camp_agreement_accepted_v2';
  var CAMP_AGREEMENT_SCROLL_SS = 'ima_camp_agreement_scrolled_v2';
  var ENROLL_SS = 'ima_reg_enroll_v1';
  var IMA_MEMBER_PREF_SS = 'ima_ima_member_pref_v1';
  var LS_STRIPE_TEST_UI = 'ima_stripe_test_ui';
  var API_CHECKOUT = '/api/create-checkout-session';

  var qs = new URLSearchParams(window.location.search);
  var session = null;
  var weeksPayload = [];
  var parentCampers = [];
  var confirmedEnrollmentsCache = [];
  var enrollmentType = 'full';
  var fullWeekCampersByWeek = {};
  var dailyPerDayCampers = {};
  var regFeeIncludeByCamper = {};
  var extraShirtByCamper = {};
  var parentProfileWaiverSigned = false;
  var pricingPreview = {
    dayRate: 85,
    weekRate: 375,
    registrationFee: 65,
    extraCampShirt: 20,
    perCamperNeedsReg: {},
    perCamperExtraShirtPaid: {},
  };
  var testPriceMode = false;
  var serverPrepaidApply = null;
  var checkoutSessionInFlight = false;
  var lastSummaryGrandDollars = 0;
  var IMA_STEP_UP_HOLD_TOTALS_SS = 'ima_step_up_hold_totals';
  var waitlistMineByKey = {};
  var fullWeekQty = {};
  var dailyKidsByWeek = {};
  var campAgreementScrollUnlocked = false;
  var campAgreementTextPromise = null;

  var host = String(location.hostname || '');
  var isLocalHost =
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host.endsWith('.local') ||
    host.startsWith('192.168.') ||
    host.startsWith('10.');
  var urlTest =
    qs.get('test') === 'true' ||
    qs.get('stripe_test') === '1' ||
    isLocalHost;
  try {
    if (!urlTest && localStorage.getItem(LS_STRIPE_TEST_UI) === '1') urlTest = true;
  } catch (e) {}
  if (qs.get('test') === 'true' || qs.get('stripe_test') === '1') {
    try {
      localStorage.setItem(LS_STRIPE_TEST_UI, '1');
    } catch (e2) {}
  }
  testPriceMode = urlTest;

  function imaNoStoreFetch(url, init) {
    init = init || {};
    var sep = url.indexOf('?') >= 0 ? '&' : '?';
    var busted = url + sep + '_nc=' + Date.now();
    var h = Object.assign({}, init.headers || {});
    h['Cache-Control'] = 'no-cache';
    h['Pragma'] = 'no-cache';
    return fetch(busted, Object.assign({ cache: 'no-store', credentials: 'same-origin' }, init, { headers: h }));
  }

  async function freshAccessTokenForApi(opts) {
    if (!session) return null;
    try {
      if (typeof IMA !== 'undefined' && IMA.refreshSessionForApi) {
        var ref = await IMA.refreshSessionForApi(opts || {});
        if (ref && ref.accessToken) {
          if (ref.session) session = ref.session;
          return ref.accessToken;
        }
      }
    } catch (e) {}
    return session && session.access_token ? session.access_token : null;
  }

  function enrollUserId() {
    if (!session || !session.user) return null;
    var u = session.user;
    var id = u.id != null && String(u.id).trim() !== '' ? String(u.id).trim() : '';
    if (!id && u.sub != null) id = String(u.sub).trim();
    return id || null;
  }

  function enrollStorageKey() {
    var uid = enrollUserId();
    return uid ? ENROLL_SS + ':' + uid : null;
  }

  function pickEnrollRaw(sk) {
    var rS = null;
    var rL = null;
    try {
      rS = sessionStorage.getItem(sk);
    } catch (e) {}
    try {
      rL = localStorage.getItem(sk);
    } catch (e2) {}
    if (!rS) return rL;
    if (!rL) return rS;
    try {
      var o1 = JSON.parse(rS);
      var o2 = JSON.parse(rL);
      var t1 = Number(o1.updatedAt) || 0;
      var t2 = Number(o2.updatedAt) || 0;
      if (t2 > t1) return rL;
      if (t1 > t2) return rS;
    } catch (eP) {}
    return rL || rS;
  }

  function imaMemberPrefStorageKey() {
    var uid = enrollUserId();
    return uid ? IMA_MEMBER_PREF_SS + ':' + uid : null;
  }

  function pickImaMemberPrefRaw(sk) {
    var rS = null;
    var rL = null;
    try {
      rS = sessionStorage.getItem(sk);
    } catch (e) {}
    try {
      rL = localStorage.getItem(sk);
    } catch (e2) {}
    if (!rS) return rL;
    if (!rL) return rS;
    try {
      var o1 = JSON.parse(rS);
      var o2 = JSON.parse(rL);
      var t1 = Number(o1.updatedAt) || 0;
      var t2 = Number(o2.updatedAt) || 0;
      return t2 > t1 ? rL : rS;
    } catch (eP) {}
    return rS;
  }

  function readImaMemberPrefs() {
    var sk = imaMemberPrefStorageKey();
    if (!sk) return {};
    var raw = pickImaMemberPrefRaw(sk);
    if (!raw) return {};
    try {
      var o = JSON.parse(raw);
      if (o && o.byCamper && typeof o.byCamper === 'object') return o.byCamper;
    } catch (eJ) {}
    return {};
  }

  function writeImaMemberPref(camperId, memberChecked) {
    var sk = imaMemberPrefStorageKey();
    if (!sk) return;
    var cid = String(camperId);
    var all = readImaMemberPrefs();
    all[cid] = !!memberChecked;
    var payload = JSON.stringify({ byCamper: all, updatedAt: Date.now() });
    try {
      sessionStorage.setItem(sk, payload);
    } catch (e1) {}
    try {
      localStorage.setItem(sk, payload);
    } catch (e2) {}
  }

  function dayRateClient() {
    return testPriceMode ? 1 : 85;
  }
  function weekRateClient() {
    return testPriceMode ? 1 : 375;
  }
  function regFeeClient() {
    return testPriceMode ? 1 : 65;
  }
  function extraShirtClient() {
    return testPriceMode ? 1 : 20;
  }

  function applyPricingFromServer(j) {
    serverPrepaidApply = null;
    var dr = j && j.dayRate != null ? Number(j.dayRate) : dayRateClient();
    var wr = j && j.weekRate != null ? Number(j.weekRate) : weekRateClient();
    var rf = j && j.registrationFee != null ? Number(j.registrationFee) : regFeeClient();
    var xs = j && j.extraCampShirt != null ? Number(j.extraCampShirt) : extraShirtClient();
    var pcr = {};
    if (j && j.perCamperNeedsReg && typeof j.perCamperNeedsReg === 'object') {
      Object.keys(j.perCamperNeedsReg).forEach(function (k) {
        pcr[String(k)] = j.perCamperNeedsReg[k];
      });
    }
    var pes = {};
    if (j && j.perCamperExtraShirtPaid && typeof j.perCamperExtraShirtPaid === 'object') {
      Object.keys(j.perCamperExtraShirtPaid).forEach(function (k) {
        pes[String(k)] = !!j.perCamperExtraShirtPaid[k];
      });
    }
    pricingPreview = {
      dayRate: dr,
      weekRate: wr,
      registrationFee: rf,
      extraCampShirt: xs,
      perCamperNeedsReg: pcr,
      perCamperExtraShirtPaid: pes,
    };
    if (j && j.perCamperNeedsReg && typeof j.perCamperNeedsReg === 'object') {
      Object.keys(pcr).forEach(function (rk) {
        if (pcr[rk] === false) regFeeIncludeByCamper[String(rk)] = false;
      });
    }
    applyImaMemberPrefsToRegFeeMap();
  }

  function applyImaMemberPrefsToRegFeeMap() {
    if (!session || !parentCampers.length) return;
    var prefs = readImaMemberPrefs();
    parentCampers.forEach(function (c) {
      var ck = String(c.id);
      if (prefs[ck] !== true && prefs[ck] !== false) return;
      if (registrationAlreadyPaidPerPreview(c.id)) return;
      regFeeIncludeByCamper[ck] = prefs[ck] ? false : true;
    });
  }

  function defaultRegFeeIncludeForCamper(cid) {
    var m = pricingPreview.perCamperNeedsReg;
    var k = String(cid);
    if (m && m[k] === false) return false;
    if (m && m[cid] === false) return false;
    var c = parentCampers.find(function (x) {
      return String(x.id) === k || x.id === cid;
    });
    if (c && c.registration_fee_paid === true) return false;
    return true;
  }

  function registrationAlreadyPaidPerPreview(cid) {
    var k = String(cid);
    var m = pricingPreview.perCamperNeedsReg;
    if (m && typeof m === 'object' && (m[k] === false || m[cid] === false)) return true;
    var c = parentCampers.find(function (x) {
      return String(x.id) === k || x.id === cid;
    });
    return !!(c && c.registration_fee_paid === true);
  }

  function getRegFeeInclude(cid) {
    var k = String(cid);
    if (registrationAlreadyPaidPerPreview(cid)) return false;
    if (regFeeIncludeByCamper[k] === undefined && regFeeIncludeByCamper[cid] === undefined) {
      return defaultRegFeeIncludeForCamper(k);
    }
    if (regFeeIncludeByCamper[k] !== undefined) return !!regFeeIncludeByCamper[k];
    return !!regFeeIncludeByCamper[cid];
  }

  function registrationFeeAppliesToCamper(cid) {
    return getRegFeeInclude(cid);
  }

  function extraShirtAddonAlreadyPaid(cid) {
    var k = String(cid);
    var m = pricingPreview.perCamperExtraShirtPaid;
    if (m && typeof m === 'object' && !!(m[k] || m[cid])) return true;
    var c = parentCampers.find(function (x) {
      return String(x.id) === k || x.id === cid;
    });
    return !!(c && c.extra_shirt_addon_paid === true);
  }

  function extraShirtChargesThisCheckout(cid) {
    var ck = String(cid);
    if (!(extraShirtByCamper[ck] || extraShirtByCamper[cid])) return false;
    return !extraShirtAddonAlreadyPaid(cid);
  }

  function fmt(n) {
    return '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function maxCap(w) {
    var n = Number(w.max_capacity);
    return n > 0 ? n : 35;
  }

  function draftExtraHeadcountForDay(weekId, dayId) {
    if (!session) return 0;
    var wk = String(weekId);
    var dk = String(dayId);
    var adding = new Set();
    if (enrollmentType === 'full') {
      var fw = fullWeekCampersByWeek[wk];
      if (fw) {
        fw.forEach(function (cid) {
          if (camperWeekHasConfirmedFullWeek(weekId, cid)) return;
          var covered = daysCoveredByConfirmedForCamperWeek(weekId, cid);
          if (!covered.has(dk)) adding.add(String(cid));
        });
      }
    } else {
      var inner = dailyPerDayCampers[wk];
      if (inner) {
        var daySet = inner[dk];
        if (daySet && daySet.size) {
          daySet.forEach(function (cid) {
            var fw = fullWeekCampersByWeek[wk];
            if (fw && fw.has(String(cid))) return;
            var covered = daysCoveredByConfirmedForCamperWeek(weekId, cid);
            if (!covered.has(dk)) adding.add(String(cid));
          });
        }
      }
    }
    return adding.size;
  }

  function normalizeWeekCapacityFromDays(w) {
    if (!w) return;
    var cap = maxCap(w);
    (w.days || []).forEach(function (d) {
      var mc = Number(d.max_capacity) > 0 ? Number(d.max_capacity) : cap;
      var serverEnr = d._imaServerEnr != null ? Number(d._imaServerEnr) || 0 : Number(d.current_enrollment) || 0;
      var draftExtra = draftExtraHeadcountForDay(w.id, d.id);
      var cur = serverEnr + draftExtra;
      d.max_capacity = mc;
      d.at_capacity = cur >= mc;
      d.slots_left = Math.max(0, mc - cur);
    });
    var numericFull = (w.days || []).some(function (d) {
      return !!d.at_capacity;
    });
    var inactive = w.is_active === false;
    var noCamp = w.is_no_camp === true;
    var dbFull = !!w._imaDbFull;
    w.is_full = !!(numericFull || dbFull);
    w.disabled = !!(w.is_full || inactive || noCamp);
  }

  function formatDayLabel(d) {
    var p = String(d.date).split('-');
    var dt = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }

  function formatWeekRangeForSummary(w) {
    if (!w || !w.start_date || !w.end_date) return '';
    var a = String(w.start_date).split('-');
    var b = String(w.end_date).split('-');
    var d0 = new Date(Number(a[0]), Number(a[1]) - 1, Number(a[2]));
    var d1 = new Date(Number(b[0]), Number(b[1]) - 1, Number(b[2]));
    var m0 = d0.toLocaleDateString('en-US', { month: 'long' });
    var m1 = d1.toLocaleDateString('en-US', { month: 'long' });
    var day0 = d0.getDate();
    var day1 = d1.getDate();
    if (m0 === m1) return m0 + ' ' + day0 + '–' + day1;
    return m0 + ' ' + day0 + ' – ' + m1 + ' ' + day1;
  }

  function getCamperNameById(id) {
    if (!id) return '';
    var want = String(id);
    var c = parentCampers.find(function (x) {
      return String(x.id) === want;
    });
    return c ? (c.first_name + ' ' + c.last_name).trim() : '';
  }

  function ensureDailyPerDayMapMain(wk) {
    var k = String(wk);
    if (!dailyPerDayCampers[k]) dailyPerDayCampers[k] = {};
    return dailyPerDayCampers[k];
  }

  function getDayCamperSetMain(wk, dayId) {
    var inner = dailyPerDayCampers[String(wk)];
    if (!inner) return null;
    return inner[String(dayId)] || null;
  }

  function pruneEmptyDailyWeekMain(wk) {
    var k = String(wk);
    var inner = dailyPerDayCampers[k];
    if (!inner) return;
    Object.keys(inner).forEach(function (dk) {
      if (!inner[dk] || !inner[dk].size) delete inner[dk];
    });
    if (!Object.keys(inner).length) delete dailyPerDayCampers[k];
  }

  function enrollmentCoversFullWeek(row, w) {
    if (!w || !(w.days && w.days.length === 5)) return false;
    var ids = (row.day_ids || []).map(String);
    var weekDayIds = (w.days || []).map(function (d) {
      return String(d.id);
    });
    return (
      ids.length === 5 &&
      weekDayIds.every(function (id) {
        return ids.indexOf(id) !== -1;
      })
    );
  }

  function enrollmentRowQualifiesForCampCredit(row) {
    if (!row || row.status !== 'confirmed') return false;
    if (row.stripe_session_id != null && String(row.stripe_session_id).trim() !== '') return true;
    var pp = Number(row.price_paid);
    if (Number.isFinite(pp) && pp > 0) return true;
    if (row.checkout_batch_id != null && String(row.checkout_batch_id).trim() !== '') return true;
    return false;
  }

  function paidEnrollmentMatchesPicker(row, cid) {
    var w = weeksPayload.find(function (x) {
      return String(x.id) === String(row.week_id);
    });
    if (!w) return false;
    var wk = String(w.id);
    var camperId = String(cid);
    var onFullWeek = !!(fullWeekCampersByWeek[wk] && fullWeekCampersByWeek[wk].has(camperId));
    if (enrollmentCoversFullWeek(row, w)) {
      return onFullWeek;
    }
    if (onFullWeek) return true;
    var dayIds = (row.day_ids || []).map(String).filter(Boolean);
    if (!dayIds.length) return false;
    return dayIds.every(function (did) {
      var s = getDayCamperSetMain(wk, did);
      return s && s.has(camperId);
    });
  }

  function normCamperKeyForPrepaidApi(id) {
    return String(id || '')
      .trim()
      .toLowerCase();
  }

  function prepaidCoverageKeysForApi() {
    var out = [];
    if (!session || !parentCampers.length) return out;
    parentCampers.forEach(function (c) {
      var cid = String(c.id);
      confirmedEnrollmentsCache.forEach(function (row) {
        if (!row || row.status !== 'confirmed') return;
        if (!enrollmentRowQualifiesForCampCredit(row)) return;
        if (String(row.camper_id) !== cid) return;
        if (paidEnrollmentMatchesPicker(row, cid)) {
          out.push(normCamperKeyForPrepaidApi(cid) + '|' + String(row.week_id));
        }
      });
    });
    return out;
  }

  function daysCoveredByConfirmedForCamperWeek(weekId, camperId) {
    var covered = new Set();
    var w = weeksPayload.find(function (x) {
      return String(x.id) === String(weekId);
    });
    if (!w) return covered;
    confirmedEnrollmentsCache.forEach(function (row) {
      if (String(row.camper_id) !== String(camperId)) return;
      if (String(row.week_id) !== String(weekId)) return;
      if (row.status !== 'confirmed' && row.status !== 'pending_step_up') return;
      if (enrollmentCoversFullWeek(row, w)) {
        (w.days || []).forEach(function (d) {
          covered.add(String(d.id));
        });
      } else {
        (row.day_ids || []).forEach(function (id) {
          covered.add(String(id));
        });
      }
    });
    return covered;
  }

  function camperWeekHasConfirmedFullWeek(weekId, camperId) {
    var w = weeksPayload.find(function (x) {
      return String(x.id) === String(weekId);
    });
    if (!w) return false;
    return confirmedEnrollmentsCache.some(function (row) {
      if (String(row.camper_id) !== String(camperId)) return false;
      if (String(row.week_id) !== String(weekId)) return false;
      return enrollmentCoversFullWeek(row, w);
    });
  }

  function camperHasConfirmedEnrollmentInWeek(weekId, camperId) {
    return (
      camperWeekHasConfirmedFullWeek(weekId, camperId) ||
      daysCoveredByConfirmedForCamperWeek(weekId, camperId).size > 0
    );
  }

  function formatBookedConflictDayPhrase(d) {
    if (!d || !d.date) return 'a day';
    var p = String(d.date).split('-');
    var dt = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    if (Number.isNaN(dt.getTime())) return 'a day';
    var wd = dt.toLocaleDateString('en-US', { weekday: 'long' });
    var md = dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return (wd + ' ' + md).replace(/,\s*/g, ' ').trim();
  }

  function firstPaidDayObjForFullWeekConflict(weekId, camperId) {
    if (camperWeekHasConfirmedFullWeek(weekId, camperId)) return null;
    var covered = daysCoveredByConfirmedForCamperWeek(weekId, camperId);
    if (!covered.size) return null;
    var w = weeksPayload.find(function (x) {
      return String(x.id) === String(weekId);
    });
    if (!w || !(w.days || []).length) return null;
    var ordered = (w.days || []).slice().sort(function (a, b) {
      return String(a.date).localeCompare(String(b.date));
    });
    for (var i = 0; i < ordered.length; i++) {
      if (covered.has(String(ordered[i].id))) return ordered[i];
    }
    return null;
  }

  function fullWeekPaidDayConflictMessage(weekId, camperId) {
    var dayObj = firstPaidDayObjForFullWeekConflict(weekId, camperId);
    if (!dayObj) return '';
    var c = parentCampers.find(function (x) {
      return String(x.id) === String(camperId);
    });
    var first = c && c.first_name ? String(c.first_name).trim() : '';
    var phrase = formatBookedConflictDayPhrase(dayObj);
    return (
      (first || 'This child') +
      ' already has ' +
      phrase +
      ' booked. Remove that day or choose individual days instead.'
    );
  }

  function getFullWeekPaidDayConflictMessages() {
    var out = [];
    if (!session) return out;
    weeksPayload.forEach(function (w) {
      var wk = String(w.id);
      var fw = fullWeekCampersByWeek[wk];
      if (!fw || !fw.size) return;
      fw.forEach(function (cid) {
        var m = fullWeekPaidDayConflictMessage(w.id, cid);
        if (m) out.push(m);
      });
    });
    return out;
  }

  function pruneConflictingFullWeekSelections() {
    if (!session) return;
    var changed = false;
    weeksPayload.forEach(function (w) {
      var wk = String(w.id);
      var fw = fullWeekCampersByWeek[wk];
      if (!fw || !fw.size) return;
      Array.from(fw).forEach(function (cid) {
        if (fullWeekPaidDayConflictMessage(w.id, cid)) {
          fw.delete(cid);
          changed = true;
        }
      });
      if (!fw.size) delete fullWeekCampersByWeek[wk];
    });
  }

  function pruneFullWeekCampersUnknownToParent() {
    if (!session || !parentCampers.length) return;
    var allow = {};
    parentCampers.forEach(function (c) {
      allow[String(c.id)] = true;
    });
    Object.keys(fullWeekCampersByWeek).forEach(function (wk) {
      var fw = fullWeekCampersByWeek[wk];
      if (!fw || !fw.size) return;
      Array.from(fw).forEach(function (cid) {
        if (!allow[String(cid)]) fw.delete(cid);
      });
      if (!fw.size) delete fullWeekCampersByWeek[wk];
    });
  }

  function dedupeConfirmedEnrollmentsForDisplay(rows) {
    var map = {};
    (rows || []).forEach(function (r) {
      if (!r || !r.camper_id || !r.week_id) return;
      var dayKey = (r.day_ids || [])
        .map(String)
        .filter(Boolean)
        .sort()
        .join(',');
      var key = String(r.camper_id) + '|' + String(r.week_id) + '|' + dayKey;
      var t = r.created_at ? new Date(r.created_at).getTime() : 0;
      var prev = map[key];
      if (!prev || t >= prev.t) map[key] = { row: r, t: t };
    });
    return Object.keys(map)
      .map(function (k) {
        return map[k].row;
      })
      .sort(function (a, b) {
        var wa = weeksPayload.find(function (w) {
          return String(w.id) === String(a.week_id);
        });
        var wb = weeksPayload.find(function (w) {
          return String(w.id) === String(b.week_id);
        });
        var cmp = (Number(wa && wa.week_number) || 0) - (Number(wb && wb.week_number) || 0);
        if (cmp !== 0) return cmp;
        return String(a.camper_id).localeCompare(String(b.camper_id));
      });
  }

  async function refreshEnrollments() {
    if (!session) {
      confirmedEnrollmentsCache = [];
      return;
    }
    try {
      var tok = await freshAccessTokenForApi();
      if (!tok) return;
      var res = await imaNoStoreFetch('/api/enrollments', {
        headers: { Authorization: 'Bearer ' + tok },
      });
      if (res.status === 401) {
        tok = await freshAccessTokenForApi({ force: true });
        if (!tok) return;
        res = await imaNoStoreFetch('/api/enrollments', {
          headers: { Authorization: 'Bearer ' + tok },
        });
      }
      if (!res.ok) return;
      var j = await res.json();
      var rows = j.enrollments || [];
      var confirmed = rows.filter(function (r) {
        return r && (r.status === 'confirmed' || r.status === 'pending_step_up');
      });
      confirmedEnrollmentsCache = dedupeConfirmedEnrollmentsForDisplay(confirmed);
    } catch (e) {}
  }

  async function loadWaitlistMine() {
    waitlistMineByKey = {};
    if (!session) return;
    try {
      var tok = await freshAccessTokenForApi();
      if (!tok) return;
      var res = await imaNoStoreFetch('/api/waitlist', { headers: { Authorization: 'Bearer ' + tok } });
      if (!res.ok) return;
      var j = await res.json();
      (j.entries || []).forEach(function (e) {
        if (!e || e.camper_id == null || e.week_id == null) return;
        waitlistMineByKey[String(e.camper_id) + '|' + String(e.week_id)] = e;
      });
    } catch (eWl) {}
  }

  function waitlistOfferIdForCheckout(camperId, weekId) {
    var e = waitlistMineByKey[String(camperId) + '|' + String(weekId)];
    if (!e || e.status !== 'offered') return null;
    if (e.expires_at && new Date(e.expires_at) <= new Date()) return null;
    return e.id;
  }

  function collectBookings() {
    var out = [];
    var fullWeekKey = new Set();
    if (!session) return out;
    weeksPayload.forEach(function (w) {
      var ids = (w.days || []).map(function (d) {
        return d.id;
      });
      if (ids.length !== 5) return;
      var cset = fullWeekCampersByWeek[String(w.id)];
      if (!cset || !cset.size) return;
      cset.forEach(function (cid) {
        if (camperWeekHasConfirmedFullWeek(w.id, cid)) return;
        if (daysCoveredByConfirmedForCamperWeek(w.id, cid).size > 0) return;
        var k = String(cid) + ':' + String(w.id);
        fullWeekKey.add(k);
        // Standalone checkout: always bill full-week checkboxes when present. On index, only the active
        // tab contributes lines so Daily view does not surprise-charge hidden weekly picks; here we
        // restore both structures from storage — if enrollmentType stayed "daily" but full-week boxes
        // are still checked, those weeks must still appear (fixes shirt-only Step Up after tab switch).
        var lineFw = { weekId: w.id, dayIds: ids, pricingMode: 'full_week', camperId: cid };
        var wlIdFw = waitlistOfferIdForCheckout(cid, w.id);
        if (wlIdFw) lineFw.waitlistEntryId = wlIdFw;
        out.push(lineFw);
      });
    });
    if (enrollmentType !== 'daily') return out;
    weeksPayload.forEach(function (w) {
      var wk = String(w.id);
      var inner = dailyPerDayCampers[wk];
      if (!inner) return;
      var camperIds = new Set();
      Object.keys(inner).forEach(function (dk) {
        var s = inner[dk];
        if (!s || !s.size) return;
        s.forEach(function (cid) {
          camperIds.add(String(cid));
        });
      });
      camperIds.forEach(function (cid) {
        var ck = String(cid) + ':' + wk;
        if (fullWeekKey.has(ck)) return;
        var covered = daysCoveredByConfirmedForCamperWeek(w.id, cid);
        var newDayIds = [];
        Object.keys(inner).forEach(function (dk) {
          var s = inner[dk];
          if (!s || !s.has(cid)) return;
          if (covered.has(String(dk))) return;
          newDayIds.push(dk);
        });
        if (!newDayIds.length) return;
        var dayObjs = (w.days || []).filter(function (d) {
          return newDayIds.indexOf(String(d.id)) !== -1;
        });
        dayObjs.sort(function (a, b) {
          return String(a.date).localeCompare(String(b.date));
        });
        var orderedIds = dayObjs.map(function (d) {
          return d.id;
        });
        var lineD = { weekId: w.id, dayIds: orderedIds, pricingMode: 'daily', camperId: cid };
        var wlIdD = waitlistOfferIdForCheckout(cid, w.id);
        if (wlIdD) lineD.waitlistEntryId = wlIdD;
        out.push(lineD);
      });
    });
    return out;
  }

  function collectDraftCamperWeekKeysUnion() {
    var keys = new Set();
    if (!session) return keys;
    var fullWeekKey = new Set();
    weeksPayload.forEach(function (w) {
      var ids = (w.days || []).map(function (d) {
        return d.id;
      });
      if (ids.length !== 5) return;
      var cset = fullWeekCampersByWeek[String(w.id)];
      if (!cset || !cset.size) return;
      cset.forEach(function (cid) {
        if (camperWeekHasConfirmedFullWeek(w.id, cid)) return;
        if (daysCoveredByConfirmedForCamperWeek(w.id, cid).size > 0) return;
        var ck = String(cid) + ':' + String(w.id);
        fullWeekKey.add(ck);
        keys.add(String(cid) + '|' + String(w.id));
      });
    });
    weeksPayload.forEach(function (w) {
      var wk = String(w.id);
      var inner = dailyPerDayCampers[wk];
      if (!inner) return;
      var camperIds = new Set();
      Object.keys(inner).forEach(function (dk) {
        var s = inner[dk];
        if (!s || !s.size) return;
        s.forEach(function (cid) {
          camperIds.add(String(cid));
        });
      });
      camperIds.forEach(function (cid) {
        if (fullWeekKey.has(String(cid) + ':' + wk)) return;
        var covered = daysCoveredByConfirmedForCamperWeek(w.id, cid);
        var hasNew = false;
        Object.keys(inner).forEach(function (dk) {
          var s = inner[dk];
          if (!s || !s.has(cid)) return;
          if (covered.has(String(dk))) return;
          hasNew = true;
        });
        if (hasNew) keys.add(String(cid) + '|' + wk);
      });
    });
    return keys;
  }

  function hasShirtCheckoutSelection() {
    return (
      session &&
      parentCampers.length &&
      parentCampers.some(function (c) {
        return extraShirtChargesThisCheckout(c.id);
      })
    );
  }

  function sortBookingsStable(bookings) {
    return bookings.slice().sort(function (a, b) {
      var wa = weeksPayload.find(function (x) {
        return String(x.id) === String(a.weekId);
      });
      var wb = weeksPayload.find(function (x) {
        return String(x.id) === String(b.weekId);
      });
      var na = Number(wa && wa.week_number) || 0;
      var nb = Number(wb && wb.week_number) || 0;
      if (na !== nb) return na - nb;
      return String(a.camperId).localeCompare(String(b.camperId));
    });
  }

  function bookingsAlignWithServerPrepaid(bookings, srv) {
    if (!srv || !Array.isArray(srv.lines) || !srv.lines.length) return false;
    var sorted = sortBookingsStable(bookings.slice());
    if (sorted.length !== srv.lines.length) return false;
    for (var i = 0; i < sorted.length; i++) {
      var a = sorted[i];
      var L = srv.lines[i];
      if (String(a.weekId) !== String(L.weekId)) return false;
      if (normCamperKeyForPrepaidApi(a.camperId) !== String(L.camperId || '').trim().toLowerCase()) return false;
      if (String(a.pricingMode || 'daily') !== String(L.pricingMode || 'daily')) return false;
    }
    return true;
  }

  function restoreEnrollFromStorage() {
    if (!session) return;
    var sk = enrollStorageKey();
    if (!sk) return;
    var raw = pickEnrollRaw(sk);
    if (!raw) {
      try {
        var legacy = sessionStorage.getItem(ENROLL_SS);
        if (legacy) {
          sessionStorage.setItem(sk, legacy);
          sessionStorage.removeItem(ENROLL_SS);
          raw = legacy;
        }
      } catch (eL) {}
    }
    if (!raw) return;
    try {
      var o = JSON.parse(raw);
      if (o.fwComplete && weeksPayload && weeksPayload.length) {
        weeksPayload.forEach(function (w) {
          var k = String(w.id);
          var rawArr = o.fw && o.fw[k];
          var arr = Array.isArray(rawArr) ? rawArr : [];
          if (arr.length) fullWeekCampersByWeek[k] = new Set(arr.map(String));
          else delete fullWeekCampersByWeek[k];
        });
      } else {
        Object.keys(o.fw || {}).forEach(function (wid) {
          var k = String(wid);
          var arr = o.fw[wid];
          if (arr && arr.length) fullWeekCampersByWeek[k] = new Set(arr.map(String));
          else delete fullWeekCampersByWeek[k];
        });
      }
      var hasPdcKey = o && Object.prototype.hasOwnProperty.call(o, 'pdc');
      var pdcObj = hasPdcKey && o.pdc && typeof o.pdc === 'object' ? o.pdc : null;
      if (o.pdcComplete && weeksPayload && weeksPayload.length && pdcObj) {
        weeksPayload.forEach(function (w) {
          var wk = String(w.id);
          delete dailyPerDayCampers[wk];
          var saved = pdcObj[wk];
          if (!saved || typeof saved !== 'object') return;
          var map = ensureDailyPerDayMapMain(wk);
          (w.days || []).forEach(function (d) {
            var dk = String(d.id);
            var arr = saved[dk];
            if (Array.isArray(arr) && arr.length) map[dk] = new Set(arr.map(String));
          });
          pruneEmptyDailyWeekMain(wk);
        });
      } else if (pdcObj && Object.keys(pdcObj).length) {
        Object.keys(pdcObj).forEach(function (wid) {
          var inner = pdcObj[wid];
          var wk = String(wid);
          delete dailyPerDayCampers[wk];
          if (!inner || typeof inner !== 'object') return;
          var map = ensureDailyPerDayMapMain(wk);
          Object.keys(inner).forEach(function (dk) {
            var arr = inner[dk];
            if (arr && arr.length) map[String(dk)] = new Set(arr.map(String));
          });
          pruneEmptyDailyWeekMain(wk);
        });
      } else if (!hasPdcKey) {
        Object.keys(o.sw || {}).forEach(function (wid) {
          var days = o.sw[wid];
          var kids = (o.dw && o.dw[wid]) || [];
          if (!days || !days.length || !kids.length) return;
          var map = ensureDailyPerDayMapMain(wid);
          days.forEach(function (dk) {
            map[String(dk)] = new Set(kids.map(String));
          });
        });
      }
      if (o.regFeeIncludeByCamper && typeof o.regFeeIncludeByCamper === 'object') {
        Object.keys(o.regFeeIncludeByCamper).forEach(function (k) {
          var kk = String(k);
          regFeeIncludeByCamper[kk] = o.regFeeIncludeByCamper[k];
          writeImaMemberPref(kk, !regFeeIncludeByCamper[kk]);
        });
      }
      if (o.extraShirtByCamper && typeof o.extraShirtByCamper === 'object') {
        Object.keys(o.extraShirtByCamper).forEach(function (k) {
          var kk = String(k);
          if (o.extraShirtByCamper[k]) extraShirtByCamper[kk] = true;
        });
      }
      enrollmentType = o.enrollmentType === 'daily' ? 'daily' : 'full';
    } catch (e) {}
  }

  function validateQueryHandoff() {
    var parentQ = (qs.get('parent') || '').trim();
    var uid = enrollUserId();
    if (!parentQ || !uid || parentQ !== uid) return false;
    var weeksQ = (qs.get('weeks') || '').trim();
    var childQ = (qs.get('children') || '').trim();
    var expectedWeeks = weeksQ ? weeksQ.split(',').map(function (s) { return s.trim(); }).filter(Boolean) : [];
    var expectedChildren = childQ ? childQ.split(',').map(function (s) { return s.trim(); }).filter(Boolean) : [];
    var bookings = collectBookings();
    var weekSet = {};
    var childSet = {};
    bookings.forEach(function (b) {
      if (b.weekId != null) weekSet[String(b.weekId)] = true;
      if (b.camperId != null) childSet[String(b.camperId)] = true;
    });
    try {
      collectDraftCamperWeekKeysUnion().forEach(function (key) {
        var parts = String(key).split('|');
        if (parts.length >= 2) {
          var cid = String(parts[0]).trim();
          var wk = String(parts[1]).trim();
          if (cid) childSet[cid] = true;
          if (wk) weekSet[wk] = true;
        }
      });
    } catch (eHu) {}
    if (parentCampers.length) {
      parentCampers.forEach(function (c) {
        if (extraShirtChargesThisCheckout(c.id)) childSet[String(c.id)] = true;
      });
    }
    function sameSorted(a, b) {
      if (a.length !== b.length) return false;
      for (var i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
      }
      return true;
    }
    function weeksHandoffMatches(actual, expected) {
      var es = expected.slice().sort();
      var as = actual.slice().sort();
      if (sameSorted(as, es)) return true;
      if (!es.length && as.length) return true;
      if (!as.length) return false;
      var expSet = {};
      es.forEach(function (w) {
        expSet[w] = true;
      });
      for (var i = 0; i < as.length; i++) {
        if (!expSet[as[i]]) return false;
      }
      return true;
    }
    function childrenHandoffMatches(actual, expected) {
      var es = expected.slice().sort();
      var as = actual.slice().sort();
      if (sameSorted(as, es)) return true;
      if (!es.length) return true;
      var have = {};
      as.forEach(function (id) {
        have[id] = true;
      });
      for (var i = 0; i < es.length; i++) {
        if (!have[es[i]]) return false;
      }
      return true;
    }
    var wa = Object.keys(weekSet).sort();
    var ca = Object.keys(childSet).sort();
    if (!bookings.length && !hasShirtCheckoutSelection() && Object.keys(weekSet).length === 0) return false;
    return weeksHandoffMatches(wa, expectedWeeks) && childrenHandoffMatches(ca, expectedChildren);
  }

  async function fetchPrepaidApply(bookings) {
    if (!bookings.length) return null;
    var tok = await freshAccessTokenForApi();
    if (!tok) return null;
    var res = await imaNoStoreFetch('/api/preview-prepaid-apply', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        testPricing: testPriceMode,
        bookings: bookings,
        prepaidCoverageKeys: prepaidCoverageKeysForApi(),
        paymentMethod: 'step_up',
      }),
    });
    if (!res.ok) return null;
    return res.json();
  }

  async function refreshPricing() {
    var headers = {};
    if (session) {
      var tok = await freshAccessTokenForApi();
      if (tok) headers['Authorization'] = 'Bearer ' + tok;
    }
    var params = new URLSearchParams();
    if (testPriceMode) params.set('test', 'true');
    var previewIdSet = new Set();
    collectBookings().forEach(function (b) {
      if (b.camperId) previewIdSet.add(String(b.camperId));
    });
    if (session && parentCampers.length) {
      parentCampers.forEach(function (c) {
        previewIdSet.add(String(c.id));
      });
    }
    var previewIds = Array.from(previewIdSet);
    if (previewIds.length && session) params.set('camperIds', previewIds.join(','));
    params.set('paymentMethod', 'step_up');
    var q = params.toString();
    try {
      var res = await imaNoStoreFetch('/api/preview-pricing' + (q ? '?' + q : ''), { headers });
      if (res.ok) {
        var j = await res.json();
        applyPricingFromServer(j);
      } else {
        applyPricingFromServer(null);
      }
    } catch (e) {
      applyPricingFromServer(null);
    }
    if (testPriceMode) {
      pricingPreview.dayRate = 1;
      pricingPreview.weekRate = 1;
      pricingPreview.registrationFee = 1;
      pricingPreview.extraCampShirt = 1;
    }
  }

  function campAgreementScrollSessionKey() {
    return CAMP_AGREEMENT_SCROLL_SS + ':' + (enrollUserId() || 'guest') + ':' + CAMP_AGREEMENT_VERSION;
  }

  function campAgreementLegacyAcceptedSessionKey() {
    return CAMP_AGREEMENT_ACCEPT_SS + ':' + (enrollUserId() || 'guest') + ':' + CAMP_AGREEMENT_VERSION;
  }

  function readCampAgreementAcceptOk() {
    try {
      var k = campAgreementLegacyAcceptedSessionKey();
      if (localStorage.getItem(k) === '1') return true;
      if (sessionStorage.getItem(k) === '1') {
        localStorage.setItem(k, '1');
        sessionStorage.removeItem(k);
        return true;
      }
    } catch (eA) {}
    return false;
  }

  function writeCampAgreementAcceptOk(on) {
    try {
      var k = campAgreementLegacyAcceptedSessionKey();
      if (on) {
        localStorage.setItem(k, '1');
        sessionStorage.removeItem(k);
      } else {
        localStorage.removeItem(k);
        sessionStorage.removeItem(k);
      }
    } catch (eW) {}
  }

  function readCampAgreementScrollOk() {
    try {
      var k = campAgreementScrollSessionKey();
      if (localStorage.getItem(k) === '1') return true;
      if (sessionStorage.getItem(k) === '1') {
        localStorage.setItem(k, '1');
        sessionStorage.removeItem(k);
        return true;
      }
    } catch (eR) {}
    return false;
  }

  function writeCampAgreementScrollOk(on) {
    try {
      var k = campAgreementScrollSessionKey();
      if (on) {
        localStorage.setItem(k, '1');
        sessionStorage.removeItem(k);
      } else {
        localStorage.removeItem(k);
        sessionStorage.removeItem(k);
      }
    } catch (eW) {}
  }

  function updateCampAgreementScrollGate() {
    var sc = document.getElementById('camp-agreement-scroll');
    var agreeChk = document.getElementById('camp-agreement-accept');
    if (!sc || !agreeChk) return;
    if (parentProfileWaiverSigned) {
      campAgreementScrollUnlocked = true;
      agreeChk.disabled = true;
      agreeChk.checked = true;
      updateHoldButtonState();
      return;
    }
    var threshold = 12;
    var atBottom = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - threshold;
    var alreadyAccepted = readCampAgreementAcceptOk();
    if (alreadyAccepted) {
      writeCampAgreementScrollOk(true);
      campAgreementScrollUnlocked = true;
      agreeChk.disabled = false;
      agreeChk.checked = true;
      updateHoldButtonState();
      return;
    }
    if (atBottom) {
      campAgreementScrollUnlocked = true;
      writeCampAgreementScrollOk(true);
    } else if (readCampAgreementScrollOk()) {
      campAgreementScrollUnlocked = true;
    }
    if (campAgreementScrollUnlocked) {
      agreeChk.disabled = false;
      agreeChk.checked = !!readCampAgreementAcceptOk();
    } else {
      agreeChk.disabled = true;
      agreeChk.checked = false;
    }
    updateHoldButtonState();
  }

  function ensureCampAgreementTextLoaded() {
    var pre = document.getElementById('camp-agreement-pre');
    if (!pre || pre.dataset.loaded === '1') {
      updateCampAgreementScrollGate();
      return;
    }
    if (campAgreementTextPromise) return;
    campAgreementTextPromise = fetch('/agreement/camp-2026-v1.txt?v=2', { cache: 'no-store' })
      .then(function (r) {
        return r.text();
      })
      .then(function (t) {
        if (pre) {
          pre.textContent = t || 'Agreement text unavailable.';
          pre.dataset.loaded = '1';
        }
        updateCampAgreementScrollGate();
      })
      .catch(function () {
        if (pre) {
          pre.textContent = 'Could not load agreement. Refresh the page or contact IMA.';
          pre.dataset.loaded = '1';
        }
        updateCampAgreementScrollGate();
      });
  }

  function initCampAgreementScrollUnlock() {
    var sc = document.getElementById('camp-agreement-scroll');
    var agreeChk = document.getElementById('camp-agreement-accept');
    if (!sc || !agreeChk || sc.dataset.agreementInit) return;
    sc.dataset.agreementInit = '1';
    sc.addEventListener('scroll', updateCampAgreementScrollGate, { passive: true });
    agreeChk.addEventListener('change', function () {
      writeCampAgreementAcceptOk(agreeChk.checked);
      updateHoldButtonState();
    });
  }

  function updateHoldButtonState() {
    var btn = document.getElementById('hold-btn');
    var agreeChk = document.getElementById('camp-agreement-accept');
    var agreementOk = !!(parentProfileWaiverSigned || (agreeChk && agreeChk.checked));
    var okCart = collectBookings().length > 0 || hasShirtCheckoutSelection();
    var conflicts = getFullWeekPaidDayConflictMessages().length > 0;
    var handoffOk = !!(session && validateQueryHandoff());
    if (!btn) return;
    if (!session || !parentCampers.length) {
      btn.disabled = true;
      return;
    }
    btn.disabled =
      !!checkoutSessionInFlight || !agreementOk || !okCart || !handoffOk || conflicts;
  }

  async function renderOrder() {
    var elErr = document.getElementById('su-error');
    var elLines = document.getElementById('order-lines');
    var elTotal = document.getElementById('order-total');
    var elEmpty = document.getElementById('order-empty');
    if (elErr) {
      elErr.textContent = '';
      elErr.className = 'cc-msg';
    }
    if (!session) {
      if (elEmpty) {
        elEmpty.hidden = false;
        elEmpty.innerHTML =
          '<a href="/login.html?return=' +
          encodeURIComponent('/checkout-step-up.html' + location.search) +
          '">Sign in</a> to complete payment.';
      }
      if (elLines) elLines.innerHTML = '';
      if (elTotal) elTotal.textContent = fmt(0);
      return;
    }
    if (!parentCampers.length) {
      if (elEmpty) {
        elEmpty.hidden = false;
        elEmpty.innerHTML = 'Add children on <a href="/index.html#account">My kids</a> first.';
      }
      if (elLines) elLines.innerHTML = '';
      if (elTotal) elTotal.textContent = fmt(0);
      return;
    }
    pruneConflictingFullWeekSelections();
    pruneFullWeekCampersUnknownToParent();
    var bookings = collectBookings();
    if (!validateQueryHandoff()) {
      if (elErr) {
        elErr.className = 'cc-msg cc-msg-error';
        elErr.textContent =
          'This page does not match your current camp selections. Go back to week selection and open checkout again.';
      }
      if (elEmpty) elEmpty.hidden = true;
      if (elLines) elLines.innerHTML = '';
      if (elTotal) elTotal.textContent = fmt(0);
      lastSummaryGrandDollars = 0;
      var acBad = document.getElementById('checkout-actions-card');
      if (acBad) acBad.hidden = true;
      updateHoldButtonState();
      return;
    }
    var fwMsg = getFullWeekPaidDayConflictMessages();
    if (fwMsg.length) {
      if (elErr) {
        elErr.className = 'cc-msg cc-msg-error';
        elErr.textContent = fwMsg[0];
      }
    }
    await refreshPricing();
    var prepaid = await fetchPrepaidApply(bookings);
    serverPrepaidApply = prepaid && bookingsAlignWithServerPrepaid(bookings, prepaid) ? prepaid : null;
    var dr = Number(testPriceMode ? 1 : pricingPreview.dayRate != null ? pricingPreview.dayRate : dayRateClient());
    var wr = Number(testPriceMode ? 1 : pricingPreview.weekRate != null ? pricingPreview.weekRate : weekRateClient());
    var rf = Number(testPriceMode ? 1 : pricingPreview.registrationFee != null ? pricingPreview.registrationFee : regFeeClient());
    var shirtUnit = Number(
      testPriceMode ? 1 : pricingPreview.extraCampShirt != null ? pricingPreview.extraCampShirt : extraShirtClient()
    );
    var html = '';
    var campTotal = 0;
    var sorted = sortBookingsStable(bookings);
    if (serverPrepaidApply && serverPrepaidApply.lines && serverPrepaidApply.lines.length === sorted.length) {
      for (var i = 0; i < sorted.length; i++) {
        var b = sorted[i];
        var L = serverPrepaidApply.lines[i];
        var w = weeksPayload.find(function (x) {
          return String(x.id) === String(b.weekId);
        });
        var range = w ? formatWeekRangeForSummary(w) : '';
        var childName = getCamperNameById(b.camperId);
        var headLine = w ? w.label + (range ? ' (' + range + ')' : '') + ' — ' + childName : 'Camp — ' + childName;
        var charge = Number(L.chargeCents) / 100;
        campTotal += charge;
        var detail =
          b.pricingMode === 'full_week'
            ? 'Full week Mon–Fri'
            : 'Daily: ' +
              (w
                ? (w.days || [])
                    .filter(function (d) {
                      return (b.dayIds || []).indexOf(d.id) !== -1;
                    })
                    .sort(function (a, b0) {
                      return String(a.date).localeCompare(String(b0.date));
                    })
                    .map(formatDayLabel)
                    .join(', ')
                : '');
        var applyCents = Math.max(0, Math.round(Number(L.applyCents) || 0));
        var detailCredit =
          applyCents > 0
            ? 'Prepaid credit ' + fmt(applyCents / 100) + ' applied · you pay ' + fmt(charge)
            : detail;
        html +=
          '<div class="order-line"><span class="ol-main">' +
          escapeHtml(headLine) +
          '<span class="ol-sub">' +
          escapeHtml(detailCredit) +
          '</span></span><span class="ol-amt">' +
          fmt(charge) +
          '</span></div>';
      }
    } else {
      sorted.forEach(function (b) {
        var w = weeksPayload.find(function (x) {
          return String(x.id) === String(b.weekId);
        });
        var range = w ? formatWeekRangeForSummary(w) : '';
        var childName = getCamperNameById(b.camperId);
        var headLine = w ? w.label + (range ? ' (' + range + ')' : '') + ' — ' + childName : 'Camp — ' + childName;
        var sub =
          b.pricingMode === 'full_week'
            ? wr
            : (b.dayIds || []).length * dr;
        campTotal += sub;
        var detail =
          b.pricingMode === 'full_week'
            ? 'Full week Mon–Fri'
            : 'Daily: ' +
              (w
                ? (w.days || [])
                    .filter(function (d) {
                      return (b.dayIds || []).indexOf(d.id) !== -1;
                    })
                    .map(formatDayLabel)
                    .join(', ')
                : '');
        html +=
          '<div class="order-line"><span class="ol-main">' +
          escapeHtml(headLine) +
          '<span class="ol-sub">' +
          escapeHtml(detail) +
          '</span></span><span class="ol-amt">' +
          fmt(sub) +
          '</span></div>';
      });
    }
    var regIds = [...new Set(bookings.map(function (b) { return b.camperId; }).filter(Boolean))];
    var regTotal = 0;
    regIds.forEach(function (cid) {
      if (!registrationFeeAppliesToCamper(cid)) return;
      regTotal += rf;
      var nm = getCamperNameById(cid);
      html +=
        '<div class="order-line"><span class="ol-main">Registration fee — ' +
        escapeHtml(nm) +
        '<span class="ol-sub">One-time (waived for IMA members)</span></span><span class="ol-amt">' +
        fmt(rf) +
        '</span></div>';
    });
    var shirtTotal = 0;
    parentCampers.forEach(function (c) {
      if (!extraShirtChargesThisCheckout(c.id)) return;
      shirtTotal += shirtUnit;
      var nm = getCamperNameById(c.id);
      html +=
        '<div class="order-line"><span class="ol-main">Extra camp T-shirt — ' +
        escapeHtml(nm) +
        '</span><span class="ol-amt">' +
        fmt(shirtUnit) +
        '</span></div>';
    });
    var grand = campTotal + regTotal + shirtTotal;
    lastSummaryGrandDollars = grand;
    if (elLines) elLines.innerHTML = html || '<p class="muted">No camp lines.</p>';
    if (elTotal) elTotal.textContent = fmt(grand);
    if (elEmpty) elEmpty.hidden = !!(bookings.length || hasShirtCheckoutSelection());
    var actionsCard = document.getElementById('checkout-actions-card');
    var agreeBlock = document.getElementById('camp-agreement-block');
    if (actionsCard) {
      actionsCard.hidden = !(session && parentCampers.length && validateQueryHandoff() && (bookings.length || hasShirtCheckoutSelection()));
    }
    if (agreeBlock) {
      if (parentProfileWaiverSigned) agreeBlock.hidden = true;
      else {
        agreeBlock.hidden = false;
        if (readCampAgreementAcceptOk()) writeCampAgreementScrollOk(true);
        ensureCampAgreementTextLoaded();
        requestAnimationFrame(updateCampAgreementScrollGate);
      }
    }
    var btnTxt = document.querySelector('#hold-btn .btn-text');
    if (btnTxt) {
      btnTxt.textContent =
        grand < 0.01 && (bookings.length || hasShirtCheckoutSelection())
          ? 'Hold Spot'
          : 'Hold Spot — ' + fmt(grand) + ' due';
    }
    updateHoldButtonState();
  }

  async function runCreateCheckoutSessionRequest(signal) {
    pruneConflictingFullWeekSelections();
    pruneFullWeekCampersUnknownToParent();
    var bookings = sortBookingsStable(collectBookings());
    var hasShirt = hasShirtCheckoutSelection();
    if (!bookings.length && !hasShirt) return { skip: true };
    var fwBlock = getFullWeekPaidDayConflictMessages();
    if (fwBlock.length) return { error: fwBlock[0] };
    var headers = { 'Content-Type': 'application/json' };
    var tokCo = await freshAccessTokenForApi();
    if (tokCo) headers['Authorization'] = 'Bearer ' + tokCo;
    var ids = [...new Set(bookings.map(function (b) { return b.camperId; }).filter(Boolean))];
    var regMap = {};
    var shirtMap = {};
    ids.forEach(function (cid) {
      regMap[String(cid)] = registrationFeeAppliesToCamper(cid);
    });
    parentCampers.forEach(function (c) {
      shirtMap[String(c.id)] = !!(extraShirtByCamper[String(c.id)] || extraShirtByCamper[c.id]);
    });
    var agreeEl = document.getElementById('camp-agreement-accept');
    var agreementAcceptedReq = !!(parentProfileWaiverSigned || (agreeEl && agreeEl.checked));
    var body = {
      bookings: bookings,
      testPricing: testPriceMode,
      registrationFeeForCamper: regMap,
      extraShirtByCamper: shirtMap,
      prepaidCoverageKeys: prepaidCoverageKeysForApi(),
      imaMember: ids.some(function (cid) {
        return !registrationFeeAppliesToCamper(cid);
      }),
      agreementAccepted: agreementAcceptedReq,
      agreementVersion: CAMP_AGREEMENT_VERSION,
      paymentMethod: 'step_up',
    };
    var res = await fetch(API_CHECKOUT, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body),
      signal: signal,
    });
    var data = await res.json().catch(function () {
      return {};
    });
    if (!res.ok) {
      var errParts = [];
      if (data && data.code) errParts.push(String(data.code));
      if (data && data.error) errParts.push(String(data.error));
      return { error: errParts.length ? errParts.join(' — ') : 'Server error ' + res.status, data: data };
    }
    return { data: data };
  }

  async function startHold() {
    var btn = document.getElementById('hold-btn');
    var msg = document.getElementById('su-error');
    function err(t) {
      if (msg) {
        msg.className = 'cc-msg cc-msg-error';
        msg.textContent = t;
      }
    }
    var agreeEl = document.getElementById('camp-agreement-accept');
    if (!parentProfileWaiverSigned && (!agreeEl || !agreeEl.checked)) {
      err('Please read and confirm the agreement before continuing.');
      return;
    }
    if (btn) {
      btn.classList.add('loading');
      btn.disabled = true;
    }
    if (msg) msg.className = 'cc-msg';
    checkoutSessionInFlight = true;
    var ac = new AbortController();
    var fetchTid = setTimeout(function () {
      ac.abort();
    }, 120000);
    try {
      await refreshPricing();
      var r = await runCreateCheckoutSessionRequest(ac.signal);
      if (r.skip) {
        err('Nothing to place on hold. Return to camp registration and select weeks or an add-on.');
        return;
      }
      if (r.error) {
        err(r.error);
        return;
      }
      var data = r.data;
      if (data && data.stepUpComplete) {
        if (data.totals != null && data.totals.total != null) {
          var serverT = Number(data.totals.total);
          var clientT = Number(lastSummaryGrandDollars);
          if (Number.isFinite(serverT) && Number.isFinite(clientT) && Math.abs(serverT - clientT) > 0.02) {
            await renderOrder();
            err(
              'The amount due was updated to $' + serverT.toFixed(2) + '. Review the summary and try again.'
            );
            return;
          }
        }
        try {
          if (data.totals && Number.isFinite(Number(data.totals.total))) {
            var tSnap = Number(data.totals.total);
            var xSh = Number(data.totals.extraShirts);
            sessionStorage.setItem(
              IMA_STEP_UP_HOLD_TOTALS_SS,
              JSON.stringify({
                total: tSnap,
                extraShirts: Number.isFinite(xSh) && xSh > 0 ? xSh : 0,
              })
            );
          }
        } catch (eSs) {}
        try {
          localStorage.setItem('ima_post_checkout_clear_enroll', '1');
          sessionStorage.setItem('ima_post_checkout_clear_enroll', '1');
        } catch (eCl) {}
        window.location.href = '/success.html?step_up_hold=1';
        return;
      }
      err('Unexpected response from server. Try again or contact IMA.');
    } catch (e) {
      err(
        e && e.name === 'AbortError'
          ? 'Request timed out.'
          : e && e.message
            ? e.message
            : 'Could not complete hold.'
      );
    } finally {
      clearTimeout(fetchTid);
      checkoutSessionInFlight = false;
      if (btn) btn.classList.remove('loading');
      updateHoldButtonState();
    }
  }

  async function loadWeeks() {
    var res = await imaNoStoreFetch('/api/weeks');
    if (!res.ok) throw new Error('weeks');
    var data = await res.json();
    weeksPayload = data.weeks || [];
    weeksPayload.forEach(function (w) {
      w._imaDbFull = !!w.is_full;
      (w.days || []).forEach(function (d) {
        d._imaServerEnr = Number(d.current_enrollment) || 0;
      });
      normalizeWeekCapacityFromDays(w);
      if (fullWeekQty[w.id] == null) fullWeekQty[w.id] = 0;
      if (dailyKidsByWeek[w.id] == null) dailyKidsByWeek[w.id] = 1;
    });
  }

  async function boot() {
    try {
      await IMA.getSupabase();
      session = (await IMA.getSession()) || null;
      if (session && IMA.refreshSessionForApi) {
        try {
          var ref = await IMA.refreshSessionForApi();
          if (ref && ref.session) session = ref.session;
        } catch (eR) {}
      }
    } catch (e) {
      session = null;
    }
    if (!session) {
      await renderOrder();
      return;
    }
    await loadWeeks();
    var sb = await IMA.getSupabase();
    var r = await sb
      .from('campers')
      .select('id,first_name,last_name,registration_fee_paid,extra_shirt_addon_paid')
      .eq('parent_id', session.user.id);
    parentCampers = !r.error && Array.isArray(r.data) ? r.data : [];
    try {
      var prof = await IMA.getProfile();
      parentProfileWaiverSigned = !!(prof && (prof.waiver_signed === true || prof.waiver_signed === 'true'));
    } catch (eW) {
      parentProfileWaiverSigned = false;
    }
    await refreshEnrollments();
    await loadWaitlistMine();
    restoreEnrollFromStorage();
    weeksPayload.forEach(function (w) {
      normalizeWeekCapacityFromDays(w);
    });
    initCampAgreementScrollUnlock();
    await renderOrder();
  }

  function start() {
    var hb = document.getElementById('hold-btn');
    if (hb) hb.addEventListener('click', function () { void startHold(); });
    void boot();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();

