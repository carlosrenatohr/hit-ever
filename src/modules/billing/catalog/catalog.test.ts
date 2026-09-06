import { describe, expect, it } from 'vitest'
import { resolveOrgRate } from '../catalog/catalog.js'
import type { OrgRateTable } from '../repo/billing-repo.js'

const tables: OrgRateTable[] = [
  {
    id: 't-std',
    name: 'Estándar',
    freightType: 'AIR',
    rows: [{ tier: 'REGULAR', price: 7, cost: 4.5, priceModel: 'weight' }],
  },
  {
    id: 't-vip',
    name: 'VIP',
    freightType: 'AIR',
    rows: [
      { tier: 'REGULAR', price: 6, cost: 4.5, priceModel: 'weight' },
      { tier: 'VIP', price: 5.5, cost: 4.5, priceModel: 'weight' },
    ],
  },
  {
    id: 't-mar',
    name: 'Estándar',
    freightType: 'MAR',
    rows: [{ tier: 'REGULAR', price: 2.8, cost: 1.25, priceModel: 'weight' }],
  },
]

describe('resolveOrgRate', () => {
  it('uses the client default table first, even when another table matches', () => {
    const r = resolveOrgRate(tables, 'AIR', 'REGULAR', 't-vip')
    expect(r).toEqual({ price: 6, cost: 4.5, priceModel: 'weight' })
  })

  it('ignores the default table when its freight does not match', () => {
    const r = resolveOrgRate(tables, 'MAR', 'REGULAR', 't-vip')
    expect(r).toEqual({ price: 2.8, cost: 1.25, priceModel: 'weight' })
  })

  it('falls back to the first org table offering the tier for that freight', () => {
    const r = resolveOrgRate(tables, 'AIR', 'VIP', null)
    expect(r).toEqual({ price: 5.5, cost: 4.5, priceModel: 'weight' })
  })

  it('resolves custom (dynamic) tier names the org invents', () => {
    const custom: OrgRateTable[] = [{ id: 't-x', name: 'Promo', freightType: 'MAR', rows: [{ tier: 'MAYORISTA', price: 2, cost: 1, priceModel: 'weight' }] }]
    expect(resolveOrgRate(custom, 'MAR', 'MAYORISTA', null)).toEqual({ price: 2, cost: 1, priceModel: 'weight' })
  })

  it('returns null when no org table offers the tier (caller falls back to legacy catalog)', () => {
    expect(resolveOrgRate(tables, 'AIR', 'MADRES', null)).toBeNull()
  })

  it('skips a default table id that does not belong to the org', () => {
    const r = resolveOrgRate(tables, 'AIR', 'REGULAR', 't-otra-org')
    expect(r).toEqual({ price: 7, cost: 4.5, priceModel: 'weight' })
  })
})
