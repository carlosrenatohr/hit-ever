// ============================================================================
// Billing router — mounted at /api/billing in src/index.ts.
// ============================================================================
// Every route is gated by billingAuth(...). Stage 0 ships only /health (proves the
// auth path end-to-end). Catalog/quote (Stage 1), invoices CRUD + payments +
// close-month (Stage 3) are added under this same router.

import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import { Res } from '../../../lib/response.js'
import { CatalogService } from '../catalog/catalog.js'
import { margin } from '../domain/calc.js'
import { CURRENCIES, FREIGHT_TYPES, INVOICE_STATUSES, PAYMENT_BANKS, PAYMENT_METHODS } from '../domain/enums.js'
import { billingAuth, type BillingEnv } from '../middleware/auth.js'
import { getBillingRepo } from '../repo/billing-repo.js'
import { BillingService } from '../service/billing-service.js'

/** Map a service error to an HTTP status by its message. */
function fail(c: Parameters<typeof Res.err>[0], e: unknown) {
  const msg = e instanceof Error ? e.message : 'Unexpected error.'
  if (/not found/i.test(msg)) return Res.err(c, 'NOT_FOUND', msg, 404)
  if (/voided|at least one|not offered/i.test(msg)) return Res.err(c, 'INVALID_REQUEST', msg, 422)
  return Res.err(c, 'BILLING_ERROR', msg, 500)
}

const billing = new Hono<BillingEnv>()

// Read access gates the whole surface; write routes additionally re-check
// 'invoices:write' at the route level (Stage 3).
billing.use('*', billingAuth('invoices:read'))

/**
 * GET /api/billing/health
 * Authenticated liveness check. Returns 200 only for an active staff member with
 * billing read access; 401 for anon/invalid token, 403 for a non-billing role.
 * Echoes the caller's role/name so the panel can confirm the session wired up.
 */
billing.get('/health', (c) => {
  const s = c.get('billingSession')
  return Res.ok(c, {
    module: 'billing',
    status: 'operational',
    version: '0.1.0',
    user: { role: s.role, name: s.name, email: s.email },
    timestamp: new Date().toISOString(),
  })
})

/**
 * GET /api/billing/catalog
 * The full pricing catalog (AIR/MAR + tiers + cost). Feeds the panel's tier dropdown
 * and lets the UI show the live rate. `null` madres price = tier not offered.
 */
billing.get('/catalog', async (c) => {
  const svc = new CatalogService(getBillingRepo(c.env))
  return Res.ok(c, await svc.entries())
})

/**
 * GET /api/billing/quote?freightType=AIR&tier=REGULAR&lbs=3.2
 * Org-aware price for a would-be line: the session agency's rate tables (client
 * default first, legacy catalog fallback), then total / freight cost / profit /
 * margin. 404 if no source prices that tier for the freight.
 */
billing.get(
  '/quote',
  zValidator(
    'query',
    z.object({
      freightType: z.enum(FREIGHT_TYPES),
      tier: z.string().min(1),
      lbs: z.coerce.number().positive(),
    }),
    (result, c) => {
      if (!result.success) return Res.err(c, 'INVALID_QUERY', 'freightType, tier and a positive lbs are required.', 422)
    },
  ),
  async (c) => {
    const { freightType, tier, lbs } = c.req.valid('query')
    const svc = new CatalogService(getBillingRepo(c.env))
    const q = await svc.quoteOrg(c.get('billingSession').agency, freightType, tier, lbs)
    if (!q) return Res.err(c, 'TIER_NOT_OFFERED', `Tier ${tier} is not offered for ${freightType}.`, 404)
    return Res.ok(c, { ...q, margin: margin(q.total, q.profit) })
  },
)

// ─── Invoices ─────────────────────────────────────────────────────────────────

/** GET /api/billing/invoices — filtered, paginated list (mirrors the packages list). */
billing.get(
  '/invoices',
  zValidator(
    'query',
    z.object({
      status: z.enum(INVOICE_STATUSES).optional(),
      freightType: z.enum(FREIGHT_TYPES).optional(),
      fiscalYear: z.coerce.number().int().optional(),
      clientId: z.string().optional(),
      search: z.string().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      page: z.coerce.number().int().positive().optional(),
      pageSize: z.coerce.number().int().positive().max(1000).optional(),
    }),
  ),
  async (c) => {
    const svc = new BillingService(getBillingRepo(c.env))
    return Res.ok(c, await svc.list({ ...c.req.valid('query'), organizationId: c.get('billingSession').agency }))
  },
)

/** GET /api/billing/invoices/:id — full invoice (header + lines + payments + packages). */
billing.get('/invoices/:id', async (c) => {
  const svc = new BillingService(getBillingRepo(c.env))
  const view = await svc.get(c.req.param('id'), c.get('billingSession').agency)
  if (!view) return Res.err(c, 'NOT_FOUND', 'Invoice not found.', 404)
  return Res.ok(c, view)
})

const LINE_SCHEMA = z.object({
  freightType: z.enum(FREIGHT_TYPES),
  tier: z.string().min(1),
  quantityLbs: z.number().positive(),
  description: z.string().nullish(),
})

/** POST /api/billing/invoices — create (prices from catalog, assigns the year sequence). */
billing.post(
  '/invoices',
  billingAuth('invoices:write'),
  zValidator(
    'json',
    z.object({
      clientName: z.string().min(1),
      issueDate: z.string().optional(),
      address: z.string().nullish(),
      specialPrice: z.boolean().optional(),
      observations: z.string().nullish(),
      status: z.enum(INVOICE_STATUSES).optional(),
      lines: z.array(LINE_SCHEMA).min(1),
      packageIds: z.array(z.string()).optional(),
    }),
    (r, c) => {
      if (!r.success) return Res.err(c, 'INVALID_BODY', 'clientName and at least one valid line are required.', 422)
    },
  ),
  async (c) => {
    const svc = new BillingService(getBillingRepo(c.env))
    try {
      const view = await svc.createInvoice(c.req.valid('json'), c.get('billingSession').email ?? 'panel', c.get('billingSession').agency)
      return Res.ok(c, view, undefined, 201)
    } catch (e) {
      return fail(c, e)
    }
  },
)

/** POST /api/billing/invoices/:id/payments — record a payment, recompute status. */
billing.post(
  '/invoices/:id/payments',
  billingAuth('invoices:write'),
  zValidator(
    'json',
    z.object({
      method: z.enum(PAYMENT_METHODS),
      bank: z.enum(PAYMENT_BANKS).nullish(),
      currency: z.enum(CURRENCIES),
      amount: z.number().positive(),
      fxRate: z.number().positive().nullish(),
      paidAt: z.string().optional(),
    }),
    (r, c) => {
      if (!r.success) return Res.err(c, 'INVALID_BODY', 'method, currency and a positive amount are required.', 422)
    },
  ),
  async (c) => {
    const svc = new BillingService(getBillingRepo(c.env))
    try {
      return Res.ok(c, await svc.applyPayment(c.req.param('id'), c.req.valid('json'), c.get('billingSession').agency))
    } catch (e) {
      return fail(c, e)
    }
  },
)

/** POST /api/billing/invoices/:id/void — mark VOID (terminal). */
billing.post(
  '/invoices/:id/void',
  billingAuth('invoices:write'),
  zValidator('json', z.object({ reason: z.string().optional() }).optional()),
  async (c) => {
    const svc = new BillingService(getBillingRepo(c.env))
    try {
      const body = c.req.valid('json')
      return Res.ok(c, await svc.voidInvoice(c.req.param('id'), body?.reason, c.get('billingSession').agency))
    } catch (e) {
      return fail(c, e)
    }
  },
)

/** POST /api/billing/invoices/:id/share — get/create the public receipt link. */
billing.post('/invoices/:id/share', billingAuth('invoices:write'), async (c) => {
  const svc = new BillingService(getBillingRepo(c.env))
  try {
    const token = await svc.shareInvoice(c.req.param('id'), c.get('billingSession').agency)
    const origin = new URL(c.req.url).origin
    return Res.ok(c, { token, url: `${origin}/billing/r/${token}` })
  } catch (e) {
    return fail(c, e)
  }
})

/** POST /api/billing/invoices/:id/packages — manually link a package by id or guía. */
billing.post(
  '/invoices/:id/packages',
  billingAuth('invoices:write'),
  zValidator('json', z.object({ packageId: z.string().optional(), guia: z.string().optional() }), (r, c) => {
    if (!r.success) return Res.err(c, 'INVALID_BODY', 'packageId or guia is required.', 422)
  }),
  async (c) => {
    const repo = getBillingRepo(c.env)
    const svc = new BillingService(repo)
    const { packageId, guia } = c.req.valid('json')
    try {
      let pkgId = packageId ?? null
      if (!pkgId && guia) pkgId = await repo.findPackageIdByToken(guia)
      if (!pkgId) return Res.err(c, 'PACKAGE_NOT_FOUND', 'No package matched the given id/guía.', 404)
      return Res.ok(c, await svc.linkPackage(c.req.param('id'), pkgId, c.get('billingSession').email ?? 'panel', c.get('billingSession').agency))
    } catch (e) {
      return fail(c, e)
    }
  },
)

/** DELETE /api/billing/invoices/:id/packages/:packageId — remove a manual/auto link. */
billing.delete('/invoices/:id/packages/:packageId', billingAuth('invoices:write'), async (c) => {
  const svc = new BillingService(getBillingRepo(c.env))
  try {
    return Res.ok(c, await svc.unlinkPackage(c.req.param('id'), c.req.param('packageId'), c.get('billingSession').agency))
  } catch (e) {
    return fail(c, e)
  }
})

/** GET /api/billing/reports?year=2026 — monthly + by-freight revenue/profit for charts. */
billing.get(
  '/reports',
  zValidator('query', z.object({ year: z.coerce.number().int() }), (r, c) => {
    if (!r.success) return Res.err(c, 'INVALID_QUERY', 'year is required.', 422)
  }),
  async (c) => {
    const svc = new BillingService(getBillingRepo(c.env))
    return Res.ok(c, await svc.yearReport(c.req.valid('query').year, c.get('billingSession').agency))
  },
)

/** GET /api/billing/summary?from=&to= — aggregated totals for an arbitrary date range. */
billing.get(
  '/summary',
  zValidator(
    'query',
    z.object({ from: z.string(), to: z.string() }),
    (r, c) => {
      if (!r.success) return Res.err(c, 'INVALID_QUERY', 'from and to (YYYY-MM-DD) are required.', 422)
    },
  ),
  async (c) => {
    const svc = new BillingService(getBillingRepo(c.env))
    const { from, to } = c.req.valid('query')
    return Res.ok(c, await svc.summary(from, to, c.get('billingSession').agency))
  },
)

/** GET /api/billing/exceptions — data-quality queue (off-catalog, quarantined pay, orphans). */
billing.get('/exceptions', async (c) => {
  const svc = new BillingService(getBillingRepo(c.env))
  // Tenant scope: without this, every agency sees every other agency's queue.
  return Res.ok(c, await svc.exceptions(c.get('billingSession').agency))
})

/** GET /api/billing/close-month?year=2026&month=6 — monthly aggregation (replaces TOTAL JUNIO). */
billing.get(
  '/close-month',
  zValidator('query', z.object({ year: z.coerce.number().int(), month: z.coerce.number().int().min(1).max(12) }), (r, c) => {
    if (!r.success) return Res.err(c, 'INVALID_QUERY', 'year and month (1-12) are required.', 422)
  }),
  async (c) => {
    const svc = new BillingService(getBillingRepo(c.env))
    const { year, month } = c.req.valid('query')
    return Res.ok(c, await svc.closeMonth(year, month, c.get('billingSession').agency))
  },
)

export { billing as billingRouter }
