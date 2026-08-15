-- ============================================================================
-- Fix: global_connection belongs to 'hit', not 'suite' + providers.organization_id
-- ============================================================================
-- Follow-up to 20260814233000_packages-tenant-scope.sql. That migration mapped
-- 'global_connection' -> 'suite', but GC is 100% HIT's account (db/0001_init.sql:
-- "Global Connection (user hitcargo): SAME Cargotrack engine"). The correct
-- provider -> tenant mapping is:
--   'everest'            -> 'hit'    (Everest Logistics, mailbox 37458)
--   'global_connection'  -> 'hit'    (GC — same HIT account, second Cargotrack engine)
--   'suite_demo'         -> 'suite'  (Suite demo provider)
--
-- This migration (additive, idempotent):
--   1. Adds providers.organization_id so the panel can list a tenant's providers
--      server-side (no more hardcoded client-side allowlists).
--   2. Backfills the column from the mapping above.
--   3. Re-assigns the wrongly-mapped GC packages back to 'hit'.
-- ============================================================================

-- --- 1. providers.organization_id (FK -> agencies.slug) ---
alter table public.providers
  add column if not exists organization_id text not null default 'hit' references agencies(slug);

-- --- 2. Backfill providers ---
-- Default is 'hit', so only the suite provider changes.
update public.providers
set organization_id = 'suite'
where code = 'suite_demo';

-- --- 3. Re-assign GC packages back to 'hit' ---
update public.packages pkg
set organization_id = 'hit',
    updated_at     = now()
from public.providers p
where p.id = pkg.provider_id
  and p.code = 'global_connection'
  and pkg.organization_id = 'suite';

-- --- Verify ---
select p.code as provider, p.organization_id as provider_org, count(*) as packages
from public.providers p
left join public.packages pkg on pkg.provider_id = p.id
group by p.code, p.organization_id
order by p.code;
