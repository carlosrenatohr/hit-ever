-- ============================================================================
-- Bulk invoicing foundation — amendment 1: DRAFT is the ONLY open state.
-- ============================================================================
-- Amendment to 20260906010000 (that file is already applied + tracked in the
-- prod migrations tracker, so it is never edited; the model is completed here).
--
-- The financial lock only makes sense with a complete closed-state invariant:
-- an invoice is open (editable) iff status = DRAFT and closed_at IS NULL.
-- Historically ISSUED has always meant "final" (the panel's "Nueva factura"
-- creates ISSUED directly and there is no other path to it), so every
-- non-DRAFT invoice is stamped closed here. Consequences:
--  - legacy invoices keep accepting payments (the payment guard finds them
--    closed) — nothing that worked before stops working;
--  - link/unlink on those invoices freezes by design: closed invoices are not
--    edited (approved rule); the panel ships the Close button + lock-aware
--    buttons in the companion panel PR of this wave.
-- Idempotent: only touches closed_at IS NULL rows; re-running is a no-op.

update invoices
set closed_at = coalesce(
      (select max(coalesce(p.paid_at, p.created_at)) from invoice_payments p where p.invoice_id = invoices.id),
      updated_at,
      now()),
    closed_by = 'system:bulk-invoicing-backfill'
where closed_at is null
  and status <> 'DRAFT';

-- ─── Tenant-pinned client FK ─────────────────────────────────────────────────
-- 20260906010000 added packages.client_id -> billing_clients(id): any agency's
-- client id satisfies it, so a buggy/malicious write could pin a package to
-- another org's client. Replace with a composite FK that can only ever point
-- inside the package's own organization. (The backfilled rows are all
-- org-scoped by construction, so validation passes without a data fix.)
create unique index if not exists billing_clients_org_id_uidx on billing_clients (organization_id, id);

alter table packages drop constraint if exists packages_client_id_fkey;
alter table packages
  add constraint packages_client_id_org_fkey
  foreign key (organization_id, client_id) references billing_clients (organization_id, id)
  on delete set null;

comment on column packages.client_id is
  'Billing client this package belongs to (bulk invoicing). Composite FK pins it to the SAME organization; NULL + non-empty referencia_name = needs review.';
