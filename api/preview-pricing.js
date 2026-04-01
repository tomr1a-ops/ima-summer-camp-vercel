const { serviceClient } = require('./lib/supabase');
const { getUserFromRequest, getProfileForUser } = require('./lib/auth');
const { setNoStoreJsonHeaders } = require('./lib/http-no-store');
const { dayRate, weekRate, registrationFee, extraCampShirt } = require('./lib/pricing');
const {
  getReconciledFamilyCampLedgerBalances,
  ledgerPaymentMethodForEnrollment,
} = require('./lib/family-camp-ledger');

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
    const paymentMethodRaw = (url.searchParams.get('paymentMethod') || '').trim().toLowerCase();
    const ledgerPaymentMethod =
      paymentMethodRaw === 'step_up' ? 'step_up' : paymentMethodRaw === 'credit_card' ? 'credit_card' : 'credit_card';
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
          const lb = await getReconciledFamilyCampLedgerBalances(sb, user.id, { paymentMethod: ledgerPaymentMethod });
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
            .select('parent_id, extra_shirt_addon_paid, registration_fee_paid, registration_fee_waived_ima_member')
            .eq('id', camperId)
            .single();
          if (ce || !camper || String(camper.parent_id) !== String(user.id)) {
            res.statusCode = 403;
            return res.end(JSON.stringify({ error: 'Invalid camper selection' }));
          }
          perCamperExtraShirtPaid[String(camperId)] = !!camper.extra_shirt_addon_paid;
          try {
            let regPaid =
              camper.registration_fee_paid === true || camper.registration_fee_waived_ima_member === true;
            if (!regPaid) {
              const { data: paidRows, error } = await sb
                .from('enrollments')
                .select('id,status,stripe_session_id,checkout_batch_id,price_paid')
                .eq('camper_id', String(camperId))
                .in('status', ['confirmed', 'pending', 'pending_step_up'])
                .eq('registration_fee_paid', true)
                .limit(80);
              if (error) throw error;
              const rows = paidRows || [];
              if (ledgerPaymentMethod === 'credit_card') {
                /* Credit card portal: only card-rail rows (not Step Up holds / Step Up–confirmed). */
                regPaid = rows.some((row) => ledgerPaymentMethodForEnrollment(row) === 'credit_card');
              } else {
                /* Step Up portal: Step Up rail + card-confirmed (one-time reg already paid on card). */
                regPaid = rows.some((row) => {
                  const rail = ledgerPaymentMethodForEnrollment(row);
                  return rail === 'step_up' || rail === 'credit_card';
                });
              }
            }
            /* pending_step_up only counts when registration_fee_paid on that row (query filter). */
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
