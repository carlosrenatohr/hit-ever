// ============================================================================
// Ingestion freshness assessment (used by GET /admin/health).
// ============================================================================
// Pure, deterministic logic so the stale threshold rule is unit-testable without a
// Hono app or a live DB. A null last_scrape means the provider has never written —
// that counts as stale (nothing to wait for). Exposed so an external free monitor
// (UptimeRobot / Better Stack) can turn an ingestion outage into an email alert.

export interface ProviderFreshness {
  last_scrape: string | null
  hours_stale: number | null
}

export interface HealthAssessment {
  stale: boolean
  staleProviders: string[]
  freshness: Record<string, ProviderFreshness>
}

export function assessIngestionFreshness(
  lastScrapeByProvider: Record<string, string | null>,
  staleAfterHours: number,
): HealthAssessment {
  const now = Date.now()
  const freshness: Record<string, ProviderFreshness> = {}
  const staleProviders: string[] = []

  for (const [code, ts] of Object.entries(lastScrapeByProvider)) {
    if (!ts) {
      freshness[code] = { last_scrape: null, hours_stale: null }
      staleProviders.push(code)
      continue
    }
    const hours = (now - Date.parse(ts)) / 3_600_000
    freshness[code] = { last_scrape: ts, hours_stale: Math.round(hours * 10) / 10 }
    if (hours > staleAfterHours) staleProviders.push(code)
  }

  return { stale: staleProviders.length > 0, staleProviders, freshness }
}