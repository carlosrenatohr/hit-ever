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

// ─── Rate cards v2 (plan -> version -> entries) ─────────────────────────────
// A rate_card is a commercial plan. A rate_card_version is a published revision
// (price_model, currency, validity). rate_card_entries is the AIR/MAR price
// pair for that version. See docs/pricing-model.md.

export type RateCardStructure = 'simple_pair'

export interface RateCardEntry {
  id: string
  serviceType: FreightType // 'AIR' | 'MAR'
  name: string
  unit: 'lb' | 'ft3' | 'package'
  price: number
  cost: number
}

/** Write-side entry (unit defaults to 'lb'; the Worker only accepts weight today). */
export interface RateCardEntryInput {
  serviceType: FreightType
  name: string
  price: number
  cost: number
}

export interface RateCardVersion {
  id: string
  version: number
  priceModel: PriceModel
  currency: CurrencyCode
  status: 'draft' | 'published' | 'archived'
  entries: RateCardEntry[]
}

export interface RateCard {
  id: string
  organizationId: string
  name: string
  structure: RateCardStructure
  currentVersion: RateCardVersion
  createdAt: string
  updatedAt: string
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
  /** Córdobas per US dollar. Manual today (default 37); automation is future. */
  exchangeRateNioPerUsd: number | null
  exchangeRateSource: 'manual' | 'automatic'
  exchangeRateUpdatedAt: string | null
}

export interface AgencyInfoPatch {
  ruc?: string | null
  address?: string | null
  phone?: string | null
  currency?: CurrencyCode
  /** Setting the rate stamps source='manual' + updated_at server-side. */
  exchangeRateNioPerUsd?: number | null
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
