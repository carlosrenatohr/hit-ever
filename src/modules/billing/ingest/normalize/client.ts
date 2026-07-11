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
