-- ============================================================================
-- Fase 4: invoice event history (linear timeline per invoice)
-- ============================================================================
-- Every action around an invoice (created, payment registered, voided, package
-- linked/unlinked) appends a row here so the panel can render a linear fecha/hora
-- timeline from generation to payment. Written by the Worker with the session
-- agency stamped (org-scoped reads via the billing repo).

create table if not exists invoice_events (
  id              bigserial primary key,
  invoice_id      uuid not null references invoices(id) on delete cascade,
  organization_id text not null references agencies(slug),
  action          text not null,
  detail          text,
  actor           text,
  created_at      timestamptz not null default now()
);
alter table invoice_events enable row level security;
create policy staff_read_invoice_events on invoice_events
  for select to authenticated using (public.is_staff());
create index if not exists idx_invoice_events_invoice on invoice_events (invoice_id, created_at);
