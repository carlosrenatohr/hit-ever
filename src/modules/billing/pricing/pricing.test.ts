import { describe, expect, it } from 'vitest'
import { buildFixedPackageSnapshot, resolvePackageCard, type RateAssignment } from './pricing.js'
import type { OrgRateCard } from '../repo/billing-repo.js'

function card(id: string, name: string, kind: string, entries: { mode: 'AIR' | 'MAR'; price: number; cost: number | null }[], extra?: Partial<OrgRateCard>): OrgRateCard {
  return {
    id,
    name,
    priceModel: kind === 'weight' ? 'weight' : kind,
    currency: 'USD',
    versionId: `${id}-v1`,
    pricingKind: kind,
    active: true,
    entries: entries.map((e) => ({ id: `${id}-${e.mode}`, serviceType: e.mode, name: name, unit: kind === 'fixed' ? 'package' : 'lb', price: e.price, cost: e.cost })),
    ...extra,
  }
}

const docs = card('c-docs', 'Documentos', 'fixed', [{ mode: 'AIR', price: 25, cost: 8 }, { mode: 'MAR', price: 20, cost: 6 }])
const express = card('c-exp', 'Courier Expreso', 'fixed', [{ mode: 'AIR', price: 40, cost: 12 }, { mode: 'MAR', price: 30, cost: 9 }])
const weight = card('c-w', 'Estándar', 'weight', [{ mode: 'AIR', price: 6.5, cost: 4.3 }, { mode: 'MAR', price: 2.5, cost: 1.3 }])

const assignments: RateAssignment[] = [
  { rateCardId: 'c-exp', pricingKind: 'fixed', transportMode: null, active: true },
]

describe('resolvePackageCard (fixed-first)', () => {
  it('explicit card wins over every default', () => {
    const picked = resolvePackageCard([docs, express], { pricingKind: 'fixed', transportMode: 'AIR', explicitCardId: 'c-docs', clientAssignments: assignments })
    expect(picked?.id).toBe('c-docs')
  })

  it('client assignment wins over the org default', () => {
    const picked = resolvePackageCard([docs, express], { pricingKind: 'fixed', transportMode: 'AIR', clientAssignments: assignments, orgDefaultCardId: 'c-docs' })
    expect(picked?.id).toBe('c-exp')
  })

  it('org default applies when the client has no assignment', () => {
    const picked = resolvePackageCard([docs, express], { pricingKind: 'fixed', transportMode: 'MAR', orgDefaultCardId: 'c-docs' })
    expect(picked?.id).toBe('c-docs')
  })

  it('falls back to the first active kind card with a mode entry', () => {
    const picked = resolvePackageCard([express, docs], { pricingKind: 'fixed', transportMode: 'MAR' })
    expect(picked?.id).toBe('c-exp')
  })

  it('returns null when nothing applies — callers error, never guess', () => {
    expect(resolvePackageCard([weight], { pricingKind: 'fixed', transportMode: 'AIR' })).toBeNull()
    expect(resolvePackageCard([docs], { pricingKind: 'fixed', transportMode: 'AIR', explicitCardId: 'missing' })).toBeNull()
  })

  it('an explicit card of the wrong kind does not silently fall back', () => {
    expect(resolvePackageCard([docs, weight], { pricingKind: 'fixed', transportMode: 'AIR', explicitCardId: 'c-w' })).toBeNull()
  })

  it('inactive cards are never resolved', () => {
    const inactive = card('c-off', 'Fuera de servicio', 'fixed', [{ mode: 'AIR', price: 25, cost: 8 }], { active: false })
    expect(resolvePackageCard([inactive], { pricingKind: 'fixed', transportMode: 'AIR' })).toBeNull()
  })
})

describe('buildFixedPackageSnapshot', () => {
  it('charges exactly the configured price — pieces and weight never participate', () => {
    const snap = buildFixedPackageSnapshot(docs, 'AIR')
    expect(snap).toMatchObject({
      rateCardId: 'c-docs',
      rateCardEntryId: 'c-docs-AIR',
      pricingKind: 'fixed',
      customerPriceModel: 'FIXED',
      customerUnit: 'package',
      customerRate: 25,
      customerCharge: 25,
      providerCostModel: 'FIXED',
      providerCost: 8,
      currency: 'USD',
    })
  })

  it('uses the mode entry (AIR vs MAR differ)', () => {
    expect(buildFixedPackageSnapshot(docs, 'MAR')?.customerCharge).toBe(20)
    expect(buildFixedPackageSnapshot(docs, 'MAR')?.providerCost).toBe(6)
  })

  it('returns null when the card has no entry for the mode', () => {
    const airOnly = card('c-a', 'Solo Aéreo', 'fixed', [{ mode: 'AIR', price: 25, cost: 8 }])
    expect(buildFixedPackageSnapshot(airOnly, 'MAR')).toBeNull()
  })
})
