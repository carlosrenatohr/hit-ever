-- RLS hardening: org-scoped reads for packages and child tables (Phase 0.7)
--
-- Before: `staff_read` policies only required is_staff() OR
-- has_permission('shipments:read'), so any staff user could read packages
-- (and their events/notes/tags) of EVERY agency by querying the table
-- directly. Tenant isolation relied on the panel adding
-- `organization_id=eq.<agency>` client-side, which a crafted query bypasses.
--
-- After: reads derive the organization server-side from the session
-- (app_users.agency via auth.uid()). Cross-tenant reads become impossible
-- at the database level, regardless of the client's filters.
--
-- Data audit (pre-migration, 2026-09-05): packages org distribution clean
-- (hit=319, suite=40, solo-guegue=12; no NULLs, no orphan orgs). Child
-- tables have no orphaned rows. 13 legacy invoice_packages links
-- (hit invoices <-> suite demo packages) predate tenant isolation;
-- invoice_packages has no SELECT policies (default-deny) so they leak
-- nothing and are left untouched.
--
-- Deliberate decisions:
-- - The Worker uses the admin key (bypasses RLS) and scopes by org itself;
--   panel RPCs are SECURITY DEFINER and derive the org server-side. Both
--   unaffected.
-- - `invoice_packages` keeps zero SELECT policies (default-deny for
--   anon/authenticated): invoice linkage is only exposed through the
--   org-scoped Worker API.
-- - `providers` and `provider_agencies` keep their is_staff() read policy:
--   operational carrier metadata and routing config, no tenant PII.
-- - Helpers are SECURITY DEFINER with pinned search_path to avoid
--   recursive RLS evaluation against app_users/packages.

-- Session agency: resolves the caller's organization from app_users.
CREATE OR REPLACE FUNCTION public.session_agency()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT agency FROM public.app_users WHERE id = (SELECT auth.uid())
$$;

-- Package readable by the session's agency (parent lookup for child tables).
CREATE OR REPLACE FUNCTION public.can_access_package(p_package_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.packages pkg
    WHERE pkg.id = p_package_id
      AND pkg.organization_id = (SELECT public.session_agency())
  )
$$;

GRANT EXECUTE ON FUNCTION public.session_agency() TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_access_package(uuid) TO authenticated;

-- packages: read only rows of the session agency.
DROP POLICY IF EXISTS staff_read ON public.packages;
CREATE POLICY staff_read_org ON public.packages
  FOR SELECT
  TO authenticated
  USING (organization_id = (SELECT public.session_agency()));

-- events: only rows of packages in the session agency.
DROP POLICY IF EXISTS staff_read ON public.events;
CREATE POLICY staff_read_org ON public.events
  FOR SELECT
  TO authenticated
  USING (public.can_access_package(package_id));

-- package_notes: only rows of packages in the session agency.
DROP POLICY IF EXISTS staff_read ON public.package_notes;
CREATE POLICY staff_read_org ON public.package_notes
  FOR SELECT
  TO authenticated
  USING (public.can_access_package(package_id));

-- package_tags: only rows of packages in the session agency.
DROP POLICY IF EXISTS staff_read ON public.package_tags;
CREATE POLICY staff_read_org ON public.package_tags
  FOR SELECT
  TO authenticated
  USING (public.can_access_package(package_id));

-- package_provider_notes: only rows of packages in the session agency.
DROP POLICY IF EXISTS staff_read ON public.package_provider_notes;
CREATE POLICY staff_read_org ON public.package_provider_notes
  FOR SELECT
  TO authenticated
  USING (public.can_access_package(package_id));

COMMENT ON FUNCTION public.session_agency IS
  'RLS helper: agency (organization slug) of the authenticated user; SECURITY DEFINER to avoid recursive policy evaluation on app_users.';
COMMENT ON FUNCTION public.can_access_package IS
  'RLS helper: true when the package belongs to the session agency; SECURITY DEFINER to avoid recursive policy evaluation on packages.';
