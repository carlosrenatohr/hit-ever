-- Fix PostgREST ambiguity: drop 3-arg overload of customer_aggregate_stats
-- Only the 4-arg version (with p_status) should exist.
-- PostgREST cannot resolve rpc('customer_aggregate_stats', { p_org }) when two
-- overloads exist (3-arg and 4-arg with defaults).

DROP FUNCTION IF EXISTS public.customer_aggregate_stats(text, date, date);

GRANT EXECUTE ON FUNCTION public.customer_aggregate_stats(text, date, date, text) TO authenticated;