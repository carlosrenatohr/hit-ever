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
- **Datos reales:** 77 paquetes (66 Everest casillero 37458 + 11 Global Connection), 222 eventos,
  111 notas de proveedor en InsForge.
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

## 5. Estado de GC (Global Connection) — RESUELTO ✓ (11 paquetes en BD)

Proveedor sembrado en `providers` (`global_connection`, `gc.cargotrack.net`, sin filtro de casillero).
Ingesta funcionando vía Worker; **GC tiene 11 paquetes** (cuenta chica, 100% HIT; verificado hoy con
query a InsForge — la lista varía con el tiempo, una sesión previa contó 13) — todos en InsForge, 4
marcados `manual_status=entregado` por su nota `RETIRADO`. La cadena de bloqueos que hubo que vencer (en orden):

1. **Secrets GC no estaban en el Worker.** Sí estaban Everest/Upstash/InsForge, pero nunca se corrió
   `wrangler secret put GC_USERNAME/GC_PASSWORD` → `credsFor('global_connection')` devolvía null →
   GC ingería 0 (sin client). Setearlos.
2. **Credenciales GC malas.** Con los secrets puestos, el login devolvía la página `/default.asp` con
   `<strong>Alert:</strong> User and/or password are incorrect.` (evidencia dura, no asumida — se
   reprodujo con curl). El usuario corrigió `.dev.vars`; el user real tiene 8 chars (`hitcargo`).
   Verificación de creds (curl, HTTP puro): un login correcto termina en `/appl2.0/agent/default.asp`;
   uno fallido vuelve a `/default.asp` con `password are incorrect`. (Ver #6 sobre un fallback de landing.)
3. **Límite de subrequests.** `/admin/ingest?offset=N` corría AMBOS providers en UNA invocación;
   Everest (~14 subreq) + GC sin filtro (un detalle por fila) pasaba de 50 → `Too many subrequests`.
   Fix: **`?provider=<code>` ingiere UN provider por invocación** (`src/routes/admin.ts` → `ingestPage`).
4. **InsForge 400 `PGRST102 "All object keys must match"`.** El bulk insert de PostgREST exige que
   todos los objetos del array tengan las MISMAS keys; los paquetes con nota `RETIRADO` llevan
   `manual_status*` y el resto no → keys mezcladas. Fix en `upsertPackages`: **agrupar las filas por
   firma de keys y un POST por grupo** (los sin override nunca mandan `manual_status`, así
   merge-duplicates no pisa un override manual del admin). Ver gotcha #9.
5. **GC no pagina.** `whs.asp?offset=15/30/...` devuelve SIEMPRE las mismas filas (cabe en 1 página;
   el offset se ignora con <15 filas). No es bug — son pocos paquetes reales. Everest sí pagina (66).
6. **Landing de login GC — aclaración (commit `9eec383`, de otra sesión).** Esa sesión reportó que el
   login GC del Worker terminaba en `/default.asp` (no `/appl2.0/agent/`) y añadió un check por
   CONTENIDO (`Desconectar` presente y sin `password are incorrect`) para aceptar ese landing.
   **Reverificado hoy con curl (HTTP puro, sin JS) y las creds correctas: GC SÍ llega a
   `/appl2.0/agent/default.asp`, igual que Everest** — la cookie de auth se setea en
   `validate.asp`/`validate_final.asp`, así que `reachedAgent=true` y la rama de contenido NO se ejecuta.
   Conclusión: el check por URL es el camino normal; el de contenido quedó como **fallback defensivo**
   inofensivo (acepta también un `/default.asp` que traiga sesión válida). El código se mantiene (está
   pusheado y no estorba); el premisa "la navegación es JS de cliente" no aplica a las creds actuales.

**Runbook GC (deslogueado de GC en el navegador, sesión única):**
`curl -s -X POST -H "Authorization: Bearer <ADMIN_SECRET>" "<worker>/admin/ingest?provider=global_connection&offset=0&days=60"`

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
4. **Credenciales GC** — login fallido vuelve a `/default.asp` con "User and/or password are incorrect";
   éxito llega a `/appl2.0/agent/`. RESUELTO (user real `hitcargo`, 8 chars). Los secrets GC deben
   estar en el Worker (`wrangler secret put`), no solo en `.dev.vars`.
5. Sesión única + corta (~2-3 min) → no logear concurrente; ingesta con humano deslogueado.
6. InsForge path real `/api/database/records/{table}` (no `/api/records`).
7. Zod 4: `error.issues` (no `.errors`) — un `.errors` viejo tiraba 500 en vez de 422.
8. `GC_BASE_URL` con slash final → normalizar (`baseUrl.replace(/\/$/, '')`).
9. **InsForge bulk insert `PGRST102` "All object keys must match"** → todas las filas del array deben
   tener idénticas keys; agrupar por firma de keys y un POST por grupo (`upsertPackages`).
10. **Límite 50 subrequests** también lo dispara correr varios providers en una invocación →
    `?provider=<code>` aísla uno por invocación (providers sin filtro de casillero abren 1 detalle/fila).
11. **Encoding: Cargotrack sirve Windows-1252, no UTF-8** → `res.text()` convierte `ó/í/ñ` en `�`.
    Decodificar bytes: `new TextDecoder('windows-1252').decode(await res.arrayBuffer())`. OJO: el dedup
    de events/notas incluye la descripción, así que al re-ingerir con el texto corregido quedan filas
    viejas huérfanas con `�` — borrarlas (`DELETE ...?description=ilike.*%EF%BF%BD*`).
12. **GC no pagina** (`?offset` se ignora con <15 filas; devuelve siempre la misma página). Son 11 reales.
