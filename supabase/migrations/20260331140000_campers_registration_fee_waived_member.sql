-- Parent checked “IMA member” at checkout: reg fee waived (not collected). Reporting must match billing.
ALTER TABLE public.campers
  ADD COLUMN IF NOT EXISTS registration_fee_waived_ima_member BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.campers.registration_fee_waived_ima_member IS
  'Parent declared active IMA member for summer camp; one-time registration fee is waived. Distinct from registration_fee_paid (money collected).';
