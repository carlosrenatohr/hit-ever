# Guía de pruebas e2e manuales (Postman / curl)

Esta guía permite verificar, paso a paso, todo lo construido en `hit-ever2`: el Worker
público de tracking, los endpoints de administración, el hook de email, la base de datos
InsForge y la cadena de scraping contra Cargotrack.

Todos los secretos aparecen como **placeholders**: sustituye `<ADMIN_SECRET>`,
`<INSFORGE_API_KEY>`, `<CARGOTRACK_USER>` y `<CARGOTRACK_PASS>` por los valores reales
(que viven en Cloudflare Secrets / el dashboard de InsForge), nunca los escribas en
repos ni los compartas en capturas.

## Bases (hosts)

| Sistema | Base URL | Autenticación |
|---|---|---|
| Worker (Cloudflare) | `https://hit-ever-scraper.honchkrow1995.workers.dev` | público (lectura) / `Authorization: Bearer <ADMIN_SECRET>` (escritura) / `X-Hook-Secret: <ADMIN_SECRET>` (hook) |
| InsForge (Postgres + REST) | `https://a4qvtp8s.us-east.insforge.app` | `Authorization: Bearer <INSFORGE_API_KEY>` |
| Cargotrack (referencia) | `https://everest.cargotrack.net` | sesión por cookie (login con formulario) |

## Envoltorio de respuesta (envelope)

Todas las respuestas del Worker usan un envoltorio uniforme:

- Éxito: `{ "ok": true, "data": { ... }, "meta"?: { "cachedAt"?, "scrapedAt"?, "latencyMs"? } }`
- Error: `{ "ok": false, "error": { "code": "...", "message": "..." } }`

Truco: añade `?pretty=1` a cualquier URL del Worker para recibir el JSON indentado
(`prettyJSON`), muy cómodo en Postman / navegador.

---

# 1. WORKER

Base: `https://hit-ever-scraper.honchkrow1995.workers.dev`

## 1.1 `GET /` — raíz / sanity check

**Método + URL**

```
GET https://hit-ever-scraper.honchkrow1995.workers.dev/
```

**Headers:** ninguno.

**curl**

```bash
curl -s "https://hit-ever-scraper.honchkrow1995.workers.dev/?pretty=1"
```

**Respuesta esperada (200)**

```json
{
  "ok": true,
  "data": {
    "name": "hit-ever-scraper",
    "description": "Everest CargoTrack scraper API for Hit Cargo",
    "version": "1.0.0",
    "endpoints": {
      "track": "GET /track/:id",
      "health": "GET /admin/health",
      "refreshSession": "POST /admin/session/refresh"
    }
  }
}
```

**Qué prueba:** que el Worker está desplegado y respondiendo; confirma el contrato del
envoltorio (`ok: true` + `data`) y enumera los endpoints públicos.

## 1.2 `GET /admin/health` — salud del servicio

**Método + URL**

```
GET https://hit-ever-scraper.honchkrow1995.workers.dev/admin/health
```

**Headers:** ninguno (este endpoint **no** requiere Bearer; sólo `/ingest` y
`/packages/*` están protegidos).

**curl**

```bash
curl -s "https://hit-ever-scraper.honchkrow1995.workers.dev/admin/health?pretty=1"
```

**Respuesta esperada (200)**

```json
{
  "ok": true,
  "data": {
    "service": "hit-ever-scraper",
    "version": "1.1.0",
    "status": "operational",
    "timestamp": "2026-06-15T12:00:00.000Z",
    "environment": "configured"
  }
}
```

**Qué prueba:** que el Worker arrancó con sus variables de entorno. El campo
`environment` será `"configured"` si `EVEREST_BASE_URL` está presente, o
`"missing-env"` si falta — un chequeo rápido de que los secretos están cargados.

## 1.3 `GET /track/:guia` — tracking público (payload mínimo)

Lee de **nuestra** base (InsForge), no scrapea en vivo. Devuelve un subconjunto
**mínimo**: NO incluye casillero, nombre del cliente (PII), valor declarado ni foto.

### 1.3.1 Guía válida (caso feliz)

**Método + URL**

```
GET https://hit-ever-scraper.honchkrow1995.workers.dev/track/910500
```

**Headers:** ninguno.

**curl**

```bash
curl -s "https://hit-ever-scraper.honchkrow1995.workers.dev/track/910500?pretty=1"
```

**Respuesta esperada (200)** — el `data` es un `PublicShipment`:

```json
{
  "ok": true,
  "data": {
    "guia": "910500",
    "status": "en_transito",
    "statusLabel": "En camino",
    "step": 2,
    "serviceType": "aereo",
    "weightLb": 2.75,
    "pieces": 1,
    "receivedAt": "2026-06-12T14:31:00Z",
    "lastEventAt": "2026-06-12T14:31:00Z",
    "events": [
      {
        "date": "2026-06-12T14:31:00Z",
        "description": "Recibido",
        "office": "MIA"
      }
    ]
  },
  "meta": {
    "cachedAt": 1749731460000,
    "latencyMs": 42
  }
}
```

**Los 4 campos de estado (barra de progreso de 4 pasos):**

- `status` — estado interno normalizado: uno de
  `en_almacen | parcial | en_transito | en_destino | entregado | excepcion | desconocido`.
- `statusLabel` — etiqueta para el usuario final, en español:

  | status | statusLabel |
  |---|---|
  | `en_almacen` | `En bodega Miami` |
  | `parcial` | `En preparación` |
  | `en_transito` | `En camino` |
  | `en_destino` | `En Nicaragua` |
  | `entregado` | `Entregado` |
  | `excepcion` | `Retenido` |
  | `desconocido` | `Sin información` |

- `step` — paso 1..4 para la barra Miami → En tránsito → Nicaragua → Entregado
  (`0` para excepción / desconocido):

  | status | step |
  |---|---|
  | `en_almacen` | 1 |
  | `parcial` | 2 |
  | `en_transito` | 2 |
  | `en_destino` | 3 |
  | `entregado` | 4 |
  | `excepcion` | 0 |
  | `desconocido` | 0 |

- `events` — lista cronológica ascendente (sólo eventos con fecha), cada uno con
  `date` (ISO), `description` y `office` opcional.

> Nota: el `status` efectivo respeta el override manual. Si se fijó un estado manual
> (ver 1.5.1), ese gana sobre el scrapeado. Por eso, tras marcar `entregado` a mano,
> este endpoint devolverá `status: "entregado"`, `statusLabel: "Entregado"`, `step: 4`.

> Nota de datos: `910500` es la guía de ejemplo solicitada para la verificación pública.
> Para que devuelva 200 debe existir en la base (haber sido ingerida). El fixture
> `fixtures/detalle.html` corresponde al almacén/guía `926791` (casillero `37458` = HIT,
> remitente AMAZON, Tracking `1Z2V8757YW00988871`, evento "Recibido" en MIA el
> 6/12/2026 14:31), útil como referencia del shape del detalle.

**Qué prueba:** la lectura pública de extremo a extremo (Worker → InsForge → payload
mínimo), el mapeo de estado/etiqueta/paso y que **no** se filtra PII.

### 1.3.2 Guía inexistente → 404 (anti-enumeración)

**Método + URL**

```
GET https://hit-ever-scraper.honchkrow1995.workers.dev/track/000000
```

**curl**

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  "https://hit-ever-scraper.honchkrow1995.workers.dev/track/000000"
```

**Respuesta esperada (404)**

```json
{
  "ok": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "We could not find a shipment with \"000000\". Please check the waybill number (guía)."
  }
}
```

**Qué prueba:** la superficie acotada anti-enumeración. La base sólo contiene paquetes
de HIT (filtro por casillero durante la ingesta), así que cualquier guía ajena
simplemente "no existe" → 404 plano, sin distinguir entre "no es de HIT" y "no existe".

### 1.3.3 Identificador inválido → 422

El parámetro debe cumplir `^[\w\-]+$` (alfanuméricos, guion bajo y guion), con longitud
1..64. Un id con caracteres prohibidos (espacios, `/`, `@`, etc.) falla la validación
del esquema **antes** de tocar la base.

**Método + URL** (el espacio se codifica como `%20`)

```
GET https://hit-ever-scraper.honchkrow1995.workers.dev/track/abc%20123
```

**curl**

```bash
curl -s "https://hit-ever-scraper.honchkrow1995.workers.dev/track/abc%20123?pretty=1"
```

**Respuesta esperada (422)**

```json
{
  "ok": false,
  "error": {
    "code": "INVALID_PARAM",
    "message": "Invalid tracking ID format"
  }
}
```

**Qué prueba:** la validación de entrada (Zod) rechaza ids malformados con `422` y un
código distinto de `404`, sin consultar la base ni gastar rate-limit útil.

> Otros estados posibles de `/track/:id`: `429 RATE_LIMITED` (con header `Retry-After: 60`)
> si se supera el límite por IP, y `503 TRACK_ERROR` si falla la lectura de la base.

## 1.4 `POST /admin/ingest` — ingesta (backfill / manual)

Dispara la ingesta de todos los proveedores activos (Everest, Global Connection)
recorriendo el Almacén de Cargotrack y volcando a InsForge. **Requiere Bearer.**

Parámetros de query:

- `pages=N` — nº de páginas de lista a recorrer (1..20, por defecto 1). Cada página
  son 15 filas.
- `days=D` — ventana en días: sólo ingiere paquetes recibidos dentro de ese rango
  (1..120, por defecto 7).
- `offset=N` — modo *chunked*: ingiere **una sola** página de lista en ese offset de
  filas (0, 15, 30, ...). Pensado para backfills que caben dentro del límite de tiempo
  del Worker. Si se envía `offset`, se ignora `pages`.

### 1.4.1 Modo por páginas — `?pages=N&days=D`

**Método + URL**

```
POST https://hit-ever-scraper.honchkrow1995.workers.dev/admin/ingest?pages=2&days=7
```

**Headers**

```
Authorization: Bearer <ADMIN_SECRET>
```

**curl**

```bash
curl -s -X POST \
  -H "Authorization: Bearer <ADMIN_SECRET>" \
  "https://hit-ever-scraper.honchkrow1995.workers.dev/admin/ingest?pages=2&days=7&pretty=1"
```

**Respuesta esperada (200)**

```json
{
  "ok": true,
  "data": {
    "pages": 2,
    "days": 7,
    "result": {
      "everest": 5,
      "global_connection": 3
    }
  }
}
```

### 1.4.2 Modo chunked — `?offset=N&days=D`

**Método + URL**

```
POST https://hit-ever-scraper.honchkrow1995.workers.dev/admin/ingest?offset=15&days=30
```

**Headers**

```
Authorization: Bearer <ADMIN_SECRET>
```

**curl**

```bash
curl -s -X POST \
  -H "Authorization: Bearer <ADMIN_SECRET>" \
  "https://hit-ever-scraper.honchkrow1995.workers.dev/admin/ingest?offset=15&days=30&pretty=1"
```

**Respuesta esperada (200)**

```json
{
  "ok": true,
  "data": {
    "offset": 15,
    "days": 30,
    "result": {
      "everest": 4,
      "global_connection": 2
    }
  }
}
```

**Forma de la respuesta `result`:** un objeto `{ "everest": N, "global_connection": M }`
donde cada valor es el nº de paquetes upsertados para ese proveedor en esta corrida.
Un valor `-1` indica que ese proveedor falló (p. ej. login bloqueado por backoff);
el resto del lote sigue adelante.

**Sin Bearer / Bearer incorrecto → 401**

```bash
curl -s -X POST \
  "https://hit-ever-scraper.honchkrow1995.workers.dev/admin/ingest?pages=1&pretty=1"
```

```json
{
  "ok": false,
  "error": { "code": "UNAUTHORIZED", "message": "Invalid admin token." }
}
```

**Qué prueba:** que la ingesta corre de punta a punta (login Cargotrack → lista →
detalle → filtro por casillero → upsert en InsForge), y que la autenticación admin
protege la escritura. Tras esto, los datos deben verificarse en InsForge (sección 2) y
vía `/track` (1.3).

## 1.5 Herramientas internas (B6): status / tags / notes por guía

Todos requieren **Bearer** (la regla `/packages/*` está protegida). Si la guía no
existe en la base → `404 NOT_FOUND`.

### 1.5.1 `POST /admin/packages/:guia/status` — estado manual

Útil para forzar un estado que el scraper no marca (p. ej. Global Connection no marca
"entregado"; HIT lo fija a mano). El estado manual **gana** sobre el scrapeado en
`/track`.

`status` debe ser uno del enum:
`en_almacen | parcial | en_transito | en_destino | entregado | excepcion | desconocido`.

**Método + URL**

```
POST https://hit-ever-scraper.honchkrow1995.workers.dev/admin/packages/910500/status
```

**Headers**

```
Authorization: Bearer <ADMIN_SECRET>
Content-Type: application/json
```

**Body**

```json
{ "status": "entregado", "note": "Entregado en mano al cliente el 15/06" }
```

**curl**

```bash
curl -s -X POST \
  -H "Authorization: Bearer <ADMIN_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"status":"entregado","note":"Entregado en mano al cliente el 15/06"}' \
  "https://hit-ever-scraper.honchkrow1995.workers.dev/admin/packages/910500/status?pretty=1"
```

**Respuesta esperada (200)**

```json
{ "ok": true, "data": { "guia": "910500", "manualStatus": "entregado" } }
```

**Qué prueba:** que el override manual se persiste (`manual_status` en InsForge) y que,
al reconsultar `GET /track/910500`, el `status` pasa a `entregado` / `step: 4`.

### 1.5.2 `POST /admin/packages/:guia/tags` — etiqueta

**Método + URL**

```
POST https://hit-ever-scraper.honchkrow1995.workers.dev/admin/packages/910500/tags
```

**Headers**

```
Authorization: Bearer <ADMIN_SECRET>
Content-Type: application/json
```

**Body** (`value` es opcional)

```json
{ "label": "fragil", "value": "si" }
```

**curl**

```bash
curl -s -X POST \
  -H "Authorization: Bearer <ADMIN_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"label":"fragil","value":"si"}' \
  "https://hit-ever-scraper.honchkrow1995.workers.dev/admin/packages/910500/tags?pretty=1"
```

**Respuesta esperada (200)**

```json
{ "ok": true, "data": { "guia": "910500", "tag": "fragil" } }
```

**Qué prueba:** que se inserta una fila en `package_tags` asociada al paquete.

### 1.5.3 `POST /admin/packages/:guia/notes` — nota interna

**Método + URL**

```
POST https://hit-ever-scraper.honchkrow1995.workers.dev/admin/packages/910500/notes
```

**Headers**

```
Authorization: Bearer <ADMIN_SECRET>
Content-Type: application/json
```

**Body**

```json
{ "body": "Cliente pidió aviso por WhatsApp antes de entregar." }
```

**curl**

```bash
curl -s -X POST \
  -H "Authorization: Bearer <ADMIN_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"body":"Cliente pidió aviso por WhatsApp antes de entregar."}' \
  "https://hit-ever-scraper.honchkrow1995.workers.dev/admin/packages/910500/notes?pretty=1"
```

**Respuesta esperada (200)**

```json
{ "ok": true, "data": { "guia": "910500", "noted": true } }
```

**Qué prueba:** que se inserta una fila en `package_notes`. Las tags y notas son
internas: NO se exponen en el payload público de `/track`.

## 1.6 `POST /hooks/provider-email` — re-scrape por email de proveedor

Integración HTTP para el email de actualización de Cargotrack: un reenviador/parser
hace POST con el cuerpo del email, el Worker extrae el nº de almacén y vuelve a scrapear
ese paquete. (El handler nativo de Cloudflare Email Routing está en `index.ts` →
`email()`; este hook es la variante HTTP.)

**Auth:** secreto compartido en el header `X-Hook-Secret` únicamente. (El fallback `?secret=` en query string se removió en la auditoría de seguridad de 2026-07 — los query strings quedan en los logs HTTP de Cloudflare.)
**Body:** el texto/HTML del email. Query opcional `?provider=everest|global_connection`
(si se omite, intenta con todos los proveedores activos).

**Método + URL**

```
POST https://hit-ever-scraper.honchkrow1995.workers.dev/hooks/provider-email
```

**Headers**

```
X-Hook-Secret: <ADMIN_SECRET>
Content-Type: text/plain
```

**Body** (texto del email; debe contener el nº de almacén, p. ej. el del fixture)

```
Estimado cliente, su almacén # 926791 ha sido actualizado en el sistema.
Ingrese para ver el detalle de su envío.
```

**curl**

```bash
curl -s -X POST \
  -H "X-Hook-Secret: <ADMIN_SECRET>" \
  -H "Content-Type: text/plain" \
  --data-binary $'Estimado cliente, su almacén # 926791 ha sido actualizado en el sistema.\nIngrese para ver el detalle de su envío.' \
  "https://hit-ever-scraper.honchkrow1995.workers.dev/hooks/provider-email?pretty=1"
```

**Respuesta esperada (200)**

```json
{
  "ok": true,
  "data": { "almacenId": "926791", "ingested": true, "provider": "everest" }
}
```

**Errores esperados:**

- Secreto inválido o ausente → `401`:

  ```json
  { "ok": false, "error": { "code": "UNAUTHORIZED", "message": "Invalid hook secret." } }
  ```

- Cuerpo sin nº de almacén → `422`:

  ```json
  { "ok": false, "error": { "code": "NO_ID", "message": "No warehouse number (almacén #) was found in the email." } }
  ```

**Qué prueba:** la cadena reactiva completa: recibe el email → extrae el almacén →
re-scrapea ese paquete (sólo si pasa el filtro de casillero de HIT) → upsert. El campo
`provider` indica con qué proveedor se logró (o `null` + `ingested: false` si ninguno
lo aceptó, p. ej. porque el casillero no es de HIT).

---

# 2. INSFORGE DB (verificación directa)

Base: `https://a4qvtp8s.us-east.insforge.app`
Ruta REST: `/api/database/records/{tabla}` con filtros estilo PostgREST (`?col=eq.valor`).
**Auth (siempre):** `Authorization: Bearer <INSFORGE_API_KEY>`.

> La API key vive SÓLO en el Worker (Cloudflare Secret) / dashboard de InsForge. Úsala
> aquí únicamente para verificación manual; nunca la pongas en el cliente del sitio.

## 2.1 Buscar un paquete por nº de almacén (guía)

**Método + URL**

```
GET https://a4qvtp8s.us-east.insforge.app/api/database/records/packages?almacen_id=eq.926791&limit=1
```

**Headers**

```
Authorization: Bearer <INSFORGE_API_KEY>
```

**curl**

```bash
curl -s \
  -H "Authorization: Bearer <INSFORGE_API_KEY>" \
  "https://a4qvtp8s.us-east.insforge.app/api/database/records/packages?almacen_id=eq.926791&limit=1"
```

**Respuesta esperada (200)** — array de filas crudas (snake_case) de la tabla `packages`:

```json
[
  {
    "id": "f3a1c2d4-0000-0000-0000-000000000001",
    "provider_id": "11111111-1111-1111-1111-111111111111",
    "almacen_id": "926791",
    "tracking_number": "1Z2V8757YW00988871",
    "status": "en_transito",
    "raw_status": "In Transit",
    "service_type": "aereo",
    "weight_lb": 2.75,
    "volume_cf": 0.481,
    "pieces": 1,
    "origin_office": "MIA",
    "dest_office": "MGA",
    "description": "ELECTRONICO",
    "remitente": "AMAZON",
    "referencia_name": "MARTHA OROZCO IZAGUIRRE",
    "casillero": "37458",
    "declared_value": 0,
    "received_at": "2026-06-12T14:31:00Z",
    "last_event_at": "2026-06-12T14:31:00Z",
    "manual_status": null,
    "scraped_at": "2026-06-15T12:00:00.000Z"
  }
]
```

**Qué prueba:** que la ingesta escribió el paquete con los campos correctos (incluida la
PII interna `referencia_name` y el `casillero`, que NO deben salir nunca por `/track`).
Anota el `id` para la consulta de eventos.

## 2.2 Proyección de columnas (auditoría de casillero/estado)

**Método + URL**

```
GET https://a4qvtp8s.us-east.insforge.app/api/database/records/packages?select=almacen_id,status,casillero&limit=10
```

**curl**

```bash
curl -s \
  -H "Authorization: Bearer <INSFORGE_API_KEY>" \
  "https://a4qvtp8s.us-east.insforge.app/api/database/records/packages?select=almacen_id,status,casillero&limit=10"
```

**Respuesta esperada (200)**

```json
[
  { "almacen_id": "926791", "status": "en_transito", "casillero": "37458" },
  { "almacen_id": "910500", "status": "entregado",   "casillero": "37458" }
]
```

**Qué prueba:** de un vistazo, que todos los paquetes ingeridos por Everest tienen
`casillero` `37458` (el de HIT) — es la garantía de que el filtro de propiedad funciona
y no se cuela carga de terceros.

## 2.3 Eventos de un paquete (orden cronológico)

Usa el `id` (UUID del paquete) obtenido en 2.1.

**Método + URL**

```
GET https://a4qvtp8s.us-east.insforge.app/api/database/records/events?package_id=eq.f3a1c2d4-0000-0000-0000-000000000001&order=occurred_at.asc
```

**curl**

```bash
curl -s \
  -H "Authorization: Bearer <INSFORGE_API_KEY>" \
  "https://a4qvtp8s.us-east.insforge.app/api/database/records/events?package_id=eq.f3a1c2d4-0000-0000-0000-000000000001&order=occurred_at.asc"
```

**Respuesta esperada (200)**

```json
[
  {
    "id": "aaaa1111-0000-0000-0000-000000000001",
    "package_id": "f3a1c2d4-0000-0000-0000-000000000001",
    "occurred_at": "2026-06-12T14:31:00Z",
    "office": "MIA",
    "description": "Recibido",
    "status": null,
    "source": "cargotrack"
  }
]
```

**Qué prueba:** que los eventos del detalle se desnormalizaron y se guardaron ligados al
paquete, ordenados por `occurred_at` ascendente (exactamente lo que `/track` expone como
`events`).

## 2.4 Verificación de conteo

Para confirmar cuántos paquetes existen (p. ej. tras una ingesta), pide una sola fila
con `limit=1` y la cabecera de conteo exacto (`Prefer: count=exact`); InsForge devuelve
el total en la cabecera `Content-Range`:

**Método + URL**

```
GET https://a4qvtp8s.us-east.insforge.app/api/database/records/packages?casillero=eq.37458&limit=1
```

**Headers**

```
Authorization: Bearer <INSFORGE_API_KEY>
Prefer: count=exact
```

**curl** (`-D -` vuelca las cabeceras para leer `Content-Range`)

```bash
curl -s -D - -o /dev/null \
  -H "Authorization: Bearer <INSFORGE_API_KEY>" \
  -H "Prefer: count=exact" \
  "https://a4qvtp8s.us-east.insforge.app/api/database/records/packages?casillero=eq.37458&limit=1"
```

**Cabecera esperada**

```
Content-Range: 0-0/42
```

(el `42` es el total de paquetes con casillero `37458`).

**Qué prueba:** un conteo agregado sin descargar todas las filas; sirve para comparar
"antes vs después" de una corrida de ingesta.

---

# 3. CARGOTRACK (referencia / depuración manual)

Base: `https://everest.cargotrack.net`

Esta sección documenta la fuente que el Worker scrapea, para reproducir el flujo a mano
cuando algo falla. **Importante:** Cargotrack mantiene **una sola sesión por usuario**.
Si haces este flujo a mano con curl/Postman, hazlo con el **navegador desconectado**
(logged OUT) de Cargotrack, o invalidarás la sesión del Worker (y viceversa). Las
sesiones duran ~2-3 min.

## 3.1 Cadena de login (formulario)

1. **Seed de sesión** — `GET /` (recoge el cookie inicial `ASPSESSIONID...`):

   ```
   GET https://everest.cargotrack.net/
   ```

2. **Envío de credenciales** — `POST /` con cuerpo `application/x-www-form-urlencoded`:
   campos `user`, `password`, `action=login`, `Submit=Log In`. Esto regenera el cookie
   de sesión autenticado.

   ```
   POST https://everest.cargotrack.net/
   Content-Type: application/x-www-form-urlencoded
   Referer: https://everest.cargotrack.net/

   user=<CARGOTRACK_USER>&password=<CARGOTRACK_PASS>&action=login&Submit=Log+In
   ```

3. **Cadena de redirecciones** — un login correcto sigue:
   `validate.asp` → `validate_final.asp` → `/appl2.0/agent/default.asp`,
   acumulando cookies en cada salto. El `accessdenied=` que aparece en esas URLs es
   **parte del flujo normal**, no una denegación. Se considera login OK cuando la URL
   final cae dentro de `/appl2.0/agent/`.

**curl** (con cookie jar para encadenar; `-L` sigue las redirecciones):

```bash
# 1) Seed: guarda cookies en cookies.txt
curl -s -c cookies.txt \
  -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36" \
  "https://everest.cargotrack.net/" -o /dev/null

# 2) Login: reusa y actualiza cookies, sigue redirecciones hasta el área de agente
curl -s -b cookies.txt -c cookies.txt -L \
  -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36" \
  -H "Referer: https://everest.cargotrack.net/" \
  --data-urlencode "user=<CARGOTRACK_USER>" \
  --data-urlencode "password=<CARGOTRACK_PASS>" \
  --data-urlencode "action=login" \
  --data-urlencode "Submit=Log In" \
  "https://everest.cargotrack.net/" -o landing.html
```

**Qué prueba:** que las credenciales son válidas y la cadena de redirecciones lleva al
área de agente. Si `landing.html` no es la página de agente (sigues en login), las
credenciales fallaron o la sesión expiró.

## 3.2 Lista de Almacén — `GET /appl2.0/agent/whs.asp`

Vista "Almacén" (Warehouse). La página 1 es lo más reciente. Pagina por **offset de
filas** (15 filas por página): `?offset=15`, `?offset=30`, ...

**Método + URL**

```
GET https://everest.cargotrack.net/appl2.0/agent/whs.asp
GET https://everest.cargotrack.net/appl2.0/agent/whs.asp?offset=15
GET https://everest.cargotrack.net/appl2.0/agent/whs.asp?offset=30
```

**curl** (requiere la cookie de sesión del paso 3.1):

```bash
curl -s -b cookies.txt \
  -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36" \
  -H "Referer: https://everest.cargotrack.net/appl2.0/agent/default.asp" \
  "https://everest.cargotrack.net/appl2.0/agent/whs.asp?offset=15" -o whs.html
```

**Qué prueba:** que la sesión es válida y que el HTML de la lista es parseable
(`parseAlmacenList`). Si Cargotrack devuelve un 302 a login, la sesión caducó (el Worker
reintenta el login una vez automáticamente).

## 3.3 Detalle de un paquete — `GET /appl2.0/agent/whs_detail.asp?id=N`

`N` es el nº de almacén (guía). Este es el HTML que `fixtures/detalle.html` captura para
`id=926791`.

**Método + URL**

```
GET https://everest.cargotrack.net/appl2.0/agent/whs_detail.asp?id=926791
```

**curl**

```bash
curl -s -b cookies.txt \
  -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36" \
  -H "Referer: https://everest.cargotrack.net/appl2.0/agent/default.asp" \
  "https://everest.cargotrack.net/appl2.0/agent/whs_detail.asp?id=926791" -o detalle.html
```

**Qué prueba:** que el detalle contiene los campos que `parseDetail` extrae —
`consignee_id` (casillero, p. ej. `37458`), `consignee` (HIT CARGO), `shipper`
(AMAZON), `tracking_number`, `destination` (MGA), `description` (ELECTRONICO), el bloque
"Eventos de Seguimiento" (fecha/hora/oficina/descripción, p. ej. `6/12/2026 14:31 MIA
Recibido`). Comparar la salida real contra el fixture confirma que el scraper sigue
alineado con el HTML vivo.

---

# 4. Flujo e2e recomendado (checklist)

Ejecuta en este orden para validar todo el sistema de punta a punta:

1. **Worker vivo** — `GET /` y `GET /admin/health` → ambos `200`, `environment: "configured"`.
2. **Ingesta** — `POST /admin/ingest?pages=2&days=7` con `Authorization: Bearer <ADMIN_SECRET>`
   → `200` con `result: { everest: N, global_connection: M }` (N/M ≥ 0, sin `-1`).
3. **Verificar en InsForge** — con `Authorization: Bearer <INSFORGE_API_KEY>`:
   - `GET .../packages?select=almacen_id,status,casillero&limit=10` → todas las filas
     Everest con `casillero` `37458`.
   - `GET .../packages?almacen_id=eq.<GUIA>&limit=1` → anota el `id`.
   - `GET .../events?package_id=eq.<id>&order=occurred_at.asc` → eventos del paquete.
   - (Opcional) conteo con `Prefer: count=exact` → `Content-Range` para comparar antes/después.
4. **Verificar vía tracking público** — `GET /track/<GUIA>` → `200` con `PublicShipment`
   (los 4 campos `status / statusLabel / step` + `events`), **sin** casillero/PII/valor.
5. **Casos negativos de tracking** — `GET /track/000000` → `404 NOT_FOUND` (anti-enumeración);
   `GET /track/abc%20123` → `422 INVALID_PARAM`.
6. **(Opcional) Admin status/tag/note** — `POST /admin/packages/<GUIA>/status`
   `{"status":"entregado","note":"..."}` con Bearer → `200`; reconsulta
   `GET /track/<GUIA>` y confirma que el override manual gana
   (`status: "entregado"`, `step: 4`). Repetir con `/tags` y `/notes` si procede.
7. **(Opcional) Hook de email** — `POST /hooks/provider-email` con `X-Hook-Secret: <ADMIN_SECRET>`
   y un cuerpo que contenga el nº de almacén → `200` con `{ ingested: true, provider }`;
   verificar de nuevo en InsForge (paso 3) que ese paquete se actualizó (`scraped_at` reciente).
8. **(Sólo si algo falla) Cargotrack a mano** — con el navegador **desconectado**,
   reproducir login (3.1) → lista (3.2) → detalle (3.3) y comparar contra
   `fixtures/detalle.html` para descartar cambios en el HTML de origen.
