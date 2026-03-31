-- =============================================================================
-- SEED: Fill week_number = 1 with 35 synthetic campers + full-week enrollments
-- =============================================================================
-- Use for waitlist / sold-out testing. Campers are tagged:
--   first_name = 'WLTEST', last_name = 'W1-001' … 'W1-035'
-- parent_id is NULL (guest-style rows); enrollments are status confirmed.
--
-- Run in Supabase SQL Editor (postgres) or: psql "$DATABASE_URL" -f this_file.sql
--
-- Undo (removes seed campers and all their enrollments in any week):
--   DELETE FROM public.enrollments e
--   USING public.campers c
--   WHERE e.camper_id = c.id AND c.first_name = 'WLTEST' AND c.last_name ~ '^W1-[0-9]{3}$';
--   DELETE FROM public.campers c
--   WHERE c.first_name = 'WLTEST' AND c.last_name ~ '^W1-[0-9]{3}$';
--   Then re-run the two UPDATE blocks at the bottom of this file for week 1 only,
--   or adjust day counts manually.
-- =============================================================================

BEGIN;

DELETE FROM public.enrollments e
USING public.campers c
WHERE e.camper_id = c.id
  AND c.first_name = 'WLTEST'
  AND c.last_name ~ '^W1-[0-9]{3}$';

DELETE FROM public.campers c
WHERE c.first_name = 'WLTEST'
  AND c.last_name ~ '^W1-[0-9]{3}$';

DO $$
DECLARE
  v_week_id uuid;
  v_day_ids uuid[];
  v_n       int;
BEGIN
  SELECT id INTO v_week_id FROM public.weeks WHERE week_number = 1 LIMIT 1;
  IF v_week_id IS NULL THEN
    RAISE EXCEPTION 'seed_week1_waitlist_test_35: no row in public.weeks with week_number = 1';
  END IF;

  SELECT array_agg(id ORDER BY date) INTO v_day_ids
  FROM public.days
  WHERE week_id = v_week_id;

  IF v_day_ids IS NULL OR cardinality(v_day_ids) = 0 THEN
    RAISE EXCEPTION 'seed_week1_waitlist_test_35: week 1 has no days';
  END IF;

  v_n := cardinality(v_day_ids);
  IF v_n <> 5 THEN
    RAISE WARNING 'seed_week1_waitlist_test_35: week 1 has % days (expected 5 for Mon–Fri); using all of them', v_n;
  END IF;
END $$;

INSERT INTO public.campers (first_name, last_name, age, parent_id)
SELECT
  'WLTEST',
  'W1-' || lpad(gs::text, 3, '0'),
  10,
  NULL
FROM generate_series(1, 35) AS gs;

INSERT INTO public.enrollments (
  parent_id,
  camper_id,
  week_id,
  day_ids,
  price_paid,
  registration_fee_paid,
  status
)
SELECT
  NULL,
  c.id,
  w.id,
  (SELECT array_agg(d.id ORDER BY d.date) FROM public.days d WHERE d.week_id = w.id),
  0,
  false,
  'confirmed'::public.enrollment_status
FROM public.campers c
CROSS JOIN public.weeks w
WHERE w.week_number = 1
  AND c.first_name = 'WLTEST'
  AND c.last_name ~ '^W1-[0-9]{3}$';

UPDATE public.days d
SET current_enrollment = (
  SELECT COUNT(*)::int
  FROM public.enrollments e
  WHERE e.week_id = d.week_id
    AND e.status IN (
      'pending'::public.enrollment_status,
      'confirmed'::public.enrollment_status,
      'pending_step_up'::public.enrollment_status
    )
    AND d.id = ANY (e.day_ids)
)
WHERE d.week_id = (SELECT id FROM public.weeks WHERE week_number = 1 LIMIT 1);

UPDATE public.weeks w
SET is_full = EXISTS (
  SELECT 1
  FROM public.days d
  WHERE d.week_id = w.id
    AND d.current_enrollment >= w.max_capacity
)
WHERE w.week_number = 1;

COMMIT;
