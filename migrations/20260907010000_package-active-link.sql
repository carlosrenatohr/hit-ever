-- ============================================================================
-- Package-level active link invariant: one active invoice per package.
-- ============================================================================
-- The previous schema only had unique(invoice_id, package_id), which prevented
-- duplicate links within the SAME invoice but allowed the same package to
-- appear in multiple invoices. This migration adds the active-link invariant:
--
--   1. invoice_packages.active (boolean, default true) — marks whether this
--      link is the current active one. When a VOID invoice releases its
--      packages, active is set to false.
--   2. invoice_packages.released_at / released_by — audit trail for when and
--      why a link was released (VOID or unlink).
--   3. Unique partial index on (package_id) WHERE active = true — enforces at
--      the database level that a package can have at most ONE active invoice
--      link at a time.
--
-- The index is partial (WHERE active = true) so that historical/released links
-- remain in the table for audit without blocking new invoices for the same
-- package after a VOID.
--
-- Backfill: all existing links are already active (default true). No data
-- migration needed — the default handles it.

-- ─── Columns ────────────────────────────────────────────────────────────────
ALTER TABLE invoice_packages
  ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;

ALTER TABLE invoice_packages
  ADD COLUMN IF NOT EXISTS released_at timestamptz;

ALTER TABLE invoice_packages
  ADD COLUMN IF NOT EXISTS released_by text;

COMMENT ON COLUMN invoice_packages.active IS
  'True while this link is the current active invoice for the package. Set to false on VOID or unlink. Partial unique index enforces one active link per package.';

COMMENT ON COLUMN invoice_packages.released_at IS
  'Timestamp when this link was released (active set to false). NULL for links that are still active.';

COMMENT ON COLUMN invoice_packages.released_by IS
  'Actor (email or system tag) that released this link. NULL for links that are still active.';

-- ─── Index ──────────────────────────────────────────────────────────────────
-- One active invoice per package. Concurrent inserts for the same package_id
-- will conflict at the index level — the second writer gets a 23505 error that
-- the service maps to PACKAGE_ALREADY_INVOICED.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_package_invoice
  ON invoice_packages (package_id)
  WHERE active = true;

-- ─── Audit index ────────────────────────────────────────────────────────────
-- Speed up "is this package already invoiced?" checks (the eligibility and
-- preview paths query by package_id + active).
CREATE INDEX IF NOT EXISTS idx_invoice_packages_active
  ON invoice_packages (package_id, active)
  WHERE active = true;
