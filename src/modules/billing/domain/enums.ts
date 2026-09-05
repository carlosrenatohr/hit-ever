// ============================================================================
// Billing domain enums — the single source of truth for the module's vocabulary.
// ============================================================================
// These mirror the Postgres enums in migrations/20260711093000_billing-schema.sql.
// Keep the two in sync: a value added here must also be added to the DB enum.

export const FREIGHT_TYPES = ['AIR', 'MAR'] as const
export type FreightType = (typeof FREIGHT_TYPES)[number]

// Tiers are dynamic: each agency creates its own (rate_rows.tier is text in the
// DB). PRICE_TIERS is the LEGACY global-catalog tier list — used only by the
// pricing_catalog fallback and the historical import's tier inference.
export const PRICE_TIERS = ['REGULAR', 'ESPECIAL', 'VIP', 'MADRES', 'DARIO'] as const
export type PriceTier = string

export const INVOICE_STATUSES = ['DRAFT', 'ISSUED', 'PARTIAL', 'PAID', 'VOID'] as const
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number]

export const PAYMENT_METHODS = ['BANK_TRANSFER', 'CASH', 'CREDIT_BALANCE'] as const
export type PaymentMethod = (typeof PAYMENT_METHODS)[number]

export const PAYMENT_BANKS = ['BAC', 'LAFISE', 'BANPRO'] as const
export type PaymentBank = (typeof PAYMENT_BANKS)[number]

export const CURRENCIES = ['USD', 'NIO'] as const
export type Currency = (typeof CURRENCIES)[number]

// The `packages.service_type` enum uses Spanish values; billing uses AIR/MAR.
// These maps bridge the invoice<->package link (Stage 2/5).
export const SERVICE_TYPE_TO_FREIGHT: Record<string, FreightType> = {
  aereo: 'AIR',
  maritimo: 'MAR',
}
export const FREIGHT_TO_SERVICE_TYPE: Record<FreightType, string> = {
  AIR: 'aereo',
  MAR: 'maritimo',
}

// The Excel `TIPO` numeric code (2025/Daniel sheets): 1 = AIR, 2 = MAR.
export const TIPO_CODE_TO_FREIGHT: Record<number, FreightType> = {
  1: 'AIR',
  2: 'MAR',
}
