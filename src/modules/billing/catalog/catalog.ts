// ============================================================================
// Pricing catalog service — the dynamic pricing engine (replaces the Excel VLOOKUP).
// ============================================================================
// Reads pricing_catalog through the repository and turns a (freightType, tier, lbs)
// into money via domain/calc.ts. Fetches on demand (2 rows, cheap) so a catalog
// edit takes effect immediately with no cache to bust.

import { computeAmounts, inferTier, quoteLine, type LineAmounts } from '../domain/calc.js'
import type { FreightType, PriceTier } from '../domain/enums.js'
import type { CatalogEntry } from '../domain/types.js'
import type { BillingRepository, OrgRateTable } from '../repo/billing-repo.js'

export interface Quote extends LineAmounts {
  freightType: FreightType
  tier: PriceTier
  quantityLbs: number
}

/**
 * Tier-resolution order for an org quote:
 *   1. The client's default rate table (when the quote has one) — its tier row wins.
 *   2. Any of the org's rate tables for that freight type that offers the tier.
 *   3. The legacy global pricing_catalog (REGULAR/ESPECIAL/VIP/MADRES/DARIO only).
 * Returns null when no source prices the tier for that freight — callers reject
 * the line instead of guessing a price.
 */
export function resolveOrgRate(
  tables: OrgRateTable[],
  freightType: FreightType,
  tier: string,
  defaultRateTableId?: string | null,
): { price: number; cost: number } | null {
  const tierRow = (t: OrgRateTable) => t.rows.find((r) => r.tier === tier && r.price != null)
  if (defaultRateTableId) {
    const t = tables.find((x) => x.id === defaultRateTableId && x.freightType === freightType)
    const row = t ? tierRow(t) : undefined
    if (row) return { price: row.price, cost: row.cost ?? 0 }
  }
  for (const t of tables) {
    if (t.freightType !== freightType) continue
    const row = tierRow(t)
    if (row) return { price: row.price, cost: row.cost ?? 0 }
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
    return { freightType, tier, quantityLbs, ...amounts }
  }

  /**
   * Org-aware quote: the per-tenant rate tables are the pricing source; the legacy
   * global catalog is the fallback. Null = tier not offered for this org/freight.
   */
  async quoteOrg(
    organizationId: string,
    freightType: FreightType,
    tier: string,
    quantityLbs: number,
    defaultRateTableId?: string | null,
  ): Promise<Quote | null> {
    const tables = await this.repo.getOrgRates(organizationId)
    const rate = resolveOrgRate(tables, freightType, tier, defaultRateTableId)
    if (rate) {
      return { freightType, tier, quantityLbs, ...computeAmounts(quantityLbs, rate.price, rate.cost) }
    }
    // Legacy fallback: only the global catalog's fixed tiers.
    return this.quote(freightType, tier, quantityLbs)
  }

  /** Infer the tier a hand-typed unit price came from (historical import). */
  async inferTier(freightType: FreightType, unitPrice: number): Promise<PriceTier | null> {
    const entry = await this.find(freightType)
    if (!entry) return null
    return inferTier(entry, unitPrice)
  }
}
