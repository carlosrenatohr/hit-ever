-- ============================================================================
-- Inactive-client visibility scope (customer lifecycle, phase 3)
-- ============================================================================
-- Packages of a deactivated client fall out of the dashboard range until the
-- client is reactivated. They are never deleted — the soft-delete stays on
-- billing_clients.active and every historical relation (invoices, links) is
-- preserved.
--
-- Two read paths consumed the panel:
--   1. Direct panel reads (Shipments / Reports / detail) go through the
--      `staff_read_org` RLS policy on packages → extend it with an
--      active-client condition.
--   2. The Overview aggregates come from `dashboard_stats()` (SECURITY
--      DEFINER — bypasses RLS) → same condition inside the function.
--
-- `client_is_active()` is a SECURITY DEFINER helper so the policy can read
-- billing_clients (default-deny RLS) regardless of the calling role — same
-- pattern as session_agency()/can_access_package() in 20260905010000.
-- Packages with client_id NULL (no billing client assigned) stay visible.
--
-- last_scraped stays unfiltered on purpose: it is provider ingest health, not
-- package data (same decision as the existing dashboard_stats filters).
--
-- Additive-only (policy drop/recreate is the established idempotent way to
-- change a policy — see 20260905010000). Owned by branch
-- feat/ever2-customer-lifecycle. Apply via `npx @insforge/cli db migrations up --all`.

-- ─── 1. Active-client helper (bypasses RLS on billing_clients) ───────────────
CREATE OR REPLACE FUNCTION public.client_is_active(p_client_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT p_client_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.billing_clients c
    WHERE c.id = p_client_id AND c.active = false
  )
$$;

COMMENT ON FUNCTION public.client_is_active(uuid) IS
  'True when a package is visible: it has no billing client, or its client is active. SECURITY DEFINER so RLS policies can read billing_clients (default-deny).';

GRANT EXECUTE ON FUNCTION public.client_is_active(uuid) TO authenticated;

-- ─── 2. Packages RLS: hide deactivated clients' packages ──────────────────────
DROP POLICY IF EXISTS staff_read_org ON public.packages;
CREATE POLICY staff_read_org ON public.packages
  FOR SELECT
  TO authenticated
  USING (
    organization_id = (SELECT public.session_agency())
    AND public.client_is_active(client_id)
  );

-- ─── 3. dashboard_stats: same scope on the aggregate paths ────────────────────
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
                       and public.client_is_active(p.client_id)),
    'by_status',    (select coalesce(json_object_agg(s, c), '{}'::json) from (
                       select coalesce(manual_status, status)::text s, count(*) c
                       from public.packages p
                       where (p_org is null or p.organization_id = p_org)
                         and (p_from is null or p.received_at >= p_from)
                         and (p_to is null or p.received_at < p_to + 1)
                         and (p_status is null or coalesce(manual_status, status)::text = p_status)
                         and public.client_is_active(p.client_id)
                       group by 1) t),
    'by_provider',  (select coalesce(json_object_agg(code, c), '{}'::json) from (
                       select pr.code, count(*) c
                       from public.packages p join public.providers pr on pr.id = p.provider_id
                       where (p_org is null or p.organization_id = p_org)
                         and (p_from is null or p.received_at >= p_from)
                         and (p_to is null or p.received_at < p_to + 1)
                         and (p_status is null or coalesce(p.manual_status, p.status)::text = p_status)
                         and public.client_is_active(p.client_id)
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
                         and public.client_is_active(p.client_id))
  ) else null end
$$;

grant execute on function public.dashboard_stats(text, date, date, text) to authenticated;