-- Physical inventory lines (admin-only via RLS + is_admin()).

CREATE TABLE public.inventory_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku TEXT,
  name TEXT NOT NULL,
  category TEXT,
  location TEXT,
  quantity_on_hand INTEGER NOT NULL DEFAULT 0 CHECK (quantity_on_hand >= 0),
  reorder_point INTEGER CHECK (reorder_point IS NULL OR reorder_point >= 0),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX inventory_items_sku_nonempty_uidx
  ON public.inventory_items (lower(btrim(sku)))
  WHERE btrim(COALESCE(sku, '')) <> '';

CREATE INDEX inventory_items_location_idx ON public.inventory_items (lower(location));
CREATE INDEX inventory_items_name_idx ON public.inventory_items (lower(name));

CREATE OR REPLACE FUNCTION public.inventory_items_touch_updated_at()
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

CREATE TRIGGER inventory_items_touch_updated_at_trg
  BEFORE UPDATE ON public.inventory_items
  FOR EACH ROW
  EXECUTE PROCEDURE public.inventory_items_touch_updated_at();

ALTER TABLE public.inventory_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "inventory_items_select_admin"
  ON public.inventory_items FOR SELECT
  USING (public.is_admin());

CREATE POLICY "inventory_items_insert_admin"
  ON public.inventory_items FOR INSERT
  WITH CHECK (public.is_admin());

CREATE POLICY "inventory_items_update_admin"
  ON public.inventory_items FOR UPDATE
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

CREATE POLICY "inventory_items_delete_admin"
  ON public.inventory_items FOR DELETE
  USING (public.is_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.inventory_items TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.inventory_items TO service_role;
