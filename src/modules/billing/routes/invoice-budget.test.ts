import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../../../index.js'

/**
 * Subrequest budget regression: the 2026-10-24 original-express incident — an
 * 11-package invoice died at 3 links because the old create path cost
 * ~8 + 5N subrequests (N=11 → 63, over the 50 free-plan cap). The batched
 * path must stay ~constant, well under the cap, for the same N.
 */

const ctx = { waitUntil() {}, passThroughOnException() {} }
const ENV = { INSFORGE_API_URL: 'https://db.test', INSFORGE_API_KEY: 'admin-key' } as never

afterEach(() => vi.unstubAllGlobals())

const pkg = (i: number) => ({
  id: `pkg-${i}`,
  almacen_id: `g2${String(i).padStart(5, '0')}`,
  tracking_number: `TRK${i}`,
  effective_status: i % 2 === 0 ? 'entregado' : 'en_destino',
  service_type: 'aereo',
  weight_lb: 2,
  client_id: 'c-ana',
  referencia_name: 'Ana',
  organization_id: 'hit',
})

function stubAndCount(transportErrorOn: { method: string; contains: string } | null = null) {
  const calls: { method: string; url: string; body?: string }[] = []
  vi.stubGlobal('fetch', async (input: Request | string, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url
    const method = (init?.method ?? 'GET').toUpperCase()
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? ''
    calls.push({ method, url, body: typeof init?.body === 'string' ? init.body : undefined })
    if (transportErrorOn && method === transportErrorOn.method && url.includes(transportErrorOn.contains)) throw new Error('fetch failed (simulated budget death)')
    if (url.includes('/api/auth/sessions/current')) {
      return auth === 'Bearer tok'
        ? new Response(JSON.stringify({ user: { id: 'u1', email: 'billing@hit.com' } }), { status: 200 })
        : new Response('no', { status: 401 })
    }
    if (url.includes('/records/app_users')) {
      return new Response(JSON.stringify([{ role: 'billing', active: true, name: 'B', email: 'billing@hit.com', agency: 'hit' }]), { status: 201 })
    }
    if (method === 'GET' && url.includes('/records/invoice_packages?') && url.includes('active=eq.true')) {
      // Creation guard: report the packages just POSTed to invoice_packages.
      if (url.includes('invoice_id=eq.')) {
        const linkedPost = [...calls].reverse().find((c) => c.method === 'POST' && c.url.includes('/records/invoice_packages') && c.body)
        if (linkedPost?.body) {
          try {
            const rows = JSON.parse(linkedPost.body) as Array<{ package_id?: string }>
            return new Response(JSON.stringify(rows.filter((r) => r.package_id)), { status: 200 })
          } catch { /* fall through to empty */ }
        }
        return new Response(JSON.stringify([]), { status: 200 })
      }
      // Batched active-link check: none of the fresh packages are invoiced.
      return new Response(JSON.stringify([]), { status: 200 })
    }
    if (method === 'GET' && url.includes('/records/packages?')) {
      return new Response(JSON.stringify(Array.from({ length: 11 }, (_, i) => pkg(i + 1))), { status: 200 })
    }
    if (method === 'GET' && url.includes('/records/billing_clients?')) return new Response(JSON.stringify([{ default_rate_id: null, active: true }]), { status: 200 })
    if (method === 'GET' && url.includes('/records/rate_tables?')) return new Response(JSON.stringify([{ id: 't1', name: 'Estándar', freight_type: 'AIR', rate_rows: [{ tier: 'REGULAR', price: 7, cost: 4.5, price_model: 'weight' }] }]), { status: 200 })
    if (method === 'GET' && url.includes('/records/pricing_catalog?')) return new Response(JSON.stringify([{ freight_type: 'AIR', cost: 4.5, tier_regular: 6.5, tier_especial: 6, tier_vip: 5.5, tier_madres: null, tier_dario: 4.3 }]), { status: 200 })
    if (method === 'GET' && url.includes('/records/payment_methods?')) return new Response(JSON.stringify([]), { status: 200 })
    if (method === 'GET' && url.includes('/records/payment_banks?')) return new Response(JSON.stringify([]), { status: 200 })
    if (method === 'GET' && url.includes('/records/charge_concepts?')) return new Response(JSON.stringify([]), { status: 200 })
    if (method === 'GET' && url.includes('/records/invoices?')) return new Response(JSON.stringify([{ id: 'i-big', invoice_number: 1, fiscal_year: 2026, client_id: 'c-ana', client_name_raw: 'Ana', issue_date: '2026-10-26', status: 'DRAFT', address: null, special_price: false, observations: null, tracking_orders: [], agent_id: null, public_token: null, paid_at: null, total: 154, profit: 55, paid_usd: 0, closed_at: null, closed_by: null, created_at: '', updated_at: '' }]), { status: 200 })
    if (method === 'GET') return new Response(JSON.stringify([]), { status: 200 })
    // POST/PATCH: createInvoiceHeader expects [{ id }], the rest [].
    return new Response(JSON.stringify([{ id: 'i-big' }]), { status: 201 })
  })
  return calls
}

const post = (path: string, body: unknown) =>
  worker.fetch(new Request(`https://t.test${path}`, { method: 'POST', headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), ENV, ctx as never)

describe('createBulkInvoice subrequest budget', () => {
  it('11 packages complete with a constant fetch count far below the 50-subrequest plan cap', async () => {
    const calls = stubAndCount()
    const res = await post('/api/billing/invoices/bulk/create', { packageIds: Array.from({ length: 11 }, (_, i) => `pkg-${i + 1}`) })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.data.status).toBe('DRAFT')

    // Old path: ~8 + 5*11 = 63 fetches (dies at 50). New path is ~constant.
    expect(calls.length).toBeLessThanOrEqual(25)

    // Batching shape: exactly one POST for links, one for package events.
    const linkPosts = calls.filter((c) => c.method === 'POST' && c.url.includes('/records/invoice_packages'))
    expect(linkPosts.length).toBe(1)
    const linkBody = JSON.parse(linkPosts[0].body ?? '[]') as unknown[]
    expect(linkBody).toHaveLength(11)
    const eventPosts = calls.filter((c) => c.method === 'POST' && c.url.includes('/records/events'))
    expect(eventPosts.length).toBe(1)
    const eventBody = JSON.parse(eventPosts[0].body ?? '[]') as unknown[]
    expect(eventBody).toHaveLength(11)
  })

  it('a mid-link transport failure reverts the invoice instead of leaving 3/11 links (incident replay)', async () => {
    const calls = stubAndCount({ method: 'POST', contains: '/records/invoice_packages' })
    const res = await post('/api/billing/invoices/bulk/create', { packageIds: Array.from({ length: 11 }, (_, i) => `pkg-${i + 1}`) })
    // The link POST dies; rollback releases + archives and the response is the
    // typed 422 envelope with the support code — never a half invoice.
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error?.code).toBe('INVOICE_CREATION_REVERTED')
    expect(body.error?.message).toMatch(/Se revirtió automáticamente/)
    const releasePatch = calls.find((c) => c.method === 'PATCH' && c.url.includes('/records/invoice_packages'))
    expect(releasePatch).toBeDefined()
    const archivePatch = calls.find((c) => c.method === 'PATCH' && c.url.includes('/records/invoices?'))
    expect(archivePatch).toBeDefined()
    const auditPost = calls.find((c) => c.method === 'POST' && c.url.includes('/records/audit_logs'))
    expect(auditPost).toBeDefined()
    expect(JSON.parse(auditPost!.body!)[0]).toMatchObject({ action: 'invoice.create_failed' })
    expect(JSON.parse(auditPost!.body!)[0].metadata.support_code).toMatch(/^F-[0-9A-F]{8}$/)
  })
})
