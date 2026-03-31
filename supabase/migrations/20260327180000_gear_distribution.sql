-- One-time gear distribution tracking (admin-only).

CREATE TABLE public.gear_distribution (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id UUID NOT NULL,
  member_name TEXT NOT NULL,
  gloves_size TEXT,
  shirt_size TEXT,
  shorts_size TEXT,
  bag_included BOOLEAN NOT NULL DEFAULT false,
  distributed BOOLEAN NOT NULL DEFAULT false,
  distributed_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX gear_distribution_studio_id_idx ON public.gear_distribution (studio_id);
CREATE INDEX gear_distribution_distributed_idx ON public.gear_distribution (studio_id, distributed);

CREATE OR REPLACE FUNCTION public.gear_distribution_touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER gear_distribution_touch_updated_at_trg
  BEFORE UPDATE ON public.gear_distribution
  FOR EACH ROW
  EXECUTE PROCEDURE public.gear_distribution_touch_updated_at();

ALTER TABLE public.gear_distribution ENABLE ROW LEVEL SECURITY;

CREATE POLICY "gear_distribution_select_admin"
  ON public.gear_distribution FOR SELECT
  USING (public.is_admin());

CREATE POLICY "gear_distribution_insert_admin"
  ON public.gear_distribution FOR INSERT
  WITH CHECK (public.is_admin());

CREATE POLICY "gear_distribution_update_admin"
  ON public.gear_distribution FOR UPDATE
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

CREATE POLICY "gear_distribution_delete_admin"
  ON public.gear_distribution FOR DELETE
  USING (public.is_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.gear_distribution TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.gear_distribution TO service_role;
