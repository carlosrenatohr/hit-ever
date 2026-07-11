# Security & correctness audit — hit-ever2 (julio 2026)

Auditoría adversarial del Worker de tracking. Resultado global: **sin vulnerabilidad crítica explotable**;
higiene de secretos correcta (verificado: ningún secreto real fue commiteado en toda la historia de git;
`.dev.vars`/`.insforge` están gitignored). El stripping de PII del payload público es allowlist-based y
correcto, todas las rutas mutantes están gateadas, y no hay injection/SSRF. Abajo: lo arreglado en esta PR
y lo que queda como acción tuya (rotación de secretos, rate-limit, DKIM).

## Arreglado en esta PR

| # | Sev | Qué | Fix |
|---|-----|-----|-----|
| H1 | HIGH | `/hooks/provider-email` aceptaba el secreto por `?secret=`, que el logger de Hono y los logs HTTP de Cloudflare capturan → filtra el ADMIN_SECRET a los sinks de log. | Solo header `X-Hook-Secret`; se quitó el fallback de query. |
| M1 | MED | Comparación de secreto con `!==` (short-circuita en el primer byte → timing). | `timingSafeEqual` (SHA-256 + XOR) en `adminAuth`, `session/refresh` y el hook. |
| M3 | MED | `getPackageByGuia` buscaba por `almacen_id` solo (no único: Everest y GC pueden colisionar) con `limit=1` sin orden → fila no determinista; un cliente podía ver otro envío. | `&order=scraped_at.desc&limit=1` (determinista). |
| M6 | MED | Rutas admin devolvían `error.message` crudo (fuga de internos de InsForge). | Mensaje genérico al caller + `console.error` del detalle. |
| L2 | LOW | `Number(query)` sin guardia → `NaN` sobrevivía a `Math.min/max` (`&limit=NaN` inyectado). | Helper `intParam` con fallback validado. |
| L3 | LOW | Type error latente en `track.test.ts` (fuera del gate). | `Promise.resolve(worker.fetch(...))`. |
| Panel H1 | HIGH | El rol `viewer` podía **escribir**: los RPCs `set_manual_status`/`add_package_tag`/`add_package_note` gateaban con `is_staff()` (true para cualquier usuario activo, incl. viewer); el panel solo ocultaba la UI. | Nueva migración `20260711040000_fix-viewer-write-rls.sql`: `is_writer()` (admin\|staff) + re-guarda los 3 RPCs. **Aplicar con `npx @insforge/cli db migrations up --all`.** |

Gate `pnpm check` (vitest 19/19 + wrangler dry-run) verde.

## Acción requerida (NO auto-arreglado — decisión/infra tuya)

- **H2 · Rotar `ADMIN_SECRET` (URGENTE).** El valor en `.dev.vars` es corto/baja entropía (`kf#A!9fY4G`) y probablemente es el de producción. Es la ÚNICA credencial que protege ingest/refresh/override/hook. Generá 32+ bytes aleatorios y `wrangler secret put ADMIN_SECRET`. Mantené dev ≠ prod.
- **H3 · Rotar el resto de secretos** que están en el working tree (`.dev.vars`, `.insforge`): admin key de InsForge (bypassa RLS), token de Upstash, key de OpenAI, contraseñas de Everest/GC. Están gitignored y nunca se commitearon, pero estuvieron expuestos en este entorno → tratalos como comprometidos. Usá valores dev-only localmente.
- **M2 · Rate-limit en `/admin/*` y `/hooks/*`.** Hoy solo `/track` está limitado. Sumá un lockout por IP en fallos de auth (frena fuerza bruta del secreto) reutilizando el `RateLimiter` existente. Los crons no pasan por HTTP, así que no se ven afectados.
- **M4 · Verificar DKIM/SPF en el handler `email()`** (`index.ts`), en vez de confiar en `message.from` (spoofable). Cloudflare expone los resultados de auth del email.
- **M5 · Alerta cuando el rate-limiter falla abierto** (Upstash caído → `/track` sin protección). Emitir métrica/log.
- **L1 · Timezone:** `toIso` etiqueta horas locales de Miami como UTC. Corregir con el offset real (America/New_York, con DST) — tiene implicación en datos ya guardados, así que decidir backfill.
- **L4 · Lock en el login de sesión** (crons/email/manual concurrentes pueden re-loguear y desalojarse).

## Cloudflare — cómo endurecerlo (lo que querés aprender)

El Worker ya hace bien: CORS allowlist explícito, `secureHeaders()`, `CF-Connecting-IP` (no spoofable detrás de CF) para el rate limit, y presupuesto de subrequests. Para llevarlo al 100%:

1. **Secrets vs vars.** Todo lo sensible va con `wrangler secret put` (cifrado), NO en `[vars]` de `wrangler.jsonc` (texto plano en el dashboard). Revisá que ADMIN_SECRET/keys sean secrets, no vars.
2. **WAF + Rate Limiting Rules (dashboard, gratis en parte).** Reglas a nivel de edge (antes del Worker) para `/admin/*`: limitar por IP, bloquear países/ASNs no esperados, y una regla de rate-limit en `/track` como segunda capa a la de Upstash.
3. **Cloudflare Access (Zero Trust)** delante de `/admin/*`: exige login SSO/email antes de que el request llegue al Worker — convierte el ADMIN_SECRET en segunda capa, no única.
4. **Logpush con cuidado.** Con observability al 100% (`head_sampling_rate: 1`), los logs guardan URLs completas — por eso H1 importaba. Nunca pongas secretos en query strings.
5. **Custom domain + TLS estricto.** Servir el Worker en `api.hit-cargo.com` con "Full (strict)" y HSTS.
6. **Turnstile** en el endpoint público `/track` si aparece abuso, en vez de subir el rate-limit.

## Verificado como correcto (no romper al arreglar)

- Sin secretos en git (verificado con `git log -S` sobre cada valor real).
- PII allowlist-based en `toPublicShipment()`; RLS default-deny en todas las tablas.
- Toda ruta mutante gateada; sin injection (PostgREST con `encodeURIComponent`, `:id` validado por zod); sin `eval`/SSRF; parsers regex lineales.
- CORS allowlist, `secureHeaders`, `onError` genérico, IP no spoofable para el limiter.
