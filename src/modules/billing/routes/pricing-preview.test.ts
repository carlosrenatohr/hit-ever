import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../../../index.js'

// Stage 5: /api/billing/pricing-preview — the create-package form's financial
// summary. Guards: it never works without the agency flag, it resolves the
// card with the same order as create_package (client assignment → org default),
// and provider cost / profit are ONLY visible to admin|billing.

const ctx = { waitUntil() {}, passThroughOnException() {} }
const ENV = { INSFORGE_API_URL: 'https://db.test', INSFORGE_API_KEY: 'admin-key' } as never

const FIXED_CARD_ROW = {
  id: 'card-docs',
  organization_id: 'suite',
  name: 'Documentos',
  structure: 'simple_pair',
  pricing_kind: 'fixed',
  is_default: true,
  active: true,
  created_at: '2026-11-16T00:00:00.000Z',
  updated_at: '2026-11-16T00:00:00.000Z',
  rate_card_versions: [
    {
      id: 'ver-docs-1',
      version: 1,
      price_model: 'fixed',
      currency: 'USD',
      status: 'published',
      created_at: '2026-11-16T00:00:00.000Z',
      updated_at: '2026-11-16T00:00:00.000Z',
      rate_card_entries: [
        { id: 'ent-air', service_type: 'AIR', name: 'Documentos', unit: 'package', price: 25, cost: 8 },
        { id: 'ent-mar', service_type: 'MAR', name: 'Documentos', unit: 'package', price: 20, cost: 6 },
      ],
    },
  ],
}

function stubBackend(opts: { role?: string; flag?: boolean; cards?: unknown[]; assignments?: unknown[] } = {}) {
  return vi.stubGlobal('fetch', async (input: Request | string) => {
    const url = typeof input === 'string' ? input : input.url
    const auth = url.includes('/api/auth/sessions/current') ? '' : ''
    void auth
    if (url.includes('/api/auth/sessions/current')) {
      return new Response(JSON.stringify({ user: { id: 'u1', email: 'u1@test' } }), { status: 200 })
    }
    if (url.includes('/api/database/records/app_users')) {
      return new Response(JSON.stringify([{ role: opts.role ?? 'admin', active: true, agency: 'suite' }]), { status: 200 })
    }
    if (url.includes('/api/database/records/agencies')) {
      return new Response(JSON.stringify([{ flexible_pricing_enabled: opts.flag ?? true }]), { status: 200 })
    }
    if (url.includes('/api/database/records/rate_cards')) {
      return new Response(JSON.stringify(opts.cards ?? [FIXED_CARD_ROW]), { status: 200 })
    }
    if (url.includes('/api/database/records/client_rate_assignments')) {
      return new Response(JSON.stringify(opts.assignments ?? []), { status: 200 })
    }
    return new Response('not found', { status: 404 })
  })
}

afterEach(() => vi.unstubAllGlobals())

const URL = 'https://t.test/api/billing/pricing-preview?serviceType=aereo&clientId=c1'

describe('GET /api/billing/pricing-preview', () => {
  it('resolves the fixed card and returns charge (unit package, quantity 1)', async () => {
    stubBackend({ role: 'admin' })
    const res = await worker.fetch(new Request(URL, { headers: { Authorization: 'Bearer goodToken' } }), ENV, ctx as never)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { cardName: string; customerCharge: number; customerUnit: string; quantity: number; providerCost: number; grossProfit: number } }
    expect(body.data.cardName).toBe('Documentos')
    expect(body.data.customerCharge).toBe(25)
    expect(body.data.customerUnit).toBe('package')
    expect(body.data.quantity).toBe(1)
    expect(body.data.providerCost).toBe(8)
    expect(body.data.grossProfit).toBe(17)
  })

  it('hides provider cost and profit from staff', async () => {
    stubBackend({ role: 'staff' })
    const res = await worker.fetch(new Request(URL, { headers: { Authorization: 'Bearer goodToken' } }), ENV, ctx as never)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: Record<string, unknown> }
    expect(body.data.customerCharge).toBe(25)
    expect('providerCost' in body.data).toBe(false)
    expect('grossProfit' in body.data).toBe(false)
  })

  it('403 FEATURE_NOT_ENABLED for agencies without the flag', async () => {
    stubBackend({ flag: false })
    const res = await worker.fetch(new Request(URL, { headers: { Authorization: 'Bearer goodToken' } }), ENV, ctx as never)
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('FEATURE_NOT_ENABLED')
  })

  it('404 NO_RATE_CONFIGURED when no fixed card applies', async () => {
    stubBackend({ cards: [{ ...FIXED_CARD_ROW, active: false }] })
    const res = await worker.fetch(new Request(URL, { headers: { Authorization: 'Bearer goodToken' } }), ENV, ctx as never)
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('NO_RATE_CONFIGURED')
  })
})
