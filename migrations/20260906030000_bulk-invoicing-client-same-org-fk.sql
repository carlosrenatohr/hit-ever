-- ============================================================================
-- Bulk invoicing foundation — amendment 2: same-org client pin WITHOUT the
-- composite SET NULL FK (security-review follow-up on 20260906020000).
-- ============================================================================
-- 20260906020000 replaced packages_client_id_fkey with a composite FK
-- (organization_id, client_id) -> billing_clients (organization_id, id)
-- ON DELETE SET NULL. Postgres applies SET NULL to EVERY column of the
-- referencing list, so deleting a client would try to NULL packages.
-- organization_id (NOT NULL) -> the delete dies with 23502 (or silently
-- destroys tenant scoping if the column ever became nullable). Same-org
-- pinning is a WRITE-side property, so enforce it on write, not on delete:
--
--   1. Restore the single-column FK with ON DELETE SET NULL (a removed client
--      un-assigns its packages; organization_id is never touched).
--   2. A BEFORE trigger refuses client_id values whose client lives in a
--      different organization (belt-and-braces above the app layer, so no
--      code path — Worker, RPC or backfill — can ever pin a cross-tenant
--      client on a package row).
--
-- The billing_clients_org_id_uidx index from 20260906020000 is kept (cheap,
-- documents the org-scoped identity). Fully idempotent; forward-only.

-- 1. FK: drop the composite, restore the single-column SET NULL version.
alter table packages drop constraint if exists packages_client_id_org_fkey;
alter table packages
  add constraint packages_client_id_fkey
  foreign key (client_id) references billing_clients (id)
  on delete set null;

-- 2. Same-org write guard. SECURITY DEFINER + pinned search_path (same
--    pattern as session_agency() in 20260905010000): the existence check must
--    read billing_clients (default-deny RLS) regardless of the calling role.
create or replace function public.package_client_same_org()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if new.client_id is not null and not exists (
    select 1
    from public.billing_clients c
    where c.id = new.client_id
      and c.organization_id = new.organization_id
  ) then
    raise exception 'client_id % does not belong to organization %', new.client_id, new.organization_id;
  end if;
  return new;
end
$$;

comment on function public.package_client_same_org is
  'Tenant guard: refuses packages.client_id values owned by another organization (bulk invoicing).';

grant execute on function public.package_client_same_org() to authenticated;

drop trigger if exists packages_client_same_org on public.packages;
create trigger packages_client_same_org
  before insert or update of client_id on public.packages
  for each row execute function public.package_client_same_org();
