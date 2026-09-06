// ============================================================================
// Config domain types — multi-tenant branding, self-managed rates, audit log.
// ============================================================================
// Mirror of migrations/20260814214034_config-module.sql. Money values are
// USD/lb; profit/margin are never stored — computed in the billing domain
// (domain/calc) when needed.

import type { FreightType, PriceTier } from '../../billing/domain/enums.js'

export interface Agency {
  slug: string
  name: string
  logoUrl: string | null
  logoKey: string | null
}

export type PriceModel = 'weight' | 'volume' | 'fixed'

export interface RateRow {
  tier: PriceTier
  price: number
  cost: number
  priceModel: PriceModel
}

export interface RateTable {
  id: string
  organizationId: string
  name: string
  freightType: FreightType
  createdAt: string
  updatedAt: string
  rows: RateRow[]
}

export type ActorType = 'user' | 'system' | 'service'

export interface AuditLogEntry {
  id: number
  organizationId: string
  actorId: string | null
  actorEmail: string | null
  actorType: ActorType
  action: string
  entityType: string
  entityId: string | null
  requestId: string | null
  metadata: Record<string, unknown>
  createdAt: string
}

export interface AuditFilter {
  action?: string
  entityType?: string
  entityId?: string
  from?: string
  to?: string
  page?: number
  pageSize?: number
}

/** Working currency for an agency's money displays (invoices, rates). */
export type CurrencyCode = 'USD' | 'NIO'

/** Agency profile editable from Config > Información (all optional except currency). */
export interface AgencyInfo {
  slug: string
  name: string
  ruc: string | null
  address: string | null
  phone: string | null
  currency: CurrencyCode
  /** When false, sync/scrape actions are refused server-side (manual-only agency). */
  isScrapable: boolean
}

export interface AgencyInfoPatch {
  ruc?: string | null
  address?: string | null
  phone?: string | null
  currency?: CurrencyCode
}

export interface PaymentCatalogItem {
  id: string
  name: string
  active: boolean
}

/** Template for custom extra invoice charges ("otros"). suggestedPrice only
 * prefills the invoice form — the real amount is set per invoice by the admin. */
export interface ChargeConcept {
  id: string
  name: string
  suggestedPrice: number | null
  active: boolean
}
