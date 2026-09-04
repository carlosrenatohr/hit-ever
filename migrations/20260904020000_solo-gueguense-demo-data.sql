-- ============================================================================
-- Solo Guegue demo agency — seed data for prospect demos
-- ============================================================================
-- Additive migration. Creates a complete demo agency with:
--   1. Agency row (solo-guegue)
--   2. Provider assignment (global_connection → solo-guegue)
--   3. Rate tables (AIR + MAR estándar, REGULAR tier only)
--   4. Billing clients (5 Nicaraguan names)
--   5. Packages (12, varied statuses)
--   6. Tracking events (2-4 per package)
--
-- All inserts use ON CONFLICT DO NOTHING for idempotency.
-- Provider is reassigned from 'hit' to 'solo-guegue' (single-tenant for now;
-- see task T5 for M:N provider_agencies migration).
-- ============================================================================

-- ─── 1. Agency ───────────────────────────────────────────────────────────────
insert into agencies (slug, name)
values ('solo-guegue', 'Solo Guegue')
on conflict (slug) do nothing;

-- ─── 2. Provider — reassign Global Connection to solo-guegue ─────────────────
-- GC is currently assigned to 'hit'. Reassign so the demo agency has its own
-- provider. This is a temporary 1:N mapping; T5 will create provider_agencies.
update providers
set organization_id = 'solo-guegue',
    updated_at = now()
where code = 'global_connection';

-- ─── 3. Rate tables — one per freight type, REGULAR tier only ────────────────
-- The agency owner creates additional tiers (ESPECIAL, VIP, etc.) from the
-- dashboard. These are the base rates.
do $$
declare
  v_air_table uuid;
  v_mar_table uuid;
begin
  -- AIR estándar
  insert into rate_tables (organization_id, name, freight_type)
  values ('solo-guegue', 'Estándar', 'AIR')
  on conflict (organization_id, name, freight_type) do nothing
  returning id into v_air_table;

  if v_air_table is not null then
    insert into rate_rows (rate_table_id, tier, price, cost)
    values (v_air_table, 'REGULAR', 7.00, 4.50);
  end if;

  -- MAR estándar
  insert into rate_tables (organization_id, name, freight_type)
  values ('solo-guegue', 'Estándar', 'MAR')
  on conflict (organization_id, name, freight_type) do nothing
  returning id into v_mar_table;

  if v_mar_table is not null then
    insert into rate_rows (rate_table_id, tier, price, cost)
    values (v_mar_table, 'REGULAR', 2.80, 1.25);
  end if;
end $$;

-- ─── 4. Billing clients ─────────────────────────────────────────────────────
-- 5 Nicaraguan customers with realistic names.
-- name_normalized = trim + collapse whitespace + lower (per client.ts).
insert into billing_clients (name, name_normalized, casillero, to_review)
values
  ('María José Ruiz',        'maría josé ruiz',        '5012', false),
  ('Carlos Andrés Martínez', 'carlos andrés martínez', '5023', false),
  ('Ana Lucía Pérez',        'ana lucía pérez',        '5034', false),
  ('Roberto Carlos López',   'roberto carlos lópez',   '5045', false),
  ('Daniela Fernanda Castillo', 'daniela fernanda castillo', '5056', false)
on conflict (name_normalized) do nothing;

-- ─── 5. Packages ────────────────────────────────────────────────────────────
-- 12 packages across the 5 clients, varied statuses and freight types.
-- All use global_connection as provider, organization_id = 'solo-guegue'.
do $$
declare
  v_provider uuid;
  v_client1 uuid;
  v_client2 uuid;
  v_client3 uuid;
  v_client4 uuid;
  v_client5 uuid;
  v_pkg uuid;
begin
  -- Resolve provider_id
  select id into v_provider from providers where code = 'global_connection';
  if v_provider is null then
    raise exception 'global_connection provider not found';
  end if;

  -- Resolve client IDs
  select id into v_client1 from billing_clients where name_normalized = 'maría josé ruiz';
  select id into v_client2 from billing_clients where name_normalized = 'carlos andrés martínez';
  select id into v_client3 from billing_clients where name_normalized = 'ana lucía pérez';
  select id into v_client4 from billing_clients where name_normalized = 'roberto carlos lópez';
  select id into v_client5 from billing_clients where name_normalized = 'daniela fernanda castillo';

  -- ── Package 1: María José Ruiz — AIR — entregado ──
  insert into packages (
    provider_id, organization_id, almacen_id, tracking_number, status,
    service_type, weight_lb, pieces, origin_office, dest_office,
    description, referencia_name, casillero, received_at, last_event_at, scraped_at, updated_at
  ) values (
    v_provider, 'solo-guegue', 'SG-100101', '1Z999AA10123456784', 'entregado',
    'aereo', 3.2, 1, 'MIA', 'MGA',
    'Funda para iPhone 15 Pro', 'María José Ruiz', '5012',
    now() - interval '18 days', now() - interval '12 days', now() - interval '1 day', now()
  )
  on conflict (provider_id, almacen_id) do nothing
  returning id into v_pkg;

  -- ── Package 2: Carlos Andrés Martínez — AIR — en_destino ──
  insert into packages (
    provider_id, organization_id, almacen_id, tracking_number, status,
    service_type, weight_lb, pieces, origin_office, dest_office,
    description, referencia_name, casillero, received_at, last_event_at, scraped_at, updated_at
  ) values (
    v_provider, 'solo-guegue', 'SG-100102', '1Z999AA10123456791', 'en_destino',
    'aereo', 5.1, 3, 'MIA', 'MGA',
    'Ropa - 3 piezas (camisa, pantalón, chaqueta)', 'Carlos Andrés Martínez', '5023',
    now() - interval '10 days', now() - interval '3 days', now() - interval '1 day', now()
  )
  on conflict (provider_id, almacen_id) do nothing
  returning id into v_pkg;

  -- ── Package 3: Ana Lucía Pérez — MAR — en_transito ──
  insert into packages (
    provider_id, organization_id, almacen_id, tracking_number, status,
    service_type, weight_lb, pieces, origin_office, dest_office,
    description, referencia_name, casillero, received_at, last_event_at, scraped_at, updated_at
  ) values (
    v_provider, 'solo-guegue', 'SG-100103', '1Z999AA10123456807', 'en_transito',
    'maritimo', 12.4, 1, 'MIA', 'MGA',
    'Licuadora Hamilton Beach 500W', 'Ana Lucía Pérez', '5034',
    now() - interval '25 days', now() - interval '8 days', now() - interval '1 day', now()
  )
  on conflict (provider_id, almacen_id) do nothing
  returning id into v_pkg;

  -- ── Package 4: Roberto Carlos López — AIR — en_almacen ──
  insert into packages (
    provider_id, organization_id, almacen_id, tracking_number, status,
    service_type, weight_lb, pieces, origin_office, dest_office,
    description, referencia_name, casillero, received_at, last_event_at, scraped_at, updated_at
  ) values (
    v_provider, 'solo-guegue', 'SG-100104', '1Z999AA10123456814', 'en_almacen',
    'aereo', 2.0, 4, 'MIA', 'MGA',
    'Libros - 4 unidades (novelas)', 'Roberto Carlos López', '5045',
    now() - interval '3 days', now() - interval '3 days', now() - interval '1 day', now()
  )
  on conflict (provider_id, almacen_id) do nothing
  returning id into v_pkg;

  -- ── Package 5: Daniela Fernanda Castillo — MAR — entregado ──
  insert into packages (
    provider_id, organization_id, almacen_id, tracking_number, status,
    service_type, weight_lb, pieces, origin_office, dest_office,
    description, referencia_name, casillero, received_at, last_event_at, scraped_at, updated_at
  ) values (
    v_provider, 'solo-guegue', 'SG-100105', '1Z999AA10123456821', 'entregado',
    'maritimo', 8.7, 2, 'MIA', 'MGA',
    'Set de construcción LEGO 600 piezas', 'Daniela Fernanda Castillo', '5056',
    now() - interval '30 days', now() - interval '15 days', now() - interval '1 day', now()
  )
  on conflict (provider_id, almacen_id) do nothing
  returning id into v_pkg;

  -- ── Package 6: María José Ruiz — AIR — en_destino ──
  insert into packages (
    provider_id, organization_id, almacen_id, tracking_number, status,
    service_type, weight_lb, pieces, origin_office, dest_office,
    description, referencia_name, casillero, received_at, last_event_at, scraped_at, updated_at
  ) values (
    v_provider, 'solo-guegue', 'SG-100106', '1Z999AA10123456838', 'en_destino',
    'aereo', 1.5, 1, 'MIA', 'MGA',
    'Set de skincare CeraVe (limpiador + hidratante)', 'María José Ruiz', '5012',
    now() - interval '7 days', now() - interval '2 days', now() - interval '1 day', now()
  )
  on conflict (provider_id, almacen_id) do nothing
  returning id into v_pkg;

  -- ── Package 7: Carlos Andrés Martínez — MAR — parcial ──
  insert into packages (
    provider_id, organization_id, almacen_id, tracking_number, status,
    service_type, weight_lb, pieces, origin_office, dest_office,
    description, referencia_name, casillero, received_at, last_event_at, scraped_at, updated_at
  ) values (
    v_provider, 'solo-guegue', 'SG-100107', '1Z999AA10123456845', 'parcial',
    'maritimo', 15.2, 1, 'MIA', 'MGA',
    'Mesa auxiliar de madera 60x40cm', 'Carlos Andrés Martínez', '5023',
    now() - interval '20 days', now() - interval '10 days', now() - interval '1 day', now()
  )
  on conflict (provider_id, almacen_id) do nothing
  returning id into v_pkg;

  -- ── Package 8: Ana Lucía Pérez — AIR — entregado ──
  insert into packages (
    provider_id, organization_id, almacen_id, tracking_number, status,
    service_type, weight_lb, pieces, origin_office, dest_office,
    description, referencia_name, casillero, received_at, last_event_at, scraped_at, updated_at
  ) values (
    v_provider, 'solo-guegue', 'SG-100108', '1Z999AA10123456852', 'entregado',
    'aereo', 4.3, 1, 'MIA', 'MGA',
    'Bolsa de mano Michael Kors', 'Ana Lucía Pérez', '5034',
    now() - interval '15 days', now() - interval '9 days', now() - interval '1 day', now()
  )
  on conflict (provider_id, almacen_id) do nothing
  returning id into v_pkg;

  -- ── Package 9: Roberto Carlos López — MAR — en_almacen ──
  insert into packages (
    provider_id, organization_id, almacen_id, tracking_number, status,
    service_type, weight_lb, pieces, origin_office, dest_office,
    description, referencia_name, casillero, received_at, last_event_at, scraped_at, updated_at
  ) values (
    v_provider, 'solo-guegue', 'SG-100109', '1Z999AA10123456869', 'en_almacen',
    'maritimo', 6.8, 1, 'MIA', 'MGA',
    'Set de llaves allen 20 piezas', 'Roberto Carlos López', '5045',
    now() - interval '5 days', now() - interval '5 days', now() - interval '1 day', now()
  )
  on conflict (provider_id, almacen_id) do nothing
  returning id into v_pkg;

  -- ── Package 10: Daniela Fernanda Castillo — AIR — en_transito ──
  insert into packages (
    provider_id, organization_id, almacen_id, tracking_number, status,
    service_type, weight_lb, pieces, origin_office, dest_office,
    description, referencia_name, casillero, received_at, last_event_at, scraped_at, updated_at
  ) values (
    v_provider, 'solo-guegue', 'SG-100110', '1Z999AA10123456876', 'en_transito',
    'aereo', 2.8, 2, 'MIA', 'MGA',
    'Zapatos deportivos Nike Air Max (2 pares)', 'Daniela Fernanda Castillo', '5056',
    now() - interval '8 days', now() - interval '4 days', now() - interval '1 day', now()
  )
  on conflict (provider_id, almacen_id) do nothing
  returning id into v_pkg;

  -- ── Package 11: María José Ruiz — MAR — en_destino ──
  insert into packages (
    provider_id, organization_id, almacen_id, tracking_number, status,
    service_type, weight_lb, pieces, origin_office, dest_office,
    description, referencia_name, casillero, received_at, last_event_at, scraped_at, updated_at
  ) values (
    v_provider, 'solo-guegue', 'SG-100111', '1Z999AA10123456883', 'en_destino',
    'maritimo', 10.5, 1, 'MIA', 'MGA',
    'Uniforme deportivo completo (2 conjuntos)', 'María José Ruiz', '5012',
    now() - interval '22 days', now() - interval '5 days', now() - interval '1 day', now()
  )
  on conflict (provider_id, almacen_id) do nothing
  returning id into v_pkg;

  -- ── Package 12: Carlos Andrés Martínez — AIR — entregado ──
  insert into packages (
    provider_id, organization_id, almacen_id, tracking_number, status,
    service_type, weight_lb, pieces, origin_office, dest_office,
    description, referencia_name, casillero, received_at, last_event_at, scraped_at, updated_at
  ) values (
    v_provider, 'solo-guegue', 'SG-100112', '1Z999AA10123456890', 'entregado',
    'aereo', 3.9, 1, 'MIA', 'MGA',
    'Audífonos Bluetooth JBL Tune 510BT', 'Carlos Andrés Martínez', '5023',
    now() - interval '14 days', now() - interval '8 days', now() - interval '1 day', now()
  )
  on conflict (provider_id, almacen_id) do nothing
  returning id into v_pkg;

end $$;

-- ─── 6. Tracking events ─────────────────────────────────────────────────────
-- Realistic event sequences per package status.
do $$
declare
  v_pkg_id uuid;
begin
  -- ── SG-100101 (entregado) ──
  select id into v_pkg_id from packages where almacen_id = 'SG-100101' and organization_id = 'solo-guegue';
  if v_pkg_id is not null then
    insert into events (package_id, occurred_at, office, description, status, source) values
      (v_pkg_id, now() - interval '18 days', 'MIA', 'Paquete recibido en bodega Miami', 'en_almacen', 'cargotrack'),
      (v_pkg_id, now() - interval '14 days', 'MIA', 'Paquete en tránsito internacional', 'en_transito', 'cargotrack'),
      (v_pkg_id, now() - interval '12 days', 'MGA', 'Paquete llegó a aduana Managua', 'en_destino', 'cargotrack'),
      (v_pkg_id, now() - interval '12 days', 'MGA', 'Paquete entregado al destinatario', 'entregado', 'cargotrack')
    on conflict (package_id, occurred_at, description) do nothing;
  end if;

  -- ── SG-100102 (en_destino) ──
  select id into v_pkg_id from packages where almacen_id = 'SG-100102' and organization_id = 'solo-guegue';
  if v_pkg_id is not null then
    insert into events (package_id, occurred_at, office, description, status, source) values
      (v_pkg_id, now() - interval '10 days', 'MIA', 'Paquete recibido en bodega Miami', 'en_almacen', 'cargotrack'),
      (v_pkg_id, now() - interval '6 days', 'MIA', 'Paquete en tránsito internacional', 'en_transito', 'cargotrack'),
      (v_pkg_id, now() - interval '3 days', 'MGA', 'Paquete llegó a aduana Managua', 'en_destino', 'cargotrack')
    on conflict (package_id, occurred_at, description) do nothing;
  end if;

  -- ── SG-100103 (en_transito) ──
  select id into v_pkg_id from packages where almacen_id = 'SG-100103' and organization_id = 'solo-guegue';
  if v_pkg_id is not null then
    insert into events (package_id, occurred_at, office, description, status, source) values
      (v_pkg_id, now() - interval '25 days', 'MIA', 'Paquete recibido en bodega Miami', 'en_almacen', 'cargotrack'),
      (v_pkg_id, now() - interval '8 days', 'MIA', 'Paquete en tránsito marítimo', 'en_transito', 'cargotrack')
    on conflict (package_id, occurred_at, description) do nothing;
  end if;

  -- ── SG-100104 (en_almacen) ──
  select id into v_pkg_id from packages where almacen_id = 'SG-100104' and organization_id = 'solo-guegue';
  if v_pkg_id is not null then
    insert into events (package_id, occurred_at, office, description, status, source) values
      (v_pkg_id, now() - interval '3 days', 'MIA', 'Paquete recibido en bodega Miami', 'en_almacen', 'cargotrack')
    on conflict (package_id, occurred_at, description) do nothing;
  end if;

  -- ── SG-100105 (entregado) ──
  select id into v_pkg_id from packages where almacen_id = 'SG-100105' and organization_id = 'solo-guegue';
  if v_pkg_id is not null then
    insert into events (package_id, occurred_at, office, description, status, source) values
      (v_pkg_id, now() - interval '30 days', 'MIA', 'Paquete recibido en bodega Miami', 'en_almacen', 'cargotrack'),
      (v_pkg_id, now() - interval '22 days', 'MIA', 'Paquete en tránsito marítimo', 'en_transito', 'cargotrack'),
      (v_pkg_id, now() - interval '16 days', 'MGA', 'Paquete llegó a aduana Managua', 'en_destino', 'cargotrack'),
      (v_pkg_id, now() - interval '15 days', 'MGA', 'Paquete entregado al destinatario', 'entregado', 'cargotrack')
    on conflict (package_id, occurred_at, description) do nothing;
  end if;

  -- ── SG-100106 (en_destino) ──
  select id into v_pkg_id from packages where almacen_id = 'SG-100106' and organization_id = 'solo-guegue';
  if v_pkg_id is not null then
    insert into events (package_id, occurred_at, office, description, status, source) values
      (v_pkg_id, now() - interval '7 days', 'MIA', 'Paquete recibido en bodega Miami', 'en_almacen', 'cargotrack'),
      (v_pkg_id, now() - interval '4 days', 'MIA', 'Paquete en tránsito internacional', 'en_transito', 'cargotrack'),
      (v_pkg_id, now() - interval '2 days', 'MGA', 'Paquete llegó a aduana Managua', 'en_destino', 'cargotrack')
    on conflict (package_id, occurred_at, description) do nothing;
  end if;

  -- ── SG-100107 (parcial) ──
  select id into v_pkg_id from packages where almacen_id = 'SG-100107' and organization_id = 'solo-guegue';
  if v_pkg_id is not null then
    insert into events (package_id, occurred_at, office, description, status, source) values
      (v_pkg_id, now() - interval '20 days', 'MIA', 'Paquete recibido en bodega Miami', 'en_almacen', 'cargotrack'),
      (v_pkg_id, now() - interval '10 days', 'MIA', 'Paquete processado parcialmente', 'parcial', 'cargotrack')
    on conflict (package_id, occurred_at, description) do nothing;
  end if;

  -- ── SG-100108 (entregado) ──
  select id into v_pkg_id from packages where almacen_id = 'SG-100108' and organization_id = 'solo-guegue';
  if v_pkg_id is not null then
    insert into events (package_id, occurred_at, office, description, status, source) values
      (v_pkg_id, now() - interval '15 days', 'MIA', 'Paquete recibido en bodega Miami', 'en_almacen', 'cargotrack'),
      (v_pkg_id, now() - interval '11 days', 'MIA', 'Paquete en tránsito internacional', 'en_transito', 'cargotrack'),
      (v_pkg_id, now() - interval '9 days', 'MGA', 'Paquete llegó a aduana Managua', 'en_destino', 'cargotrack'),
      (v_pkg_id, now() - interval '9 days', 'MGA', 'Paquete entregado al destinatario', 'entregado', 'cargotrack')
    on conflict (package_id, occurred_at, description) do nothing;
  end if;

  -- ── SG-100109 (en_almacen) ──
  select id into v_pkg_id from packages where almacen_id = 'SG-100109' and organization_id = 'solo-guegue';
  if v_pkg_id is not null then
    insert into events (package_id, occurred_at, office, description, status, source) values
      (v_pkg_id, now() - interval '5 days', 'MIA', 'Paquete recibido en bodega Miami', 'en_almacen', 'cargotrack')
    on conflict (package_id, occurred_at, description) do nothing;
  end if;

  -- ── SG-100110 (en_transito) ──
  select id into v_pkg_id from packages where almacen_id = 'SG-100110' and organization_id = 'solo-guegue';
  if v_pkg_id is not null then
    insert into events (package_id, occurred_at, office, description, status, source) values
      (v_pkg_id, now() - interval '8 days', 'MIA', 'Paquete recibido en bodega Miami', 'en_almacen', 'cargotrack'),
      (v_pkg_id, now() - interval '4 days', 'MIA', 'Paquete en tránsito internacional', 'en_transito', 'cargotrack')
    on conflict (package_id, occurred_at, description) do nothing;
  end if;

  -- ── SG-100111 (en_destino) ──
  select id into v_pkg_id from packages where almacen_id = 'SG-100111' and organization_id = 'solo-guegue';
  if v_pkg_id is not null then
    insert into events (package_id, occurred_at, office, description, status, source) values
      (v_pkg_id, now() - interval '22 days', 'MIA', 'Paquete recibido en bodega Miami', 'en_almacen', 'cargotrack'),
      (v_pkg_id, now() - interval '14 days', 'MIA', 'Paquete en tránsito marítimo', 'en_transito', 'cargotrack'),
      (v_pkg_id, now() - interval '5 days', 'MGA', 'Paquete llegó a aduana Managua', 'en_destino', 'cargotrack')
    on conflict (package_id, occurred_at, description) do nothing;
  end if;

  -- ── SG-100112 (entregado) ──
  select id into v_pkg_id from packages where almacen_id = 'SG-100112' and organization_id = 'solo-guegue';
  if v_pkg_id is not null then
    insert into events (package_id, occurred_at, office, description, status, source) values
      (v_pkg_id, now() - interval '14 days', 'MIA', 'Paquete recibido en bodega Miami', 'en_almacen', 'cargotrack'),
      (v_pkg_id, now() - interval '10 days', 'MIA', 'Paquete en tránsito internacional', 'en_transito', 'cargotrack'),
      (v_pkg_id, now() - interval '8 days', 'MGA', 'Paquete llegó a aduana Managua', 'en_destino', 'cargotrack'),
      (v_pkg_id, now() - interval '8 days', 'MGA', 'Paquete entregado al destinatario', 'entregado', 'cargotrack')
    on conflict (package_id, occurred_at, description) do nothing;
  end if;

end $$;

-- ─── Verify ─────────────────────────────────────────────────────────────────
-- Quick sanity checks (will show results when migration runs).
select 'agencies' as tbl, count(*) as cnt from agencies where slug = 'solo-guegue'
union all
select 'providers', count(*) from providers where organization_id = 'solo-guegue'
union all
select 'rate_tables', count(*) from rate_tables where organization_id = 'solo-guegue'
union all
select 'rate_rows', count(*) from rate_rows rr join rate_tables rt on rt.id = rr.rate_table_id where rt.organization_id = 'solo-guegue'
union all
select 'billing_clients', count(*) from billing_clients where name_normalized in ('maría josé ruiz','carlos andrés martínez','ana lucía pérez','roberto carlos lópez','daniela fernanda castillo')
union all
select 'packages', count(*) from packages where organization_id = 'solo-guegue'
union all
select 'events', count(*) from events e join packages p on p.id = e.package_id where p.organization_id = 'solo-guegue';
