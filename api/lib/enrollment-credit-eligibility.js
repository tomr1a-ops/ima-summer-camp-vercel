/**
 * Camp prepaid / ledger credit only for enrollments that actually completed checkout
 * (card, $0 after Stripe session, or $0 prepaid finalize with a batch).
 * Raw status=confirmed without settlement must not create floating credits or ledger on cancel.
 */

function enrollmentHasVerifiedSettlement(row) {
  if (!row) return false;
  if (row.stripe_session_id != null && String(row.stripe_session_id).trim() !== '') return true;
  const pp = Number(row.price_paid);
  if (Number.isFinite(pp) && pp > 0) return true;
  if (row.checkout_batch_id != null && String(row.checkout_batch_id).trim() !== '') return true;
  return false;
}

function enrollmentQualifiesForCampCredit(row) {
  if (!row || String(row.status || '').toLowerCase() !== 'confirmed') return false;
  return enrollmentHasVerifiedSettlement(row);
}

/** Cancelled row still carries settlement fields from when it was paid — justifies a non-zero ledger. */
function enrollmentCancelledJustifiesLedger(row) {
  if (!row || String(row.status || '').toLowerCase() !== 'cancelled') return false;
  return enrollmentHasVerifiedSettlement(row);
}

module.exports = {
  enrollmentQualifiesForCampCredit,
  enrollmentHasVerifiedSettlement,
  enrollmentCancelledJustifiesLedger,
};
