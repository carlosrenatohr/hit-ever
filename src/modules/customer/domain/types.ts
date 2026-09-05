import type { BillingClient } from '../../billing/domain/types.js'

export type Customer = BillingClient

export interface CustomerListFilter {
  organizationId: string
  search?: string
  toReview?: boolean
  page?: number
  pageSize?: number
}

export interface CreateCustomerInput {
  name: string
  casillero?: string | null
  toReview?: boolean
  email?: string | null
  phone?: string | null
  address?: string | null
}

export interface UpdateCustomerInput {
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
