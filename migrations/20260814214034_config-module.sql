-- ============================================================================
-- Config module (Orbit) — agencies (tenant root), audit logs, self-managed rates.
-- ============================================================================
-- Additive migration, owned by branch feat/config-module. Follows ADR-009
-- (multi-tenancy: tenant-scoped entities carry organization_id -> agencies) and
-- ADR-011 (audit_logs: relational columns + jsonb metadata, separated from
-- scraper telemetry).
--
-- Security model: RLS enabled + default-deny everywhere; staff gets SELECT
-- only. Write paths are the Worker (admin key, enforces config:write /
-- rates:write permissions) and the re-guarded SECURITY DEFINER RPCs — there are
-- NO direct write policies for the panel (Do Not: no UPDATE/INSERT directo).
-- organization_id/actor come from the session (app_users.agency), never from
-- the payload.

-- ─── agencies (tenant root) ────────────────────────────────────────────────
-- One row per organization/brand. `slug` is the tenant key referenced as
-- organization_id across the schema. Logo lives in InsForge Storage; the DB
-- keeps url + key only (never binaries in Postgres).
create table if not exists agencies (
  slug       text primary key check (slug ~ '^[a-z0-9-]+$'),
  name       text not null,
  logo_url   text,
  logo_key   text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table agencies enable row level security;

-- ─── audit_logs ────────────────────────────────────────────────────────────
-- ADR-011. actor_id is the canonical identity (auth.uid() for users);
-- actor_email is a historical snapshot, never an identifier. actor_type:
-- user | system | service. metadata jsonb carries before/after of changed
-- fields. request_id correlates with Worker observability (nullable: panel
-- RPCs don't carry one yet).
create table if not exists audit_logs (
  id              bigint generated always as identity primary key,
  organization_id text not null references agencies(slug),
  actor_id        uuid,
  actor_email     text,
  actor_type      text not null default 'user' check (actor_type in ('user', 'system', 'service')),
  action          text not null,
  entity_type     text not null,
  entity_id       text,
  request_id      uuid,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);
alter table audit_logs enable row level security;
create index if not exists idx_audit_logs_org_created on audit_logs (organization_id, created_at desc);
create index if not exists idx_audit_logs_entity     on audit_logs (entity_type, entity_id);
create index if not exists idx_audit_logs_actor      on audit_logs (actor_id);

-- ─── rate_tables / rate_rows ───────────────────────────────────────────────
-- Self-managed per-organization rates. Mirrors pricing_catalog (global
-- fallback) but tenant-scoped. profit/margin are NOT stored — computed
-- server-side in the Worker domain/calc, like the billing module.
create table if not exists rate_tables (
  id              uuid primary key default gen_random_uuid(),
  organization_id text not null references agencies(slug),
  name            text not null,
  freight_type    billing_freight_type not null,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, name, freight_type)
);
alter table rate_tables enable row level security;
create index if not exists idx_rate_tables_org on rate_tables (organization_id);

create table if not exists rate_rows (
  id            uuid primary key default gen_random_uuid(),
  rate_table_id uuid not null references rate_tables(id) on delete cascade,
  tier          price_tier not null,
  price         numeric not null,
  cost          numeric not null,
  updated_at    timestamptz not null default now(),
  unique (rate_table_id, tier)
);
alter table rate_rows enable row level security;
create index if not exists idx_rate_rows_table on rate_rows (rate_table_id);

-- ─── Additive columns ──────────────────────────────────────────────────────
alter table billing_clients
  add column if not exists default_rate_id uuid references rate_tables(id) on delete set null;

alter table packages
  add column if not exists rate_override_id uuid references rate_tables(id) on delete set null,
  add column if not exists rate_override_by text,
  add column if not exists rate_override_at timestamptz;

-- ─── RLS policies (staff read only — no write policies) ────────────────────
create policy staff_read_agencies   on agencies    for select to authenticated using (public.is_staff());
create policy staff_read_audit_logs on audit_logs  for select to authenticated using (public.is_staff());
create policy staff_read_rate_tables on rate_tables for select to authenticated using (public.is_staff());
create policy staff_read_rate_rows   on rate_rows   for select to authenticated using (public.is_staff());

-- ─── Seed ──────────────────────────────────────────────────────────────────
-- Known agencies (mirrors app_users.agency check 'hit'/'suite'). Brand names
-- are editable later from the panel branding screen.
insert into agencies (slug, name) values
  ('hit',   'HIT Cargo'),
  ('suite', 'Suite')
on conflict (slug) do nothing;

-- One "Regular" rate table per agency × freight_type, seeded from the global
-- pricing_catalog (demo default, editable in the panel). tier_madres is null
-- for MAR (no Madres tier), so that row is skipped.
do $$
declare r record; t record; v_table uuid;
begin
  for r in
    select a.slug, c.freight_type, c.cost, c.tier_regular, c.tier_especial,
           c.tier_vip, c.tier_madres, c.tier_dario
    from agencies a cross join pricing_catalog c
  loop
    insert into rate_tables (organization_id, name, freight_type)
    values (r.slug, 'Regular', r.freight_type)
    on conflict (organization_id, name, freight_type) do nothing
    returning id into v_table;
    if v_table is null then continue; end if;
    for t in values
      ('REGULAR', r.tier_regular), ('ESPECIAL', r.tier_especial),
      ('VIP', r.tier_vip), ('DARIO', r.tier_dario)
    loop
      insert into rate_rows (rate_table_id, tier, price, cost)
      values (v_table, t.column1::public.price_tier, t.column2::numeric, r.cost)
      on conflict (rate_table_id, tier) do nothing;
    end loop;
    if r.tier_madres is not null then
      insert into rate_rows (rate_table_id, tier, price, cost)
      values (v_table, 'MADRES', r.tier_madres, r.cost)
      on conflict (rate_table_id, tier) do nothing;
    end if;
  end loop;
end $$;

-- ─── RPC retrofit: audit on the three write RPCs (ADR-011) ──────────────────
-- Bodies unchanged except the audit_logs insert in the same transaction.
-- organization_id and actor resolve from the session (auth.uid() ->
-- app_users.agency), never from the payload. Grants persist across
-- CREATE OR REPLACE.
create or replace function public.set_manual_status(p_guia text, p_status text, p_note text default null)
  returns json language plpgsql security definer set search_path = public, auth as $$
declare v_id uuid; v_by text; v_agency text;
begin
  if not public.is_writer() then raise exception 'not authorized'; end if;
  select id into v_id from public.packages where almacen_id = p_guia;
  if v_id is null then raise exception 'package % not found', p_guia; end if;
  select coalesce(email, 'panel'), coalesce(agency, 'hit')
    into v_by, v_agency
    from public.app_users where id = auth.uid();
  update public.packages set
    manual_status      = p_status::public.shipment_status,
    manual_status_by   = coalesce(v_by, 'panel'),
    manual_status_note = p_note,
    manual_status_at   = now(),
    updated_at         = now()
  where id = v_id;
  insert into public.audit_logs
    (organization_id, actor_id, actor_email, actor_type, action, entity_type, entity_id, metadata)
  values
    (v_agency, auth.uid(), v_by, 'user', 'set_manual_status', 'package', p_guia,
     jsonb_build_object('status', p_status, 'note', p_note));
  return json_build_object('guia', p_guia, 'manual_status', p_status);
end $$;

create or replace function public.add_package_tag(p_guia text, p_label text, p_value text default null)
  returns json language plpgsql security definer set search_path = public, auth as $$
declare v_id uuid; v_by text; v_agency text;
begin
  if not public.is_writer() then raise exception 'not authorized'; end if;
  select id into v_id from public.packages where almacen_id = p_guia;
  if v_id is null then raise exception 'package % not found', p_guia; end if;
  select coalesce(email, 'panel'), coalesce(agency, 'hit')
    into v_by, v_agency
    from public.app_users where id = auth.uid();
  insert into public.package_tags (package_id, label, value, created_by)
  values (v_id, p_label, p_value, v_by);
  insert into public.audit_logs
    (organization_id, actor_id, actor_email, actor_type, action, entity_type, entity_id, metadata)
  values
    (v_agency, auth.uid(), v_by, 'user', 'add_package_tag', 'package', p_guia,
     jsonb_build_object('label', p_label, 'value', p_value));
  return json_build_object('guia', p_guia, 'tag', p_label);
end $$;

create or replace function public.add_package_note(p_guia text, p_body text)
  returns json language plpgsql security definer set search_path = public, auth as $$
declare v_id uuid; v_by text; v_agency text;
begin
  if not public.is_writer() then raise exception 'not authorized'; end if;
  if coalesce(trim(p_body), '') = '' then raise exception 'note body required'; end if;
  select id into v_id from public.packages where almacen_id = p_guia;
  if v_id is null then raise exception 'package % not found', p_guia; end if;
  select coalesce(email, 'panel'), coalesce(agency, 'hit')
    into v_by, v_agency
    from public.app_users where id = auth.uid();
  insert into public.package_notes (package_id, body, created_by)
  values (v_id, p_body, v_by);
  insert into public.audit_logs
    (organization_id, actor_id, actor_email, actor_type, action, entity_type, entity_id, metadata)
  values
    (v_agency, auth.uid(), v_by, 'user', 'add_package_note', 'package', p_guia,
     jsonb_build_object('body', p_body));
  return json_build_object('guia', p_guia, 'noted', true);
end $$;
