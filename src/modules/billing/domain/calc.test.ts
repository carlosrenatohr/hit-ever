import { describe, expect, it } from 'vitest'
import { amountsDiffer, computeAmounts, inferTier, margin, quoteLine, tierPrice } from './calc.js'
import type { CatalogEntry } from './types.js'

// Real catalog values from the Excel `BD` sheet.
const AIR: CatalogEntry = {
  freightType: 'AIR',
  cost: 4.5,
  tiers: { REGULAR: 6.5, ESPECIAL: 6.0, VIP: 5.5, MADRES: 6.25, DARIO: 4.3 },
}
const MAR: CatalogEntry = {
  freightType: 'MAR',
  cost: 1.25,
  tiers: { REGULAR: 2.5, ESPECIAL: 2.3, VIP: 2.25, MADRES: null, DARIO: 1.3 },
}

describe('computeAmounts', () => {
  it('matches the real Rikkert row: 5 lbs AIR @ 6.5 → total 32.5, cost 22.5, profit 10', () => {
    const a = computeAmounts(5, 6.5, 4.5)
    expect(a.total).toBe(32.5)
    expect(a.freightCost).toBe(22.5)
    expect(a.profit).toBe(10)
  })

  it('avoids float drift (7.7 lbs MAR @ 2.5)', () => {
    const a = computeAmounts(7.7, 2.5, 1.25)
    expect(a.total).toBe(19.25)
    expect(a.freightCost).toBe(9.63) // 9.625 rounded to 2dp
  })
})

describe('margin', () => {
  it('is profit/total, null when total is 0', () => {
    expect(margin(32.5, 10)).toBe(0.3077)
    expect(margin(0, 0)).toBeNull()
  })
})

describe('tierPrice / quoteLine', () => {
  it('returns the tier price, null for a tier not offered', () => {
    expect(tierPrice(AIR, 'REGULAR')).toBe(6.5)
    expect(tierPrice(MAR, 'MADRES')).toBeNull()
  })

  it('quotes a full line and refuses an unoffered tier', () => {
    const q = quoteLine(MAR, 'ESPECIAL', 10)
    expect(q).not.toBeNull()
    expect(q?.total).toBe(23)
    expect(q?.freightCost).toBe(12.5)
    expect(q?.profit).toBe(10.5)
    expect(quoteLine(MAR, 'MADRES', 10)).toBeNull()
  })
})

describe('inferTier', () => {
  it('maps a hand-typed price back to its tier within tolerance', () => {
    expect(inferTier(AIR, 6.5)).toBe('REGULAR')
    expect(inferTier(AIR, 6.0)).toBe('ESPECIAL')
    expect(inferTier(AIR, 4.3)).toBe('DARIO')
    expect(inferTier(MAR, 2.25)).toBe('VIP')
  })

  it('returns null for an off-catalog price', () => {
    expect(inferTier(AIR, 7.99)).toBeNull()
  })
})

describe('amountsDiffer', () => {
  it('respects the 0.01 tolerance', () => {
    expect(amountsDiffer(19.25, 19.254)).toBe(false)
    expect(amountsDiffer(19.25, 19.3)).toBe(true)
  })
})
