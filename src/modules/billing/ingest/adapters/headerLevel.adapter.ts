// ============================================================================
// Header-level adapter — the 2026 Q1/Q2/Q3 sheets (1 row = 1 invoice = 1 line).
// ============================================================================

import { isVoidClient } from '../normalize/client.js'
import { freightFromTipo, parseOc } from '../normalize/freight.js'
import { normalizePayment } from '../normalize/payment.js'
import type { ParsedInvoice, ParsedLineItem, RawRow, SheetAdapter } from '../types.js'
import { COLS_2026 as C, isSubtotalRow, num, str, toBool, toInvoiceNumber, toIsoDate } from './shared.js'

export class HeaderLevelAdapter implements SheetAdapter {
  constructor(public readonly sheetName: string) {}

  /** `rows` includes the header at index 0; data starts at row 1 (sheet row = i + 1). */
  extract(rows: RawRow[], fiscalYear: number): ParsedInvoice[] {
    const out: ParsedInvoice[] = []
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i]
      if (isSubtotalRow(r[C.num])) continue
      const invoiceNumber = toInvoiceNumber(r[C.num])
      if (invoiceNumber == null) continue // blank / garbage row

      const isVoid = isVoidClient(r[C.client])
      const line: ParsedLineItem = {
        description: null,
        freightType: freightFromTipo(r[C.tipo]),
        quantityLbs: num(r[C.lbs]) ?? 0,
        unitPrice: num(r[C.unitPrice]) ?? 0,
        sheetTotal: num(r[C.total]),
        listPrice: num(r[C.listPrice]),
        sheetFreightCost: num(r[C.cost]),
        sheetProfit: num(r[C.profit]),
      }

      out.push({
        invoiceNumber,
        fiscalYear,
        clientRaw: str(r[C.client]) ?? '',
        isVoid,
        issueDate: toIsoDate(r[C.date]),
        paidAt: toIsoDate(r[C.payDate]),
        address: null,
        specialPrice: toBool(r[C.special]),
        observations: str(r[C.obs]),
        oc: parseOc(r[C.oc]),
        payment: isVoid ? null : normalizePayment(r[C.pago]),
        lines: isVoid || line.freightType == null ? [] : [line],
        source: { sheet: this.sheetName, rows: [i + 1] },
      })
    }
    return out
  }
}
