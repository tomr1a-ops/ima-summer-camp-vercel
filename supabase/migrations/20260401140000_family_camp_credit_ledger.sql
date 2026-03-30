-- Persisted camp-fee credits when a parent cancels a paid (confirmed) enrollment.
-- Floating credits from *other* still-confirmed weeks remain separate (family-prepaid-credits.js).

CREATE TABLE IF NOT EXISTS public.family_camp_credit_ledger (
  parent_id     UUID PRIMARY KEY REFERENCES public.profiles (id) ON DELETE CASCADE,
  balance_cents INTEGER NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.family_camp_credit_ledger IS
  'Dollar camp credits (cents) issued when confirmed enrollments are cancelled; consumed at checkout.';

ALTER TABLE public.family_camp_credit_ledger ENABLE ROW LEVEL SECURITY;

CREATE POLICY "family_camp_credit_ledger_select_own"
  ON public.family_camp_credit_ledger FOR SELECT
  USING (parent_id = auth.uid());

REVOKE ALL ON TABLE public.family_camp_credit_ledger FROM PUBLIC;
GRANT SELECT ON TABLE public.family_camp_credit_ledger TO authenticated;

-- Service role bypasses RLS for INSERT/UPDATE from Vercel APIs.

CREATE OR REPLACE FUNCTION public.family_camp_ledger_add(p_parent uuid, p_cents integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_parent IS NULL OR p_cents IS NULL OR p_cents <= 0 THEN
    RETURN;
  END IF;
  INSERT INTO public.family_camp_credit_ledger (parent_id, balance_cents)
  VALUES (p_parent, p_cents)
  ON CONFLICT (parent_id) DO UPDATE SET
    balance_cents = public.family_camp_credit_ledger.balance_cents + EXCLUDED.balance_cents,
    updated_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION public.family_camp_ledger_subtract(p_parent uuid, p_cents integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_parent IS NULL OR p_cents IS NULL OR p_cents <= 0 THEN
    RETURN;
  END IF;
  UPDATE public.family_camp_credit_ledger
  SET
    balance_cents = GREATEST(0, balance_cents - p_cents),
    updated_at = now()
  WHERE parent_id = p_parent;
  -- If no row, nothing to subtract (checkout should not over-draw).
END;
$$;

REVOKE ALL ON FUNCTION public.family_camp_ledger_add(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.family_camp_ledger_subtract(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.family_camp_ledger_add(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.family_camp_ledger_subtract(uuid, integer) TO service_role;
