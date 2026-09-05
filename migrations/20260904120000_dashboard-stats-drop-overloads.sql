-- ============================================================================
-- Fix: drop legacy dashboard_stats overloads (PostgREST ambiguity)
-- ============================================================================
-- With three overloads (( ), (text), (text, date, date, text)) PostgREST cannot
-- resolve rpc('dashboard_stats', { p_org }) — PGRST203. Keep ONLY the 4-arg
-- signature (its optional params cover the old call shapes exactly: no args,
-- or p_org only). Functions only — no data touched.
drop function if exists public.dashboard_stats();
drop function if exists public.dashboard_stats(text);

grant execute on function public.dashboard_stats(text, date, date, text) to authenticated;
