-- Align customer_aggregate_stats top-client subqueries to effective_service_type
-- (resolves overridden service types via COALESCE logic defined in package-edit-rpcs).
-- Mirrors customer_weight_stats which already uses effective_service_type.
-- Multitenant: per-org (p_org), date-range (p_from/p_to), status filter (p_status).

CREATE OR REPLACE FUNCTION public.customer_aggregate_stats(
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
                            and (p_from is null or p2.received_at >= p_from)
                            and (p_to is null or p2.received_at < p_to + 1)
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
                         and (p_from is null or p3.received_at >= p_from)
                         and (p_to is null or p3.received_at < p_to + 1)
                       group by p3.client_id order by w desc nulls last limit 1) t
                 join public.billing_clients c on c.id = t.client_id)
  )
  from public.packages p
  where p.organization_id = p_org
    and p.deleted_at is null
    and public.client_matches_status(p.client_id, p_status)
    and (p_from is null or p.received_at >= p_from)
    and (p_to is null or p.received_at < p_to + 1)
$$;
