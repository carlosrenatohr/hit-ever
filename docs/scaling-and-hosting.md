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

## Migración a opencode — retos y beneficio

**El beneficio (costo).** Real y grande: bajar el costo por token moviendo el desarrollo a opencode +
un modelo más barato/propio. **Pero el ahorro solo se materializa si ese modelo produce trabajo
CORRECTO.** Si produce trabajo sutilmente-mal que nadie atrapa, el "ahorro" se vuelve deuda técnica e
incidentes en prod. La palanca que decide de qué lado caés es **el harness**.

**Los retos, del mayor al menor:**

1. **El harness tiene que ser el ancla de confianza — hoy es parcial.** Con un modelo más barato, la
   confianza **no puede venir de la prosa del agente**; tiene que venir de **gates deterministas que
   corran solos** (tests + CI + verificación en vivo). Estado actual: v1.2 y ever2 tienen `pnpm check`
   + CI; el **panel no tiene tests** y varios flujos no tienen verificación automática. **Prerrequisito
   #1: dejar el harness airtight en los 3 repos** antes de bajar de modelo. Sin eso, un modelo débil
   mergea bugs con confianza.
2. **Gap de capacidad del modelo.** Este código necesitó razonar sobre un **sistema viejo desconocido**
   (Cargotrack) y cazar bugs sutiles (límite de subrequests, *starvation* del refresh, parsing de
   `service_type`, RLS/auth, URL de InsForge baked en build). Un modelo más chico los pasa por alto con
   facilidad. El hábito **"verificar con evidencia, no asumir"** es difícil de sostener para modelos
   débiles → el harness y los fixtures son los que compensan.
3. **Loop engineering / auto-mejora.** Que sea "auto-mejorable" = el agente corre el harness, lee el
   fallo, arregla, re-corre, y **aprende** (memoria/feedback). Requiere: gates deterministas, buenas
   superficies de error (mensajes claros, no swallow), un store de memoria, y **guardrails** para que
   no derive ni haga cosas destructivas sin supervisión. Construir ese loop confiable es el trabajo
   real — no es "prender opencode".
4. **Guardrails / seguridad.** Esta sesión tuvo clasificadores bloqueando cosas riesgosas (deploys a
   prod sin pedirlo, materializar credenciales en el transcript, auto-merge de PRs propios). opencode
   self-hosted **necesita guardrails equivalentes** o human-in-the-loop, o hay riesgo real a prod y a
   secretos (tenemos PAT de GitHub, ADMIN_SECRET, creds de Cargotrack/InsForge en juego).
5. **Paridad de tooling.** Esta sesión usó: Cloudflare MCP (observability/logs), InsForge CLI, `gh` +
   PAT, **lectura de screenshots**, subagents, y skills del repo. opencode necesita esos equivalentes
   cableados (MCP, CLIs, credenciales en archivos gitignored). Algunos (leer capturas, verificación en
   navegador real) pueden quedar más débiles y hay que suplirlos.
6. **Contexto / conocimiento de dominio.** El proyecto tiene conocimiento tribal (gotchas de
   Cargotrack, InsForge, la topología multi-repo, quirks de deploy/credenciales). Un modelo nuevo sin
   el contexto de esta sesión depende de **estos docs + la memoria** para no re-romper cosas ya
   resueltas. Por eso vale mantener `docs/` y el `ONBOARDING.md` al día — son el onboarding del próximo
   agente.

**Recomendación de secuencia:** (1) cerrar el harness en los 3 repos → (2) recién ahí bajar a un modelo
más barato en opencode para las tareas mecánicas, dejando las de diseño/seguridad/parser al criterio
humano o a un modelo fuerte → (3) construir el loop de auto-mejora encima de gates que ya son
confiables. El orden importa: auto-mejora sobre un harness flojo amplifica errores, no los corrige.
