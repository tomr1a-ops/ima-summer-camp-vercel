-- =============================================================================
-- CLEAR CAMP TEST DATA — KEEP HOUSEHOLDS (profiles + campers)
-- =============================================================================
-- Run in Supabase Dashboard → SQL Editor as postgres (or: supabase db execute).
--
-- Removes / resets:
--   • All enrollments (pending, confirmed, cancelled) — attendance CASCADEs
--   • All family_camp_credit_ledger rows (cancelled-enrollment dollar credits)
--   • extra_shirt_addon_paid on every camper → false
--   • days.current_enrollment → 0
--   • weeks.is_full recomputed from remaining enrollments (none → false)
--
-- Preserves:
--   • auth.users, public.profiles (parents / HOH)
--   • public.campers (names, ages — only shirt-paid flag cleared)
--   • public.weeks, public.days, public.inventory_items
--   • public.gear_distribution (admin list; delete manually if you want it empty)
--
-- After running: hard-refresh the portal and/or clear browser localStorage keys
-- ima_reg_enroll_v1 and ima_portal_enroll_v1:* or draft lines may still show until refresh.
-- =============================================================================

BEGIN;

DELETE FROM public.enrollments;

DELETE FROM public.family_camp_credit_ledger;

UPDATE public.campers
SET
  extra_shirt_addon_paid = false,
  registration_fee_paid = false
WHERE extra_shirt_addon_paid IS DISTINCT FROM false
   OR registration_fee_paid IS DISTINCT FROM false;

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
