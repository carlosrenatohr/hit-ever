# Client onboarding runbook — alta de un tenant (cliente) en el panel

Runbook operativo: cómo dar de alta a un **cliente nuevo** (agencia = tenant) en el sistema.
Primer caso real: **Original Express** (2026-09-22). Este documento es el procedimiento
reutilizable para los clientes que sigan; cada alta agrega una fila `agencies` + tarifas de
arranque + usuario(s).

> Contexto de arquitectura (no repetir acá): multi-tenancy ADR-009, `organization_id` como
> slug de agencia, RLS aísla por `session_agency()`, migraciones aditivas dueñas de rama.
> Ver `../docs/architecture.md` y `docs/adr/009-live-multi-tenancy.md` en la raíz del workspace.

---

## 0. Modelo de acceso (cómo funciona)

Un cliente que entra al panel es **dos cosas**:

1. Una **agencia/tenant** en `public.agencies` — fila con `slug` (clave de tenant, `^[a-z0-9-]+$`),
   `name`, `currency` (USD/NIO), `is_scrapable` (false = operación manual por ahora),
   `logo_url`/`logo_key` (se sube después desde Config > branding).
2. **Usuarios** en `auth.users` (email+password, InsForge Auth) + fila en `public.app_users`
   (id = `auth.users.id`, `role`, `active`, `agency = slug`).

Sin la fila #2 (o `active=false`) la persona **no entra** aunque tenga cuenta de Auth.
La FK `app_users_agency_fkey → agencies(slug)` valida que el slug exista — por eso
primero se crea la agencia (migración) y después el usuario (paso operativo).

RLS: cada usuario ve **solo** los paquetes/eventos de su `agency` (org-scoped read).
Los `viewer` no escriben; los writes pasan por RPCs `SECURITY DEFINER` (nunca UPDATE directo).

---

## 1. Datos del cliente (preguntar ANTES de tocar nada)

Checklist de decisión — mismos datos que se le pidieron a Original Express:

| Dato | Pregunta | Original Express (real) |
|---|---|---|
| Slug | Clave de tenant (a-z0-9-) | `original-express` |
| Nombre visible | Marca/razón social en branding y reportes | `Original Express` |
| Moneda | Símbolo en tarifas/facturas | `USD` |
| Entrada de paquetes | ¿scraper propio o manual? | **Manual** por ahora (`is_scrapable=false`) |
| Rol del 1er usuario | Qué puede hacer la persona | `admin` (dueño/representante) |
| Email (genérico ok) | `auth.users` + `app_users.email` — **cambiable después** | genérico `admin@originalexpress.com` → **`torunoana71@gmail.com`** (real, 2026-09-22) |
| Logo | ¿Se tiene ya? | **Después** (Config > branding, post-login) |

> El email no es fijo: vive en `auth.users` y `app_users.email` y se actualiza con el mismo
> procedimiento de gestión de usuarios. Ver `hit-panel/docs/04-admin-access-and-user-management.md`.

---

## 2. Migración aditiva (rama dueña del tenant)

Cada cliente nuevo = **una migración aditiva** (`YYYYMMDDHHMMSS_<slug>-tenant.sql`) en
`hit-ever2/migrations/`, dueña de su rama (`feat/<slug>-tenant`). Contenido (idempotente):

1. `insert into agencies (slug, name, currency, is_scrapable) values (...)` `on conflict do nothing`
2. Seed **rate_tables legacy** "Regular" (AIR+MAR) desde `pricing_catalog` — par básico de
   arranque, precio modificable desde Config > Tarifas.
3. Seed **rate_cards v2** "Regular" (`simple_pair`, `weight`, `USD`) con
   `source_key = '<slug>:Regular:REGULAR'` (mismo formato de idempotencia que el backfill).
4. Seed **payment_methods / payment_banks** por defecto (Transferencia/Efectivo/Saldo a favor;
   BAC/LAFISE/BANPRO).
5. Seed en **provider_agencies**: la fila de la junction con el proveedor del cliente y
   `is_default = true` (**obligatorio** — sin provider, crear paquetes falla con error accionable;
   ver §2.5).

Reglas:
- **Aditiva**: nunca toca filas de otras agencias ni altera constraints existentes (en prod el
  slug ya está validado por la **FK** `app_users_agency_fkey`, no por un CHECK — no hay que
  re-crear el constraint al agregar tenant, solo asegurarse de que la FK no use CHECK lock).
- **Idempotente**: `on conflict do nothing` + guard en el DO block de rate_cards (skip si el
  `source_key` ya existe).
- **Referencia**: `migrations/20260922060000_original-express-tenant.sql` (primer caso real).

> Si el tenant recibe scraper en el futuro: `is_scrapable=true` (UPDATE) + routing en
> `provider_agencies` + decidir credenciales (¿propias o las de HIT?). Documentar aparte.

---

### 2.5 Proveedor por defecto — obligatorio incluso en modo manual

`create_package` resuelve el proveedor **data-driven**: `p_provider_code` (override del panel,
validado contra la junction de la agencia) → `provider_agencies.is_default` de la agencia → error
accionable si no hay ninguno (apunta a esta sección). Un tenant sin proveedor **no puede crear
paquetes** (el modal del panel también lo avisa y deshabilita Crear). `provider_id` no es opcional:
la idempotencia del paquete es `ON CONFLICT (provider_id, almacen_id)` — el proveedor es requisito
de arranque, no solo de scraper.

En la migración del tenant:

```sql
insert into provider_agencies (provider_id, agency_slug, casillero_filter, is_default)
select id, '<slug>', null, true from providers where code = '<provider_code>'
on conflict (provider_id, agency_slug) do nothing;
```

Reglas (importantes):

- **Un default por agencia**: índice único `uq_provider_agencies_one_default` (`is_default` partial)
  — elegir con qué proveedor se crean los paquetes del tenant.
- **Guard de ruteo**: la junction alimenta el ruteo de ingest (por prefijo de casillero). Una
  agencia **manual** (`is_scrapable=false`) con `casillero_filter NULL` (catch-all) **no cuenta**
  para el default del proveedor compartido: sin prefijo no rutea nada. Protege el status quo — p.ej.
  GC mantiene a `hit` como único catch-all aunque exista una fila manual sin prefijo.
- **Nunca dos defaults `NULL` para el mismo proveedor**: si dos agencias scrapables tienen
  `casillero_filter NULL`, el ruteo es ambiguo y el ingest **saltea ese paquete** (nunca adivina).
  Antes de activar el scraper de un tenant hay que asignarle su prefijo de casillero (dato del
  cliente) y **recién entonces** `is_scrapable=true`.
- **Activar scraper más adelante** = prefijo en la fila de la junction + `is_scrapable=true` +
  credenciales del proveedor (`credsFor` en `src/services/ingest.ts`: secrets de Cloudflare
  `EVEREST_USERNAME/PASSWORD`, `GC_USERNAME/PASSWORD`). El guard del §6 protege los datos manuales.

---

## 3. Alta del usuario (paso operativo post-migración)

La migración **no** crea usuarios (implica password). Después de aplicar su migración, crear la
cuenta con el procedimiento estándar (mismo que `hit-panel/docs/04`, con `agency` seteada):

```bash
BASE="https://a4qvtp8s.us-east.insforge.app"
ANON=$(npx @insforge/cli secrets get ANON_KEY --json | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('value') or d.get('ANON_KEY'))")

EMAIL="admin@originalexpress.com"; NAME="<nombre>"; ROLE="admin"; AGENCY="original-express"; PW="<contraseña-inicial-fuerte>"

# 1) cuenta de Auth
curl -s -X POST "$BASE/api/auth/users" -H "Content-Type: application/json" -H "Authorization: Bearer $ANON" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PW\",\"name\":\"$NAME\"}"

# 2) email verificado (si la verificación está activa)
npx @insforge/cli db query "update auth.users set email_verified=true where email='$EMAIL'"

# 3) rol + agencia en el panel
npx @insforge/cli db query \
  "insert into public.app_users(id,email,name,role,agency,active)
   select id,'$EMAIL','$NAME','$ROLE','$AGENCY',true from auth.users where email='$EMAIL'
   on conflict(id) do update set role=excluded.role, agency=excluded.agency, active=true, name=excluded.name"
```

> `role` ∈ `admin | billing | staff | viewer` (enum `staff_role`). Para el 1er cliente admin es
> razonable como dueño; `viewer` si solo quiere ver. Cambiar rol después es un UPDATE simple.

---

## 4. Verificación post-alta (smoke)

1. `npx @insforge/cli db query "select slug,name,currency,is_scrapable from agencies where slug='original-express'"`
2. `npx @insforge/cli db query "select id,email,role,agency,active from app_users where agency='original-express'"`
3. Login en `https://hit-panel.pages.dev` con el email+password.
4. La shell muestra el branding (nombre de la agencia, no logo aún) y **solo** ve el contenido de
   su org (RLS org-scoped — aunque consulte paquetes de otra agencia, no los ve).
5. Config > Tarifas: la rate card "Regular" (AIR/MAR) existe y es editable. Config > Pagos:
   métodos/bancos por defecto presentes.
6. Config > Información: nombre de agencia editable (una vez por mes, server-enforced).
7. Paquetería > **Crear paquete**: el modal muestra el proveedor — chip si hay 1, `<select>` con el
   default preseleccionado si hay ≥2, mensaje claro si no hay ninguno. Crear uno y verificar en la
   DB: `select provider_id, organization_id from packages where almacen_id = '<guia>'` — el provider
   debe ser el default de la agencia, `organization_id` el slug del tenant.
8. Facturación: crear un cliente y una factura #1. La numeración es **por agencia** (per-org):
   arranca en #1 sin colisionar con otros tenants. Los conceptos de cargo ("otros") no vienen
   seedeados — crear desde Config > Conceptos si el cliente los usará.
9. Reportes: el filtro de proveedor y la columna "Proveedor" del CSV muestran el provider de la
   agencia (1 solo proveedor = filtro trivial pero funcional).
10. Config > Auditoría: tras operar, aquí se ven los avisos del sistema (ver §6).
11. Crear un paquete **manual** (flujo definitivo para tenants sin scraper). El modal pide
    **Cliente** (obligatorio: autocompleta los clientes del tenant y ofrece "Crear cliente: X" si
    el nombre no existe), **Estado inicial** (`En bodega Miami` por default; se puede cambiar
    después desde el detalle) y **Tipo de servicio** (obligatorio). Después de crear, verificar en
    el detalle del paquete: el **timeline** muestra la fila *"Paquete creado manualmente por
    `<email>`"*; el cliente queda asignado y **prefilleado** en las acciones; el servicio muestra el
    elegido (nunca un "Scraped (Aéreo)" inventado). El cliente autocreado es un cliente normal del
    tenant: aparece en Clientes y en todos los buscadores, y se edita/elimina como cualquier otro.

---

## 5. Caso real #1 — Original Express (histórico de esta sesión)

| Campo | Valor |
|---|---|
| Slug | `original-express` |
| Nombre | `Original Express` |
| Moneda | USD |
| is_scrapable | false (manual por ahora) |
| 1er usuario | `admin` · `admin@originalexpress.com` → **`torunoana71@gmail.com`** (email real de Ana, actualizado 2026-09-22; el genérico era placeholder) |
| Tarifas de arranque | rate_tables + rate_cards "Regular" AIR/MAR (editable) |
| Logo | pendiente (Config > branding) |
| Migración | `20260922060000_original-express-tenant.sql` |
| Rama | `feat/original-express-tenant` (hit-ever2) |
| Provider (junction) | Global Connection · `is_default=true` · `casillero_filter NULL` (migración `20260923015138_package-create-hardening.sql`, rama `feat/package-create-hardening`) |

**Pendientes del cliente:** logo; **prefijo/rango de casilleros en la cuenta de Global Connection**
(necesario para activar el scraper: asignar `casillero_filter` en la junction + `is_scrapable=true` —
ver §2.5); completar datos de facturación (RUC/dirección) en Config > Información.

---

## 6. Colisiones manual ↔ scraper (qué garantiza el sistema)

Desde `20260923015138` (guard `packages_tenant_guard` + preflight en `create_package`), la operación
manual y el scraper conviven sin pisarse:

| Garantía | Mecanismo | Dónde se ve |
|---|---|---|
| El scraper **no roba ni mueve** paquetes entre tenants | trigger congela `organization_id` (escape: GUC `hit.allow_org_move='on'` solo para backfills deliberados) | Auditoría: `package.org_move_blocked` |
| El scraper **no borra** valores manuales | trigger restaura el valor si el update trae `NULL` ("scrape nunca borra"; dedup de 24h para no inundar) | Auditoría: `package.scrape_values_preserved` + evento en el timeline del paquete |
| Crear un paquete **no pisa** el ledger de otra org | `create_package` detecta `(provider_id, almacen_id)` ajeno → bloquea + audita (devuelve error JSON, no raise) | Auditoría: `package.create.blocked_cross_org` + mensaje claro en el modal |
| Tracking duplicado en otra org | se crea igual, pero **avisa** (no bloquea) | Auditoría: `package.create.tracking_duplicate` + evento en la fila preexistente + `warning` ámbar en el modal |

El duplicado de **guía en otra org** es un **bloqueo** con error claro (nunca un update mudo); el
**tracking duplicado** es un **aviso** (se crea y todos se enteran). El admin ve todo en Config >
Auditoría (org-scoped) y en el timeline de cada paquete.

---

## 7. Módulos que toca una agencia nueva (checklist de smoke)

| Módulo | Esperado al arrancar | Dónde |
|---|---|---|
| Paquetería | crear paquete con proveedor (chip/select), **cliente obligatorio** (autocompletar o crear) y estado inicial; timeline registra el alta manual; stats, listado y export scoped a la org | Shipments / Overview / Reports |
| Facturación | numeración per-org desde #1; tarifas v2 "Regular"; métodos/bancos seedeados; conceptos de cargo vacíos (crear desde Config si aplica) | Billing / Config > Conceptos |
| Clientes | CRUD scoped a la org; valida que la rate table/card sea de la propia agencia | Customers |
| Reportes | listado/export con proveedor; filtros scoped | Reports |
| Configuración | branding, tarifas, pagos, conceptos, auditoría; alta de usuarios por CLI (§3) | Config |

---

*Este runbook es de futuro: la próxima vez, copiar §2 (migración) y §3 (usuario) con los datos
del §1. El resto del proceso no cambia.*