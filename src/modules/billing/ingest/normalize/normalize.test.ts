import { describe, expect, it } from 'vitest'
import { isVoidClient, normalizeClientName } from './client.js'
import { freightFromTipo, parseOc } from './freight.js'
import { normalizePayment } from './payment.js'

describe('normalizePayment', () => {
  it('maps the many BAC/Lafise/Banpro variants', () => {
    expect(normalizePayment('BAC USD')).toMatchObject({ method: 'BANK_TRANSFER', bank: 'BAC', currency: 'USD' })
    expect(normalizePayment('Bac dolares')).toMatchObject({ method: 'BANK_TRANSFER', bank: 'BAC', currency: 'USD' })
    expect(normalizePayment('BAC cordobas')).toMatchObject({ bank: 'BAC', currency: 'NIO' })
    expect(normalizePayment('Lafise Hit')).toMatchObject({ bank: 'LAFISE', method: 'BANK_TRANSFER' })
    expect(normalizePayment('Banpro May')).toMatchObject({ bank: 'BANPRO' })
    expect(normalizePayment('EFECTIVO')).toMatchObject({ method: 'CASH' })
    expect(normalizePayment('SALDO A FAVOR')).toMatchObject({ method: 'CREDIT_BALANCE' })
  })

  it('flags PARCIAL and No PAGO as status signals, not methods', () => {
    expect(normalizePayment('PARCIAL')).toMatchObject({ isPartial: true, method: null })
    expect(normalizePayment('No PAGO')).toMatchObject({ isNoPayment: true, method: null })
  })

  it('quarantines junk with the raw kept (nothing lost)', () => {
    for (const junk of ['?', '-', '', '60', '6.75']) {
      const p = normalizePayment(junk)
      expect(p.quarantined).toBe(true)
      expect(p.raw).toBe(junk)
    }
  })
})

describe('normalizeClientName', () => {
  it('trims, collapses spaces, and builds a stable dedupe key', () => {
    const a = normalizeClientName('Yardley Chavarria ')
    const b = normalizeClientName('  yardley   chavarria')
    expect(a.key).toBe(b.key)
    expect(a.display).toBe('Yardley Chavarria')
  })
  it('detects ANULADO', () => {
    expect(isVoidClient('ANULADO')).toBe(true)
    expect(isVoidClient('anulado ')).toBe(true)
    expect(isVoidClient('Petra')).toBe(false)
  })
})

describe('freightFromTipo', () => {
  it('handles numeric codes and strings', () => {
    expect(freightFromTipo(1)).toBe('AIR')
    expect(freightFromTipo(2)).toBe('MAR')
    expect(freightFromTipo(2.0)).toBe('MAR')
    expect(freightFromTipo('AIR')).toBe('AIR')
    expect(freightFromTipo(null)).toBeNull()
    expect(freightFromTipo('')).toBeNull()
  })
})

describe('parseOc', () => {
  it('splits CSV tokens and keeps digit runs', () => {
    expect(parseOc('172018, 171003, 170955')).toEqual(['172018', '171003', '170955'])
    expect(parseOc('800799')).toEqual(['800799'])
  })
  it('best-effort splits a float where a comma was eaten', () => {
    expect(parseOc(663714.6648)).toEqual(['663714', '6648'])
    expect(parseOc(655218)).toEqual(['655218'])
  })
})
