-- 24-hour Step Up hold expiry (set in application when status becomes pending_step_up).
ALTER TABLE public.enrollments
  ADD COLUMN IF NOT EXISTS step_up_hold_expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS enrollments_step_up_hold_expires_idx
  ON public.enrollments (status, step_up_hold_expires_at)
  WHERE status = 'pending_step_up'::public.enrollment_status;
