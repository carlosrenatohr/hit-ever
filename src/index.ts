import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { prettyJSON } from 'hono/pretty-json'
import { secureHeaders } from 'hono/secure-headers'
import { timing } from 'hono/timing'
import { Res } from './lib/response.js'
import { adminRouter } from './routes/admin.js'
import { trackRouter } from './routes/track.js'
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

// CORS – allow the Hit Cargo Astro site + local dev
app.use(
  '*',
  cors({
    origin: [
      'https://hitcargo.com',
      'https://www.hitcargo.com',
      'http://localhost:4321',   // Astro dev
      'http://localhost:3000',
    ],
    allowMethods: ['GET', 'POST', 'OPTIONS'],
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
    },
  }),
)

// Mount sub-routers
app.route('/track', trackRouter)
app.route('/admin', adminRouter)

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
export default app
