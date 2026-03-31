/**
 * Must match Postgres public.enrollment_status (see supabase migrations).
 * Never use payment method strings (e.g. step_up) as enrollment.status.
 */
const ENROLLMENT_STATUS = Object.freeze({
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  CANCELLED: 'cancelled',
  PENDING_STEP_UP: 'pending_step_up',
});

/** Counts toward week/day capacity (Stripe pending checkout + paid + Step Up hold). */
const CAPACITY_STATUSES = [
  ENROLLMENT_STATUS.PENDING,
  ENROLLMENT_STATUS.CONFIRMED,
  ENROLLMENT_STATUS.PENDING_STEP_UP,
];

/** Blocks overlapping the same camper/days as a paid or Step Up hold. */
const OVERLAP_BLOCK_STATUSES = [ENROLLMENT_STATUS.CONFIRMED, ENROLLMENT_STATUS.PENDING_STEP_UP];

module.exports = {
  ENROLLMENT_STATUS,
  CAPACITY_STATUSES,
  OVERLAP_BLOCK_STATUSES,
};
