-- Add top billing client subqueries to customer_aggregate_stats.
-- "Billing weight" = packages linked to non-VOID invoices via invoice_packages.
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
                                   and (p_from is null or p4.received_at >= p_from)
                                   and (p_to is null or p4.received_at < p_to + 1)
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
                                and (p_from is null or p5.received_at >= p_from)
                                and (p_to is null or p5.received_at < p_to + 1)
                              group by p5.client_id order by w desc nulls last limit 1) t
                        join public.billing_clients c on c.id = t.client_id)
  )
  from public.packages p
  where p.organization_id = p_org
    and p.deleted_at is null
    and public.client_matches_status(p.client_id, p_status)
    and (p_from is null or p.received_at >= p_from)
    and (p_to is null or p.received_at < p_to + 1)
$$;
