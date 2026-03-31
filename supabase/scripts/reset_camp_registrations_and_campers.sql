-- =============================================================================
-- RESET CAMP REGISTRATIONS + ALL CAMPERS (typical “wipe test data”)
-- =============================================================================
-- Run in Supabase Dashboard → SQL Editor as postgres / service (bypasses RLS).
--
-- Removes:
--   • All public.enrollments (and attendance via FK CASCADE)
--   • All public.campers (children records — parent logins stay)
--
-- Resets:
--   • public.days.current_enrollment → 0
--   • public.weeks.is_full recomputed (→ false when no enrollments)
--
-- Does NOT touch:
--   • auth.users, public.profiles, public.weeks, public.days rows
--   • public.inventory_items, public.gear_distribution
-- =============================================================================

BEGIN;

DELETE FROM public.enrollments;
DELETE FROM public.campers;

UPDATE public.days
SET current_enrollment = 0;

UPDATE public.weeks w
SET is_full = (
  COALESCE(
    (
      SELECT COUNT(DISTINCT e.camper_id)::int
      FROM public.enrollments e
      WHERE e.week_id = w.id
        AND e.status = 'confirmed'
    ),
    0
  ) >= w.max_capacity
);

COMMIT;

-- Verify:
-- SELECT COUNT(*) AS enrollments FROM public.enrollments;
-- SELECT COUNT(*) AS campers FROM public.campers;
-- SELECT COUNT(*) AS attendance FROM public.attendance;
