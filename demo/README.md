# Demo Suite Cargo — dataset ficticio de demostración

Data completa fake-pero-real para la **empresa ficticia "Suite Cargo"**, insertada
junto a la data real de HIT en el mismo proyecto InsForge. Su propósito es
demostrar el flujo completo del panel (login → envíos → clientes → facturación →
reportes) con una empresa distinta, nombres latinos y tarifas $7/lb aéreo y
$3/lb marítimo.

> **No es una migración.** Es data de demostración: reusable, idempotente y
> descartable. El esquema no cambia.

## Qué inserta

| Tabla | Contenido demo | Identificación |
|---|---|---|
| `providers` | `suite_demo` (Suite Cargo) | `code='suite_demo'` |
| `packages` | 40 guías `800001..800040`, estados variados, nombres latinos | guía `8xxxxx` + provider `suite_demo` |
| `events` | 140 eventos de timeline (3-4 por guía) | `source='suite'` |
| `billing_clients` | 16 clientes con nombres latinos (2 `to_review`) | `casillero='8899'` |
| `invoices` | 20 facturas 2026 (`6001..6020`): 8 PAID, 5 PARTIAL, 3 ISSUED, 2 DRAFT, 2 VOID | número `60xx` |
| `invoice_line_items` | Precio **7.00 USD/lb AIR** y **3.00 USD/lb MAR**; costo interno ficticio 5.80 / 2.20 | — |
| `invoice_payments` | 13 pagos (transferencia BAC/LAFISE/BANPRO, efectivo, USD y NIO fx 36.5) + 1 cuarentena | — |
| `invoice_packages` | 12 links factura ↔ guía (`source='auto'`) | — |
| `package_tags` / `package_notes` | 7 tags + 5 notas de control | `created_by='demo@suite-cargo.com'` |

## Aplicar / re-aplicar

```bash
npx @insforge/cli db import demo/suite-cargo-seed.sql
```

Idempotente: re-aplicarlo es un no-op (UUIDs deterministas + `on conflict do nothing`).
Los conteos esperados están al final del archivo SQL.

## Verificación rápida

```sql
select count(*) from packages where almacen_id like '8000%';          -- 40
select count(*) from invoices where invoice_number between 6000 and 6020;  -- 20
```

## Usuario demo

Email **`demo@suite-cargo.com`** (rol `admin`). La contraseña vive en
`../hit-panel/ADMIN-CREDENTIALS-DEMO.local.txt` (gitignored, entregada por
separado) — ver `hit-panel/docs/04-admin-access-and-user-management.md` para el
procedimiento de creación.

## Efectos colaterales conocidos (por diseño)

- **Siguiente factura real será #6021**: `nextInvoiceNumber()` = max+1 del año
  fiscal; el gap 347→6021 es cosmético (número no es secuencial-requerido).
- **El cotizador y la creación de facturas en vivo usan el catálogo global de
  HIT** (6.5 / 2.5): `pricing_catalog` es global y NO se toca (rompería la
  ingesta real). Solo la data sembrada lleva 7 / 3 por línea.
- **Dashboard y reportes agregan data de ambas empresas** (sin concepto de
  tenant aún): filtrar por provider `suite_demo` / facturas `60xx` para aislar
  la demo.
- Las facturas demo con `price_off_catalog=true` (6012, 6020) y el pago en
  cuarentena (6018) aparecen en **Excepciones** — intencional, para mostrar la
  cola.

## Limpiar (si algún día se retira la demo)

```sql
-- borra en orden inverso a los FKs (adaptar si la data ya fue editada)
delete from invoice_packages where invoice_id in (select id from invoices where invoice_number between 6000 and 6020);
delete from invoice_payments  where invoice_id in (select id from invoices where invoice_number between 6000 and 6020);
delete from invoice_line_items where invoice_id in (select id from invoices where invoice_number between 6000 and 6020);
delete from invoices where invoice_number between 6000 and 6020;
delete from billing_clients where casillero = '8899';
delete from package_notes where created_by = 'demo@suite-cargo.com';
delete from package_tags  where created_by = 'demo@suite-cargo.com';
delete from events  where package_id in (select id from packages where provider_id = (select id from providers where code = 'suite_demo'));
delete from packages where provider_id = (select id from providers where code = 'suite_demo');
delete from providers where code = 'suite_demo';
```