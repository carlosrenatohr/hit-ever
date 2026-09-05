import type { BillingClient } from '../../billing/domain/types.js'

export type Customer = BillingClient

export interface CustomerListFilter {
  organizationId: string
  search?: string
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
}

export interface UpdateCustomerInput extends CustomerRateDefaults {
  name?: string
  casillero?: string | null
  toReview?: boolean
  email?: string | null
  phone?: string | null
  address?: string | null
}

export interface CustomerPage {
  rows: Customer[]
  count: number
}

export interface CustomerRateDefaults {
  /** Default rate table for this client (preselects pricing on future invoices). */
  defaultRateTableId?: string | null
}
