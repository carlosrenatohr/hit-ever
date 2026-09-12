-- ============================================================================
-- Customer module: weight/package aggregates by service + card stats + timeline
-- ============================================================================
-- The Clientes module needs, per client, summed weight and package count split
-- by service (aéreo/marítimo) within a reception-date range, plus aggregate
-- totals and top clients for the KPI cards, and a per-client event timeline.
--
--   1. client_is_active(): widen to also hide ARCHIVED clients' packages
--      (deleted_at IS NOT NULL). Packages of an archived client fall out of
--      every operational read (RLS staff_read_org + dashboard_stats) — point 5.
--   2. RPC customer_weight_stats(p_org, p_from, p_to): one row per client →
--      { weightMaritimo, weightAereo, countMaritimo, countAereo }, as a JSON
--      object keyed by client id. Single scan, single subrequest (no N+1).
--   3. RPC customer_aggregate_stats(p_org, p_from, p_to): totals + top client
--      by weight per service, for the KPI cards (also JSON).
--   4. Index on audit_logs(entity_type, entity_id, created_at) for the
--      per-client timeline reads.
--
-- Reception date = received_at (same column dashboard_stats filters on).
-- Both RPCs are SECURITY DEFINER and org-scoped via p_org (resolved from the
-- worker session server-side, never from the client).
--
-- Additive-only. Owned by branch feat/customer-weight-stats. Apply via
-- `npx @insforge/cli db migrations up --all`.

-- ─── 1. client_is_active(): hide archived clients' packages ──────────────────
CREATE OR REPLACE FUNCTION public.client_is_active(p_client_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT p_client_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.billing_clients c
    WHERE c.id = p_client_id
      AND (c.active = false OR c.deleted_at IS NOT NULL)
  )
$$;

COMMENT ON FUNCTION public.client_is_active(uuid) IS
  'True when a package is visible: no billing client, or its client is active AND not archived. SECURITY DEFINER so RLS policies can read billing_clients (default-deny).';

GRANT EXECUTE ON FUNCTION public.client_is_active(uuid) TO authenticated;

-- ─── 2. customer_weight_stats: per-client sums by service ─────────────────────
create or replace function public.customer_weight_stats(
  p_org  text,
  p_from date default null,
  p_to   date default null
)
  returns json language sql stable security definer set search_path = public, auth as $$
  select coalesce(json_object_agg(c.id::text, json_build_object(
    'weightMaritimo',  coalesce(g.wm, 0),
    'weightAereo',     coalesce(g.wa, 0),
    'countMaritimo',   coalesce(g.cm, 0),
    'countAereo',      coalesce(g.ca, 0)
  )), '{}'::json)
  from public.billing_clients c
  left join (
    select p.client_id,
           sum(p.weight_lb) filter (where p.service_type = 'maritimo') as wm,
           sum(p.weight_lb) filter (where p.service_type = 'aereo')    as wa,
           count(*)         filter (where p.service_type = 'maritimo') as cm,
           count(*)         filter (where p.service_type = 'aereo')    as ca
    from public.packages p
    where p.organization_id = p_org
      and p.deleted_at is null
      and public.client_is_active(p.client_id)
      and (p_from is null or p.received_at >= p_from)
      and (p_to is null or p.received_at < p_to + 1)
    group by p.client_id
  ) g on g.client_id = c.id
  where c.organization_id = p_org
    and c.deleted_at is null
$$;

grant execute on function public.customer_weight_stats(text, date, date) to authenticated;

-- ─── 3. customer_aggregate_stats: KPI totals + top clients ────────────────────
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

-- ─── 4. Timeline reads: audit_logs per entity ─────────────────────────────────
create index if not exists idx_audit_logs_entity
  on public.audit_logs (entity_type, entity_id, created_at desc);