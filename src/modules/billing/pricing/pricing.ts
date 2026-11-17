// ============================================================================
// Package pricing — fixed-first resolution + snapshot (pure, no I/O).
// ============================================================================
// One place decides WHICH rate card prices a package and WHAT the snapshot
// holds, so the create_package RPC, the preview endpoint and the tests share
// the same order. The SQL RPC mirrors this resolution order explicitly (see
// the flexible-pricing-schema migration); both sides are covered by tests.
//
// Resolution priority (decided in the flexible-pricing plan):
//   1. Explicit card on the package (operator pick).
//   2. The client's active assignment for the pricing kind.
//   3. The org's default card for the pricing kind.
//   4. The org's first active card of the kind with an entry for the mode.
//
// Fixed pricing rules (owner decisions, Nov 2026):
//   * One guía = one package. pieces NEVER multiply the charge.
//   * The ONLY money inputs are the owner-configured entry price and cost —
//     weight and dimensions never participate in the fixed money math.
// ============================================================================

import type { OrgRateCard } from '../repo/billing-repo.js'

export type PricingKind = 'weight' | 'fixed' | 'volume'
export type TransportMode = 'AIR' | 'MAR'

/** Active assignment rows as the repo returns them (client_rate_assignments). */
export interface RateAssignment {
  rateCardId: string
  pricingKind: string
  transportMode: string | null
  active: boolean
}

export interface PackageSnapshot {
  rateCardId: string
  rateCardVersionId: string
  rateCardEntryId: string
  pricingKind: PricingKind
  customerPriceModel: 'WEIGHT' | 'VOLUME' | 'FIXED'
  customerUnit: string
  customerRate: number
  customerCharge: number
  providerCostModel: 'WEIGHT' | 'VOLUME' | 'FIXED'
  providerCostUnit: string
  providerRate: number
  providerCost: number
  currency: string
}

export interface ResolveCardOptions {
  pricingKind: PricingKind
  transportMode: TransportMode
  /** Operator pick — wins over every default. Must be same-org (caller validates). */
  explicitCardId?: string | null
  /** The client's active assignments for this org. */
  clientAssignments?: RateAssignment[]
  /** Org default card id for the kind (rate_cards.is_default), if any. */
  orgDefaultCardId?: string | null
}

function entryForMode(card: OrgRateCard, mode: TransportMode) {
  return card.entries.find((e) => e.serviceType === mode && e.price != null)
}

/**
 * Pick the card that prices a package. Deterministic: cards are scanned in the
 * order the repo returns them (stable by id/name). Returns null when nothing
 * applies — callers surface a clear "no rate configured" error, never a guess.
 */
export function resolvePackageCard(cards: OrgRateCard[], opts: ResolveCardOptions): OrgRateCard | null {
  const kind = opts.pricingKind
  const active = (c: OrgRateCard) => c.active !== false
  const ofKind = cards.filter((c) => (c.pricingKind ?? 'weight') === kind && active(c))

  if (opts.explicitCardId) {
    const card = ofKind.find((c) => c.id === opts.explicitCardId && entryForMode(c, opts.transportMode))
    if (card) return card
    return null // explicit pick must be valid; do not silently fall back
  }

  const assigned = (opts.clientAssignments ?? []).find(
    (a) => a.active && a.pricingKind === kind && (a.transportMode == null || a.transportMode === opts.transportMode),
  )
  if (assigned) {
    const card = ofKind.find((c) => c.id === assigned.rateCardId && entryForMode(c, opts.transportMode))
    if (card) return card
  }

  if (opts.orgDefaultCardId) {
    const card = ofKind.find((c) => c.id === opts.orgDefaultCardId && entryForMode(c, opts.transportMode))
    if (card) return card
  }

  return ofKind.find((c) => entryForMode(c, opts.transportMode)) ?? null
}

/**
 * Build the pricing snapshot for a fixed package. quantity is ALWAYS 1 guía —
 * pieces and weight are recorded for operations, never for the money math.
 */
export function buildFixedPackageSnapshot(card: OrgRateCard, mode: TransportMode): PackageSnapshot | null {
  const entry = entryForMode(card, mode)
  if (!entry) return null
  const providerCost = entry.cost ?? 0
  return {
    rateCardId: card.id,
    rateCardVersionId: card.versionId,
    rateCardEntryId: entry.id,
    pricingKind: 'fixed',
    customerPriceModel: 'FIXED',
    customerUnit: 'package',
    customerRate: entry.price,
    customerCharge: entry.price,
    providerCostModel: 'FIXED',
    providerCostUnit: 'package',
    providerRate: providerCost,
    providerCost,
    currency: card.currency,
  }
}
