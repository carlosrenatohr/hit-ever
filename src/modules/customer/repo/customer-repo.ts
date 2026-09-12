import type { CloudflareBindings } from '../../../types/index.js'
import type { BillingClient } from '../../billing/domain/types.js'
import type { AuditFilter, AuditLogEntry } from '../../config/domain/types.js'
import type { CreateCustomerInput, CustomerAggregateStats, CustomerDeletePreview, CustomerEventsPage, CustomerListFilter, CustomerPage, CustomerWeightStats, CustomerWithStats, UpdateCustomerInput } from '../domain/types.js'

interface BillingClientDbRow {
  id: string
  name: string
  name_normalized: string
  casillero: string | null
  to_review: boolean
  email: string | null
  phone: string | null
  address: string | null
  company_name: string | null
  tax_id: string | null
  active: boolean
  deleted_at: string | null
  default_rate_id: string | null
  default_rate_card_id: string | null
  /** PostgREST aggregate embed — packages(count) → [{ count }] (derived, never stored). */
  packages?: { count: number }[]
}

/** audit_logs row as PostgREST returns it (snake_case). */
interface AuditRow {
  id: number
  organization_id: string
  actor_id: string | null
  actor_email: string | null
  actor_type: string
  action: string
  entity_type: string
  entity_id: string | null
  request_id: string | null
  metadata: Record<string, unknown> | null
  created_at: string
}

/** Actor context for audit entries written on customer mutations. */
export interface CustomerAuditEntry {
  organizationId: string
  actorId: string | null
  actorEmail: string | null
  actorType: 'user' | 'system' | 'service'
  action: string
  entityType: string
  entityId: string | null
  requestId: string | null
  metadata?: Record<string, unknown>
}

export interface CustomerRepository {
  list(filter: CustomerListFilter): Promise<CustomerPage>
  get(id: string, organizationId?: string): Promise<BillingClient | null>
  /** Per-client weight/package aggregates by service within a date range. */
  weightStats(organizationId: string, from?: string, to?: string): Promise<Record<string, CustomerWeightStats>>
  /** Agency-level KPI aggregates (totals + top clients by weight per service). */
  aggregateStats(organizationId: string, from?: string, to?: string): Promise<CustomerAggregateStats>
  /** Event timeline for a single client (audit_logs, entity-scoped). */
  listEvents(organizationId: string, clientId: string, filter: AuditFilter): Promise<CustomerEventsPage>
  create(input: {
    organizationId: string
    name: string
    nameNormalized: string
    casillero: string | null
    toReview: boolean
    email: string | null
    phone: string | null
    address: string | null
    companyName?: string | null
    taxId?: string | null
    active?: boolean
    defaultRateId?: string | null
    defaultRateCardId?: string | null
  }): Promise<BillingClient>
  update(
    id: string,
    input: {
      name?: string
      nameNormalized?: string
      casillero?: string | null
      toReview?: boolean
      email?: string | null
      phone?: string | null
      address?: string | null
      companyName?: string | null
      taxId?: string | null
      active?: boolean
      defaultRateId?: string | null
      defaultRateCardId?: string | null
    },
    organizationId?: string,
  ): Promise<BillingClient | null>
  /** Soft delete: PATCH deleted_at/by/reason scoped to the org. Returns the row or null. */
  delete(id: string, organizationId: string, deletedBy: string, reason: string | null): Promise<BillingClient | null>
  /** Impact summary (packages + invoices, capped samples) for the delete confirmation. */
  deletePreview(id: string, organizationId: string): Promise<CustomerDeletePreview | null>
  insertAudit(entry: CustomerAuditEntry): Promise<void>
}

function toDomain(row: BillingClientDbRow): BillingClient {
  return {
    id: row.id,
    name: row.name,
    nameNormalized: row.name_normalized,
    casillero: row.casillero ?? null,
    toReview: row.to_review,
    email: row.email ?? null,
    phone: row.phone ?? null,
    address: row.address ?? null,
    companyName: row.company_name ?? null,
    taxId: row.tax_id ?? null,
    active: row.active,
    deletedAt: row.deleted_at ?? null,
    packageCount: row.packages?.[0]?.count ?? 0,
    defaultRateId: row.default_rate_id ?? null,
    defaultRateCardId: row.default_rate_card_id ?? null,
  }
}

const ZERO_STATS: CustomerWeightStats = { weightMaritimo: 0, weightAereo: 0, countMaritimo: 0, countAereo: 0 }

/** Merges a client with its weight aggregates, defaulting to zero when absent. */
function withStats(client: BillingClient, stats?: CustomerWeightStats): CustomerWithStats {
  return { ...client, ...(stats ?? ZERO_STATS) }
}

const CLIENT_COLS =
  'id,name,name_normalized,casillero,to_review,email,phone,address,company_name,tax_id,active,deleted_at,default_rate_id,default_rate_card_id,packages(count)'

function statusPredicate(status: string): string {
  if (status === 'active') return 'active.eq.true'
  if (status === 'inactive') return 'active.eq.false'
  return 'to_review.eq.true'
}

export class InsforgeCustomerRepo implements CustomerRepository {
  private readonly base: string
  private readonly headers: Record<string, string>

  constructor(apiUrl: string, apiKey: string) {
    this.base = `${apiUrl.replace(/\/$/, '')}/api/database/records`
    this.headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
  }

  private async fetchRows<T>(query: string): Promise<T[]> {
    return this.fetchRowsFrom<T>('billing_clients', query)
  }

  private async fetchRowsWithCount<T>(query: string): Promise<{ rows: T[]; count: number }> {
    return this.fetchRowsWithCountFrom<T>('billing_clients', query)
  }

  private async fetchRowsFrom<T>(table: string, query: string): Promise<T[]> {
    const res = await fetch(`${this.base}/${table}?${query}`, { headers: this.headers })
    if (!res.ok) throw new Error(`InsForge GET ${table} → ${res.status}`)
    return (await res.json()) as T[]
  }

  private async fetchRowsWithCountFrom<T>(table: string, query: string): Promise<{ rows: T[]; count: number }> {
    const res = await fetch(`${this.base}/${table}?${query}`, {
      headers: { ...this.headers, Prefer: 'count=exact' },
    })
    if (!res.ok) throw new Error(`InsForge GET ${table} → ${res.status}`)
    const rows = (await res.json()) as T[]
    const range = res.headers.get('content-range') ?? ''
    return { rows, count: Number(range.split('/')[1]) || rows.length }
  }

  private async post<T>(row: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${this.base}/billing_clients`, {
      method: 'POST',
      headers: { ...this.headers, Prefer: 'return=representation' },
      body: JSON.stringify([row]),
    })
    if (!res.ok) throw new Error(`InsForge POST billing_clients → ${res.status}: ${(await res.text()).slice(0, 300)}`)
    const rows = (await res.json()) as T[]
    return rows[0]
  }

  private async callRpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${this.base.replace(/records\/?$/, '')}/rpc/${fn}`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(args),
    })
    if (!res.ok) throw new Error(`InsForge RPC ${fn} → ${res.status}: ${(await res.text()).slice(0, 300)}`)
    return (await res.json()) as T
  }

  private async patch(id: string, row: Record<string, unknown>, organizationId?: string): Promise<BillingClientDbRow | null> {
    // Tenant scope on writes: the org filter makes a cross-tenant PATCH a no-op.
    const orgFilter = organizationId ? `&organization_id=eq.${encodeURIComponent(organizationId)}` : ''
    const res = await fetch(`${this.base}/billing_clients?id=eq.${encodeURIComponent(id)}${orgFilter}`, {
      method: 'PATCH',
      headers: { ...this.headers, Prefer: 'return=representation' },
      body: JSON.stringify(row),
    })
    if (!res.ok) throw new Error(`InsForge PATCH billing_clients → ${res.status}`)
    const rows = (await res.json()) as BillingClientDbRow[]
    return rows[0] ?? null
  }

  private async postAudit(row: Record<string, unknown>): Promise<void> {
    const res = await fetch(`${this.base}/audit_logs`, {
      method: 'POST',
      headers: { ...this.headers, Prefer: 'return=minimal' },
      body: JSON.stringify([row]),
    })
    if (!res.ok) throw new Error(`InsForge POST audit_logs → ${res.status}: ${(await res.text()).slice(0, 300)}`)
  }

  async list(filter: CustomerListFilter): Promise<CustomerPage> {
    const page = Math.max(1, filter.page ?? 1)
    const pageSize = Math.min(100, Math.max(1, filter.pageSize ?? 25))
    const parts = [`select=${CLIENT_COLS}`, 'order=name.asc']
    parts.push(`organization_id=eq.${encodeURIComponent(filter.organizationId)}`)
    // Soft-deleted clients are out of every operational read by default.
    parts.push('deleted_at=is.null')
    if (filter.search) {
      const search = filter.search.replace(/[(),*]/g, '')
      parts.push(`name=ilike.*${encodeURIComponent(search)}*`)
    }
    if (filter.statuses?.length) {
      parts.push(`or=(${filter.statuses.map(statusPredicate).join(',')})`)
    } else if (filter.toReview !== undefined) {
      parts.push(`to_review=eq.${filter.toReview}`)
    }
    parts.push(`limit=${pageSize}`, `offset=${(page - 1) * pageSize}`)
    const { rows, count } = await this.fetchRowsWithCount<BillingClientDbRow>(parts.join('&'))
    // One RPC call for the whole agency's weight aggregates — never N calls per client.
    const stats = await this.weightStats(filter.organizationId, filter.from, filter.to)
    return { rows: rows.map((r) => withStats(toDomain(r), stats[r.id])), count }
  }

  async weightStats(organizationId: string, from?: string, to?: string): Promise<Record<string, CustomerWeightStats>> {
    return this.callRpc<Record<string, CustomerWeightStats>>('customer_weight_stats', {
      p_org: organizationId,
      p_from: from ?? null,
      p_to: to ?? null,
    })
  }

  async aggregateStats(organizationId: string, from?: string, to?: string): Promise<CustomerAggregateStats> {
    const out = await this.callRpc<CustomerAggregateStats>('customer_aggregate_stats', {
      p_org: organizationId,
      p_from: from ?? null,
      p_to: to ?? null,
    })
    return {
      totalWeightLb: out.totalWeightLb ?? 0,
      weightMaritimo: out.weightMaritimo ?? 0,
      weightAereo: out.weightAereo ?? 0,
      packageCountTotal: out.packageCountTotal ?? 0,
      packageCountMaritimo: out.packageCountMaritimo ?? 0,
      packageCountAereo: out.packageCountAereo ?? 0,
      topMaritimo: out.topMaritimo ?? null,
      topAereo: out.topAereo ?? null,
    }
  }

  async listEvents(organizationId: string, clientId: string, filter: AuditFilter): Promise<CustomerEventsPage> {
    const q: string[] = [`organization_id=eq.${encodeURIComponent(organizationId)}`, `entity_id=eq.${encodeURIComponent(clientId)}`]
    if (filter.action) q.push(`action=eq.${encodeURIComponent(filter.action)}`)
    if (filter.from) q.push(`created_at=gte.${encodeURIComponent(filter.from)}`)
    if (filter.to) q.push(`created_at=lte.${encodeURIComponent(filter.to)}`)
    const pageSize = Math.min(filter.pageSize ?? 50, 200)
    const offset = Math.min(((filter.page ?? 1) - 1) * pageSize, 10_000)
    q.push(`select=id,organization_id,actor_id,actor_email,actor_type,action,entity_type,entity_id,request_id,metadata,created_at`)
    q.push(`order=created_at.desc&limit=${pageSize}&offset=${offset}`)
    const { rows, count } = await this.fetchRowsWithCountFrom<AuditRow>('audit_logs', q.join('&'))
    return {
      rows: rows.map((r): AuditLogEntry => ({
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

  async get(id: string, organizationId?: string): Promise<BillingClient | null> {
    const orgFilter = organizationId ? `&organization_id=eq.${encodeURIComponent(organizationId)}` : ''
    const rows = await this.fetchRows<BillingClientDbRow>(`id=eq.${encodeURIComponent(id)}${orgFilter}&select=${CLIENT_COLS}&limit=1`)
    return rows[0] ? toDomain(rows[0]) : null
  }

  async delete(id: string, organizationId: string, deletedBy: string, reason: string | null): Promise<BillingClient | null> {
    const updated = await this.patch(
      id,
      { deleted_at: new Date().toISOString(), deleted_by: deletedBy, delete_reason: reason, updated_at: new Date().toISOString() },
      organizationId,
    )
    return updated ? toDomain(updated) : null
  }

  async deletePreview(id: string, organizationId: string): Promise<CustomerDeletePreview | null> {
    const client = await this.get(id, organizationId)
    if (!client) return null
    const [pkgs, invs] = await Promise.all([
      this.fetchRowsWithCountFrom<{ almacen_id: string | null; tracking_number: string | null }>(
        'packages',
        `client_id=eq.${encodeURIComponent(id)}&organization_id=eq.${encodeURIComponent(organizationId)}&select=almacen_id,tracking_number&limit=5&order=scraped_at.desc`,
      ),
      this.fetchRowsWithCountFrom<{ fiscal_year: number; invoice_number: number; status: string }>(
        'invoices',
        `client_id=eq.${encodeURIComponent(id)}&organization_id=eq.${encodeURIComponent(organizationId)}&select=fiscal_year,invoice_number,status&limit=5&order=fiscal_year.desc,invoice_number.desc`,
      ),
    ])
    return {
      client,
      packages: pkgs.rows.map((p) => ({ guia: p.almacen_id, tracking: p.tracking_number })),
      packageCount: pkgs.count,
      invoices: invs.rows.map((i) => ({ fiscalYear: i.fiscal_year, invoiceNumber: i.invoice_number, status: i.status })),
      invoiceCount: invs.count,
    }
  }

  async create(input: {
    organizationId: string
    name: string
    nameNormalized: string
    casillero: string | null
    toReview: boolean
    email: string | null
    phone: string | null
    address: string | null
    companyName?: string | null
    taxId?: string | null
    active?: boolean
    defaultRateId?: string | null
    defaultRateCardId?: string | null
  }): Promise<BillingClient> {
    const row = await this.post<BillingClientDbRow>({
      organization_id: input.organizationId,
      name: input.name,
      name_normalized: input.nameNormalized,
      casillero: input.casillero,
      to_review: input.toReview,
      email: input.email,
      phone: input.phone,
      address: input.address,
      company_name: input.companyName ?? null,
      tax_id: input.taxId ?? null,
      active: input.active ?? true,
      default_rate_id: input.defaultRateId ?? null,
      default_rate_card_id: input.defaultRateCardId ?? null,
    })
    return toDomain(row)
  }

  async update(
    id: string,
    input: {
      name?: string
      nameNormalized?: string
      casillero?: string | null
      toReview?: boolean
      email?: string | null
      phone?: string | null
      address?: string | null
      companyName?: string | null
      taxId?: string | null
      active?: boolean
      defaultRateId?: string | null
      defaultRateCardId?: string | null
    },
    organizationId?: string,
  ): Promise<BillingClient | null> {
    const row: Record<string, unknown> = {}
    if (input.name !== undefined) row.name = input.name
    if (input.nameNormalized !== undefined) row.name_normalized = input.nameNormalized
    if (input.casillero !== undefined) row.casillero = input.casillero
    if (input.toReview !== undefined) row.to_review = input.toReview
    if (input.email !== undefined) row.email = input.email
    if (input.phone !== undefined) row.phone = input.phone
    if (input.address !== undefined) row.address = input.address
    if (input.companyName !== undefined) row.company_name = input.companyName
    if (input.taxId !== undefined) row.tax_id = input.taxId
    if (input.active !== undefined) row.active = input.active
    if (input.defaultRateId !== undefined) row.default_rate_id = input.defaultRateId
    if (input.defaultRateCardId !== undefined) row.default_rate_card_id = input.defaultRateCardId
    row.updated_at = new Date().toISOString()
    const updated = await this.patch(id, row, organizationId)
    return updated ? toDomain(updated) : null
  }

  async insertAudit(entry: CustomerAuditEntry): Promise<void> {
    await this.postAudit({
      organization_id: entry.organizationId,
      actor_id: entry.actorId,
      actor_email: entry.actorEmail,
      actor_type: entry.actorType,
      action: entry.action,
      entity_type: entry.entityType,
      entity_id: entry.entityId,
      request_id: entry.requestId,
      metadata: entry.metadata ?? {},
    })
  }
}

export function getCustomerRepo(env: CloudflareBindings): CustomerRepository {
  if (!env.INSFORGE_API_URL || !env.INSFORGE_API_KEY) {
    throw new Error('Customer module requires INSFORGE_API_URL and INSFORGE_API_KEY.')
  }
  return new InsforgeCustomerRepo(env.INSFORGE_API_URL, env.INSFORGE_API_KEY)
}

export type CustomerRepositoryInput = CreateCustomerInput | UpdateCustomerInput