import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../../../index.js'

// Archive wiring at the HTTP edge: POST /invoices/:id/archive must stamp
// deleted_at/deleted_by/delete_reason org-scoped (guarded by deleted_at=is.null),
// release the active package links VOID-style so the packages are re-invoiceable,
// and log both audit events (invoice + per-package). Archived rows never leave
// the bundle read, so list/detail/public receipts filter them and every other
// mutation 404s.

const ctx = { waitUntil() {}, passThroughOnException() {} }
const ENV = { INSFORGE_API_URL: 'https://db.test', INSFORGE_API_KEY: 'admin-key' } as never

afterEach(() => vi.unstubAllGlobals())

const header = {
  id: 'i1', invoice_number: 7, fiscal_year: 2026, client_id: 'c1', client_name_raw: 'Ana',
  issue_date: '2026-09-05', status: 'DRAFT', address: null, special_price: false, observations: null,
  tracking_orders: [], agent_id: null, public_token: null, paid_at: null,
  total: 6.5, profit: 2, paid_usd: 0, closed_at: null, closed_by: null,
  created_at: '', updated_at: '',
}
const link = {
  id: 'l1', invoice_id: 'i1', package_id: 'pkg-1', source: 'manual', matched_oc: null, active: true,
  packages: { almacen_id: 'HIT-00122', tracking_number: null },
}

/** `invoice: null` simulates an archived (or foreign) invoice: every bundle read resolves empty. */
function stubDb(opts: { invoice?: Record<string, unknown> | null; links?: unknown[] } = {}) {
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
    if (method === 'GET' && url.includes('/records/invoices?')) {
      return new Response(JSON.stringify(opts.invoice ? [opts.invoice] : []), { status: 200 })
    }
    if (method === 'GET' && url.includes('/records/invoice_packages?')) {
      return new Response(JSON.stringify(opts.links ?? []), { status: 200 })
    }
    if (method === 'GET') return new Response(JSON.stringify([]), { status: 200 })
    if (method === 'PATCH') return new Response(JSON.stringify([{ id: 'i1' }]), { status: 200 })
    return new Response('[]', { status: 201 })
  })
  return calls
}

const post = (path: string, body?: unknown) =>
  worker.fetch(
    new Request(`https://t.test${path}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }),
    ENV,
    ctx as never,
  )

const get = (path: string) =>
  worker.fetch(new Request(`https://t.test${path}`, { headers: { Authorization: 'Bearer tok' } }), ENV, ctx as never)

describe('POST /api/billing/invoices/:id/archive', () => {
  it('stamps deleted_at org-scoped, releases the links and logs both events', async () => {
    const calls = stubDb({ invoice: header, links: [link] })
    const res = await post('/api/billing/invoices/i1/archive', { reason: 'creada por error' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, data: { id: 'i1', archived: true } })

    // The bundle read that gates the archive itself filters archived rows.
    const bundle = calls.find((c) => c.method === 'GET' && c.url.includes('/records/invoices?'))
    expect(bundle?.url).toContain('deleted_at=is.null')

    const patch = calls.find((c) => c.method === 'PATCH' && c.url.includes('/records/invoices?'))
    expect(patch?.url).toContain('organization_id=eq.hit')
    expect(patch?.url).toContain('deleted_at=is.null')
    const body = JSON.parse(patch!.body!)
    expect(body).toMatchObject({ deleted_by: 'billing@hit.com', delete_reason: 'creada por error' })
    expect(body.deleted_at).toBeTruthy()

    // VOID-style release: the packages become re-invoiceable again.
    const release = calls.find((c) => c.method === 'PATCH' && c.url.includes('/records/invoice_packages?'))
    expect(release?.url).toContain('invoice_id=eq.i1')
    expect(release?.url).toContain('active=eq.true')
    expect(JSON.parse(release!.body!)).toMatchObject({ active: false, released_by: 'system:archive' })

    const invEvent = calls.find((c) => c.method === 'POST' && c.url.includes('/records/invoice_events'))
    expect(invEvent?.body).toContain('Factura archivada')
    expect(invEvent?.body).toContain('creada por error')
    expect(invEvent?.body).toContain('hit')

    const pkgEvent = calls.find((c) => c.method === 'POST' && c.url.endsWith('/records/events'))
    expect(pkgEvent?.body).toContain('archivada')
    expect(pkgEvent?.body).toContain('pkg-1')
  })

  it('404s when the invoice does not exist (or is already archived)', async () => {
    stubDb({ invoice: null })
    const res = await post('/api/billing/invoices/i1/archive', {})
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND')
  })

  it('blocks void/close/share/payments on an archived invoice (all resolve via the bundle)', async () => {
    stubDb({ invoice: null })
    expect((await post('/api/billing/invoices/i1/void', {})).status).toBe(404)
    expect((await post('/api/billing/invoices/i1/close')).status).toBe(404)
    expect((await post('/api/billing/invoices/i1/share')).status).toBe(404)
    expect(
      (await post('/api/billing/invoices/i1/payments', { method: 'CASH', currency: 'USD', amount: 5 })).status,
    ).toBe(404)
  })
})

describe('archived invoices leave every operational read', () => {
  it('GET /invoices filters deleted_at at the repo layer (rows and count)', async () => {
    const calls = stubDb({ invoice: header })
    const res = await get('/api/billing/invoices')
    expect(res.status).toBe(200)
    const list = calls.find((c) => c.method === 'GET' && c.url.includes('/records/invoices?'))
    expect(list?.url).toContain('deleted_at=is.null')
    expect(list?.url).toContain('organization_id=eq.hit')
  })

  it('404s the public receipt of an archived invoice (token lookup filters deleted_at)', async () => {
    const calls = stubDb({ invoice: null })
    const res = await worker.fetch(new Request('https://t.test/billing/r/11111111-2222-3333-4444-555555555555'), ENV, ctx as never)
    expect(res.status).toBe(404)
    const lookup = calls.find((c) => c.method === 'GET' && c.url.includes('public_token'))
    expect(lookup?.url).toContain('deleted_at=is.null')
  })
})
