const { serviceClient } = require('./lib/supabase');
const { getUserFromRequest, getProfileForUser } = require('./lib/auth');
const { setNoStoreJsonHeaders } = require('./lib/http-no-store');
const { dayRate, weekRate, registrationFee, extraCampShirt } = require('./lib/pricing');
const { getReconciledFamilyCampLedgerBalances } = require('./lib/family-camp-ledger');

function uniqueCamperIdsFromQuery(url) {
  const raw = url.searchParams.get('camperIds') || url.searchParams.get('camperId') || '';
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set(parts)];
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  setNoStoreJsonHeaders(res);
  if (req.method !== 'GET') {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: 'Method not allowed' }));
  }

  try {
    const url = new URL(req.url || '', 'http://local');
    const testPricing = url.searchParams.get('test') === 'true';
    const camperIds = uniqueCamperIdsFromQuery(url);
    const { user, token } = await getUserFromRequest(req);

    const perCamperNeedsReg = {};
    /** True when this camper already paid the optional extra T-shirt add-on (no repeat charge). */
    const perCamperExtraShirtPaid = {};
    let profile = null;
    let prepaidCampBalanceWeekCents = 0;
    let prepaidCampBalanceDayCents = 0;

    if (user && token && camperIds.length) {
      let sb;
      try {
        sb = serviceClient();
      } catch (cfg) {
        console.warn('[preview-pricing] supabase config:', cfg.message);
        sb = null;
      }
      try {
        profile = sb ? await getProfileForUser(user.id) : null;
      } catch (pe) {
        console.warn('[preview-pricing] profile load:', pe.message);
        profile = null;
      }

      if (profile && sb) {
        try {
          const lb = await getReconciledFamilyCampLedgerBalances(sb, user.id);
          prepaidCampBalanceWeekCents = lb.weekCents;
          prepaidCampBalanceDayCents = lb.dayCents;
        } catch (le) {
          console.warn('[preview-pricing] ledger balance:', le.message);
          prepaidCampBalanceWeekCents = 0;
          prepaidCampBalanceDayCents = 0;
        }
        for (const camperId of camperIds) {
          const { data: camper, error: ce } = await sb
            .from('campers')
            .select('parent_id, extra_shirt_addon_paid, registration_fee_paid')
            .eq('id', camperId)
            .single();
          if (ce || !camper || String(camper.parent_id) !== String(user.id)) {
            res.statusCode = 403;
            return res.end(JSON.stringify({ error: 'Invalid camper selection' }));
          }
          perCamperExtraShirtPaid[String(camperId)] = !!camper.extra_shirt_addon_paid;
          try {
            let regPaid = camper.registration_fee_paid === true;
            if (!regPaid) {
              const { data: paidRows, error } = await sb
                .from('enrollments')
                .select('id')
                .eq('camper_id', String(camperId))
                .in('status', ['confirmed', 'pending_step_up'])
                .eq('registration_fee_paid', true)
                .limit(1);
              if (error) throw error;
              regPaid = !!(paidRows && paidRows.length);
            }
            /* Do not treat any pending_step_up as “reg paid” unless that row has registration_fee_paid (reg was in that hold). */
            perCamperNeedsReg[String(camperId)] = !regPaid;
          } catch (cntErr) {
            console.warn('[preview-pricing] reg fee check:', cntErr.message);
            perCamperNeedsReg[String(camperId)] = true;
          }
        }
      }
    }

    const needsRegistration =
      !user || !camperIds.length ? true : Object.values(perCamperNeedsReg).some(Boolean);

    res.statusCode = 200;
    return res.end(
      JSON.stringify({
        dayRate: dayRate(testPricing),
        weekRate: weekRate(testPricing),
        registrationFee: registrationFee(testPricing),
        extraCampShirt: extraCampShirt(testPricing),
        needsRegistration,
        perCamperNeedsReg,
        perCamperExtraShirtPaid,
        prepaidCampBalanceWeekCents,
        prepaidCampBalanceDayCents,
        prepaidCampBalanceCents: prepaidCampBalanceWeekCents + prepaidCampBalanceDayCents,
      })
    );
  } catch (e) {
    console.error('[preview-pricing]', e);
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: e.message }));
  }
};
