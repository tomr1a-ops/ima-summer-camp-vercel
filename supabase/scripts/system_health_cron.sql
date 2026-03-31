-- Supabase: schedule hourly tick for /api/system-health (enforces schedule server-side).
-- Prerequisites: enable pg_cron and pg_net (Database → Extensions in Dashboard).
--
-- 1) Store the shared secret (must match verify in API: env SYSTEM_HEALTH_CRON_SECRET and/or this row):
INSERT INTO public.app_settings (key, value)
VALUES ('system_health_cron_secret', '{"secret":"REPLACE_WITH_LONG_RANDOM"}'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
--
-- 2) Set your production API URL if not using the default:
--    UPDATE app_settings SET value = jsonb_build_object('url','https://your-host/api/system-health') WHERE key = 'system_health_cron_url';
--
-- 3) Schedule (hourly). Job POSTs { "source": "cron" }; API reads quick/full timing from system_health_schedule.

SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname = 'ima_system_health_tick';

SELECT cron.schedule(
  'ima_system_health_tick',
  '0 * * * *',
  $$
  SELECT net.http_post(
    url := coalesce(
      (SELECT value->>'url' FROM public.app_settings WHERE key = 'system_health_cron_url'),
      'https://ima-summer-camp.vercel.app/api/system-health'
    ),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-system-health-cron-secret',
      coalesce((SELECT value->>'secret' FROM public.app_settings WHERE key = 'system_health_cron_secret'), '')
    ),
    body := '{"source":"cron"}'::text
  ) AS request_id;
  $$
);
