// Accent folding for accent-insensitive ILIKE search — each vowel/ñ expands to a
// LIKE char class (Mendez → m[eé][nñ]d[eé]z), so no schema change is required.
const ACCENT_CLASS: Record<string, string> = { a: '[aá]', c: '[cç]', e: '[eé]', i: '[ií]', n: '[nñ]', o: '[oó]', u: '[uúü]' }

/** Expand each letter of `term` into a lowercased LIKE char class (ILIKE case-folds both sides). */
export function toIlikePattern(term: string): string {
  let out = ''
  for (const ch of term) out += ACCENT_CLASS[ch.toLowerCase()] ?? ch.toLowerCase()
  return out
}
