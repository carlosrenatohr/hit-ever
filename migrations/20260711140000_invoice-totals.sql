-- ============================================================================
-- Denormalized invoice totals — total / profit / paid_usd on the header.
-- ============================================================================
-- The list view and monthly/quarterly reports need per-invoice figures without an
-- N+1 fetch of line-items. These are maintained by the billing service on every
-- write (create invoice, apply payment) and by the import runner after it writes
-- an invoice's lines/payments. They are derived, never hand-entered.
--   total    = sum(line_items.total)
--   profit   = sum(line_items.profit)
--   paid_usd = sum(payments.amount_usd)   (reconciled USD paid)

alter table invoices add column if not exists total    numeric not null default 0;
alter table invoices add column if not exists profit   numeric not null default 0;
alter table invoices add column if not exists paid_usd numeric not null default 0;

create index if not exists idx_invoices_total on invoices (total);
