-- ============================================================================
-- Package soft delete — phase 3 of the soft-delete rollout
-- ============================================================================
-- Package deletes are NEVER physical. The panel calls the `delete_package` RPC
-- (SECURITY DEFINER) which sets deleted_at and audits; this migration lays the
-- columns down and makes every operational read hide deleted packages:
--
--   1. Columns: packages.deleted_at/deleted_by/delete_reason + partial index.
--   2. RLS: `staff_read_org` (panel direct reads) also requires deleted_at IS NULL.
--   3. dashboard_stats(): all package aggregates skip deleted rows.
--   4. RPC `delete_package(p_guia, p_reason)`: auth is_writer(), org from the
--      session, UPDATE (never DELETE), same-transaction audit with impact counts.
--
-- Historical relations are preserved verbatim: events, package_tags/notes/
-- provider_notes, invoice_packages links, invoice_line_items.package_id and the
-- guía/tracking snapshots all stay. The ingest upsert never writes deleted_at
-- (merge-duplicates only touches the columns it sends), so a re-scrape cannot
-- "resurrect" a deleted package.
--
-- `deleted_at` is distinct from `client_is_active` (inactive-client scope):
-- that one is about the CLIENT lifecycle; this one is terminal for the package.
--
-- Additive-only (policy drop/recreate is the established idempotent pattern,
-- see 20260905010000 / 20260907040000). Apply via
-- `npx @insforge/cli db migrations up --all`.

-- ─── 1. Columns ─────────────────────────────────────────────────────────────
ALTER TABLE packages
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by text,
  ADD COLUMN IF NOT EXISTS delete_reason text;

CREATE INDEX IF NOT EXISTS idx_packages_org_deleted
  ON packages (organization_id, deleted_at)
  WHERE deleted_at IS NULL;

COMMENT ON COLUMN packages.deleted_at IS
  'Soft delete timestamp. Non-NULL = package removed from operational reads (list, dashboard, billing eligibility, public track). Historical events/notes/links/invoice lines are preserved. Terminal; the ingest upsert never clears it.';
COMMENT ON COLUMN packages.deleted_by IS
  'Actor (user id / system tag) that soft-deleted this package.';
COMMENT ON COLUMN packages.delete_reason IS
  'Free-text reason captured at soft-delete time (audit + dialog context).';

-- ─── 2. RLS: panel direct reads hide deleted packages ────────────────────────
-- Copy of the current policy (org scope + inactive-client scope) plus the new
-- deleted condition. DROP + CREATE keeps the migration idempotent.
DROP POLICY IF EXISTS staff_read_org ON public.packages;
CREATE POLICY staff_read_org ON public.packages
  FOR SELECT
  TO authenticated
  USING (
    organization_id = (SELECT public.session_agency())
    AND public.client_is_active(client_id)
    AND deleted_at IS NULL
  );

-- ─── 3. dashboard_stats: skip deleted packages in every aggregate ─────────────
create or replace function public.dashboard_stats(
  p_org    text default null,
  p_from   date default null,
  p_to     date default null,
  p_status text default null
)
  returns json language sql stable security definer set search_path = public, auth as $$
  select case when public.is_staff() then json_build_object(
    'total',        (select count(*) from public.packages p
                     where (p_org is null or p.organization_id = p_org)
                       and (p_from is null or p.received_at >= p_from)
                       and (p_to is null or p.received_at < p_to + 1)
                       and (p_status is null or coalesce(p.manual_status, p.status)::text = p_status)
                       and public.client_is_active(p.client_id)
                       and p.deleted_at is null),
    'by_status',    (select coalesce(json_object_agg(s, c), '{}'::json) from (
                       select coalesce(manual_status, status)::text s, count(*) c
                       from public.packages p
                       where (p_org is null or p.organization_id = p_org)
                         and (p_from is null or p.received_at >= p_from)
                         and (p_to is null or p.received_at < p_to + 1)
                         and (p_status is null or coalesce(p.manual_status, p.status)::text = p_status)
                         and public.client_is_active(p.client_id)
                         and p.deleted_at is null
                       group by 1) t),
    'by_provider',  (select coalesce(json_object_agg(code, c), '{}'::json) from (
                       select pr.code, count(*) c
                       from public.packages p join public.providers pr on pr.id = p.provider_id
                       where (p_org is null or p.organization_id = p_org)
                         and (p_from is null or p.received_at >= p_from)
                         and (p_to is null or p.received_at < p_to + 1)
                         and (p_status is null or coalesce(p.manual_status, p.status)::text = p_status)
                         and public.client_is_active(p.client_id)
                         and p.deleted_at is null
                       group by pr.code) t),
    'last_scraped', (select coalesce(json_object_agg(code, ls), '{}'::json) from (
                       select pr.code, max(p.scraped_at) ls
                       from public.packages p join public.providers pr on pr.id = p.provider_id
                       where p_org is null or p.organization_id = p_org
                       group by pr.code) t),
    'delivered_30d',(select count(*) from public.packages p
                       where coalesce(manual_status, status) = 'entregado'
                         and coalesce(last_event_at, received_at) > now() - interval '30 days'
                         and (p_org is null or p.organization_id = p_org)
                         and public.client_is_active(p.client_id)
                         and p.deleted_at is null)
  ) else null end
$$;

grant execute on function public.dashboard_stats(text, date, date, text) to authenticated;

-- ─── 4. delete_package RPC (soft delete + audit, same transaction) ─────────────
create or replace function public.delete_package(
  p_guia   text,
  p_reason text default null
)
  returns json language plpgsql security definer set search_path = public, auth as $$
declare
  v_agency        text;
  v_by            text;
  v_pkg_id        uuid;
  v_pkg_org       text;
  v_pkg_client    uuid;
  v_active_invoice uuid;
  v_events        int;
  v_notes         int;
  v_tags          int;
  v_prov_notes    int;
  v_line_items    int;
begin
  -- 1. Authorization: admin|staff only (same gate as create_package)
  if not public.is_writer() then
    raise exception 'not authorized';
  end if;

  -- 2. Resolve agency + actor email from session
  select coalesce(email, 'panel'), coalesce(agency, 'hit')
    into v_by, v_agency
    from public.app_users where id = auth.uid();
  if v_agency is null then
    raise exception 'user has no agency';
  end if;

  -- 3. Resolve the package by guía within the session agency (deterministic: newest scraped)
  select id, organization_id, client_id
    into v_pkg_id, v_pkg_org, v_pkg_client
    from public.packages
    where almacen_id = p_guia
    order by scraped_at desc
    limit 1;
  if v_pkg_id is null then
    raise exception 'package not found';
  end if;
  if v_pkg_org is distinct from v_agency then
    raise exception 'package not found';
  end if;

  -- 4. Impact counts for the audit trail
  select count(*) into v_events     from public.events                  where package_id = v_pkg_id;
  select count(*) into v_notes      from public.package_notes           where package_id = v_pkg_id;
  select count(*) into v_tags       from public.package_tags            where package_id = v_pkg_id;
  select count(*) into v_prov_notes from public.package_provider_notes  where package_id = v_pkg_id;
  select count(*) into v_line_items from public.invoice_line_items      where package_id = v_pkg_id;
  select invoice_id into v_active_invoice
    from public.invoice_packages
    where package_id = v_pkg_id and active = true
    limit 1;

  -- 5. Soft delete (UPDATE, never DELETE). Idempotent: re-running on an
  --    already-deleted package is a no-op success (no resurrection).
  update public.packages
    set deleted_at = now(),
        deleted_by = v_by,
        delete_reason = p_reason,
        updated_at = now()
    where id = v_pkg_id;

  -- 6. Audit in the same transaction
  insert into public.audit_logs (
    organization_id, actor_id, actor_email, actor_type,
    action, entity_type, entity_id, metadata
  ) values (
    v_agency, auth.uid(), v_by, 'user',
    'package.delete', 'package', v_pkg_id::text,
    jsonb_build_object(
      'almacen_id', p_guia,
      'client_id', v_pkg_client::text,
      'active_invoice_id', v_active_invoice,
      'events', v_events,
      'notes', v_notes,
      'tags', v_tags,
      'provider_notes', v_prov_notes,
      'invoice_line_items', v_line_items,
      'reason', p_reason
    )
  );

  return json_build_object('id', v_pkg_id, 'almacen_id', p_guia, 'deleted', true);
end $$;

grant execute on function public.delete_package to authenticated;