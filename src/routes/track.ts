import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import { Res } from '../lib/response.js'
import { EverestScraperService } from '../services/scraper.js'
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
 * Returns structured shipment data for the given tracking ID.
 *
 * Flow:
 *  1. Validate :id param
 *  2. Instantiate EverestScraperService (uses env bindings)
 *  3. Scrape & parse the Everest page
 *  4. Return JSON or 404/500
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

        try {
            const scraper = new EverestScraperService(c.env)
            const data = await scraper.track(id)

            if (!data) {
                return Res.err(
                    c,
                    'NOT_FOUND',
                    `No tracking data found for ID "${id}". The shipment may not exist or the system is unavailable.`,
                    404,
                )
            }

            return Res.ok(c, data, {
                scrapedAt: data.scrapedAt,
                latencyMs: Date.now() - start,
            })
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown scraper error'
            console.error(`[track/${id}] Scraper error:`, message)

            return Res.err(
                c,
                'SCRAPER_ERROR',
                'Failed to retrieve tracking data. Please try again in a moment.',
                503,
                process.env.NODE_ENV === 'development' ? message : undefined,
            )
        }
    },
)

export { track as trackRouter }
