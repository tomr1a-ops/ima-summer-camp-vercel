-- Split family camp ledger into mutually exclusive week vs day credit buckets.
-- Week credits apply only to full-week checkouts; day credits only to daily checkouts.
-- Runs after family_camp_credit_ledger table exists (20260401140000).

ALTER TABLE public.family_camp_credit_ledger
  ADD COLUMN IF NOT EXISTS balance_week_cents integer NOT NULL DEFAULT 0 CHECK (balance_week_cents >= 0),
  ADD COLUMN IF NOT EXISTS balance_day_cents integer NOT NULL DEFAULT 0 CHECK (balance_day_cents >= 0);

DO $$
DECLARE
  wr integer := 42500;
  dr integer := 9500;
  r record;
  rem integer;
  nw integer;
  has_legacy boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'family_camp_credit_ledger'
      AND column_name = 'balance_cents'
  )
  INTO has_legacy;

  IF has_legacy THEN
    FOR r IN SELECT parent_id, balance_cents FROM public.family_camp_credit_ledger
    LOOP
      rem := GREATEST(0, COALESCE(r.balance_cents, 0));
      nw := CASE WHEN wr > 0 THEN rem / wr ELSE 0 END;
      rem := rem - nw * wr;
      UPDATE public.family_camp_credit_ledger
      SET
        balance_week_cents = nw * wr,
        balance_day_cents = rem,
        balance_cents = 0
      WHERE parent_id = r.parent_id;
    END LOOP;
  END IF;
END $$;

ALTER TABLE public.family_camp_credit_ledger DROP COLUMN IF EXISTS balance_cents;

DROP FUNCTION IF EXISTS public.family_camp_ledger_add(uuid, integer);
DROP FUNCTION IF EXISTS public.family_camp_ledger_subtract(uuid, integer);

CREATE OR REPLACE FUNCTION public.family_camp_ledger_add_week(p_parent uuid, p_cents integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_parent IS NULL OR p_cents IS NULL OR p_cents <= 0 THEN
    RETURN;
  END IF;
  INSERT INTO public.family_camp_credit_ledger (parent_id, balance_week_cents, balance_day_cents)
  VALUES (p_parent, p_cents, 0)
  ON CONFLICT (parent_id) DO UPDATE SET
    balance_week_cents = public.family_camp_credit_ledger.balance_week_cents + EXCLUDED.balance_week_cents,
    updated_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION public.family_camp_ledger_add_day(p_parent uuid, p_cents integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_parent IS NULL OR p_cents IS NULL OR p_cents <= 0 THEN
    RETURN;
  END IF;
  INSERT INTO public.family_camp_credit_ledger (parent_id, balance_week_cents, balance_day_cents)
  VALUES (p_parent, 0, p_cents)
  ON CONFLICT (parent_id) DO UPDATE SET
    balance_day_cents = public.family_camp_credit_ledger.balance_day_cents + EXCLUDED.balance_day_cents,
    updated_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION public.family_camp_ledger_subtract_split(p_parent uuid, p_week_cents integer, p_day_cents integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  w integer := GREATEST(0, COALESCE(p_week_cents, 0));
  d integer := GREATEST(0, COALESCE(p_day_cents, 0));
BEGIN
  IF p_parent IS NULL OR (w <= 0 AND d <= 0) THEN
    RETURN;
  END IF;
  UPDATE public.family_camp_credit_ledger
  SET
    balance_week_cents = GREATEST(0, balance_week_cents - w),
    balance_day_cents = GREATEST(0, balance_day_cents - d),
    updated_at = now()
  WHERE parent_id = p_parent;
END;
$$;

REVOKE ALL ON FUNCTION public.family_camp_ledger_add_week(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.family_camp_ledger_add_day(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.family_camp_ledger_subtract_split(uuid, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.family_camp_ledger_add_week(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.family_camp_ledger_add_day(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.family_camp_ledger_subtract_split(uuid, integer, integer) TO service_role;

COMMENT ON TABLE public.family_camp_credit_ledger IS
  'Camp fee credits (cents): balance_week_cents for full-week checkouts only; balance_day_cents for daily checkouts only.';
