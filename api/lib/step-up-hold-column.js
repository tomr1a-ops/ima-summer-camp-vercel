/**
 * Production DB may not have applied migration `20260411120000_enrollment_step_up_hold_expires.sql` yet.
 * Detect PostgREST / Postgres errors for the missing column and retry without it.
 */
function isMissingStepUpHoldExpiresColumn(err) {
  if (!err) return false;
  const s = `${err.message || ''} ${err.details || ''} ${err.hint || ''} ${err.code || ''}`;
  return /step_up_hold_expires_at|42703|does not exist|undefined column/i.test(s);
}

module.exports = { isMissingStepUpHoldExpiresColumn };
