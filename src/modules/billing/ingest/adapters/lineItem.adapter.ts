// ============================================================================
// Line-item adapter — the 2025 sheet (N contiguous rows per invoice).
// ============================================================================
// Rows carry the invoice number; the same number can repeat across several rows
// (that is NOT an error — they are the invoice's line-items). A continuation row
// may also omit the number while still carrying line data; it attaches to the
// current invoice. Subtotal rows ("TOTAL ...") reset the grouping.

import { isVoidClient } from '../normalize/client.js'
import { freightFromTipo, parseOc } from '../normalize/freight.js'
import { normalizePayment } from '../normalize/payment.js'
import type { ParsedInvoice, ParsedLineItem, RawRow, SheetAdapter } from '../types.js'
import { COLS_2025 as C, isSubtotalRow, num, str, toBool, toInvoiceNumber, toIsoDate } from './shared.js'

function buildLine(r: RawRow): ParsedLineItem {
  return {
    description: str(r[C.desc]),
    freightType: freightFromTipo(r[C.tipo]),
    quantityLbs: num(r[C.lbs]) ?? 0,
    unitPrice: num(r[C.unitPrice]) ?? 0,
    sheetTotal: num(r[C.total]),
    listPrice: num(r[C.listPrice]),
    sheetFreightCost: num(r[C.cost]),
    sheetProfit: num(r[C.profit]),
  }
}

function hasLineData(r: RawRow): boolean {
  return num(r[C.lbs]) != null || num(r[C.unitPrice]) != null || freightFromTipo(r[C.tipo]) != null
}

export class LineItemAdapter implements SheetAdapter {
  constructor(public readonly sheetName: string) {}

  extract(rows: RawRow[], fiscalYear: number): ParsedInvoice[] {
    const byNumber = new Map<number, ParsedInvoice>()
    let current: ParsedInvoice | null = null

    for (let i = 1; i < rows.length; i++) {
      const r = rows[i]
      const sheetRow = i + 1
      if (isSubtotalRow(r[C.num])) {
        current = null
        continue
      }
      const invoiceNumber = toInvoiceNumber(r[C.num])

      if (invoiceNumber != null) {
        let inv = byNumber.get(invoiceNumber)
        if (!inv) {
          const isVoid = isVoidClient(r[C.client])
          inv = {
            invoiceNumber,
            fiscalYear,
            clientRaw: str(r[C.client]) ?? '',
            isVoid,
            issueDate: toIsoDate(r[C.date]),
            paidAt: toIsoDate(r[C.payDate]),
            address: str(r[C.address]),
            specialPrice: toBool(r[C.special]),
            observations: str(r[C.obs]),
            oc: parseOc(r[C.oc]),
            payment: isVoid ? null : normalizePayment(r[C.pago]),
            lines: [],
            source: { sheet: this.sheetName, rows: [] },
          }
          byNumber.set(invoiceNumber, inv)
        }
        current = inv
        inv.source.rows.push(sheetRow)
        if (!inv.isVoid && hasLineData(r)) inv.lines.push(buildLine(r))
      } else if (current && hasLineData(r)) {
        // Continuation line (number omitted) for the current invoice.
        current.lines.push(buildLine(r))
        current.source.rows.push(sheetRow)
      }
      // else: blank/garbage row -> skip.
    }

    return [...byNumber.values()]
  }
}
