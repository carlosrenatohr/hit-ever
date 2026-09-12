import type { BillingClient } from '../../billing/domain/types.js'
import type { AuditLogEntry } from '../../config/domain/types.js'

export type Customer = BillingClient

/** Weight/package aggregates by service for a client (derived from packages). */
export interface CustomerWeightStats {
  weightMaritimo: number
  weightAereo: number
  countMaritimo: number
  countAereo: number
}

/** A client row enriched with its weight aggregates for the list view. */
export interface CustomerWithStats extends Customer, CustomerWeightStats {}

/** KPI-card aggregates for the whole agency within a date range. */
export interface CustomerAggregateStats {
  totalWeightLb: number
  weightMaritimo: number
  weightAereo: number
  packageCountTotal: number
  packageCountMaritimo: number
  packageCountAereo: number
  topMaritimo: { clientId: string; name: string; weightLb: number } | null
  topAereo: { clientId: string; name: string; weightLb: number } | null
}

/** Lifecycle / review states exposed by the clients list filter. Combined with OR. */
export type CustomerStatus = 'active' | 'inactive' | 'review'

export interface CustomerListFilter {
  organizationId: string
  search?: string
  /** Multi-state filter: active | inactive | review, OR'd together. Empty = all clients. */
  statuses?: CustomerStatus[]
  /** Legacy single flag (current panel checkbox); `statuses` takes precedence when set. */
  toReview?: boolean
  /** Reception-date range (received_at), same semantics as dashboard_stats. */
  from?: string
  to?: string
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
  rows: CustomerWithStats[]
  count: number
}

/** Event timeline for a client (from audit_logs). */
export interface CustomerEventsPage {
  rows: AuditLogEntry[]
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
