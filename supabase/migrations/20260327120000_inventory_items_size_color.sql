-- Optional apparel attributes for physical inventory.

ALTER TABLE public.inventory_items
  ADD COLUMN IF NOT EXISTS size TEXT,
  ADD COLUMN IF NOT EXISTS color TEXT;

CREATE INDEX IF NOT EXISTS inventory_items_size_idx ON public.inventory_items (lower(size));
CREATE INDEX IF NOT EXISTS inventory_items_color_idx ON public.inventory_items (lower(color));
