import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import { getRepository } from '../lib/repository.js'
import { Res } from '../lib/response.js'
import { IngestService } from '../services/ingest.js'
import { EverestScraperService } from '../services/scraper.js'
import type { CloudflareBindings } from '../types/index.js'

const STATUS_ENUM = z.enum([
  'en_almacen',
  'parcial',
  'en_transito',
  'en_destino',
  'entregado',
  'excepcion',
  'desconocido',
])

// ─── Router ───────────────────────────────────────────────────────────────────
const admin = new Hono<{ Bindings: CloudflareBindings }>()

// Bearer auth for internal endpoints (writes). Replace with HMAC if the team grows.
const adminAuth = async (c: any, next: any) => {
  const auth = c.req.header('Authorization') ?? ''
  if (!c.env.ADMIN_SECRET || auth !== `Bearer ${c.env.ADMIN_SECRET}`) {
    return Res.err(c, 'UNAUTHORIZED', 'Invalid admin token.', 401)
  }
  await next()
}
admin.use('/packages/*', adminAuth)
admin.use('/ingest', adminAuth)

/** GET /admin/health */
admin.get('/health', (c) => {
  return Res.ok(c, {
    service: 'hit-ever-scraper',
    version: '1.1.0',
    status: 'operational',
    timestamp: new Date().toISOString(),
    environment: c.env.EVEREST_BASE_URL ? 'configured' : 'missing-env',
  })
})

/** POST /admin/session/refresh — body { secret } (legacy, Everest session) */
admin.post(
  '/session/refresh',
  zValidator('json', z.object({ secret: z.string().min(1) }), (result, c) => {
    if (!result.success) return Res.err(c, 'INVALID_BODY', 'A "secret" field is required.', 400)
  }),
  async (c) => {
    const { secret } = c.req.valid('json')
    if (!c.env.ADMIN_SECRET || secret !== c.env.ADMIN_SECRET) {
      return Res.err(c, 'UNAUTHORIZED', 'Invalid admin secret.', 401)
    }
    try {
      const session = await new EverestScraperService(c.env).refreshSession()
      return Res.ok(c, {
        message: 'Session refreshed successfully.',
        createdAt: new Date(session.createdAt).toISOString(),
        expiresAt: new Date(session.expiresAt).toISOString(),
        cookieCount: session.cookies.length,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      return Res.err(c, 'SESSION_REFRESH_FAILED', message, 500)
    }
  },
)

/** POST /admin/ingest?pages=N — triggers ingestion of all active providers (backfill/manual). */
admin.post('/ingest', async (c) => {
  const days = Math.min(120, Math.max(1, Number(c.req.query('days') ?? '7')))
  const offsetParam = c.req.query('offset')
  try {
    const svc = new IngestService(c.env)
    // Chunked backfill: ?offset=N ingests just that one list page (fits the Worker time limit).
    if (offsetParam !== undefined) {
      const offset = Math.max(0, Number(offsetParam))
      const result = await svc.ingestAllAtOffset(offset, days)
      return Res.ok(c, { offset, days, result })
    }
    const pages = Math.min(20, Math.max(1, Number(c.req.query('pages') ?? '1')))
    const result = await svc.ingestAll(pages, days)
    return Res.ok(c, { pages, days, result })
  } catch (error) {
    return Res.err(c, 'INGEST_FAILED', (error as Error).message, 500)
  }
})

// ─── Internal tool (B6): tags / notes / manual status by waybill (guía) ───────
function db(c: any) {
  return getRepository(c.env)
}

/** POST /admin/packages/:guia/status — body { status, note? } (e.g. mark "entregado" in GC) */
admin.post(
  '/packages/:guia/status',
  zValidator('json', z.object({ status: STATUS_ENUM, note: z.string().optional() })),
  async (c) => {
    const { guia } = c.req.param()
    const { status, note } = c.req.valid('json')
    const client = db(c)
    const pkg = await client.getPackageByGuia(guia)
    if (!pkg?.id) return Res.err(c, 'NOT_FOUND', `Waybill (guía) ${guia} does not exist.`, 404)
    await client.setManualStatus(pkg.id, status, 'admin', note, new Date().toISOString())
    return Res.ok(c, { guia, manualStatus: status })
  },
)

/** POST /admin/packages/:guia/tags — body { label, value? } */
admin.post(
  '/packages/:guia/tags',
  zValidator('json', z.object({ label: z.string().min(1), value: z.string().optional() })),
  async (c) => {
    const { guia } = c.req.param()
    const { label, value } = c.req.valid('json')
    const client = db(c)
    const pkg = await client.getPackageByGuia(guia)
    if (!pkg?.id) return Res.err(c, 'NOT_FOUND', `Waybill (guía) ${guia} does not exist.`, 404)
    await client.addTag(pkg.id, label, value ?? null, 'admin')
    return Res.ok(c, { guia, tag: label })
  },
)

/** POST /admin/packages/:guia/notes — body { body } */
admin.post(
  '/packages/:guia/notes',
  zValidator('json', z.object({ body: z.string().min(1) })),
  async (c) => {
    const { guia } = c.req.param()
    const { body } = c.req.valid('json')
    const client = db(c)
    const pkg = await client.getPackageByGuia(guia)
    if (!pkg?.id) return Res.err(c, 'NOT_FOUND', `Waybill (guía) ${guia} does not exist.`, 404)
    await client.addNote(pkg.id, body, 'admin')
    return Res.ok(c, { guia, noted: true })
  },
)

export { admin as adminRouter }
