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
