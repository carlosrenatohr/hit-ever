-- ============================================================================
-- Tenant scoping for packages -- organization_id -> agencies(slug)
-- ============================================================================
-- Additive migration. Follows ADR-009 (multi-tenancy: tenant-scoped entities
-- carry organization_id -> agencies).
--
-- Provider -> tenant mapping (based on providers.code):
--   'everest'            -> 'hit'    (Everest Logistics, mailbox 37458)
--   'global_connection'  -> 'suite'  (Global Connection)
--   'suite_demo'         -> 'suite'  (Suite demo provider)
-- Any unknown provider defaults to 'hit' (the original HIT tenant).
--
-- Backfill strategy: existing packages are assigned by joining through providers.
-- Future scrapes set organization_id via toPackageRow() in ingest.ts.
--
-- Security: staff_read_packages uses is_staff() (admin|staff|viewer) like the
-- other read policies. The panel enforces tenant filtering client-side by
-- appending organization_id = eq.<agency> to the PostgREST query; the Worker's
-- public /track/:id endpoint resolves the package and returns it regardless
-- of tenant (public tracking -- no auth), but the panel is the only consumer
-- that enforces isolation.
--
-- WARNING: this migration is applied on top of the config-module migrations
-- that created the agencies table and the RLS policies. The packages table
-- is ALREADY RLS-enabled (db/0001_init.sql line 127).
-- ============================================================================

-- --- Add column ---
-- Default 'hit' preserves backward compatibility for any edge case during deploy.
alter table public.packages
  add column if not exists organization_id text not null default 'hit' references agencies(slug);

-- --- Backfill existing packages by provider -> agency mapping ---
-- Map known provider codes to their tenant. Unknown providers default to 'hit'.
-- Idempotent: only updates rows that still have the default 'hit' value.
update public.packages
set organization_id = (
  case p.code
    when 'everest'            then 'hit'
    when 'global_connection'  then 'suite'
    when 'suite_demo'         then 'suite'
    else 'hit'
  end
)
from public.providers p
where packages.provider_id = p.id
  and packages.organization_id = 'hit';

-- --- Index for tenant-scoped queries ---
create index if not exists idx_packages_org on public.packages (organization_id);
create index if not exists idx_packages_org_status on public.packages (organization_id, effective_status);

-- --- Tenant-scoped dashboard_stats (additive) ---
-- The original dashboard_stats() (20260623015746) returns global aggregates.
-- The panel now calls dashboard_stats(p_org) with the logged-in user's agency
-- to get tenant-scoped KPIs. CREATE OR REPLACE makes the new signature
-- backward-compatible: callers that omit p_org get NULL = "all tenants".
create or replace function public.dashboard_stats(p_org text default null)
  returns json language sql stable security definer set search_path = public, auth as $$
  select case when public.is_staff() then json_build_object(
    'total',        (select count(*) from public.packages p where p_org is null or p.organization_id = p_org),
    'by_status',    (select coalesce(json_object_agg(s, c), '{}'::json) from (
                       select coalesce(manual_status, status)::text s, count(*) c
                       from public.packages p
                       where p_org is null or p.organization_id = p_org
                       group by 1) t),
    'by_provider',  (select coalesce(json_object_agg(code, c), '{}'::json) from (
                       select pr.code, count(*) c
                       from public.packages p join public.providers pr on pr.id = p.provider_id
                       where p_org is null or p.organization_id = p_org
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
grant execute on function public.dashboard_stats(text) to authenticated;

-- ── Verify backfill ──────────────────────────────────────────────────────────
-- Existing policy staff_read already allows is_staff() reads; the panel
-- enforces tenant filtering client-side via organization_id=eq.<agency>.
-- Idempotency check: report any unmapped organization_ids.
select count(*) as unmapped
from public.packages
where organization_id not in (select slug from public.agencies);
