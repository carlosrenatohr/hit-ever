import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../../../index.js'

// Regression: /api/billing/invoice-links was gated by `reports:read` only. Admins
// (and billing/staff) have `invoices:read` but NOT `reports:read`, so the package
// list got a 403, swallowed it, and kept rendering the paid icon orange forever.

const ctx = { waitUntil() {}, passThroughOnException() {} }
const ENV = { INSFORGE_API_URL: 'https://db.test', INSFORGE_API_KEY: 'admin-key' } as never
const PKG = '11111111-2222-3333-4444-555555555555'

afterEach(() => vi.unstubAllGlobals())

function stub(role: string, captured: string[] = []) {
  vi.stubGlobal('fetch', async (input: Request | string) => {
    const url = typeof input === 'string' ? input : input.url
    if (url.includes('/api/auth/sessions/current')) {
      return new Response(JSON.stringify({ user: { id: 'u1', email: 'u1@test' } }), { status: 200 })
    }
    if (url.includes('/api/database/records/app_users')) {
      return new Response(JSON.stringify([{ role, active: true, agency: 'suite' }]), { status: 200 })
    }
    if (url.includes('/api/database/records/invoice_packages')) {
      captured.push(url)
      return new Response(
        JSON.stringify([{ package_id: PKG, invoice_id: 'inv-1', invoices: { status: 'PAID' } }]),
        { status: 200 },
      )
    }
    return new Response('not found', { status: 404 })
  })
}

function call(path: string): Promise<Response> {
  return worker.fetch(
    new Request(`https://t.test${path}`, { headers: { Authorization: 'Bearer goodToken' } }),
    ENV,
    ctx as never,
  )
}

describe('GET /api/billing/invoice-links — role gate', () => {
  for (const role of ['admin', 'billing', 'staff', 'viewer']) {
    it(`${role} gets the paid status`, async () => {
      const captured: string[] = []
      stub(role, captured)
      const res = await call(`/api/billing/invoice-links?ids=${PKG}`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { data: { links: Array<{ status: string }> } }
      expect(body.data.links[0]?.status).toBe('PAID')
      // Tenant scope still pinned to the session agency.
      expect(captured[0]).toContain('organization_id=eq.suite')
    })
  }

  it('rejects non-UUID ids before hitting the database', async () => {
    const captured: string[] = []
    stub('admin', captured)
    const res = await call('/api/billing/invoice-links?ids=not-a-uuid')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { links: unknown[] } }
    expect(body.data.links).toEqual([])
    expect(captured).toHaveLength(0)
  })

  it('/linked-packages opens with invoices:read too', async () => {
    stub('admin')
    const res = await call('/api/billing/linked-packages')
    expect(res.status).toBe(200)
  })
})
