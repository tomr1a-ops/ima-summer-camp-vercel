-- Ensure public.enrollment_status includes pending_step_up (required for Step Up + capacity queries).
-- Uses public + pg_namespace so typname alone cannot match the wrong type.
DO $m$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_enum e
    JOIN pg_catalog.pg_type t ON e.enumtypid = t.oid
    JOIN pg_catalog.pg_namespace n ON t.typnamespace = n.oid
    WHERE n.nspname = 'public'
      AND t.typname = 'enrollment_status'
      AND e.enumlabel = 'pending_step_up'
  ) THEN
    ALTER TYPE public.enrollment_status ADD VALUE 'pending_step_up';
  END IF;
END
$m$;

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
       AND e.status IN (
         'pending'::public.enrollment_status,
         'confirmed'::public.enrollment_status,
         'pending_step_up'::public.enrollment_status
       )
       AND (p_exclude_enrollment_id IS NULL OR e.id <> p_exclude_enrollment_id)),
    0
  );
$$;

REVOKE ALL ON FUNCTION public.week_distinct_camper_count(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.week_distinct_camper_count(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.week_distinct_camper_count(uuid, uuid) TO service_role;
