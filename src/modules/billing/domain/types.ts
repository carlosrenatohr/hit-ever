// ============================================================================
// Billing canonical domain types.
// ============================================================================
// Application-facing shapes (camelCase). DB row shapes (snake_case) live next to
// the repository. Derived amounts (total/profit/margin/commission) are produced by
// domain/calc.ts and are always recomputed, never trusted from input.

import type {
  Currency,
  FreightType,
  InvoiceStatus,
  PaymentBank,
  PaymentMethod,
  PriceTier,
} from './enums.js'

/** One freight type's pricing, mirroring an Excel `BD` row. USD/lb. Tiers are the
 * legacy global-catalog columns (now text in the DB) — the fallback source. */
export interface CatalogEntry {
  freightType: FreightType
  cost: number
  tiers: Record<string, number | null>
}

export interface BillingClient {
  id: string
  name: string
  nameNormalized: string
  casillero: string | null
  toReview: boolean
  email: string | null
  phone: string | null
  address: string | null
  /** Company / sub-agency this client belongs to (nullable: personal clients have none). */
  companyName?: string | null
  /** Tax identifier (cédula / RUC) of the client or its company. */
  taxId?: string | null
  /** Lifecycle state — false = deactivated (packages hidden from dashboards until reactivated). */
  active?: boolean
  /** Soft delete timestamp — non-null = removed from operational reads (never physical). */
  deletedAt?: string | null
  /** Total packages related to this client (derived from packages.client_id). */
  packageCount?: number
  /** Default rate table for this client (preselects pricing on their next invoice). */
  defaultRateId: string | null
  /** Default rate card (v2 plan) for this client — takes precedence over defaultRateId. */
  defaultRateCardId: string | null
}

export interface Payment {
  method: PaymentMethod | null
  bank: PaymentBank | null
  currency: Currency | null
  amount: number | null
  amountUsd: number | null
  fxRate: number | null
  paidAt: string | null
  raw: string
  quarantined: boolean
}

export interface LineItem {
  description: string | null
  freightType: FreightType
  quantityLbs: number
  unit: string
  unitPrice: number
  total: number
  listPrice: number | null
  freightCost: number
  profit: number
  priceTier: PriceTier | null
  priceOffCatalog: boolean
}

/** Trace back to the source sheet + rows for migration auditability. */
export interface InvoiceSource {
  sheet: string
  rows: number[]
}

export interface Invoice {
  id: string
  invoiceNumber: number
  fiscalYear: number
  clientId: string | null
  clientNameRaw: string | null
  issueDate: string | null
  status: InvoiceStatus
  address: string | null
  specialPrice: boolean
  observations: string | null
  trackingOrders: string[]
  agentId: string | null
  source: InvoiceSource | null
  lineItems: LineItem[]
  payments: Payment[]
  // Derived (computed by calc.ts, see domain/calc.ts):
  total: number
  profit: number
  margin: number | null
}
