-- ============================================================================
-- Customer lifecycle fields on billing_clients
-- ============================================================================
-- Phase 1 of the customer module (panel → Clientes / Orbit). Adds three columns,
-- all nullable/defaulted so existing rows and every current read/write path keep
-- working untouched:
--
--   * company_name — company / sub-agency the client belongs to (nullable:
--     personal clients carry none). Extra client info beyond the contact fields.
--   * tax_id       — tax identifier (cédula / RUC) of the client or its company.
--   * active       — lifecycle state. false = deactivated: the client drops out
--     of autoload/autocomplete and its packages fall out of dashboard range
--     until reactivated (the derived exclusion lands with the consumer code,
--     not here). true (default) = active. Historical invoices and relations are
--     preserved either way — this is a soft-delete, never a DELETE.
--
-- `to_review` stays an INDEPENDENT visual flag (review badge in the table) and is
-- deliberately NOT folded into `active`: a client can be reviewed and active, or
-- inactive and clean, independently.
--
-- Additive-only. Owned by branch feat/ever2-customer-lifecycle (one migration per
-- PR). Apply via `npx @insforge/cli db migrations up --all`.

ALTER TABLE billing_clients
  ADD COLUMN IF NOT EXISTS company_name text,
  ADD COLUMN IF NOT EXISTS tax_id text,
  ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;

-- Tenant-scoped lifecycle lookups (status filters, inactive exclusion) hit this.
CREATE INDEX IF NOT EXISTS idx_billing_clients_org_active
  ON billing_clients (organization_id, active);

COMMENT ON COLUMN billing_clients.company_name IS
  'Company / sub-agency this client belongs to (nullable: personal clients have none).';
COMMENT ON COLUMN billing_clients.tax_id IS
  'Tax identifier (cédula / RUC) of the client or its company.';
COMMENT ON COLUMN billing_clients.active IS
  'Lifecycle state. false = deactivated: excluded from autoload/autocomplete and its packages fall out of dashboard range until reactivated.';
