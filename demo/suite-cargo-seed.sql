-- ============================================================================
-- Suite Cargo — demo dataset (fictional company)
-- ============================================================================
-- Idempotent seed for the demo: a complete, realistic-looking dataset for a
-- fictional freight forwarder ("Suite Cargo") living alongside the real HIT data
-- in the same InsForge project. Re-runnable: every INSERT uses deterministic
-- UUIDs and `on conflict do nothing`, so applying twice is a no-op.
--
--   provider     : suite_demo -> packages 800001..800040 (guía 9xxxxx avoided;
--                  real Cargotrack guías live in 2xxxxx-9xxxxx)
--   prices       : AIR 7.00 USD/lb, MAR 3.00 USD/lb (client-facing, stored per
--                  line item; freight_cost 5.80 / 2.20 => profit 1.20 / 0.80)
--   pricing_catalog is NOT touched (global table shared with production).
--   invoices     : 6001..6020 (2026), far above the real max (346) so the
--                  unique(fiscal_year, invoice_number) never collides. NOTE:
--                  nextInvoiceNumber() = max+1, so the next panel-created
--                  invoice will read 6021 — cosmetic gap, by design.
--   demo user    : demo@suite-cargo.com (created separately — see demo/README.md)
--   exceptions   : 2 off-catalog lines (6012, 6020), 1 quarantined payment
--                  (6018), 2 clients to_review (Valeria Quezada, Ferretería El
--                  Progreso) so the Exceptions view has content.
--
-- Apply:  npx @insforge/cli db import demo/suite-cargo-seed.sql
-- Verify: see queries at the bottom of this file.
-- ============================================================================


-- ─── provider ─────────────────────────────────────────────────────────────────
insert into providers (id, code, name, base_url, casillero_filter, active)
values ('d0000000-0000-4000-8000-000000000000', 'suite_demo', 'Suite Cargo',
        'https://demo.suitecargo.net', '8899', true)
on conflict (code) do nothing;

-- ─── packages ─────────────────────────────────────────────────────────────────
insert into packages (id, provider_id, almacen_id, tracking_number, status,
  raw_status, service_type, weight_lb, pieces, dimensions, origin_office,
  dest_office, description, remitente, referencia_name, casillero, declared_value,
  received_at, last_event_at, scraped_at, manual_status, manual_status_note)
values
('d0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000000', '800001', 'TBA8000007', 'en_almacen', 'IN WAREHOUSE', 'aereo', 10, 2, null, 'MIA', 'MGA', 'ELECTRONICO', 'AMAZON', 'María José Hernández', '8899', 133, '2026-06-15T09:00:00Z', '2026-06-16T10:00:00Z', '2026-08-13T04:00:00Z', null, null),
('d0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000000', '800002', 'SH700010', 'en_almacen', 'IN WAREHOUSE', 'aereo', 17, 3, null, 'MIA', 'MGA', 'ROPA', 'SHEIN', 'Carlos Andrés Mejía', '8899', 246, '2026-06-16T10:00:00Z', '2026-06-17T11:00:00Z', '2026-08-13T04:00:00Z', null, null),
('d0000000-0000-4000-8000-000000000003', 'd0000000-0000-4000-8000-000000000000', '800003', '100027', 'en_almacen', 'IN WAREHOUSE', 'maritimo', 24, 4, '23x18x15', 'MIA', 'MGA', 'CALZADO', 'EBAY', 'Ana Lucía Romero', '8899', 359, '2026-06-17T11:00:00Z', '2026-06-18T12:00:00Z', '2026-08-13T04:00:00Z', null, null),
('d0000000-0000-4000-8000-000000000004', 'd0000000-0000-4000-8000-000000000000', '800004', 'WM90012', 'en_almacen', 'IN WAREHOUSE', 'aereo', 31, 5, null, 'MIA', 'MGA', 'AUTOPARTES', 'WALMART', 'Diego Alejandro Fuentes', '8899', 72, '2026-06-18T12:00:00Z', '2026-06-19T13:00:00Z', '2026-08-13T04:00:00Z', null, null),
('d0000000-0000-4000-8000-000000000005', 'd0000000-0000-4000-8000-000000000000', '800005', 'AE60020', 'en_almacen', 'IN WAREHOUSE', 'aereo', 38, 1, null, 'MIA', 'MGA', 'COSMETICOS', 'ALIEXPRESS', 'Gabriela Martínez', '8899', 185, '2026-06-19T13:00:00Z', '2026-06-20T14:00:00Z', '2026-08-13T04:00:00Z', null, null),
('d0000000-0000-4000-8000-000000000006', 'd0000000-0000-4000-8000-000000000000', '800006', 'TT50036', 'en_almacen', 'IN WAREHOUSE', 'maritimo', 45, 2, '26x21x13', 'MIA', 'MGA', 'HERRAMIENTAS', 'TEMU', 'Jorge Luis Talavera', '8899', 298, '2026-06-20T14:00:00Z', '2026-06-21T15:00:00Z', '2026-08-13T04:00:00Z', null, null),
('d0000000-0000-4000-8000-000000000007', 'd0000000-0000-4000-8000-000000000000', '800007', 'EX40056', 'en_almacen', 'IN WAREHOUSE', 'aereo', 52, 3, null, 'MIA', 'MGA', 'ACCESORIOS', 'ETSY', 'Katherine Silva', '8899', 411, '2026-06-21T15:00:00Z', '2026-06-22T16:00:00Z', '2026-08-13T04:00:00Z', null, null),
('d0000000-0000-4000-8000-000000000008', 'd0000000-0000-4000-8000-000000000000', '800008', '1Z71008HR00896', 'en_almacen', 'IN WAREHOUSE', 'aereo', 59, 4, null, 'MIA', 'MGA', 'JUGUETES', 'B&H PHOTO', 'Ricardo Mendoza', '8899', 124, '2026-06-22T16:00:00Z', '2026-06-23T09:00:00Z', '2026-08-13T04:00:00Z', null, null),
('d0000000-0000-4000-8000-000000000009', 'd0000000-0000-4000-8000-000000000000', '800009', 'TBA8000063', 'en_almacen', 'IN WAREHOUSE', 'maritimo', 66, 5, '20x17x16', 'MIA', 'MGA', 'SUPLEMENTOS', 'AMAZON', 'Sofía del Carmen Palacios', '8899', 237, '2026-06-23T08:00:00Z', '2026-06-24T10:00:00Z', '2026-08-13T04:00:00Z', null, null),
('d0000000-0000-4000-8000-000000000010', 'd0000000-0000-4000-8000-000000000000', '800010', 'SH700050', 'en_transito', 'IN TRANSIT', 'aereo', 73, 1, null, 'MIA', 'MGA', 'LIBROS', 'SHEIN', 'Fernando Blandón', '8899', 350, '2026-06-24T09:00:00Z', '2026-06-28T11:00:00Z', '2026-08-13T04:00:00Z', null, null),
('d0000000-0000-4000-8000-000000000011', 'd0000000-0000-4000-8000-000000000000', '800011', '100099', 'en_transito', 'IN TRANSIT', 'aereo', 80, 2, null, 'MIA', 'MGA', 'REPUESTOS', 'EBAY', 'Valeria Quezada', '8899', 63, '2026-06-25T10:00:00Z', '2026-06-30T12:00:00Z', '2026-08-13T04:00:00Z', null, null),
('d0000000-0000-4000-8000-000000000012', 'd0000000-0000-4000-8000-000000000000', '800012', 'WM90036', 'en_transito', 'IN TRANSIT', 'maritimo', 9, 3, '23x20x14', 'MIA', 'MGA', 'EQUIPO DEPORTIVO', 'WALMART', 'Andrés Cabrera', '8899', 176, '2026-06-26T11:00:00Z', '2026-06-29T13:00:00Z', '2026-08-13T04:00:00Z', null, null),
('d0000000-0000-4000-8000-000000000013', 'd0000000-0000-4000-8000-000000000000', '800013', 'AE60052', 'en_transito', 'IN TRANSIT', 'aereo', 16, 4, null, 'MIA', 'MGA', 'ELECTRONICO', 'ALIEXPRESS', 'Lucía Dávila', '8899', 289, '2026-06-27T12:00:00Z', '2026-07-01T14:00:00Z', '2026-08-13T04:00:00Z', null, null),
('d0000000-0000-4000-8000-000000000014', 'd0000000-0000-4000-8000-000000000000', '800014', 'TT50084', 'en_transito', 'IN TRANSIT', 'aereo', 23, 5, null, 'MIA', 'MGA', 'ROPA', 'TEMU', 'Daniela Ríos', '8899', 402, '2026-06-28T13:00:00Z', '2026-07-03T15:00:00Z', '2026-08-13T04:00:00Z', null, null),
('d0000000-0000-4000-8000-000000000015', 'd0000000-0000-4000-8000-000000000000', '800015', 'EX40120', 'en_transito', 'IN TRANSIT', 'maritimo', 30, 1, '26x16x12', 'MIA', 'MGA', 'CALZADO', 'ETSY', 'Guadalupe Fonseca', '8899', 115, '2026-06-29T14:00:00Z', '2026-07-02T16:00:00Z', '2026-08-13T04:00:00Z', null, null),
('d0000000-0000-4000-8000-000000000016', 'd0000000-0000-4000-8000-000000000000', '800016', '1Z71016HR01696', 'en_transito', 'IN TRANSIT', 'aereo', 37, 2, null, 'MIA', 'MGA', 'AUTOPARTES', 'B&H PHOTO', 'Pedro José Castrillo', '8899', 228, '2026-06-30T15:00:00Z', '2026-07-04T09:00:00Z', '2026-08-13T04:00:00Z', null, null),
('d0000000-0000-4000-8000-000000000017', 'd0000000-0000-4000-8000-000000000000', '800017', 'TBA8000119', 'en_transito', 'IN TRANSIT', 'aereo', 44, 3, null, 'MIA', 'MGA', 'COSMETICOS', 'AMAZON', 'Marta Elena Urbina', '8899', 341, '2026-07-01T16:00:00Z', '2026-07-06T10:00:00Z', '2026-08-13T04:00:00Z', null, null),
('d0000000-0000-4000-8000-000000000018', 'd0000000-0000-4000-8000-000000000000', '800018', 'SH700090', 'en_transito', 'IN TRANSIT', 'maritimo', 51, 4, '20x19x15', 'MIA', 'MGA', 'HERRAMIENTAS', 'SHEIN', 'Roberto Cárcamo', '8899', 54, '2026-07-02T08:00:00Z', '2026-07-05T11:00:00Z', '2026-08-13T04:00:00Z', null, null),
('d0000000-0000-4000-8000-000000000019', 'd0000000-0000-4000-8000-000000000000', '800019', '100171', 'en_transito', 'IN TRANSIT', 'aereo', 58, 5, null, 'MIA', 'MGA', 'ACCESORIOS', 'EBAY', 'Andrea Tijerino', '8899', 167, '2026-07-03T09:00:00Z', '2026-07-07T12:00:00Z', '2026-08-13T04:00:00Z', null, null),
('d0000000-0000-4000-8000-000000000020', 'd0000000-0000-4000-8000-000000000000', '800020', 'WM90060', 'en_transito', 'IN TRANSIT', 'aereo', 65, 1, null, 'MIA', 'MGA', 'JUGUETES', 'WALMART', 'Silvia María Blandón', '8899', 280, '2026-07-04T10:00:00Z', '2026-07-09T13:00:00Z', '2026-08-13T04:00:00Z', null, null),
('d0000000-0000-4000-8000-000000000021', 'd0000000-0000-4000-8000-000000000000', '800021', 'AE60084', 'en_destino', 'AT DESTINATION', 'maritimo', 72, 2, '23x15x13', 'MIA', 'MGA', 'SUPLEMENTOS', 'ALIEXPRESS', 'Mauricio Lacayo', '8899', 393, '2026-07-05T11:00:00Z', '2026-07-12T14:00:00Z', '2026-08-13T04:00:00Z', null, null),
('d0000000-0000-4000-8000-000000000022', 'd0000000-0000-4000-8000-000000000000', '800022', 'TT50132', 'en_destino', 'AT DESTINATION', 'aereo', 79, 3, null, 'MIA', 'MGA', 'LIBROS', 'TEMU', 'Paola Gutiérrez', '8899', 106, '2026-07-06T12:00:00Z', '2026-07-14T15:00:00Z', '2026-08-13T04:00:00Z', null, null),
('d0000000-0000-4000-8000-000000000023', 'd0000000-0000-4000-8000-000000000000', '800023', 'EX40184', 'en_destino', 'AT DESTINATION', 'aereo', 8, 4, null, 'MIA', 'MGA', 'REPUESTOS', 'ETSY', 'Harold Bermúdez', '8899', 219, '2026-07-07T13:00:00Z', '2026-07-16T16:00:00Z', '2026-08-13T04:00:00Z', 'entregado', 'Cliente retiró en bodega Managua — marcado manualmente'),
('d0000000-0000-4000-8000-000000000024', 'd0000000-0000-4000-8000-000000000000', '800024', '1Z71024HR02496', 'en_destino', 'AT DESTINATION', 'maritimo', 15, 5, '26x18x16', 'MIA', 'MGA', 'EQUIPO DEPORTIVO', 'B&H PHOTO', 'Isabel Cuadra', '8899', 332, '2026-07-08T14:00:00Z', '2026-07-14T09:00:00Z', '2026-08-13T04:00:00Z', null, null),
('d0000000-0000-4000-8000-000000000025', 'd0000000-0000-4000-8000-000000000000', '800025', 'TBA8000175', 'en_destino', 'AT DESTINATION', 'aereo', 22, 1, null, 'MIA', 'MGA', 'ELECTRONICO', 'AMAZON', 'Esteban Urroz', '8899', 45, '2026-07-09T15:00:00Z', '2026-07-16T10:00:00Z', '2026-08-13T04:00:00Z', null, null),
('d0000000-0000-4000-8000-000000000026', 'd0000000-0000-4000-8000-000000000000', '800026', 'SH700130', 'en_destino', 'AT DESTINATION', 'aereo', 29, 2, null, 'MIA', 'MGA', 'ROPA', 'SHEIN', 'Rebeca Ocampo', '8899', 158, '2026-07-10T16:00:00Z', '2026-07-18T11:00:00Z', '2026-08-13T04:00:00Z', null, null),
('d0000000-0000-4000-8000-000000000027', 'd0000000-0000-4000-8000-000000000000', '800027', '100243', 'en_destino', 'AT DESTINATION', 'maritimo', 36, 3, '20x21x14', 'MIA', 'MGA', 'CALZADO', 'EBAY', 'Gilberto Sánchez', '8899', 271, '2026-07-11T08:00:00Z', '2026-07-20T12:00:00Z', '2026-08-13T04:00:00Z', null, null),
('d0000000-0000-4000-8000-000000000028', 'd0000000-0000-4000-8000-000000000000', '800028', 'WM90084', 'en_destino', 'AT DESTINATION', 'aereo', 43, 4, null, 'MIA', 'MGA', 'AUTOPARTES', 'WALMART', 'Natalia Rivas', '8899', 384, '2026-07-12T09:00:00Z', '2026-07-18T13:00:00Z', '2026-08-13T04:00:00Z', null, null),
('d0000000-0000-4000-8000-000000000029', 'd0000000-0000-4000-8000-000000000000', '800029', 'AE60116', 'en_transito', 'IN TRANSIT', 'aereo', 50, 5, null, 'MIA', 'MGA', 'COSMETICOS', 'ALIEXPRESS', 'Óscar Baltodano', '8899', 97, '2026-07-13T10:00:00Z', '2026-07-18T14:00:00Z', '2026-08-13T04:00:00Z', 'en_destino', 'Cliente confirmó recogida el viernes'),
('d0000000-0000-4000-8000-000000000030', 'd0000000-0000-4000-8000-000000000000', '800030', 'TT50180', 'entregado', 'DELIVERED', 'maritimo', 57, 1, '23x17x12', 'MIA', 'MGA', 'HERRAMIENTAS', 'TEMU', 'Marleny Fonseca', '8899', 210, '2026-07-14T11:00:00Z', '2026-07-24T15:00:00Z', '2026-08-13T04:00:00Z', null, null),
('d0000000-0000-4000-8000-000000000031', 'd0000000-0000-4000-8000-000000000000', '800031', 'EX40248', 'entregado', 'DELIVERED', 'aereo', 64, 2, null, 'MIA', 'MGA', 'ACCESORIOS', 'ETSY', 'Ferretería El Progreso', '8899', 323, '2026-07-15T12:00:00Z', '2026-07-26T16:00:00Z', '2026-08-13T04:00:00Z', null, null),
('d0000000-0000-4000-8000-000000000032', 'd0000000-0000-4000-8000-000000000000', '800032', '1Z71032HR03296', 'entregado', 'DELIVERED', 'aereo', 71, 3, null, 'MIA', 'MGA', 'JUGUETES', 'B&H PHOTO', 'Clínica Santa Lucía', '8899', 36, '2026-07-16T13:00:00Z', '2026-07-28T09:00:00Z', '2026-08-13T04:00:00Z', null, null),
('d0000000-0000-4000-8000-000000000033', 'd0000000-0000-4000-8000-000000000000', '800033', 'TBA8000231', 'entregado', 'DELIVERED', 'maritimo', 78, 4, '26x20x15', 'MIA', 'MGA', 'SUPLEMENTOS', 'AMAZON', 'Ericka Blandino', '8899', 149, '2026-07-17T14:00:00Z', '2026-07-30T10:00:00Z', '2026-08-13T04:00:00Z', null, null),
('d0000000-0000-4000-8000-000000000034', 'd0000000-0000-4000-8000-000000000000', '800034', 'SH700170', 'entregado', 'DELIVERED', 'aereo', 7, 5, null, 'MIA', 'MGA', 'LIBROS', 'SHEIN', 'Juan Pablo Argüello', '8899', 262, '2026-07-18T15:00:00Z', '2026-08-01T11:00:00Z', '2026-08-13T04:00:00Z', null, null),
('d0000000-0000-4000-8000-000000000035', 'd0000000-0000-4000-8000-000000000000', '800035', '100315', 'entregado', 'DELIVERED', 'aereo', 14, 1, null, 'MIA', 'MGA', 'REPUESTOS', 'EBAY', 'Teresa Rostrán', '8899', 375, '2026-07-19T16:00:00Z', '2026-07-29T12:00:00Z', '2026-08-13T04:00:00Z', null, null),
('d0000000-0000-4000-8000-000000000036', 'd0000000-0000-4000-8000-000000000000', '800036', 'WM90108', 'entregado', 'DELIVERED', 'maritimo', 21, 2, '20x16x13', 'MIA', 'MGA', 'EQUIPO DEPORTIVO', 'WALMART', 'Óscar de la Rocha', '8899', 88, '2026-07-20T08:00:00Z', '2026-07-31T13:00:00Z', '2026-08-13T04:00:00Z', null, null),
('d0000000-0000-4000-8000-000000000037', 'd0000000-0000-4000-8000-000000000000', '800037', 'AE60148', 'excepcion', 'HELD', 'aereo', 28, 3, null, 'MIA', 'MGA', 'ELECTRONICO', 'ALIEXPRESS', 'Melissa Villagra', '8899', 201, '2026-07-21T09:00:00Z', '2026-07-24T14:00:00Z', '2026-08-13T04:00:00Z', null, null),
('d0000000-0000-4000-8000-000000000038', 'd0000000-0000-4000-8000-000000000000', '800038', 'TT50228', 'excepcion', 'HELD', 'aereo', 35, 4, null, 'MIA', 'MGA', 'ROPA', 'TEMU', 'Raúl Picado', '8899', 314, '2026-07-22T10:00:00Z', '2026-07-26T15:00:00Z', '2026-08-13T04:00:00Z', null, null),
('d0000000-0000-4000-8000-000000000039', 'd0000000-0000-4000-8000-000000000000', '800039', 'EX40312', 'parcial', 'PARTIAL', 'maritimo', 42, 5, '23x19x16', 'MIA', 'MGA', 'CALZADO', 'ETSY', 'Claudia Blandón', '8899', 27, '2026-07-23T11:00:00Z', '2026-07-25T16:00:00Z', '2026-08-13T04:00:00Z', null, null),
('d0000000-0000-4000-8000-000000000040', 'd0000000-0000-4000-8000-000000000000', '800040', '1Z71040HR04096', 'parcial', 'PARTIAL', 'aereo', 49, 1, null, 'MIA', 'MGA', 'AUTOPARTES', 'B&H PHOTO', 'Henry Castellón', '8899', 140, '2026-07-24T12:00:00Z', '2026-07-27T09:00:00Z', '2026-08-13T04:00:00Z', null, null)
on conflict (provider_id, almacen_id) do nothing;

-- ─── events (tracking timeline) ───────────────────────────────────────────────
insert into events (id, package_id, occurred_at, office, description, status, source)
values
('d8000000-0000-4000-8000-000000000010', 'd0000000-0000-4000-8000-000000000001', '2026-06-15T15:00:00Z', 'MIA', 'Recibido en bodega Miami', 'en_almacen', 'suite'),
('d8000000-0000-4000-8000-000000000011', 'd0000000-0000-4000-8000-000000000001', '2026-06-17T15:00:00Z', 'MIA', 'Almacenado – pendiente de despacho', 'en_almacen', 'suite'),
('d8000000-0000-4000-8000-000000000012', 'd0000000-0000-4000-8000-000000000001', '2026-06-20T15:00:00Z', 'MIA', 'Escaneado en bodega Miami', 'en_almacen', 'suite'),
('d8000000-0000-4000-8000-000000000020', 'd0000000-0000-4000-8000-000000000002', '2026-06-16T16:00:00Z', 'MIA', 'Recibido en bodega Miami', 'en_almacen', 'suite'),
('d8000000-0000-4000-8000-000000000021', 'd0000000-0000-4000-8000-000000000002', '2026-06-18T16:00:00Z', 'MIA', 'Almacenado – pendiente de despacho', 'en_almacen', 'suite'),
('d8000000-0000-4000-8000-000000000022', 'd0000000-0000-4000-8000-000000000002', '2026-06-21T16:00:00Z', 'MIA', 'Escaneado en bodega Miami', 'en_almacen', 'suite'),
('d8000000-0000-4000-8000-000000000030', 'd0000000-0000-4000-8000-000000000003', '2026-06-17T17:00:00Z', 'MIA', 'Recibido en bodega Miami', 'en_almacen', 'suite'),
('d8000000-0000-4000-8000-000000000031', 'd0000000-0000-4000-8000-000000000003', '2026-06-19T17:00:00Z', 'MIA', 'Almacenado – pendiente de despacho', 'en_almacen', 'suite'),
('d8000000-0000-4000-8000-000000000032', 'd0000000-0000-4000-8000-000000000003', '2026-06-22T17:00:00Z', 'MIA', 'Escaneado en bodega Miami', 'en_almacen', 'suite'),
('d8000000-0000-4000-8000-000000000040', 'd0000000-0000-4000-8000-000000000004', '2026-06-18T18:00:00Z', 'MIA', 'Recibido en bodega Miami', 'en_almacen', 'suite'),
('d8000000-0000-4000-8000-000000000041', 'd0000000-0000-4000-8000-000000000004', '2026-06-20T18:00:00Z', 'MIA', 'Almacenado – pendiente de despacho', 'en_almacen', 'suite'),
('d8000000-0000-4000-8000-000000000042', 'd0000000-0000-4000-8000-000000000004', '2026-06-23T18:00:00Z', 'MIA', 'Escaneado en bodega Miami', 'en_almacen', 'suite'),
('d8000000-0000-4000-8000-000000000050', 'd0000000-0000-4000-8000-000000000005', '2026-06-19T19:00:00Z', 'MIA', 'Recibido en bodega Miami', 'en_almacen', 'suite'),
('d8000000-0000-4000-8000-000000000051', 'd0000000-0000-4000-8000-000000000005', '2026-06-21T19:00:00Z', 'MIA', 'Almacenado – pendiente de despacho', 'en_almacen', 'suite'),
('d8000000-0000-4000-8000-000000000052', 'd0000000-0000-4000-8000-000000000005', '2026-06-24T19:00:00Z', 'MIA', 'Escaneado en bodega Miami', 'en_almacen', 'suite'),
('d8000000-0000-4000-8000-000000000060', 'd0000000-0000-4000-8000-000000000006', '2026-06-20T20:00:00Z', 'MIA', 'Recibido en bodega Miami', 'en_almacen', 'suite'),
('d8000000-0000-4000-8000-000000000061', 'd0000000-0000-4000-8000-000000000006', '2026-06-22T20:00:00Z', 'MIA', 'Almacenado – pendiente de despacho', 'en_almacen', 'suite'),
('d8000000-0000-4000-8000-000000000062', 'd0000000-0000-4000-8000-000000000006', '2026-06-25T20:00:00Z', 'MIA', 'Escaneado en bodega Miami', 'en_almacen', 'suite'),
('d8000000-0000-4000-8000-000000000070', 'd0000000-0000-4000-8000-000000000007', '2026-06-21T21:00:00Z', 'MIA', 'Recibido en bodega Miami', 'en_almacen', 'suite'),
('d8000000-0000-4000-8000-000000000071', 'd0000000-0000-4000-8000-000000000007', '2026-06-23T21:00:00Z', 'MIA', 'Almacenado – pendiente de despacho', 'en_almacen', 'suite'),
('d8000000-0000-4000-8000-000000000072', 'd0000000-0000-4000-8000-000000000007', '2026-06-26T21:00:00Z', 'MIA', 'Escaneado en bodega Miami', 'en_almacen', 'suite'),
('d8000000-0000-4000-8000-000000000080', 'd0000000-0000-4000-8000-000000000008', '2026-06-22T22:00:00Z', 'MIA', 'Recibido en bodega Miami', 'en_almacen', 'suite'),
('d8000000-0000-4000-8000-000000000081', 'd0000000-0000-4000-8000-000000000008', '2026-06-24T22:00:00Z', 'MIA', 'Almacenado – pendiente de despacho', 'en_almacen', 'suite'),
('d8000000-0000-4000-8000-000000000082', 'd0000000-0000-4000-8000-000000000008', '2026-06-27T22:00:00Z', 'MIA', 'Escaneado en bodega Miami', 'en_almacen', 'suite'),
('d8000000-0000-4000-8000-000000000090', 'd0000000-0000-4000-8000-000000000009', '2026-06-23T14:00:00Z', 'MIA', 'Recibido en bodega Miami', 'en_almacen', 'suite'),
('d8000000-0000-4000-8000-000000000091', 'd0000000-0000-4000-8000-000000000009', '2026-06-25T14:00:00Z', 'MIA', 'Almacenado – pendiente de despacho', 'en_almacen', 'suite'),
('d8000000-0000-4000-8000-000000000092', 'd0000000-0000-4000-8000-000000000009', '2026-06-28T14:00:00Z', 'MIA', 'Escaneado en bodega Miami', 'en_almacen', 'suite'),
('d8000000-0000-4000-8000-000000000100', 'd0000000-0000-4000-8000-000000000010', '2026-06-24T15:00:00Z', 'MIA', 'Recibido en bodega Miami', 'en_transito', 'suite'),
('d8000000-0000-4000-8000-000000000101', 'd0000000-0000-4000-8000-000000000010', '2026-06-26T15:00:00Z', 'MGA', 'Procesado y embarcado a Nicaragua', 'en_transito', 'suite'),
('d8000000-0000-4000-8000-000000000102', 'd0000000-0000-4000-8000-000000000010', '2026-06-29T15:00:00Z', 'MGA', 'En tránsito hacia Managua', 'en_transito', 'suite'),
('d8000000-0000-4000-8000-000000000110', 'd0000000-0000-4000-8000-000000000011', '2026-06-25T16:00:00Z', 'MIA', 'Recibido en bodega Miami', 'en_transito', 'suite'),
('d8000000-0000-4000-8000-000000000111', 'd0000000-0000-4000-8000-000000000011', '2026-06-27T16:00:00Z', 'MGA', 'Procesado y embarcado a Nicaragua', 'en_transito', 'suite'),
('d8000000-0000-4000-8000-000000000112', 'd0000000-0000-4000-8000-000000000011', '2026-06-30T16:00:00Z', 'MGA', 'En tránsito hacia Managua', 'en_transito', 'suite'),
('d8000000-0000-4000-8000-000000000120', 'd0000000-0000-4000-8000-000000000012', '2026-06-26T17:00:00Z', 'MIA', 'Recibido en bodega Miami', 'en_transito', 'suite'),
('d8000000-0000-4000-8000-000000000121', 'd0000000-0000-4000-8000-000000000012', '2026-06-28T17:00:00Z', 'MGA', 'Procesado y embarcado a Nicaragua', 'en_transito', 'suite'),
('d8000000-0000-4000-8000-000000000122', 'd0000000-0000-4000-8000-000000000012', '2026-07-01T17:00:00Z', 'MGA', 'En tránsito hacia Managua', 'en_transito', 'suite'),
('d8000000-0000-4000-8000-000000000130', 'd0000000-0000-4000-8000-000000000013', '2026-06-27T18:00:00Z', 'MIA', 'Recibido en bodega Miami', 'en_transito', 'suite'),
('d8000000-0000-4000-8000-000000000131', 'd0000000-0000-4000-8000-000000000013', '2026-06-29T18:00:00Z', 'MGA', 'Procesado y embarcado a Nicaragua', 'en_transito', 'suite'),
('d8000000-0000-4000-8000-000000000132', 'd0000000-0000-4000-8000-000000000013', '2026-07-02T18:00:00Z', 'MGA', 'En tránsito hacia Managua', 'en_transito', 'suite'),
('d8000000-0000-4000-8000-000000000140', 'd0000000-0000-4000-8000-000000000014', '2026-06-28T19:00:00Z', 'MIA', 'Recibido en bodega Miami', 'en_transito', 'suite'),
('d8000000-0000-4000-8000-000000000141', 'd0000000-0000-4000-8000-000000000014', '2026-06-30T19:00:00Z', 'MGA', 'Procesado y embarcado a Nicaragua', 'en_transito', 'suite'),
('d8000000-0000-4000-8000-000000000142', 'd0000000-0000-4000-8000-000000000014', '2026-07-03T19:00:00Z', 'MGA', 'En tránsito hacia Managua', 'en_transito', 'suite'),
('d8000000-0000-4000-8000-000000000150', 'd0000000-0000-4000-8000-000000000015', '2026-06-29T20:00:00Z', 'MIA', 'Recibido en bodega Miami', 'en_transito', 'suite'),
('d8000000-0000-4000-8000-000000000151', 'd0000000-0000-4000-8000-000000000015', '2026-07-01T20:00:00Z', 'MGA', 'Procesado y embarcado a Nicaragua', 'en_transito', 'suite'),
('d8000000-0000-4000-8000-000000000152', 'd0000000-0000-4000-8000-000000000015', '2026-07-04T20:00:00Z', 'MGA', 'En tránsito hacia Managua', 'en_transito', 'suite'),
('d8000000-0000-4000-8000-000000000160', 'd0000000-0000-4000-8000-000000000016', '2026-06-30T21:00:00Z', 'MIA', 'Recibido en bodega Miami', 'en_transito', 'suite'),
('d8000000-0000-4000-8000-000000000161', 'd0000000-0000-4000-8000-000000000016', '2026-07-02T21:00:00Z', 'MGA', 'Procesado y embarcado a Nicaragua', 'en_transito', 'suite'),
('d8000000-0000-4000-8000-000000000162', 'd0000000-0000-4000-8000-000000000016', '2026-07-05T21:00:00Z', 'MGA', 'En tránsito hacia Managua', 'en_transito', 'suite'),
('d8000000-0000-4000-8000-000000000170', 'd0000000-0000-4000-8000-000000000017', '2026-07-01T22:00:00Z', 'MIA', 'Recibido en bodega Miami', 'en_transito', 'suite'),
('d8000000-0000-4000-8000-000000000171', 'd0000000-0000-4000-8000-000000000017', '2026-07-03T22:00:00Z', 'MGA', 'Procesado y embarcado a Nicaragua', 'en_transito', 'suite'),
('d8000000-0000-4000-8000-000000000172', 'd0000000-0000-4000-8000-000000000017', '2026-07-06T22:00:00Z', 'MGA', 'En tránsito hacia Managua', 'en_transito', 'suite'),
('d8000000-0000-4000-8000-000000000180', 'd0000000-0000-4000-8000-000000000018', '2026-07-02T14:00:00Z', 'MIA', 'Recibido en bodega Miami', 'en_transito', 'suite'),
('d8000000-0000-4000-8000-000000000181', 'd0000000-0000-4000-8000-000000000018', '2026-07-04T14:00:00Z', 'MGA', 'Procesado y embarcado a Nicaragua', 'en_transito', 'suite'),
('d8000000-0000-4000-8000-000000000182', 'd0000000-0000-4000-8000-000000000018', '2026-07-07T14:00:00Z', 'MGA', 'En tránsito hacia Managua', 'en_transito', 'suite'),
('d8000000-0000-4000-8000-000000000190', 'd0000000-0000-4000-8000-000000000019', '2026-07-03T15:00:00Z', 'MIA', 'Recibido en bodega Miami', 'en_transito', 'suite'),
('d8000000-0000-4000-8000-000000000191', 'd0000000-0000-4000-8000-000000000019', '2026-07-05T15:00:00Z', 'MGA', 'Procesado y embarcado a Nicaragua', 'en_transito', 'suite'),
('d8000000-0000-4000-8000-000000000192', 'd0000000-0000-4000-8000-000000000019', '2026-07-08T15:00:00Z', 'MGA', 'En tránsito hacia Managua', 'en_transito', 'suite'),
('d8000000-0000-4000-8000-000000000200', 'd0000000-0000-4000-8000-000000000020', '2026-07-04T16:00:00Z', 'MIA', 'Recibido en bodega Miami', 'en_transito', 'suite'),
('d8000000-0000-4000-8000-000000000201', 'd0000000-0000-4000-8000-000000000020', '2026-07-06T16:00:00Z', 'MGA', 'Procesado y embarcado a Nicaragua', 'en_transito', 'suite'),
('d8000000-0000-4000-8000-000000000202', 'd0000000-0000-4000-8000-000000000020', '2026-07-09T16:00:00Z', 'MGA', 'En tránsito hacia Managua', 'en_transito', 'suite'),
('d8000000-0000-4000-8000-000000000210', 'd0000000-0000-4000-8000-000000000021', '2026-07-05T17:00:00Z', 'MIA', 'Recibido en bodega Miami', 'en_destino', 'suite'),
('d8000000-0000-4000-8000-000000000211', 'd0000000-0000-4000-8000-000000000021', '2026-07-07T17:00:00Z', 'MGA', 'Llegó a Managua – en aduana', 'en_destino', 'suite'),
('d8000000-0000-4000-8000-000000000212', 'd0000000-0000-4000-8000-000000000021', '2026-07-10T17:00:00Z', 'MGA', 'Disponible para recogida en bodega Managua', 'en_destino', 'suite'),
('d8000000-0000-4000-8000-000000000213', 'd0000000-0000-4000-8000-000000000021', '2026-07-13T17:00:00Z', 'MGA', 'Contactado para entrega', 'en_destino', 'suite'),
('d8000000-0000-4000-8000-000000000220', 'd0000000-0000-4000-8000-000000000022', '2026-07-06T18:00:00Z', 'MIA', 'Recibido en bodega Miami', 'en_destino', 'suite'),
('d8000000-0000-4000-8000-000000000221', 'd0000000-0000-4000-8000-000000000022', '2026-07-08T18:00:00Z', 'MGA', 'Llegó a Managua – en aduana', 'en_destino', 'suite'),
('d8000000-0000-4000-8000-000000000222', 'd0000000-0000-4000-8000-000000000022', '2026-07-11T18:00:00Z', 'MGA', 'Disponible para recogida en bodega Managua', 'en_destino', 'suite'),
('d8000000-0000-4000-8000-000000000223', 'd0000000-0000-4000-8000-000000000022', '2026-07-14T18:00:00Z', 'MGA', 'Contactado para entrega', 'en_destino', 'suite'),
('d8000000-0000-4000-8000-000000000230', 'd0000000-0000-4000-8000-000000000023', '2026-07-07T19:00:00Z', 'MIA', 'Recibido en bodega Miami', 'en_destino', 'suite'),
('d8000000-0000-4000-8000-000000000231', 'd0000000-0000-4000-8000-000000000023', '2026-07-09T19:00:00Z', 'MGA', 'Llegó a Managua – en aduana', 'en_destino', 'suite'),
('d8000000-0000-4000-8000-000000000232', 'd0000000-0000-4000-8000-000000000023', '2026-07-12T19:00:00Z', 'MGA', 'Disponible para recogida en bodega Managua', 'en_destino', 'suite'),
('d8000000-0000-4000-8000-000000000233', 'd0000000-0000-4000-8000-000000000023', '2026-07-15T19:00:00Z', 'MGA', 'Contactado para entrega', 'en_destino', 'suite'),
('d8000000-0000-4000-8000-000000000240', 'd0000000-0000-4000-8000-000000000024', '2026-07-08T20:00:00Z', 'MIA', 'Recibido en bodega Miami', 'en_destino', 'suite'),
('d8000000-0000-4000-8000-000000000241', 'd0000000-0000-4000-8000-000000000024', '2026-07-10T20:00:00Z', 'MGA', 'Llegó a Managua – en aduana', 'en_destino', 'suite'),
('d8000000-0000-4000-8000-000000000242', 'd0000000-0000-4000-8000-000000000024', '2026-07-13T20:00:00Z', 'MGA', 'Disponible para recogida en bodega Managua', 'en_destino', 'suite'),
('d8000000-0000-4000-8000-000000000243', 'd0000000-0000-4000-8000-000000000024', '2026-07-16T20:00:00Z', 'MGA', 'Contactado para entrega', 'en_destino', 'suite'),
('d8000000-0000-4000-8000-000000000250', 'd0000000-0000-4000-8000-000000000025', '2026-07-09T21:00:00Z', 'MIA', 'Recibido en bodega Miami', 'en_destino', 'suite'),
('d8000000-0000-4000-8000-000000000251', 'd0000000-0000-4000-8000-000000000025', '2026-07-11T21:00:00Z', 'MGA', 'Llegó a Managua – en aduana', 'en_destino', 'suite'),
('d8000000-0000-4000-8000-000000000252', 'd0000000-0000-4000-8000-000000000025', '2026-07-14T21:00:00Z', 'MGA', 'Disponible para recogida en bodega Managua', 'en_destino', 'suite'),
('d8000000-0000-4000-8000-000000000253', 'd0000000-0000-4000-8000-000000000025', '2026-07-17T21:00:00Z', 'MGA', 'Contactado para entrega', 'en_destino', 'suite'),
('d8000000-0000-4000-8000-000000000260', 'd0000000-0000-4000-8000-000000000026', '2026-07-10T22:00:00Z', 'MIA', 'Recibido en bodega Miami', 'en_destino', 'suite'),
('d8000000-0000-4000-8000-000000000261', 'd0000000-0000-4000-8000-000000000026', '2026-07-12T22:00:00Z', 'MGA', 'Llegó a Managua – en aduana', 'en_destino', 'suite'),
('d8000000-0000-4000-8000-000000000262', 'd0000000-0000-4000-8000-000000000026', '2026-07-15T22:00:00Z', 'MGA', 'Disponible para recogida en bodega Managua', 'en_destino', 'suite'),
('d8000000-0000-4000-8000-000000000263', 'd0000000-0000-4000-8000-000000000026', '2026-07-18T22:00:00Z', 'MGA', 'Contactado para entrega', 'en_destino', 'suite'),
('d8000000-0000-4000-8000-000000000270', 'd0000000-0000-4000-8000-000000000027', '2026-07-11T14:00:00Z', 'MIA', 'Recibido en bodega Miami', 'en_destino', 'suite'),
('d8000000-0000-4000-8000-000000000271', 'd0000000-0000-4000-8000-000000000027', '2026-07-13T14:00:00Z', 'MGA', 'Llegó a Managua – en aduana', 'en_destino', 'suite'),
('d8000000-0000-4000-8000-000000000272', 'd0000000-0000-4000-8000-000000000027', '2026-07-16T14:00:00Z', 'MGA', 'Disponible para recogida en bodega Managua', 'en_destino', 'suite'),
('d8000000-0000-4000-8000-000000000273', 'd0000000-0000-4000-8000-000000000027', '2026-07-19T14:00:00Z', 'MGA', 'Contactado para entrega', 'en_destino', 'suite'),
('d8000000-0000-4000-8000-000000000280', 'd0000000-0000-4000-8000-000000000028', '2026-07-12T15:00:00Z', 'MIA', 'Recibido en bodega Miami', 'en_destino', 'suite'),
('d8000000-0000-4000-8000-000000000281', 'd0000000-0000-4000-8000-000000000028', '2026-07-14T15:00:00Z', 'MGA', 'Llegó a Managua – en aduana', 'en_destino', 'suite'),
('d8000000-0000-4000-8000-000000000282', 'd0000000-0000-4000-8000-000000000028', '2026-07-17T15:00:00Z', 'MGA', 'Disponible para recogida en bodega Managua', 'en_destino', 'suite'),
('d8000000-0000-4000-8000-000000000283', 'd0000000-0000-4000-8000-000000000028', '2026-07-20T15:00:00Z', 'MGA', 'Contactado para entrega', 'en_destino', 'suite'),
('d8000000-0000-4000-8000-000000000290', 'd0000000-0000-4000-8000-000000000029', '2026-07-13T16:00:00Z', 'MIA', 'Recibido en bodega Miami', 'en_transito', 'suite'),
('d8000000-0000-4000-8000-000000000291', 'd0000000-0000-4000-8000-000000000029', '2026-07-15T16:00:00Z', 'MGA', 'Procesado y embarcado a Nicaragua', 'en_transito', 'suite'),
('d8000000-0000-4000-8000-000000000292', 'd0000000-0000-4000-8000-000000000029', '2026-07-18T16:00:00Z', 'MGA', 'En tránsito hacia Managua', 'en_transito', 'suite'),
('d8000000-0000-4000-8000-000000000300', 'd0000000-0000-4000-8000-000000000030', '2026-07-14T17:00:00Z', 'MIA', 'Recibido en bodega Miami', 'entregado', 'suite'),
('d8000000-0000-4000-8000-000000000301', 'd0000000-0000-4000-8000-000000000030', '2026-07-16T17:00:00Z', 'MGA', 'Llegó a Managua – en aduana', 'entregado', 'suite'),
('d8000000-0000-4000-8000-000000000302', 'd0000000-0000-4000-8000-000000000030', '2026-07-19T17:00:00Z', 'MGA', 'Disponible para recogida en bodega Managua', 'entregado', 'suite'),
('d8000000-0000-4000-8000-000000000303', 'd0000000-0000-4000-8000-000000000030', '2026-07-22T17:00:00Z', 'MGA', 'Entregado en destino', 'entregado', 'suite'),
('d8000000-0000-4000-8000-000000000310', 'd0000000-0000-4000-8000-000000000031', '2026-07-15T18:00:00Z', 'MIA', 'Recibido en bodega Miami', 'entregado', 'suite'),
('d8000000-0000-4000-8000-000000000311', 'd0000000-0000-4000-8000-000000000031', '2026-07-17T18:00:00Z', 'MGA', 'Llegó a Managua – en aduana', 'entregado', 'suite'),
('d8000000-0000-4000-8000-000000000312', 'd0000000-0000-4000-8000-000000000031', '2026-07-20T18:00:00Z', 'MGA', 'Disponible para recogida en bodega Managua', 'entregado', 'suite'),
('d8000000-0000-4000-8000-000000000313', 'd0000000-0000-4000-8000-000000000031', '2026-07-23T18:00:00Z', 'MGA', 'Entregado en destino', 'entregado', 'suite'),
('d8000000-0000-4000-8000-000000000320', 'd0000000-0000-4000-8000-000000000032', '2026-07-16T19:00:00Z', 'MIA', 'Recibido en bodega Miami', 'entregado', 'suite'),
('d8000000-0000-4000-8000-000000000321', 'd0000000-0000-4000-8000-000000000032', '2026-07-18T19:00:00Z', 'MGA', 'Llegó a Managua – en aduana', 'entregado', 'suite'),
('d8000000-0000-4000-8000-000000000322', 'd0000000-0000-4000-8000-000000000032', '2026-07-21T19:00:00Z', 'MGA', 'Disponible para recogida en bodega Managua', 'entregado', 'suite'),
('d8000000-0000-4000-8000-000000000323', 'd0000000-0000-4000-8000-000000000032', '2026-07-24T19:00:00Z', 'MGA', 'Entregado en destino', 'entregado', 'suite'),
('d8000000-0000-4000-8000-000000000330', 'd0000000-0000-4000-8000-000000000033', '2026-07-17T20:00:00Z', 'MIA', 'Recibido en bodega Miami', 'entregado', 'suite'),
('d8000000-0000-4000-8000-000000000331', 'd0000000-0000-4000-8000-000000000033', '2026-07-19T20:00:00Z', 'MGA', 'Llegó a Managua – en aduana', 'entregado', 'suite'),
('d8000000-0000-4000-8000-000000000332', 'd0000000-0000-4000-8000-000000000033', '2026-07-22T20:00:00Z', 'MGA', 'Disponible para recogida en bodega Managua', 'entregado', 'suite'),
('d8000000-0000-4000-8000-000000000333', 'd0000000-0000-4000-8000-000000000033', '2026-07-25T20:00:00Z', 'MGA', 'Entregado en destino', 'entregado', 'suite'),
('d8000000-0000-4000-8000-000000000340', 'd0000000-0000-4000-8000-000000000034', '2026-07-18T21:00:00Z', 'MIA', 'Recibido en bodega Miami', 'entregado', 'suite'),
('d8000000-0000-4000-8000-000000000341', 'd0000000-0000-4000-8000-000000000034', '2026-07-20T21:00:00Z', 'MGA', 'Llegó a Managua – en aduana', 'entregado', 'suite'),
('d8000000-0000-4000-8000-000000000342', 'd0000000-0000-4000-8000-000000000034', '2026-07-23T21:00:00Z', 'MGA', 'Disponible para recogida en bodega Managua', 'entregado', 'suite'),
('d8000000-0000-4000-8000-000000000343', 'd0000000-0000-4000-8000-000000000034', '2026-07-26T21:00:00Z', 'MGA', 'Entregado en destino', 'entregado', 'suite'),
('d8000000-0000-4000-8000-000000000350', 'd0000000-0000-4000-8000-000000000035', '2026-07-19T22:00:00Z', 'MIA', 'Recibido en bodega Miami', 'entregado', 'suite'),
('d8000000-0000-4000-8000-000000000351', 'd0000000-0000-4000-8000-000000000035', '2026-07-21T22:00:00Z', 'MGA', 'Llegó a Managua – en aduana', 'entregado', 'suite'),
('d8000000-0000-4000-8000-000000000352', 'd0000000-0000-4000-8000-000000000035', '2026-07-24T22:00:00Z', 'MGA', 'Disponible para recogida en bodega Managua', 'entregado', 'suite'),
('d8000000-0000-4000-8000-000000000353', 'd0000000-0000-4000-8000-000000000035', '2026-07-27T22:00:00Z', 'MGA', 'Entregado en destino', 'entregado', 'suite'),
('d8000000-0000-4000-8000-000000000360', 'd0000000-0000-4000-8000-000000000036', '2026-07-20T14:00:00Z', 'MIA', 'Recibido en bodega Miami', 'entregado', 'suite'),
('d8000000-0000-4000-8000-000000000361', 'd0000000-0000-4000-8000-000000000036', '2026-07-22T14:00:00Z', 'MGA', 'Llegó a Managua – en aduana', 'entregado', 'suite'),
('d8000000-0000-4000-8000-000000000362', 'd0000000-0000-4000-8000-000000000036', '2026-07-25T14:00:00Z', 'MGA', 'Disponible para recogida en bodega Managua', 'entregado', 'suite'),
('d8000000-0000-4000-8000-000000000363', 'd0000000-0000-4000-8000-000000000036', '2026-07-28T14:00:00Z', 'MGA', 'Entregado en destino', 'entregado', 'suite'),
('d8000000-0000-4000-8000-000000000370', 'd0000000-0000-4000-8000-000000000037', '2026-07-21T15:00:00Z', 'MIA', 'Recibido en bodega Miami', 'excepcion', 'suite'),
('d8000000-0000-4000-8000-000000000371', 'd0000000-0000-4000-8000-000000000037', '2026-07-23T15:00:00Z', 'MGA', 'Retenido – verificar documentación', 'excepcion', 'suite'),
('d8000000-0000-4000-8000-000000000372', 'd0000000-0000-4000-8000-000000000037', '2026-07-26T15:00:00Z', 'MGA', 'Aduana – solicitar cotización de arancel', 'excepcion', 'suite'),
('d8000000-0000-4000-8000-000000000373', 'd0000000-0000-4000-8000-000000000037', '2026-07-29T15:00:00Z', 'MGA', 'Esperando corrección del remitente', 'excepcion', 'suite'),
('d8000000-0000-4000-8000-000000000380', 'd0000000-0000-4000-8000-000000000038', '2026-07-22T16:00:00Z', 'MIA', 'Recibido en bodega Miami', 'excepcion', 'suite'),
('d8000000-0000-4000-8000-000000000381', 'd0000000-0000-4000-8000-000000000038', '2026-07-24T16:00:00Z', 'MGA', 'Retenido – verificar documentación', 'excepcion', 'suite'),
('d8000000-0000-4000-8000-000000000382', 'd0000000-0000-4000-8000-000000000038', '2026-07-27T16:00:00Z', 'MGA', 'Aduana – solicitar cotización de arancel', 'excepcion', 'suite'),
('d8000000-0000-4000-8000-000000000383', 'd0000000-0000-4000-8000-000000000038', '2026-07-30T16:00:00Z', 'MGA', 'Esperando corrección del remitente', 'excepcion', 'suite'),
('d8000000-0000-4000-8000-000000000390', 'd0000000-0000-4000-8000-000000000039', '2026-07-23T17:00:00Z', 'MIA', 'Recibido en bodega Miami', 'parcial', 'suite'),
('d8000000-0000-4000-8000-000000000391', 'd0000000-0000-4000-8000-000000000039', '2026-07-25T17:00:00Z', 'MGA', 'Parcial – pendiente consolidar', 'parcial', 'suite'),
('d8000000-0000-4000-8000-000000000392', 'd0000000-0000-4000-8000-000000000039', '2026-07-28T17:00:00Z', 'MGA', 'Recibido primer embarque parcial', 'parcial', 'suite'),
('d8000000-0000-4000-8000-000000000400', 'd0000000-0000-4000-8000-000000000040', '2026-07-24T18:00:00Z', 'MIA', 'Recibido en bodega Miami', 'parcial', 'suite'),
('d8000000-0000-4000-8000-000000000401', 'd0000000-0000-4000-8000-000000000040', '2026-07-26T18:00:00Z', 'MGA', 'Parcial – pendiente consolidar', 'parcial', 'suite'),
('d8000000-0000-4000-8000-000000000402', 'd0000000-0000-4000-8000-000000000040', '2026-07-29T18:00:00Z', 'MGA', 'Recibido primer embarque parcial', 'parcial', 'suite'),
('d8000000-0000-4000-8000-000000000039', 'd0000000-0000-4000-8000-000000000003', '2026-06-23T11:00:00Z', 'MIA', 'Aduana – revisión de documentación completada', 'en_almacen', 'suite'),
('d8000000-0000-4000-8000-000000000159', 'd0000000-0000-4000-8000-000000000015', '2026-07-05T14:00:00Z', 'MIA', 'Aduana – revisión de documentación completada', 'en_transito', 'suite'),
('d8000000-0000-4000-8000-000000000279', 'd0000000-0000-4000-8000-000000000027', '2026-07-17T08:00:00Z', 'MIA', 'Aduana – revisión de documentación completada', 'en_destino', 'suite')

on conflict (package_id, occurred_at, description) do nothing;

-- ─── billing_clients ──────────────────────────────────────────────────────────
insert into billing_clients (id, name, name_normalized, casillero, to_review)
values
('d1000000-0000-4000-8000-000000000001', 'María José Hernández', 'maría josé hernández', '8899', false),
('d1000000-0000-4000-8000-000000000002', 'Carlos Andrés Mejía', 'carlos andrés mejía', '8899', false),
('d1000000-0000-4000-8000-000000000003', 'Ana Lucía Romero', 'ana lucía romero', '8899', false),
('d1000000-0000-4000-8000-000000000004', 'Diego Alejandro Fuentes', 'diego alejandro fuentes', '8899', false),
('d1000000-0000-4000-8000-000000000005', 'Gabriela Martínez', 'gabriela martínez', '8899', false),
('d1000000-0000-4000-8000-000000000006', 'Jorge Luis Talavera', 'jorge luis talavera', null, false),
('d1000000-0000-4000-8000-000000000007', 'Katherine Silva', 'katherine silva', null, false),
('d1000000-0000-4000-8000-000000000008', 'Ricardo Mendoza', 'ricardo mendoza', '8899', false),
('d1000000-0000-4000-8000-000000000009', 'Sofía del Carmen Palacios', 'sofía del carmen palacios', null, false),
('d1000000-0000-4000-8000-000000000010', 'Fernando Blandón', 'fernando blandón', null, false),
('d1000000-0000-4000-8000-000000000011', 'Valeria Quezada', 'valeria quezada', null, true),
('d1000000-0000-4000-8000-000000000012', 'Andrés Cabrera', 'andrés cabrera', null, false),
('d1000000-0000-4000-8000-000000000013', 'Lucía Dávila', 'lucía dávila', null, false),
('d1000000-0000-4000-8000-000000000014', 'Daniela Ríos', 'daniela ríos', null, false),
('d1000000-0000-4000-8000-000000000015', 'Ferretería El Progreso', 'ferretería el progreso', '8899', true),
('d1000000-0000-4000-8000-000000000016', 'Clínica Santa Lucía', 'clínica santa lucía', '8899', false)

on conflict (name_normalized) do nothing;

-- ─── invoices (header) ────────────────────────────────────────────────────────
-- 20 invoices across Jun-Aug 2026: 8 PAID, 5 PARTIAL, 3 ISSUED, 2 DRAFT, 2 VOID.
insert into invoices (id, invoice_number, fiscal_year, client_id, client_name_raw,
  issue_date, status, address, special_price, observations, tracking_orders,
  source, total, profit, paid_usd, paid_at)
values
('d2000000-0000-4000-8000-000000006001', 6001, 2026, 'd1000000-0000-4000-8000-000000000001', 'María José Hernández', '2026-06-10', 'PAID', 'Rotonda El Periodista, 3 c. al lago, Managua', true, null, ARRAY['800001'], null, 84.00, 14.40, 84.00, '2026-06-10T18:00:00Z'),
('d2000000-0000-4000-8000-000000006002', 6002, 2026, 'd1000000-0000-4000-8000-000000000002', 'Carlos Andrés Mejía', '2026-06-12', 'PAID', null, true, 'Cliente paga en NIO — tasa 36.5', ARRAY['800002'], null, 135.00, 36.00, 135.00, '2026-06-12T18:00:00Z'),
('d2000000-0000-4000-8000-000000006003', 6003, 2026, 'd1000000-0000-4000-8000-000000000005', 'Gabriela Martínez', '2026-06-15', 'PAID', null, true, null, ARRAY['800003'], null, 56.00, 9.60, 56.00, '2026-06-15T18:00:00Z'),
('d2000000-0000-4000-8000-000000006004', 6004, 2026, 'd1000000-0000-4000-8000-000000000015', 'Ferretería El Progreso', '2026-06-18', 'PARTIAL', null, false, null, ARRAY['800004'], null, 360.00, 96.00, 120.00, null),
('d2000000-0000-4000-8000-000000006005', 6005, 2026, 'd1000000-0000-4000-8000-000000000004', 'Diego Alejandro Fuentes', '2026-06-22', 'ISSUED', null, false, null, ARRAY['800005'], null, 42.00, 7.20, 0.00, null),
('d2000000-0000-4000-8000-000000006006', 6006, 2026, 'd1000000-0000-4000-8000-000000000016', 'Clínica Santa Lucía', '2026-06-25', 'PAID', 'Cantera Sur, de la iglesia 2 c. arriba, Managua', true, null, ARRAY['800006'], null, 255.00, 68.00, 255.00, '2026-06-25T18:00:00Z'),
('d2000000-0000-4000-8000-000000006007', 6007, 2026, 'd1000000-0000-4000-8000-000000000006', 'Jorge Luis Talavera', '2026-06-29', 'VOID', null, false, 'Cliente anuló el pedido, factura duplicada de OC', ARRAY['800007'], null, 105.00, 18.00, 0.00, null),
('d2000000-0000-4000-8000-000000006008', 6008, 2026, 'd1000000-0000-4000-8000-000000000007', 'Katherine Silva', '2026-07-03', 'PARTIAL', null, false, null, ARRAY['800008'], null, 63.00, 10.80, 35.00, null),
('d2000000-0000-4000-8000-000000006009', 6009, 2026, 'd1000000-0000-4000-8000-000000000008', 'Ricardo Mendoza', '2026-07-06', 'PAID', 'Masaya, frente a la estación de bomberos', true, null, ARRAY['800009'], null, 180.00, 48.00, 180.00, '2026-07-06T18:00:00Z'),
('d2000000-0000-4000-8000-000000006010', 6010, 2026, 'd1000000-0000-4000-8000-000000000009', 'Sofía del Carmen Palacios', '2026-07-09', 'ISSUED', null, false, null, ARRAY['800010'], null, 126.00, 21.60, 0.00, null),
('d2000000-0000-4000-8000-000000006011', 6011, 2026, 'd1000000-0000-4000-8000-000000000010', 'Fernando Blandón', '2026-07-12', 'PAID', 'León, 2 c. al norte de la Catedral', true, null, ARRAY['800011'], null, 167.00, 37.20, 167.00, '2026-07-12T18:00:00Z'),
('d2000000-0000-4000-8000-000000006012', 6012, 2026, 'd1000000-0000-4000-8000-000000000011', 'Valeria Quezada', '2026-07-15', 'DRAFT', null, false, 'Precio especial no publicado en catálogo — repasar con el cliente', ARRAY['800012'], null, 55.30, 14.70, 0.00, null),
('d2000000-0000-4000-8000-000000006013', 6013, 2026, 'd1000000-0000-4000-8000-000000000012', 'Andrés Cabrera', '2026-07-18', 'PARTIAL', null, false, null, ARRAY['800013'], null, 285.00, 76.00, 100.00, null),
('d2000000-0000-4000-8000-000000006014', 6014, 2026, 'd1000000-0000-4000-8000-000000000013', 'Lucía Dávila', '2026-07-21', 'PAID', 'Granada, calle Atravesada', true, null, ARRAY['800014'], null, 98.00, 16.80, 98.00, '2026-07-21T18:00:00Z'),
('d2000000-0000-4000-8000-000000006015', 6015, 2026, 'd1000000-0000-4000-8000-000000000014', 'Daniela Ríos', '2026-07-24', 'ISSUED', null, false, null, ARRAY['800015'], null, 120.00, 32.00, 0.00, null),
('d2000000-0000-4000-8000-000000006016', 6016, 2026, 'd1000000-0000-4000-8000-000000000001', 'María José Hernández', '2026-07-27', 'PAID', 'Managua, Las Colinas, casa 12', true, null, ARRAY['800016'], null, 70.00, 12.00, 70.00, '2026-07-27T18:00:00Z'),
('d2000000-0000-4000-8000-000000006017', 6017, 2026, 'd1000000-0000-4000-8000-000000000002', 'Carlos Andrés Mejía', '2026-07-30', 'PARTIAL', null, false, null, ARRAY['800017'], null, 165.00, 44.00, 80.00, null),
('d2000000-0000-4000-8000-000000006018', 6018, 2026, 'd1000000-0000-4000-8000-000000000005', 'Gabriela Martínez', '2026-08-03', 'ISSUED', null, false, 'Pago prometido vía transferencia — pendiente de acreditar', ARRAY['800018'], null, 154.00, 26.40, 0.00, null),
('d2000000-0000-4000-8000-000000006019', 6019, 2026, 'd1000000-0000-4000-8000-000000000008', 'Ricardo Mendoza', '2026-08-06', 'VOID', null, false, 'Factura anulada — rectificación de peso', ARRAY['800019'], null, 110.00, 26.00, 0.00, null),
('d2000000-0000-4000-8000-000000006020', 6020, 2026, 'd1000000-0000-4000-8000-000000000015', 'Ferretería El Progreso', '2026-08-10', 'DRAFT', 'Carretera Norte, km 8, Zona Franca Las Mercedes', false, 'Pendiente de confirmar embarque marítimo completo', ARRAY['800020'], null, 476.00, 168.00, 0.00, null)

on conflict (fiscal_year, invoice_number) do nothing;

-- ─── invoice_line_items (prices 7 / 3 stored per line) ────────────────────────
insert into invoice_line_items (id, invoice_id, line_no, description, freight_type,
  quantity_lbs, unit, unit_price, total, list_price, freight_cost, profit,
  price_tier, price_off_catalog)
values
('d3000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000006001', 1, null, 'AIR', 12, 'lbs', 7.00, 84.00, null, 69.60, 14.40, 'REGULAR', false),
('d3000000-0000-4000-8000-000000000002', 'd2000000-0000-4000-8000-000000006002', 1, null, 'MAR', 45, 'lbs', 3.00, 135.00, null, 99.00, 36.00, 'REGULAR', false),
('d3000000-0000-4000-8000-000000000003', 'd2000000-0000-4000-8000-000000006003', 1, null, 'AIR', 8, 'lbs', 7.00, 56.00, null, 46.40, 9.60, 'REGULAR', false),
('d3000000-0000-4000-8000-000000000004', 'd2000000-0000-4000-8000-000000006004', 1, null, 'MAR', 120, 'lbs', 3.00, 360.00, null, 264.00, 96.00, 'REGULAR', false),
('d3000000-0000-4000-8000-000000000005', 'd2000000-0000-4000-8000-000000006005', 1, null, 'AIR', 6, 'lbs', 7.00, 42.00, null, 34.80, 7.20, 'REGULAR', false),
('d3000000-0000-4000-8000-000000000006', 'd2000000-0000-4000-8000-000000006006', 1, null, 'MAR', 85, 'lbs', 3.00, 255.00, null, 187.00, 68.00, 'REGULAR', false),
('d3000000-0000-4000-8000-000000000007', 'd2000000-0000-4000-8000-000000006007', 1, null, 'AIR', 15, 'lbs', 7.00, 105.00, null, 87.00, 18.00, 'REGULAR', false),
('d3000000-0000-4000-8000-000000000008', 'd2000000-0000-4000-8000-000000006008', 1, null, 'AIR', 9, 'lbs', 7.00, 63.00, null, 52.20, 10.80, 'REGULAR', false),
('d3000000-0000-4000-8000-000000000009', 'd2000000-0000-4000-8000-000000006009', 1, null, 'MAR', 60, 'lbs', 3.00, 180.00, null, 132.00, 48.00, 'REGULAR', false),
('d3000000-0000-4000-8000-000000000010', 'd2000000-0000-4000-8000-000000006010', 1, null, 'AIR', 18, 'lbs', 7.00, 126.00, null, 104.40, 21.60, 'REGULAR', false),
('d3000000-0000-4000-8000-000000000011', 'd2000000-0000-4000-8000-000000006011', 1, null, 'AIR', 11, 'lbs', 7.00, 77.00, null, 63.80, 13.20, 'REGULAR', false),
('d3000000-0000-4000-8000-000000000012', 'd2000000-0000-4000-8000-000000006011', 2, null, 'MAR', 30, 'lbs', 3.00, 90.00, null, 66.00, 24.00, 'REGULAR', false),
('d3000000-0000-4000-8000-000000000013', 'd2000000-0000-4000-8000-000000006012', 1, null, 'AIR', 7, 'lbs', 7.90, 55.30, null, 40.60, 14.70, 'REGULAR', true),
('d3000000-0000-4000-8000-000000000014', 'd2000000-0000-4000-8000-000000006013', 1, null, 'MAR', 95, 'lbs', 3.00, 285.00, null, 209.00, 76.00, 'REGULAR', false),
('d3000000-0000-4000-8000-000000000015', 'd2000000-0000-4000-8000-000000006014', 1, null, 'AIR', 14, 'lbs', 7.00, 98.00, null, 81.20, 16.80, 'REGULAR', false),
('d3000000-0000-4000-8000-000000000016', 'd2000000-0000-4000-8000-000000006015', 1, null, 'MAR', 40, 'lbs', 3.00, 120.00, null, 88.00, 32.00, 'REGULAR', false),
('d3000000-0000-4000-8000-000000000017', 'd2000000-0000-4000-8000-000000006016', 1, null, 'AIR', 10, 'lbs', 7.00, 70.00, null, 58.00, 12.00, 'REGULAR', false),
('d3000000-0000-4000-8000-000000000018', 'd2000000-0000-4000-8000-000000006017', 1, null, 'MAR', 55, 'lbs', 3.00, 165.00, null, 121.00, 44.00, 'REGULAR', false),
('d3000000-0000-4000-8000-000000000019', 'd2000000-0000-4000-8000-000000006018', 1, null, 'AIR', 22, 'lbs', 7.00, 154.00, null, 127.60, 26.40, 'REGULAR', false),
('d3000000-0000-4000-8000-000000000020', 'd2000000-0000-4000-8000-000000006019', 1, null, 'AIR', 5, 'lbs', 7.00, 35.00, null, 29.00, 6.00, 'REGULAR', false),
('d3000000-0000-4000-8000-000000000021', 'd2000000-0000-4000-8000-000000006019', 2, null, 'MAR', 25, 'lbs', 3.00, 75.00, null, 55.00, 20.00, 'REGULAR', false),
('d3000000-0000-4000-8000-000000000022', 'd2000000-0000-4000-8000-000000006020', 1, null, 'MAR', 140, 'lbs', 3.40, 476.00, null, 308.00, 168.00, 'REGULAR', true)

  on conflict (id) do nothing;

-- ─── invoice_payments ─────────────────────────────────────────────────────────
insert into invoice_payments (id, invoice_id, method, bank, currency, amount,
  amount_usd, fx_rate, paid_at, raw, quarantined)
values
('d4000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000006001', 'BANK_TRANSFER', 'BAC', 'USD', 84.00, 84.00, null, '2026-06-10T13:00:00Z', null, false),
('d4000000-0000-4000-8000-000000000002', 'd2000000-0000-4000-8000-000000006002', 'BANK_TRANSFER', 'LAFISE', 'NIO', 4927.50, 135.00, 36.50, '2026-06-12T14:00:00Z', null, false),
('d4000000-0000-4000-8000-000000000003', 'd2000000-0000-4000-8000-000000006003', 'CASH', null, 'USD', 56.00, 56.00, null, '2026-06-15T15:00:00Z', null, false),
('d4000000-0000-4000-8000-000000000004', 'd2000000-0000-4000-8000-000000006004', 'BANK_TRANSFER', 'BANPRO', 'NIO', 4380.00, 120.00, 36.50, '2026-06-18T16:00:00Z', null, false),
('d4000000-0000-4000-8000-000000000005', 'd2000000-0000-4000-8000-000000006006', 'BANK_TRANSFER', 'LAFISE', 'USD', 255.00, 255.00, null, '2026-06-25T17:00:00Z', null, false),
('d4000000-0000-4000-8000-000000000006', 'd2000000-0000-4000-8000-000000006008', 'CASH', null, 'USD', 35.00, 35.00, null, '2026-07-03T12:00:00Z', null, false),
('d4000000-0000-4000-8000-000000000007', 'd2000000-0000-4000-8000-000000006009', 'BANK_TRANSFER', 'BANPRO', 'USD', 180.00, 180.00, null, '2026-07-06T13:00:00Z', null, false),
('d4000000-0000-4000-8000-000000000008', 'd2000000-0000-4000-8000-000000006011', 'BANK_TRANSFER', 'BAC', 'USD', 167.00, 167.00, null, '2026-07-12T14:00:00Z', null, false),
('d4000000-0000-4000-8000-000000000009', 'd2000000-0000-4000-8000-000000006013', 'BANK_TRANSFER', 'LAFISE', 'USD', 100.00, 100.00, null, '2026-07-18T15:00:00Z', null, false),
('d4000000-0000-4000-8000-000000000010', 'd2000000-0000-4000-8000-000000006014', 'CASH', null, 'USD', 98.00, 98.00, null, '2026-07-21T16:00:00Z', null, false),
('d4000000-0000-4000-8000-000000000011', 'd2000000-0000-4000-8000-000000006016', 'BANK_TRANSFER', 'BAC', 'USD', 70.00, 70.00, null, '2026-07-27T17:00:00Z', null, false),
('d4000000-0000-4000-8000-000000000012', 'd2000000-0000-4000-8000-000000006017', 'BANK_TRANSFER', 'BANPRO', 'USD', 80.00, 80.00, null, '2026-07-30T12:00:00Z', null, false),
('d4000000-0000-4000-8000-000000000999', 'd2000000-0000-4000-8000-000000006018', null, null, null, null, null, null, null, 'PENDIENTE DE PAGO', true)

on conflict (id) do nothing;

-- ─── invoice_packages (invoice <-> package links) ─────────────────────────────
insert into invoice_packages (id, invoice_id, package_id, source, matched_oc, created_by)
values
('d5000000-0000-4000-8000-000000006001', 'd2000000-0000-4000-8000-000000006001', 'd0000000-0000-4000-8000-000000000001', 'auto', '800001', null),
('d5000000-0000-4000-8000-000000006002', 'd2000000-0000-4000-8000-000000006002', 'd0000000-0000-4000-8000-000000000002', 'auto', '800002', null),
('d5000000-0000-4000-8000-000000006004', 'd2000000-0000-4000-8000-000000006004', 'd0000000-0000-4000-8000-000000000004', 'auto', '800004', null),
('d5000000-0000-4000-8000-000000006006', 'd2000000-0000-4000-8000-000000006006', 'd0000000-0000-4000-8000-000000000006', 'auto', '800006', null),
('d5000000-0000-4000-8000-000000006008', 'd2000000-0000-4000-8000-000000006008', 'd0000000-0000-4000-8000-000000000008', 'auto', '800008', null),
('d5000000-0000-4000-8000-000000006010', 'd2000000-0000-4000-8000-000000006010', 'd0000000-0000-4000-8000-000000000010', 'auto', '800010', null),
('d5000000-0000-4000-8000-000000006012', 'd2000000-0000-4000-8000-000000006012', 'd0000000-0000-4000-8000-000000000012', 'auto', '800012', null),
('d5000000-0000-4000-8000-000000006013', 'd2000000-0000-4000-8000-000000006013', 'd0000000-0000-4000-8000-000000000013', 'auto', '800013', null),
('d5000000-0000-4000-8000-000000006014', 'd2000000-0000-4000-8000-000000006014', 'd0000000-0000-4000-8000-000000000014', 'auto', '800014', null),
('d5000000-0000-4000-8000-000000006016', 'd2000000-0000-4000-8000-000000006016', 'd0000000-0000-4000-8000-000000000016', 'auto', '800016', null),
('d5000000-0000-4000-8000-000000006018', 'd2000000-0000-4000-8000-000000006018', 'd0000000-0000-4000-8000-000000000018', 'auto', '800018', null),
('d5000000-0000-4000-8000-000000006020', 'd2000000-0000-4000-8000-000000006020', 'd0000000-0000-4000-8000-000000000020', 'auto', '800020', null)

on conflict (invoice_id, package_id) do nothing;

-- ─── package_tags / package_notes (control notes from the panel) ──────────────
insert into package_tags (id, package_id, label, value, created_by)
values
('d6000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', 'estado', 'VIP', 'demo@suite-cargo.com'),
('d6000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001', 'metodo_pago', 'transferencia', 'demo@suite-cargo.com'),
('d6000000-0000-4000-8000-000000000003', 'd0000000-0000-4000-8000-000000000011', 'cliente', 'frecuente', 'demo@suite-cargo.com'),
('d6000000-0000-4000-8000-000000000004', 'd0000000-0000-4000-8000-000000000011', 'seguro', 'declarado', 'demo@suite-cargo.com'),
('d6000000-0000-4000-8000-000000000005', 'd0000000-0000-4000-8000-000000000027', 'excepcion', 'aduanas', 'demo@suite-cargo.com'),
('d6000000-0000-4000-8000-000000000006', 'd0000000-0000-4000-8000-000000000029', 'pago', 'verificado', 'demo@suite-cargo.com'),
('d6000000-0000-4000-8000-000000000007', 'd0000000-0000-4000-8000-000000000038', 'fragil', 'si', 'demo@suite-cargo.com')

on conflict (id) do nothing;

insert into package_notes (id, package_id, body, created_by)
values
('d7000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', 'Confirmar dirección de entrega con la clienta antes del despacho.', 'demo@suite-cargo.com'),
('d7000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000004', 'Factura compartida con el cliente — esperando transferencia BANPRO.', 'demo@suite-cargo.com'),
('d7000000-0000-4000-8000-000000000003', 'd0000000-0000-4000-8000-000000000011', 'Cliente frecuente: consolidar con su próximo pedido si vuelve a comprar esta semana.', 'demo@suite-cargo.com'),
('d7000000-0000-4000-8000-000000000004', 'd0000000-0000-4000-8000-000000000027', 'Retenido en aduana — se solicitó cotización de arancel.', 'demo@suite-cargo.com'),
('d7000000-0000-4000-8000-000000000005', 'd0000000-0000-4000-8000-000000000038', 'Mercancía frágil: indicar manejo cuidadoso al transportista.', 'demo@suite-cargo.com')

on conflict (id) do nothing;

-- ─── verification queries (after applying, expect the counts below) ───────────
-- select 'providers' t, count(*) from providers where code='suite_demo'
-- union all select 'packages', count(*) from packages where provider_id='d0000000-0000-4000-8000-000000000000'
-- union all select 'events',   count(*) from events e join packages p on p.id=e.package_id where p.provider_id='d0000000-0000-4000-8000-000000000000'
-- union all select 'clients',  count(*) from billing_clients where name_normalized like '%quezada%' or name_normalized like '%progreso%'
-- union all select 'invoices', count(*) from invoices where invoice_number between 6000 and 6020
-- union all select 'lines',    count(*) from invoice_line_items l join invoices i on i.id=l.invoice_id where i.invoice_number between 6000 and 6020
-- union all select 'payments', count(*) from invoice_payments p join invoices i on i.id=p.invoice_id where i.invoice_number between 6000 and 6020
-- Expected: providers=1, packages=40, events=140, clients=16,
-- invoices=20, lines=22, payments=14 (13 valid + 1 quarantined), links=12, tags=7, notes=5
