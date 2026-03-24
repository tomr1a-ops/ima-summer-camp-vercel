const { serviceClient } = require('./lib/supabase');

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(204).end();
  }
  if (req.method !== 'GET') {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: 'Method not allowed' }));
  }

  try {
    const sb = serviceClient();
    const { data: weeks, error: we } = await sb
      .from('weeks')
      .select('id,week_number,label,start_date,end_date,max_capacity,is_active,is_full')
      .eq('is_active', true)
      .order('week_number');
    if (we) throw we;

    const { data: days, error: de } = await sb
      .from('days')
      .select('id,week_id,date,day_name,current_enrollment')
      .order('date');
    if (de) throw de;

    const byWeek = {};
    (days || []).forEach((d) => {
      if (!byWeek[d.week_id]) byWeek[d.week_id] = [];
      byWeek[d.week_id].push(d);
    });

    const capDefault = 35;
    const payload = (weeks || []).map((w) => {
      const max = w.max_capacity || capDefault;
      const wdays = (byWeek[w.id] || []).map((d) => ({
        id: d.id,
        date: d.date,
        day_name: d.day_name,
        current_enrollment: d.current_enrollment,
        slots_left: Math.max(0, max - (d.current_enrollment || 0)),
        at_capacity: (d.current_enrollment || 0) >= max,
      }));
      return {
        ...w,
        days: wdays,
        disabled: w.is_full || !w.is_active,
      };
    });

    res.statusCode = 200;
    return res.end(JSON.stringify({ weeks: payload }));
  } catch (e) {
    console.error(e);
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: e.message }));
  }
};
