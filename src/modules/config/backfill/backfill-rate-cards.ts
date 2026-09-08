// ============================================================================
// Rate cards v2 backfill runner (Node, not the Worker).
// ============================================================================
// One-time migration of legacy rate_tables/rate_rows into the v2 model
// (rate_cards -> rate_card_versions -> rate_card_entries) for the agencies that
// had legacy data: hit, solo-guegue, suite. Idempotent via source_key on the
// version. Dry-run by default; pass --yes to write.
//
// Usage:
//   npx tsx src/modules/config/backfill/backfill-rate-cards.ts           # report
//   npx tsx src/modules/config/backfill/backfill-rate-cards.ts --yes     # apply
//
// Credentials: process.env.INSFORGE_API_URL / INSFORGE_API_KEY, else read from
// .insforge/project.json (oss_host + api_key).

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const BACKFILL_ORGS = ['hit', 'solo-guegue', 'suite']

const TIER_LABELS: Record<string, string> = {
  REGULAR: 'Regular',
  ESPECIAL: 'Especial',
  VIP: 'VIP',
  MADRES: 'Madres',
  DARIO: 'Dario',
}

interface Creds {
  url: string
  key: string
}

function loadCreds(): Creds {
  const envUrl = process.env.INSFORGE_API_URL
  const envKey = process.env.INSFORGE_API_KEY
  if (envUrl && envKey) return { url: envUrl, key: envKey }
  try {
    const p = resolve(process.cwd(), '.insforge/project.json')
    const j = JSON.parse(readFileSync(p, 'utf8')) as Record<string, string>
    const url = j.oss_host || j.api_url || j.apiUrl
    const key = j.api_key || j.apiKey
    if (url && key) return { url, key }
  } catch {
    /* fall through */
  }
  throw new Error('Set INSFORGE_API_URL + INSFORGE_API_KEY, or provide .insforge/project.json.')
}

interface RateRowDb {
  tier: string
  price: number
  cost: number | null
  price_model: string
}

export interface RateTableDb {
  id: string
  organization_id: string
  name: string
  freight_type: 'AIR' | 'MAR'
  rate_rows: RateRowDb[]
}

export interface BackfillCardPlan {
  org: string
  name: string
  sourceKey: string
  air: RateRowDb
  mar: RateRowDb
}

export interface BackfillSkip {
  org: string
  tableName: string
  tier: string
  reason: string
}

export interface BackfillPlan {
  cards: BackfillCardPlan[]
  skipped: BackfillSkip[]
}

export function cardName(tableName: string, tier: string): string {
  if (tier === 'REGULAR') return tableName
  return `${tableName} · ${TIER_LABELS[tier] ?? tier}`
}

/**
 * Build the migration plan from the legacy tables. Pure + testable. Validates
 * the abort criteria (unknown org, null cost, non-weight model) and groups by
 * (org, table, tier) — a group becomes a card only when it has both AIR and MAR.
 */
export function buildBackfillPlan(tables: RateTableDb[]): BackfillPlan {
  const orgs = new Set(tables.map((t) => t.organization_id))
  const unknown = [...orgs].filter((o) => !BACKFILL_ORGS.includes(o))
  if (unknown.length > 0) {
    throw new Error(`Unexpected agency with rate tables: ${unknown.join(', ')}. Abort.`)
  }
  for (const t of tables) {
    for (const r of t.rate_rows ?? []) {
      if (r.cost == null) throw new Error(`Null cost in ${t.organization_id}:${t.name}:${r.tier}. Abort.`)
      if (r.price_model !== 'weight') throw new Error(`Non-weight model in ${t.organization_id}:${t.name}:${r.tier}. Abort.`)
    }
  }

  const groups = new Map<string, { org: string; tableName: string; tier: string; air?: RateRowDb; mar?: RateRowDb }>()
  // Legacy model splits AIR/MAR into separate rate_tables sharing a name; the
  // group key is (org, tableName, tier) so the pair lands in one card. Unique
  // (organization_id, name, freight_type) guarantees at most one AIR + one MAR.
  for (const t of tables) {
    for (const r of t.rate_rows ?? []) {
      const key = `${t.organization_id}|${t.name}|${r.tier}`
      const g = groups.get(key) ?? { org: t.organization_id, tableName: t.name, tier: r.tier }
      if (t.freight_type === 'AIR') g.air = r
      else g.mar = r
      groups.set(key, g)
    }
  }

  const cards: BackfillCardPlan[] = []
  const skipped: BackfillSkip[] = []
  // Empty tables (no price rows) never price anything — flag for manual review.
  for (const t of tables) {
    if (!t.rate_rows || t.rate_rows.length === 0) {
      skipped.push({ org: t.organization_id, tableName: t.name, tier: '', reason: 'empty table (no prices)' })
    }
  }
  for (const g of groups.values()) {
    if (!g.air || !g.mar) {
      skipped.push({ org: g.org, tableName: g.tableName, tier: g.tier, reason: g.air ? 'missing MAR' : 'missing AIR' })
      continue
    }
    cards.push({
      org: g.org,
      name: cardName(g.tableName, g.tier),
      sourceKey: `${g.org}:${g.tableName}:${g.tier}`,
      air: g.air,
      mar: g.mar,
    })
  }
  cards.sort((a, b) => (a.sourceKey < b.sourceKey ? -1 : 1))
  return { cards, skipped }
}

// ─── HTTP helpers (admin key, same shape as the config repo) ─────────────────

function base(creds: Creds): string {
  return `${creds.url.replace(/\/$/, '')}/api/database/records`
}
function hdrs(creds: Creds): Record<string, string> {
  return { Authorization: `Bearer ${creds.key}`, 'Content-Type': 'application/json' }
}

async function get<T>(creds: Creds, table: string, query: string): Promise<T[]> {
  const res = await fetch(`${base(creds)}/${table}?${query}`, { headers: hdrs(creds) })
  if (!res.ok) throw new Error(`GET ${table} -> ${res.status}`)
  return (await res.json()) as T[]
}

async function post(creds: Creds, table: string, rows: Array<Record<string, unknown>>, opts: { representation?: boolean } = {}): Promise<Array<Record<string, unknown>>> {
  const prefer = [opts.representation ? 'return=representation' : 'return=minimal'].join(',')
  const res = await fetch(`${base(creds)}/${table}`, {
    method: 'POST',
    headers: { ...hdrs(creds), Prefer: prefer },
    body: JSON.stringify(rows),
  })
  if (!res.ok) throw new Error(`POST ${table} -> ${res.status}`)
  return opts.representation ? ((await res.json()) as Array<Record<string, unknown>>) : []
}

async function patch(creds: Creds, table: string, query: string, patch: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${base(creds)}/${table}?${query}`, { method: 'PATCH', headers: { ...hdrs(creds), Prefer: 'return=minimal' }, body: JSON.stringify(patch) })
  if (!res.ok) throw new Error(`PATCH ${table} -> ${res.status}`)
}

// ─── Runner ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const creds = loadCreds()
  const write = process.argv.includes('--yes')
  console.log(write ? 'MODE: write' : 'MODE: dry-run')

  const tables = await get<RateTableDb>(
    creds,
    'rate_tables',
    'select=id,organization_id,name,freight_type,rate_rows(tier,price,cost,price_model)&order=organization_id,name',
  )
  const { cards, skipped } = buildBackfillPlan(tables)

  // Idempotency: versions already carrying a source_key.
  const existing = await get<{ source_key: string; rate_card_id: string }>(creds, 'rate_card_versions', 'select=source_key,rate_card_id&source_key=not.is.null')
  const sourceKeyToCardId = new Map(existing.map((v) => [v.source_key, v.rate_card_id]))

  let created = 0
  for (const c of cards) {
    const already = sourceKeyToCardId.get(c.sourceKey)
    if (already) {
      console.log(`SKIP (exists) ${c.sourceKey} -> card ${already}`)
      continue
    }
    const label = (tier: string) => TIER_LABELS[tier] ?? tier
    console.log(`PLAN create ${c.sourceKey}: "${c.name}" AIR ${label(c.air.tier)} ${c.air.price}/${c.air.cost} · MAR ${label(c.mar.tier)} ${c.mar.price}/${c.mar.cost}`)
    if (!write) continue
    const card = await post(creds, 'rate_cards', [{ organization_id: c.org, name: c.name }], { representation: true })
    if (!card[0]) throw new Error(`rate card not created for ${c.sourceKey}`)
    const version = await post(creds, 'rate_card_versions', [{ rate_card_id: card[0].id, price_model: 'weight', currency: 'USD', status: 'published', source_key: c.sourceKey }], { representation: true })
    if (!version[0]) throw new Error(`version not created for ${c.sourceKey}`)
    await post(creds, 'rate_card_entries', [
      { rate_card_version_id: version[0].id, service_type: 'AIR', name: label(c.air.tier), unit: 'lb', price: c.air.price, cost: c.air.cost },
      { rate_card_version_id: version[0].id, service_type: 'MAR', name: label(c.mar.tier), unit: 'lb', price: c.mar.price, cost: c.mar.cost },
    ])
    sourceKeyToCardId.set(c.sourceKey, card[0].id as string)
    created++
    console.log(`CREATED ${c.sourceKey} -> card ${card[0].id}`)
  }

  // Remap client defaults (default_rate_id -> default_rate_card_id via REGULAR card).
  const clients = await get<{ id: string; organization_id: string; name_normalized: string; default_rate_id: string | null }>(
    creds,
    'billing_clients',
    'select=id,organization_id,name_normalized,default_rate_id&default_rate_id=not.is.null',
  )
  const tableNameById = new Map(tables.map((t) => [t.id, t.name]))
  for (const cl of clients) {
    const tblName = tableNameById.get(cl.default_rate_id as string)
    if (!tblName) {
      console.log(`WARN client ${cl.name_normalized}: default_rate_id ${cl.default_rate_id} -> unknown table.`)
      continue
    }
    const key = `${cl.organization_id}:${tblName}:REGULAR`
    const cardId = sourceKeyToCardId.get(key)
    if (!cardId) {
      console.log(`WARN client ${cl.name_normalized}: no REGULAR card for ${key}.`)
      continue
    }
    console.log(`PLAN remap client ${cl.name_normalized} -> ${key} (card ${cardId})`)
    if (!write) continue
    await patch(creds, 'billing_clients', `id=eq.${cl.id}`, { default_rate_card_id: cardId })
    console.log(`REMAP client ${cl.name_normalized} -> card ${cardId}`)
  }

  console.log(`\nSUMMARY: ${cards.length} cards, ${skipped.length} skipped, ${created} created.`)
  for (const s of skipped) {
    console.log(`  SKIPPED ${s.org}:${s.tableName}:${s.tier} — ${s.reason}`)
  }
  if (!write) console.log('\nDry-run only. Re-run with --yes to write.')
}

main().catch((e) => {
  console.error('backfill failed:', e instanceof Error ? e.message : e)
  process.exit(1)
})