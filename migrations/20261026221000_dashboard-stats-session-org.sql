-- ============================================================================
-- dashboard-stats-session-org — dashboard_stats nunca más cross-tenant
-- ============================================================================
-- Additive, idempotente, dueña de la rama fix/dashboard-stats-org-scope.
--
-- Contexto (hallazgo T1 del onboarding de Original Express): dashboard_stats es
-- SECURITY DEFINER pero solo gateaba con is_staff(); el filtro de org era
-- `p_org is null or organization_id = p_org`, así que cualquier staff podía
-- llamar con p_org=null (agregados de TODOS los tenants) o con p_org ajeno
-- (agregados de otro tenant). El panel siempre pasa user.agency, pero la RPC
-- quedaba abierta a queries construidas.
--
-- Fix: replica la política de resolveOrg() del config-module — admin/billing
-- pueden pedir otra agencia (dashboard view legítimo); cualquier otro rol queda
-- pineado a su session_agency(), sin importar el p_org enviado. Firma idéntica
-- (4 args) para no reintroducir la ambigüedad PGRST203 de 20260904120000.
--
-- Sin cambio de contrato: el panel sigue llamando igual (p_org = user.agency);
-- para admin/billing el resultado es el mismo; para staff/viewer queda aislado.

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