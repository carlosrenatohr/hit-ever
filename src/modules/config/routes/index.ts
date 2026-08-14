// ============================================================================
// Config router — mounted at /api/config in src/index.ts.
// ============================================================================
// Every route is gated by configAuth(...). Reads need rates:read / config:read /
// audit:read; every write re-checks rates:write at the route level. The
// organization is resolved from the session (admin/billing may pass
// ?organizationId= for another agency; staff is pinned to their own — enforced
// in ConfigService.resolveOrg). Writes propagate request_id into audit_logs.

import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import { Res } from '../../../lib/response.js'
import { FREIGHT_TYPES, PRICE_TIERS } from '../../billing/domain/enums.js'
import { configAuth, type ConfigEnv } from '../middleware/auth.js'
import { getConfigRepo } from '../repo/config-repo.js'
import { ConfigService } from '../service/config-service.js'

/** Map a service error to an HTTP status by its message. */
function fail(c: Parameters<typeof Res.err>[0], e: unknown) {
  const msg = e instanceof Error ? e.message : 'Unexpected error.'
  if (/not found/i.test(msg)) return Res.err(c, 'NOT_FOUND', msg, 404)
  if (/not authorized|forbidden/i.test(msg)) return Res.err(c, 'FORBIDDEN', msg, 403)
  if (/duplicate|unique/i.test(msg)) return Res.err(c, 'CONFLICT', 'A resource with those values already exists.', 409)
  console.error('config error:', msg, 'requestId:', c.get('requestId') ?? null)
  return Res.err(c, 'CONFIG_ERROR', 'Unexpected error.', 500)
}

const RATE_ROW_SCHEMA = z.object({
  tier: z.enum(PRICE_TIERS),
  price: z.number().nonnegative(),
  cost: z.number().nonnegative(),
})

const config = new Hono<ConfigEnv>()

// Reads gate the whole surface; writes additionally re-check at the route level.
config.use('*', configAuth('rates:read'))

// One request_id per request, propagated into audit_logs for observability
// correlation (coding-standards: Worker endpoint checklist).
config.use('*', async (c, next) => {
  c.set('requestId', crypto.randomUUID())
  await next()
})

/**
 * GET /api/config/branding
 * The agencies with their brand data (name + logo). Feeds the panel shell so
 * branding is dynamic per agency (admin sees all; the panel filters by the
 * logged-in user's agency).
 */
config.get('/branding', configAuth('config:read'), async (c) => {
  const svc = new ConfigService(getConfigRepo(c.env))
  return Res.ok(c, { agencies: await svc.getBranding(c.get('configSession')) })
})

/**
 * GET /api/config/rates
 * Rate tables (with their tier rows) for one organization. Non-admin callers
 * are pinned to their session agency; ?organizationId= is honored for
 * admin/billing only (validated server-side).
 */
config.get(
  '/rates',
  zValidator('query', z.object({ organizationId: z.string().optional() }), (r, c) => {
    if (!r.success) return Res.err(c, 'INVALID_QUERY', 'Invalid query parameters.', 422)
  }),
  async (c) => {
    const svc = new ConfigService(getConfigRepo(c.env))
    try {
      const org = svc.resolveOrg(c.get('configSession'), c.req.valid('query').organizationId)
      return Res.ok(c, { organizationId: org, tables: await svc.listRates(org) })
    } catch (e) {
      return fail(c, e)
    }
  },
)

/** POST /api/config/rates — create a rate table for the caller's org. */
config.post(
  '/rates',
  configAuth('rates:write'),
  zValidator(
    'json',
    z.object({
      name: z.string().min(1).max(80),
      freightType: z.enum(FREIGHT_TYPES),
      organizationId: z.string().optional(),
    }),
    (r, c) => {
      if (!r.success) return Res.err(c, 'INVALID_BODY', 'name and freightType are required.', 422)
    },
  ),
  async (c) => {
    const svc = new ConfigService(getConfigRepo(c.env))
    try {
      const session = c.get('configSession')
      const org = svc.resolveOrg(session, c.req.valid('json').organizationId)
      const { name, freightType } = c.req.valid('json')
      const table = await svc.createRate(org, name, freightType, session, c.get('requestId'))
      return Res.ok(c, table, undefined, 201)
    } catch (e) {
      return fail(c, e)
    }
  },
)

/** PATCH /api/config/rates/:id — rename a rate table. */
config.patch(
  '/rates/:id',
  configAuth('rates:write'),
  zValidator('json', z.object({ name: z.string().min(1).max(80) }), (r, c) => {
    if (!r.success) return Res.err(c, 'INVALID_BODY', 'name is required.', 422)
  }),
  async (c) => {
    const svc = new ConfigService(getConfigRepo(c.env))
    try {
      const session = c.get('configSession')
      return Res.ok(c, await svc.renameRate(session.agency, c.req.param('id'), c.req.valid('json').name, session, c.get('requestId')))
    } catch (e) {
      return fail(c, e)
    }
  },
)

/** DELETE /api/config/rates/:id — delete a rate table (rows cascade). */
config.delete('/rates/:id', configAuth('rates:write'), async (c) => {
  const svc = new ConfigService(getConfigRepo(c.env))
  try {
    const session = c.get('configSession')
    await svc.deleteRate(session.agency, c.req.param('id'), session, c.get('requestId'))
    return Res.ok(c, { deleted: true, id: c.req.param('id') })
  } catch (e) {
    return fail(c, e)
  }
})

/** PUT /api/config/rates/:id/rows — replace the tier rows of a rate table. */
config.put(
  '/rates/:id/rows',
  configAuth('rates:write'),
  zValidator(
    'json',
    z.object({
      rows: z
        .array(RATE_ROW_SCHEMA)
        .max(10)
        .refine((rows) => new Set(rows.map((r) => r.tier)).size === rows.length, 'Duplicate tiers are not allowed.'),
    }),
    (r, c) => {
      if (!r.success) return Res.err(c, 'INVALID_BODY', 'rows must be an array of { tier, price, cost } with no duplicate tiers.', 422)
    },
  ),
  async (c) => {
    const svc = new ConfigService(getConfigRepo(c.env))
    try {
      const session = c.get('configSession')
      const table = await svc.replaceRows(session.agency, c.req.param('id'), c.req.valid('json').rows, session, c.get('requestId'))
      return Res.ok(c, table)
    } catch (e) {
      return fail(c, e)
    }
  },
)

/** POST /api/config/rates/assign-client — set a client's default rate table. */
config.post(
  '/rates/assign-client',
  configAuth('rates:write'),
  zValidator('json', z.object({ clientId: z.string().min(1), rateTableId: z.string().nullish() }), (r, c) => {
    if (!r.success) return Res.err(c, 'INVALID_BODY', 'clientId is required.', 422)
  }),
  async (c) => {
    const svc = new ConfigService(getConfigRepo(c.env))
    try {
      const session = c.get('configSession')
      const { clientId, rateTableId } = c.req.valid('json')
      await svc.assignClientDefault(session.agency, clientId, rateTableId ?? null, session, c.get('requestId'))
      return Res.ok(c, { clientId, defaultRateId: rateTableId ?? null })
    } catch (e) {
      return fail(c, e)
    }
  },
)

/** POST /api/config/rates/override-package — override a package's rate table. */
config.post(
  '/rates/override-package',
  configAuth('rates:write'),
  zValidator('json', z.object({ guia: z.string().min(1), rateTableId: z.string().nullish() }), (r, c) => {
    if (!r.success) return Res.err(c, 'INVALID_BODY', 'guia is required.', 422)
  }),
  async (c) => {
    const svc = new ConfigService(getConfigRepo(c.env))
    try {
      const session = c.get('configSession')
      const { guia, rateTableId } = c.req.valid('json')
      const packageId = await svc.overridePackageRate(session.agency, guia, rateTableId ?? null, session, c.get('requestId'))
      return Res.ok(c, { packageId, guia, rateTableId: rateTableId ?? null })
    } catch (e) {
      return fail(c, e)
    }
  },
)

/**
 * GET /api/config/audit
 * Read-only audit trail (staff/admin; admin may pass ?organizationId= for any
 * agency, staff is pinned to their own).
 */
config.get(
  '/audit',
  configAuth('audit:read'),
  zValidator(
    'query',
    z.object({
      organizationId: z.string().optional(),
      action: z.string().optional(),
      entityType: z.string().optional(),
      entityId: z.string().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      page: z.coerce.number().int().positive().optional(),
      pageSize: z.coerce.number().int().positive().max(200).optional(),
    }),
    (r, c) => {
      if (!r.success) return Res.err(c, 'INVALID_QUERY', 'Invalid query parameters.', 422)
    },
  ),
  async (c) => {
    const svc = new ConfigService(getConfigRepo(c.env))
    try {
      const session = c.get('configSession')
      const { organizationId, ...filter } = c.req.valid('query')
      const org = svc.resolveOrg(session, organizationId)
      const { rows, count } = await svc.listAudit(org, filter)
      return Res.ok(c, { organizationId: org, rows, count })
    } catch (e) {
      return fail(c, e)
    }
  },
)

export { config as configRouter }
