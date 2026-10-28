import { afterEach, describe, expect, it, vi } from 'vitest'
import { InsforgeBillingRepo } from './billing-repo.js'

function mockFetch(reply: unknown) {
  const calls: { url: string; method?: string; headers: Record<string, string>; body?: string }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => {
      calls.push({ url, method: init.method, headers: init.headers ?? {}, body: init.body })
      return new Response(JSON.stringify(reply), { status: 200 })
    }),
  )
  return calls
}

afterEach(() => vi.unstubAllGlobals())

describe('InsforgeBillingRepo.closeInvoiceIfOpen — compare-and-set', () => {
  it('scopes the PATCH to id + org + open + the status that was read, and reports the winner', async () => {
    const calls = mockFetch([{ id: 'i1' }])
    const repo = new InsforgeBillingRepo('https://x.test', 'k')
    const won = await repo.closeInvoiceIfOpen('i1', 'solo-guegue', 'DRAFT', 'ISSUED', '2026-09-06T00:00:00Z', 'ana@hit.com')
    expect(won).toBe(true)
    const url = new URL(calls[0].url)
    expect(url.pathname).toBe('/api/database/records/invoices')
    const q = url.searchParams
    expect(q.get('id')).toBe('eq.i1')
    expect(q.get('organization_id')).toBe('eq.solo-guegue')
    expect(q.get('closed_at')).toBe('is.null')
    expect(q.get('status')).toBe('eq.DRAFT')
    expect(calls[0].method).toBe('PATCH')
    expect(calls[0].headers.Prefer).toBe('return=representation')
    expect(JSON.parse(calls[0].body!)).toMatchObject({ status: 'ISSUED', closed_by: 'ana@hit.com' })
  })
  it('returns false when the guarded PATCH matches no row (lost race / foreign org)', async () => {
    mockFetch([])
    const repo = new InsforgeBillingRepo('https://x.test', 'k')
    expect(await repo.closeInvoiceIfOpen('i1', 'hit', 'ISSUED', 'ISSUED', '2026-09-06T00:00:00Z', 'a@b.c')).toBe(false)
  })
  it('never reflects the upstream error body in the thrown message (log-only, POST path)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"message":"column \\u0022closed_at\\u0022 does not exist"}', { status: 400 })))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const repo = new InsforgeBillingRepo('https://x.test', 'k')
      await expect(repo.insertPayment('i1', { amount: 5 })).rejects.toThrow(/^InsForge POST invoice_payments → 400$/)
      expect(errSpy).toHaveBeenCalled()
    } finally {
      errSpy.mockRestore()
    }
  })
})

describe('InsforgeBillingRepo package projections — PostgREST alias syntax', () => {
  const row = {
    id: 'p1',
    almacen_id: 'A-1',
    tracking_number: 'T-1',
    effective_status: 'RECIBIDO',
    service_type: 'AEREO',
    effective_service_type: 'AEREO',
    weight_lb: 12.5,
    client_id: 'c1',
    referencia_name: 'ORIGINAL EXPRESS',
    organization_id: 'hit',
  }

  it('getPackagesForBulk aliases effective_weight_lb with alias:column, not SQL AS', async () => {
    const calls = mockFetch([row])
    const repo = new InsforgeBillingRepo('https://x.test', 'k')
    const rows = await repo.getPackagesForBulk(['p1'], 'hit')
    const select = new URL(calls[0].url).searchParams.get('select') ?? ''
    expect(select).toContain('weight_lb:effective_weight_lb')
    expect(select).not.toMatch(/\bas\b/)
    expect(rows).toEqual([row])
  })

  it('getPackagesForClient aliases effective_weight_lb with alias:column, not SQL AS', async () => {
    const calls = mockFetch([row])
    const repo = new InsforgeBillingRepo('https://x.test', 'k')
    const rows = await repo.getPackagesForClient('c1', 'hit')
    const url = new URL(calls[0].url)
    expect(url.searchParams.get('select')).toContain('weight_lb:effective_weight_lb')
    expect(url.searchParams.get('select')).not.toMatch(/\bas\b/)
    expect(url.searchParams.get('client_id')).toBe('eq.c1')
    expect(url.searchParams.get('organization_id')).toBe('eq.hit')
    expect(rows).toEqual([row])
  })

  it('surfaces the upstream status when the projection is rejected (400)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad request', { status: 400 })))
    const repo = new InsforgeBillingRepo('https://x.test', 'k')
    await expect(repo.getPackagesForBulk(['p1'], 'hit')).rejects.toThrow(/^InsForge GET packages → 400$/)
  })
})

describe('InsforgeBillingRepo client reads — org scoped', () => {
  const row = { id: 'c1', name: 'Original Express', active: true, default_rate_card_id: 'card-1', default_rate_id: null }

  it('getClientForBilling filters by id + org and selects identity + defaults', async () => {
    const calls = mockFetch([row])
    const repo = new InsforgeBillingRepo('https://x.test', 'k')
    expect(await repo.getClientForBilling('c1', 'hit')).toEqual(row)
    const q = new URL(calls[0].url).searchParams
    expect(q.get('id')).toBe('eq.c1')
    expect(q.get('organization_id')).toBe('eq.hit')
    expect(q.get('deleted_at')).toBe('is.null')
    expect(q.get('select')).toBe('id,name,active,default_rate_card_id,default_rate_id')
  })

  it('getClientForBilling returns null for a foreign/unknown client', async () => {
    mockFetch([])
    const repo = new InsforgeBillingRepo('https://x.test', 'k')
    expect(await repo.getClientForBilling('nope', 'hit')).toBeNull()
  })

  it('listClientsForBilling scopes to the org and skips soft-deleted rows', async () => {
    const calls = mockFetch([row])
    const repo = new InsforgeBillingRepo('https://x.test', 'k')
    expect(await repo.listClientsForBilling('solo-guegue')).toEqual([row])
    const q = new URL(calls[0].url).searchParams
    expect(q.get('organization_id')).toBe('eq.solo-guegue')
    expect(q.get('deleted_at')).toBe('is.null')
    expect(q.get('order')).toBe('name.asc')
  })
})
