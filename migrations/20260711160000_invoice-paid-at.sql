-- ============================================================================
-- Denormalized paid_at on the invoice header.
-- ============================================================================
-- When an invoice becomes PAID we stamp the payment date here so the list view can
-- show the "issued -> paid" turnaround (days badge) without loading each invoice's
-- payments. Maintained by applyPayment and by the historical import.
alter table invoices add column if not exists paid_at timestamptz;

-- Backfill historical PAID invoices from their imported payment rows (the sheet's
-- "Fecha de Pago"), so the days badge works on existing data without a re-import.
update invoices i
set paid_at = p.paid_at
from (
  select invoice_id, max(paid_at) as paid_at
  from invoice_payments
  where paid_at is not null
  group by invoice_id
) p
where p.invoice_id = i.id and i.status = 'PAID' and i.paid_at is null;
