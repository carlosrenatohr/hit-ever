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

const WEIGHT_CARD_ROW = {
  id: 'card-std',
  organization_id: 'suite',
  name: 'Estándar',
  structure: 'simple_pair',
  pricing_kind: 'weight',
  is_default: true,
  active: true,
  created_at: '2026-11-16T00:00:00.000Z',
  updated_at: '2026-11-16T00:00:00.000Z',
  rate_card_versions: [
    {
      id: 'ver-std-1',
      version: 1,
      price_model: 'weight',
      currency: 'USD',
      status: 'published',
      created_at: '2026-11-16T00:00:00.000Z',
      updated_at: '2026-11-16T00:00:00.000Z',
      rate_card_entries: [
        { id: 'ent-std-air', service_type: 'AIR', name: 'Regular', unit: 'lb', price: 7, cost: 4.5 },
        { id: 'ent-std-mar', service_type: 'MAR', name: 'Regular', unit: 'lb', price: 2.8, cost: 1.25 },
      ],
    },
  ],
}

const VIP_WEIGHT_CARD_ROW = {
  id: 'card-vip',
  organization_id: 'suite',
  name: 'Cliente VIP',
  structure: 'simple_pair',
  pricing_kind: 'weight',
  is_default: false,
  active: true,
  created_at: '2026-11-16T00:00:00.000Z',
  updated_at: '2026-11-16T00:00:00.000Z',
  rate_card_versions: [
    {
      id: 'ver-vip-1',
      version: 1,
      price_model: 'weight',
      currency: 'USD',
      status: 'published',
      created_at: '2026-11-16T00:00:00.000Z',
      updated_at: '2026-11-16T00:00:00.000Z',
      rate_card_entries: [
        { id: 'ent-vip-air', service_type: 'AIR', name: 'Regular', unit: 'lb', price: 5, cost: 3 },
        { id: 'ent-vip-mar', service_type: 'MAR', name: 'Regular', unit: 'lb', price: 2, cost: 1 },
      ],
    },
  ],
}

function stubBackend(opts: { role?: string; flag?: boolean; cards?: unknown[]; assignments?: unknown[]; clientDefaultCardId?: string | null } = {}) {
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
    if (url.includes('/api/database/records/billing_clients')) {
      const row = {
        id: 'c1', name: 'Ana', name_normalized: 'ana', casillero: null, to_review: false,
        email: null, phone: null, address: null, company_name: null, tax_id: null,
        active: true, deleted_at: null, default_rate_id: null,
        default_rate_card_id: opts.clientDefaultCardId ?? null,
      }
      return new Response(JSON.stringify([row]), { status: 200 })
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

  it('prices a weight preview with the resolved weight card (price × lb)', async () => {
    stubBackend({ role: 'admin', cards: [WEIGHT_CARD_ROW] })
    const res = await worker.fetch(new Request(`${URL}&pricingKind=weight&weightLb=5`, { headers: { Authorization: 'Bearer goodToken' } }), ENV, ctx as never)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: { cardName: string; pricingKind: string; customerRate: number; customerCharge: number; customerUnit: string; quantity: number; providerCost: number; grossProfit: number }
    }
    expect(body.data.pricingKind).toBe('weight')
    expect(body.data.cardName).toBe('Estándar')
    expect(body.data.customerRate).toBe(7)
    expect(body.data.customerUnit).toBe('lb')
    expect(body.data.quantity).toBe(5)
    expect(body.data.customerCharge).toBe(35)
    expect(body.data.providerCost).toBe(22.5)
    expect(body.data.grossProfit).toBe(12.5)
  })

  it('hides cost and profit from staff on a weight preview too', async () => {
    stubBackend({ role: 'staff', cards: [WEIGHT_CARD_ROW] })
    const res = await worker.fetch(new Request(`${URL}&pricingKind=weight&weightLb=2`, { headers: { Authorization: 'Bearer goodToken' } }), ENV, ctx as never)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: Record<string, unknown> }
    expect(body.data.customerCharge).toBe(14)
    expect('providerCost' in body.data).toBe(false)
    expect('grossProfit' in body.data).toBe(false)
  })

  it('422 when a weight preview has no weight to price', async () => {
    stubBackend({ role: 'admin', cards: [WEIGHT_CARD_ROW] })
    const res = await worker.fetch(new Request(`${URL}&pricingKind=weight`, { headers: { Authorization: 'Bearer goodToken' } }), ENV, ctx as never)
    expect(res.status).toBe(422)
  })

  it('uses the client profile default weight tariff over the agency default', async () => {
    stubBackend({ role: 'admin', cards: [WEIGHT_CARD_ROW, VIP_WEIGHT_CARD_ROW], clientDefaultCardId: 'card-vip' })
    const res = await worker.fetch(new Request(`${URL}&pricingKind=weight&weightLb=10`, { headers: { Authorization: 'Bearer goodToken' } }), ENV, ctx as never)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { cardName: string; customerRate: number; customerCharge: number } }
    expect(body.data.cardName).toBe('Cliente VIP')
    expect(body.data.customerRate).toBe(5)
    expect(body.data.customerCharge).toBe(50)
  })

  it('never prices a weight preview with a fixed card', async () => {
    stubBackend({ role: 'admin', cards: [FIXED_CARD_ROW] })
    const res = await worker.fetch(new Request(`${URL}&pricingKind=weight&weightLb=3`, { headers: { Authorization: 'Bearer goodToken' } }), ENV, ctx as never)
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('NO_RATE_CONFIGURED')
  })
})
