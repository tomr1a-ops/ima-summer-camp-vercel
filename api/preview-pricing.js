const { serviceClient } = require('./lib/supabase');
const { getUserFromRequest, getProfileForUser } = require('./lib/auth');
const { setNoStoreJsonHeaders } = require('./lib/http-no-store');
const { dayRate, weekRate, registrationFee, extraCampShirt } = require('./lib/pricing');

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
        for (const camperId of camperIds) {
          const { data: camper, error: ce } = await sb
            .from('campers')
            .select('parent_id, extra_shirt_addon_paid')
            .eq('id', camperId)
            .single();
          if (ce || !camper || String(camper.parent_id) !== String(user.id)) {
            res.statusCode = 403;
            return res.end(JSON.stringify({ error: 'Invalid camper selection' }));
          }
          perCamperExtraShirtPaid[String(camperId)] = !!camper.extra_shirt_addon_paid;
          try {
            const { data: paidRows, error } = await sb
              .from('enrollments')
              .select('id')
              .eq('camper_id', String(camperId))
              .eq('status', 'confirmed')
              .eq('registration_fee_paid', true)
              .limit(1);
            if (error) {
              console.warn('[preview-pricing] enrollment count:', error.message);
              perCamperNeedsReg[String(camperId)] = true;
            } else {
              perCamperNeedsReg[String(camperId)] = !(paidRows && paidRows.length);
            }
          } catch (cntErr) {
            console.warn('[preview-pricing] count error:', cntErr.message);
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
      })
    );
  } catch (e) {
    console.error('[preview-pricing]', e);
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: e.message }));
  }
};
