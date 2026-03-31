-- System Health dashboard: settings cache, failure log, optional cron auth secret row.

CREATE TABLE IF NOT EXISTS public.app_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS app_settings_updated_at_idx ON public.app_settings (updated_at DESC);

CREATE TABLE IF NOT EXISTS public.system_health_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  check_name    TEXT NOT NULL,
  status        TEXT NOT NULL,
  count_result  INTEGER,
  ai_diagnosis  TEXT,
  resolved      BOOLEAN NOT NULL DEFAULT false,
  resolved_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS system_health_log_check_created_idx
  ON public.system_health_log (check_name, created_at DESC);

CREATE INDEX IF NOT EXISTS system_health_log_unresolved_idx
  ON public.system_health_log (check_name)
  WHERE resolved = false;

ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_health_log ENABLE ROW LEVEL SECURITY;

-- No policies: only service role / postgres (bypass) used from API.

COMMENT ON TABLE public.system_health_log IS 'Failed system health checks; resolved when the same check passes again.';

INSERT INTO public.app_settings (key, value)
VALUES ('system_health_schedule', '{
  "quickEnabled": false,
  "quickFrequency": "manual",
  "fullEnabled": false,
  "fullFrequency": "manual",
  "emailOnFailure": false,
  "alertEmail": ""
}'::jsonb)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.app_settings (key, value)
VALUES ('system_health_last_run', '{}'::jsonb)
ON CONFLICT (key) DO NOTHING;
