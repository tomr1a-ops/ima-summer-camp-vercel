-- Admin backup / restore audit log (service role from API only).

CREATE TABLE IF NOT EXISTS public.backup_log (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  studio_id uuid,
  created_at timestamptz DEFAULT now() NOT NULL,
  file_name text,
  table_count int,
  total_rows int,
  status text DEFAULT 'completed',
  notes text
);

CREATE INDEX IF NOT EXISTS backup_log_created_at_idx ON public.backup_log (created_at DESC);
CREATE INDEX IF NOT EXISTS backup_log_studio_id_idx ON public.backup_log (studio_id);

ALTER TABLE public.backup_log ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.backup_log IS 'IMAOS/camp admin backup and restore events; written via service role API.';
