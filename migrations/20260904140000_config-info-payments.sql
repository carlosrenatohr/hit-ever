-- ============================================================================
-- Fase 1: agency info + currency + scrapable flag + dynamic payment methods
-- ============================================================================
-- 1) Agency profile (Config > Información): RUC, address, phone (optional free
--    text, rendered under the agency name on invoice PDFs) and the working
--    currency (USD | NIO) that governs money symbols across the panel.
-- 2) is_scrapable (task 0.6): when false, every sync/scrape path for the
--    agency is refused server-side (solo-guegue works manual-only).
-- 3) Dynamic payment methods and banks (Config > Pagos): per-agency catalogs
--    replace the hardcoded Postgres enums; invoice_payments gains optional
--    reference + comments, and its method/bank columns widen to text.

-- ─── 1. Agency profile + scrapable flag ──────────────────────────────────────
alter table agencies
  add column if not exists ruc text,
  add column if not exists address text,
  add column if not exists phone text,
  add column if not exists currency text not null default 'USD'
    check (currency in ('USD', 'NIO')),
  add column if not exists is_scrapable boolean not null default true;

update agencies set is_scrapable = false where slug = 'solo-guegue';

-- ─── 2. Payment methods / banks per agency ───────────────────────────────────
create table if not exists payment_methods (
  id              uuid primary key default gen_random_uuid(),
  organization_id text not null references agencies(slug),
  name            text not null,
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, name)
);
alter table payment_methods enable row level security;
create policy staff_read_payment_methods on payment_methods
  for select to authenticated using (public.is_staff());

create table if not exists payment_banks (
  id              uuid primary key default gen_random_uuid(),
  organization_id text not null references agencies(slug),
  name            text not null,
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, name)
);
alter table payment_banks enable row level security;
create policy staff_read_payment_banks on payment_banks
  for select to authenticated using (public.is_staff());

-- Seed the three working agencies with the current defaults (admins can add
-- more or deactivate — the catalogs are theirs now).
insert into payment_methods (organization_id, name)
select a.slug, m.name from agencies a
cross join (values ('Transferencia'), ('Efectivo'), ('Saldo a favor')) as m(name)
on conflict (organization_id, name) do nothing;

insert into payment_banks (organization_id, name)
select a.slug, b.name from agencies a
cross join (values ('BAC'), ('LAFISE'), ('BANPRO')) as b(name)
on conflict (organization_id, name) do nothing;

-- ─── 3. invoice_payments: reference + comments, dynamic method/bank ─────────
alter table invoice_payments
  add column if not exists reference text,
  add column if not exists comments text;

alter table invoice_payments
  alter column method type text using method::text,
  alter column bank type text using bank::text;
