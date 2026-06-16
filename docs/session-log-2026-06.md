# Session log — Tracker build & Cargotrack integration (junio 2026)

Registro detallado de lo construido y, sobre todo, del conocimiento ganado del sistema legacy
(Cargotrack) que hizo falta para que la ingesta funcione. Complementa `ONBOARDING.md` (raíz) y
`docs/e2e-testing.md`. Pensado para que un agente o persona retome **sin repetir los errores** que
ya cometimos.

> Regla del equipo: no asumir comportamientos del sistema viejo — diagnosticar con evidencia
> (logs del Worker, requests capturados, mensajes de la propia página). Casi todos los "bugs"
> de esta sesión fueron supuestos equivocados que la evidencia corrigió.

---

## 1. Qué se logró

- **Web MVP (hit-cargo-web):** quitar testimonios falsos + rating inventado (riesgo Google), unificar
  datos de contacto, SEO/JSON-LD, páginas faltantes (servicios/precios/contacto/legal), portal de
  tracking conectado a `PUBLIC_API_URL` con fallback "próximamente".
- **Tracker (hit-ever2):** API pública `GET /track/:guia` (lee InsForge, payload mínimo, rate-limit,
  anti-enumeración), parser de Cargotrack validado contra fixtures, repositorio **DB-agnóstico**
  (interfaz `TrackingRepository` + adaptador Insforge + adaptador en memoria), ingesta multi-proveedor
  con login real, batching, filtro de casillero, notas del proveedor y override de estado manual.
- **Datos reales:** 66 paquetes Everest (casillero 37458), 205 eventos, 86 notas en InsForge.
- **Infra:** worker desplegado, secrets en Cloudflare, cron 2h, harness `pnpm check` + CI en ambos repos.

---

## 2. Cargotrack — conocimiento del sistema (lo más valioso)

Everest (`everest.cargotrack.net`, user `provexpro`) y Global Connection (`gc.cargotrack.net`,
user `hitcargo`) son **el MISMO motor Cargotrack** (Classic ASP). Mismo login, mismas rutas.

### 2.1 Login — sigue la CADENA de redirects (gotcha #1)
- `GET /` (siembra cookie) → `POST /` con form `user`, `password`, `action=login`, `Submit=Log In`
  → **302 a `validate.asp?accessdenied=` → 302 a `validate_final.asp?accessdenied=` → 302 a
  `/appl2.0/agent/default.asp`** (área autenticada).
- **El `accessdenied=` en esas URLs es parte del login EXITOSO, NO un error.** Tratarlo como
  denegación (lo que hicimos al inicio) rompe todo. Hay que **seguir la cadena**.
- Workers `fetch` NO mantiene cookies entre redirects → el Worker sigue la cadena **manualmente**,
  acumulando cookies en cada hop (`src/services/ingest.ts` → `CargotrackClient.login`).
- **Login fallido (creds malas)** → vuelve a `/default.asp` con texto "incorrect". Así se distingue
  éxito (llega a `/appl2.0/agent/`) de fallo.

### 2.2 Sesión única + corta (gotcha #2)
- **Una sola sesión activa por cuenta.** El scraper y un navegador humano NO pueden estar logueados
  a la vez: si vos estás logueado en el navegador, el login del Worker hace que la lista vuelva vacía.
  → **Correr ingesta cuando nadie esté logueado** (ej. cron de madrugada).
- Sesión dura **~2-3 min**. El Worker cachea la cookie en Upstash ~2 min y re-loguea al expirar.

### 2.3 Rutas y paginación
- Lista (Almacén): `GET /appl2.0/agent/whs.asp`, **pagina por offset de filas**: `?offset=15,30,45,…`
  (15 filas/página). Página 1 = sin query.
- Detalle: `GET /appl2.0/agent/whs_detail.asp?id=<almacen>`.
- Notas (escribir, futuro): `remarks.asp?id=<almacen>&line=WAREHOUSE&sc=<codigo>` (sc=509 GC, 7240 Everest).

### 2.4 Modelo de datos
- **Llave** = `almacén`/"guía" (ej. 926791) — número de control, lo que el cliente conoce.
- **Tracking** del carrier (1Z…, TBA…) = búsqueda secundaria (solo en el detalle).
- **Casillero** (`Para`) = filtro de propiedad: Everest cuenta compartida → solo **37458** es HIT;
  GC cuenta 100% HIT → sin filtro.
- **Colores de fila → estado (leyenda oficial):** 🟢 verde=en_almacen · 🟡 amarillo=parcial ·
  🔴 rojo=en_transito · 🟣 morado=en_destino · 🟠 naranja=entregado. Ícono avión/ancla = aéreo/marítimo.
- **GC no marca "entregado" por color** — lo registran como **nota `> RETIRADO`** (creada por HITCARGO).
  → detectamos esa nota y seteamos `manual_status=entregado` (estado efectivo = manual ?? scrapeado).

---

## 3. Ingesta — diseño y por qué (gotchas #3 y #4)

`src/services/ingest.ts`:
- Recorre `whs.asp` por offset; pre-filtra HIT (destinatario) + ventana de días; abre cada detalle
  (throttle ~1s, UA de navegador); **filtro estricto de casillero** post-detalle (Everest solo 37458).
- **Batching (gotcha #3 — límite de subrequests):** Workers free permite **50 subrequests/invocación**.
  Hacer 3 llamadas a InsForge por paquete (upsert + get-id + events) reventaba en páginas densas
  (`Too many subrequests`). Solución: **1 bulk upsert de packages** (con `Prefer: return=representation`
  para traer los ids) + **1 bulk de events** + **1 bulk de notes** por página.
- **Backfill chunked:** `POST /admin/ingest?offset=N&days=D` ingiere UNA página (cabe en el límite de
  tiempo del Worker). Para 2 meses: offsets 0,15,…,105. Reusa la sesión cacheada (1 login).
- **Notas dedup + no-fatal (gotcha #4):** dos notas idénticas en una página hacían que `ON CONFLICT`
  pegara dos veces en un statement → **InsForge 500**. Solución: dedup por
  `(package_id, body, author, noted_at)` antes del bulk, y envolver el upsert de notas en try/catch
  (las notas son suplementarias, nunca tumban packages/events ya guardados).

---

## 4. InsForge (la DB)

- REST estilo PostgREST: `GET/POST/PATCH https://<host>/api/database/records/{table}` (¡NO `/api/records`!),
  auth `Authorization: Bearer <API_KEY>`, filtros `?col=eq.valor`. Insert = body **array**.
- Cliente en `src/lib/insforge.ts` (un adaptador de `TrackingRepository`). Para cambiar de DB:
  nuevo adaptador + flip en `getRepository()` (`src/lib/repository.ts`). Sin Insforge configurado,
  cae al adaptador **en memoria** (demo).
- Migraciones: `db/0001_init.sql` (schema base + RLS) y `db/0002_provider_notes.sql` (tabla de notas).
  RLS default-deny; el Worker usa la API key admin (bypassa RLS); nunca exponer la key al cliente.

---

## 5. Estado de GC (Global Connection) — BLOQUEADO por credenciales

- Proveedor sembrado en `providers` (`global_connection`, `gc.cargotrack.net`, sin filtro).
- **El login GC FALLA: la página devuelve "incorrect".** Diagnóstico (no asumido): el `GC_USERNAME`
  en `.dev.vars` tiene **3 caracteres** y el password 6, pero el usuario GC es **HITCARGO** (~8).
  → **Las credenciales GC en `.dev.vars` (y en los secrets del Worker) están mal.**
- **Acción requerida:** poner el usuario/password reales de `gc.cargotrack.net` en:
  1. `hit-ever2/.dev.vars` (`GC_USERNAME`, `GC_PASSWORD`).
  2. Secrets del Worker: `printf %s "<valor>" | pnpm exec wrangler secret put GC_USERNAME` (y `GC_PASSWORD`).
  Luego, **logueado OUT de GC en el navegador** (sesión única), correr:
  `for o in 0 15 30 45 60 75 90 105; do curl -s -X POST -H "Authorization: Bearer <ADMIN_SECRET>" \
   "https://hit-ever-scraper.honchkrow1995.workers.dev/admin/ingest?offset=$o&days=60"; done`
  → trae paquetes GC + sus notas `RETIRADO` (→ entregado).

---

## 6. Runbook rápido (verificación / operación)

- **Backfill / ingesta manual:** `POST /admin/ingest?offset=N&days=D` o `?pages=N&days=D`
  (header `Authorization: Bearer <ADMIN_SECRET>`). Respuesta `{result:{everest:N, global_connection:M}}`
  (`-1` = error → ver logs).
- **Logs del Worker:** Cloudflare Observability (MCP `query_worker_observability`, filtro
  `$metadata.service = hit-ever-scraper`, `level = error`) — así diagnosticamos cada `-1`.
- **Verificar datos:** `npx @insforge/cli db query "select count(*) from packages" --json`.
- **Probar público:** `GET /track/926791` → payload mínimo + timeline.
- **Pausar logins (anti-footprint):** `setex ct:login_block:<provider> <seg> 1` vía Upstash REST.

---

## 7. Commits & push

Ramas `feat/tracker-api` (ever2) y `feat/mvp-pages-tracker` (web), autor `honchkrow1995@gmail.com`,
conventional, sin firma. **Commits locales sin pushear** (el sandbox no tiene SSH): pushear desde tu
shell. Detalle de hilos abiertos en `ONBOARDING.md` §7.

---

## 8. Índice de gotchas (lo que tumbó a los agentes)

1. `validate.asp?accessdenied=` es login NORMAL, no denegación → seguir la cadena.
2. Límite 50 subrequests/invocación Workers free → batching de upserts.
3. InsForge 500 por notas duplicadas en `ON CONFLICT` → dedup + no-fatal.
4. **Credenciales GC malas en `.dev.vars`** (user 3 chars) → el login devuelve "incorrect". ← bloqueo actual de GC.
5. Sesión única + corta (~2-3 min) → no logear concurrente; ingesta con humano deslogueado.
6. InsForge path real `/api/database/records/{table}` (no `/api/records`).
7. Zod 4: `error.issues` (no `.errors`) — un `.errors` viejo tiraba 500 en vez de 422.
8. `GC_BASE_URL` con slash final → normalizar (`baseUrl.replace(/\/$/, '')`).
