-- One-time extra T-shirt add-on: after Stripe payment, we set this so repeat checkouts do not charge again.
ALTER TABLE public.campers
  ADD COLUMN IF NOT EXISTS extra_shirt_addon_paid BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.campers.extra_shirt_addon_paid IS 'True after parent paid optional extra camp T-shirt add-on; suppresses future Stripe line for that camper.';
