import type { BillingClient } from '../../billing/domain/types.js'

export type Customer = BillingClient

export interface CustomerListFilter {
  search?: string
  toReview?: boolean
  page?: number
  pageSize?: number
}

export interface CreateCustomerInput {
  name: string
  casillero?: string | null
  toReview?: boolean
}

export interface UpdateCustomerInput {
  name?: string
  casillero?: string | null
  toReview?: boolean
}

export interface CustomerPage {
  rows: Customer[]
  count: number
}
