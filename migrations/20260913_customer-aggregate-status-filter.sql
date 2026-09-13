-- customer_aggregate_stats: add p_status filter for KPI cards
-- Aditive. Owned by branch feat/customer-stats-status-filter.

-- ─── 1. client_matches_status: filter by lifecycle status ────────────────────
CREATE OR REPLACE FUNCTION public.client_matches_status(p_client_id uuid, p_status text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT p_client_id IS NULL OR EXISTS (
    SELECT 1 FROM public.billing_clients c
    WHERE c.id = p_client_id
      AND c.deleted_at IS NULL
      AND (
        p_status IS NULL
        OR (p_status = 'active'   AND c.active = true)
        OR (p_status = 'inactive' AND c.active = false)
        OR (p_status = 'review'   AND c.to_review = true)
      )
  )
$$;

COMMENT ON FUNCTION public.client_matches_status(uuid, text) IS
  'Lifecycle status filter: null=all non-deleted, active/inactive/review. SECURITY DEFINER to read billing_clients.';

GRANT EXECUTE ON FUNCTION public.client_matches_status(uuid, text) TO authenticated;

-- ─── 2. customer_aggregate_stats: accept p_status ───────────────────────────
CREATE OR REPLACE FUNCTION public.customer_aggregate_stats(
  p_org    text,
  p_from   date default null,
  p_to     date default null,
  p_status text default null
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
                    from (select p2.client_id, sum(p2.weight_lb) w
                          from public.packages p2
                          where p2.organization_id = p_org
                            and p2.deleted_at is null
                            and public.client_matches_status(p2.client_id, p_status)
                            and p2.service_type = 'maritimo'
                            and (p_from is null or p2.received_at >= p_from)
                            and (p_to is null or p2.received_at < p_to + 1)
                          group by p2.client_id order by w desc nulls last limit 1) t
                    join public.billing_clients c on c.id = t.client_id),
    'topAereo', (select json_build_object('clientId', c.id, 'name', c.name, 'weightLb', t.w)
                 from (select p3.client_id, sum(p3.weight_lb) w
                       from public.packages p3
                       where p3.organization_id = p_org
                         and p3.deleted_at is null
                         and public.client_matches_status(p3.client_id, p_status)
                         and p3.service_type = 'aereo'
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

GRANT EXECUTE ON FUNCTION public.customer_aggregate_stats(text, date, date, text) TO authenticated;
