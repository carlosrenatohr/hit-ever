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
  /** Billing unit ('lb' legacy, 'package' fixed) and pricing kind of the source card. */
  unit?: string
  pricingKind?: string
  cardName?: string
  /** Currency of the source card (USD today). */
  currency?: string
}

export interface ResolvedRate {
  price: number
  cost: number
  priceModel: string
  pricingSource: 'rate_card' | 'legacy'
  rateCardId?: string | null
  rateCardVersionId?: string | null
  rateCardEntryId?: string | null
  /** Billing unit of the entry ('lb' legacy, 'package' for fixed services). */
  unit?: string
  /** Flexible pricing kind of the source card ('weight' legacy). */
  pricingKind?: string
  /** Card/service name — the label invoices show for fixed services. */
  cardName?: string
  /** Card currency (USD today); legacy rows omit it. */
  currency?: string
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
  // Fixed cards NEVER price weight lines: their flat per-guía entry would
  // otherwise be multiplied by pounds in the weight quoting path. Fixed money
  // flows only through the package snapshot (pricing.ts + create_package).
  const entryFor = (c: OrgRateCard) =>
    c.pricingKind === 'fixed' || c.active === false
      ? undefined
      : c.entries.find((e) => e.serviceType === freightType && e.price != null)
  const tierRow = (t: OrgRateTable) => t.rows.find((r) => r.tier === tier && r.price != null)
  const asRate = (c: OrgRateCard, entry: { id: string; price: number; cost: number | null; unit: string }): ResolvedRate => ({
    price: entry.price,
    cost: entry.cost ?? 0,
    priceModel: c.priceModel ?? 'weight',
    pricingSource: 'rate_card',
    rateCardId: c.id,
    rateCardVersionId: c.versionId,
    rateCardEntryId: entry.id,
    unit: entry.unit,
    pricingKind: c.pricingKind ?? 'weight',
    cardName: c.name,
    currency: c.currency,
  })

  if (defaultRateId) {
    const card = cards.find((c) => c.id === defaultRateId)
    if (card) {
      const entry = entryFor(card)
      if (entry) return asRate(card, entry)
    } else {
      // Legacy default (billing_clients.default_rate_id) for an unmigrated org.
      const t = legacyTables.find((x) => x.id === defaultRateId && x.freightType === freightType)
      const row = t ? tierRow(t) : undefined
      if (row) return { price: row.price, cost: row.cost ?? 0, priceModel: row.priceModel ?? 'weight', pricingSource: 'legacy' }
    }
  }
  // The agency default for the requested kind is the commercial fallback. Picking
  // the first card in the list billed a card nobody chose.
  const orgDefault = cards.find((c) => c.isDefault && entryFor(c))
  if (orgDefault) return asRate(orgDefault, entryFor(orgDefault)!)
  // No default: only an unambiguous single candidate may price the line. With
  // several cards the caller must choose one — guessing would bill the wrong rate.
  const candidates = cards.filter((c) => entryFor(c))
  if (candidates.length === 1) return asRate(candidates[0], entryFor(candidates[0])!)
  for (const t of legacyTables) {
    if (t.freightType !== freightType) continue
    const row = tierRow(t)
    if (row) return { price: row.price, cost: row.cost ?? 0, priceModel: row.priceModel ?? 'weight', pricingSource: 'legacy' }
  }
  return null
}

export class CatalogService {
  constructor(private readonly repo: BillingRepository) {}

  /** Request-scoped rate cache. CatalogService lives one HTTP request (the
   *  routes build it per call), so caching here keeps multi-line invoices from
   *  paying 2 subrequests per line — the fetches that pushed an 11-package
   *  invoice past the Workers free-plan 50-subrequest limit. Storing the
   *  promise also dedupes concurrent quotes for the same org. */
  private rateCache = new Map<string, Promise<[OrgRateCard[], OrgRateTable[]]>>()

  private orgRates(organizationId: string): Promise<[OrgRateCard[], OrgRateTable[]]> {
    let cached = this.rateCache.get(organizationId)
    if (!cached) {
      cached = Promise.all([this.repo.getOrgRateCards(organizationId), this.repo.getOrgRates(organizationId)]) as Promise<[OrgRateCard[], OrgRateTable[]]>
      this.rateCache.set(organizationId, cached)
    }
    return cached
  }

  /** Org cards for the current request (same cache as quotes: no extra read). */
  async cardsFor(organizationId: string): Promise<OrgRateCard[]> {
    const [cards] = await this.orgRates(organizationId)
    return cards
  }

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
    const [cards, legacy] = await this.orgRates(organizationId)
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
        unit: rate.unit,
        pricingKind: rate.pricingKind,
        cardName: rate.cardName,
        currency: rate.currency,
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
