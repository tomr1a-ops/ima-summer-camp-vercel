/**
 * Whether this camper should not be charged the one-time registration fee again on a *new* checkout:
 * campers.registration_fee_paid, or any confirmed / pending_step_up row with registration_fee_paid
 * (reg was included in that enrollment / hold — do not add another reg line for another week).
 *
 * Do not treat “any pending_step_up” as paid: money may still be owed; only the row flag means reg was bundled.
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
    .in('status', ['confirmed', 'pending_step_up'])
    .eq('registration_fee_paid', true)
    .limit(1);
  if (error) throw error;
  return !!(rows && rows.length);
}

module.exports = { isCampRegistrationFeePaid };
