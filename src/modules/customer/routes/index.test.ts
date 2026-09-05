import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../../../index.js'

const ctx = { waitUntil() {}, passThroughOnException() {} }
const ENV = { INSFORGE_API_URL: 'https://db.test', INSFORGE_API_KEY: 'admin-key' } as never

function stubAuth(role = 'staff', agency = 'hit') {
  vi.stubGlobal('fetch', async (input: Request | string, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? ''
    if (url.includes('/api/auth/sessions/current')) {
      return auth === 'Bearer goodToken' ? new Response(JSON.stringify({ user: { id: 'u1', email: 'u1@test' } }), { status: 200 }) : new Response('unauthorized', { status: 401 })
    }
    if (url.includes('/api/database/records/app_users')) return new Response(JSON.stringify([{ role, active: true, agency }]), { status: 200 })
    if (url.includes('/api/database/records/billing_clients')) return new Response(JSON.stringify([{ id: 'c1', name: 'Ana', name_normalized: 'ana', casillero: null, to_review: false }]), { status: 200, headers: { 'content-range': '0-0/1' } })
    return new Response('not found', { status: 404 })
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('Customer routes', () => {
  it('allows staff to read billing_clients', async () => {
    stubAuth('staff')
    const res = await worker.fetch(new Request('https://t.test/api/customer/clients', { headers: { Authorization: 'Bearer goodToken' } }), ENV, ctx as never)
    expect(res.status).toBe(200)
    expect((await res.json() as { data: { rows: unknown[] } }).data.rows).toHaveLength(1)
  })

  it('scopes the client list to the session agency (tenant isolation)', async () => {
    let clientsUrl = ''
    vi.stubGlobal('fetch', async (input: Request | string, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.url
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? ''
      if (url.includes('/api/auth/sessions/current')) {
        return auth === 'Bearer goodToken' ? new Response(JSON.stringify({ user: { id: 'u1', email: 'u1@test' } }), { status: 200 }) : new Response('unauthorized', { status: 401 })
      }
      if (url.includes('/api/database/records/app_users')) return new Response(JSON.stringify([{ role: 'staff', active: true, agency: 'solo-guegue' }]), { status: 200 })
      if (url.includes('/api/database/records/billing_clients')) {
        clientsUrl = url
        return new Response(JSON.stringify([]), { status: 200, headers: { 'content-range': '*/0' } })
      }
      return new Response('not found', { status: 404 })
    })
    await worker.fetch(new Request('https://t.test/api/customer/clients', { headers: { Authorization: 'Bearer goodToken' } }), ENV, ctx as never)
    expect(clientsUrl).toContain('organization_id=eq.solo-guegue')
  })

  it('denies staff writes while allowing billing roles to write', async () => {
    stubAuth('staff')
    const denied = await worker.fetch(new Request('https://t.test/api/customer/clients', { method: 'POST', headers: { Authorization: 'Bearer goodToken', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Beta' }) }), ENV, ctx as never)
    expect(denied.status).toBe(403)

    stubAuth('billing')
    const allowed = await worker.fetch(new Request('https://t.test/api/customer/clients', { method: 'POST', headers: { Authorization: 'Bearer goodToken', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Beta' }) }), ENV, ctx as never)
    expect(allowed.status).toBe(201)
  })
})
