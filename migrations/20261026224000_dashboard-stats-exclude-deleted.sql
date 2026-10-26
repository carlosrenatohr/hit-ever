-- ============================================================================
-- dashboard-stats-exclude-deleted — last_scraped nunca lee paquetes borrados
-- ============================================================================
-- Additive, idempotente, dueña de la rama fix/customer-package-count-deleted.
--
-- Contexto: delete_package marca deleted_at (soft delete) y las lecturas
-- operativas lo excluyen, pero el subquery `last_scraped` de dashboard_stats
-- hacía max(scraped_at) SIN filtrar → el "último scrapeo" de la agencia podía
-- provenir de un paquete eliminado y sobrevivir a borrar lo más reciente.
--
-- Los demás subqueries (total, by_status, by_provider, delivered_30d) ya
-- filtran desde 20260908233000_package-soft-delete.sql. Solo agrega el
-- predicado faltante; firma idéntica (4 args, sin ambigüedad PGRST203).
-- Multitenant: el org sigue resolviéndose en session_org (admin/billing pueden
-- ver otra agencia; el resto queda pineado a session_agency()).

create or replace function public.dashboard_stats(
  p_org    text default null,
  p_from   date default null,
  p_to     date default null,
  p_status text default null
)
  returns json language sql stable security definer set search_path = public, auth as $$
  with session_org as (
    select case
             when a.role in ('admin', 'billing') and p_org is not null then p_org
             else a.agency
           end as agency
    from public.app_users a
    where a.id = (select auth.uid())
  )
  select case when public.is_staff() then json_build_object(
    'total',        (select count(*) from public.packages p
                     where p.organization_id = (select agency from session_org)
                       and (p_from is null or p.received_at >= p_from)
                       and (p_to is null or p.received_at < p_to + 1)
                       and (p_status is null or coalesce(p.manual_status, p.status)::text = p_status)
                       and public.client_is_active(p.client_id)
                       and p.deleted_at is null),
    'by_status',    (select coalesce(json_object_agg(s, c), '{}'::json) from (
                       select coalesce(manual_status, status)::text s, count(*) c
                       from public.packages p
                       where p.organization_id = (select agency from session_org)
                         and (p_from is null or p.received_at >= p_from)
                         and (p_to is null or p.received_at < p_to + 1)
                         and (p_status is null or coalesce(p.manual_status, p.status)::text = p_status)
                         and public.client_is_active(p.client_id)
                         and p.deleted_at is null
                       group by 1) t),
    'by_provider',  (select coalesce(json_object_agg(code, c), '{}'::json) from (
                       select pr.code, count(*) c
                       from public.packages p join public.providers pr on pr.id = p.provider_id
                       where p.organization_id = (select agency from session_org)
                         and (p_from is null or p.received_at >= p_from)
                         and (p_to is null or p.received_at < p_to + 1)
                         and (p_status is null or coalesce(p.manual_status, p.status)::text = p_status)
                         and public.client_is_active(p.client_id)
                         and p.deleted_at is null
                       group by pr.code) t),
    'last_scraped', (select coalesce(json_object_agg(code, ls), '{}'::json) from (
                       select pr.code, max(p.scraped_at) ls
                       from public.packages p join public.providers pr on pr.id = p.provider_id
                       where p.organization_id = (select agency from session_org)
                         and p.deleted_at is null
                       group by pr.code) t),
    'delivered_30d',(select count(*) from public.packages p
                     where coalesce(manual_status, status) = 'entregado'
                       and coalesce(last_event_at, received_at) > now() - interval '30 days'
                       and p.organization_id = (select agency from session_org)
                       and public.client_is_active(p.client_id)
                       and p.deleted_at is null)
  ) else null end
$$;

grant execute on function public.dashboard_stats(text, date, date, text) to authenticated;
