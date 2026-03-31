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

CREATE INDEX IF NOT EXISTS agreement_records_parent_id_idx ON public.agreement_records (parent_id);
CREATE INDEX IF NOT EXISTS agreement_records_agreed_at_idx ON public.agreement_records (agreed_at DESC);

COMMENT ON TABLE public.agreement_records IS 'IMA Summer Camp liability/policy acceptance captured at checkout (service role insert).';

ALTER TABLE public.agreement_records ENABLE ROW LEVEL SECURITY;

-- No client access; API uses service role.
