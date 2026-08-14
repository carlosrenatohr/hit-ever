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

export interface RateRow {
  tier: PriceTier
  price: number
  cost: number
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
