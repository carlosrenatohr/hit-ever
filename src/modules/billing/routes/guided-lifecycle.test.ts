import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../../../index.js'

// ============================================================================
// E2E (HTTP layer) — guided invoice lifecycle plan.
// Exercises the real billing router + auth against a stubbed InsForge backend:
//   1. POST /api/billing/invoices with a freight line carrying packageId
//      → DRAFT + line snapshot + package link + package event.
//   2. POST /invoices/:id/close → ISSUED + "cerrada" package event.
//   3. GET /clients/:clientId/unbilled-packages → eligible + reasons.
// ============================================================================

const ctx = { waitUntil() {}, passThroughOnException() {} }
const ENV = { INSFORGE_API_URL: 'https://db.test', INSFORGE_API_KEY: 'admin-key' } as never

afterEach(() => vi.unstubAllGlobals())

function stubBackend(opts: { packages?: unknown[]; activeLinks?: Record<string, string>; linkedPackages?: unknown[] } = {}) {
  const calls: { method: string; url: string; body?: string }[] = []
  const header = {
    id: 'i-g', invoice_number: 1, fiscal_year: 2026, client_id: 'c-ana', client_name_raw: 'Ana',
    issue_date: '2026-09-06', status: 'DRAFT', address: null, special_price: false, observations: null,
    tracking_orders: [], agent_id: null, public_token: null, paid_at: null, total: 14, profit: 5, paid_usd: 0,
    closed_at: null, closed_by: null, created_at: '', updated_at: '',
  }
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
    if (method === 'GET' && url.includes('/records/invoice_packages?') && url.includes('active=eq.true')) {
      const m = url.match(/package_id=eq\.([^&]+)/)
      if (m) {
        const invoiceId = opts.activeLinks?.[decodeURIComponent(m[1])]
        if (invoiceId) return new Response(JSON.stringify([{ invoice_id: invoiceId }]), { status: 200 })
      }
      return new Response(JSON.stringify([]), { status: 200 })
    }
    if (method === 'GET' && url.includes('/records/invoice_packages?')) {
      return new Response(JSON.stringify(opts.linkedPackages ?? []), { status: 200 })
    }
    if (method === 'GET' && url.includes('/records/invoice_line_items?')) return new Response(JSON.stringify([]), { status: 200 })
    if (method === 'GET' && url.includes('/records/invoice_payments?')) return new Response(JSON.stringify([]), { status: 200 })
    if (method === 'GET' && url.includes('/records/packages?')) return new Response(JSON.stringify(opts.packages ?? []), { status: 200 })
    if (method === 'GET' && url.includes('/records/billing_clients?')) return new Response(JSON.stringify([{ default_rate_id: null, active: true }]), { status: 200 })
    if (method === 'GET' && url.includes('/records/rate_tables?')) return new Response(JSON.stringify([{ id: 't1', name: 'Estándar', freight_type: 'AIR', rate_rows: [{ tier: 'REGULAR', price: 7, cost: 4.5, price_model: 'weight' }] }]), { status: 200 })
    if (method === 'GET' && url.includes('/records/pricing_catalog?')) return new Response(JSON.stringify([{ freight_type: 'AIR', cost: 4.5, tier_regular: 6.5, tier_especial: 6, tier_vip: 5.5, tier_madres: null, tier_dario: 4.3 }]), { status: 200 })
    if (method === 'GET' && url.includes('/records/invoices?')) return new Response(JSON.stringify([header]), { status: 200 })
    if (method === 'GET') return new Response(JSON.stringify([]), { status: 200 })
    if (method === 'POST' && url.includes('/records/billing_clients')) return new Response(JSON.stringify([{ id: 'c-ana' }]), { status: 201 })
    return new Response(JSON.stringify([{ id: 'i-g' }]), { status: 201 })
  })
  return calls
}

const call = (path: string, init?: RequestInit) =>
  worker.fetch(new Request(`https://t.test${path}`, init ?? {}), ENV, ctx as never)
const authed = (path: string, init?: RequestInit) =>
  call(path, { ...init, headers: { Authorization: 'Bearer tok', ...(init?.headers ?? {}) } })
const postJson = (path: string, body: unknown) =>
  authed(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

const ANA_PKG = {
  id: 'c67d6a4d-1c40-41e3-9122-a03d2a8c1203', almacen_id: 'g123456', tracking_number: 'TRK1', effective_status: 'en_destino',
  service_type: 'aereo', weight_lb: 2, client_id: 'c-ana', referencia_name: 'Ana', organization_id: 'hit',
}

describe('E2E — guided invoice lifecycle', () => {
  it('creates a DRAFT from a package-linked freight line, snapshoting guía/tracking and emitting events', async () => {
    const calls = stubBackend({ packages: [ANA_PKG] })
    const res = await postJson('/api/billing/invoices', {
      clientName: 'Ana',
      status: 'DRAFT',
      lines: [{ freightType: 'AIR', tier: 'REGULAR', quantityLbs: 2, packageId: 'c67d6a4d-1c40-41e3-9122-a03d2a8c1203' }],
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { data: { status: string; closedAt: string | null } }
    expect(body.data.status).toBe('DRAFT')
    expect(body.data.closedAt).toBeNull()
    const line = calls.find((c) => c.method === 'POST' && c.url.includes('/records/invoice_line_items'))
    expect(line).toBeDefined()
    expect(JSON.parse(line!.body!)[0]).toMatchObject({ package_id: 'c67d6a4d-1c40-41e3-9122-a03d2a8c1203', package_guia: 'g123456', package_tracking: 'TRK1' })
    const links = calls.filter((c) => c.method === 'POST' && c.url.includes('/records/invoice_packages'))
    expect(links.length).toBeGreaterThan(0)
    const pkgEvent = calls.find((c) => c.method === 'POST' && c.url.includes('/records/events'))
    expect(JSON.parse(pkgEvent!.body!)[0].description).toMatch(/Factura #\d+ generada/)
  })

  it('closes the DRAFT, promoting it to ISSUED and writing a closed event onto the linked package', async () => {
    const calls = stubBackend({
      packages: [ANA_PKG],
      linkedPackages: [
        { id: 'lk1', invoice_id: 'i-g', package_id: 'c67d6a4d-1c40-41e3-9122-a03d2a8c1203', source: 'manual', matched_oc: 'g123456', active: true, packages: { almacen_id: 'g123456', tracking_number: 'TRK1' } },
      ],
    })
    const res = await postJson('/api/billing/invoices/i-g/close', {})
    expect(res.status).toBe(200)
    const closePatch = calls.find((c) => c.method === 'PATCH' && c.url.includes('/records/invoices?') && c.url.includes('status=eq.DRAFT'))
    expect(closePatch).toBeDefined()
    expect(JSON.parse(closePatch!.body!).status).toBe('ISSUED')
    const pkgEvent = calls.find((c) => c.method === 'POST' && c.url.includes('/records/events'))
    expect(JSON.parse(pkgEvent!.body!)[0].description).toBe('Factura #1 cerrada')
  })
})

describe('E2E — unbilled packages by client', () => {
  it('lists eligible and ineligible packages with reasons for the guided flow', async () => {
    const calls = stubBackend({ packages: [ANA_PKG, { ...ANA_PKG, id: 'pkg-2', almacen_id: 'g654321' }], activeLinks: { 'pkg-2': 'inv-9' } })
    const res = await authed('/api/billing/clients/c-ana/unbilled-packages')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { packages: Array<{ guia: string; eligible: boolean; reason: string | null }> } }
    expect(body.data.packages.map((p) => ({ guia: p.guia, eligible: p.eligible, reason: p.reason }))).toEqual([
      { guia: 'g123456', eligible: true, reason: null },
      { guia: 'g654321', eligible: false, reason: 'Ya facturado' },
    ])
    // Soft-deleted packages must never appear in the unbilled list.
    const pkgCall = calls.find((c) => c.method === 'GET' && c.url.includes('/records/packages?'))
    expect(pkgCall?.url).toContain('deleted_at=is.null')
  })
})