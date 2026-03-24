-- Run after schema.sql — checkout batches + optional guest fields
-- Supabase SQL Editor

ALTER TABLE public.enrollments
  ALTER COLUMN parent_id DROP NOT NULL;

ALTER TABLE public.enrollments
  ADD COLUMN IF NOT EXISTS guest_email TEXT,
  ADD COLUMN IF NOT EXISTS checkout_batch_id UUID;

CREATE INDEX IF NOT EXISTS enrollments_checkout_batch_id_idx
  ON public.enrollments (checkout_batch_id);

-- Optional guest checkout: server creates camper before parent exists
ALTER TABLE public.campers
  ALTER COLUMN parent_id DROP NOT NULL;

COMMENT ON COLUMN public.enrollments.guest_email IS 'Email collected at Stripe when no parent session';
COMMENT ON COLUMN public.enrollments.checkout_batch_id IS 'One Stripe Checkout session → one batch UUID';
