-- ============================================================================
-- manual-package-visibility — cliente visible (RLS) + libras cuentan en stats
-- ============================================================================
-- Additive, idempotente, dueña de la rama fix/manual-package-visibility.
--
-- Contexto (Original Express, operación 100% manual): dos síntomas tras el alta
-- manual de paquetes con cliente:
--   1. El cliente asignado no se ve en el detalle/lista de paquetes: los embeds
--      `billing_clients(name)` devolvían NULL porque billing_clients NO tenía
--      ninguna policy SELECT para authenticated (default-deny; el panel lee
--      clientes por el Worker). packages sí tiene staff_read_org, el embed no.
--   2. Las libras del paquete manual no sumaban en el detalle de clientes por
--      aéreo/marítimo: los paquetes sin "fecha de recepción" (received_at NULL,
--      campo opcional del modal) quedaban fuera del filtro de fechas de los RPC
--      de stats. packs no tiene created_at → fecha efectiva = updated_at.
--
-- Alcance (todo multitenant: las RPC operan sobre p_org resuelto server-side en
-- el Worker desde la sesión; la policy aplica session_agency()):
--   1. policy SELECT staff_read_org en billing_clients (org-scoped, authenticated).
--      Escrituras siguen siendo RPC/Worker-only (no se toca).
--   2. customer_weight_stats + customer_aggregate_stats: predicados de fecha con
--      coalesce(p.received_at, p.updated_at) — se cuentan paquetes con recepción
--      desconocida usando cuándo entraron al sistema. Cero cambio de contrato.

-- ─── 1. billing_clients: lectura org-scoped para authenticated ───────────────
drop policy if exists staff_read_org on public.billing_clients;
create policy staff_read_org on public.billing_clients
  for select
  to authenticated
  using (organization_id = (select public.session_agency()));

comment on policy staff_read_org on public.billing_clients is
  'Staff reads their own agency clients. Needed by the billing_clients(name) embeds on the packages list and detail (the panel still writes clients through the Worker).';

-- ─── 2. customer_weight_stats: per-client sums (aéreo/marítimo) ──────────────
create or replace function public.customer_weight_stats(
  p_org  text,
  p_from date default null,
  p_to   date default null
)
  returns json
  language sql
  stable
  security definer
  set search_path = public, auth
as $$
  select coalesce(json_object_agg(c.id, json_build_object(
    'clientId',       c.id,
    'name',           c.name,
    'weightLb',       coalesce(g.w, 0),
    'weightMaritimo', coalesce(g.wm, 0),
    'weightAereo',    coalesce(g.wa, 0),
    'countTotal',     coalesce(g.ct, 0),
    'countMaritimo',  coalesce(g.cm, 0),
    'countAereo',     coalesce(g.ca, 0)
  )), '{}'::json)
  from public.billing_clients c
  left join (
    select p.client_id,
           sum(p.weight_lb)                                                       as w,
           sum(p.weight_lb) filter (where p.effective_service_type = 'maritimo')  as wm,
           sum(p.weight_lb) filter (where p.effective_service_type = 'aereo')     as wa,
           count(*)                                                               as ct,
           count(*) filter (where p.effective_service_type = 'maritimo')          as cm,
           count(*) filter (where p.effective_service_type = 'aereo')             as ca
    from public.packages p
    where p.organization_id = p_org
      and p.deleted_at is null
      and public.client_is_active(p.client_id)
      and (p_from is null or coalesce(p.received_at, p.updated_at) >= p_from)
      and (p_to is null or coalesce(p.received_at, p.updated_at) < p_to + 1)
    group by p.client_id
  ) g on g.client_id = c.id
  where c.organization_id = p_org
    and c.deleted_at is null
$$;

grant execute on function public.customer_weight_stats(text, date, date) to authenticated;

-- ─── 3. customer_aggregate_stats: KPI totals + top clients ───────────────────
-- Mantiene la forma actual de 20260914170000 (p_status + effective_service_type +
-- topBilling + client_matches_status); solo cambian los predicados de fecha.
create or replace function public.customer_aggregate_stats(
  p_org    text,
  p_from   date default null,
  p_to     date default null,
  p_status text default null
)
returns json language sql stable
set search_path = public
as $$
  select json_build_object(
    'totalWeightLb',       coalesce(sum(p.weight_lb), 0),
    'weightMaritimo',      coalesce(sum(p.weight_lb) filter (where p.effective_service_type = 'maritimo'), 0),
    'weightAereo',         coalesce(sum(p.weight_lb) filter (where p.effective_service_type = 'aereo'), 0),
    'packageCountTotal',   count(*),
    'packageCountMaritimo', count(*) filter (where p.effective_service_type = 'maritimo'),
    'packageCountAereo',   count(*) filter (where p.effective_service_type = 'aereo'),
    'topMaritimo', (select json_build_object('clientId', c.id, 'name', c.name, 'weightLb', t.w)
                    from (select p2.client_id, sum(p2.weight_lb) w
                          from public.packages p2
                          where p2.organization_id = p_org
                            and p2.deleted_at is null
                            and p2.client_id is not null
                            and public.client_matches_status(p2.client_id, p_status)
                            and p2.effective_service_type = 'maritimo'
                            and (p_from is null or coalesce(p2.received_at, p2.updated_at) >= p_from)
                            and (p_to is null or coalesce(p2.received_at, p2.updated_at) < p_to + 1)
                          group by p2.client_id order by w desc nulls last limit 1) t
                    join public.billing_clients c on c.id = t.client_id),
    'topAereo', (select json_build_object('clientId', c.id, 'name', c.name, 'weightLb', t.w)
                 from (select p3.client_id, sum(p3.weight_lb) w
                       from public.packages p3
                       where p3.organization_id = p_org
                         and p3.deleted_at is null
                         and p3.client_id is not null
                         and public.client_matches_status(p3.client_id, p_status)
                         and p3.effective_service_type = 'aereo'
                         and (p_from is null or coalesce(p3.received_at, p3.updated_at) >= p_from)
                         and (p_to is null or coalesce(p3.received_at, p3.updated_at) < p_to + 1)
                       group by p3.client_id order by w desc nulls last limit 1) t
                 join public.billing_clients c on c.id = t.client_id),
    'topBillingMaritimo', (select json_build_object('clientId', c.id, 'name', c.name, 'weightLb', t.w)
                           from (select p4.client_id, sum(p4.weight_lb) w
                                 from public.packages p4
                                 inner join public.invoice_packages ip on ip.package_id = p4.id and ip.active = true
                                 inner join public.invoices i on i.id = ip.invoice_id and i.status <> 'VOID'
                                 where p4.organization_id = p_org
                                   and p4.deleted_at is null
                                   and p4.client_id is not null
                                   and public.client_matches_status(p4.client_id, p_status)
                                   and p4.effective_service_type = 'maritimo'
                                   and (p_from is null or coalesce(p4.received_at, p4.updated_at) >= p_from)
                                   and (p_to is null or coalesce(p4.received_at, p4.updated_at) < p_to + 1)
                                 group by p4.client_id order by w desc nulls last limit 1) t
                           join public.billing_clients c on c.id = t.client_id),
    'topBillingAereo', (select json_build_object('clientId', c.id, 'name', c.name, 'weightLb', t.w)
                        from (select p5.client_id, sum(p5.weight_lb) w
                              from public.packages p5
                              inner join public.invoice_packages ip on ip.package_id = p5.id and ip.active = true
                              inner join public.invoices i on i.id = ip.invoice_id and i.status <> 'VOID'
                              where p5.organization_id = p_org
                                and p5.deleted_at is null
                                and p5.client_id is not null
                                and public.client_matches_status(p5.client_id, p_status)
                                and p5.effective_service_type = 'aereo'
                                and (p_from is null or coalesce(p5.received_at, p5.updated_at) >= p_from)
                                and (p_to is null or coalesce(p5.received_at, p5.updated_at) < p_to + 1)
                              group by p5.client_id order by w desc nulls last limit 1) t
                        join public.billing_clients c on c.id = t.client_id)
  )
  from public.packages p
  where p.organization_id = p_org
    and p.deleted_at is null
    and public.client_matches_status(p.client_id, p_status)
    and (p_from is null or coalesce(p.received_at, p.updated_at) >= p_from)
    and (p_to is null or coalesce(p.received_at, p.updated_at) < p_to + 1)
$$;

grant execute on function public.customer_aggregate_stats(text, date, date, text) to authenticated;