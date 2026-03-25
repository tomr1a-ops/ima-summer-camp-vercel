-- Global distinct camper count per week (RLS would hide other parents' rows from the API).
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
       AND e.status IN ('pending', 'confirmed')
       AND (p_exclude_enrollment_id IS NULL OR e.id <> p_exclude_enrollment_id)),
    0
  );
$$;

REVOKE ALL ON FUNCTION public.week_distinct_camper_count(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.week_distinct_camper_count(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.week_distinct_camper_count(uuid, uuid) TO service_role;

CREATE POLICY "enrollments_delete_own"
  ON public.enrollments FOR DELETE
  USING (parent_id = auth.uid());
