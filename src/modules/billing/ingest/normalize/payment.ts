// ============================================================================
// Payment normalization — turns the Excel `Pago` free-text into a canonical shape.
// ============================================================================
// The column has 14+ variants for the same thing plus junk. Everything must land
// either in the canonical shape or in quarantine (raw kept) — never silently lost.
// See the plan §3.4. Examples handled:
//   'BAC USD' | 'BAC dolares' | 'Bac dolares' | 'BAC'  -> BANK_TRANSFER / BAC / USD
//   'BAC NIO' | 'BAC cordobas'                          -> BANK_TRANSFER / BAC / NIO
//   'Lafise USD' | 'Lafise Hit' | 'Lafise'             -> BANK_TRANSFER / LAFISE / USD?
//   'Banpro May'                                        -> BANK_TRANSFER / BANPRO
//   'EFECTIVO' | 'Efectivo'                             -> CASH
//   'SALDO A FAVOR'                                     -> CREDIT_BALANCE
//   'PARCIAL'                                           -> isPartial (not a method)
//   'No PAGO'                                           -> isNoPayment (not a method)
//   '?' | '-' | '' | '60' | '6.75'                      -> quarantined

import type { Currency, PaymentBank, PaymentMethod } from '../../domain/enums.js'

export interface NormalizedPayment {
  method: PaymentMethod | null
  bank: PaymentBank | null
  currency: Currency | null
  quarantined: boolean
  isPartial: boolean
  isNoPayment: boolean
  raw: string
}

export function normalizePayment(rawInput: unknown): NormalizedPayment {
  const raw = rawInput == null ? '' : String(rawInput)
  const s = raw.trim().toLowerCase()

  const base = { method: null, bank: null, currency: null, quarantined: false, isPartial: false, isNoPayment: false, raw } as NormalizedPayment

  // Empty / pure-numeric / placeholder junk -> quarantine.
  if (s === '' || s === '?' || s === '-' || /^\d+(\.\d+)?$/.test(s)) {
    return { ...base, quarantined: true }
  }

  // Status signals that are NOT payment methods.
  if (/no\s*pag/.test(s)) return { ...base, isNoPayment: true }
  if (/parcial/.test(s)) return { ...base, isPartial: true }

  const bank: PaymentBank | null = /bac/.test(s)
    ? 'BAC'
    : /lafise/.test(s)
      ? 'LAFISE'
      : /banpro/.test(s)
        ? 'BANPRO'
        : null

  const currency: Currency | null = /(usd|dolar|dólar)/.test(s)
    ? 'USD'
    : /(nio|cordob|córdob)/.test(s)
      ? 'NIO'
      : null

  const method: PaymentMethod | null = /efectivo/.test(s)
    ? 'CASH'
    : /saldo a favor/.test(s)
      ? 'CREDIT_BALANCE'
      : bank
        ? 'BANK_TRANSFER'
        : null

  // Recognized nothing (e.g. a stray note) -> quarantine so a human reviews it.
  if (method === null && bank === null && currency === null) {
    return { ...base, quarantined: true }
  }

  return { ...base, method, bank, currency }
}
