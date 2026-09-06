import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../../../index.js'

// Financial lock wiring at the HTTP edge: POST /invoices/:id/close must be
// org-scoped, must persist closed_at/closed_by through the compare-and-set,
// must 422 on a double close, and payments on an OPEN invoice must be rejected
// with 422 (not 500) so the panel can render "cerrá primero".

const ctx = { waitUntil() {}, passThroughOnException() {} }
const ENV = { INSFORGE_API_URL: 'https://db.test', INSFORGE_API_KEY: 'admin-key' } as never

afterEach(() => vi.unstubAllGlobals())

const openHeader = {
  id: 'i1', invoice_number: 7, fiscal_year: 2026, client_id: 'c1', client_name_raw: 'Ana',
  issue_date: '2026-09-05', status: 'DRAFT', address: null, special_price: false, observations: null,
  tracking_orders: [], agent_id: null, public_token: null, paid_at: null,
  total: 6.5, profit: 2, paid_usd: 0, closed_at: null, closed_by: null,
  created_at: '', updated_at: '',
}
const closedHeader = { ...openHeader, status: 'ISSUED', closed_at: '2026-09-05T10:00:00Z', closed_by: 'ana@hit.com' }

function stubDb(header: Record<string, unknown>, opts: { closeWins?: boolean } = {}) {
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
    if (method === 'GET' && url.includes('/records/invoices?')) return new Response(JSON.stringify([header]), { status: 200 })
    if (method === 'GET') return new Response(JSON.stringify([]), { status: 200 })
    if (method === 'PATCH') return new Response(JSON.stringify(opts.closeWins === false ? [] : [{ id: 'i1' }]), { status: 200 })
    return new Response('[]', { status: 201 })
  })
  return calls
}

const post = (path: string, body?: unknown) =>
  worker.fetch(new Request(`https://t.test${path}`, { method: 'POST', headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), ENV, ctx as never)

describe('POST /api/billing/invoices/:id/close', () => {
  it('closes an open DRAFT via the guarded org-scoped PATCH and logs the event', async () => {
    const calls = stubDb(openHeader)
    const res = await post('/api/billing/invoices/i1/close')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    const patch = calls.find((c) => c.method === 'PATCH' && c.url.includes('/records/invoices?'))
    expect(patch?.url).toContain('organization_id=eq.hit')
    expect(patch?.url).toContain('closed_at=is.null')
    expect(JSON.parse(patch!.body!)).toMatchObject({ status: 'ISSUED', closed_by: 'billing@hit.com' })
    const event = calls.find((c) => c.method === 'POST' && c.url.includes('/records/invoice_events'))
    expect(event?.body).toContain('Factura cerrada')
    expect(event?.body).toContain('hit')
  })
  it('422s a double close (already closed in DB)', async () => {
    stubDb(closedHeader)
    const res = await post('/api/billing/invoices/i1/close')
    expect(res.status).toBe(422)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INVALID_REQUEST')
  })
  it('422s when the compare-and-set loses to a concurrent writer', async () => {
    stubDb(openHeader, { closeWins: false })
    const res = await post('/api/billing/invoices/i1/close')
    expect(res.status).toBe(422)
  })
  it('404s an invoice outside the session agency (org filter, not just guard)', async () => {
    const calls = stubDb(openHeader)
    stubGlobalFetchEmptyOtherOrg(calls)
    const res = await post('/api/billing/invoices/i1/close')
    expect(res.status).toBe(404)
  })
})

describe('payments respect the lock', () => {
  it('422s a payment while the invoice is open (close-first rule)', async () => {
    const calls = stubDb(openHeader)
    const res = await post('/api/billing/invoices/i1/payments', { method: 'CASH', currency: 'USD', amount: 5 })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/Close the invoice/i)
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/records/invoice_payments'))).toBe(false)
  })
  it('accepts a payment on a closed invoice (the lock only gates the before)', async () => {
    const calls = stubDb(closedHeader)
    const res = await post('/api/billing/invoices/i1/payments', { method: 'CASH', currency: 'USD', amount: 5 })
    expect(res.status).toBe(200)
    const pay = calls.find((c) => c.method === 'POST' && c.url.includes('/records/invoice_payments'))
    expect(JSON.parse(pay!.body!)[0]).toMatchObject({ amount: 5, amount_usd: 5, organization_id: 'hit' })
  })
})

// The 404 case: same URL shapes, but the org-scoped GET finds nothing.
function stubGlobalFetchEmptyOtherOrg(calls: { method: string; url: string; body?: string }[]) {
  vi.stubGlobal('fetch', async (input: Request | string, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url
    const method = (init?.method ?? 'GET').toUpperCase()
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? ''
    if (url.includes('/api/auth/sessions/current')) {
      return auth === 'Bearer tok' ? new Response(JSON.stringify({ user: { id: 'u1', email: 'billing@hit.com' } }), { status: 200 }) : new Response('no', { status: 401 })
    }
    if (url.includes('/records/app_users')) {
      return new Response(JSON.stringify([{ role: 'billing', active: true, name: 'B', email: 'billing@hit.com', agency: 'solo-guegue' }]), { status: 201 })
    }
    calls.push({ method, url, body: typeof init?.body === 'string' ? init.body : undefined })
    if (method === 'GET') return new Response(JSON.stringify([]), { status: 200 })
    return new Response('[]', { status: 201 })
  })
}
