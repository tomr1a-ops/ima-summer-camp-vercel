-- Split family_camp_credit_ledger by payment rail (Step Up vs credit card).
-- Legacy balance_week_cents / balance_day_cents become credit_card buckets.

ALTER TABLE public.family_camp_credit_ledger
  ADD COLUMN IF NOT EXISTS balance_week_cents_credit_card integer NOT NULL DEFAULT 0 CHECK (balance_week_cents_credit_card >= 0),
  ADD COLUMN IF NOT EXISTS balance_day_cents_credit_card integer NOT NULL DEFAULT 0 CHECK (balance_day_cents_credit_card >= 0),
  ADD COLUMN IF NOT EXISTS balance_week_cents_step_up integer NOT NULL DEFAULT 0 CHECK (balance_week_cents_step_up >= 0),
  ADD COLUMN IF NOT EXISTS balance_day_cents_step_up integer NOT NULL DEFAULT 0 CHECK (balance_day_cents_step_up >= 0);

UPDATE public.family_camp_credit_ledger SET
  balance_week_cents_credit_card = COALESCE(balance_week_cents, 0),
  balance_day_cents_credit_card = COALESCE(balance_day_cents, 0);

UPDATE public.family_camp_credit_ledger SET
  balance_week_cents = 0,
  balance_day_cents = 0;

ALTER TABLE public.family_camp_credit_ledger DROP COLUMN IF EXISTS balance_week_cents;
ALTER TABLE public.family_camp_credit_ledger DROP COLUMN IF EXISTS balance_day_cents;

DROP FUNCTION IF EXISTS public.family_camp_ledger_add_week(uuid, integer);
DROP FUNCTION IF EXISTS public.family_camp_ledger_add_day(uuid, integer);
DROP FUNCTION IF EXISTS public.family_camp_ledger_subtract_split(uuid, integer, integer);

CREATE OR REPLACE FUNCTION public.family_camp_ledger_add_week(
  p_parent uuid,
  p_cents integer,
  p_payment_method text DEFAULT 'credit_card'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  pm text := lower(trim(COALESCE(p_payment_method, 'credit_card')));
BEGIN
  IF p_parent IS NULL OR p_cents IS NULL OR p_cents <= 0 THEN
    RETURN;
  END IF;
  IF pm NOT IN ('step_up', 'credit_card') THEN
    pm := 'credit_card';
  END IF;
  IF pm = 'step_up' THEN
    INSERT INTO public.family_camp_credit_ledger (parent_id, balance_week_cents_step_up, balance_day_cents_step_up, balance_week_cents_credit_card, balance_day_cents_credit_card)
    VALUES (p_parent, p_cents, 0, 0, 0)
    ON CONFLICT (parent_id) DO UPDATE SET
      balance_week_cents_step_up = public.family_camp_credit_ledger.balance_week_cents_step_up + EXCLUDED.balance_week_cents_step_up,
      updated_at = now();
  ELSE
    INSERT INTO public.family_camp_credit_ledger (parent_id, balance_week_cents_step_up, balance_day_cents_step_up, balance_week_cents_credit_card, balance_day_cents_credit_card)
    VALUES (p_parent, 0, 0, p_cents, 0)
    ON CONFLICT (parent_id) DO UPDATE SET
      balance_week_cents_credit_card = public.family_camp_credit_ledger.balance_week_cents_credit_card + EXCLUDED.balance_week_cents_credit_card,
      updated_at = now();
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.family_camp_ledger_add_day(
  p_parent uuid,
  p_cents integer,
  p_payment_method text DEFAULT 'credit_card'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  pm text := lower(trim(COALESCE(p_payment_method, 'credit_card')));
BEGIN
  IF p_parent IS NULL OR p_cents IS NULL OR p_cents <= 0 THEN
    RETURN;
  END IF;
  IF pm NOT IN ('step_up', 'credit_card') THEN
    pm := 'credit_card';
  END IF;
  IF pm = 'step_up' THEN
    INSERT INTO public.family_camp_credit_ledger (parent_id, balance_week_cents_step_up, balance_day_cents_step_up, balance_week_cents_credit_card, balance_day_cents_credit_card)
    VALUES (p_parent, 0, p_cents, 0, 0)
    ON CONFLICT (parent_id) DO UPDATE SET
      balance_day_cents_step_up = public.family_camp_credit_ledger.balance_day_cents_step_up + EXCLUDED.balance_day_cents_step_up,
      updated_at = now();
  ELSE
    INSERT INTO public.family_camp_credit_ledger (parent_id, balance_week_cents_step_up, balance_day_cents_step_up, balance_week_cents_credit_card, balance_day_cents_credit_card)
    VALUES (p_parent, 0, 0, 0, p_cents)
    ON CONFLICT (parent_id) DO UPDATE SET
      balance_day_cents_credit_card = public.family_camp_credit_ledger.balance_day_cents_credit_card + EXCLUDED.balance_day_cents_credit_card,
      updated_at = now();
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.family_camp_ledger_subtract_split(
  p_parent uuid,
  p_week_cents integer,
  p_day_cents integer,
  p_payment_method text DEFAULT 'credit_card'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  w integer := GREATEST(0, COALESCE(p_week_cents, 0));
  d integer := GREATEST(0, COALESCE(p_day_cents, 0));
  pm text := lower(trim(COALESCE(p_payment_method, 'credit_card')));
BEGIN
  IF p_parent IS NULL OR (w <= 0 AND d <= 0) THEN
    RETURN;
  END IF;
  IF pm NOT IN ('step_up', 'credit_card') THEN
    pm := 'credit_card';
  END IF;
  IF pm = 'step_up' THEN
    UPDATE public.family_camp_credit_ledger
    SET
      balance_week_cents_step_up = GREATEST(0, balance_week_cents_step_up - w),
      balance_day_cents_step_up = GREATEST(0, balance_day_cents_step_up - d),
      updated_at = now()
    WHERE parent_id = p_parent;
  ELSE
    UPDATE public.family_camp_credit_ledger
    SET
      balance_week_cents_credit_card = GREATEST(0, balance_week_cents_credit_card - w),
      balance_day_cents_credit_card = GREATEST(0, balance_day_cents_credit_card - d),
      updated_at = now()
    WHERE parent_id = p_parent;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.family_camp_ledger_add_week(uuid, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.family_camp_ledger_add_day(uuid, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.family_camp_ledger_subtract_split(uuid, integer, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.family_camp_ledger_add_week(uuid, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.family_camp_ledger_add_day(uuid, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.family_camp_ledger_subtract_split(uuid, integer, integer, text) TO service_role;

COMMENT ON TABLE public.family_camp_credit_ledger IS
  'Camp fee credits (cents): week/day buckets per payment rail — credit_card vs step_up.';
