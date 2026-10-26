// ============================================================================
// Client-name normalization + dedupe key.
// ============================================================================
// The Excel `cliente` column is free text with trailing spaces and casing drift.
// `key` (trim + collapse whitespace + lower) is the dedupe key stored as
// billing_clients.name_normalized; `display` is a tidy title-cased name.

export interface NormalizedClient {
  display: string
  key: string
}

/**
 * Match key for package referencia_name ↔ client name comparisons. Package
 * providers ship free text: "ANTONY" vs client "Antony", "HAZMAT FERNANDA
 * QUINTANILLA" vs client "Fernanda Quintanilla", "María José" vs "Maria Jose".
 * Case-insensitive + accent-folded + HAZMAT tokens dropped + whitespace
 * collapsed. Deliberately separate from normalizeClientName().key (the
 * billing_clients dedupe key, which must stay stable for existing rows).
 */
export function clientMatchKey(raw: unknown): string {
  const rawStr = raw == null ? '' : String(raw)
  const folded = rawStr
    .replace(/hazmat/gi, ' ') // provider tag, never part of the client's name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics (é→e, ñ→n — both sides folded alike)
  return folded.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** Display name with HAZMAT tokens removed (bulk flow derives the client name
 *  from the package's referencia; the tag must not become part of the client). */
export function cleanClientDisplay(raw: unknown): string {
  return String(raw ?? '').replace(/hazmat/gi, ' ').replace(/\s+/g, ' ').trim()
}

export function normalizeClientName(rawInput: unknown): NormalizedClient {
  const raw = rawInput == null ? '' : String(rawInput)
  const collapsed = raw.trim().replace(/\s+/g, ' ')
  const key = collapsed.toLowerCase()
  const display = collapsed
    .split(' ')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(' ')
  return { display, key }
}

/** ANULADO rows are voided invoices, not a real client. */
export function isVoidClient(rawInput: unknown): boolean {
  return String(rawInput ?? '').trim().toUpperCase() === 'ANULADO'
}
