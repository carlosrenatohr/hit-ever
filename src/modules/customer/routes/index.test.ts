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
    if (url.includes('/rpc/customer_weight_stats')) return new Response(JSON.stringify({}), { status: 200 })
    if (url.includes('/api/database/records/billing_clients')) {
      return new Response(JSON.stringify([{ id: 'c1', name: 'Ana', name_normalized: 'ana', casillero: null, to_review: false, company_name: null, tax_id: null, active: true, default_rate_id: null, packages: [{ count: 2 }] }]), { status: 200, headers: { 'content-range': '0-0/1' } })
    }
    if (url.includes('/api/database/records/audit_logs')) return new Response(null, { status: 201 })
    return new Response('not found', { status: 404 })
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('Customer routes', () => {
  it('allows staff to read billing_clients', async () => {
    stubAuth('staff')
    const res = await worker.fetch(new Request('https://t.test/api/customer/clients', { headers: { Authorization: 'Bearer goodToken' } }), ENV, ctx as never)
    expect(res.status).toBe(200)
    const body = (await res.json() as { data: { rows: Array<{ packageCount: number; active: boolean }> } }).data
    expect(body.rows).toHaveLength(1)
    expect(body.rows[0]).toMatchObject({ active: true, packageCount: 2 })
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
      if (url.includes('/rpc/customer_weight_stats')) return new Response(JSON.stringify({}), { status: 200 })
      if (url.includes('/api/database/records/billing_clients')) {
        clientsUrl = url
        return new Response(JSON.stringify([]), { status: 200, headers: { 'content-range': '*/0' } })
      }
      return new Response('not found', { status: 404 })
    })
    await worker.fetch(new Request('https://t.test/api/customer/clients', { headers: { Authorization: 'Bearer goodToken' } }), ENV, ctx as never)
    expect(clientsUrl).toContain('organization_id=eq.solo-guegue')
  })

  it('filters by comma-separated statuses with OR semantics', async () => {
    let clientsUrl = ''
    vi.stubGlobal('fetch', async (input: Request | string, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.url
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? ''
      if (url.includes('/api/auth/sessions/current')) return auth === 'Bearer goodToken' ? new Response(JSON.stringify({ user: { id: 'u1', email: 'u1@test' } }), { status: 200 }) : new Response('unauthorized', { status: 401 })
      if (url.includes('/api/database/records/app_users')) return new Response(JSON.stringify([{ role: 'staff', active: true, agency: 'hit' }]), { status: 200 })
      if (url.includes('/rpc/customer_weight_stats')) return new Response(JSON.stringify({}), { status: 200 })
      if (url.includes('/api/database/records/billing_clients')) {
        clientsUrl = url
        return new Response(JSON.stringify([]), { status: 200, headers: { 'content-range': '*/0' } })
      }
      return new Response('not found', { status: 404 })
    })
    const res = await worker.fetch(new Request('https://t.test/api/customer/clients?status=active,review', { headers: { Authorization: 'Bearer goodToken' } }), ENV, ctx as never)
    expect(res.status).toBe(200)
    expect(clientsUrl).toContain('or=(active.eq.true,to_review.eq.true)')
  })

  it('denies staff writes while allowing billing roles to write', async () => {
    stubAuth('staff')
    const denied = await worker.fetch(new Request('https://t.test/api/customer/clients', { method: 'POST', headers: { Authorization: 'Bearer goodToken', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Beta' }) }), ENV, ctx as never)
    expect(denied.status).toBe(403)

    stubAuth('billing')
    const allowed = await worker.fetch(new Request('https://t.test/api/customer/clients', { method: 'POST', headers: { Authorization: 'Bearer goodToken', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Beta' }) }), ENV, ctx as never)
    expect(allowed.status).toBe(201)
  })

  it('soft-deletes a client (DELETE) org-scoped and audits client.delete', async () => {
    let patchUrl = ''
    let patchBody = ''
    const postedAudits: string[] = []
    vi.stubGlobal('fetch', async (input: Request | string, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.url
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? ''
      const method = init?.method ?? 'GET'
      if (url.includes('/api/auth/sessions/current')) {
        return auth === 'Bearer goodToken' ? new Response(JSON.stringify({ user: { id: 'u1', email: 'u1@test' } }), { status: 200 }) : new Response('unauthorized', { status: 401 })
      }
      if (url.includes('/api/database/records/app_users')) return new Response(JSON.stringify([{ role: 'billing', active: true, agency: 'hit' }]), { status: 200 })
      if (method === 'PATCH' && url.includes('/records/billing_clients')) {
        patchUrl = url
        patchBody = String(init?.body ?? '')
        return new Response(JSON.stringify([{ id: 'c1', name: 'Ana', name_normalized: 'ana', casillero: null, to_review: false, email: null, phone: null, address: null, company_name: null, tax_id: null, active: true, deleted_at: '2026-09-08T22:00:00Z', default_rate_id: null, default_rate_card_id: null }]), { status: 200 })
      }
      if (url.includes('/records/audit_logs')) {
        postedAudits.push(String(init?.body ?? ''))
        return new Response(null, { status: 201 })
      }
      if (url.includes('/records/billing_clients')) {
        return new Response(JSON.stringify([{ id: 'c1', name: 'Ana', name_normalized: 'ana', casillero: null, to_review: false, email: null, phone: null, address: null, company_name: null, tax_id: null, active: true, deleted_at: null, default_rate_id: null, default_rate_card_id: null }]), { status: 200, headers: { 'content-range': '0-0/1' } })
      }
      if (url.includes('/records/packages') || url.includes('/records/invoices')) return new Response(JSON.stringify([]), { status: 200, headers: { 'content-range': '*/0' } })
      return new Response('not found', { status: 404 })
    })

    const res = await worker.fetch(new Request('https://t.test/api/customer/clients/c1', { method: 'DELETE', headers: { Authorization: 'Bearer goodToken', 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'cierre' }) }), ENV, ctx as never)

    expect(res.status).toBe(200)
    expect(patchUrl).toContain('organization_id=eq.hit')
    expect(JSON.parse(patchBody)).toMatchObject({ deleted_by: 'u1', delete_reason: 'cierre' })
    expect(postedAudits[0]).toContain('client.delete')
  })

  it('denies client delete for staff (clients:write required)', async () => {
    vi.stubGlobal('fetch', async (input: Request | string, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.url
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? ''
      if (url.includes('/api/auth/sessions/current')) return auth === 'Bearer goodToken' ? new Response(JSON.stringify({ user: { id: 'u1', email: 'u1@test' } }), { status: 200 }) : new Response('unauthorized', { status: 401 })
      if (url.includes('/api/database/records/app_users')) return new Response(JSON.stringify([{ role: 'staff', active: true, agency: 'hit' }]), { status: 200 })
      return new Response('not found', { status: 404 })
    })

    const res = await worker.fetch(new Request('https://t.test/api/customer/clients/c1', { method: 'DELETE', headers: { Authorization: 'Bearer goodToken' } }), ENV, ctx as never)
    expect(res.status).toBe(403)
  })

  it('returns 404 for a delete preview of an unknown client', async () => {
    vi.stubGlobal('fetch', async (input: Request | string, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.url
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? ''
      if (url.includes('/api/auth/sessions/current')) return auth === 'Bearer goodToken' ? new Response(JSON.stringify({ user: { id: 'u1', email: 'u1@test' } }), { status: 200 }) : new Response('unauthorized', { status: 401 })
      if (url.includes('/api/database/records/app_users')) return new Response(JSON.stringify([{ role: 'billing', active: true, agency: 'hit' }]), { status: 200 })
      if (url.includes('/records/billing_clients')) return new Response(JSON.stringify([]), { status: 200 })
      return new Response('not found', { status: 404 })
    })

    const res = await worker.fetch(new Request('https://t.test/api/customer/clients/nope/delete-preview', { headers: { Authorization: 'Bearer goodToken' } }), ENV, ctx as never)
    expect(res.status).toBe(404)
  })

  it('returns KPI aggregate stats scoped to the session agency', async () => {
    let statsUrl = ''
    vi.stubGlobal('fetch', async (input: Request | string, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.url
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? ''
      if (url.includes('/api/auth/sessions/current')) return auth === 'Bearer goodToken' ? new Response(JSON.stringify({ user: { id: 'u1', email: 'u1@test' } }), { status: 200 }) : new Response('unauthorized', { status: 401 })
      if (url.includes('/api/database/records/app_users')) return new Response(JSON.stringify([{ role: 'staff', active: true, agency: 'hit' }]), { status: 200 })
      if (url.includes('/rpc/customer_aggregate_stats')) {
        statsUrl = url
        return new Response(JSON.stringify({ totalWeightLb: 100, weightMaritimo: 60, weightAereo: 40, packageCountTotal: 12, packageCountMaritimo: 7, packageCountAereo: 5, topMaritimo: { clientId: 'c1', name: 'Ana', weightLb: 50 }, topAereo: null }), { status: 200 })
      }
      return new Response('not found', { status: 404 })
    })

    const res = await worker.fetch(new Request('https://t.test/api/customer/stats?from=2026-09-01&to=2026-09-30', { headers: { Authorization: 'Bearer goodToken' } }), ENV, ctx as never)
    expect(res.status).toBe(200)
    expect(statsUrl).toContain('/rpc/customer_aggregate_stats')
    const body = (await res.json() as { data: { totalWeightLb: number; topAereo: unknown } }).data
    expect(body).toMatchObject({ totalWeightLb: 100, topAereo: null })
  })

  it('returns the event timeline for a client scoped to the agency', async () => {
    let eventsUrl = ''
    vi.stubGlobal('fetch', async (input: Request | string, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.url
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? ''
      if (url.includes('/api/auth/sessions/current')) return auth === 'Bearer goodToken' ? new Response(JSON.stringify({ user: { id: 'u1', email: 'u1@test' } }), { status: 200 }) : new Response('unauthorized', { status: 401 })
      if (url.includes('/api/database/records/app_users')) return new Response(JSON.stringify([{ role: 'staff', active: true, agency: 'hit' }]), { status: 200 })
      if (url.includes('/records/audit_logs')) {
        eventsUrl = url
        return new Response(JSON.stringify([{ id: 1, organization_id: 'hit', actor_id: 'u1', actor_email: 'a@t.com', actor_type: 'user', action: 'client.update', entity_type: 'billing_client', entity_id: 'c1', request_id: 'r1', metadata: {}, created_at: '2026-09-10T00:00:00Z' }]), { status: 200, headers: { 'content-range': '0-0/1' } })
      }
      return new Response('not found', { status: 404 })
    })

    const res = await worker.fetch(new Request('https://t.test/api/customer/clients/c1/events', { headers: { Authorization: 'Bearer goodToken' } }), ENV, ctx as never)
    expect(res.status).toBe(200)
    expect(eventsUrl).toContain('entity_id=eq.c1')
    expect(eventsUrl).toContain('organization_id=eq.hit')
    const body = (await res.json() as { data: { rows: Array<{ action: string }>; count: number } }).data
    expect(body.rows[0]).toMatchObject({ action: 'client.update' })
    expect(body.count).toBe(1)
  })
})