// ============================================================================
// Storage-agnostic billing persistence port + InsForge adapter.
// ============================================================================
// Same pattern as the tracker's TrackingRepository (src/lib/repository.ts): the
// service/routes depend on this interface, never on a concrete client. Swap the DB
// = new adapter + flip the factory. The InsForge adapter uses the Worker admin key
// (RLS bypass) over the PostgREST-style REST API.

import type { CloudflareBindings } from '../../../types/index.js'
import type { FreightType, InvoiceStatus } from '../domain/enums.js'
import type { CatalogEntry } from '../domain/types.js'

// ─── DB row shapes (snake_case, as returned by PostgREST) ───────────────────────
interface PricingCatalogRow {
  freight_type: FreightType
  cost: number
  tier_regular: number
  tier_especial: number
  tier_vip: number
  tier_madres: number | null
  tier_dario: number
}

export interface InvoiceHeaderDbRow {
  id: string
  invoice_number: number
  fiscal_year: number
  client_id: string | null
  client_name_raw: string | null
  issue_date: string | null
  status: InvoiceStatus
  address: string | null
  special_price: boolean
  observations: string | null
  tracking_orders: string[]
  agent_id: string | null
  public_token: string | null
  paid_at: string | null
  // Stored on the header by setInvoiceTotals (the service reads them on every
  // list/receivables pass; select=* returns them whether declared or not).
  total: number
  profit: number
  paid_usd: number
  // Financial lock (bulk-invoicing-foundation migration): non-NULL once the
  // invoice is closed — lines/links freeze, payments keep flowing.
  closed_at: string | null
  closed_by: string | null
  created_at: string
  updated_at: string
}

export interface LineItemDbRow {
  id: string
  invoice_id: string
  line_no: number
  description: string | null
  freight_type: FreightType | null
  line_type: 'freight' | 'other'
  concept_id: string | null
  quantity_lbs: number | null
  unit: string
  unit_price: number
  total: number
  list_price: number | null
  freight_cost: number
  profit: number
  price_tier: string | null
  price_off_catalog: boolean
  // Bulk-invoicing per-line snapshot: the package this freight line bills and
  // its guide/tracking text frozen at billing time (NULL on manual/import lines).
  package_id: string | null
  package_guia: string | null
  package_tracking: string | null
}

export interface PaymentDbRow {
  id: string
  invoice_id: string
  method: string | null
  bank: string | null
  currency: string | null
  amount: number | null
  amount_usd: number | null
  fx_rate: number | null
  paid_at: string | null
  raw: string | null
  quarantined: boolean
  reference: string | null
  comments: string | null
}

export interface PackageLinkDbRow {
  id: string
  invoice_id: string
  package_id: string
  source: 'auto' | 'manual'
  matched_oc: string | null
}

export interface InvoiceBundle {
  header: InvoiceHeaderDbRow
  lines: LineItemDbRow[]
  payments: PaymentDbRow[]
  packages: PackageLinkDbRow[]
}

export interface ListFilter {
  organizationId: string
  status?: InvoiceStatus
  fiscalYear?: number
  freightType?: FreightType
  clientId?: string
  search?: string
  from?: string // issue_date >=
  to?: string // issue_date <=
  page?: number
  pageSize?: number
}

function rowToCatalog(r: PricingCatalogRow): CatalogEntry {
  return {
    freightType: r.freight_type,
    cost: r.cost,
    tiers: { REGULAR: r.tier_regular, ESPECIAL: r.tier_especial, VIP: r.tier_vip, MADRES: r.tier_madres, DARIO: r.tier_dario },
  }
}

export type Row = Record<string, unknown>

/** One org rate table with its rows (config module's rate_tables/rate_rows). */
export interface OrgRateTable {
  id: string
  name: string
  freightType: FreightType
  rows: { tier: string; price: number; cost: number | null }[]
}

/** Row returned by getPackagesForBulk — the subset of package fields needed to price + link. */
export interface PackageBulkRow {
  id: string
  almacen_id: string
  tracking_number: string | null
  effective_status: string
  service_type: string | null
  weight_lb: number | null
  client_id: string | null
  referencia_name: string | null
  organization_id: string
}

export interface ExceptionRow {
  invoiceId: string
  invoiceNumber: number
  fiscalYear: number
  client: string | null
  detail: string
}
export interface ExceptionsPayload {
  offCatalog: ExceptionRow[]
  quarantinedPayments: ExceptionRow[]
  orphanInvoices: ExceptionRow[]
  clientsToReview: { id: string; name: string }[]
}

// ─── Port ───────────────────────────────────────────────────────────────────
export interface BillingRepository {
  getCatalog(): Promise<CatalogEntry[]>
  /** Org rate tables + rows — the per-tenant pricing source (legacy catalog is the fallback). */
  getOrgRates(organizationId: string): Promise<OrgRateTable[]>
  /** The client's default rate table (billing_clients.default_rate_id), or null. */
  getClientDefaultRateTable(clientId: string): Promise<string | null>
  upsertClient(display: string, key: string, organizationId: string): Promise<string>
  // Import (idempotent upsert path):
  upsertInvoiceHeader(row: Row): Promise<string>
  replaceLineItems(invoiceId: string, rows: Row[]): Promise<void>
  replacePayments(invoiceId: string, rows: Row[]): Promise<void>
  // CRUD (new invoices):
  nextInvoiceNumber(fiscalYear: number): Promise<number>
  createInvoiceHeader(row: Row): Promise<string>
  insertLineItems(invoiceId: string, rows: Row[]): Promise<void>
  insertPayment(invoiceId: string, row: Row): Promise<void>
  setInvoiceStatus(invoiceId: string, status: InvoiceStatus, patch?: Row): Promise<void>
  /**
   * Atomic close: patches ONLY while the invoice still matches what the caller
   * read (open + unchanged status), scoped to its organization. True = this
   * caller won the lock; false = a concurrent close/void/payment moved it
   * first — no clobbering, no resurrection of VOID.
   */
  closeInvoiceIfOpen(invoiceId: string, organizationId: string, expectedStatus: InvoiceStatus, newStatus: InvoiceStatus, closedAt: string, closedBy: string | null): Promise<boolean>
  setInvoiceTotals(invoiceId: string, totals: { total: number; profit: number; paidUsd: number }): Promise<void>
  listInvoices(filter: ListFilter): Promise<{ rows: InvoiceHeaderDbRow[]; count: number }>
  getInvoiceBundle(invoiceId: string, organizationId?: string): Promise<InvoiceBundle | null>
  getBundlesByDateRange(from: string, to: string, organizationId?: string): Promise<InvoiceBundle[]>
  setPublicToken(invoiceId: string, token: string): Promise<void>
  getPublicBundle(token: string): Promise<InvoiceBundle | null>
  // Exception queue (import + ongoing data-quality flags):
  getExceptions(organizationId?: string): Promise<ExceptionsPayload>
  // Package linking:
  getPackagesForBulk(packageIds: string[], organizationId: string): Promise<PackageBulkRow[]>
  packageBelongsToOrg(packageId: string, organizationId: string): Promise<boolean>
  /** Whether the charge concept exists within the agency (validates client input). */
  conceptBelongsToOrg(conceptId: string, organizationId: string): Promise<boolean>
  getChargeConcept(conceptId: string, organizationId: string): Promise<{ id: string; name: string } | null>
  /** Append an entry to the invoice's linear history (created/paid/voided/linked…). */
  insertInvoiceEvent(invoiceId: string, organizationId: string, action: string, detail: string | null, actor: string | null): Promise<void>
  listInvoiceEvents(invoiceId: string, organizationId: string): Promise<{ action: string; detail: string | null; actor: string | null; createdAt: string }[]>
  /** Append a panel-sourced entry to the package's event history (e.g. invoice generated). */
  insertPackageEvent(packageId: string, description: string, occurredAt: string): Promise<void>
  findPackageIdByToken(token: string, organizationId?: string): Promise<string | null>
  linkPackage(invoiceId: string, packageId: string, source: 'auto' | 'manual', matchedOc: string | null, by: string, organizationId: string): Promise<void>
  unlinkPackage(invoiceId: string, packageId: string): Promise<void>
}

// ─── InsForge adapter ─────────────────────────────────────────────────────────
export class InsforgeBillingRepo implements BillingRepository {
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
    if (!res.ok) {
      // Upstream detail (constraint names, table shapes) goes to Worker logs
      // only — never reflected to API clients through the thrown message.
      const detail = (await res.text()).slice(0, 500)
      console.error(`billing repo POST ${table} failed`, res.status, detail)
      throw new Error(`InsForge POST ${table} → ${res.status}`)
    }
    return opts.representation ? ((await res.json()) as T[]) : []
  }

  private async patch(table: string, query: string, patch: Row): Promise<void> {
    const res = await fetch(`${this.base}/${table}?${query}`, { method: 'PATCH', headers: { ...this.headers, Prefer: 'return=minimal' }, body: JSON.stringify(patch) })
    if (!res.ok) throw new Error(`InsForge PATCH ${table} → ${res.status}`)
  }

  /** PATCH that returns the updated rows (for guarded/conditional writes). */
  private async patchReturning<T>(table: string, query: string, patch: Row): Promise<T[]> {
    const res = await fetch(`${this.base}/${table}?${query}`, { method: 'PATCH', headers: { ...this.headers, Prefer: 'return=representation' }, body: JSON.stringify(patch) })
    if (!res.ok) throw new Error(`InsForge PATCH ${table} → ${res.status}`)
    return (await res.json()) as T[]
  }

  private async del(table: string, query: string): Promise<void> {
    const res = await fetch(`${this.base}/${table}?${query}`, { method: 'DELETE', headers: { ...this.headers, Prefer: 'return=minimal' } })
    if (!res.ok) throw new Error(`InsForge DELETE ${table} → ${res.status}`)
  }

  async getCatalog(): Promise<CatalogEntry[]> {
    const rows = await this.get<PricingCatalogRow>('pricing_catalog', 'order=freight_type.asc')
    return rows.map(rowToCatalog)
  }

  async getOrgRates(organizationId: string): Promise<OrgRateTable[]> {
    type RateTableRowDb = { id: string; name: string; freight_type: string; rate_rows: { tier: string; price: number; cost: number | null }[] }
    const rows = await this.get<RateTableRowDb>(
      'rate_tables',
      `organization_id=eq.${encodeURIComponent(organizationId)}&select=id,name,freight_type,rate_rows(tier,price,cost)&order=name`,
    )
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      freightType: r.freight_type as FreightType,
      rows: r.rate_rows ?? [],
    }))
  }

  async getClientDefaultRateTable(clientId: string): Promise<string | null> {
    const rows = await this.get<{ default_rate_id: string | null }>('billing_clients', `id=eq.${encodeURIComponent(clientId)}&select=default_rate_id&limit=1`)
    return rows[0]?.default_rate_id ?? null
  }

  async upsertClient(display: string, key: string, organizationId: string): Promise<string> {
    const rows = await this.post<{ id: string }>(
      'billing_clients',
      [{ name: display, name_normalized: key, organization_id: organizationId }],
      // Composite unique (organization_id, name_normalized) — same client name in a
      // different agency must create its own row, never merge across tenants.
      { onConflict: 'organization_id,name_normalized', representation: true },
    )
    return rows[0].id
  }

  async upsertInvoiceHeader(row: Row): Promise<string> {
    const rows = await this.post<{ id: string }>('invoices', [row], { onConflict: 'organization_id,fiscal_year,invoice_number', representation: true })
    return rows[0].id
  }

  async createInvoiceHeader(row: Row): Promise<string> {
    const rows = await this.post<{ id: string }>('invoices', [row], { representation: true })
    return rows[0].id
  }

  async replaceLineItems(invoiceId: string, rows: Row[]): Promise<void> {
    await this.del('invoice_line_items', `invoice_id=eq.${encodeURIComponent(invoiceId)}`)
    await this.insertLineItems(invoiceId, rows)
  }

  async insertLineItems(invoiceId: string, rows: Row[]): Promise<void> {
    await this.post('invoice_line_items', rows.map((r) => ({ ...r, invoice_id: invoiceId })))
  }

  async replacePayments(invoiceId: string, rows: Row[]): Promise<void> {
    await this.del('invoice_payments', `invoice_id=eq.${encodeURIComponent(invoiceId)}`)
    await this.post('invoice_payments', rows.map((r) => ({ ...r, invoice_id: invoiceId })))
  }

  async insertPayment(invoiceId: string, row: Row): Promise<void> {
    await this.post('invoice_payments', [{ ...row, invoice_id: invoiceId }])
  }

  async setInvoiceStatus(invoiceId: string, status: InvoiceStatus, patch: Row = {}): Promise<void> {
    await this.patch('invoices', `id=eq.${encodeURIComponent(invoiceId)}`, { status, updated_at: new Date().toISOString(), ...patch })
  }

  async closeInvoiceIfOpen(invoiceId: string, organizationId: string, expectedStatus: InvoiceStatus, newStatus: InvoiceStatus, closedAt: string, closedBy: string | null): Promise<boolean> {
    // Compare-and-set: the filters pin the exact state the caller read
    // (open + status unchanged, in-organization). A concurrent close/void
    // matches no rows instead of being clobbered.
    const q =
      `id=eq.${encodeURIComponent(invoiceId)}&organization_id=eq.${encodeURIComponent(organizationId)}` +
      `&closed_at=is.null&status=eq.${expectedStatus}`
    const rows = await this.patchReturning<{ id: string }>('invoices', q, {
      status: newStatus,
      closed_at: closedAt,
      closed_by: closedBy,
      updated_at: new Date().toISOString(),
    })
    return rows.length > 0
  }

  async setInvoiceTotals(invoiceId: string, totals: { total: number; profit: number; paidUsd: number }): Promise<void> {
    await this.patch('invoices', `id=eq.${encodeURIComponent(invoiceId)}`, {
      total: totals.total,
      profit: totals.profit,
      paid_usd: totals.paidUsd,
      updated_at: new Date().toISOString(),
    })
  }

  async nextInvoiceNumber(fiscalYear: number, organizationId?: string): Promise<number> {
    // Per-agency sequence: two agencies can each have their own #1 for a year.
    const orgFilter = organizationId ? `&organization_id=eq.${encodeURIComponent(organizationId)}` : ''
    const rows = await this.get<{ invoice_number: number }>('invoices', `fiscal_year=eq.${fiscalYear}${orgFilter}&select=invoice_number&order=invoice_number.desc&limit=1`)
    return (rows[0]?.invoice_number ?? 0) + 1
  }

  async listInvoices(filter: ListFilter): Promise<{ rows: InvoiceHeaderDbRow[]; count: number }> {
    const page = Math.max(1, filter.page ?? 1)
    const pageSize = Math.min(1000, Math.max(1, filter.pageSize ?? 25))
    const parts: string[] = ['select=*', 'order=fiscal_year.desc,invoice_number.desc']
    parts.push(`organization_id=eq.${encodeURIComponent(filter.organizationId)}`)
    if (filter.status) parts.push(`status=eq.${filter.status}`)
    if (filter.fiscalYear) parts.push(`fiscal_year=eq.${filter.fiscalYear}`)
    if (filter.clientId) parts.push(`client_id=eq.${filter.clientId}`)
    if (filter.from) parts.push(`issue_date=gte.${filter.from}`)
    if (filter.to) parts.push(`issue_date=lte.${filter.to}`)
    if (filter.search) {
      const s = filter.search.replace(/[(),*]/g, '')
      parts.push(`client_name_raw=ilike.*${encodeURIComponent(s)}*`)
    }
    // freightType lives on the line-items; resolve the matching invoice ids first.
    if (filter.freightType) {
      const lines = await this.get<{ invoice_id: string }>('invoice_line_items', `freight_type=eq.${filter.freightType}&select=invoice_id`)
      const ids = [...new Set(lines.map((l) => l.invoice_id))]
      if (ids.length === 0) return { rows: [], count: 0 }
      parts.push(`id=in.(${ids.join(',')})`)
    }
    const offset = (page - 1) * pageSize
    parts.push(`limit=${pageSize}`, `offset=${offset}`)
    return this.getWithCount<InvoiceHeaderDbRow>('invoices', parts.join('&'))
  }

  async getInvoiceBundle(invoiceId: string, organizationId?: string): Promise<InvoiceBundle | null> {
    const orgFilter = organizationId ? `&organization_id=eq.${encodeURIComponent(organizationId)}` : ''
    const headers = await this.get<InvoiceHeaderDbRow>('invoices', `id=eq.${encodeURIComponent(invoiceId)}&limit=1${orgFilter}`)
    const header = headers[0]
    if (!header) return null
    const [lines, payments, packages] = await Promise.all([
      this.get<LineItemDbRow>('invoice_line_items', `invoice_id=eq.${invoiceId}&order=line_no.asc`),
      this.get<PaymentDbRow>('invoice_payments', `invoice_id=eq.${invoiceId}&order=created_at.asc`),
      this.get<PackageLinkDbRow>('invoice_packages', `invoice_id=eq.${invoiceId}`),
    ])
    return { header, lines, payments, packages }
  }

  async setPublicToken(invoiceId: string, token: string): Promise<void> {
    await this.patch('invoices', `id=eq.${encodeURIComponent(invoiceId)}`, { public_token: token })
  }

  async getPublicBundle(token: string): Promise<InvoiceBundle | null> {
    const headers = await this.get<InvoiceHeaderDbRow>('invoices', `public_token=eq.${encodeURIComponent(token)}&limit=1`)
    const header = headers[0]
    if (!header) return null
    const lines = await this.get<LineItemDbRow>('invoice_line_items', `invoice_id=eq.${header.id}&order=line_no.asc`)
    return { header, lines, payments: [], packages: [] }
  }

  async getBundlesByDateRange(from: string, to: string, organizationId?: string): Promise<InvoiceBundle[]> {
    // Embed line-items in ONE request (PostgREST child embed) instead of N+1 per-invoice
    // queries — a full year is ~150 invoices and the Worker caps at 50 subrequests, so the
    // old fan-out blew the limit and 500'd. `limit=5000` covers any realistic range.
    type Row = InvoiceHeaderDbRow & { invoice_line_items: LineItemDbRow[] }
    const orgFilter = organizationId ? `&organization_id=eq.${encodeURIComponent(organizationId)}` : ''
    const rows = await this.get<Row>('invoices', `issue_date=gte.${from}&issue_date=lte.${to}${orgFilter}&select=*,invoice_line_items(*)&limit=5000`)
    return rows.map(({ invoice_line_items, ...header }) => ({
      header: header as InvoiceHeaderDbRow,
      lines: invoice_line_items ?? [],
      payments: [],
      packages: [],
    }))
  }

  async getExceptions(organizationId?: string): Promise<ExceptionsPayload> {
    type Emb = { invoice_number: number; fiscal_year: number; client_name_raw: string | null }
    const orgFilter = organizationId ? `&organization_id=eq.${encodeURIComponent(organizationId)}` : ''
    // Off-catalog line prices.
    const offRows = await this.get<{ invoice_id: string; unit_price: number; freight_type: string; invoices: Emb }>(
      'invoice_line_items',
      `price_off_catalog=eq.true&select=invoice_id,unit_price,freight_type,invoices(invoice_number,fiscal_year,client_name_raw)${orgFilter}`,
    )
    // Quarantined payment cells.
    const qRows = await this.get<{ invoice_id: string; raw: string | null; invoices: Emb }>(
      'invoice_payments',
      `quarantined=eq.true&select=invoice_id,raw,invoices(invoice_number,fiscal_year,client_name_raw)${orgFilter}`,
    )
    // Invoices carrying OC tokens but with no linked package (orphans).
    const withOc = await this.get<{ id: string; invoice_number: number; fiscal_year: number; client_name_raw: string | null; tracking_orders: string[] }>(
      'invoices',
      `status=neq.VOID&select=id,invoice_number,fiscal_year,client_name_raw,tracking_orders&limit=2000${orgFilter}`,
    )
    const linkedRows = await this.get<{ invoice_id: string }>('invoice_packages', `select=invoice_id&limit=5000${orgFilter}`)
    const linked = new Set(linkedRows.map((r) => r.invoice_id))
    const clients = await this.get<{ id: string; name: string }>('billing_clients', `to_review=eq.true&select=id,name${orgFilter}`)

    return {
      offCatalog: offRows.map((r) => ({ invoiceId: r.invoice_id, invoiceNumber: r.invoices?.invoice_number, fiscalYear: r.invoices?.fiscal_year, client: r.invoices?.client_name_raw ?? null, detail: `${r.freight_type} @ ${r.unit_price}/lb` })),
      quarantinedPayments: qRows.map((r) => ({ invoiceId: r.invoice_id, invoiceNumber: r.invoices?.invoice_number, fiscalYear: r.invoices?.fiscal_year, client: r.invoices?.client_name_raw ?? null, detail: r.raw ?? '(vacío)' })),
      orphanInvoices: withOc
        .filter((i) => (i.tracking_orders?.length ?? 0) > 0 && !linked.has(i.id))
        .map((i) => ({ invoiceId: i.id, invoiceNumber: i.invoice_number, fiscalYear: i.fiscal_year, client: i.client_name_raw ?? null, detail: (i.tracking_orders ?? []).join(', ') })),
      clientsToReview: clients.map((c) => ({ id: c.id, name: c.name })),
    }
  }

  async getPackagesForBulk(packageIds: string[], organizationId: string): Promise<PackageBulkRow[]> {
    if (packageIds.length === 0) return []
    const ids = packageIds.map((id) => encodeURIComponent(id)).join(',')
    const q = `id=in.(${ids})&organization_id=eq.${encodeURIComponent(organizationId)}&select=id,almacen_id,tracking_number,effective_status,service_type,weight_lb,client_id,referencia_name,organization_id&limit=${packageIds.length}`
    return this.get<PackageBulkRow>('packages', q)
  }

  async packageBelongsToOrg(packageId: string, organizationId: string): Promise<boolean> {
    const rows = await this.get<{ id: string }>('packages', `id=eq.${encodeURIComponent(packageId)}&organization_id=eq.${encodeURIComponent(organizationId)}&select=id&limit=1`)
    return rows.length > 0
  }

  async conceptBelongsToOrg(conceptId: string, organizationId: string): Promise<boolean> {
    const rows = await this.get<{ id: string }>('charge_concepts', `id=eq.${encodeURIComponent(conceptId)}&organization_id=eq.${encodeURIComponent(organizationId)}&select=id&limit=1`)
    return rows.length > 0
  }

  async getChargeConcept(conceptId: string, organizationId: string): Promise<{ id: string; name: string } | null> {
    const rows = await this.get<{ id: string; name: string }>('charge_concepts', `id=eq.${encodeURIComponent(conceptId)}&organization_id=eq.${encodeURIComponent(organizationId)}&select=id,name&limit=1`)
    return rows[0] ?? null
  }

  async insertInvoiceEvent(invoiceId: string, organizationId: string, action: string, detail: string | null, actor: string | null): Promise<void> {
    await this.post('invoice_events', [{ invoice_id: invoiceId, organization_id: organizationId, action, detail, actor }])
  }

  async listInvoiceEvents(invoiceId: string, organizationId: string): Promise<{ action: string; detail: string | null; actor: string | null; createdAt: string }[]> {
    const rows = await this.get<{ action: string; detail: string | null; actor: string | null; created_at: string }>(
      'invoice_events',
      `invoice_id=eq.${encodeURIComponent(invoiceId)}&organization_id=eq.${encodeURIComponent(organizationId)}&select=action,detail,actor,created_at&order=created_at.asc&limit=200`,
    )
    return rows.map((r) => ({ action: r.action, detail: r.detail, actor: r.actor, createdAt: r.created_at }))
  }

  async insertPackageEvent(packageId: string, description: string, occurredAt: string): Promise<void> {
    await this.post('events', [{ package_id: packageId, occurred_at: occurredAt, office: null, description, status: null, source: 'panel' }])
  }

  async findPackageIdByToken(token: string, organizationId?: string): Promise<string | null> {
    // Tenant scope: a package from another agency must never match.
    const orgFilter = organizationId ? `&organization_id=eq.${encodeURIComponent(organizationId)}` : ''
    const byAlmacen = await this.get<{ id: string }>('packages', `almacen_id=eq.${encodeURIComponent(token)}${orgFilter}&select=id&limit=1`)
    if (byAlmacen[0]) return byAlmacen[0].id
    const byTracking = await this.get<{ id: string }>('packages', `tracking_number=eq.${encodeURIComponent(token)}${orgFilter}&select=id&limit=1`)
    return byTracking[0]?.id ?? null
  }

  async linkPackage(invoiceId: string, packageId: string, source: 'auto' | 'manual', matchedOc: string | null, by: string, organizationId: string): Promise<void> {
    await this.post(
      'invoice_packages',
      [{ invoice_id: invoiceId, package_id: packageId, source, matched_oc: matchedOc, created_by: by, organization_id: organizationId }],
      { onConflict: 'invoice_id,package_id' },
    )
  }

  async unlinkPackage(invoiceId: string, packageId: string): Promise<void> {
    await this.del('invoice_packages', `invoice_id=eq.${encodeURIComponent(invoiceId)}&package_id=eq.${encodeURIComponent(packageId)}`)
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────
export function getBillingRepo(env: CloudflareBindings): BillingRepository {
  if (!env.INSFORGE_API_URL || !env.INSFORGE_API_KEY) {
    throw new Error('Billing requires INSFORGE_API_URL and INSFORGE_API_KEY.')
  }
  return new InsforgeBillingRepo(env.INSFORGE_API_URL, env.INSFORGE_API_KEY)
}
