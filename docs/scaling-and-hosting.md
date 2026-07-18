# Escalar y hosting — hit-ever2 (worker de tracking)

Notas de arquitectura y escalamiento para el scraper + API. Escrito como **handoff**: el equipo va a
mover el desarrollo a otra herramienta/modelo, así que acá queda el razonamiento completo, no solo la
conclusión. Relacionado: [known-issues.md](known-issues.md) (incidente del límite de subrequests).

## TL;DR

- **El cuello de botella real NO es la infra — es Cargotrack.** Sesión única por cuenta, no se puede
  paralelizar, y hay que throttlear para no comerse un ban de IP. Un servidor más grande **no** da más
  throughput si el límite es el proveedor.
- **Ahora:** el fix de lote (cron 4/tick) destraba el estancamiento en Workers Free. Ver known-issues.
- **Siguiente paso más barato:** **Workers Paid ($5/mes)** → límite de subrequests 50 → **10,000**
  (config hasta 10M). Se sube `limits.subrequests`, se suben los batches del cron, y el diseño actual
  anda sin migrar nada.
- **Si el scraping crece de verdad:** partir por responsabilidad — **API pública + landing + panel se
  quedan en Cloudflare** (el edge es ideal para lectura global/cacheada); **el scraper se muda a un
  droplet de DigitalOcean** (proceso Node siempre-encendido + cron, sin límites de subrequests/tiempo).
- **AWS: saltearla.** Sin beneficio a esta escala y con factura enredada.

## Por qué el scraper no encaja bien en serverless

El scraper hace **muchas requests externas secuenciales** (login Cargotrack → walk de lista → abrir
detalle por paquete), throttleadas a propósito. El modelo serverless de Workers pelea con eso:

- **Límite de subrequests por invocación** (Free 50 externos, Paid 10,000). Cada paquete cuesta ~4
  (fetch detalle + 3 upserts InsForge). Terminás batcheando entre invocaciones y haciendo malabares
  con los cron ticks (que es lo que hacemos hoy).
- Límites de **CPU/wall-time** por invocación (aunque esperar en `fetch` no cuenta como CPU, hay tope
  de tiempo en scheduled).

Un **servidor chico siempre-encendido** (droplet DO, o Fly/Render worker) es el fit natural: un loop
throttleado, cron del sistema, sesión persistente, sin límites de subrequests ni de tiempo.

## Opciones de hosting (evaluadas)

| Opción | Costo | Veredicto |
|---|---|---|
| **Cloudflare Workers Paid** | $5/mes | ✅ Más rápido/barato para destrabar YA. Límite → 10,000. Cero migración. |
| **DigitalOcean droplet** | $6–12/mes | ✅ Fit natural del scraper; stack conocido por el equipo. Manejás el box (updates, uptime). |
| **AWS (Lambda/ECS/EC2)** | variable | ❌ Factura compleja, sin beneficio a esta escala. Lambda tiene topes de tiempo parecidos a Workers. |

**Recomendación escalonada:**
1. **Hoy:** fix de lote (hecho) → destraba en Free.
2. **Cuando quieras más margen sin migrar:** Workers Paid + `limits.subrequests` + subir batches.
3. **Cuando el volumen lo pida:** split — scraper → DO droplet; API/landing/panel → Cloudflare; misma
   DB InsForge.
4. **DB:** InsForge/Postgres aguanta este volumen. Si lo superás, el swap es un Postgres gestionado
   (DO Managed DB / Neon / Supabase), no ahora.

**El techo real:** escalar "masivo" el scraping = más **cuentas de proveedor** (sesiones paralelas), un
**feed/API real** de Everest/GC (lo mejor), o proxies (frágil, gato-y-ratón). No más CPU.

## Pre-configurar `limits.subrequests` (¿hace ruido en Free?)

**No hace ruido.** Se puede dejar puesto en `wrangler.jsonc` ahora y **se activa solo al pasar a Paid**:

```jsonc
// wrangler.jsonc — agregar dentro del objeto raíz:
"limits": { "subrequests": 10000 }
```

- **Verificado:** `wrangler deploy --dry-run` con esa línea pasa sin errores ni warnings (config válida).
- **En Free es inerte:** la plataforma sigue enforced a 50 subrequests externos por invocación sin
  importar el config (docs de Cloudflare, 2026). No lo sube, pero **tampoco rompe el deploy**.
- **En Paid toma efecto** → hasta 10,000 (o el valor que pongas, máx 10M).
- Nota: el dry-run valida el config localmente, no pega contra la API. Si querés 100% de certeza de
  que un deploy real en Free no tira warning, confirmalo al momento de agregarlo (un `wrangler deploy`).
  Riesgo bajísimo.

**Al pasar a Paid, además:** subir de nuevo los batches del cron en `src/index.ts` (handler
`scheduled`): `refreshOpenPackages` 4 → 10–15, `ingestProvider('everest', 1)` → 2–3. Y opcionalmente
subir la frecuencia. Con 10,000 de límite hay margen de sobra.

## Handoff a otra herramienta / modelo

- Toda la lógica del worker vive en `hit-ever2/src/`. El estado vivo (qué está desplegado, gotchas)
  está en `docs/` (este archivo, `known-issues.md`, `session-log-*`, `production-deployment.md`) y en
  el `ONBOARDING.md` de la raíz del workspace.
- El worker **auto-deploya** en push a `feat/tracker-api` (GitHub Action `Deploy Worker to Cloudflare`;
  necesita el secret `CLOUDFLARE_API_TOKEN`).
- Convenciones (para cualquier modelo/herramienta): commits Conventional **sin firma de IA**, código y
  comentarios en **inglés**, copy/docs de equipo en **español**. Verificar con el gate `pnpm check`
  (vitest + `wrangler deploy --dry-run`), no confiar en la prosa.
- El scraper es contra un **sistema viejo (Cargotrack, Classic ASP)**: no asumir, verificar con HTML
  real/fixtures antes de tocar el parser (`src/lib/cargotrack.ts`, con tests en
  `src/lib/cargotrack.test.ts`).
