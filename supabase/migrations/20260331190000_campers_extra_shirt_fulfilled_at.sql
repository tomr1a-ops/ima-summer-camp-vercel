-- Track when staff handed out the paid extra camp T-shirt; parents cannot set this (trigger).
ALTER TABLE public.campers
  ADD COLUMN IF NOT EXISTS extra_shirt_fulfilled_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN public.campers.extra_shirt_fulfilled_at IS
  'Set by admin when the optional extra camp T-shirt (extra_shirt_addon_paid) is physically given to the family.';

DROP POLICY IF EXISTS "campers_update_admin" ON public.campers;
CREATE POLICY "campers_update_admin"
  ON public.campers FOR UPDATE
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

CREATE OR REPLACE FUNCTION public.campers_guard_extra_shirt_fulfilled_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  jwt_role text;
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RETURN NEW;
  END IF;
  IF NEW.extra_shirt_fulfilled_at IS NOT DISTINCT FROM OLD.extra_shirt_fulfilled_at THEN
    RETURN NEW;
  END IF;
  jwt_role := COALESCE(auth.jwt() ->> 'role', '');
  IF jwt_role = 'service_role' THEN
    RETURN NEW;
  END IF;
  IF public.is_admin() THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'extra_shirt_fulfilled_at may only be changed by staff'
    USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS campers_guard_extra_shirt_fulfilled_at_trg ON public.campers;
CREATE TRIGGER campers_guard_extra_shirt_fulfilled_at_trg
  BEFORE UPDATE ON public.campers
  FOR EACH ROW
  EXECUTE PROCEDURE public.campers_guard_extra_shirt_fulfilled_at();
