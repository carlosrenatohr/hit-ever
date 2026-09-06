// ============================================================================
// Derived-amount math — the single place invoice/line numbers are computed.
// ============================================================================
// Mirrors the Excel formula graph, but server-side and catalog-driven:
//   unit_price   = catalog tier price (USD/lb)
//   total        = quantity_lbs * unit_price
//   freight_cost = quantity_lbs * catalog.cost
//   profit       = total - freight_cost
//   margin       = profit / total        (null when total is 0)
//   commission   = profit * agent.rate   (see service/, Daniel = 0.5)
// Pure functions only — no I/O — so they are trivially unit-tested and reused by
// the quote endpoint, the create-invoice service, and the import validator.

import type { PriceTier } from './enums.js'
import type { CatalogEntry } from './types.js'

/** Tolerance for "does this amount match the expected computation / a catalog tier". */
export const AMOUNT_EPSILON = 0.01

/** Round to 2 decimals (money). Avoids float drift like 19.250000000000004. */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/** Round to 4 decimals (ratios like margin). */
export function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 10000) / 10000
}

/** Price for a tier, or null if the freight type does not offer it (e.g. MAR/MADRES). */
export function tierPrice(entry: CatalogEntry, tier: PriceTier): number | null {
  return entry.tiers[tier] ?? null
}

export interface LineAmounts {
  unitPrice: number
  total: number
  freightCost: number
  profit: number
}

/** Compute a line's money fields from quantity, unit price, and catalog cost. */
export function computeAmounts(quantityLbs: number, unitPrice: number, cost: number): LineAmounts {
  const total = round2(quantityLbs * unitPrice)
  const freightCost = round2(quantityLbs * cost)
  const profit = round2(total - freightCost)
  return { unitPrice, total, freightCost, profit }
}

// Price model: weight (lbs × price), volume (ft³ × price), fixed (flat per package).
export type PriceModel = 'weight' | 'volume' | 'fixed'

/** Compute line amounts respecting the price model of the rate row. */
export function computeAmountsByModel(
  quantity: number,
  unitPrice: number,
  cost: number,
  priceModel: PriceModel = 'weight',
): LineAmounts {
  const total = round2(quantity * unitPrice)
  // freight_cost scales with weight regardless of how the customer is billed.
  const freightCost = round2(quantity * cost)
  const profit = round2(total - freightCost)
  return { unitPrice, total, freightCost, profit }
}

/** profit / total. Null when total is 0 (avoids Infinity/NaN leaking into reports). */
export function margin(total: number, profit: number): number | null {
  if (!total) return null
  return round4(profit / total)
}

/**
 * Quote one line from the catalog: given a freight type entry, a tier, and lbs,
 * return the money fields. Returns null if the tier is not offered for that freight.
 */
export function quoteLine(entry: CatalogEntry, tier: PriceTier, quantityLbs: number): LineAmounts | null {
  const unitPrice = tierPrice(entry, tier)
  if (unitPrice == null) return null
  return computeAmounts(quantityLbs, unitPrice, entry.cost)
}

/**
 * Infer which tier a hand-typed unit price came from (used on historical import).
 * Returns the matching tier within AMOUNT_EPSILON, or null (flag price_off_catalog).
 * Order is deterministic so ties resolve consistently.
 */
export function inferTier(entry: CatalogEntry, unitPrice: number): PriceTier | null {
  const order: PriceTier[] = ['REGULAR', 'ESPECIAL', 'VIP', 'MADRES', 'DARIO']
  for (const tier of order) {
    const p = entry.tiers[tier]
    if (p != null && Math.abs(p - unitPrice) <= AMOUNT_EPSILON) return tier
  }
  return null
}

/** True when |actual - expected| exceeds the money tolerance (import validation). */
export function amountsDiffer(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) > AMOUNT_EPSILON
}
