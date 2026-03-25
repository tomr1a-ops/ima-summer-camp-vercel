-- Backfill profile for auth user missing public.profiles row; set admin for camp ops.
INSERT INTO public.profiles (id, email, full_name, role)
SELECT id, email, 'Tom Richardson', 'admin'::public.user_role
FROM auth.users
WHERE email = 'tomr1a@gmail.com'
ON CONFLICT (id) DO NOTHING;

UPDATE public.profiles
SET role = 'admin'::public.user_role
WHERE email = 'tomr1a@gmail.com';
