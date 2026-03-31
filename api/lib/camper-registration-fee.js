/**
 * Whether this camper should not be charged the one-time registration fee again:
 * campers.registration_fee_paid, any confirmed/pending_step_up row with registration_fee_paid,
 * or any active pending_step_up hold (reg is part of that flow / legacy rows).
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
  if (rows && rows.length) return true;
  /** Active Step Up hold: registration was part of that checkout (or legacy rows) — do not charge again for another week. */
  const { data: su, error: sue } = await sb
    .from('enrollments')
    .select('id')
    .eq('camper_id', id)
    .eq('status', 'pending_step_up')
    .limit(1);
  if (sue) throw sue;
  return !!(su && su.length);
}

module.exports = { isCampRegistrationFeePaid };
