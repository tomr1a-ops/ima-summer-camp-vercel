-- Clear optional extra-shirt paid flags (public.campers.extra_shirt_addon_paid).
-- There is no separate shirt table; Stripe checkout sets this when the add-on is purchased.
--
-- Uncomment ONE block and run in Supabase SQL editor (or psql).

-- All campers who have the flag set:
-- UPDATE public.campers SET extra_shirt_addon_paid = false WHERE extra_shirt_addon_paid = true;

-- Single camper:
-- UPDATE public.campers SET extra_shirt_addon_paid = false WHERE id = 'PASTE-CAMPER-UUID';
