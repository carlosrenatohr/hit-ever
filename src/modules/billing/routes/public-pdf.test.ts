import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../../../index.js'

// Public receipt endpoints reach the worker directly (no auth, token-gated).
const ctx = { waitUntil() {}, passThroughOnException() {} }
const ENV = { INSFORGE_API_URL: 'https://db.test', INSFORGE_API_KEY: 'admin-key' } as never

afterEach(() => vi.unstubAllGlobals())

const header = {
  id: 'i1',
  invoice_number: 7,
  fiscal_year: 2026,
  client_id: 'c1',
  client_name_raw: 'Ana',
  issue_date: '2026-09-05',
  status: 'ISSUED',
  address: null,
  special_price: false,
  observations: null,
  tracking_orders: [],
  agent_id: null,
  public_token: null,
  paid_at: null,
  total: 32.5,
  profit: 10,
  paid_usd: 0,
  closed_at: '2026-09-05T10:00:00Z',
  closed_by: 'billing@hit.com',
  organization_id: 'hit',
  created_at: '',
  updated_at: '',
}
const line = {
  id: 'li1',
  invoice_id: 'i1',
  line_no: 1,
  line_type: 'freight',
  description: null,
  freight_type: 'AIR',
  quantity_lbs: 5,
  unit: 'lbs',
  unit_price: 6.5,
  total: 32.5,
  package_guia: '25001234',
  package_tracking: 'TRACK-1',
  package_id: 'p1',
}

function stubDb() {
  vi.stubGlobal('fetch', async (input: Request | string) => {
    const url = typeof input === 'string' ? input : input.url
    if (url.includes('/records/invoices?')) return new Response(JSON.stringify([header]), { status: 200 })
    if (url.includes('/records/invoice_line_items')) return new Response(JSON.stringify([line]), { status: 200 })
    if (url.includes('/records/invoice_packages')) return new Response(JSON.stringify([]), { status: 200 })
    if (url.includes('/records/agencies'))
      return new Response(JSON.stringify([{ name: 'HIT Cargo', logo_url: null, ruc: null, address: null, phone: null, currency: 'USD', exchange_rate_nio_per_usd: 37 }]), { status: 200 })
    return new Response('[]', { status: 200 })
  })
}

describe('GET /billing/r/:token/pdf', () => {
  it('downloads an on-the-fly PDF with attachment headers', async () => {
    stubDb()
    const token = 'a'.repeat(32)
    const res = await worker.fetch(new Request(`https://t.test/billing/r/${token}/pdf`), ENV, ctx)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('application/pdf')
    const cd = res.headers.get('Content-Disposition') ?? ''
    expect(cd).toMatch(/^attachment; filename="factura-7\.pdf"/)
    // The download name mirrors the receipt page title (UTF-8 via RFC 5987).
    expect(cd).toContain("filename*=UTF-8''Factura%20%237%20%E2%80%94%20HIT%20Cargo.pdf")
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-')
    expect(bytes.length).toBeGreaterThan(800)
  })

  it('404s on a malformed token without touching the DB', async () => {
    const res = await worker.fetch(new Request('https://t.test/billing/r/not-a-token/pdf'), ENV, ctx)
    expect(res.status).toBe(404)
  })
})