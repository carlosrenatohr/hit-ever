-- ============================================================================
-- Fase 3: charge concepts (custom extra charges) + line types on invoices
-- ============================================================================
-- 1) charge_concepts — per-agency templates for extra invoice charges ("otros").
--    Each concept is a NAME plus an OPTIONAL suggested price that only prefills
--    the invoice form: the admin always sets the real amount per invoice, and
--    concepts are fully editable per agency (Delivery, IVA, whatever they need).
-- 2) invoice_line_items learn about non-freight lines: line_type distinguishes
--    'freight' (existing rows/behavior) from 'other'; freight_type and
--    quantity_lbs become nullable (an "other" line has no freight and no lbs);
--    concept_id keeps traceability to the template used. Existing rows are all
--    freight and keep working untouched (defaults cover them).

-- ─── 1. charge_concepts ──────────────────────────────────────────────────────
create table if not exists charge_concepts (
  id              uuid primary key default gen_random_uuid(),
  organization_id text not null references agencies(slug),
  name            text not null,
  suggested_price numeric,
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, name)
);
alter table charge_concepts enable row level security;
create policy staff_read_charge_concepts on charge_concepts
  for select to authenticated using (public.is_staff());

-- Working example for the demo agency (owner-requested); editable like any other.
insert into charge_concepts (organization_id, name, suggested_price)
values ('solo-guegue', 'Delivery', 3.00)
on conflict (organization_id, name) do nothing;

-- ─── 2. invoice_line_items: line types ───────────────────────────────────────
alter table invoice_line_items
  add column if not exists line_type text not null default 'freight',
  add column if not exists concept_id uuid references charge_concepts(id);

alter table invoice_line_items
  alter column freight_type drop not null,
  alter column quantity_lbs drop not null;

-- Existing rows are all freight (default covers them; explicit backfill for any
-- row inserted between the ADD COLUMN and the constraint drop).
update invoice_line_items set line_type = 'freight' where line_type is null;
