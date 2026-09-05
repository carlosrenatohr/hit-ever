import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../../../index.js'

// Regression: /api/billing/exceptions must scope EVERY underlying query to the
// session agency. It originally shipped unfiltered (the only billing route that
// skipped the org), leaking other agencies' queues. If this test fails, a
// getExceptions sub-query lost its organization_id filter.

const ctx = { waitUntil() {}, passThroughOnException() {} }
const ENV = { INSFORGE_API_URL: 'https://db.test', INSFORGE_API_KEY: 'admin-key' } as never

afterEach(() => vi.unstubAllGlobals())

describe('GET /api/billing/exceptions — tenant scope', () => {
  it('scopes every underlying query to the session agency', async () => {
    const queried: string[] = []
    vi.stubGlobal('fetch', async (input: Request | string, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.url
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? ''
      if (url.includes('/api/auth/sessions/current')) {
        return auth === 'Bearer goodToken'
          ? new Response(JSON.stringify({ user: { id: 'u1', email: 'u1@test' } }), { status: 200 })
          : new Response('unauthorized', { status: 401 })
      }
      if (url.includes('/api/database/records/app_users')) {
        return new Response(JSON.stringify([{ role: 'staff', active: true, agency: 'solo-guegue' }]), { status: 200 })
      }
      if (url.includes('/api/database/records/')) {
        queried.push(url)
        return new Response(JSON.stringify([]), { status: 200 })
      }
      return new Response('not found', { status: 404 })
    })

    const res = await worker.fetch(new Request('https://t.test/api/billing/exceptions', { headers: { Authorization: 'Bearer goodToken' } }), ENV, ctx as never)
    expect(res.status).toBe(200)

    const tables = queried.map((u) => {
      const path = u.split('/api/database/records/')[1] ?? ''
      return { table: path.split('?')[0], url: u }
    })
    const EXPECTED = ['invoice_line_items', 'invoice_payments', 'invoices', 'invoice_packages', 'billing_clients']
    for (const table of EXPECTED) {
      const hits = tables.filter((t) => t.table === table)
      expect(hits.length, `expected a query against ${table}`).toBeGreaterThan(0)
      for (const hit of hits) {
        expect(hit.url, `${table} query must be org-scoped`).toContain('organization_id=eq.solo-guegue')
      }
    }
  })
})
