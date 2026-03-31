/**
 * Whether this camper already paid the one-time camp registration fee
 * (campers.registration_fee_paid or any confirmed enrollment flagged).
 */
async function isCampRegistrationFeePaid(sb, camperId) {
  const id = String(camperId);
  const { data: camp, error: ce } = await sb.from('campers').select('registration_fee_paid').eq('id', id).maybeSingle();
  if (ce) throw ce;
  if (camp && camp.registration_fee_paid === true) return true;
  const { data: rows, error } = await sb
    .from('enrollments')
    .select('id')
    .eq('camper_id', id)
    .eq('status', 'confirmed')
    .eq('registration_fee_paid', true)
    .limit(1);
  if (error) throw error;
  return !!(rows && rows.length);
}

module.exports = { isCampRegistrationFeePaid };
