-- Promote known admin emails (no-op if profiles do not exist yet)
UPDATE public.profiles
SET role = 'admin'::public.user_role
WHERE lower(email) IN ('tom@imaimpact.com', 'coachshick@imaimpact.com');
