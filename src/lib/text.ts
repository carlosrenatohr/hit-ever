// Accent folding for accent-insensitive customer search — mirrors Postgres
// unaccent() (which powers the `name_unaccent` generated column, see
// migrations/20260926104843_customer-search-unaccent.sql). Deliberately NOT
// LIKE bracket classes: `[eé]` does not match in this cluster (verified:
// `'a' ilike '[a]'` = f on PG 15.18/en_US.utf8), so the query term must be a
// plain folded string.
const ACCENT_MAP: Record<string, string> = {
  á: 'a', à: 'a', â: 'a', ä: 'a', ã: 'a', å: 'a',
  é: 'e', è: 'e', ê: 'e', ë: 'e',
  í: 'i', ì: 'i', î: 'i', ï: 'i',
  ó: 'o', ò: 'o', ô: 'o', ö: 'o', õ: 'o',
  ú: 'u', ù: 'u', û: 'u', ü: 'u',
  ñ: 'n', ç: 'c', ý: 'y', ÿ: 'y',
}

/** Fold accents to ASCII and lowercase (Méndez → mendez). */
export function foldAccents(term: string): string {
  return [...term.toLowerCase()].map((ch) => ACCENT_MAP[ch] ?? ch).join('')
}