import { afterEach, describe, expect, it, vi } from 'vitest'
import { InsforgeCustomerRepo } from './customer-repo.js'

afterEach(() => vi.unstubAllGlobals())

describe('InsforgeCustomerRepo', () => {
  it('lists and maps billing_clients rows with lifecycle fields, package count and weight stats', async () => {
    const requested: string[] = []
    vi.stubGlobal('fetch', async (input: Request | string) => {
      const url = typeof input === 'string' ? input : input.url
      requested.push(url)
      if (url.includes('/rpc/customer_weight_stats')) {
        return new Response(JSON.stringify({ c1: { weightMaritimo: 10, weightAereo: 5, countMaritimo: 2, countAereo: 1 } }), { status: 200 })
      }
      return new Response(JSON.stringify([{ id: 'c1', name: 'Ana', name_normalized: 'ana', casillero: 'A1', to_review: true, email: 'a@t.com', phone: null, address: null, company_name: 'Ana S.A.', tax_id: 'J123', active: true, default_rate_id: null, default_rate_card_id: null, packages: [{ count: 3 }] }]), {
        status: 200,
        headers: { 'content-range': '0-0/1' },
      })
    })

    const result = await new InsforgeCustomerRepo('https://db.test', 'key').list({ organizationId: 'hit', search: 'Ana', page: 1, pageSize: 25 })

    expect(requested[0]).toContain('/api/database/records/billing_clients?')
    expect(requested[0]).toContain('organization_id=eq.hit')
    expect(requested[0]).toContain('name=ilike.*Ana*')
    expect(requested[0]).toContain('packages(count)')
    expect(requested[1]).toContain('/rpc/customer_weight_stats')
    expect(result).toEqual({
      rows: [
        {
          id: 'c1', name: 'Ana', nameNormalized: 'ana', casillero: 'A1', toReview: true, email: 'a@t.com', phone: null, address: null,
          companyName: 'Ana S.A.', taxId: 'J123', active: true, deletedAt: null, packageCount: 3, defaultRateId: null, defaultRateCardId: null,
          weightMaritimo: 10, weightAereo: 5, countMaritimo: 2, countAereo: 1,
        },
      ],
      count: 1,
    })
  })

  it('builds an OR status filter and drops the legacy toReview flag when statuses are set', async () => {
    const requested: string[] = []
    vi.stubGlobal('fetch', async (input: Request | string) => {
      const url = typeof input === 'string' ? input : input.url
      requested.push(url)
      if (url.includes('/rpc/customer_weight_stats')) {
        return new Response(JSON.stringify({}), { status: 200 })
      }
      return new Response(JSON.stringify([]), { status: 200, headers: { 'content-range': '*/0' } })
    })

    await new InsforgeCustomerRepo('https://db.test', 'key').list({ organizationId: 'hit', statuses: ['active', 'review'], toReview: true })

    expect(requested[0]).toContain('or=(active.eq.true,to_review.eq.true)')
    expect(requested[0]).not.toContain('to_review=eq')
  })

  it('returns zeroed weight stats for clients missing from the RPC map', async () => {
    vi.stubGlobal('fetch', async (input: Request | string) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('/rpc/customer_weight_stats')) {
        return new Response(JSON.stringify({}), { status: 200 })
      }
      return new Response(JSON.stringify([{ id: 'c9', name: 'Zoe', name_normalized: 'zoe', casillero: null, to_review: false, email: null, phone: null, address: null, company_name: null, tax_id: null, active: true, default_rate_id: null, default_rate_card_id: null }]), {
        status: 200,
        headers: { 'content-range': '0-0/1' },
      })
    })

    const result = await new InsforgeCustomerRepo('https://db.test', 'key').list({ organizationId: 'hit', page: 1, pageSize: 25 })

    expect(result.rows[0]).toMatchObject({ id: 'c9', weightMaritimo: 0, weightAereo: 0, countMaritimo: 0, countAereo: 0 })
  })

  it('calls the aggregate stats RPC and normalizes defaults', async () => {
    vi.stubGlobal('fetch', async (input: Request | string) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('/rpc/customer_aggregate_stats')) {
        return new Response(JSON.stringify({
          totalWeightLb: 100, weightMaritimo: 60, weightAereo: 40,
          packageCountTotal: 12, packageCountMaritimo: 7, packageCountAereo: 5,
          topMaritimo: { clientId: 'c1', name: 'Ana', weightLb: 50 },
          topAereo: null,
        }), { status: 200 })
      }
      return new Response('not found', { status: 404 })
    })

    const result = await new InsforgeCustomerRepo('https://db.test', 'key').aggregateStats('hit', '2026-09-01', '2026-09-30')

    expect(result).toEqual({
      totalWeightLb: 100, weightMaritimo: 60, weightAereo: 40,
      packageCountTotal: 12, packageCountMaritimo: 7, packageCountAereo: 5,
      topMaritimo: { clientId: 'c1', name: 'Ana', weightLb: 50 },
      topAereo: null,
    })
  })

  it('lists a client event timeline from audit_logs entity-scoped', async () => {
    const requested: string[] = []
    vi.stubGlobal('fetch', async (input: Request | string) => {
      const url = typeof input === 'string' ? input : input.url
      requested.push(url)
      return new Response(JSON.stringify([{ id: 1, organization_id: 'hit', actor_id: 'u1', actor_email: 'a@t.com', actor_type: 'user', action: 'client.update', entity_type: 'billing_client', entity_id: 'c1', request_id: 'r1', metadata: { changes: {} }, created_at: '2026-09-10T00:00:00Z' }]), {
        status: 200,
        headers: { 'content-range': '0-0/1' },
      })
    })

    const result = await new InsforgeCustomerRepo('https://db.test', 'key').listEvents('hit', 'c1', { page: 1, pageSize: 25 })

    expect(requested[0]).toContain('/api/database/records/audit_logs?')
    expect(requested[0]).toContain('entity_id=eq.c1')
    expect(result.rows[0]).toMatchObject({ action: 'client.update', entityId: 'c1', createdAt: '2026-09-10T00:00:00Z' })
    expect(result.count).toBe(1)
  })

  it('creates a billing_clients row using the canonical snake_case columns', async () => {
    let body = ''
    vi.stubGlobal('fetch', async (_input: Request | string, init?: RequestInit) => {
      body = String(init?.body ?? '')
      return new Response(JSON.stringify([{ id: 'c1', name: 'Ana', name_normalized: 'ana', casillero: null, to_review: false, email: null, phone: null, address: null, company_name: null, tax_id: null, active: true, default_rate_id: null, default_rate_card_id: null }]), { status: 201 })
    })

    const result = await new InsforgeCustomerRepo('https://db.test', 'key').create({ organizationId: 'hit', name: 'Ana', nameNormalized: 'ana', casillero: null, toReview: false, email: null, phone: null, address: null, companyName: null, taxId: null, active: true, defaultRateId: null, defaultRateCardId: null })

    expect(JSON.parse(body)).toEqual([{ organization_id: 'hit', name: 'Ana', name_normalized: 'ana', casillero: null, to_review: false, email: null, phone: null, address: null, company_name: null, tax_id: null, active: true, default_rate_id: null, default_rate_card_id: null }])
    expect(result.id).toBe('c1')
  })

  it('writes an audit entry to audit_logs', async () => {
    let body = ''
    vi.stubGlobal('fetch', async (_input: Request | string, init?: RequestInit) => {
      body = String(init?.body ?? '')
      return new Response(null, { status: 201 })
    })

    await new InsforgeCustomerRepo('https://db.test', 'key').insertAudit({
      organizationId: 'hit', actorId: 'u1', actorEmail: 'a@t.com', actorType: 'user', action: 'client.deactivate',
      entityType: 'billing_client', entityId: 'c1', requestId: 'r1', metadata: { changes: {} },
    })

    expect(JSON.parse(body)).toEqual([{ organization_id: 'hit', actor_id: 'u1', actor_email: 'a@t.com', actor_type: 'user', action: 'client.deactivate', entity_type: 'billing_client', entity_id: 'c1', request_id: 'r1', metadata: { changes: {} } }])
  })

  it('soft-deletes a client org-scoped and maps deletedAt', async () => {
    let url = ''
    let body = ''
    vi.stubGlobal('fetch', async (input: Request | string, init?: RequestInit) => {
      url = typeof input === 'string' ? input : input.url
      body = String(init?.body ?? '')
      return new Response(JSON.stringify([{ id: 'c1', name: 'Ana', name_normalized: 'ana', casillero: null, to_review: false, email: null, phone: null, address: null, company_name: null, tax_id: null, active: true, deleted_at: '2026-09-08T22:00:00Z', default_rate_id: null, default_rate_card_id: null }]), { status: 200 })
    })

    const result = await new InsforgeCustomerRepo('https://db.test', 'key').delete('c1', 'hit', 'u1', 'cierre')

    expect(url).toContain('/api/database/records/billing_clients?id=eq.c1')
    expect(url).toContain('organization_id=eq.hit')
    expect(JSON.parse(body)).toMatchObject({ deleted_by: 'u1', delete_reason: 'cierre' })
    expect(typeof JSON.parse(body).deleted_at).toBe('string')
    expect(result?.deletedAt).toBe('2026-09-08T22:00:00Z')
  })

  it('builds a delete preview with package and invoice counts + capped samples', async () => {
    const requested: string[] = []
    vi.stubGlobal('fetch', async (input: Request | string) => {
      const url = typeof input === 'string' ? input : input.url
      requested.push(url)
      if (url.includes('/api/database/records/billing_clients')) {
        return new Response(JSON.stringify([{ id: 'c1', name: 'Ana', name_normalized: 'ana', casillero: null, to_review: false, email: null, phone: null, address: null, company_name: null, tax_id: null, active: true, deleted_at: null, default_rate_id: null, default_rate_card_id: null }]), { status: 200 })
      }
      if (url.includes('/api/database/records/packages')) {
        return new Response(JSON.stringify([{ almacen_id: '926791', tracking_number: 'TRK1' }]), { status: 200, headers: { 'content-range': '0-0/3' } })
      }
      if (url.includes('/api/database/records/invoices')) {
        return new Response(JSON.stringify([{ fiscal_year: 2026, invoice_number: 104, status: 'PAID' }]), { status: 200, headers: { 'content-range': '0-0/2' } })
      }
      return new Response('not found', { status: 404 })
    })

    const result = await new InsforgeCustomerRepo('https://db.test', 'key').deletePreview('c1', 'hit')

    expect(result).toMatchObject({
      client: expect.objectContaining({ id: 'c1' }),
      packages: [{ guia: '926791', tracking: 'TRK1' }],
      packageCount: 3,
      invoices: [{ fiscalYear: 2026, invoiceNumber: 104, status: 'PAID' }],
      invoiceCount: 2,
    })
    expect(requested.find((u) => u.includes('/records/packages'))).toContain('client_id=eq.c1')
    expect(requested.find((u) => u.includes('/records/invoices'))).toContain('organization_id=eq.hit')
  })
})