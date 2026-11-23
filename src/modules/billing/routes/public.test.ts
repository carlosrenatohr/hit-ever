import { describe, expect, it } from 'vitest'
import { lineQtyLabel } from './public.js'

// The receipt's quantity column: weight lines print pounds, fixed lines print
// units (one guía = one unit). "1 envío" was confused with a shipping label.
describe('lineQtyLabel', () => {
  it('prints pounds for weight lines', () => {
    expect(lineQtyLabel({ unit: 'lbs', quantityLbs: 3.5, unitPrice: 7, total: 24.5 })).toBe('3.5 lb')
    expect(lineQtyLabel({ unit: null, quantityLbs: 10, unitPrice: 2, total: 20 })).toBe('10 lb')
  })

  it('prints one unit for a fixed line', () => {
    expect(lineQtyLabel({ unit: 'package', quantityLbs: 0, unitPrice: 25, total: 25 })).toBe('1 unidad')
  })

  it('derives plural units from total / unit price', () => {
    expect(lineQtyLabel({ unit: 'package', quantityLbs: 0, unitPrice: 25, total: 50 })).toBe('2 unidades')
  })

  it('falls back to a dash when a weight line has no quantity', () => {
    expect(lineQtyLabel({ unit: 'lbs', quantityLbs: null, unitPrice: 0, total: 0 })).toBe('-')
  })
})
