-- ============================================================================
-- Billing module schema (Freight Billing) — AIR/MAR invoices linked to packages.
-- ============================================================================
-- Canonical model: header (invoices) + embedded line-items + payments, plus a
-- pricing catalog, a client dedupe table, and an invoice<->package join.
--
-- Security: every billing table has RLS ENABLED with NO permissive policies
-- (default-deny), exactly like the base tracker tables (db/0001_init.sql). The
-- only reader/writer is the Worker's billing module, which uses the InsForge
-- admin key (RLS bypass) and enforces auth + role/permission in application code
-- (src/modules/billing/middleware/auth.ts). Money never leaves to the browser
-- except through those authenticated endpoints. The panel does NOT touch these
-- tables directly.
--
-- Idempotency of the historical import lives in `unique (fiscal_year, invoice_number)`.
-- Derived amounts (total, profit, margin, commission) are computed in
-- src/modules/billing/domain/calc.ts and stored; they are never source-of-truth
-- formulas in the DB (mirrors the Excel VLOOKUP graph, but server-side).

-- ─── Enums ──────────────────────────────────────────────────────────────────
do $$ begin
  create type billing_freight_type as enum ('AIR', 'MAR');
exception when duplicate_object then null; end $$;

do $$ begin
  create type price_tier as enum ('REGULAR', 'ESPECIAL', 'VIP', 'MADRES', 'DARIO');
exception when duplicate_object then null; end $$;

do $$ begin
  create type invoice_status as enum ('DRAFT', 'ISSUED', 'PARTIAL', 'PAID', 'VOID');
exception when duplicate_object then null; end $$;

do $$ begin
  create type payment_method as enum ('BANK_TRANSFER', 'CASH', 'CREDIT_BALANCE');
exception when duplicate_object then null; end $$;

do $$ begin
  create type payment_bank as enum ('BAC', 'LAFISE', 'BANPRO');
exception when duplicate_object then null; end $$;

do $$ begin
  create type billing_currency as enum ('USD', 'NIO');
exception when duplicate_object then null; end $$;

-- ─── pricing_catalog ──────────────────────────────────────────────────────────
-- One row per freight type. Tier prices are USD/lb; `cost` is the internal freight
-- cost/lb used to derive profit. Mirrors the Excel `BD` sheet. `madres` is nullable
-- (MAR has no Madres tier). This is reference data; the seed lives at the bottom.
create table if not exists pricing_catalog (
  freight_type   billing_freight_type primary key,
  cost           numeric not null,
  tier_regular   numeric not null,
  tier_especial  numeric not null,
  tier_vip       numeric not null,
  tier_madres    numeric,
  tier_dario     numeric not null,
  updated_at     timestamptz not null default now()
);
alter table pricing_catalog enable row level security;

-- ─── billing_clients ────────────────────────────────────────────────────────
-- Dedupe of free-text customer names (the Excel `cliente` column and, going
-- forward, packages.referencia_name). `name_normalized` = trim + collapse spaces
-- + lower, and is unique. `to_review` flags fuzzy/ambiguous matches for a human.
create table if not exists billing_clients (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  name_normalized  text not null unique,
  casillero        text,
  to_review        boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
alter table billing_clients enable row level security;

-- ─── billing_agents ─────────────────────────────────────────────────────────
-- Sales agents that earn commission (e.g. Daniel = 50% of profit). NOT populated
-- by the current import (Daniel is out of scope for now); kept so commissions can
-- be turned on later without a migration.
create table if not exists billing_agents (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  commission_rate  numeric not null default 0.5,
  active           boolean not null default true,
  created_at       timestamptz not null default now()
);
alter table billing_agents enable row level security;

-- ─── invoices (header) ────────────────────────────────────────────────────────
-- One row per invoice. The 2026 sheets are header-level (materialized as a single
-- line-item downstream); the 2025 sheet is line-item (grouped by invoice_number).
-- `status` behaves like the shipment status on packages: workflow state derived
-- from payments, with VOID as a manual terminal override (ANULADO rows import as VOID).
create table if not exists invoices (
  id               uuid primary key default gen_random_uuid(),
  invoice_number   integer not null,
  fiscal_year      integer not null,
  client_id        uuid references billing_clients(id) on delete set null,
  client_name_raw  text,                                  -- original cell before dedupe
  issue_date       date,
  status           invoice_status not null default 'DRAFT',
  address          text,                                  -- 2025 sheet only
  special_price    boolean not null default false,        -- "Precio especial"
  observations     text,
  tracking_orders  text[] not null default '{}',          -- parsed OC tokens (raw, best-effort)
  agent_id         uuid references billing_agents(id) on delete set null,
  source           jsonb,                                 -- migration trace: { sheet, rows }
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (fiscal_year, invoice_number)                    -- import idempotency key
);
alter table invoices enable row level security;
create index if not exists idx_invoices_status       on invoices (status);
create index if not exists idx_invoices_issue_date   on invoices (issue_date desc);
create index if not exists idx_invoices_client       on invoices (client_id);
create index if not exists idx_invoices_fiscal_year  on invoices (fiscal_year);

-- ─── invoice_line_items ─────────────────────────────────────────────────────
-- total = quantity_lbs * unit_price ; freight_cost = quantity_lbs * catalog.cost ;
-- profit = total - freight_cost. `price_tier` inferred from the catalog on ingest;
-- `price_off_catalog` flags a unit_price that matches no tier (goes to the queue).
create table if not exists invoice_line_items (
  id                 uuid primary key default gen_random_uuid(),
  invoice_id         uuid not null references invoices(id) on delete cascade,
  line_no            integer not null default 1,
  description        text,                                -- null on 2026 sheets
  freight_type       billing_freight_type not null,
  quantity_lbs       numeric not null,
  unit               text not null default 'lbs',
  unit_price         numeric not null,
  total              numeric not null,
  list_price         numeric,                             -- precio_total_original
  freight_cost       numeric not null default 0,
  profit             numeric not null default 0,
  price_tier         price_tier,
  price_off_catalog  boolean not null default false,
  created_at         timestamptz not null default now()
);
alter table invoice_line_items enable row level security;
create index if not exists idx_line_items_invoice on invoice_line_items (invoice_id);
create index if not exists idx_line_items_freight  on invoice_line_items (freight_type);

-- ─── invoice_payments ─────────────────────────────────────────────────────────
-- Invoice is priced in USD; a payment may be in USD or NIO. `amount_usd` is the
-- reconciled USD figure (= amount when USD, = amount / fx_rate when NIO with a
-- manual rate). `raw` keeps the original Excel cell for audit; `quarantined` marks
-- unparseable payment cells (numeric garbage, '?', '-') that need human review.
create table if not exists invoice_payments (
  id           uuid primary key default gen_random_uuid(),
  invoice_id   uuid not null references invoices(id) on delete cascade,
  method       payment_method,
  bank         payment_bank,
  currency     billing_currency,
  amount       numeric,
  amount_usd   numeric,
  fx_rate      numeric,
  paid_at      timestamptz,
  raw          text,
  quarantined  boolean not null default false,
  created_at   timestamptz not null default now()
);
alter table invoice_payments enable row level security;
create index if not exists idx_payments_invoice on invoice_payments (invoice_id);

-- ─── invoice_packages (join) ────────────────────────────────────────────────
-- Links an invoice to one or more real packages. `source='auto'` = matched during
-- import by OC token against packages.almacen_id/tracking_number; `source='manual'`
-- = assigned from the panel (same idea as a manual status). FK to packages.id (uuid)
-- because almacen_id is unique only per provider.
create table if not exists invoice_packages (
  id           uuid primary key default gen_random_uuid(),
  invoice_id   uuid not null references invoices(id) on delete cascade,
  package_id   uuid not null references packages(id) on delete cascade,
  source       text not null default 'auto' check (source in ('auto', 'manual')),
  matched_oc   text,
  created_by   text,
  created_at   timestamptz not null default now(),
  unique (invoice_id, package_id)
);
alter table invoice_packages enable row level security;
create index if not exists idx_invoice_packages_package on invoice_packages (package_id);
create index if not exists idx_invoice_packages_invoice on invoice_packages (invoice_id);

-- ─── Seed: pricing_catalog (from the Excel `BD` sheet) ──────────────────────────
-- USD/lb. AIR: cost 4.5 · regular 6.5 · especial 6.0 · VIP 5.5 · Madres 6.25 · Dario 4.3
--        MAR: cost 1.25 · regular 2.5 · especial 2.3 · VIP 2.25 · Madres NULL · Dario 1.3
insert into pricing_catalog (freight_type, cost, tier_regular, tier_especial, tier_vip, tier_madres, tier_dario)
values
  ('AIR', 4.5,  6.5, 6.0, 5.5, 6.25, 4.3),
  ('MAR', 1.25, 2.5, 2.3, 2.25, null, 1.3)
on conflict (freight_type) do update set
  cost = excluded.cost,
  tier_regular = excluded.tier_regular,
  tier_especial = excluded.tier_especial,
  tier_vip = excluded.tier_vip,
  tier_madres = excluded.tier_madres,
  tier_dario = excluded.tier_dario,
  updated_at = now();
