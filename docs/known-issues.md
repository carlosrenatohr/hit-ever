# Known issues / incidentes — hit-ever2

Registro de problemas conocidos del worker y su causa raíz, para no re-investigar. Formato: síntoma
→ diagnóstico → causa → fix. Añadir arriba los más recientes.

---

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

**Causa raíz.** El plan **Workers Free** limita a **50 subrequests por invocación**. El camino
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
3. **Definitivo:** subir a **Workers Paid ($5/mes)** → el límite pasa a **1000 subrequests/invocación**
   y el problema desaparece; se pueden subir los batches y la frecuencia. Recomendado si el volumen
   crece.

**Cómo re-verificar a futuro.**
- Actividad de escritura: `select date_trunc('day',scraped_at)::date d, count(*) from packages
  where scraped_at > now() - interval '7 days' group by 1 order by 1 desc;`
- Errores del cron: Observability → *calculations*, filtro `$metadata.origin=cron` +
  `$metadata.level=error`, group by `$metadata.message`.
- Prueba en vivo: `POST /admin/refresh-open?provider=everest&limit=3` con `Authorization: Bearer <ADMIN_SECRET>`.

**Secundario a vigilar.** El login de Everest falla de forma intermitente (*"did not reach the agent
area"* + backoff de 15 min). Puede ser sesión corta de Cargotrack o rate-limit de IP; si se vuelve
frecuente, revisar credenciales y el throttle de salida.
