// ============================================================================
// Pricing catalog service — the dynamic pricing engine (replaces the Excel VLOOKUP).
// ============================================================================
// Reads pricing_catalog through the repository and turns a (freightType, tier, lbs)
// into money via domain/calc.ts. Fetches on demand (2 rows, cheap) so a catalog
// edit takes effect immediately with no cache to bust.

import { inferTier, quoteLine, type LineAmounts } from '../domain/calc.js'
import type { FreightType, PriceTier } from '../domain/enums.js'
import type { CatalogEntry } from '../domain/types.js'
import type { BillingRepository } from '../repo/billing-repo.js'

export interface Quote extends LineAmounts {
  freightType: FreightType
  tier: PriceTier
  quantityLbs: number
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
    return { freightType, tier, quantityLbs, ...amounts }
  }

  /** Infer the tier a hand-typed unit price came from (historical import). */
  async inferTier(freightType: FreightType, unitPrice: number): Promise<PriceTier | null> {
    const entry = await this.find(freightType)
    if (!entry) return null
    return inferTier(entry, unitPrice)
  }
}
