-- =============================================================================
-- RESET ALL RESERVATION / CHECKOUT DATA (testing)
-- =============================================================================
-- Run in Supabase Dashboard → SQL Editor (uses elevated role; bypasses RLS).
--
-- Removes:
--   • All rows in public.enrollments (confirmed, pending, cancelled)
--   • All public.attendance rows (FK to enrollments, CASCADE)
--
-- Resets:
--   • public.days.current_enrollment → 0 (per-day capacity counters)
--   • public.weeks.is_full → recomputed from remaining enrollments (none → false)
--
-- Does NOT delete: profiles, campers, weeks, days, auth users.
-- =============================================================================

BEGIN;

DELETE FROM public.enrollments;

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

-- Verify (optional):
-- SELECT COUNT(*) AS enrollments_left FROM public.enrollments;
-- SELECT COUNT(*) AS attendance_left FROM public.attendance;
-- SELECT week_id, SUM(current_enrollment) FROM public.days GROUP BY week_id;
