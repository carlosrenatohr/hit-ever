-- ============================================================================
-- Rate cards v2: plan (padre) -> versiones -> precios hijos AIR/MAR + tasa de cambio
-- ============================================================================
-- Additive migration owned by branch feat/ever2-rate-cards-backfill. Implements
-- the robust pricing model from docs/pricing-model.md: a rate_card is a
-- commercial plan ("Estándar", "Regular · VIP"...), a rate_card_versions is a
-- published revision (price_model, currency, validity, status), and
-- rate_card_entries is the AIR/MAR price pair. structure='simple_pair' means
-- exactly one AIR + one MAR entry per published version (enforced by the Worker
-- on write). Legacy rate_tables/rate_rows stay for the transition and rollback.
--
-- Also adds the manual exchange rate (C$/US$, default 37) on agencies and the
-- billing provenance columns on invoice_line_items (snapshot of what was priced;
-- historical rows stay NULL, never recalculated).
--
-- RLS: staff SELECT only (config_reader). Writes go exclusively through the
-- Worker (admin key + rates:write permission) — no direct write policies.

-- ─── rate_cards (plan) ───────────────────────────────────────────────────────
create table if not exists rate_cards (
  id              uuid primary key default gen_random_uuid(),
  organization_id text not null references agencies(slug),
  name            text not null,
  structure       text not null default 'simple_pair'
                  check (structure in ('simple_pair')),   -- 'matrix' en el futuro
  created_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, name)
);
alter table rate_cards enable row level security;
create index if not exists idx_rate_cards_org on rate_cards (organization_id);

-- ─── rate_card_versions ──────────────────────────────────────────────────────
create table if not exists rate_card_versions (
  id            uuid primary key default gen_random_uuid(),
  rate_card_id  uuid not null references rate_cards(id) on delete cascade,
  version       int not null default 1,
  price_model   text not null default 'weight'
                check (price_model in ('weight', 'volume', 'fixed')),
  currency      text not null default 'USD' check (currency in ('USD', 'NIO')),
  valid_from    timestamptz,
  valid_to      timestamptz,
  status        text not null default 'published'
                check (status in ('draft', 'published', 'archived')),
  source_key    text,   -- backfill idempotencia: "{org}:{table}:{tier}"
  created_by    uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (rate_card_id, version),
  unique (source_key)
);
alter table rate_card_versions enable row level security;
create index if not exists idx_rate_card_versions_card on rate_card_versions (rate_card_id);

-- ─── rate_card_entries (precio por servicio dentro de una versión) ───────────
create table if not exists rate_card_entries (
  id                    uuid primary key default gen_random_uuid(),
  rate_card_version_id  uuid not null references rate_card_versions(id) on delete cascade,
  service_type          text not null check (service_type in ('AIR', 'MAR')),
  name                  text not null,
  unit                  text not null default 'lb' check (unit in ('lb', 'ft3', 'package')),
  price                 numeric not null check (price >= 0),
  cost                  numeric not null default 0 check (cost >= 0),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  -- simple_pair: a lo sumo un AIR + un MAR por versión. Una futura matriz
  -- (rangos/zona) relajará esta constraint como evolución aditiva.
  unique (rate_card_version_id, service_type)
);
alter table rate_card_entries enable row level security;
create index if not exists idx_rate_card_entries_version on rate_card_entries (rate_card_version_id);

-- ─── Referencias nuevas (additive, on delete set null) ───────────────────────
alter table billing_clients
  add column if not exists default_rate_card_id uuid references rate_cards(id) on delete set null;

alter table packages
  add column if not exists rate_override_card_id uuid references rate_cards(id) on delete set null;

-- ─── Tasa de cambio manual (C$/US$) ──────────────────────────────────────────
alter table agencies
  add column if not exists exchange_rate_nio_per_usd numeric check (exchange_rate_nio_per_usd > 0),
  add column if not exists exchange_rate_source  text not null default 'manual'
                  check (exchange_rate_source in ('manual', 'automatic')),
  add column if not exists exchange_rate_updated_at timestamptz;

-- Default global manual C$37/US$1 para todas las agencias existentes y futuras.
update agencies
set exchange_rate_nio_per_usd = 37,
    exchange_rate_updated_at = now()
where exchange_rate_nio_per_usd is null;

-- ─── Provenance de pricing en líneas de factura (snapshot, no recálculo) ─────
alter table invoice_line_items
  add column if not exists rate_card_id uuid,
  add column if not exists rate_card_version_id uuid,
  add column if not exists rate_card_entry_id uuid,
  add column if not exists base_unit_price numeric,
  add column if not exists discount_amount numeric not null default 0,
  add column if not exists surcharge_amount numeric not null default 0,
  add column if not exists pricing_source text;  -- 'rate_card' | 'legacy' | 'catalog'

-- ─── RLS (staff SELECT only — writes via Worker) ─────────────────────────────
create policy staff_read_rate_cards         on rate_cards         for select to authenticated using (public.config_reader());
create policy staff_read_rate_card_versions on rate_card_versions for select to authenticated using (public.config_reader());
create policy staff_read_rate_card_entries  on rate_card_entries  for select to authenticated using (public.config_reader());