// ============================================================================
// Freight type + OC (tracking-order) normalization.
// ============================================================================

import { TIPO_CODE_TO_FREIGHT, type FreightType } from '../../domain/enums.js'

/**
 * Resolve a freight type from either sheet family:
 *  - 2025/Daniel: numeric `TIPO` (1 = AIR, 2 = MAR), stored as 1.0 / 2.0.
 *  - 2026 Q*: string `TIPO DE FLETE` ('AIR' | 'MAR').
 * Returns null when absent/unrecognized (row is likely a subtotal/void).
 */
export function freightFromTipo(rawInput: unknown): FreightType | null {
  if (rawInput == null) return null
  if (typeof rawInput === 'number') return TIPO_CODE_TO_FREIGHT[Math.trunc(rawInput)] ?? null
  const s = String(rawInput).trim().toUpperCase()
  if (s === 'AIR' || s === 'MAR') return s
  if (s === '1') return 'AIR'
  if (s === '2') return 'MAR'
  return null
}

/**
 * Parse the `OC` cell into tracking-order tokens for best-effort package linking.
 * The column is dirty: Excel ate commas turning some into floats (663714.6648),
 * others are ambiguous CSV. We extract digit tokens (len >= 3) as candidates; a
 * token that matches no package simply stays unlinked (orphan -> manual link).
 */
export function parseOc(rawInput: unknown): string[] {
  if (rawInput == null) return []
  if (typeof rawInput === 'number') {
    const s = String(rawInput)
    // A float here is almost always "AAAAAA, BBBB" with the comma lost.
    return s.includes('.') ? s.split('.').filter((t) => t.length >= 3) : [s]
  }
  return String(rawInput)
    .split(/[,;/\s]+/)
    .map((t) => t.trim())
    .filter((t) => /^\d{3,}$/.test(t))
}
