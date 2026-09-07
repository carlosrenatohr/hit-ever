import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../../../index.js'

const ctx = { waitUntil() {}, passThroughOnException() {} }
const ENV = { INSFORGE_API_URL: 'https://db.test', INSFORGE_API_KEY: 'admin-key' } as never

afterEach(() => vi.unstubAllGlobals())

const draftHeader = {
  id: 'i1', invoice_number: 7, fiscal_year: 2026, client_id: 'c1', client_name_raw: 'Ana',
  issue_date: '2026-09-05', status: 'DRAFT', address: null, special_price: false, observations: null,
  tracking_orders: [], agent_id: null, public_token: null, paid_at: null,
  total: 6.5, profit: 2, paid_usd: 0, closed_at: null, closed_by: null,
  created_at: '', updated_at: '', organization_id: 'hit',
}
const closedHeader = { ...draftHeader, status: 'ISSUED', closed_at: '2026-09-05T10:00:00Z', closed_by: 'ana@hit.com' }
const voidHeader = { ...draftHeader, status: 'VOID', closed_at: '2026-09-05T10:00:00Z', closed_by: 'ana@hit.com' }

function stubDb(header: Record<string, unknown>) {
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
    if (method === 'GET' && url.includes('/records/rate_tables?')) return new Response(JSON.stringify([{ id: 't1', name: 'Estándar', freight_type: 'AIR', rate_rows: [{ tier: 'REGULAR', price: 7, cost: 4.5, price_model: 'weight' }] }]), { status: 200 })
    if (method === 'GET' && url.includes('/records/billing_clients?')) return new Response(JSON.stringify([{ default_rate_id: null }]), { status: 200 })
    if (method === 'GET') return new Response(JSON.stringify([]), { status: 200 })
    if (method === 'PATCH') return new Response(JSON.stringify([{ id: 'i1' }]), { status: 200 })
    return new Response('[]', { status: 201 })
  })
  return calls
}

const patch = (path: string, body: unknown) =>
  worker.fetch(new Request(`https://t.test${path}`, { method: 'PATCH', headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), ENV, ctx as never)

describe('PATCH /api/billing/invoices/:id', () => {
  it('edits an open DRAFT invoice (observations + issueDate)', async () => {
    const calls = stubDb(draftHeader)
    const res = await patch('/api/billing/invoices/i1', { observations: 'Updated note', issueDate: '2026-09-10' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    // Verify header was patched
    const headerPatch = calls.find((c) => c.method === 'PATCH' && c.url.includes('/records/invoices?') && !c.url.includes('line'))
    expect(headerPatch).toBeDefined()
    expect(headerPatch!.body).toContain('Updated note')
  })
  it('422s when editing a closed invoice', async () => {
    stubDb(closedHeader)
    const res = await patch('/api/billing/invoices/i1', { observations: 'Nope' })
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error.message).toMatch(/closed/i)
  })
  it('422s when editing a VOID invoice', async () => {
    stubDb(voidHeader)
    const res = await patch('/api/billing/invoices/i1', { observations: 'Nope' })
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error.message).toMatch(/void/i)
  })
})
