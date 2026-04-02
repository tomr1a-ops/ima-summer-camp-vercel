-- Parent checked “IMA member” at checkout: reg fee waived (not collected). Reporting must match billing.
-- Version 20260331140001: avoids duplicate timestamp with 20260331140000_agreement_records.sql.
ALTER TABLE public.campers
  ADD COLUMN IF NOT EXISTS registration_fee_waived_ima_member BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.campers.registration_fee_waived_ima_member IS
  'Parent declared active IMA member for summer camp; one-time registration fee is waived. Distinct from registration_fee_paid (money collected).';
