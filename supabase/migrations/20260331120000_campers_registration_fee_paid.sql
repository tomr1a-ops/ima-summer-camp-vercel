-- One-time camp registration fee is tracked per child (survives cancelled / removed enrollments).
ALTER TABLE public.campers
  ADD COLUMN IF NOT EXISTS registration_fee_paid BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.campers.registration_fee_paid IS
  'True after this camper''s one-time summer registration fee was collected (Stripe or $0 checkout); never charge again.';

UPDATE public.campers c
SET registration_fee_paid = true
WHERE EXISTS (
  SELECT 1
  FROM public.enrollments e
  WHERE e.camper_id = c.id
    AND e.status = 'confirmed'::public.enrollment_status
    AND e.registration_fee_paid = true
);
