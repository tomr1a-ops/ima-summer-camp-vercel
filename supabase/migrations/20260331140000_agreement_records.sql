-- Parent acceptance of IMA Summer Camp policies (recorded at checkout).
CREATE TABLE IF NOT EXISTS public.agreement_records (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id          UUID REFERENCES public.profiles (id) ON DELETE SET NULL,
  parent_name        TEXT NOT NULL,
  email              TEXT NOT NULL,
  agreed_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip_address         TEXT,
  agreement_version  TEXT NOT NULL,
  camper_ids         UUID[] NOT NULL DEFAULT '{}'::uuid[],
  acknowledgment_email_sent BOOLEAN NOT NULL DEFAULT false
);

-- Align legacy / manually created tables (IF NOT EXISTS skipped CREATE but shape differs).
ALTER TABLE public.agreement_records ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES public.profiles (id) ON DELETE SET NULL;
ALTER TABLE public.agreement_records ADD COLUMN IF NOT EXISTS parent_name TEXT;
ALTER TABLE public.agreement_records ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE public.agreement_records ADD COLUMN IF NOT EXISTS agreed_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE public.agreement_records ADD COLUMN IF NOT EXISTS ip_address TEXT;
ALTER TABLE public.agreement_records ADD COLUMN IF NOT EXISTS agreement_version TEXT;
ALTER TABLE public.agreement_records ADD COLUMN IF NOT EXISTS camper_ids UUID[] DEFAULT '{}'::uuid[];
ALTER TABLE public.agreement_records ADD COLUMN IF NOT EXISTS acknowledgment_email_sent BOOLEAN DEFAULT false;

UPDATE public.agreement_records SET parent_name = 'Unknown' WHERE parent_name IS NULL;
UPDATE public.agreement_records SET email = 'unknown@placeholder.local' WHERE email IS NULL;
UPDATE public.agreement_records SET agreement_version = '1.0' WHERE agreement_version IS NULL;
UPDATE public.agreement_records SET camper_ids = '{}'::uuid[] WHERE camper_ids IS NULL;
UPDATE public.agreement_records SET agreed_at = now() WHERE agreed_at IS NULL;
UPDATE public.agreement_records SET acknowledgment_email_sent = false WHERE acknowledgment_email_sent IS NULL;

ALTER TABLE public.agreement_records ALTER COLUMN parent_name SET NOT NULL;
ALTER TABLE public.agreement_records ALTER COLUMN email SET NOT NULL;
ALTER TABLE public.agreement_records ALTER COLUMN agreement_version SET NOT NULL;
ALTER TABLE public.agreement_records ALTER COLUMN camper_ids SET NOT NULL;
ALTER TABLE public.agreement_records ALTER COLUMN acknowledgment_email_sent SET NOT NULL;
ALTER TABLE public.agreement_records ALTER COLUMN agreed_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS agreement_records_parent_id_idx ON public.agreement_records (parent_id);
CREATE INDEX IF NOT EXISTS agreement_records_agreed_at_idx ON public.agreement_records (agreed_at DESC);

COMMENT ON TABLE public.agreement_records IS 'IMA Summer Camp liability/policy acceptance captured at checkout (service role insert).';

ALTER TABLE public.agreement_records ENABLE ROW LEVEL SECURITY;

-- No client access; API uses service role.
