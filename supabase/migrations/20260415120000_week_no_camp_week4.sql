-- Closed week shown in schedule but not bookable (e.g. holiday week).
ALTER TABLE public.weeks
  ADD COLUMN IF NOT EXISTS is_no_camp boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.weeks.is_no_camp IS 'When true, week appears in the public schedule but registration is disabled.';

-- Week 4: June 29 – July 3, 2026 (Mon–Fri) — no camp
INSERT INTO public.weeks (week_number, label, start_date, end_date, max_capacity, is_active, is_full, is_no_camp)
VALUES (
  4,
  'Week 4: June 29 – July 3',
  '2026-06-29',
  '2026-07-03',
  35,
  true,
  false,
  true
)
ON CONFLICT (week_number) DO UPDATE SET
  label = EXCLUDED.label,
  start_date = EXCLUDED.start_date,
  end_date = EXCLUDED.end_date,
  is_active = true,
  is_no_camp = true;

INSERT INTO public.days (week_id, date, day_name, current_enrollment)
SELECT w.id, v.d, v.day_name, 0
FROM public.weeks w
CROSS JOIN (
  VALUES
    ('2026-06-29'::date, 'Monday'),
    ('2026-06-30'::date, 'Tuesday'),
    ('2026-07-01'::date, 'Wednesday'),
    ('2026-07-02'::date, 'Thursday'),
    ('2026-07-03'::date, 'Friday')
) AS v(d, day_name)
WHERE w.week_number = 4
ON CONFLICT (week_id, date) DO NOTHING;
