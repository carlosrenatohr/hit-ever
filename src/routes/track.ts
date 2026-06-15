import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import { RateLimiter } from '../lib/ratelimit.js'
import { getRepository } from '../lib/repository.js'
import { Res } from '../lib/response.js'
import { normalizeTracking, toPublicShipment } from '../types/tracking.js'
import type { CloudflareBindings } from '../types/index.js'

// ─── Schema ───────────────────────────────────────────────────────────────────
const trackParamSchema = z.object({
    id: z
        .string()
        .min(1, 'Tracking ID is required')
        .max(64, 'Tracking ID too long')
        .regex(/^[\w\-]+$/, 'Invalid tracking ID format'),
})

// ─── Router ───────────────────────────────────────────────────────────────────
const track = new Hono<{ Bindings: CloudflareBindings }>()

/**
 * GET /track/:id
 *
 * Reads from OUR database (Supabase), it does not scrape live. Ingestion (B3) fills the DB.
 *
 *  - PRIMARY lookup by waybill number / warehouse number (e.g. "926791").
 *  - If not found, SECONDARY attempt by the carrier tracking number.
 *
 * Security:
 *  - Per-IP rate limit (anti-abuse/enumeration).
 *  - The DB only contains HIT's packages (mailbox filter during ingestion),
 *    so a foreign id simply does not exist → 404 (bounded surface).
 *  - Returns a MINIMAL payload: no mailbox (casillero), customer name, value, or photo.
 */
track.get(
    '/:id',
    zValidator('param', trackParamSchema, (result, c) => {
        if (!result.success) {
            return Res.err(c, 'INVALID_PARAM', result.error.errors[0]?.message ?? 'Validation error', 422)
        }
    }),
    async (c) => {
        const { id } = c.req.valid('param')
        const start = Date.now()

        // ─── Rate limit ───────────────────────────────────────────────────────
        const ip = c.req.header('CF-Connecting-IP') ?? 'unknown'
        const limiter = new RateLimiter(c.env.UPSTASH_REDIS_URL, c.env.UPSTASH_REDIS_TOKEN)
        const rl = await limiter.check(ip)
        if (!rl.allowed) {
            c.header('Retry-After', '60')
            return Res.err(c, 'RATE_LIMITED', 'Too many requests. Please try again in a moment.', 429)
        }

        try {
            const db = getRepository(c.env)

            // Primary by waybill number (guía); fallback by carrier tracking.
            let pkg = await db.getPackageByGuia(id)
            if (!pkg) pkg = await db.getPackageByTracking(normalizeTracking(id))

            if (!pkg || !pkg.id) {
                return Res.err(
                    c,
                    'NOT_FOUND',
                    `We could not find a shipment with "${id}". Please check the waybill number (guía).`,
                    404,
                )
            }

            const events = await db.getEvents(pkg.id)
            const shipment = toPublicShipment(pkg, events)

            return Res.ok(c, shipment, {
                cachedAt: pkg.scrapedAt ? Date.parse(pkg.scrapedAt) : undefined,
                latencyMs: Date.now() - start,
            })
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error'
            console.error(`[track/${id}] error:`, message)
            return Res.err(
                c,
                'TRACK_ERROR',
                'We could not retrieve the shipment status. Please try again in a moment.',
                503,
            )
        }
    },
)

export { track as trackRouter }
