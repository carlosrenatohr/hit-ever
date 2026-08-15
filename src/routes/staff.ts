import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import { Cooldown } from '../lib/ratelimit.js'
import { Res } from '../lib/response.js'
import { resolveBillingSession, type BillingEnv } from '../modules/billing/middleware/auth.js'
import { IngestService } from '../services/ingest.js'

// ─── Constants / Schema ───────────────────────────────────────────────────────
// 5 min between manual re-scrapes of the same guia: protects the single Cargotrack
// session (the scraper and a human cannot coexist logged in) from UI hammering.
const REFRESH_COOLDOWN_SEC = 5 * 60

const guiaParamSchema = z.object({
  guia: z
    .string()
    .min(1, 'Guia is required')
    .max(64, 'Guia too long')
    .regex(/^[\w\-]+$/, 'Invalid guia format'),
})

const refreshQuerySchema = z.object({
  provider: z.enum(['everest', 'global_connection']).optional(),
})

// ─── Router ───────────────────────────────────────────────────────────────────
const staff = new Hono<BillingEnv>()

/**
 * POST /staff/packages/:guia/refresh?provider=X
 *
 * The panel's "Refrescar ahora" endpoint. Unlike /admin/* (which uses a shared
 * ADMIN_SECRET), this validates the caller's own InsForge session (JWT) and gates
 * on the `admin` role — the ADMIN_SECRET never leaves the Worker. A per-guia
 * cooldown (5 min) keeps the UI from stressing the shared Cargotrack session.
 */
staff.post(
  '/packages/:guia/refresh',
  zValidator('param', guiaParamSchema, (result, c) => {
    if (!result.success) {
      return Res.err(c, 'INVALID_PARAM', result.error.issues[0]?.message ?? 'Validation error', 422)
    }
  }),
  zValidator('query', refreshQuerySchema, (result, c) => {
    if (!result.success) {
      return Res.err(c, 'INVALID_QUERY', result.error.issues[0]?.message ?? 'Validation error', 422)
    }
  }),
  async (c) => {
    const { guia } = c.req.valid('param')
    const provider = c.req.valid('query').provider

    // ─── Auth: the panel user's own session + admin role ────────────────────
    const header = c.req.header('Authorization')
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : null
    if (!token) return Res.err(c, 'UNAUTHORIZED', 'Missing bearer token.', 401)
    const session = await resolveBillingSession(c.env, token)
    if (!session.ok) return Res.err(c, session.code, session.message, session.status)
    if (session.session.role !== 'admin') {
      return Res.err(c, 'FORBIDDEN', 'Only admin can force a re-scrape.', 403)
    }

    // ─── Cooldown per guia ──────────────────────────────────────────────────
    const cooldown = new Cooldown(c.env.UPSTASH_REDIS_URL, c.env.UPSTASH_REDIS_TOKEN, REFRESH_COOLDOWN_SEC)
    const cd = await cooldown.check(`refresh:${guia}`)
    if (!cd.allowed) {
      c.header('Retry-After', String(cd.retryAfterSeconds))
      return Res.err(c, 'RATE_LIMITED', 'Please wait before refreshing this package again.', 429, {
        retryAfterSeconds: cd.retryAfterSeconds,
      })
    }

    try {
      const svc = new IngestService(c.env)
      const found = provider
        ? (await svc.ingestOne(provider, guia)) && provider
        : await svc.ingestOneAnyProvider(guia)
      if (!found) {
        return Res.err(c, 'NOT_FOUND', `Could not refresh ${guia} (not found or ownership filter rejected it).`, 404)
      }
      return Res.ok(c, { guia, provider: found })
    } catch (error) {
      console.error('staff package refresh failed', error)
      return Res.err(c, 'REFRESH_FAILED', 'Refresh failed.', 500)
    }
  },
)

export { staff as staffRouter }
