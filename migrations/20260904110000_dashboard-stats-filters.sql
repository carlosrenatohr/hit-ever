-- ============================================================================
-- T28: dashboard_stats with optional date-range and status filters
-- ============================================================================
-- Overview only showed all-time aggregates. This widens the RPC with three
-- OPTIONAL params (defaults keep existing calls working):
--   p_from/p_to  — date range on received_at (p_to is inclusive: compared
--                  against p_to + 1 day, same trick as the panel's list filter)
--   p_status     — effective status (coalesce(manual_status, status))
-- last_scraped stays unfiltered: it is provider ingest-health, not package data.
-- Additive: CREATE OR REPLACE + a grant for the new signature.

create or replace function public.dashboard_stats(
  p_org    text default null,
  p_from   date default null,
  p_to     date default null,
  p_status text default null
)
  returns json language sql stable security definer set search_path = public, auth as $$
  select case when public.is_staff() then json_build_object(
    'total',        (select count(*) from public.packages p
                     where (p_org is null or p.organization_id = p_org)
                       and (p_from is null or p.received_at >= p_from)
                       and (p_to is null or p.received_at < p_to + 1)
                       and (p_status is null or coalesce(p.manual_status, p.status)::text = p_status)),
    'by_status',    (select coalesce(json_object_agg(s, c), '{}'::json) from (
                       select coalesce(manual_status, status)::text s, count(*) c
                       from public.packages p
                       where (p_org is null or p.organization_id = p_org)
                         and (p_from is null or p.received_at >= p_from)
                         and (p_to is null or p.received_at < p_to + 1)
                         and (p_status is null or coalesce(manual_status, status)::text = p_status)
                       group by 1) t),
    'by_provider',  (select coalesce(json_object_agg(code, c), '{}'::json) from (
                       select pr.code, count(*) c
                       from public.packages p join public.providers pr on pr.id = p.provider_id
                       where (p_org is null or p.organization_id = p_org)
                         and (p_from is null or p.received_at >= p_from)
                         and (p_to is null or p.received_at < p_to + 1)
                         and (p_status is null or coalesce(p.manual_status, p.status)::text = p_status)
                       group by pr.code) t),
    'last_scraped', (select coalesce(json_object_agg(code, ls), '{}'::json) from (
                       select pr.code, max(p.scraped_at) ls
                       from public.packages p join public.providers pr on pr.id = p.provider_id
                       where p_org is null or p.organization_id = p_org
                       group by pr.code) t),
    'delivered_30d',(select count(*) from public.packages p
                       where coalesce(manual_status, status) = 'entregado'
                         and coalesce(last_event_at, received_at) > now() - interval '30 days'
                         and (p_org is null or p.organization_id = p_org))
  ) else null end
$$;

grant execute on function public.dashboard_stats(text, date, date, text) to authenticated;
