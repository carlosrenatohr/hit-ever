// ============================================================================
// Storage-agnostic config persistence port + InsForge adapter.
// ============================================================================
// Same pattern as the billing module (src/modules/billing/repo/billing-repo.ts):
// routes/services depend on the interface, never on a concrete client. The
// InsForge adapter uses the Worker admin key (RLS bypass) over the
// PostgREST-style REST API. Audit writes go here too (ADR-011), with
// request_id propagated from the request for observability correlation.

import type { CloudflareBindings } from '../../../types/index.js'
import type { FreightType } from '../../billing/domain/enums.js'
import type { ActorType, Agency, AuditFilter, AuditLogEntry, RateTable, RateRow } from '../domain/types.js'

// ─── DB row shapes (snake_case, as returned by PostgREST) ─────────────────────
interface AgencyRow {
  slug: string
  name: string
  logo_url: string | null
  logo_key: string | null
}

interface RateTableRow {
  id: string
  organization_id: string
  name: string
  freight_type: FreightType
  created_at: string
  updated_at: string
  rate_rows: RateRowDb[]
}

interface RateRowDb {
  tier: string
  price: number
  cost: number
}

interface AuditRow {
  id: number
  organization_id: string
  actor_id: string | null
  actor_email: string | null
  actor_type: ActorType
  action: string
  entity_type: string
  entity_id: string | null
  request_id: string | null
  metadata: Record<string, unknown> | null
  created_at: string
}

export type Row = Record<string, unknown>

// ─── Port ───────────────────────────────────────────────────────────────────
export interface ConfigRepository {
  listAgencies(): Promise<Agency[]>
  listRateTables(organizationId: string): Promise<RateTable[]>
  getRateTable(id: string): Promise<RateTable | null>
  createRateTable(organizationId: string, name: string, freightType: FreightType, by: string | null): Promise<RateTable>
  updateRateTable(id: string, patch: Row): Promise<void>
  deleteRateTable(id: string): Promise<void>
  replaceRateRows(rateTableId: string, rows: RateRow[]): Promise<void>
  setClientDefaultRate(clientId: string, rateTableId: string | null): Promise<void>
  setPackageRateOverride(packageId: string, rateTableId: string | null, by: string | null): Promise<void>
  findPackageIdByToken(token: string): Promise<string | null>
  listAudit(organizationId: string, filter: AuditFilter): Promise<{ rows: AuditLogEntry[]; count: number }>
  insertAudit(entry: {
    organizationId: string
    actorId: string | null
    actorEmail: string | null
    actorType: ActorType
    action: string
    entityType: string
    entityId: string | null
    requestId: string | null
    metadata?: Record<string, unknown>
  }): Promise<void>
}

// ─── InsForge adapter ─────────────────────────────────────────────────────────
export class InsforgeConfigRepo implements ConfigRepository {
  private base: string
  private headers: Record<string, string>

  constructor(apiUrl: string, apiKey: string) {
    this.base = `${apiUrl.replace(/\/$/, '')}/api/database/records`
    this.headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
  }

  private async get<T>(table: string, query = ''): Promise<T[]> {
    const res = await fetch(`${this.base}/${table}${query ? `?${query}` : ''}`, { headers: this.headers })
    if (!res.ok) throw new Error(`InsForge GET ${table} → ${res.status}`)
    return (await res.json()) as T[]
  }

  /** GET returning both rows and the exact total count (PostgREST Content-Range). */
  private async getWithCount<T>(table: string, query: string): Promise<{ rows: T[]; count: number }> {
    const res = await fetch(`${this.base}/${table}?${query}`, {
      headers: { ...this.headers, Prefer: 'count=exact' },
    })
    if (!res.ok) throw new Error(`InsForge GET ${table} → ${res.status}`)
    const rows = (await res.json()) as T[]
    const range = res.headers.get('content-range') ?? ''
    const count = Number(range.split('/')[1]) || rows.length
    return { rows, count }
  }

  private async post<T>(table: string, rows: Row[], opts: { onConflict?: string; representation?: boolean } = {}): Promise<T[]> {
    if (rows.length === 0) return []
    const q = opts.onConflict ? `?on_conflict=${encodeURIComponent(opts.onConflict)}` : ''
    const prefer = [opts.onConflict ? 'resolution=merge-duplicates' : null, opts.representation ? 'return=representation' : 'return=minimal']
      .filter(Boolean)
      .join(',')
    const res = await fetch(`${this.base}/${table}${q}`, { method: 'POST', headers: { ...this.headers, Prefer: prefer }, body: JSON.stringify(rows) })
    if (!res.ok) throw new Error(`InsForge POST ${table} → ${res.status}: ${(await res.text()).slice(0, 300)}`)
    return opts.representation ? ((await res.json()) as T[]) : []
  }

  private async patch(table: string, query: string, patch: Row): Promise<void> {
    const res = await fetch(`${this.base}/${table}?${query}`, { method: 'PATCH', headers: { ...this.headers, Prefer: 'return=minimal' }, body: JSON.stringify(patch) })
    if (!res.ok) throw new Error(`InsForge PATCH ${table} → ${res.status}`)
  }

  private async del(table: string, query: string): Promise<void> {
    const res = await fetch(`${this.base}/${table}?${query}`, { method: 'DELETE', headers: { ...this.headers, Prefer: 'return=minimal' } })
    if (!res.ok) throw new Error(`InsForge DELETE ${table} → ${res.status}`)
  }

  // ─── Implementations ─────────────────────────────────────────────────────────

  async listAgencies(): Promise<Agency[]> {
    const rows = await this.get<AgencyRow>('agencies', 'select=slug,name,logo_url,logo_key&order=slug')
    return rows.map((r) => ({ slug: r.slug, name: r.name, logoUrl: r.logo_url, logoKey: r.logo_key }))
  }

  async listRateTables(organizationId: string): Promise<RateTable[]> {
    const rows = await this.get<RateTableRow>(
      'rate_tables',
      `organization_id=eq.${encodeURIComponent(organizationId)}&select=id,organization_id,name,freight_type,created_at,updated_at,rate_rows(tier,price,cost)&order=name`,
    )
    return rows.map(toRateTable)
  }

  async getRateTable(id: string): Promise<RateTable | null> {
    const rows = await this.get<RateTableRow>(
      'rate_tables',
      `id=eq.${encodeURIComponent(id)}&select=id,organization_id,name,freight_type,created_at,updated_at,rate_rows(tier,price,cost)&limit=1`,
    )
    return rows[0] ? toRateTable(rows[0]) : null
  }

  async createRateTable(organizationId: string, name: string, freightType: FreightType, by: string | null): Promise<RateTable> {
    const created = await this.post<RateTableRow>('rate_tables', [{ organization_id: organizationId, name, freight_type: freightType, created_by: by }], {
      representation: true,
    })
    if (!created[0]) throw new Error('Rate table was not created.')
    return toRateTable(created[0])
  }

  async updateRateTable(id: string, patch: Row): Promise<void> {
    await this.patch('rate_tables', `id=eq.${encodeURIComponent(id)}`, { ...patch, updated_at: new Date().toISOString() })
  }

  async deleteRateTable(id: string): Promise<void> {
    await this.del('rate_tables', `id=eq.${encodeURIComponent(id)}`)
  }

  async replaceRateRows(rateTableId: string, rows: RateRow[]): Promise<void> {
    if (rows.length === 0) {
      await this.del('rate_rows', `rate_table_id=eq.${encodeURIComponent(rateTableId)}`)
      return
    }
    await this.post('rate_rows', rows.map((r) => ({ rate_table_id: rateTableId, tier: r.tier, price: r.price, cost: r.cost })), {
      onConflict: 'rate_table_id,tier',
    })
    const keep = rows.map((r) => `"${r.tier}"`).join(',')
    await this.del('rate_rows', `rate_table_id=eq.${encodeURIComponent(rateTableId)}&tier=not.in.(${keep})`)
  }

  async setClientDefaultRate(clientId: string, rateTableId: string | null): Promise<void> {
    await this.patch('billing_clients', `id=eq.${encodeURIComponent(clientId)}`, { default_rate_id: rateTableId })
  }

  async setPackageRateOverride(packageId: string, rateTableId: string | null, by: string | null): Promise<void> {
    await this.patch('packages', `id=eq.${encodeURIComponent(packageId)}`, {
      rate_override_id: rateTableId,
      rate_override_by: by,
      rate_override_at: rateTableId ? new Date().toISOString() : null,
    })
  }

  async listAudit(organizationId: string, filter: AuditFilter): Promise<{ rows: AuditLogEntry[]; count: number }> {
    const q: string[] = [`organization_id=eq.${encodeURIComponent(organizationId)}`]
    if (filter.action) q.push(`action=eq.${encodeURIComponent(filter.action)}`)
    if (filter.entityType) q.push(`entity_type=eq.${encodeURIComponent(filter.entityType)}`)
    if (filter.entityId) q.push(`entity_id=eq.${encodeURIComponent(filter.entityId)}`)
    if (filter.from) q.push(`created_at=gte.${encodeURIComponent(filter.from)}`)
    if (filter.to) q.push(`created_at=lte.${encodeURIComponent(filter.to)}`)
    const pageSize = Math.min(filter.pageSize ?? 50, 200)
    const offset = ((filter.page ?? 1) - 1) * pageSize
    q.push(`select=id,organization_id,actor_id,actor_email,actor_type,action,entity_type,entity_id,request_id,metadata,created_at`)
    q.push(`order=created_at.desc&limit=${pageSize}&offset=${offset}`)
    const { rows, count } = await this.getWithCount<AuditRow>('audit_logs', q.join('&'))
    return {
      rows: rows.map((r) => ({
        id: r.id,
        organizationId: r.organization_id,
        actorId: r.actor_id,
        actorEmail: r.actor_email,
        actorType: r.actor_type,
        action: r.action,
        entityType: r.entity_type,
        entityId: r.entity_id,
        requestId: r.request_id,
        metadata: r.metadata ?? {},
        createdAt: r.created_at,
      })),
      count,
    }
  }

  async findPackageIdByToken(token: string): Promise<string | null> {
    const byAlmacen = await this.get<{ id: string }>('packages', `almacen_id=eq.${encodeURIComponent(token)}&select=id&limit=1`)
    if (byAlmacen[0]) return byAlmacen[0].id
    const byTracking = await this.get<{ id: string }>('packages', `tracking_number=eq.${encodeURIComponent(token)}&select=id&limit=1`)
    return byTracking[0]?.id ?? null
  }

  async insertAudit(entry: Parameters<ConfigRepository['insertAudit']>[0]): Promise<void> {
    await this.post('audit_logs', [
      {
        organization_id: entry.organizationId,
        actor_id: entry.actorId,
        actor_email: entry.actorEmail,
        actor_type: entry.actorType,
        action: entry.action,
        entity_type: entry.entityType,
        entity_id: entry.entityId,
        request_id: entry.requestId,
        metadata: entry.metadata ?? {},
      },
    ])
  }
}

function toRateTable(r: RateTableRow): RateTable {
  return {
    id: r.id,
    organizationId: r.organization_id,
    name: r.name,
    freightType: r.freight_type,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    rows: (r.rate_rows ?? []).map((row) => ({ tier: row.tier as RateRow['tier'], price: row.price, cost: row.cost })),
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────
export function getConfigRepo(env: CloudflareBindings): ConfigRepository {
  if (!env.INSFORGE_API_URL || !env.INSFORGE_API_KEY) {
    throw new Error('Config requires INSFORGE_API_URL and INSFORGE_API_KEY.')
  }
  return new InsforgeConfigRepo(env.INSFORGE_API_URL, env.INSFORGE_API_KEY)
}
