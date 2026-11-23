import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../../../index.js'

// Payment balance guards at the HTTP edge: a payment never exceeds what the
// invoice still owes, NIO is reconciled with the agency rate when no explicit
// rate arrives (it used to be stored with amount_usd NULL and never counted),
// and a fully paid invoice stops accepting payments.

const ctx = { waitUntil() {}, passThroughOnException() {} }
const ENV = { INSFORGE_API_URL: 'https://db.test', INSFORGE_API_KEY: 'admin-key' } as never

afterEach(() => vi.unstubAllGlobals())

/** Closed PARTIAL invoice: total 20, already paid 11 → outstanding 9. */
const partialHeader = {
  id: 'i1', invoice_number: 7, fiscal_year: 2026, client_id: 'c1', client_name_raw: 'Ana',
  issue_date: '2026-09-05', status: 'PARTIAL', address: null, special_price: false, observations: null,
  tracking_orders: [], agent_id: null, public_token: null, paid_at: null,
  total: 20, profit: 6, paid_usd: 11, closed_at: '2026-09-05T10:00:00Z', closed_by: 'ana@hit.com',
  created_at: '', updated_at: '',
}
const line = { id: 'l1', invoice_id: 'i1', line_no: 1, line_type: 'freight', freight_type: 'AIR', total: 20, profit: 6, quantity_lbs: 4 }
const priorPayment = { id: 'p0', invoice_id: 'i1', amount: 11, amount_usd: 11, currency: 'USD', fx_rate: null, method: 'CASH', paid_at: '2026-09-05', quarantined: false }

function stubDb(opts: {
  header?: Record<string, unknown>
  payments?: Array<Record<string, unknown>>
  agency?: Record<string, unknown> | null
} = {}) {
  const calls: { method: string; url: string; body?: string }[] = []
  vi.stubGlobal('fetch', async (input: Request | string, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url
    const method = (init?.method ?? 'GET').toUpperCase()
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? ''
    if (url.includes('/api/auth/sessions/current')) {
      return auth === 'Bearer tok'
        ? new Response(JSON.stringify({ user: { id: 'u1', email: 'billing@hit.com' } }), { status: 200 })
        : new Response('no', { status: 401 })
    }
    if (url.includes('/records/app_users')) {
      return new Response(JSON.stringify([{ role: 'billing', active: true, name: 'B', email: 'billing@hit.com', agency: 'hit' }]), { status: 201 })
    }
    calls.push({ method, url, body: typeof init?.body === 'string' ? init.body : undefined })
    if (method === 'GET' && url.includes('/records/invoices?')) return new Response(JSON.stringify([opts.header ?? partialHeader]), { status: 200 })
    if (method === 'GET' && url.includes('/records/invoice_line_items?')) return new Response(JSON.stringify([line]), { status: 200 })
    if (method === 'GET' && url.includes('/records/invoice_payments?')) return new Response(JSON.stringify(opts.payments ?? [priorPayment]), { status: 200 })
    if (method === 'GET' && url.includes('/records/agencies?')) {
      return new Response(JSON.stringify(opts.agency === undefined ? [{ exchange_rate_nio_per_usd: 36.5 }] : opts.agency === null ? [] : [opts.agency]), { status: 200 })
    }
    if (method === 'GET') return new Response(JSON.stringify([]), { status: 200 })
    if (method === 'PATCH') return new Response(JSON.stringify([{ id: 'i1' }]), { status: 200 })
    return new Response('[]', { status: 201 })
  })
  return calls
}

const pay = (body: unknown) =>
  worker.fetch(
    new Request('https://t.test/api/billing/invoices/i1/payments', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    ENV,
    ctx as never,
  )

describe('POST /api/billing/invoices/:id/payments — balance guard', () => {
  it('422s a payment above the outstanding balance and stores nothing', async () => {
    const calls = stubDb()
    const res = await pay({ method: 'CASH', currency: 'USD', amount: 10 })
    expect(res.status).toBe(422)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('PAYMENT_EXCEEDS_BALANCE')
    expect(body.error.message).toMatch(/saldo pendiente/i)
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/records/invoice_payments'))).toBe(false)
  })

  it('accepts the exact remaining balance and marks the invoice paid', async () => {
    const calls = stubDb()
    const res = await pay({ method: 'CASH', currency: 'USD', amount: 9 })
    expect(res.status).toBe(200)
    const payment = calls.find((c) => c.method === 'POST' && c.url.includes('/records/invoice_payments'))
    expect(JSON.parse(payment!.body!)[0]).toMatchObject({ amount: 9, amount_usd: 9, currency: 'USD' })
    const statusPatch = calls.find((c) => c.method === 'PATCH' && c.url.includes('/records/invoices?'))
    expect(JSON.parse(statusPatch!.body!)).toMatchObject({ status: 'PAID' })
  })

  it('422s a payment on an invoice with no balance left', async () => {
    const calls = stubDb({ header: { ...partialHeader, status: 'PAID', paid_usd: 20 } })
    const res = await pay({ method: 'CASH', currency: 'USD', amount: 5 })
    expect(res.status).toBe(422)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('INVOICE_ALREADY_PAID')
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/records/invoice_payments'))).toBe(false)
  })
})

describe('POST /api/billing/invoices/:id/payments — NIO reconciliation', () => {
  it('converts NIO with the agency exchange rate when no explicit rate is sent', async () => {
    const calls = stubDb({ agency: { exchange_rate_nio_per_usd: 36.5 } })
    // 9 USD × 36.5 = 328.5 NIO → exactly the remaining balance.
    const res = await pay({ method: 'TRANSFER', currency: 'NIO', amount: 328.5 })
    expect(res.status).toBe(200)
    const payment = calls.find((c) => c.method === 'POST' && c.url.includes('/records/invoice_payments'))
    expect(JSON.parse(payment!.body!)[0]).toMatchObject({ amount: 328.5, amount_usd: 9, fx_rate: 36.5, currency: 'NIO' })
  })

  it('422s NIO when neither an explicit nor an agency rate exists', async () => {
    const calls = stubDb({ agency: null })
    const res = await pay({ method: 'CASH', currency: 'NIO', amount: 100 })
    expect(res.status).toBe(422)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('EXCHANGE_RATE_REQUIRED')
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/records/invoice_payments'))).toBe(false)
  })

  it('rejects a NIO amount whose USD equivalent exceeds the balance', async () => {
    const calls = stubDb({ agency: { exchange_rate_nio_per_usd: 36.5 } })
    // 400 NIO = 10.96 USD > 9 USD outstanding.
    const res = await pay({ method: 'CASH', currency: 'NIO', amount: 400 })
    expect(res.status).toBe(422)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('PAYMENT_EXCEEDS_BALANCE')
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/records/invoice_payments'))).toBe(false)
  })
})
