# Known issues / incidentes — hit-ever2

Registro de problemas conocidos del worker y su causa raíz, para no re-investigar. Formato: síntoma
→ diagnóstico → causa → fix. Añadir arriba los más recientes.

---

## 2026-09-11 · Guía 220643 (y 7 más) nunca llegaron a la BD — hueco de ingesta 16-ago → 02-sep

**Síntoma.** La guía GC 220643 (DANIEL VILCHEZ, casillero 1538, recibida en MIA el 19-ago) no
existía en `packages`. Alarma del cliente/ops: "si pasó con una, ¿cuántas más faltan?".

**Diagnóstico (verificado con datos, no asumido).**
- `providers`/`provider_agencies` correctos; el routing GC→hit funciona. El sistema SÍ estaba
  ingiriendo (GC last_scrape minutos antes) pero con volumen diario de 1-16 writes cuando el
  diseño permite ~180/día (página de 15 filas × 12 ticks diarios).
- Query de writes/día mostró un hueco casi total **16-ago → 02-sep** en AMBOS proveedores
  (GC: 11 el 16-ago, 2 el 25, 2 el 26, 0 hasta el 02-sep; Everest: 3 el 19-ago, 1 el 26-ago).
- La causa exacta de ese hueco ya no es auditable: la retención de logs de CF es de 7 días y el
  hook de Observability devolvía errores internos. El patrón es idéntico al incidente
  **2026-07-18 de abajo** (límite de 50 subrequests del plan Free + login backoff), que fue
  "mitigado" bajando batches, no curado.
- Mecánica de la pérdida: el list-walk solo ve **página 1 (15 filas)** con **ventana de 7 días**
  (`INGEST_WINDOW_DAYS`). Un paquete que llega durante un apagón y recibe >15 llegadas después,
  sale de la página 1; cuando sale de la ventana de 7 días es inalcanzable para siempre por el
  cron rutinario (solo el email trigger o un refresh manual lo rescatan).

**Auditoría exacta (backfill + diff) — el método para contar lo perdido:**
El `almacen_id` NO sirve para contar faltantes directamente: el espacio de IDs es compartido
entre TODOS los clientes de Global Connection (huecos de miles = casilleros ajenos). El contador
exacto es **recorrer el listado `whs.asp` hacia atrás y diff contra la BD**:
```
POST /admin/ingest?provider=<code>&offset=<0,15,30,...>&days=45
```
(página de 15 filas por invocación; ~21 subrequests, cabe en el plan Free). Se detiene cuando
`count:0` dos veces seguidas = se pasó del límite de la ventana. Diff de `almacen_id` antes/después
= faltantes exactos. Resultado de la auditoría del 11-sep (45 días):
- **GC:** 49 paquetes en 45 días; **3 faltantes** → 220643 (VILCHEZ), 218961 (DAVID DURAN,
  19-ago), 220665 (STEPFANIE, 03-sep).
- **Everest:** 19 paquetes en 45 días; **5 faltantes** → 977641 y 977761 (26-ago, dentro del
  hueco) + 976004/976258/976262 (10-sep, overflow de página 1).
- **Total: 8 guías perdidas en ~4 semanas. Todas recuperadas el 11-sep vía backfill.**

**Lección de riesgo.** El volumen real (~50 paquetes/45d entre ambos) es bajo, por eso la pérdida
fue pequeña pese a 17 días de ingesta moribunda. Pero es **ley de overflow**: con >15 llegadas
entre walks exitosos (lo que pasará al escalar clientes), la pérdida crece linealmente.

**Fixes.**
1. **Inmediato (aplicado 11-sep):** backfill completo de 45 días, ambos proveedores. Repetir esta
   auditoría (walk + diff) tras cualquier apagón detectado.
2. **Estructural recomendado:** Workers Paid ($5/mes) → 10.000 subrequests/invocación, mata la
   clase entera de fallos del incidente 2026-07-18 y permite walks profundos en una invocación.
3. **Alternativa gratuita:** cron de deep-walk rotativo (1 página extra por invocación, offsets
   15/30/45 en horarios muertos) + detector de huecos (ver abajo). Suficiente con el volumen
   actual, insuficiente si el volumen crece >15 llegadas/2h.
4. **Detección (pendiente de implementar):** `GET /admin/health` debe reflejar frescura real
   (max `scraped_at` por proveedor vs now; >6h de atraso → 503) para que un monitor externo
   gratuito (UptimeRobot/Better Stack free) alerte. Opcional: watermark de `max(almacen_id)`
   por proveedor como tripwire barato de "el walk no corrió".

**Regla para no re-investigar.** Guía faltante puntual → `POST /admin/packages/<GUIA>/refresh`.
Sospecha de paquetes perdidos por apagón → auditoría walk+diff de arriba. Write rate en el piso
por días → asumir subrequests/backoff, no "la BD está rota"; revisar Observability de CF primero.

---

## 2026-08-05 · Paquete sin libraje y "el re-scrape no lo llenó" (endpoint equivocado)

**Síntoma.** Dos guías en tránsito (955165, 961438) muestran "peso sin dato" en el panel.
Se intentó rellenarlas con `POST /admin/ingest?almacen_id=955165` → devolvía `ok:true` pero
el peso seguía null. En Cargotrack el detalle SÍ mostraba el peso ("3.6 pound(s)").

**Causa.** `/admin/ingest` **no acepta `almacen_id`**: solo `pages` / `days` / `offset` /
`provider`. La llamada con `almacen_id` hacía un ingest normal de la ventana reciente (que
no incluía esas guías por estar fuera del window de 7 días), así que nunca tocaba el paquete.

**Fix.** Usar el endpoint de re-scrape puntual:
`POST /admin/packages/<GUIA>/refresh` (con `?provider=everest|global_connection` opcional;
si se omite, `ingestOneAnyProvider` auto-detecta el proveedor). Ese re-scrapea el detalle
de esa guía y upserta el paquete + eventos + notas. Verificado: 955165 → `weightLb 0.3`,
961438 → `weightLb 3.6` (matchea la captura de Cargotrack).

**Regla para no re-investigar.** Para refrescar UNA guía puntual, siempre
`/admin/packages/:guia/refresh`. `/admin/ingest` es solo para recorrer el Almacén por
ventana/páginas/offset. Documentado en `docs/e2e-testing.md` §1.4.3.

---

## 2026-07-18 · Paquetes abiertos que nunca se refrescan (*starvation* del cron)

**Síntoma.** Un paquete queda con estado viejo (ej. `en_transito`) aunque en Cargotrack ya está
`entregado`; el re-scrape manual lo corrige al instante, pero el cron nunca lo alcanza (guia 945354).

**Causa.** `refreshOpenPackages` tomaba los abiertos ordenados por **`last_event_at ASC`** con un lote
capado. Con ese orden, el cron refresca **siempre el mismo subconjunto del frente** y los paquetes con
`last_event` más nuevo quedan pasados el corte del lote → **nunca se revisitan** (starvation). 945354
tenía el `last_event` más nuevo del set abierto, así que se congeló indefinidamente.

**Fix (aplicado).** `getOpenAlmacenIds` ahora ordena por **`scraped_at ASC`** (el menos-recientemente
scrapeado primero): tras refrescar, su `scraped_at` salta a ahora y rota al fondo → **round-robin** por
todos los abiertos. Se subió el lote del cron a **6** (verificado que cabe bajo 50 subrequests). Ver
`src/lib/insforge.ts` (`getOpenAlmacenIds`) y `src/index.ts` (handler `scheduled`).

**Verificar.** `select almacen_id, scraped_at from packages where effective_status<>'entregado' order
by scraped_at asc` — con el fix, ningún abierto debería quedar con `scraped_at` mucho más viejo que el
resto por varias vueltas del cron.

## 2026-07-18 · El cron "no deja registros nuevos" por días (límite de subrequests)

**Síntoma.** En InsForge, `scraped_at` de `packages` deja huecos de 1+ día; parece que el cron no
corre y que no se guarda nada nuevo.

**Diagnóstico (verificado, no asumido).**
- El cron **sí dispara** confiable. Cloudflare Observability (vista *calculations*, agrupado por
  `$metadata.trigger`, 48h) muestra los 4 crons corriendo cada 2h/6h sin faltar.
- El scraper **funciona** al dispararlo a mano: `POST /admin/refresh-open?provider=everest&limit=3`
  → `count:3` (login + scrape + write OK).
- Lo que falla es cada **invocación del cron**, con el error dominante en TODOS los ticks:
  ```
  [refresh-open] <provider>/<guia> failed: Too many subrequests by single Worker invocation.
  ```
  (más algún login fail intermitente de Everest: *"did not reach the agent area"* / *"backing off"*).

**Causa raíz.** El plan **Workers Free** limita a **50 subrequests EXTERNOS por invocación**
(verificado en docs de Cloudflare, 2026; Cargotrack, InsForge y Upstash cuentan todos como
externos). El plan **Paid** sube ese límite a **10,000** por defecto, configurable hasta 10M vía
`limits.subrequests`. El camino
per-paquete `persist()` cuesta ~**4 subrequests/paquete** (fetch del detalle + upsert de
`packages` + upsert de `events` + upsert de `package_provider_notes`), más el login/sesión
(~3-5) y las lecturas de Upstash. Con `refreshOpenPackages(provider, 8)` en el cron, la invocación
supera 50 y **falla casi todos los paquetes** → pocos/ningún write → la DB parece congelada. Por eso
el test manual con `limit=3` (≈13 subrequests) sí pasa.

**Dónde.** `src/index.ts` (handler `scheduled`): `refreshOpenPackages('everest'|'global_connection', 8)`
y `ingestProvider('everest', 2)`. Ver también el comentario de `wrangler.jsonc` sobre por qué
list-walk y open-refresh no comparten invocación.

**Fixes (de menor a mayor esfuerzo):**
1. **Rápido (mitiga ya):** bajar el batch del cron para quedar bajo 50 — `refreshOpenPackages` 8→**4**
   e `ingestProvider('everest', 2)`→**1**. Trade-off: cicla más lento los paquetes abiertos (con 4/tick
   cada 6h y ~20 abiertos en GC, cada uno se refresca ~cada 30h). El orden es *oldest-last-event-first*,
   así que los más atrasados entran primero.
2. **Estructural:** agrupar los 3 writes de `persist()` en menos llamadas a InsForge (como ya hace el
   camino bulk `ingestRows`), bajando el costo por paquete de ~4 a ~2 subrequests → se puede subir el
   batch sin reventar.
3. **Definitivo:** subir a **Workers Paid ($5/mes)** → el límite pasa a **10,000 subrequests/invocación**
   (configurable hasta 10M vía `limits.subrequests` en `wrangler.jsonc`); el problema desaparece y se
   pueden subir los batches y la frecuencia. Recomendado si el volumen crece.

**Cómo re-verificar a futuro.**
- Actividad de escritura: `select date_trunc('day',scraped_at)::date d, count(*) from packages
  where scraped_at > now() - interval '7 days' group by 1 order by 1 desc;`
- Errores del cron: Observability → *calculations*, filtro `$metadata.origin=cron` +
  `$metadata.level=error`, group by `$metadata.message`.
- Prueba en vivo: `POST /admin/refresh-open?provider=everest&limit=3` con `Authorization: Bearer <ADMIN_SECRET>`.

**Secundario a vigilar.** El login de Everest falla de forma intermitente (*"did not reach the agent
area"* + backoff de 15 min). Puede ser sesión corta de Cargotrack o rate-limit de IP; si se vuelve
frecuente, revisar credenciales y el throttle de salida.
