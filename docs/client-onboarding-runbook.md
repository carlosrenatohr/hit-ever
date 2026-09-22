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
| Email (genérico ok) | `auth.users` + `app_users.email` — **cambiable después** | `admin@originalexpress.com` |
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

---

## 5. Caso real #1 — Original Express (histórico de esta sesión)

| Campo | Valor |
|---|---|
| Slug | `original-express` |
| Nombre | `Original Express` |
| Moneda | USD |
| is_scrapable | false (manual por ahora) |
| 1er usuario | `admin` · `admin@originalexpress.com` (email genérico, cambiable) |
| Tarifas de arranque | rate_tables + rate_cards "Regular" AIR/MAR (editable) |
| Logo | pendiente (Config > branding) |
| Migración | `20260922060000_original-express-tenant.sql` |
| Rama | `feat/original-express-tenant` (hit-ever2) |

**Pendientes del cliente:** logo; decidir si algún día entra por scraper (routing +
credenciales); completar datos de facturación (RUC/dirección) en Config > Información.

---

*Este runbook es de futuro: la próxima vez, copiar §2 (migración) y §3 (usuario) con los datos
del §1. El resto del proceso no cambia.*