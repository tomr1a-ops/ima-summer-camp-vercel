-- Step Up for Students: reservation without Stripe; holds capacity like pending/confirmed.
DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'enrollment_status'
      AND e.enumlabel = 'pending_step_up'
  ) THEN
    ALTER TYPE public.enrollment_status ADD VALUE 'pending_step_up';
  END IF;
END
$migration$;

CREATE OR REPLACE FUNCTION public.week_distinct_camper_count(
  p_week_id uuid,
  p_exclude_enrollment_id uuid DEFAULT NULL
)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT COALESCE(
    (SELECT COUNT(DISTINCT e.camper_id)::integer
     FROM public.enrollments e
     WHERE e.week_id = p_week_id
       AND e.status IN ('pending', 'confirmed', 'pending_step_up')
       AND (p_exclude_enrollment_id IS NULL OR e.id <> p_exclude_enrollment_id)),
    0
  );
$$;
