-- ============================================================================
-- T8+T11: providers ↔ agencies M:N junction + dynamic agency assignment
-- ============================================================================
-- Phase 2 of the multi-agency plan. Today a provider belongs to exactly one
-- agency via the hardcoded PROVIDER_TENANT map in the Worker and the 1:N
-- providers.organization_id column. A junction table makes the mapping data
-- (a provider account can serve more than one agency), removes the code-level
-- map, and lets app_users.agency point at any agency that exists.

-- ─── 1. provider_agencies (junction) ────────────────────────────────────────
create table if not exists provider_agencies (
  provider_id uuid        not null references providers(id) on delete cascade,
  agency_slug text        not null references agencies(slug),
  created_at  timestamptz not null default now(),
  primary key (provider_id, agency_slug)
);
alter table provider_agencies enable row level security;
create policy staff_read_provider_agencies on provider_agencies
  for select to authenticated using (public.is_staff());

-- ─── 2. Seed from the current 1:N column ────────────────────────────────────
-- Derives the junction from providers.organization_id so the live mapping
-- (everest→hit, global_connection→solo-guegue after the demo reassignment,
-- suite_demo→suite) carries over untouched.
insert into provider_agencies (provider_id, agency_slug)
select id, organization_id from providers
on conflict (provider_id, agency_slug) do nothing;

-- ─── 3. app_users.agency: CHECK enum → FK to agencies ───────────────────────
-- The CHECK hardcodes the agency list in SQL (hit/suite/solo-guegue); every new
-- agency needed a migration. An FK accepts any agency that exists — dynamic by
-- construction. Data-preserving: every current value exists in agencies(slug).
alter table public.app_users
  drop constraint if exists app_users_agency_check;
alter table public.app_users
  add constraint app_users_agency_fkey
  foreign key (agency) references agencies(slug);

-- providers.organization_id stays for now (additive-only migrations) but is
-- DEPRECATED: the junction above is the source of truth. The panel reads the
-- junction; the Worker resolves the ingest tenant from it too.
