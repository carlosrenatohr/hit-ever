-- ============================================================================
-- Original Express — primer tenant de cliente real (onboarding #1)
-- ============================================================================
-- Additive migration, owned by branch feat/original-express-tenant. Crea el
-- tenant del cliente "Original Express" siguiendo el modelo de agencias
-- (ADR-009): agencia = tenant raíz; las entidades tenant-scoped cuelgan de
-- agencies(slug). No toca agencias existentes ni datos de hit/suite.
--
-- Alcance (lo esencial de arranque, todo editable desde el panel después):
--   1. agencies row             slug 'original-express' (currency USD)
--   2. rate_tables legacy       "Regular" AIR+MAR (precios del pricing_catalog)
--   3. rate_cards v2            "Regular" (simple_pair, precio por libra) —
--                               fuente de verdad para el panel (/rates/v2)
--   4. payment_methods/banks    catálogos por defecto (Transferencia/Efectivo,
--                               Saldo a favor; BAC/LAFISE/BANPRO)
--
-- Idempotencia: on conflict / do nothing + source_key único en
-- rate_card_versions ("{org}:{table}:{tier}", mismo formato que el backfill).
--
-- NOTA operativa: no se crea usuario aquí (implica password). El alta de
-- cuenta auth + app_users es un paso operativo documentado en
-- docs/client-onboarding-runbook.md §3, posterior al merge.

-- ─── 1. Tenant ────────────────────────────────────────────────────────────────
insert into agencies (slug, name, currency, is_scrapable)
values ('original-express', 'Original Express', 'USD', false)
on conflict (slug) do nothing;

-- ─── 2. rate_tables legacy ("Regular") seed desde pricing_catalog ─────────────
-- Mismo patrón que el config-module original, solo para el tenant nuevo.
do $$
declare r record; v_table uuid;
begin
  for r in
    select c.freight_type, c.cost, c.tier_regular
    from pricing_catalog c
  loop
    insert into rate_tables (organization_id, name, freight_type)
    values ('original-express', 'Regular', r.freight_type)
    on conflict (organization_id, name, freight_type) do nothing
    returning id into v_table;
    if v_table is not null then
      insert into rate_rows (rate_table_id, tier, price, cost)
      values (v_table, 'REGULAR', r.tier_regular, r.cost)
      on conflict (rate_table_id, tier) do nothing;
    end if;
  end loop;
end $$;

-- ─── 3. rate_cards v2 "Regular" (simple_pair, weight, USD) ────────────────────
-- Idempotente por source_key del rate_card_versions (formato del backfill).
do $$
declare v_org text := 'original-express';
        v_card uuid; v_ver uuid; v_air numeric; v_mar numeric;
        v_air_cost numeric; v_mar_cost numeric;
begin
  -- Ya existe si el backfill / esta migración corrió antes.
  if exists (
    select 1 from rate_card_versions v
    join rate_cards c on c.id = v.rate_card_id
    where v.source_key = v_org || ':Regular:REGULAR'
  ) then
    return;
  end if;

  select tier_regular, cost into v_air, v_air_cost
  from pricing_catalog where freight_type = 'AIR';
  select tier_regular, cost into v_mar, v_mar_cost
  from pricing_catalog where freight_type = 'MAR';

  insert into rate_cards (organization_id, name, structure)
  values (v_org, 'Regular', 'simple_pair')
  returning id into v_card;

  insert into rate_card_versions (rate_card_id, version, price_model, currency, status, source_key)
  values (v_card, 1, 'weight', 'USD', 'published', v_org || ':Regular:REGULAR')
  returning id into v_ver;

  insert into rate_card_entries (rate_card_version_id, service_type, name, unit, price, cost)
  values
    (v_ver, 'AIR', 'REGULAR', 'lb', v_air, v_air_cost),
    (v_ver, 'MAR', 'REGULAR', 'lb', v_mar, v_mar_cost);
end $$;

-- ─── 4. payment_methods / payment_banks por defecto ───────────────────────────
insert into payment_methods (organization_id, name)
select 'original-express', m.name
from (values ('Transferencia'), ('Efectivo'), ('Saldo a favor')) as m(name)
on conflict (organization_id, name) do nothing;

insert into payment_banks (organization_id, name)
select 'original-express', b.name
from (values ('BAC'), ('LAFISE'), ('BANPRO')) as b(name)
on conflict (organization_id, name) do nothing;