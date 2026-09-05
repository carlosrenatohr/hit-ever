import { afterEach, describe, expect, it, vi } from 'vitest'
import { InsforgeCustomerRepo } from './customer-repo.js'

afterEach(() => vi.unstubAllGlobals())

describe('InsforgeCustomerRepo', () => {
  it('lists and maps billing_clients rows', async () => {
    let requested = ''
    vi.stubGlobal('fetch', async (input: Request | string) => {
      requested = typeof input === 'string' ? input : input.url
      return new Response(JSON.stringify([{ id: 'c1', name: 'Ana', name_normalized: 'ana', casillero: 'A1', to_review: true, email: 'a@t.com', phone: null, address: null, default_rate_id: null }]), {
        status: 200,
        headers: { 'content-range': '0-0/1' },
      })
    })

    const result = await new InsforgeCustomerRepo('https://db.test', 'key').list({ organizationId: 'hit', search: 'Ana', page: 1, pageSize: 25 })

    expect(requested).toContain('/api/database/records/billing_clients?')
    expect(requested).toContain('organization_id=eq.hit')
    expect(requested).toContain('name=ilike.*Ana*')
    expect(result).toEqual({ rows: [{ id: 'c1', name: 'Ana', nameNormalized: 'ana', casillero: 'A1', toReview: true, email: 'a@t.com', phone: null, address: null, defaultRateId: null }], count: 1 })
  })

  it('creates a billing_clients row using the canonical snake_case columns', async () => {
    let body = ''
    vi.stubGlobal('fetch', async (_input: Request | string, init?: RequestInit) => {
      body = String(init?.body ?? '')
      return new Response(JSON.stringify([{ id: 'c1', name: 'Ana', name_normalized: 'ana', casillero: null, to_review: false, email: null, phone: null, address: null, default_rate_id: null }]), { status: 201 })
    })

    const result = await new InsforgeCustomerRepo('https://db.test', 'key').create({ organizationId: 'hit', name: 'Ana', nameNormalized: 'ana', casillero: null, toReview: false, email: null, phone: null, address: null, defaultRateId: null })

    expect(JSON.parse(body)).toEqual([{ organization_id: 'hit', name: 'Ana', name_normalized: 'ana', casillero: null, to_review: false, email: null, phone: null, address: null, default_rate_id: null }])
    expect(result.id).toBe('c1')
  })
})
