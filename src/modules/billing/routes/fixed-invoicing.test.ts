import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../../../index.js'

// Stage 6: fixed-package invoicing. The invoice uses the package's STORED
// customer charge (the creation-time snapshot) — never a re-quote, never the
// provider cost, never the profit. Mixing fixed and weight packages in one
// invoice is rejected (one invoice = one pricing kind), and fixed lines carry
// quantity 0 lbs + unit 'package' so weight aggregates stay clean.

const ctx = { waitUntil() {}, passThroughOnException() {} }
const ENV = { INSFORGE_API_URL: 'https://db.test', INSFORGE_API_KEY: 'admin-key' } as never

function fixedPkg(id: string, charge = 25, cost = 8) {
  return {
    id, almacen_id: `g-${id}`, tracking_number: null, effective_status: 'en_destino',
    service_type: 'aereo', effective_service_type: 'aereo', weight_lb: 999, // irrelevant on purpose
    client_id: 'c-ana', referencia_name: 'Ana', organization_id: 'hit',
    pricing_kind: 'fixed', customer_charge: charge, customer_rate: charge, customer_unit: 'package',
    provider_cost: cost, pricing_currency: 'USD',
    rate_card_id: 'card-docs', rate_card_version_id: 'ver-1', rate_card_entry_id: 'ent-air',
  }
}
function weightPkg(id: string) {
  return {
    id, almacen_id: `g-${id}`, tracking_number: null, effective_status: 'en_destino',
    service_type: 'aereo', effective_service_type: 'aereo', weight_lb: 2,
    client_id: 'c-ana', referencia_name: 'Ana', organization_id: 'hit',
    pricing_kind: null, customer_charge: null, customer_rate: null, customer_unit: null,
    provider_cost: null, pricing_currency: null, rate_card_id: null, rate_card_version_id: null, rate_card_entry_id: null,
  }
}

function stubBackend(opts: { packages: unknown[] }) {
  const calls: Array<{ method: string; url: string; body?: string }> = []
  vi.stubGlobal('fetch', async (input: Request | string, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url
    const method = (init?.method ?? 'GET').toUpperCase()
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? ''
    if (url.includes('/api/auth/sessions/current')) {
      return auth === 'Bearer tok' ? new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200 }) : new Response('no', { status: 401 })
    }
    if (url.includes('/records/app_users')) {
      return new Response(JSON.stringify([{ role: 'billing', active: true, name: 'B', email: 'b@hit', agency: 'hit' }]), { status: 200 })
    }
    calls.push({ method, url, body: typeof init?.body === 'string' ? init.body : undefined })
    if (method === 'GET' && url.includes('/records/packages?')) return new Response(JSON.stringify(opts.packages), { status: 200 })
    if (method === 'GET' && url.includes('/records/billing_clients?')) return new Response(JSON.stringify([{ default_rate_id: null, default_rate_card_id: null, active: true }]), { status: 200 })
    if (method === 'GET' && url.includes('/records/rate_tables?')) return new Response(JSON.stringify([]), { status: 200 })
    if (method === 'GET' && url.includes('/records/rate_cards?')) return new Response(JSON.stringify([]), { status: 200 })
    if (method === 'GET' && url.includes('/records/pricing_catalog?')) return new Response(JSON.stringify([{ freight_type: 'AIR', cost: 4.5, tier_regular: 6.5, tier_especial: 6, tier_vip: 5.5, tier_madres: null, tier_dario: 4.3 }]), { status: 200 })
    // Link read-back FIRST: the invoice creation verifies the packages it just
    // POSTed to invoice_packages (the read-back filters active=eq.true too).
    if (method === 'GET' && url.includes('/records/invoice_packages?') && url.includes('invoice_id=eq.')) {
      const linkedPost = [...calls].reverse().find((c) => c.method === 'POST' && c.url.includes('/records/invoice_packages') && c.body)
      if (linkedPost?.body) {
        try {
          const rows = JSON.parse(linkedPost.body) as Array<{ package_id?: string }>
          return new Response(JSON.stringify(rows.filter((r) => r.package_id)), { status: 200 })
        } catch { /* fall through to empty */ }
      }
      return new Response(JSON.stringify([]), { status: 200 })
    }
    if (method === 'GET' && url.includes('/records/invoice_packages?') && url.includes('active=eq.true')) return new Response(JSON.stringify([]), { status: 200 })
    if (method === 'GET' && url.includes('/records/clients') ) return new Response(JSON.stringify([]), { status: 200 })
    if (method === 'GET') return new Response(JSON.stringify([]), { status: 200 })
    return new Response(JSON.stringify([{ id: 'i-fix' }]), { status: 201 })
  })
  return calls
}

afterEach(() => vi.unstubAllGlobals())

const post = (path: string, body: unknown) =>
  worker.fetch(new Request(`https://t.test${path}`, { method: 'POST', headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), ENV, ctx as never)

describe('fixed-package invoicing (bulk)', () => {
  it('preview charges the stored snapshot — weight never participates', async () => {
    stubBackend({ packages: [fixedPkg('pkg-f1'), fixedPkg('pkg-f2', 20, 6)] })
    const res = await post('/api/billing/invoices/bulk/preview', { packageIds: ['pkg-f1', 'pkg-f2'] })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { lines: Array<{ total: number; unitPrice: number; freightCost: number; profit: number }>; total: number; profit: number } }
    expect(body.data.lines[0].total).toBe(25)
    expect(body.data.lines[0].unitPrice).toBe(25)
    expect(body.data.lines[0].freightCost).toBe(8)
    expect(body.data.lines[0].profit).toBe(17)
    expect(body.data.total).toBe(45)
    expect(body.data.profit).toBe(31)
  })

  it('rejects mixing fixed and weight packages (422, Spanish message)', async () => {
    stubBackend({ packages: [fixedPkg('pkg-f1'), weightPkg('pkg-w1')] })
    const res = await post('/api/billing/invoices/bulk/preview', { packageIds: ['pkg-f1', 'pkg-w1'] })
    expect(res.status).toBe(422)
    const body = (await res.json()) as { error?: { message?: string } }
    expect(body.error?.message).toMatch(/cuota fija/)
  })

  it('create writes fixed lines with unit package, 0 lbs and snapshot provenance', async () => {
    const calls = stubBackend({ packages: [fixedPkg('pkg-f1')] })
    const res = await post('/api/billing/invoices/bulk/create', { packageIds: ['pkg-f1'], clientName: 'Ana' })
    expect(res.status).toBe(201)
    const linesPost = calls.find((c) => c.method === 'POST' && c.url.includes('/records/invoice_line_items'))
    expect(linesPost?.body).toBeTruthy()
    const rows = JSON.parse(linesPost!.body!) as Array<{ quantity_lbs: number; unit: string; total: number; pricing_source: string; rate_card_id: string | null }>
    expect(rows[0]).toMatchObject({ quantity_lbs: 0, unit: 'package', total: 25, pricing_source: 'package_snapshot', rate_card_id: 'card-docs' })
  })

  it('a fixed package bills without weight (the snapshot is the only input)', async () => {
    const pkg = fixedPkg('pkg-f1')
    pkg.weight_lb = null
    stubBackend({ packages: [pkg] })
    const res = await post('/api/billing/invoices/bulk/preview', { packageIds: ['pkg-f1'] })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { total: number } }
    expect(body.data.total).toBe(25)
  })
})
