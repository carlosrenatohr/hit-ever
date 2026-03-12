import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import { Res } from '../lib/response.js'
import { EverestScraperService } from '../services/scraper.js'
import type { CloudflareBindings } from '../types/index.js'

// ─── Schema ───────────────────────────────────────────────────────────────────
const refreshBodySchema = z.object({
    secret: z.string().min(1),
})

// ─── Router ───────────────────────────────────────────────────────────────────
const admin = new Hono<{ Bindings: CloudflareBindings }>()

/**
 * GET /admin/health
 *
 * Returns service status and current session info (no credentials exposed).
 */
admin.get('/health', (c) => {
    return Res.ok(c, {
        service: 'hit-ever-scraper',
        version: '1.0.0',
        status: 'operational',
        timestamp: new Date().toISOString(),
        environment: c.env.EVEREST_BASE_URL ? 'configured' : 'missing-env',
    })
})

/**
 * POST /admin/session/refresh
 *
 * Forces a fresh login and updates the Redis-cached session.
 * Requires a `secret` in the request body matching a known value
 * (simple HMAC-less approach for now; upgrade to something stronger later).
 *
 * Body: { "secret": "<ADMIN_SECRET>" }
 */
admin.post(
    '/session/refresh',
    zValidator('json', refreshBodySchema, (result, c) => {
        if (!result.success) {
            return Res.err(c, 'INVALID_BODY', 'A "secret" field is required.', 400)
        }
    }),
    async (c) => {
        const { secret } = c.req.valid('json')

        // Very simple secret check – replace with proper auth later
        const adminSecret = (c.env as unknown as Record<string, string>)['ADMIN_SECRET']
        if (!adminSecret || secret !== adminSecret) {
            return Res.err(c, 'UNAUTHORIZED', 'Invalid admin secret.', 401)
        }

        try {
            const scraper = new EverestScraperService(c.env)
            const session = await scraper.refreshSession()

            return Res.ok(c, {
                message: 'Session refreshed successfully.',
                createdAt: new Date(session.createdAt).toISOString(),
                expiresAt: new Date(session.expiresAt).toISOString(),
                cookieCount: session.cookies.length,
            })
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error'
            console.error('[admin/session/refresh] Error:', message)
            return Res.err(c, 'SESSION_REFRESH_FAILED', message, 500)
        }
    },
)

export { admin as adminRouter }
