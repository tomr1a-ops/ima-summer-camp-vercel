-- Expose camp tables to Supabase Realtime so admin.html can live-refresh on registration changes.
-- RLS still applies: only rows visible to the subscriber are sent (admins see all enrollments/campers).

ALTER PUBLICATION supabase_realtime ADD TABLE public.enrollments;
ALTER PUBLICATION supabase_realtime ADD TABLE public.campers;
ALTER PUBLICATION supabase_realtime ADD TABLE public.days;
ALTER PUBLICATION supabase_realtime ADD TABLE public.weeks;
ALTER PUBLICATION supabase_realtime ADD TABLE public.inventory_items;
