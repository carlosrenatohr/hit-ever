-- ============================================================================
-- HIT CARGO Tracker — initial schema
-- ============================================================================
-- Model derived from the Cargotrack system (Everest + 2nd provider):
--   * almacen_id (waybill number / "guía") = Cargotrack control number, PRIMARY KEY for public lookup.
--   * tracking_number      = carrier number (UPS/Amazon/Shein...), secondary lookup.
--   * casillero            = ownership filter (Everest shares an account; only "37458" is HIT's).
--
-- SECURITY:
--   * RLS enabled on ALL tables, WITHOUT permissive policies for anon/authenticated
--     => the public client cannot read anything directly.
--   * The Worker connects with the SERVICE ROLE KEY, which by design BYPASSES RLS. That key
--     lives only in the Worker (Cloudflare Secret), never in the client.
--   * Sensitive data (casillero, referencia_name, photo_ref, value) is stored for internal
--     control but is NEVER exposed in the public payload (filtered at the API layer, B4).
-- ============================================================================

-- ─── Types ──────────────────────────────────────────────────────────────────
-- Statuses follow the official Cargotrack LEGEND (printed on the Warehouse view):
do $$ begin
  create type shipment_status as enum (
    'en_almacen',   -- 🟢 green:   In warehouse (at the Miami warehouse)
    'parcial',      -- 🟡 yellow:  Partial (shipment partially processed)
    'en_transito',  -- 🔴 red:     Shipped / In transit
    'en_destino',   -- 🟣 purple:  At destination (arrived in Nicaragua)
    'entregado',    -- 🟠 orange:  Delivered at destination
    'excepcion',    -- held / blocked
    'desconocido'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type service_type as enum ('aereo', 'maritimo');
exception when duplicate_object then null; end $$;

-- ─── providers ────────────────────────────────────────────────────────────────
create table if not exists providers (
  id               uuid primary key default gen_random_uuid(),
  code             text not null unique,          -- 'everest', 'provider2'
  name             text not null,
  base_url         text not null,
  casillero_filter text,                           -- '37458' in Everest; null = accept everything
  active           boolean not null default true,
  created_at       timestamptz not null default now()
);

-- ─── packages ───────────────────────────────────────────────────────────────
create table if not exists packages (
  id              uuid primary key default gen_random_uuid(),
  provider_id     uuid not null references providers(id) on delete cascade,
  almacen_id      text not null,                   -- waybill number (guía) (926791) — primary public key
  tracking_number text,                            -- carrier, normalized (upper, no spaces)
  status          shipment_status not null default 'desconocido',
  raw_status      text,                            -- original Cargotrack value (color/"In Transit")
  service_type    service_type,
  weight_lb       numeric,
  volume_cf       numeric,
  pieces          integer,
  dimensions      text,
  origin_office   text,                            -- MIA
  dest_office     text,                            -- MGA
  description      text,                           -- "ELECTRONICO"
  remitente       text,                            -- AMAZON / SHEIN ...
  -- internal (NEVER expose publicly):
  referencia_name text,                            -- final customer name (PII)
  casillero       text,                            -- "37458"
  declared_value  numeric,                         -- "Value"
  photo_ref       text,                            -- attachment in Cargotrack
  received_at     timestamptz,
  last_event_at   timestamptz,
  -- manual status override: some providers (e.g. Global Connection) do not mark
  -- "Entregado en destino"; HIT records it by hand. The EFFECTIVE status = manual_status ?? status.
  manual_status     shipment_status,
  manual_status_at  timestamptz,
  manual_status_by  text,
  manual_status_note text,
  scraped_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (provider_id, almacen_id)
);

create index if not exists idx_packages_tracking on packages (tracking_number) where tracking_number is not null;
create index if not exists idx_packages_provider_almacen on packages (provider_id, almacen_id);
create index if not exists idx_packages_status on packages (status);

-- ─── events (tracking timeline) ───────────────────────────────────────────────
create table if not exists events (
  id          uuid primary key default gen_random_uuid(),
  package_id  uuid not null references packages(id) on delete cascade,
  occurred_at timestamptz,
  office      text,                                -- MIA / MGA
  description text not null,
  status      shipment_status,
  source      text not null default 'cargotrack', -- 'cargotrack' | 'carrier_api' (phase 2: Parcel)
  created_at  timestamptz not null default now(),
  unique (package_id, occurred_at, description)    -- dedup on re-scrapes
);

create index if not exists idx_events_package on events (package_id);

-- ─── HIT's own tags / notes (control tool) ─────────────────────────────────────
create table if not exists package_tags (
  id         uuid primary key default gen_random_uuid(),
  package_id uuid not null references packages(id) on delete cascade,
  label      text not null,
  value      text,
  created_by text,
  created_at timestamptz not null default now()
);

create index if not exists idx_tags_package on package_tags (package_id);

create table if not exists package_notes (
  id         uuid primary key default gen_random_uuid(),
  package_id uuid not null references packages(id) on delete cascade,
  body       text not null,
  created_by text,
  created_at timestamptz not null default now()
);

create index if not exists idx_notes_package on package_notes (package_id);

-- ─── RLS: default-deny on everything ───────────────────────────────────────────
-- Without policies for anon/authenticated => access denied via PostgREST with the anon key.
-- The Worker uses service_role (RLS bypass). Do NOT create permissive policies for anon.
alter table providers     enable row level security;
alter table packages      enable row level security;
alter table events        enable row level security;
alter table package_tags  enable row level security;
alter table package_notes enable row level security;

-- ─── Provider seed (adjust after the B0 spike) ────────────────────────────────
insert into providers (code, name, base_url, casillero_filter) values
  -- Everest: shared account (provexpro). Only mailbox 37458 is HIT's.
  ('everest', 'Everest Logistics Services', 'https://everest.cargotrack.net', '37458')
on conflict (code) do nothing;

-- Global Connection (user hitcargo): SAME Cargotrack engine. The account is 100% HIT's,
-- so it is NOT filtered by mailbox (casillero_filter = null => accept everything). Its visible
-- mailbox is 1538. Fill in base_url with the real host before enabling ingestion.
-- insert into providers (code, name, base_url, casillero_filter) values
--   ('global_connection', 'Global Connection', 'https://<host-global-connection>', null)
-- on conflict (code) do nothing;
