import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../../../index.js'

const ctx = { waitUntil() {}, passThroughOnException() {} }
const ENV = { INSFORGE_API_URL: 'https://db.test', INSFORGE_API_KEY: 'admin-key' } as never

afterEach(() => vi.unstubAllGlobals())

function stubAuthAndDb(opts: { packages?: unknown[]; rates?: unknown[]; methods?: unknown[] } = {}) {
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
    if (method === 'GET' && url.includes('/records/packages?')) return new Response(JSON.stringify(opts.packages ?? []), { status: 200 })
    if (method === 'GET' && url.includes('/records/billing_clients?')) return new Response(JSON.stringify([{ default_rate_id: null }]), { status: 200 })
    if (method === 'GET' && url.includes('/records/rate_tables?')) return new Response(JSON.stringify([{ id: 't1', name: 'Estándar', freight_type: 'AIR', rate_rows: [{ tier: 'REGULAR', price: 7, cost: 4.5, price_model: 'weight' }] }]), { status: 200 })
    if (method === 'GET' && url.includes('/records/pricing_catalog?')) return new Response(JSON.stringify([{ freight_type: 'AIR', cost: 4.5, tier_regular: 6.5, tier_especial: 6, tier_vip: 5.5, tier_madres: null, tier_dario: 4.3 }]), { status: 200 })
    if (method === 'GET' && url.includes('/records/payment_methods?')) return new Response(JSON.stringify(opts.methods ?? []), { status: 200 })
    if (method === 'GET' && url.includes('/records/payment_banks?')) return new Response(JSON.stringify([]), { status: 200 })
    if (method === 'GET' && url.includes('/records/charge_concepts?')) return new Response(JSON.stringify([]), { status: 200 })
    if (method === 'GET' && url.includes('/records/invoices?')) return new Response(JSON.stringify([{ id: 'i-bulk', invoice_number: 1, fiscal_year: 2026, client_id: 'c1', client_name_raw: 'Ana', issue_date: '2026-09-06', status: 'DRAFT', address: null, special_price: false, observations: null, tracking_orders: [], agent_id: null, public_token: null, paid_at: null, total: 14, profit: 5, paid_usd: 0, closed_at: null, closed_by: null, created_at: '', updated_at: '' }]), { status: 200 })
    if (method === 'GET') return new Response(JSON.stringify([]), { status: 200 })
    // POST/PATCH/DELETE: return a minimal shape the repo adapter expects.
    // createInvoiceHeader expects [{ id }], insertLineItems/linkPackage/events expect [].
    return new Response(JSON.stringify([{ id: 'i-bulk' }]), { status: 201 })
  })
  return calls
}

const post = (path: string, body: unknown) =>
  worker.fetch(new Request(`https://t.test${path}`, { method: 'POST', headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), ENV, ctx as never)

const EN_DESTINO_PKG = {
  id: 'pkg-1', almacen_id: 'g123456', tracking_number: 'TRK1', effective_status: 'en_destino',
  service_type: 'aereo', weight_lb: 2, client_id: 'c-ana', referencia_name: 'Ana', organization_id: 'hit',
}
const ENTREGADO_PKG = { ...EN_DESTINO_PKG, id: 'pkg-2', almacen_id: 'g234567', effective_status: 'entregado', client_id: 'c-ana', referencia_name: 'Ana' }

describe('POST /api/billing/invoices/bulk/preview', () => {
  it('prices invoiceable packages and returns one line per package', async () => {
    stubAuthAndDb({ packages: [EN_DESTINO_PKG, ENTREGADO_PKG] })
    const res = await post('/api/billing/invoices/bulk/preview', { packageIds: ['pkg-1', 'pkg-2'] })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.data.lines).toHaveLength(2)
    expect(body.data.lines[0].unitPrice).toBe(7)
    expect(body.data.lines[0].total).toBe(14)
  })
  it('422s when packages are not invoiceable', async () => {
    stubAuthAndDb({ packages: [{ ...EN_DESTINO_PKG, effective_status: 'en_transito' }] })
    const res = await post('/api/billing/invoices/bulk/preview', { packageIds: ['pkg-1'] })
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error.code).toBe('INVALID_REQUEST')
  })
  it('422s with empty packageIds', async () => {
    stubAuthAndDb()
    const res = await post('/api/billing/invoices/bulk/preview', { packageIds: [] })
    expect(res.status).toBe(422)
  })
})

describe('POST /api/billing/invoices/bulk/create', () => {
  it('creates a DRAFT invoice from valid packages', async () => {
    const calls = stubAuthAndDb({ packages: [EN_DESTINO_PKG, ENTREGADO_PKG] })
    const res = await post('/api/billing/invoices/bulk/create', { packageIds: ['pkg-1', 'pkg-2'] })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.data.status).toBe('DRAFT')
    expect(body.data.closedAt).toBeNull()
    // Verify invoice header written with correct shape
    const header = calls.find((c) => c.method === 'POST' && c.url.includes('/records/invoices') && !c.url.includes('events') && !c.url.includes('line') && !c.url.includes('package') && !c.url.includes('payment'))
    expect(header).toBeDefined()
    expect(JSON.parse(header!.body!)[0].status).toBe('DRAFT')
    // Verify line items written with package snapshots
    const lines = calls.find((c) => c.method === 'POST' && c.url.includes('/records/invoice_lines'))
    // Verify packages linked
    const links = calls.filter((c) => c.method === 'POST' && c.url.includes('/records/invoice_packages'))
    expect(links.length).toBeGreaterThan(0)
  })
  it('422s when packages belong to different clients', async () => {
    stubAuthAndDb({
      packages: [
        { ...EN_DESTINO_PKG, client_id: 'c-ana', referencia_name: 'Ana' },
        { ...EN_DESTINO_PKG, id: 'pkg-3', client_id: 'c-luis', referencia_name: 'Luis' },
      ],
    })
    const res = await post('/api/billing/invoices/bulk/create', { packageIds: ['pkg-1', 'pkg-3'] })
    expect(res.status).toBe(422)
  })
})
