import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import { Res } from '../../../lib/response.js'
import { billingAuth, type BillingEnv } from '../../billing/middleware/auth.js'
import { getCustomerRepo } from '../repo/customer-repo.js'
import { getConfigRepo } from '../../config/repo/config-repo.js'
import { CustomerService, type CustomerActor } from '../service/customer-service.js'
import type { CustomerStatus } from '../domain/types.js'

function fail(c: Parameters<typeof Res.err>[0], e: unknown) {
  const message = e instanceof Error ? e.message : 'Unexpected error.'
  if (/not found/i.test(message)) return Res.err(c, 'NOT_FOUND', message, 404)
  if (/required|duplicate|unique|409/i.test(message)) return Res.err(c, 'INVALID_REQUEST', message, 422)
  return Res.err(c, 'CUSTOMER_ERROR', message, 500)
}

const CUSTOMER_STATUSES: CustomerStatus[] = ['active', 'inactive', 'review']

/** Parses a comma-separated `status` query (active,inactive,review) into typed values. */
function parseStatuses(raw: string | undefined): CustomerStatus[] | undefined {
  if (!raw) return undefined
  const statuses = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is CustomerStatus => (CUSTOMER_STATUSES as string[]).includes(s))
  return statuses.length ? statuses : undefined
}

function actorOf(c: Context<BillingEnv>): CustomerActor {
  const session = c.get('billingSession')
  return { userId: session.userId, email: session.email }
}

const customer = new Hono<BillingEnv>()
customer.use('*', billingAuth('clients:read'))

customer.get(
  '/clients',
  zValidator('query', z.object({ search: z.string().optional(), status: z.string().optional(), toReview: z.enum(['true', 'false']).optional(), page: z.coerce.number().int().positive().optional(), pageSize: z.coerce.number().int().positive().max(100).optional() })),
  async (c) => {
    const query = c.req.valid('query')
    // Tenant scope comes from the session, never from the query string.
    const svc = new CustomerService(getCustomerRepo(c.env))
    return Res.ok(
      c,
      await svc.list({
        search: query.search,
        statuses: parseStatuses(query.status),
        toReview: query.toReview === undefined ? undefined : query.toReview === 'true',
        organizationId: c.get('billingSession').agency,
        page: query.page,
        pageSize: query.pageSize,
      }),
    )
  },
)

customer.get('/clients/:id', async (c) => {
  const customer = await new CustomerService(getCustomerRepo(c.env)).get(c.req.param('id'), c.get('billingSession').agency)
  return customer ? Res.ok(c, customer) : Res.err(c, 'NOT_FOUND', 'Customer not found.', 404)
})

/** GET /api/customer/clients/:id/delete-preview — impact summary for the delete dialog.
 *  Counts + capped samples of the client's packages and invoices. Read-only. */
customer.get('/clients/:id/delete-preview', billingAuth('clients:write'), async (c) => {
  const preview = await new CustomerService(getCustomerRepo(c.env)).deletePreview(c.req.param('id'), c.get('billingSession').agency)
  return preview ? Res.ok(c, preview) : Res.err(c, 'NOT_FOUND', 'Customer not found.', 404)
})

/** DELETE /api/customer/clients/:id — soft delete (never physical): sets deleted_at,
 *  hides the client from operational reads, preserves packages/invoices links, audits. */
customer.delete('/clients/:id', billingAuth('clients:write'), async (c) => {
  try {
    let reason: string | null = null
    const ct = c.req.header('content-type') ?? ''
    if (ct.includes('application/json')) {
      const body = (await c.req.json().catch(() => null)) as { reason?: unknown } | null
      if (body?.reason !== undefined) {
        if (typeof body.reason !== 'string' || body.reason.length > 300) {
          return Res.err(c, 'INVALID_BODY', 'reason must be a string up to 300 chars.', 422)
        }
        reason = body.reason.trim() || null
      }
    }
    const requestId = c.req.header('x-request-id') ?? crypto.randomUUID()
    const result = await new CustomerService(getCustomerRepo(c.env)).delete(
      c.req.param('id'),
      c.get('billingSession').agency,
      actorOf(c),
      requestId,
      reason,
    )
    return Res.ok(c, result)
  } catch (e) {
    return fail(c, e)
  }
})

const CUSTOMER_INPUT = z.object({
  name: z.string().min(1),
  casillero: z.string().nullish(),
  toReview: z.boolean().optional(),
  email: z.string().email().nullish(),
  phone: z.string().max(40).nullish(),
  address: z.string().max(300).nullish(),
  companyName: z.string().max(120).nullish(),
  taxId: z.string().max(40).nullish(),
  active: z.boolean().optional(),
  defaultRateTableId: z.string().uuid().nullish(),
  defaultRateCardId: z.string().uuid().nullish(),
})

/** The default rate table must exist within the caller's agency — a foreign id
 * (or one from another agency) is rejected instead of silently stored. */
async function validateRateTable(env: never, agency: string, rateTableId: string | null | undefined) {
  if (!rateTableId) return
  const table = await getConfigRepo(env).getRateTable(rateTableId)
  if (!table || table.organizationId !== agency) {
    throw new Error('rate table not found in your agency')
  }
}

/** The default rate card (v2 plan) must belong to the caller's agency. */
async function validateRateCard(env: never, agency: string, rateCardId: string | null | undefined) {
  if (!rateCardId) return
  const card = await getConfigRepo(env).getRateCard(rateCardId)
  if (!card || card.organizationId !== agency) {
    throw new Error('rate card not found in your agency')
  }
}

customer.post('/clients', billingAuth('clients:write'), zValidator('json', CUSTOMER_INPUT), async (c) => {
  try {
    const input = c.req.valid('json')
    await validateRateTable(c.env, c.get('billingSession').agency, input.defaultRateTableId)
    await validateRateCard(c.env, c.get('billingSession').agency, input.defaultRateCardId)
    const requestId = c.req.header('x-request-id') ?? crypto.randomUUID()
    return Res.ok(c, await new CustomerService(getCustomerRepo(c.env)).create(input, c.get('billingSession').agency, actorOf(c), requestId), undefined, 201)
  } catch (e) {
    return fail(c, e)
  }
})

customer.patch('/clients/:id', billingAuth('clients:write'), zValidator('json', CUSTOMER_INPUT.partial()), async (c) => {
  try {
    const input = c.req.valid('json')
    await validateRateTable(c.env, c.get('billingSession').agency, input.defaultRateTableId)
    await validateRateCard(c.env, c.get('billingSession').agency, input.defaultRateCardId)
    const requestId = c.req.header('x-request-id') ?? crypto.randomUUID()
    const result = await new CustomerService(getCustomerRepo(c.env)).update(c.req.param('id'), input, c.get('billingSession').agency, actorOf(c), requestId)
    return result ? Res.ok(c, result) : Res.err(c, 'NOT_FOUND', 'Customer not found.', 404)
  } catch (e) {
    return fail(c, e)
  }
})

export { customer as customerRouter }