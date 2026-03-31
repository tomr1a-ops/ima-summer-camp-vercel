-- One-time camp waiver / agreement per parent profile (portal skips UI when true).

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS waiver_signed BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS waiver_signed_at TIMESTAMPTZ;

COMMENT ON COLUMN public.profiles.waiver_signed IS 'Parent completed camp agreement + checkout at least once; portal hides waiver block.';
COMMENT ON COLUMN public.profiles.waiver_signed_at IS 'When waiver_signed was first set true.';
