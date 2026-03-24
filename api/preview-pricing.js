const { serviceClient } = require('./lib/supabase');
const { getUserFromRequest, getProfileForUser } = require('./lib/auth');
const { dayRate, weekRate, registrationFee } = require('./lib/pricing');

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: 'Method not allowed' }));
  }

  try {
    const url = new URL(req.url || '', 'http://local');
    const testPricing = url.searchParams.get('test') === 'true';
    const camperId = url.searchParams.get('camperId');
    const { user } = await getUserFromRequest(req);

    let needsReg = true;
    if (user && camperId) {
      const profile = await getProfileForUser(user.id);
      if (!profile) {
        res.statusCode = 403;
        return res.end(JSON.stringify({ error: 'No profile' }));
      }
      const sb = serviceClient();
      const { data: camper } = await sb.from('campers').select('parent_id').eq('id', camperId).single();
      if (!camper || camper.parent_id !== user.id) {
        res.statusCode = 403;
        return res.end(JSON.stringify({ error: 'Invalid camper' }));
      }
      const { count, error } = await sb
        .from('enrollments')
        .select('*', { count: 'exact', head: true })
        .eq('camper_id', camperId)
        .eq('status', 'confirmed')
        .eq('registration_fee_paid', true);
      if (error) throw error;
      needsReg = (count || 0) === 0;
    } else if (!user) {
      needsReg = true;
    } else {
      needsReg = true;
    }

    res.statusCode = 200;
    return res.end(
      JSON.stringify({
        dayRate: dayRate(testPricing),
        weekRate: weekRate(testPricing),
        registrationFee: registrationFee(testPricing),
        needsRegistration: needsReg,
      })
    );
  } catch (e) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: e.message }));
  }
};
