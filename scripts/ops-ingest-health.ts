// ============================================================================
// Ops: check ingestion health and self-heal a stale provider.
// ============================================================================
// Usage:
//   ADMIN_SECRET=<secret> pnpm tsx scripts/ops-ingest-health.ts
//   ADMIN_SECRET=<secret> pnpm tsx scripts/ops-ingest-health.ts --dry-run
//
// Reads ADMIN_SECRET from env (or .dev.vars if present). GET /admin/health; if a
// provider is stale (>6h without a write) it triggers, per stale provider:
//   POST /admin/refresh-open?provider=X&limit=6   (revisit open packages by id)
//   POST /admin/ingest?provider=X&offset=0&days=7 (fresh page-1 list-walk)
// then re-checks health and reports. Exit code 1 if still stale (useful for cron).
//
// This is the "control from the ops side" tool: a single command that turns the
// /admin/health alert into an immediate recovery, no dashboard needed.
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const BASE = process.env.WORKER_URL ?? 'https://hit-ever-scraper.nativerse.workers.dev'
const STALE_AFTER_HOURS = 6
const DRY_RUN = process.argv.includes('--dry-run')

function loadSecret(): string {
  if (process.env.ADMIN_SECRET) return process.env.ADMIN_SECRET
  const varsPath = resolve(process.cwd(), '.dev.vars')
  if (existsSync(varsPath)) {
    const m = readFileSync(varsPath, 'utf8').match(/^ADMIN_SECRET=(.+)$/m)
    if (m) return m[1].trim()
  }
  throw new Error('ADMIN_SECRET not found in env or .dev.vars')
}

async function health(): Promise<{ ok: boolean; staleProviders: string[]; freshness: Record<string, unknown> }> {
  const res = await fetch(`${BASE}/admin/health?stale_after=${STALE_AFTER_HOURS}`)
  const json = (await res.json()) as any
  if (res.ok) {
    return { ok: true, staleProviders: [], freshness: json.data?.freshness ?? {} }
  }
  return {
    ok: false,
    staleProviders: json.error?.details?.stale_providers ?? [],
    freshness: json.error?.details?.freshness ?? {},
  }
}

async function post(path: string): Promise<number> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${loadSecret()}` },
  })
  return res.status
}

async function main(): Promise<void> {
  console.log(`[ops] health check → ${BASE}/admin/health (stale_after=${STALE_AFTER_HOURS}h)`)
  const before = await health()
  for (const [code, f] of Object.entries(before.freshness as Record<string, any>)) {
    console.log(`[ops] ${code}: last_scrape=${f.last_scrape} hours_stale=${f.hours_stale}`)
  }

  if (before.ok) {
    console.log('[ops] OK — all providers fresh. Nothing to do.')
    return
  }

  console.log(`[ops] STALE provider(s): ${before.staleProviders.join(', ')}`)
  if (DRY_RUN) {
    console.log('[ops] --dry-run: would trigger refresh-open + ingest page 0 for each stale provider.')
    process.exitCode = 1
    return
  }

  for (const code of before.staleProviders) {
    console.log(`[ops] healing ${code}: refresh-open(limit=6)...`)
    const r1 = await post(`/admin/refresh-open?provider=${encodeURIComponent(code)}&limit=6`)
    console.log(`[ops]   refresh-open → ${r1}`)
    console.log(`[ops] healing ${code}: ingest page 0 (days=7)...`)
    const r2 = await post(`/admin/ingest?provider=${encodeURIComponent(code)}&offset=0&days=7`)
    console.log(`[ops]   ingest → ${r2}`)
  }

  const after = await health()
  console.log(`[ops] re-check → ${after.ok ? 'OK' : `still stale: ${after.staleProviders.join(', ')}`}`)
  for (const [code, f] of Object.entries(after.freshness as Record<string, any>)) {
    console.log(`[ops] ${code}: last_scrape=${f.last_scrape} hours_stale=${f.hours_stale}`)
  }
  if (!after.ok) process.exitCode = 1
}

main().catch((e) => {
  console.error('[ops] failed:', e instanceof Error ? e.message : e)
  process.exitCode = 1
})