-- ============================================================================
-- Fix: customer_aggregate_stats top clients ignore unassigned packages
-- ============================================================================
-- The top-client subqueries ordered by summed weight with `nulls last limit 1`.
-- When the heaviest packages have client_id NULL (unassigned), the winner is an
-- unassigned row, and the join to billing_clients yields nothing → topMaritimo/
-- topAereo came back null. Fix: only rank packages that actually belong to a
-- client (client_id IS NOT NULL). Totals keep counting everything.
--
-- Additive-only (CREATE OR REPLACE). Apply via
-- `npx @insforge/cli db migrations up --all`.

create or replace function public.customer_aggregate_stats(
  p_org  text,
  p_from date default null,
  p_to   date default null
)
  returns json language sql stable security definer set search_path = public, auth as $$
  select json_build_object(
    'totalWeightLb',       coalesce(sum(p.weight_lb), 0),
    'weightMaritimo',      coalesce(sum(p.weight_lb) filter (where p.service_type = 'maritimo'), 0),
    'weightAereo',         coalesce(sum(p.weight_lb) filter (where p.service_type = 'aereo'), 0),
    'packageCountTotal',   count(*),
    'packageCountMaritimo', count(*) filter (where p.service_type = 'maritimo'),
    'packageCountAereo',   count(*) filter (where p.service_type = 'aereo'),
    'topMaritimo', (select json_build_object('clientId', c.id, 'name', c.name, 'weightLb', t.w)
                    from (select p.client_id, sum(p.weight_lb) w
                          from public.packages p
                          where p.organization_id = p_org
                            and p.deleted_at is null
                            and p.client_id is not null
                            and public.client_is_active(p.client_id)
                            and p.service_type = 'maritimo'
                            and (p_from is null or p.received_at >= p_from)
                            and (p_to is null or p.received_at < p_to + 1)
                          group by p.client_id order by w desc nulls last limit 1) t
                    join public.billing_clients c on c.id = t.client_id),
    'topAereo', (select json_build_object('clientId', c.id, 'name', c.name, 'weightLb', t.w)
                 from (select p.client_id, sum(p.weight_lb) w
                       from public.packages p
                       where p.organization_id = p_org
                         and p.deleted_at is null
                         and p.client_id is not null
                         and public.client_is_active(p.client_id)
                         and p.service_type = 'aereo'
                         and (p_from is null or p.received_at >= p_from)
                         and (p_to is null or p.received_at < p_to + 1)
                       group by p.client_id order by w desc nulls last limit 1) t
                 join public.billing_clients c on c.id = t.client_id)
  )
  from public.packages p
  where p.organization_id = p_org
    and p.deleted_at is null
    and public.client_is_active(p.client_id)
    and (p_from is null or p.received_at >= p_from)
    and (p_to is null or p.received_at < p_to + 1)
$$;

grant execute on function public.customer_aggregate_stats(text, date, date) to authenticated;