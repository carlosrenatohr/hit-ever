import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../../../index.js'

// Regression guards for the Phase 1 config endpoints: /info is self-scoped (even
// admins only touch their own agency), payments catalogs are org-filtered on
// every read AND write, and all mutations land in the audit log.

const ctx = { waitUntil() {}, passThroughOnException() {} }
const ENV = { INSFORGE_API_URL: 'https://db.test', INSFORGE_API_KEY: 'admin-key' } as never

let postedAudits: string[] = []
const writes: { table: string; url: string }[] = []

function stubBackend(opts: { validToken?: string; users?: Record<string, unknown>; tables?: Record<string, unknown[]> }) {
  vi.stubGlobal('fetch', async (input: Request | string, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? ''
    if (url.includes('/api/auth/sessions/current')) {
      const token = auth.replace(/^Bearer\s+/i, '')
      if (opts.validToken && token === opts.validToken) {
        return new Response(JSON.stringify({ user: { id: 'u1', email: 'u1@test' } }), { status: 200 })
      }
      return new Response('unauthorized', { status: 401 })
    }
    if (url.includes('/api/database/records/app_users')) {
      const row = opts.users?.['u1']
      return new Response(JSON.stringify(row ? [row] : []), { status: 200 })
    }
    if (url.includes('/api/database/records/')) {
      const table = url.split('/api/database/records/')[1].split('?')[0]
      if (table === 'audit_logs' && init?.method === 'POST') postedAudits.push((init.body as string) ?? '')
      if (init?.method && init.method !== 'GET') writes.push({ table, url })
      return new Response(JSON.stringify(opts.tables?.[table] ?? []), { status: 200 })
    }
    return new Response('not found', { status: 404 })
  })
}

const AUTH = { Authorization: 'Bearer goodToken', 'Content-Type': 'application/json' }
const agencyRow = { slug: 'suite', name: 'Suite', ruc: null, address: null, phone: null, currency: 'USD', is_scrapable: true }
const methodRow = { id: 'm1', name: 'Transferencia', active: true }

afterEach(() => {
  vi.unstubAllGlobals()
  postedAudits = []
  writes.length = 0
})

describe('GET /api/config/info', () => {
  it('returns the session agency profile (self-scoped)', async () => {
    const requested: string[] = []
    vi.stubGlobal('fetch', async (input: Request | string) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('/api/database/records/agencies')) {
        requested.push(url)
        return new Response(JSON.stringify([agencyRow]), { status: 200 })
      }
      if (url.includes('/api/auth/sessions/current')) return new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200 })
      if (url.includes('/api/database/records/app_users')) return new Response(JSON.stringify([{ role: 'staff', active: true, agency: 'suite' }]), { status: 200 })
      return new Response('not found', { status: 404 })
    })
    const res = await worker.fetch(new Request('https://t.test/api/config/info', { headers: { Authorization: 'Bearer goodToken' } }), ENV, ctx as never)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { slug: string; currency: string; isScrapable: boolean } }
    expect(body.data).toMatchObject({ slug: 'suite', currency: 'USD', isScrapable: true })
    expect(requested[0]).toContain('slug=eq.suite')
  })
})

describe('PATCH /api/config/info', () => {
  it('403 for staff (config:write required)', async () => {
    stubBackend({ validToken: 'goodToken', users: { u1: { role: 'staff', active: true, agency: 'suite' } }, tables: { agencies: [agencyRow] } })
    const res = await worker.fetch(new Request('https://t.test/api/config/info', { method: 'PATCH', headers: AUTH, body: JSON.stringify({ ruc: 'X' }) }), ENV, ctx as never)
    expect(res.status).toBe(403)
  })

  it('admin updates only their own agency, with an audit row', async () => {
    stubBackend({ validToken: 'goodToken', users: { u1: { role: 'admin', active: true, agency: 'hit' } }, tables: { agencies: [{ ...agencyRow, slug: 'hit' }] } })
    const res = await worker.fetch(new Request('https://t.test/api/config/info', { method: 'PATCH', headers: AUTH, body: JSON.stringify({ ruc: 'J0310000123', currency: 'NIO' }) }), ENV, ctx as never)
    expect(res.status).toBe(200)
    const agencyWrite = writes.find((w) => w.table === 'agencies')
    expect(agencyWrite?.url).toContain('slug=eq.hit')
    expect(postedAudits.some((a) => a.includes('agency.info.update'))).toBe(true)
  })
})

describe('/api/config/payments — catalogs', () => {
  it('reads methods and banks scoped to the session agency', async () => {
    const requested: string[] = []
    vi.stubGlobal('fetch', async (input: Request | string) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('/api/database/records/payment_methods') || url.includes('/api/database/records/payment_banks')) {
        requested.push(url)
        return new Response(JSON.stringify([methodRow]), { status: 200 })
      }
      if (url.includes('/api/auth/sessions/current')) return new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200 })
      if (url.includes('/api/database/records/app_users')) return new Response(JSON.stringify([{ role: 'staff', active: true, agency: 'suite' }]), { status: 200 })
      return new Response('not found', { status: 404 })
    })
    const res = await worker.fetch(new Request('https://t.test/api/config/payments', { headers: { Authorization: 'Bearer goodToken' } }), ENV, ctx as never)
    expect(res.status).toBe(200)
    expect(requested.length).toBeGreaterThanOrEqual(2)
    for (const url of requested) expect(url).toContain('organization_id=eq.suite')
  })

  it('creates a method as billing with org + audit', async () => {
    stubBackend({
      validToken: 'goodToken',
      users: { u1: { role: 'billing', active: true, agency: 'hit' } },
      tables: { payment_methods: [methodRow] },
    })
    const res = await worker.fetch(new Request('https://t.test/api/config/payments/methods', { method: 'POST', headers: AUTH, body: JSON.stringify({ name: 'Sinpe móvil' }) }), ENV, ctx as never)
    expect(res.status).toBe(201)
    const insert = writes.find((w) => w.table === 'payment_methods')
    expect(insert).toBeTruthy()
    expect(postedAudits.some((a) => a.includes('payment_method.create'))).toBe(true)
  })

  it('scopes method updates to the session agency (foreign id = no-op)', async () => {
    stubBackend({
      validToken: 'goodToken',
      users: { u1: { role: 'billing', active: true, agency: 'hit' } },
      tables: { payment_methods: [methodRow] },
    })
    const res = await worker.fetch(new Request('https://t.test/api/config/payments/methods/m1', { method: 'PATCH', headers: AUTH, body: JSON.stringify({ active: false }) }), ENV, ctx as never)
    expect(res.status).toBe(200)
    const patch = writes.find((w) => w.table === 'payment_methods')
    expect(patch?.url).toContain('organization_id=eq.hit')
  })
})
