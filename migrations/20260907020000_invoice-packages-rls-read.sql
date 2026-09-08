-- ============================================================================
-- invoice_packages: staff read policy for authenticated users (org-scoped)
-- ============================================================================
-- Previously invoice_packages had zero SELECT policies (default-deny), so the
-- PostgREST embed invoice_packages(invoice_id) in listPackages/getPackageDetail
-- returned empty for all authenticated users. This prevented the panel from
-- detecting already-invoiced packages in the UI (client-side pre-validation).
-- The Worker uses admin key (bypasses RLS) and was unaffected.

-- Idempotent: this migration was applied out-of-band (tracker missed it), so
-- `migrations up --all` re-runs it. Drop-then-create matches the policy pattern
-- in 20260905010000 and makes the chain resumable.
DROP POLICY IF EXISTS staff_read_org_invoice_packages ON public.invoice_packages;

CREATE POLICY staff_read_org_invoice_packages ON public.invoice_packages
  FOR SELECT
  TO authenticated
  USING (organization_id = (SELECT public.session_agency()));

COMMENT ON POLICY staff_read_org_invoice_packages ON public.invoice_packages IS
  'Staff can read invoice package links for their own agency only.';
