-- ============================================================================
-- Client soft delete (billing_clients) — phase 1 of the soft-delete rollout
-- ============================================================================
-- Deletes for the Clients module are NEVER physical. `DELETE /clients/:id` marks
-- the row as deleted (deleted_at) and hides it from every operational read:
-- list/autocomplete, new invoices, rate defaults. Historical relations are
-- preserved verbatim:
--   * packages.client_id   — the client's packages keep their assignment.
--   * invoices.client_id   — historical invoices keep their client link.
--   * invoice_line_items snapshots — already immutable at billing time.
-- The existing FK `ON DELETE SET NULL` constraints never fire (there is no
-- physical DELETE), so nothing is silently unlinked.
--
-- `deleted_at` is intentionally distinct from `active`: active=false is the
-- "deactivated, can come back" lifecycle state (still listed under the status
-- filter). deleted_at = now() is terminal for operational purposes; a dedicated
-- restore path is future work (see backlog). An "archived" state (paused but
-- visible) is reserved as a separate column later — do not overload this one.
--
-- Additive-only. One migration per branch. Apply via
-- `npx @insforge/cli db migrations up --all`.

ALTER TABLE billing_clients
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by text,
  ADD COLUMN IF NOT EXISTS delete_reason text;

-- Operational list/autocomplete filter on (organization_id) + deleted_at IS NULL.
CREATE INDEX IF NOT EXISTS idx_billing_clients_org_active_deleted
  ON billing_clients (organization_id, deleted_at)
  WHERE deleted_at IS NULL;

COMMENT ON COLUMN billing_clients.deleted_at IS
  'Soft delete timestamp. Non-NULL = client removed from operational reads (list, autocomplete, new invoices); historical packages and invoices keep their link. Terminal for operations; restore is future work.';
COMMENT ON COLUMN billing_clients.deleted_by IS
  'Actor (user id / system tag) that soft-deleted this client.';
COMMENT ON COLUMN billing_clients.delete_reason IS
  'Free-text reason captured at soft-delete time (audit + dialog context).';