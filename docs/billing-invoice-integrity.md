# Runbook — Integridad de facturación (facturas parciales, rollback, overrides)

Guía operativa de los invariantes de facturación, el incidente del 2026-10-24 y cómo
verificar/reparar. Decisiones de arquitectura: [ADR-014](../../docs/adr/014.md).

---

## Invariantes (qué garantiza el Worker)

1. **Un paquete = a lo sumo 1 vínculo activo.** Índice único parcial
   `uniq_active_package_invoice` sobre `invoice_packages(package_id) WHERE active=true`.
   Un VOID libera sus vínculos (`active=false`): eso es diseño, no anomalía.
2. **Factura atómica o revertida.** La creación factura en dos pasos (INSERT de la
   factura → vínculos + eventos + nota por lote). Si algo falla a mitad de camino,
   `rollbackPartialInvoice` libera vínculos, archiva la factura y audita el incidente
   con un **código de soporte** `F-XXXXXXXX`; el caller recibe un 422 determinista
   `INVOICE_CREATION_REVERTED` (nunca un 500 opaco).
3. **Guard `links == packages`.** Después de crear los vínculos se cuenta los activos
   de la factura: si no es exactamente el número de paquetes facturados, rollback.
4. **Presupuesto de subrequests constante (≈14, no crece con N).** Los POST de
   vínculos/eventos/notas son por lote (1 request por tabla), las rates se cachean por
   request. Un bulk de 11 paquetes ≈ 14 fetches (antes ≈ 8+5N → 63).
5. **Peso efectivo.** `packages.effective_weight_lb` (GENERATED:
   `coalesce(weight_override_lb, weight_lb)`) es el peso que factura el detalle, el
   track público y los stats de peso por cliente. El scrape solo escribe `weight_lb`;
   el override del staff (`set_package_weight`) sobrevive los refreshes.

## Bandera `integrityWarning`

`GET /api/billing/invoices/:id` agrega `integrityWarning` por factura: `null` en VOID
(los vínculos liberados son por diseño) y `true|false` en el resto. `true` significa que
alguna línea de flete factura un paquete **sin vínculo activo** (líneas facturadas ⊄
vínculos activos) — riesgo de doble facturación o de una factura que cobra algo que la
vista de paquetes vinculados no refleja. El panel muestra un banner ámbar persistente en
`InvoiceDetail` cuando es `true`.

## Verificación mensual (read-only)

Chequeo rápido de anomalías vivas — líneas de flete con `package_id` (flujo guiado/manual;
el bulk agrega N paquetes en líneas por tier y vincula vía `invoice_packages`, sin
`package_id` por línea) cuyo paquete **no tiene vínculo activo en esa factura**:

```sql
select i.invoice_number, li.package_id
from invoices i
join invoice_line_items li on li.invoice_id = i.id
  and coalesce(li.line_type, 'freight') <> 'other'
  and li.package_id is not null
where i.deleted_at is null and i.status <> 'VOID'
  and not exists (
    select 1 from invoice_packages ip
    where ip.invoice_id = i.id and ip.package_id = li.package_id and ip.active = true
  );
```

Esperado: **0 filas**. (Nota: en facturas VOID el vínculo liberado es por diseño — la
consulta las excluye.) Si hay filas, reparar insertando los vínculos activos que falten
(mismo patrón que la migración de reparación
`20261026214605_repair-invoice-package-links.sql`: INSERT con `on conflict do nothing`,
stamped `system:repair-links` en `created_by`) y auditar en `audit_logs`. Alternativa en
el panel: la factura muestra el banner ámbar con el detalle por paquete.

Nota: los vínculos liberados por VOID **no** cuentan como facturado — el chequeo excluye
las facturas VOID a propósito.

## Presupuesto de subrequests

El bulk de facturación hace ≈ **14 fetches constantes** por invocación, independiente
del número de paquetes (N): pre-checks + GET de paquetes (1, batched `id=in.(…)`) +
rates (cacheadas) + 1 POST de vínculos (N filas) + 1 POST de eventos (N filas) + 1 POST
de notas + guard. Antes era `8+5N` (un POST por paquete): con N=11 la factura #85 murió
a los 3 vínculos por el límite de 50 subrequests del plan Free. Ver
`invoice-budget.test.ts` (aserta ≤25 fetches y el replay del incidente).

## Limitación conocida — cadena de migraciones

`insforge migrations up --all` falla en `create_package` porque esa función es owner
`postgres` (creada fuera de la CLI) y `create or replace` exige ser owner. Las
migraciones nuevas se aplican a prod **statement por statement** con
`npx @insforge/cli db query "<sql>"` (el proxy rechaza multi-statement y comentarios —
mandar sentencias simples limpias). Los envs nuevos aplican la cadena completa desde los
archivos; ver `docs/known-issues.md` (2026-10-26 · cadena de migraciones).

Las funciones reemplazables (owner `project_admin`) se verifican post-apply con:

```sql
select proname, (select rolname from pg_roles where oid = proowner) as owner
from pg_proc where proname in ('set_package_weight','customer_weight_stats',
  'customer_aggregate_stats','unassigned_packages');
```
