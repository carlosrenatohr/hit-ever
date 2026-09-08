import type { BillingClient } from '../../billing/domain/types.js'

export type Customer = BillingClient

/** Lifecycle / review states exposed by the clients list filter. Combined with OR. */
export type CustomerStatus = 'active' | 'inactive' | 'review'

export interface CustomerListFilter {
  organizationId: string
  search?: string
  /** Multi-state filter: active | inactive | review, OR'd together. Empty = all clients. */
  statuses?: CustomerStatus[]
  /** Legacy single flag (current panel checkbox); `statuses` takes precedence when set. */
  toReview?: boolean
  page?: number
  pageSize?: number
}

export interface CreateCustomerInput extends CustomerRateDefaults {
  name: string
  casillero?: string | null
  toReview?: boolean
  email?: string | null
  phone?: string | null
  address?: string | null
  /** Company / sub-agency the client belongs to. */
  companyName?: string | null
  /** Tax identifier (cédula / RUC). */
  taxId?: string | null
  /** Lifecycle state (defaults to active=true). */
  active?: boolean
}

export interface UpdateCustomerInput extends CustomerRateDefaults {
  name?: string
  casillero?: string | null
  toReview?: boolean
  email?: string | null
  phone?: string | null
  address?: string | null
  companyName?: string | null
  taxId?: string | null
  active?: boolean
}

export interface CustomerPage {
  rows: Customer[]
  count: number
}

/** Impact summary for the delete confirmation dialog. Samples capped at 5 per kind. */
export interface CustomerDeletePreview {
  client: Customer
  packages: Array<{ guia: string | null; tracking: string | null }>
  packageCount: number
  invoices: Array<{ fiscalYear: number; invoiceNumber: number; status: string }>
  invoiceCount: number
}

export interface CustomerRateDefaults {
  /** Default rate table for this client (preselects pricing on future invoices). */
  defaultRateTableId?: string | null
  /** Default rate card (v2 plan) — takes precedence over defaultRateTableId. */
  defaultRateCardId?: string | null
}
