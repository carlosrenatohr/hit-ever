import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { prettyJSON } from 'hono/pretty-json'
import { secureHeaders } from 'hono/secure-headers'
import { timing } from 'hono/timing'
import { almacenIdFromEmail } from './lib/cargotrack.js'
import { billingRouter } from './modules/billing/routes/index.js'
import { Res } from './lib/response.js'
import { adminRouter } from './routes/admin.js'
import { hooksRouter } from './routes/hooks.js'
import { trackRouter } from './routes/track.js'
import { IngestService } from './services/ingest.js'
import type { CloudflareBindings } from './types/index.js'

// ─── App ──────────────────────────────────────────────────────────────────────
const app = new Hono<{ Bindings: CloudflareBindings }>()

// ─── Global Middleware ────────────────────────────────────────────────────────

// Request logging (format: --> GET /track/852786 / <-- 200 38ms)
app.use('*', logger())

// Server-Timing header for performance visibility
app.use('*', timing())

// Security headers (no X-Frame-Options clicks, CSP, etc.)
app.use('*', secureHeaders())

// CORS – allow the Hit Cargo Astro site (custom domain), its Cloudflare Pages deploys
// (production alias + preview hashes) and local dev. The /track payload is public and minimal,
// so this is defense-in-depth, not the primary control.
const STATIC_ALLOWED_ORIGINS = new Set([
  'https://hit-cargo.com',
  'https://www.hit-cargo.com',
  'http://localhost:4321', // Astro dev
  'http://localhost:3000',
])
// Landing Pages project: hit-landing-34b.pages.dev and every <hash>.hit-landing-34b.pages.dev preview.
const PAGES_ORIGIN_RE = /^https:\/\/([a-z0-9-]+\.)?hit-landing-34b\.pages\.dev$/
// Internal panel (hit-panel): its Cloudflare Pages production alias + preview hashes.
// The panel calls the authenticated /api/billing/* endpoints from the browser.
const PANEL_ORIGIN_RE = /^https:\/\/([a-z0-9-]+\.)?hit-panel\.pages\.dev$/
app.use(
  '*',
  cors({
    origin: (origin) => {
      if (!origin) return undefined
      if (STATIC_ALLOWED_ORIGINS.has(origin) || PAGES_ORIGIN_RE.test(origin) || PANEL_ORIGIN_RE.test(origin)) return origin
      return null // not allowed → no ACAO header → browser blocks the response
    },
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86400,
  }),
)

// ?pretty=1 → pretty-printed JSON (handy in dev/Postman)
app.use('*', prettyJSON({ space: 2 }))

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /
 * API root — useful sanity check that the worker is alive.
 */
app.get('/', (c) =>
  Res.ok(c, {
    name: 'hit-ever-scraper',
    description: 'Everest CargoTrack scraper API for Hit Cargo',
    version: '1.0.0',
    endpoints: {
      track: 'GET /track/:id',
      health: 'GET /admin/health',
      refreshSession: 'POST /admin/session/refresh',
      billing: 'GET /api/billing/health (auth)',
    },
  }),
)

// Mount sub-routers
app.route('/track', trackRouter)
app.route('/admin', adminRouter)
app.route('/hooks', hooksRouter)
app.route('/api/billing', billingRouter)

// ─── 404 Catch-all ────────────────────────────────────────────────────────────
app.notFound((c) =>
  Res.err(c, 'NOT_FOUND', `Route "${c.req.path}" does not exist.`, 404),
)

// ─── Global Error Handler ─────────────────────────────────────────────────────
app.onError((err, c) => {
  console.error('[unhandled]', err.message)
  return Res.err(
    c,
    'INTERNAL_ERROR',
    'An unexpected error occurred.',
    500,
  )
})

// ─── Export ───────────────────────────────────────────────────────────────────
export default {
  fetch: app.fetch,

  // Cron (wrangler triggers): periodic backup refresh. The main freshness mechanism
  // is the email trigger; this covers whatever the email does not reach.
  //
  // Each tick does ONE job for ONE provider so it stays under the Workers free-plan
  // 50-subrequest limit — see the triggers comment in wrangler.jsonc for why list-walk and
  // open-refresh can't share an invocation.
  async scheduled(event: { cron: string }, env: CloudflareBindings, ctx: { waitUntil(p: Promise<unknown>): void }) {
    const svc = new IngestService(env)
    const jobs: Record<string, Promise<unknown>> = {
      '0 */2 * * *': svc.ingestProvider('everest', 2),
      '30 */2 * * *': svc.ingestProvider('global_connection', 1),
      // 8, not 12: persist() costs ~4 subrequests/package (fetch + package + events + notes) —
      // measured hitting the 50-subrequest ceiling around package #7 at limit=20/21 in testing.
      '15 */6 * * *': svc.refreshOpenPackages('everest', 8),
      '45 */6 * * *': svc.refreshOpenPackages('global_connection', 8),
    }
    const job = jobs[event.cron] ?? svc.ingestProvider('everest', 2)
    ctx.waitUntil(job.catch((e) => console.error('[cron]', event.cron, (e as Error).message)))
  },

  // Cloudflare Email Routing: route the Cargotrack update email to this Worker.
  // Validates the sender, extracts the warehouse number, and re-scrapes that package.
  async email(message: any, env: CloudflareBindings, ctx: { waitUntil(p: Promise<unknown>): void }) {
    try {
      const from = String(message.from ?? '').toLowerCase()
      if (!from.endsWith('@cargotrack.email')) return
      const raw = await new Response(message.raw).text()
      const id = almacenIdFromEmail(raw) ?? almacenIdFromEmail(String(message.headers?.get?.('subject') ?? ''))
      if (!id) return
      ctx.waitUntil(new IngestService(env).ingestOneAnyProvider(id))
    } catch (e) {
      console.error('[email]', (e as Error).message)
    }
  },
}
