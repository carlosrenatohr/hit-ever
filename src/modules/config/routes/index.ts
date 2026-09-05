// ============================================================================
// Config router — mounted at /api/config in src/index.ts.
// ============================================================================
// Every route is gated by configAuth(...). Reads need rates:read / config:read /
// audit:read; every write re-checks rates:write at the route level. The
// organization is resolved from the session for every route — admin/billing may
// pass ?organizationId= (reads and writes alike) to manage another agency;
// staff is pinned to their own — enforced in ConfigService.resolveOrg.
// Writes propagate request_id into audit_logs.

import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import { Res } from '../../../lib/response.js'
import { FREIGHT_TYPES } from '../../billing/domain/enums.js'
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
  tier: z.string().min(1).max(40),
  price: z.number().nonnegative(),
  cost: z.number().nonnegative().nullable(),
})

// Storage object keys under the branding bucket: letters, digits, / _ . - (the
// panel uploads logos/<slug>.webp). The URL is derived server-side so clients
// can never point branding at an arbitrary host.
const BRANDING_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9/._-]{0,254}$/

// Optional org override for writes, same semantics as GET /rates: honored for
// admin/billing only (resolveOrg enforces it server-side).
const ORG_QUERY = z.object({ organizationId: z.string().optional() })

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
 * GET /api/config/info — the caller's own agency profile (RUC, address, phone,
 * currency, is_scrapable). Self-scoped like branding: even admins only read
 * their own agency's info.
 */
config.get('/info', configAuth('config:read'), async (c) => {
  const svc = new ConfigService(getConfigRepo(c.env))
  try {
    return Res.ok(c, await svc.getInfo(c.get('configSession')))
  } catch (e) {
    return fail(c, e)
  }
})

/**
 * PATCH /api/config/info — update the caller's own agency profile. config:write.
 * Currency governs money symbols across the panel; is_scrapable is read-only here
 * (it changes via data/ops, not from the UI).
 */
config.patch(
  '/info',
  configAuth('config:write'),
  zValidator(
    'json',
    z.object({
      ruc: z.string().max(50).nullish(),
      address: z.string().max(300).nullish(),
      phone: z.string().max(40).nullish(),
      currency: z.enum(['USD', 'NIO']).optional(),
    }),
    (r, c) => {
      if (!r.success) return Res.err(c, 'INVALID_BODY', 'Invalid agency info payload.', 422)
    },
  ),
  async (c) => {
    const svc = new ConfigService(getConfigRepo(c.env))
    try {
      return Res.ok(c, await svc.updateInfo(c.get('configSession'), c.req.valid('json'), c.get('requestId')))
    } catch (e) {
      return fail(c, e)
    }
  },
)

/**
 * GET /api/config/payments — the agency's dynamic payment catalogs (methods and
 * banks). Self-scoped to the session agency.
 */
config.get('/payments', configAuth('config:read'), async (c) => {
  const svc = new ConfigService(getConfigRepo(c.env))
  return Res.ok(c, await svc.listPaymentCatalogs(c.get('configSession').agency))
})

/**
 * POST /api/config/payments/methods — add a payment method. config:write.
 */
config.post(
  '/payments/methods',
  configAuth('config:write'),
  zValidator('json', z.object({ name: z.string().min(1).max(40) }), (r, c) => {
    if (!r.success) return Res.err(c, 'INVALID_BODY', 'name is required.', 422)
  }),
  async (c) => {
    const svc = new ConfigService(getConfigRepo(c.env))
    try {
      return Res.ok(c, await svc.createPaymentMethod(c.get('configSession').agency, c.req.valid('json').name, c.get('configSession'), c.get('requestId')), undefined, 201)
    } catch (e) {
      return fail(c, e)
    }
  },
)

/**
 * PATCH /api/config/payments/methods/:id — rename or toggle a method. config:write.
 */
config.patch(
  '/payments/methods/:id',
  configAuth('config:write'),
  zValidator(
    'json',
    z.object({ name: z.string().min(1).max(40).optional(), active: z.boolean().optional() }),
    (r, c) => {
      if (!r.success) return Res.err(c, 'INVALID_BODY', 'Nothing to update.', 422)
    },
  ),
  async (c) => {
    const svc = new ConfigService(getConfigRepo(c.env))
    try {
      await svc.updatePaymentMethod(c.get('configSession').agency, c.req.param('id'), c.req.valid('json'), c.get('configSession'), c.get('requestId'))
      return Res.ok(c, { ok: true })
    } catch (e) {
      return fail(c, e)
    }
  },
)

/**
 * POST /api/config/payments/banks — add a bank. config:write.
 */
config.post(
  '/payments/banks',
  configAuth('config:write'),
  zValidator('json', z.object({ name: z.string().min(1).max(40) }), (r, c) => {
    if (!r.success) return Res.err(c, 'INVALID_BODY', 'name is required.', 422)
  }),
  async (c) => {
    const svc = new ConfigService(getConfigRepo(c.env))
    try {
      return Res.ok(c, await svc.createPaymentBank(c.get('configSession').agency, c.req.valid('json').name, c.get('configSession'), c.get('requestId')), undefined, 201)
    } catch (e) {
      return fail(c, e)
    }
  },
)

/**
 * PATCH /api/config/payments/banks/:id — rename or toggle a bank. config:write.
 */
config.patch(
  '/payments/banks/:id',
  configAuth('config:write'),
  zValidator(
    'json',
    z.object({ name: z.string().min(1).max(40).optional(), active: z.boolean().optional() }),
    (r, c) => {
      if (!r.success) return Res.err(c, 'INVALID_BODY', 'Nothing to update.', 422)
    },
  ),
  async (c) => {
    const svc = new ConfigService(getConfigRepo(c.env))
    try {
      await svc.updatePaymentBank(c.get('configSession').agency, c.req.param('id'), c.req.valid('json'), c.get('configSession'), c.get('requestId'))
      return Res.ok(c, { ok: true })
    } catch (e) {
      return fail(c, e)
    }
  },
)

/**
 * PATCH /api/config/branding/:slug — update an agency's logo.
 * config:write. The client only sends the storage object key; the public URL is
 * derived server-side from INSFORGE_API_URL so branding can never point at an
 * arbitrary host. Tenant check in the service: only admin may touch another
 * agency (billing/staff are pinned to their own).
 */
config.patch(
  '/branding/:slug',
  configAuth('config:write'),
  zValidator(
    'param',
    z.object({ slug: z.string().regex(/^[a-z0-9-]{1,32}$/, 'Invalid agency slug.') }),
    (r, c) => {
      if (!r.success) return Res.err(c, 'INVALID_BODY', 'Invalid agency slug.', 422)
    },
  ),
  zValidator(
    'json',
    z.object({ logoKey: z.string().regex(BRANDING_KEY_RE, 'logoKey must be a valid object key.').nullable() }),
    (r, c) => {
      if (!r.success) return Res.err(c, 'INVALID_BODY', 'logoKey must be a valid object key.', 422)
    },
  ),
  async (c) => {
    const svc = new ConfigService(getConfigRepo(c.env))
    try {
      const session = c.get('configSession')
      const patch = await svc.updateBranding(
        session,
        c.req.param('slug'),
        c.req.valid('json').logoKey,
        c.get('requestId'),
        c.env.INSFORGE_API_URL,
      )
      return Res.ok(c, patch)
    } catch (e) {
      return fail(c, e)
    }
  },
)

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
  zValidator('query', ORG_QUERY, (r, c) => {
    if (!r.success) return Res.err(c, 'INVALID_QUERY', 'Invalid query parameters.', 422)
  }),
  zValidator('json', z.object({ name: z.string().min(1).max(80) }), (r, c) => {
    if (!r.success) return Res.err(c, 'INVALID_BODY', 'name is required.', 422)
  }),
  async (c) => {
    const svc = new ConfigService(getConfigRepo(c.env))
    try {
      const session = c.get('configSession')
      const org = svc.resolveOrg(session, c.req.valid('query').organizationId)
      return Res.ok(c, await svc.renameRate(org, c.req.param('id'), c.req.valid('json').name, session, c.get('requestId')))
    } catch (e) {
      return fail(c, e)
    }
  },
)

/** DELETE /api/config/rates/:id — delete a rate table (rows cascade). */
config.delete(
  '/rates/:id',
  configAuth('rates:write'),
  zValidator('query', ORG_QUERY, (r, c) => {
    if (!r.success) return Res.err(c, 'INVALID_QUERY', 'Invalid query parameters.', 422)
  }),
  async (c) => {
    const svc = new ConfigService(getConfigRepo(c.env))
    try {
      const session = c.get('configSession')
      const org = svc.resolveOrg(session, c.req.valid('query').organizationId)
      await svc.deleteRate(org, c.req.param('id'), session, c.get('requestId'))
      return Res.ok(c, { deleted: true, id: c.req.param('id') })
    } catch (e) {
      return fail(c, e)
    }
  },
)

/** PUT /api/config/rates/:id/rows — replace the tier rows of a rate table. */
config.put(
  '/rates/:id/rows',
  configAuth('rates:write'),
  zValidator('query', ORG_QUERY, (r, c) => {
    if (!r.success) return Res.err(c, 'INVALID_QUERY', 'Invalid query parameters.', 422)
  }),
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
      const org = svc.resolveOrg(session, c.req.valid('query').organizationId)
      const table = await svc.replaceRows(org, c.req.param('id'), c.req.valid('json').rows, session, c.get('requestId'))
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
  zValidator('query', ORG_QUERY, (r, c) => {
    if (!r.success) return Res.err(c, 'INVALID_QUERY', 'Invalid query parameters.', 422)
  }),
  zValidator('json', z.object({ clientId: z.string().min(1), rateTableId: z.string().nullish() }), (r, c) => {
    if (!r.success) return Res.err(c, 'INVALID_BODY', 'clientId is required.', 422)
  }),
  async (c) => {
    const svc = new ConfigService(getConfigRepo(c.env))
    try {
      const session = c.get('configSession')
      const org = svc.resolveOrg(session, c.req.valid('query').organizationId)
      const { clientId, rateTableId } = c.req.valid('json')
      await svc.assignClientDefault(org, clientId, rateTableId ?? null, session, c.get('requestId'))
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
  zValidator('query', ORG_QUERY, (r, c) => {
    if (!r.success) return Res.err(c, 'INVALID_QUERY', 'Invalid query parameters.', 422)
  }),
  zValidator('json', z.object({ guia: z.string().min(1), rateTableId: z.string().nullish() }), (r, c) => {
    if (!r.success) return Res.err(c, 'INVALID_BODY', 'guia is required.', 422)
  }),
  async (c) => {
    const svc = new ConfigService(getConfigRepo(c.env))
    try {
      const session = c.get('configSession')
      const org = svc.resolveOrg(session, c.req.valid('query').organizationId)
      const { guia, rateTableId } = c.req.valid('json')
      const packageId = await svc.overridePackageRate(org, guia, rateTableId ?? null, session, c.get('requestId'))
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
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'from must be an ISO date.').optional(),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'to must be an ISO date.').optional(),
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
