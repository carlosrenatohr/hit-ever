import { describe, expect, it } from 'vitest'
import { resolveOrgRate } from '../catalog/catalog.js'
import type { OrgRateCard, OrgRateTable } from '../repo/billing-repo.js'

const legacy: OrgRateTable[] = [
  { id: 't-std', name: 'Estándar', freightType: 'AIR', rows: [{ tier: 'REGULAR', price: 7, cost: 4.5, priceModel: 'weight' }] },
  { id: 't-mar', name: 'Estándar', freightType: 'MAR', rows: [{ tier: 'REGULAR', price: 2.8, cost: 1.25, priceModel: 'weight' }] },
]

const cards: OrgRateCard[] = [
  {
    id: 'c-std',
    name: 'Estándar',
    priceModel: 'weight',
    currency: 'USD',
    versionId: 'v-std',
    entries: [
      { id: 'e-air', serviceType: 'AIR', name: 'Regular', unit: 'lb', price: 7, cost: 4.5 },
      { id: 'e-mar', serviceType: 'MAR', name: 'Regular', unit: 'lb', price: 2.8, cost: 1.25 },
    ],
  },
  {
    id: 'c-vip',
    name: 'VIP',
    priceModel: 'weight',
    currency: 'USD',
    versionId: 'v-vip',
    entries: [
      { id: 'e-vip-air', serviceType: 'AIR', name: 'VIP', unit: 'lb', price: 5.5, cost: 4.5 },
      { id: 'e-vip-mar', serviceType: 'MAR', name: 'VIP', unit: 'lb', price: 2.25, cost: 1.25 },
    ],
  },
]

const base = { pricingSource: 'rate_card' } as const

describe('resolveOrgRate (v2 cards)', () => {
  it('uses the explicit card entry matching the service (AIR)', () => {
    const r = resolveOrgRate(cards, [], 'AIR', 'Regular', 'c-vip')
    expect(r).toEqual({ price: 5.5, cost: 4.5, priceModel: 'weight', ...base, rateCardId: 'c-vip', rateCardVersionId: 'v-vip', rateCardEntryId: 'e-vip-air' })
  })

  it('resolves MAR within the same card (service-based, not tier)', () => {
    const r = resolveOrgRate(cards, [], 'MAR', 'Regular', 'c-vip')
    expect(r?.price).toBe(2.25)
    expect(r?.rateCardId).toBe('c-vip')
    expect(r?.rateCardEntryId).toBe('e-vip-mar')
  })

  it('falls back to the first card offering the service when no explicit id', () => {
    const r = resolveOrgRate(cards, [], 'AIR', 'CustomName', null)
    expect(r?.price).toBe(7)
    expect(r?.rateCardId).toBe('c-std')
  })

  it('resolves an unknown explicit id from any card (not legacy)', () => {
    const r = resolveOrgRate(cards, legacy, 'AIR', 'Regular', 'not-ours')
    expect(r?.pricingSource).toBe('rate_card')
    expect(r?.price).toBe(7)
  })

  it('falls to legacy tables only when cards do not offer the service', () => {
    const r = resolveOrgRate([], legacy, 'AIR', 'REGULAR', null)
    expect(r).toEqual({ price: 7, cost: 4.5, priceModel: 'weight', pricingSource: 'legacy' })
  })

  it('uses a legacy default table id for unmigrated orgs', () => {
    const r = resolveOrgRate([], legacy, 'MAR', 'REGULAR', 't-mar')
    expect(r).toEqual({ price: 2.8, cost: 1.25, priceModel: 'weight', pricingSource: 'legacy' })
  })

  it('cards resolve by service (tier is informational) — a card offering AIR prices it', () => {
    expect(resolveOrgRate(cards, [], 'AIR', 'MADRES', null)?.price).toBe(7)
    expect(resolveOrgRate(cards, [], 'MAR', 'ANYNAME', null)?.price).toBe(2.8)
  })

  it('returns null when nothing offers the line', () => {
    // Legacy path: MADRES has no AIR row in the fixtures.
    expect(resolveOrgRate([], legacy, 'AIR', 'MADRES', null)).toBeNull()
    // No cards and no legacy tables at all.
    expect(resolveOrgRate([], [], 'AIR', 'REGULAR', null)).toBeNull()
  })
})