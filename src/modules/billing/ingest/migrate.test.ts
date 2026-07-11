import { describe, expect, it } from 'vitest'
import type { FreightType } from '../domain/enums.js'
import type { CatalogEntry } from '../domain/types.js'
import { buildLineRows, buildPaymentRows, deriveStatus, isEmptyPlaceholder } from './migrate.js'
import { normalizePayment } from './normalize/payment.js'
import type { ParsedInvoice } from './types.js'

const CATALOG = new Map<FreightType, CatalogEntry>([
  ['AIR', { freightType: 'AIR', cost: 4.5, tiers: { REGULAR: 6.5, ESPECIAL: 6.0, VIP: 5.5, MADRES: 6.25, DARIO: 4.3 } }],
  ['MAR', { freightType: 'MAR', cost: 1.25, tiers: { REGULAR: 2.5, ESPECIAL: 2.3, VIP: 2.25, MADRES: null, DARIO: 1.3 } }],
])

function inv(over: Partial<ParsedInvoice>): ParsedInvoice {
  return {
    invoiceNumber: 1,
    fiscalYear: 2026,
    clientRaw: 'Test',
    isVoid: false,
    issueDate: '2026-01-01',
    paidAt: null,
    address: null,
    specialPrice: false,
    observations: null,
    oc: [],
    payment: null,
    lines: [],
    source: { sheet: 't', rows: [2] },
    ...over,
  }
}

describe('deriveStatus', () => {
  it('VOID / PARTIAL / PAID / ISSUED', () => {
    expect(deriveStatus(inv({ isVoid: true }))).toBe('VOID')
    expect(deriveStatus(inv({ payment: normalizePayment('PARCIAL') }))).toBe('PARTIAL')
    expect(deriveStatus(inv({ payment: normalizePayment('BAC USD') }))).toBe('PAID')
    expect(deriveStatus(inv({ payment: normalizePayment('No PAGO') }))).toBe('ISSUED')
    expect(deriveStatus(inv({ payment: null }))).toBe('ISSUED')
  })
})

describe('isEmptyPlaceholder', () => {
  it('true only when no client, no lines and no payment', () => {
    expect(isEmptyPlaceholder(inv({ clientRaw: '', lines: [], payment: null }))).toBe(true)
    expect(isEmptyPlaceholder(inv({ clientRaw: 'Petra' }))).toBe(false)
  })
})

describe('buildLineRows', () => {
  it('recomputes canonical amounts and infers the tier', () => {
    const i = inv({
      lines: [{ description: null, freightType: 'AIR', quantityLbs: 5, unitPrice: 6.5, sheetTotal: 32.5, listPrice: null, sheetFreightCost: 22.5, sheetProfit: 10 }],
    })
    const { rows, priceOffCatalog, mismatches, storedTotal, canonicalTotal } = buildLineRows(i, CATALOG)
    expect(rows[0]).toMatchObject({ total: 32.5, freight_cost: 22.5, profit: 10, price_tier: 'REGULAR', price_off_catalog: false })
    expect(priceOffCatalog).toBe(0)
    expect(mismatches).toHaveLength(0)
    expect(storedTotal).toBe(32.5)
    expect(canonicalTotal).toBe(32.5)
  })

  it('flags an off-catalog price and records a mismatch when the sheet total disagrees', () => {
    const i = inv({
      lines: [{ description: null, freightType: 'AIR', quantityLbs: 2, unitPrice: 7.99, sheetTotal: 99, listPrice: null, sheetFreightCost: null, sheetProfit: null }],
    })
    const { rows, priceOffCatalog, mismatches } = buildLineRows(i, CATALOG)
    expect(rows[0].price_off_catalog).toBe(true)
    expect(priceOffCatalog).toBe(1)
    expect(mismatches[0]).toMatchObject({ field: 'total', sheet: 99, computed: 15.98 })
  })
})

describe('buildPaymentRows', () => {
  it('creates a row for every non-empty Pago cell, quarantining junk', () => {
    expect(buildPaymentRows(inv({ payment: normalizePayment('BAC USD') })).rows).toHaveLength(1)
    expect(buildPaymentRows(inv({ payment: normalizePayment('?') })).quarantined).toBe(1)
    expect(buildPaymentRows(inv({ payment: normalizePayment('') })).rows).toHaveLength(0)
    expect(buildPaymentRows(inv({ payment: null })).rows).toHaveLength(0)
  })
})
