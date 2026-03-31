-- =============================================================================
-- IMA Summer Camp — Supabase schema
-- Run this in: Supabase Dashboard → SQL Editor → New query → Paste → Run
-- =============================================================================
-- Prerequisites: Supabase project with Auth enabled (Email provider).
-- After run: create admin users in Authentication, then run the admin promotion
-- block at the bottom (or update profiles.role via Table Editor as service role).
-- =============================================================================

-- Extensions (usually already enabled on Supabase)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------
CREATE TYPE public.user_role AS ENUM ('admin', 'parent');
CREATE TYPE public.enrollment_status AS ENUM ('pending', 'confirmed', 'cancelled');

-- -----------------------------------------------------------------------------
-- Tables
-- -----------------------------------------------------------------------------

-- 1) profiles — one row per auth user
CREATE TABLE public.profiles (
  id         UUID PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  email      TEXT NOT NULL,
  full_name  TEXT,
  phone      TEXT,
  role       public.user_role NOT NULL DEFAULT 'parent',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX profiles_email_idx ON public.profiles (lower(email));
CREATE INDEX profiles_role_idx ON public.profiles (role);

-- 2) campers — children linked to a parent profile
CREATE TABLE public.campers (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id  UUID NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  first_name TEXT NOT NULL,
  last_name  TEXT NOT NULL,
  age        INTEGER NOT NULL CHECK (age >= 0 AND age <= 18),
  registration_fee_paid BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX campers_parent_id_idx ON public.campers (parent_id);

-- 3) weeks — camp weeks (capacity is week-level; days hold per-day tallies)
CREATE TABLE public.weeks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  week_number   INTEGER NOT NULL UNIQUE CHECK (week_number > 0),
  label         TEXT NOT NULL,
  start_date    DATE NOT NULL,
  end_date      DATE NOT NULL,
  max_capacity  INTEGER NOT NULL DEFAULT 35 CHECK (max_capacity > 0),
  is_active     BOOLEAN NOT NULL DEFAULT true,
  is_full       BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT weeks_date_range CHECK (end_date >= start_date)
);

CREATE INDEX weeks_active_idx ON public.weeks (is_active) WHERE is_active = true;

-- 4) days — Mon–Fri (or each calendar day) under a week
CREATE TABLE public.days (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  week_id              UUID NOT NULL REFERENCES public.weeks (id) ON DELETE CASCADE,
  date                 DATE NOT NULL,
  day_name             TEXT NOT NULL,
  current_enrollment   INTEGER NOT NULL DEFAULT 0 CHECK (current_enrollment >= 0),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (week_id, date)
);

CREATE INDEX days_week_id_idx ON public.days (week_id);
CREATE INDEX days_date_idx ON public.days (date);

-- 5) enrollments — checkout / registration rows (day_ids = selected public.days.id)
CREATE TABLE public.enrollments (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id              UUID NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  camper_id              UUID NOT NULL REFERENCES public.campers (id) ON DELETE CASCADE,
  week_id                UUID NOT NULL REFERENCES public.weeks (id) ON DELETE RESTRICT,
  day_ids                UUID[] NOT NULL DEFAULT '{}'::uuid[] CHECK (cardinality(day_ids) > 0),
  price_paid             NUMERIC(10, 2) NOT NULL DEFAULT 0 CHECK (price_paid >= 0),
  registration_fee_paid  BOOLEAN NOT NULL DEFAULT false,
  stripe_session_id      TEXT,
  status                 public.enrollment_status NOT NULL DEFAULT 'pending',
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX enrollments_parent_id_idx ON public.enrollments (parent_id);
CREATE INDEX enrollments_camper_id_idx ON public.enrollments (camper_id);
CREATE INDEX enrollments_week_id_idx ON public.enrollments (week_id);
CREATE INDEX enrollments_status_idx ON public.enrollments (status);
CREATE INDEX enrollments_stripe_session_idx ON public.enrollments (stripe_session_id);
CREATE INDEX enrollments_day_ids_gin_idx ON public.enrollments USING GIN (day_ids);

-- 6) attendance — per camper per enrolled day
CREATE TABLE public.attendance (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id  UUID NOT NULL REFERENCES public.enrollments (id) ON DELETE CASCADE,
  camper_id      UUID NOT NULL REFERENCES public.campers (id) ON DELETE CASCADE,
  day_id         UUID NOT NULL REFERENCES public.days (id) ON DELETE CASCADE,
  present        BOOLEAN NOT NULL DEFAULT false,
  notes          TEXT,
  marked_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (camper_id, day_id)
);

CREATE INDEX attendance_day_id_idx ON public.attendance (day_id);
CREATE INDEX attendance_enrollment_id_idx ON public.attendance (enrollment_id);

-- -----------------------------------------------------------------------------
-- Helper: admin check for RLS (uses profiles.role)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = auth.uid()
      AND p.role = 'admin'::public.user_role
  );
$$;

REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_admin() TO anon;

-- -----------------------------------------------------------------------------
-- Row Level Security
-- -----------------------------------------------------------------------------
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.weeks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.days ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance ENABLE ROW LEVEL SECURITY;

-- profiles
CREATE POLICY "profiles_select_own_or_admin"
  ON public.profiles FOR SELECT
  USING (id = auth.uid() OR public.is_admin());

CREATE POLICY "profiles_insert_own_parent"
  ON public.profiles FOR INSERT
  WITH CHECK (id = auth.uid() AND role = 'parent'::public.user_role);

CREATE POLICY "profiles_update_own"
  ON public.profiles FOR UPDATE
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

CREATE POLICY "profiles_update_admin"
  ON public.profiles FOR UPDATE
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- Prevent non-admins from changing their own role (e.g. to admin)
CREATE OR REPLACE FUNCTION public.profiles_role_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.role IS DISTINCT FROM OLD.role AND NOT public.is_admin() THEN
    NEW.role := OLD.role;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER profiles_role_guard_trg
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE PROCEDURE public.profiles_role_guard();

-- campers
CREATE POLICY "campers_select_own_or_admin"
  ON public.campers FOR SELECT
  USING (parent_id = auth.uid() OR public.is_admin());

CREATE POLICY "campers_insert_own"
  ON public.campers FOR INSERT
  WITH CHECK (parent_id = auth.uid());

CREATE POLICY "campers_update_own"
  ON public.campers FOR UPDATE
  USING (parent_id = auth.uid())
  WITH CHECK (parent_id = auth.uid());

CREATE POLICY "campers_delete_own"
  ON public.campers FOR DELETE
  USING (parent_id = auth.uid());

-- weeks + days — readable for booking UI (anon + auth); writes admin-only
CREATE POLICY "weeks_select_active_or_admin"
  ON public.weeks FOR SELECT
  USING (is_active = true OR public.is_admin());

CREATE POLICY "weeks_all_admin"
  ON public.weeks FOR ALL
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

CREATE POLICY "days_select_bookable_or_admin"
  ON public.days FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.weeks w
      WHERE w.id = week_id AND w.is_active = true
    )
    OR public.is_admin()
  );

CREATE POLICY "days_all_admin"
  ON public.days FOR ALL
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- enrollments
CREATE POLICY "enrollments_select_own_or_admin"
  ON public.enrollments FOR SELECT
  USING (parent_id = auth.uid() OR public.is_admin());

CREATE POLICY "enrollments_insert_own"
  ON public.enrollments FOR INSERT
  WITH CHECK (parent_id = auth.uid());

CREATE POLICY "enrollments_update_own_or_admin"
  ON public.enrollments FOR UPDATE
  USING (parent_id = auth.uid() OR public.is_admin())
  WITH CHECK (parent_id = auth.uid() OR public.is_admin());

-- attendance — admins only (parents could be added later for read-only)
CREATE POLICY "attendance_all_admin"
  ON public.attendance FOR ALL
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- -----------------------------------------------------------------------------
-- Optional: auto-create profile row when a user signs up (role still parent;
-- promote admins manually — see bottom of file)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, phone, role)
  VALUES (
    NEW.id,
    COALESCE(NEW.email, ''),
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    COALESCE(NEW.raw_user_meta_data->>'phone', ''),
    'parent'::public.user_role
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE PROCEDURE public.handle_new_user();

-- -----------------------------------------------------------------------------
-- Recompute week.is_full from enrollments (distinct campers per week, confirmed)
-- Optional trigger target — you can also set is_full in application/webhook logic.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.refresh_week_full_flag()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  wid UUID;
BEGIN
  wid := COALESCE(NEW.week_id, OLD.week_id);
  IF wid IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  UPDATE public.weeks w
  SET is_full = (
    (
      SELECT COUNT(DISTINCT e.camper_id)
      FROM public.enrollments e
      WHERE e.week_id = wid
        AND e.status = 'confirmed'::public.enrollment_status
    ) >= w.max_capacity
  )
  WHERE w.id = wid;

  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER enrollments_refresh_week_full_ins
  AFTER INSERT ON public.enrollments
  FOR EACH ROW
  EXECUTE PROCEDURE public.refresh_week_full_flag();

CREATE TRIGGER enrollments_refresh_week_full_upd
  AFTER UPDATE OF status, week_id ON public.enrollments
  FOR EACH ROW
  EXECUTE PROCEDURE public.refresh_week_full_flag();

CREATE TRIGGER enrollments_refresh_week_full_del
  AFTER DELETE ON public.enrollments
  FOR EACH ROW
  EXECUTE PROCEDURE public.refresh_week_full_flag();

-- -----------------------------------------------------------------------------
-- Seed: 2026 camp weeks (Mon–Fri rows in days)
-- -----------------------------------------------------------------------------
INSERT INTO public.weeks (week_number, label, start_date, end_date, max_capacity, is_active)
VALUES
  (1, 'Week 1: June 8–12', '2026-06-08', '2026-06-12', 35, true),
  (2, 'Week 2: June 15–19', '2026-06-15', '2026-06-19', 35, true),
  (3, 'Week 3: June 22–26', '2026-06-22', '2026-06-26', 35, true),
  (5, 'Week 5: July 6–10', '2026-07-06', '2026-07-10', 35, true),
  (6, 'Week 6: July 13–17', '2026-07-13', '2026-07-17', 35, true),
  (7, 'Week 7: July 20–24', '2026-07-20', '2026-07-24', 35, true),
  (8, 'Week 8: July 27–31', '2026-07-27', '2026-07-31', 35, true)
ON CONFLICT (week_number) DO NOTHING;

INSERT INTO public.days (week_id, date, day_name, current_enrollment)
SELECT w.id, gs::date, TRIM(TO_CHAR(gs::date, 'Day')), 0
FROM public.weeks w
CROSS JOIN LATERAL generate_series(w.start_date::timestamp, w.end_date::timestamp, interval '1 day') AS gs
WHERE w.week_number IN (1, 2, 3, 5, 6, 7, 8)
ON CONFLICT (week_id, date) DO NOTHING;

-- -----------------------------------------------------------------------------
-- Promote admins (run AFTER those users exist in auth.users + profiles)
-- Replace with your real auth user IDs if needed — or use email match:
-- -----------------------------------------------------------------------------
-- UPDATE public.profiles
-- SET role = 'admin'::public.user_role
-- WHERE lower(email) IN ('tom@imaimpact.com', 'coachshick@imaimpact.com');

-- =============================================================================
-- Notes
-- =============================================================================
-- • Vercel API routes should use SUPABASE_SERVICE_KEY to bypass RLS for
--   webhooks, Stripe reconciliation, and trusted server-side writes.
-- • Client pages use NEXT_PUBLIC_SUPABASE_ANON_KEY and respect RLS.
-- • register.html can INSERT into profiles — if the trigger already inserted
--   the row, use UPSERT or skip insert and only UPDATE full_name/phone.
-- • If CREATE TRIGGER fails with "EXECUTE FUNCTION", change to
--   "EXECUTE PROCEDURE" (older Postgres).
-- =============================================================================
