import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import { Res } from '../../../lib/response.js'
import { billingAuth, type BillingEnv } from '../../billing/middleware/auth.js'
import { getCustomerRepo } from '../repo/customer-repo.js'
import { getConfigRepo } from '../../config/repo/config-repo.js'
import { CustomerService } from '../service/customer-service.js'

function fail(c: Parameters<typeof Res.err>[0], e: unknown) {
  const message = e instanceof Error ? e.message : 'Unexpected error.'
  if (/not found/i.test(message)) return Res.err(c, 'NOT_FOUND', message, 404)
  if (/required|duplicate|unique|409/i.test(message)) return Res.err(c, 'INVALID_REQUEST', message, 422)
  return Res.err(c, 'CUSTOMER_ERROR', message, 500)
}

const customer = new Hono<BillingEnv>()
customer.use('*', billingAuth('clients:read'))

customer.get(
  '/clients',
  zValidator('query', z.object({ search: z.string().optional(), toReview: z.enum(['true', 'false']).optional(), page: z.coerce.number().int().positive().optional(), pageSize: z.coerce.number().int().positive().max(100).optional() })),
  async (c) => {
    const query = c.req.valid('query')
    // Tenant scope comes from the session, never from the query string.
    const svc = new CustomerService(getCustomerRepo(c.env))
    return Res.ok(c, await svc.list({ ...query, toReview: query.toReview === undefined ? undefined : query.toReview === 'true', organizationId: c.get('billingSession').agency }))
  },
)

customer.get('/clients/:id', async (c) => {
  const customer = await new CustomerService(getCustomerRepo(c.env)).get(c.req.param('id'), c.get('billingSession').agency)
  return customer ? Res.ok(c, customer) : Res.err(c, 'NOT_FOUND', 'Customer not found.', 404)
})

const CUSTOMER_INPUT = z.object({
  name: z.string().min(1),
  casillero: z.string().nullish(),
  toReview: z.boolean().optional(),
  email: z.string().email().nullish(),
  phone: z.string().max(40).nullish(),
  address: z.string().max(300).nullish(),
  defaultRateTableId: z.string().uuid().nullish(),
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

customer.post('/clients', billingAuth('clients:write'), zValidator('json', CUSTOMER_INPUT), async (c) => {
  try {
    await validateRateTable(c.env, c.get('billingSession').agency, c.req.valid('json').defaultRateTableId)
    return Res.ok(c, await new CustomerService(getCustomerRepo(c.env)).create(c.req.valid('json'), c.get('billingSession').agency), undefined, 201)
  } catch (e) {
    return fail(c, e)
  }
})

customer.patch('/clients/:id', billingAuth('clients:write'), zValidator('json', CUSTOMER_INPUT.partial()), async (c) => {
  try {
    await validateRateTable(c.env, c.get('billingSession').agency, c.req.valid('json').defaultRateTableId)
    const result = await new CustomerService(getCustomerRepo(c.env)).update(c.req.param('id'), c.req.valid('json'), c.get('billingSession').agency)
    return result ? Res.ok(c, result) : Res.err(c, 'NOT_FOUND', 'Customer not found.', 404)
  } catch (e) {
    return fail(c, e)
  }
})

export { customer as customerRouter }
