-- -----------------------------------------------------------------------------
-- One-off cleanup: duplicate enrollments for one camper in one week (test data)
-- Run in Supabase → SQL Editor as a project owner / service role context.
--
-- Does:
--   1) DELETE all pending rows for that camper + week (abandoned checkouts).
--   2) For confirmed duplicates: KEEP one row (highest price_paid, then newest),
--      decrement days.current_enrollment for removed rows' day_ids, then DELETE extras.
--
-- VERIFY targets first: uncomment the SELECT preview block and run it alone.
-- -----------------------------------------------------------------------------

BEGIN;

-- Resolve week (Week 5: July 6–10 in seed data)
WITH w AS (
  SELECT id FROM public.weeks WHERE week_number = 5 LIMIT 1
),
cam AS (
  SELECT id AS camper_id
  FROM public.campers
  WHERE lower(trim(first_name)) = 'alyssa'
    AND lower(trim(last_name)) = 'richardson'
  ORDER BY created_at ASC
  LIMIT 1
),
scope AS (
  SELECT w.id AS week_id, cam.camper_id
  FROM w
  CROSS JOIN cam
)
-- Preview (optional): run this CTE alone without BEGIN/COMMIT to inspect
-- SELECT e.id, e.status, e.price_paid, e.created_at, e.stripe_session_id, e.checkout_batch_id
-- FROM public.enrollments e
-- JOIN scope s ON e.week_id = s.week_id AND e.camper_id = s.camper_id
-- ORDER BY e.status DESC, e.created_at;

, del_pending AS (
  DELETE FROM public.enrollments e
  USING scope s
  WHERE e.week_id = s.week_id
    AND e.camper_id = s.camper_id
    AND e.status = 'pending'
  RETURNING e.id
)
, ranked AS (
  SELECT
    e.id,
    row_number() OVER (
      ORDER BY e.price_paid DESC NULLS LAST, e.created_at DESC
    ) AS rn
  FROM public.enrollments e
  JOIN scope s ON e.week_id = s.week_id AND e.camper_id = s.camper_id
  WHERE e.status = 'confirmed'
)
, to_remove AS (
  SELECT id FROM ranked WHERE rn > 1
)
, decrements AS (
  SELECT u.day_id, count(*)::int AS n
  FROM to_remove tr
  JOIN public.enrollments e ON e.id = tr.id
  CROSS JOIN LATERAL unnest(e.day_ids) AS u(day_id)
  GROUP BY u.day_id
)
UPDATE public.days d
SET current_enrollment = greatest(0, d.current_enrollment - dec.n)
FROM decrements dec
WHERE d.id = dec.day_id;

-- Second statement: delete extra confirmed rows (keeper = rn 1)
WITH w AS (
  SELECT id FROM public.weeks WHERE week_number = 5 LIMIT 1
),
cam AS (
  SELECT id AS camper_id
  FROM public.campers
  WHERE lower(trim(first_name)) = 'alyssa'
    AND lower(trim(last_name)) = 'richardson'
  ORDER BY created_at ASC
  LIMIT 1
),
scope AS (
  SELECT w.id AS week_id, cam.camper_id
  FROM w
  CROSS JOIN cam
),
ranked AS (
  SELECT
    e.id,
    row_number() OVER (
      ORDER BY e.price_paid DESC NULLS LAST, e.created_at DESC
    ) AS rn
  FROM public.enrollments e
  JOIN scope s ON e.week_id = s.week_id AND e.camper_id = s.camper_id
  WHERE e.status = 'confirmed'
)
DELETE FROM public.enrollments e
WHERE e.id IN (SELECT id FROM ranked WHERE rn > 1);

COMMIT;

-- If anything looks wrong, use ROLLBACK; instead of COMMIT; (or run without COMMIT in a transaction you abort).
