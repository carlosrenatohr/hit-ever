// ============================================================================
// Ingest intermediate shapes — what SheetAdapters produce and migrate consumes.
// ============================================================================
// Adapters only EXTRACT sheet cells (no catalog access). migrate.ts then recomputes
// canonical amounts, infers the tier, dedupes clients, upserts, and links packages.

import type { FreightType } from '../domain/enums.js'
import type { NormalizedPayment } from './normalize/payment.js'

/** One sheet row as primitive cells (formulas already unwrapped to their result). */
export type RawRow = Array<string | number | Date | null | undefined>

export interface ParsedLineItem {
  description: string | null
  freightType: FreightType | null // null if unresolved (drop/flag downstream)
  quantityLbs: number
  unitPrice: number
  // Raw sheet figures (validated against the recomputed canonical values):
  sheetTotal: number | null
  listPrice: number | null
  sheetFreightCost: number | null
  sheetProfit: number | null
}

export interface ParsedInvoice {
  invoiceNumber: number
  fiscalYear: number
  clientRaw: string
  isVoid: boolean
  issueDate: string | null // ISO yyyy-mm-dd
  paidAt: string | null // ISO yyyy-mm-dd (Fecha de Pago)
  address: string | null
  specialPrice: boolean
  observations: string | null
  oc: string[]
  payment: NormalizedPayment | null
  lines: ParsedLineItem[]
  source: { sheet: string; rows: number[] }
}

export interface SheetAdapter {
  readonly sheetName: string
  extract(rows: RawRow[], fiscalYear: number): ParsedInvoice[]
}
