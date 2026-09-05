-- ============================================================================
-- T1+T2: Tenant isolation for billing — add organization_id to all billing tables
-- ============================================================================
-- Every billing table gets an organization_id column so each agency only sees
-- its own invoices, line items, payments, package links, and clients.
-- Default 'hit' preserves existing data (all current rows belong to hit).
-- A backfill migration can reassign rows to other agencies later if needed.

-- ─── Invoices ──────────────────────────────────────────────────────────────────
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS organization_id TEXT NOT NULL DEFAULT 'hit'
  REFERENCES agencies(slug);

CREATE INDEX IF NOT EXISTS idx_invoices_org ON invoices (organization_id);
CREATE INDEX IF NOT EXISTS idx_invoices_org_status ON invoices (organization_id, status);
CREATE INDEX IF NOT EXISTS idx_invoices_org_year ON invoices (organization_id, fiscal_year);

-- ─── Invoice line items ────────────────────────────────────────────────────────
ALTER TABLE invoice_line_items
  ADD COLUMN IF NOT EXISTS organization_id TEXT NOT NULL DEFAULT 'hit'
  REFERENCES agencies(slug);

CREATE INDEX IF NOT EXISTS idx_line_items_org ON invoice_line_items (organization_id);

-- ─── Invoice payments ──────────────────────────────────────────────────────────
ALTER TABLE invoice_payments
  ADD COLUMN IF NOT EXISTS organization_id TEXT NOT NULL DEFAULT 'hit'
  REFERENCES agencies(slug);

CREATE INDEX IF NOT EXISTS idx_payments_org ON invoice_payments (organization_id);

-- ─── Invoice packages (join table) ─────────────────────────────────────────────
ALTER TABLE invoice_packages
  ADD COLUMN IF NOT EXISTS organization_id TEXT NOT NULL DEFAULT 'hit'
  REFERENCES agencies(slug);

CREATE INDEX IF NOT EXISTS idx_invoice_packages_org ON invoice_packages (organization_id);

-- ─── Billing clients ───────────────────────────────────────────────────────────
ALTER TABLE billing_clients
  ADD COLUMN IF NOT EXISTS organization_id TEXT NOT NULL DEFAULT 'hit'
  REFERENCES agencies(slug);

CREATE INDEX IF NOT EXISTS idx_billing_clients_org ON billing_clients (organization_id);

-- ─── Unique constraints: global → per-agency ───────────────────────────────────
-- Two global unique constraints would leak/merge data across agencies once more
-- than one agency uses billing:
--   * billing_clients.name_normalized unique → an upsert from agency B with the
--     same client name would MERGE into agency A's client row.
--   * invoices (fiscal_year, invoice_number) → agency B's invoice #1/2026 would
--     either collide (INSERT fails) or MERGE into agency A's invoice on import.
-- Swap both for composite constraints including organization_id. Data-preserving:
-- every existing row is 'hit', and names/numbers were unique globally, so they
-- remain unique within 'hit'.
ALTER TABLE billing_clients
  DROP CONSTRAINT IF EXISTS billing_clients_name_normalized_key;
ALTER TABLE billing_clients
  ADD CONSTRAINT billing_clients_org_name_normalized_key UNIQUE (organization_id, name_normalized);

ALTER TABLE invoices
  DROP CONSTRAINT IF EXISTS invoices_fiscal_year_invoice_number_key;
ALTER TABLE invoices
  ADD CONSTRAINT invoices_org_fiscal_year_invoice_number_key UNIQUE (organization_id, fiscal_year, invoice_number);

