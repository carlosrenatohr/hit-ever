// ============================================================================
// Pricing catalog service — the dynamic pricing engine (replaces the Excel VLOOKUP).
// ============================================================================
// Reads pricing_catalog through the repository and turns a (freightType, tier, lbs)
// into money via domain/calc.ts. Fetches on demand (2 rows, cheap) so a catalog
// edit takes effect immediately with no cache to bust.

import { computeAmounts, computeAmountsByModel, inferTier, quoteLine, type LineAmounts } from '../domain/calc.js'
import type { FreightType, PriceTier } from '../domain/enums.js'
import type { CatalogEntry } from '../domain/types.js'
import type { BillingRepository, OrgRateCard, OrgRateTable } from '../repo/billing-repo.js'
import type { PriceModel } from '../domain/calc.js'

export interface Quote extends LineAmounts {
  freightType: FreightType
  tier: PriceTier
  quantityLbs: number
  /** Where the price came from — recorded on the invoice line (provenance). */
  pricingSource: 'rate_card' | 'legacy' | 'catalog'
  rateCardId?: string | null
  rateCardVersionId?: string | null
  rateCardEntryId?: string | null
}

export interface ResolvedRate {
  price: number
  cost: number
  priceModel: string
  pricingSource: 'rate_card' | 'legacy'
  rateCardId?: string | null
  rateCardVersionId?: string | null
  rateCardEntryId?: string | null
}

/**
 * Tier-resolution order for an org quote:
 *   1. The explicit rate card (per-line or client default) — its service entry wins.
 *   2. Any of the org's rate cards that offers the service (AIR/MAR).
 *   3. Legacy rate_tables by tier (only unmigrated orgs should still have them).
 * Returns null when no source prices the line — callers reject it instead of
 * guessing a price (migrated orgs never fall back to the global catalog).
 */
export function resolveOrgRate(
  cards: OrgRateCard[],
  legacyTables: OrgRateTable[],
  freightType: FreightType,
  tier: string,
  defaultRateId?: string | null,
): ResolvedRate | null {
  const entryFor = (c: OrgRateCard) => c.entries.find((e) => e.serviceType === freightType && e.price != null)
  const tierRow = (t: OrgRateTable) => t.rows.find((r) => r.tier === tier && r.price != null)

  if (defaultRateId) {
    const card = cards.find((c) => c.id === defaultRateId)
    if (card) {
      const entry = entryFor(card)
      if (entry) return { price: entry.price, cost: entry.cost ?? 0, priceModel: card.priceModel ?? 'weight', pricingSource: 'rate_card', rateCardId: card.id, rateCardVersionId: card.versionId, rateCardEntryId: entry.id }
    } else {
      // Legacy default (billing_clients.default_rate_id) for an unmigrated org.
      const t = legacyTables.find((x) => x.id === defaultRateId && x.freightType === freightType)
      const row = t ? tierRow(t) : undefined
      if (row) return { price: row.price, cost: row.cost ?? 0, priceModel: row.priceModel ?? 'weight', pricingSource: 'legacy' }
    }
  }
  for (const card of cards) {
    const entry = entryFor(card)
    if (entry) return { price: entry.price, cost: entry.cost ?? 0, priceModel: card.priceModel ?? 'weight', pricingSource: 'rate_card', rateCardId: card.id, rateCardVersionId: card.versionId, rateCardEntryId: entry.id }
  }
  for (const t of legacyTables) {
    if (t.freightType !== freightType) continue
    const row = tierRow(t)
    if (row) return { price: row.price, cost: row.cost ?? 0, priceModel: row.priceModel ?? 'weight', pricingSource: 'legacy' }
  }
  return null
}

export class CatalogService {
  constructor(private readonly repo: BillingRepository) {}

  /** All catalog entries (for GET /catalog and the panel's tier dropdown). */
  async entries(): Promise<CatalogEntry[]> {
    return this.repo.getCatalog()
  }

  /** One freight type's entry, or null if not in the catalog. */
  async find(freightType: FreightType): Promise<CatalogEntry | null> {
    const all = await this.repo.getCatalog()
    return all.find((e) => e.freightType === freightType) ?? null
  }

  /**
   * Quote a line. Returns null if the freight type is unknown or the tier is not
   * offered for it (e.g. MAR has no MADRES tier).
   */
  async quote(freightType: FreightType, tier: PriceTier, quantityLbs: number): Promise<Quote | null> {
    const entry = await this.find(freightType)
    if (!entry) return null
    const amounts = quoteLine(entry, tier, quantityLbs)
    if (!amounts) return null
    return { freightType, tier, quantityLbs, pricingSource: 'catalog', rateCardId: null, rateCardVersionId: null, rateCardEntryId: null, ...amounts }
  }

  /**
   * Org-aware quote. The per-tenant rate cards are the pricing source for
   * migrated orgs; legacy rate_tables and the global catalog remain only as a
   * fallback for unmigrated orgs (no cards). A migrated org with an unresolved
   * line returns null (caller errors) — never a silent catalog price.
   */
  async quoteOrg(
    organizationId: string,
    freightType: FreightType,
    tier: string,
    quantityLbs: number,
    defaultRateId?: string | null,
  ): Promise<Quote | null> {
    const [cards, legacy] = await Promise.all([this.repo.getOrgRateCards(organizationId), this.repo.getOrgRates(organizationId)])
    const rate = resolveOrgRate(cards, legacy, freightType, tier, defaultRateId)
    if (rate) {
      const amounts = computeAmountsByModel(quantityLbs, rate.price, rate.cost, (rate.priceModel ?? 'weight') as PriceModel)
      return {
        freightType,
        tier,
        quantityLbs,
        pricingSource: rate.pricingSource,
        rateCardId: rate.rateCardId ?? null,
        rateCardVersionId: rate.rateCardVersionId ?? null,
        rateCardEntryId: rate.rateCardEntryId ?? null,
        ...amounts,
      }
    }
    // Migrated org (has cards): a missing price is an error, not a fallback.
    if (cards.length > 0) return null
    // Unmigrated org: only the legacy global catalog's fixed tiers.
    return this.quote(freightType, tier, quantityLbs)
  }

  /** Infer the tier a hand-typed unit price came from (historical import). */
  async inferTier(freightType: FreightType, unitPrice: number): Promise<PriceTier | null> {
    const entry = await this.find(freightType)
    if (!entry) return null
    return inferTier(entry, unitPrice)
  }
}
