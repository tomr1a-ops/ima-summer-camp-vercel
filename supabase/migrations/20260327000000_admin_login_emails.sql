-- Ensure known admin emails have profiles.role = admin (required for RLS is_admin()).
UPDATE public.profiles
SET role = 'admin'::public.user_role
WHERE lower(trim(email)) IN ('tom@imaimpact.com', 'coachshick@imaimpact.com');
