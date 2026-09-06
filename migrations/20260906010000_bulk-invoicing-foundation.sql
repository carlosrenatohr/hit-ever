-- ============================================================================
-- Bulk invoicing foundation: packages.client_id, per-line package snapshots,
-- invoice closing (closed_at/closed_by) + safe backfills.
-- ============================================================================
-- Adds the data-model groundwork for the from-Paquetería bulk-invoicing flow
-- without changing any existing write path (fully additive):
--
-- 1. packages.client_id — the billing client a package belongs to. Nullable:
--    packages whose referencia_name had NO exact client match stay unassigned
--    and are flagged for review by the PANEL as "client_id is null AND
--    referencia_name is not empty" (derived, no extra column). Manual creation
--    may set it with a warning; fuzzy merges are never done in SQL.
--
-- 2. invoice_line_items.package_id + package_guia/package_tracking snapshots —
--    the bulk flow prices one line per package; the guide/tracking text is
--    snapshotted so the invoice keeps reading correctly even if the package
--    row later changes (or is deleted: SET NULL keeps the money rows intact).
--
-- 3. invoices.closed_at / closed_by — "Cerrar factura" is a separate fact from
--    the money status (DRAFT/ISSUED/PARTIAL/PAID/VOID stay as-is). An invoice
--    is open (editable lines/links) while closed_at IS NULL; closing freezes
--    the total, after which only PAYMENTS may change — each one reducing the
--    outstanding until PAID. VOID remains available as the admin override.
--    DRAFT is now the "open" state: createInvoice(status DRAFT) stays editable
--    until POST /invoices/:id/close flips it to ISSUED + stamps closed_at.
--
-- Backfills (both idempotent, re-running changes nothing):
-- - packages.client_id by EXACT normalized match (same algorithm as
--   normalizeClientName: trim → collapse whitespace → lower) within the SAME
--   organization only. billing_clients has unique (organization_id,
--   name_normalized), so every join below is provably 1:1 — no fuzzy work.
--   Audit (2026-09-06): hit 319 packages (96 without a client name — skipped
--   by the empty guard; 102 groups unmatched — stay NULL/to_review),
--   solo-guegue 12, suite 40 (40 packages without billing clients → NULL).
-- - Historical invoices that already carry payments are stamped closed
--   (closed_at = latest payment, else now()) since their money state is final;
--   the new payment guard can then never reject a payment that used to work.

-- ─── 1. packages.client_id ───────────────────────────────────────────────────
alter table packages
  add column if not exists client_id uuid references billing_clients(id) on delete set null;

comment on column packages.client_id is
  'Billing client this package belongs to (bulk invoicing). Backfilled by exact org-scoped name match; NULL + non-empty referencia_name = needs review.';

create index if not exists idx_packages_client on packages (client_id) where client_id is not null;

-- Exact-match backfill: identical normalization to normalizeClientName() in
-- src/modules/billing/ingest/normalize/client.ts, org-scoped. Packages whose
-- name matches no client (or matches zero) stay NULL on purpose — a human
-- assigns them from the panel; we never invent or merge clients in SQL.
update packages p
set client_id = c.id
from billing_clients c
where p.client_id is null
  and p.referencia_name is not null
  and btrim(p.referencia_name) <> ''
  and c.organization_id = p.organization_id
  and c.name_normalized = lower(regexp_replace(btrim(p.referencia_name), '\s+', ' ', 'g'));

-- ─── 2. Per-line package snapshot ────────────────────────────────────────────
alter table invoice_line_items
  add column if not exists package_id uuid references packages(id) on delete set null;
alter table invoice_line_items
  add column if not exists package_guia text;
alter table invoice_line_items
  add column if not exists package_tracking text;

comment on column invoice_line_items.package_id is
  'Package this freight line bills (bulk invoicing: one line per package). NULL on manual/import lines.';
comment on column invoice_line_items.package_guia is
  'Snapshot of packages.almacen_id at billing time — survives package edits/deletes.';
comment on column invoice_line_items.package_tracking is
  'Snapshot of packages.tracking_number at billing time — survives package edits/deletes.';

create index if not exists idx_line_items_package on invoice_line_items (package_id) where package_id is not null;

-- ─── 3. Invoice closing (financial lock) ─────────────────────────────────────
alter table invoices
  add column if not exists closed_at timestamptz;
alter table invoices
  add column if not exists closed_by text;

comment on column invoices.closed_at is
  'Financial lock: non-NULL once "Cerrar factura" ran (or legacy invoices with payments, backfilled). Lines/links frozen after this; payments keep flowing and only move the balance.';
comment on column invoices.closed_by is
  'Email of the session that closed the invoice (NULL for the historical backfill).';

-- Historical invoices that already carry money are final → treat as closed.
update invoices i
set closed_at = coalesce(i.closed_at, (
      select max(coalesce(p.paid_at, p.created_at))
      from invoice_payments p
      where p.invoice_id = i.id
    ), now()),
    closed_by = coalesce(i.closed_by, 'system:bulk-invoicing-backfill')
where i.closed_at is null
  and (
    i.status in ('PARTIAL', 'PAID')
    or exists (select 1 from invoice_payments p where p.invoice_id = i.id)
  );
