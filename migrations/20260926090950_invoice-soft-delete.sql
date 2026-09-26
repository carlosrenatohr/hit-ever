-- ============================================================================
-- Invoice soft delete (invoices) — archive for Facturación
-- ============================================================================
-- Archiving an invoice is NEVER physical (mirrors billing_clients soft delete,
-- migrations/20260908230000_client-soft-delete.sql): `POST /invoices/:id/archive`
-- stamps deleted_at and hides the invoice from every operational read:
--   * listInvoices        — the Facturación table (count included).
--   * getInvoiceBundle    — GET/PATCH detail, payments, close, void, share and
--                           package link/unlink all resolve through it, so every
--                           mutation on an archived invoice 404s.
--   * getBundlesByDateRange / getExceptions — reports and the exception queue.
--   * getPublicBundle     — the public receipt (`/billing/r/:token` → 404).
-- Historical data is preserved verbatim (line items, payments, links, events);
-- the existing FK constraints never fire (no physical DELETE), so nothing is
-- silently unlinked. A dedicated restore path is future work — do not overload
-- `status` (VOID) with this: VOID is a fiscal state, deleted_at is removal from
-- operations.
--
-- Archiving releases the invoice's ACTIVE package links (released_by
-- 'system:archive', the exact VOID mechanism) so the packages become
-- re-invoiceable again. Without that, archiving a mistaken DRAFT would trap its
-- packages forever: the invoice itself is no longer reachable to void/unlink.
--
-- Additive-only. One migration per branch (owner: feat/invoice-archive). Apply
-- via `npx @insforge/cli db migrations up --all`.

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by text,
  ADD COLUMN IF NOT EXISTS delete_reason text;

-- Operational list/reports filter on (organization_id) + deleted_at IS NULL.
CREATE INDEX IF NOT EXISTS idx_invoices_org_active_deleted
  ON invoices (organization_id, deleted_at)
  WHERE deleted_at IS NULL;

COMMENT ON COLUMN invoices.deleted_at IS
  'Soft delete (archive) timestamp. Non-NULL = invoice removed from operational reads (list, detail, mutations, reports, public receipt). Restore is future work.';
COMMENT ON COLUMN invoices.deleted_by IS
  'Actor (user email / system tag) that archived this invoice.';
COMMENT ON COLUMN invoices.delete_reason IS
  'Free-text reason captured at archive time (audit + dialog context).';
