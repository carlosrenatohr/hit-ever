-- ============================================================================
-- invoice_packages: staff read policy for authenticated users (org-scoped)
-- ============================================================================
-- Previously invoice_packages had zero SELECT policies (default-deny), so the
-- PostgREST embed invoice_packages(invoice_id) in listPackages/getPackageDetail
-- returned empty for all authenticated users. This prevented the panel from
-- detecting already-invoiced packages in the UI (client-side pre-validation).
-- The Worker uses admin key (bypasses RLS) and was unaffected.

CREATE POLICY staff_read_org_invoice_packages ON public.invoice_packages
  FOR SELECT
  TO authenticated
  USING (organization_id = (SELECT public.session_agency()));

COMMENT ON POLICY staff_read_org_invoice_packages ON public.invoice_packages IS
  'Staff can read invoice package links for their own agency only.';
