# Backfill histórico — runbook

Guía operativa para traer historia "desde X fecha" a InsForge cuando la ventana normal (cron,
últimos 60-120 días) no alcanza. Escrito después de correr el primer backfill real (Everest, desde
enero 2026, julio 2026) — documenta el procedimiento, los supuestos que hay que verificar cada vez,
y los problemas que ya mordieron una vez para no repetirlos.

**Backfill ≠ backup.** Esto llena las mismas tablas de producción que usan el Worker y `hit-panel`,
no crea una copia aparte. Es idempotente (upsert), así que correrlo de más no rompe nada — pero
tampoco sustituye un respaldo real.

---

## 1. Antes de correr nada

1. **¿Cuántos días hacia atrás necesito?** Calculá los días entre la fecha objetivo y hoy.
2. **¿Cargotrack retiene esa historia?** No asumir — probarlo. Ver §2.
3. **¿El cap de `days` en `/admin/ingest` alcanza?** `src/routes/admin.ts` cachea `days` a un máximo
   (hoy 250). Si tu ventana es mayor, **`ingestRows` descarta en silencio** las filas más viejas que
   `days` aunque el offset sea correcto (`withinDays()` en `src/services/ingest.ts`). Sin este chequeo
   podés traer el offset correcto y aun así perder las filas de los meses más antiguos sin ningún error.
4. **¿Hay un humano logueado en Cargotrack ahora mismo?** Sesión única — si alguien está en el
   navegador, el login del Worker devuelve listas vacías. Pedir que se desloguee antes de empezar.
5. **¿InsForge tiene margen?** `npx @insforge/cli db query "select pg_size_pretty(pg_database_size(current_database()))"`.
   Free tier = 500 MB. Un backfill de meses de texto/números no se acerca ni de lejos (verificado:
   ~12 MB con 106 paquetes/272 eventos/166 notas — con 4x ese volumen seguiría bajo 50 MB).

---

## 2. Encontrar el offset objetivo (no adivinar)

La lista de Cargotrack (`whs.asp`) es un ledger cronológico descendente, no paginación por fecha —
hay que **leer las fechas reales** en la página para saber cuándo llegás al límite que buscás.

```bash
# 1 login manual (reusa cookie), luego varios GET espaciados de la lista, mirando las fechas:
curl -s -A "$UA" -b "$JAR" "https://everest.cargotrack.net/appl2.0/agent/whs.asp?offset=$OFF" \
  | grep -oE "[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}" | sort -u
```

Barré con saltos grandes primero (150, 300, 450…) para ubicar el rango, después afiná de 15 en 15
hasta encontrar exactamente dónde cae tu fecha límite. Un solo login sirve para todo el barrido — no
hay que reloguear entre offsets.

**Cada proveedor pagina distinto:**
- **Everest**: ledger real, retiene mucho más de lo que se esperaría (verificado hasta abril 2025).
  Offset avanza ~15 filas/página; las fechas bajan monótonamente.
- **Global Connection**: la lista se topa en un puñado de filas (una decena) sin importar el offset
  — pedir offset 15/30/45… devuelve las MISMAS filas. No es un bug: esa cuenta simplemente no tiene
  más historial expuesto por esta vía. Si ya la ingeriste una vez, no hay nada más que backfillear ahí.

---

## 3. Correr el backfill

Un provider por invocación (`?provider=<code>`), un offset por llamada, **secuencial** (nunca en
paralelo — ver §4.1):

```bash
URL=https://hit-ever-scraper.honchkrow1995.workers.dev
A="Authorization: Bearer ${ADMIN_SECRET}"
for o in $(seq 0 15 <OFFSET_FINAL>); do
  curl -s -X POST -H "$A" "$URL/admin/ingest?provider=everest&offset=$o&days=<DIAS_SUFICIENTES>"
  echo
  sleep 2   # cortesía; también deja que la sesión cacheada respire entre llamadas
done
```

- `days` debe cubrir TODA la ventana (ver §1.3) — no solo la página actual.
- Es seguro repetir offsets o volver a correr todo el rango: upsert por `(provider_id, almacen_id)`
  con `merge-duplicates`; eventos dedup por `(package_id, occurred_at, description)`; notas por
  `(package_id, body, author, noted_at)`.
- Si se corta a mitad, **simplemente continuá desde el último offset confirmado** — no hace falta
  reiniciar desde 0.

**Verificar al final:**
```bash
npx @insforge/cli db query \
  "select pr.code, count(*) n, min(p.received_at) oldest, max(p.received_at) newest
   from public.packages p join public.providers pr on pr.id=p.provider_id group by pr.code"
```
Confirmá que `oldest` cae en o cerca de la fecha objetivo.

---

## 4. Known issues y sus fixes

### 4.1 Sesión única — no paralelizar, nunca
**Síntoma:** logins que fallan intermitentemente, listas vacías, o backoff (`ct:login_block:<provider>`
en Upstash) sin razón aparente. **Causa:** dos requests de login casi simultáneas (dos llamadas
paralelas, o un humano navegando mientras corre el backfill) invalidan la sesión de la otra.
**Fix:** todo secuencial, con `sleep` entre llamadas. Nunca correr el backfill con subagentes/scripts
en paralelo contra el mismo proveedor — no acelera nada, solo rompe sesiones entre sí. Confirmar que
nadie esté logueado en el navegador antes de arrancar.

### 4.2 `days` cap silencioso
**Síntoma:** el offset es correcto (fechas confirmadas en la página) pero esas filas no aparecen en
InsForge. **Causa:** `ingestRows` filtra por `withinDays(r.fecha, windowDays)` — si `days` es menor
que la distancia real a la fecha objetivo, esas filas se descartan sin error visible.
**Fix:** calcular los días reales necesarios ANTES de correr nada; subir el cap en `admin.ts` si hace
falta (hoy tope 250 — subido desde 120 durante el backfill de enero 2026, ver commit
`fix: raise the /admin/ingest days cap`). Redeployar antes de backfillear, no después.

### 4.3 Límite de 50 subrequests por invocación (Workers free plan)
**Síntoma:** `Too many subrequests by single Worker invocation`. **Causa:** un proveedor sin filtro de
casillero (Global Connection) abre un detalle por fila; correr dos proveedores en una sola invocación
suma subrequests de ambos y revienta el límite. **Fix:** ya resuelto en código — `?provider=<code>`
aísla un proveedor por invocación, y el cron corre cada proveedor en un tick separado
(`0 */2` Everest, `30 */2` Global Connection). Si se agrega un tercer proveedor de alto volumen,
revisar de nuevo si Workers Paid ($5/mes, límite 1000 subrequests) vale la pena.

### 4.4 InsForge `PGRST102` — "All object keys must match"
**Síntoma:** `Insforge bulk upsert packages → 400` en páginas donde algunos paquetes tienen
`manual_status*` (por la nota `RETIRADO`) y otros no. **Causa:** PostgREST exige que todo el array de
un insert bulk tenga las mismas keys. **Fix:** ya resuelto — `upsertPackages()` en `src/lib/insforge.ts`
agrupa las filas por firma de keys y manda un POST por grupo. No debería reaparecer, pero si se agrega
un campo condicional nuevo a `toPackageRow()`, revisar que siga agrupando bien.

### 4.5 Encoding — texto con `�`
**Síntoma:** acentos rotos en `description`/notas (`Lleg� al Pa�s`). **Causa:** Cargotrack sirve
Windows-1252, no UTF-8. **Fix:** ya resuelto — `fetchHtml()` decodifica con
`new TextDecoder('windows-1252')`. Si aparece de nuevo texto con `�` en algo *nuevo* backfillado,
sospechar un decode point no cubierto (raro) antes que asumir que el fix se revirtió.

### 4.6 Login "correcto" que no llega a `/appl2.0/agent/`
**Síntoma:** con credenciales confirmadas buenas, el Worker reporta `did not reach the agent area`.
**Causa histórica:** credenciales viejas/mal seteadas en los secrets del Worker (no solo en
`.dev.vars` local — hay que `wrangler secret put` aparte). **Fix:** verificar con un curl de login
manual (HTTP puro, sin JS) que la cadena de redirects termine en `/appl2.0/agent/default.asp`; si
termina en `/default.asp` con texto "incorrect", las credenciales están mal, no es un bug de código.

### 4.7 GC "no pagina" — no es un fallo
Ver §2. Si un backfill futuro de GC devuelve las mismas filas en offsets crecientes, es el
comportamiento esperado de esa cuenta, no algo que arreglar.

---

## 5. Ver también

- `docs/session-log-2026-06.md` — bitácora completa de la construcción del scraper (login, batching,
  encoding, etc.) con más contexto de cada fix listado arriba.
- `docs/production-deployment.md` — go-live, secrets, límites de plan.
