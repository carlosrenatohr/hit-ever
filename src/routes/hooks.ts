import { Hono } from 'hono'
import { almacenIdFromEmail } from '../lib/cargotrack.js'
import { Res } from '../lib/response.js'
import { timingSafeEqual } from '../lib/security.js'
import { IngestService } from '../services/ingest.js'
import type { CloudflareBindings } from '../types/index.js'

const hooks = new Hono<{ Bindings: CloudflareBindings }>()

/**
 * POST /hooks/provider-email
 *
 * HTTP integration for the Cargotrack update email (for a forward/parser that
 * POSTs the body). The native Cloudflare Email Routing handler is in index.ts (email()).
 *
 * Auth: shared secret in the `X-Hook-Secret` header only. NOT accepted via `?secret=` — query
 * strings are captured by Hono's request logger and Cloudflare's edge HTTP logs, which would leak
 * the master secret into log sinks.
 * Body: the HTML/text of the email. Extracts the warehouse number and re-scrapes that package.
 * Optional query: ?provider=everest|global_connection (if omitted, tries all).
 */
hooks.post('/provider-email', async (c) => {
  const secret = c.req.header('X-Hook-Secret')
  if (!c.env.ADMIN_SECRET || !secret || !(await timingSafeEqual(secret, c.env.ADMIN_SECRET))) {
    return Res.err(c, 'UNAUTHORIZED', 'Invalid hook secret.', 401)
  }

  const raw = await c.req.text()
  const almacenId = almacenIdFromEmail(raw)
  if (!almacenId) return Res.err(c, 'NO_ID', 'No warehouse number (almacén #) was found in the email.', 422)

  const ingest = new IngestService(c.env)
  const provider = c.req.query('provider')
  const code = provider ? ((await ingest.ingestOne(provider, almacenId)) ? provider : null) : await ingest.ingestOneAnyProvider(almacenId)

  return Res.ok(c, { almacenId, ingested: code !== null, provider: code })
})

export { hooks as hooksRouter }
