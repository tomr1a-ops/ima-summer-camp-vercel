-- Waitlist for sold-out camp weeks (portal + admin + automated offers).

CREATE TYPE public.waitlist_status AS ENUM ('waiting', 'offered', 'expired', 'converted');

CREATE TABLE public.waitlist (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  camper_id    UUID NOT NULL REFERENCES public.campers (id) ON DELETE CASCADE,
  week_id      UUID NOT NULL REFERENCES public.weeks (id) ON DELETE CASCADE,
  parent_id    UUID NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  position     INTEGER NOT NULL DEFAULT 0,
  status       public.waitlist_status NOT NULL DEFAULT 'waiting',
  offered_at   TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX waitlist_active_camper_week
  ON public.waitlist (camper_id, week_id)
  WHERE status IN ('waiting', 'offered');

CREATE INDEX waitlist_week_status_created_idx
  ON public.waitlist (week_id, status, created_at);

CREATE INDEX waitlist_week_status_expires_idx
  ON public.waitlist (week_id, status, expires_at)
  WHERE status = 'offered';

ALTER TABLE public.waitlist ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.waitlist IS 'Parents join when a week is full; offers expire in 24h and chain to next waiting.';

CREATE POLICY "waitlist_select_own_or_admin"
  ON public.waitlist FOR SELECT
  USING (parent_id = auth.uid() OR public.is_admin());

-- Atomic join: one queue position per week; blocks duplicate active rows.
CREATE OR REPLACE FUNCTION public.waitlist_join(p_camper_id uuid, p_week_id uuid, p_parent_id uuid)
RETURNS TABLE (entry_id uuid, entry_position integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pos  integer;
  v_id   uuid;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.enrollments e
    WHERE e.camper_id = p_camper_id
      AND e.week_id = p_week_id
      AND e.status IN ('pending', 'confirmed', 'pending_step_up')
  ) THEN
    RAISE EXCEPTION 'already_enrolled' USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.waitlist w
    WHERE w.camper_id = p_camper_id
      AND w.week_id = p_week_id
      AND w.status IN ('waiting', 'offered')
  ) THEN
    RAISE EXCEPTION 'already_on_waitlist' USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock((hashtext(p_week_id::text))::bigint);

  SELECT COALESCE(MAX(w.position), 0) + 1 INTO v_pos
  FROM public.waitlist w
  WHERE w.week_id = p_week_id;

  INSERT INTO public.waitlist (camper_id, week_id, parent_id, position, status)
  VALUES (p_camper_id, p_week_id, p_parent_id, v_pos, 'waiting')
  RETURNING id, position INTO v_id, v_pos;

  RETURN QUERY SELECT v_id, v_pos;
END;
$$;

REVOKE ALL ON FUNCTION public.waitlist_join(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.waitlist_join(uuid, uuid, uuid) TO service_role;

-- Expire stale offers for this week, then promote first waiting → offered (24h window).
CREATE OR REPLACE FUNCTION public.waitlist_offer_next(p_week_id uuid, p_offer_hours integer DEFAULT 24)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  wid    uuid;
  now_ts timestamptz := now();
  exp_ts timestamptz := now_ts + (GREATEST(1, COALESCE(p_offer_hours, 24)) * interval '1 hour');
BEGIN
  PERFORM pg_advisory_xact_lock((hashtext(p_week_id::text))::bigint);

  UPDATE public.waitlist w
  SET status = 'expired'
  WHERE w.week_id = p_week_id
    AND w.status = 'offered'
    AND w.expires_at IS NOT NULL
    AND w.expires_at <= now_ts;

  IF EXISTS (
    SELECT 1 FROM public.waitlist w
    WHERE w.week_id = p_week_id
      AND w.status = 'offered'
      AND (w.expires_at IS NULL OR w.expires_at > now_ts)
  ) THEN
    RETURN NULL;
  END IF;

  SELECT w.id INTO wid
  FROM public.waitlist w
  WHERE w.week_id = p_week_id
    AND w.status = 'waiting'
  ORDER BY w.created_at ASC, w.id ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF wid IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE public.waitlist
  SET status = 'offered',
      offered_at = now_ts,
      expires_at = exp_ts
  WHERE id = wid;

  RETURN wid;
END;
$$;

REVOKE ALL ON FUNCTION public.waitlist_offer_next(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.waitlist_offer_next(uuid, integer) TO service_role;

ALTER PUBLICATION supabase_realtime ADD TABLE public.waitlist;
