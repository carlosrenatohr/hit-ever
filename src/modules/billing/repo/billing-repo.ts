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
  created_at: string
  updated_at: string
}

export interface LineItemDbRow {
  id: string
  invoice_id: string
  line_no: number
  description: string | null
  freight_type: FreightType
  quantity_lbs: number
  unit: string
  unit_price: number
  total: number
  list_price: number | null
  freight_cost: number
  profit: number
  price_tier: string | null
  price_off_catalog: boolean
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

// ─── Port ───────────────────────────────────────────────────────────────────
export interface BillingRepository {
  getCatalog(): Promise<CatalogEntry[]>
  upsertClient(display: string, key: string): Promise<string>
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
  setInvoiceTotals(invoiceId: string, totals: { total: number; profit: number; paidUsd: number }): Promise<void>
  listInvoices(filter: ListFilter): Promise<{ rows: InvoiceHeaderDbRow[]; count: number }>
  getInvoiceBundle(invoiceId: string): Promise<InvoiceBundle | null>
  getBundlesByDateRange(from: string, to: string): Promise<InvoiceBundle[]>
  // Package linking:
  findPackageIdByToken(token: string): Promise<string | null>
  linkPackage(invoiceId: string, packageId: string, source: 'auto' | 'manual', matchedOc: string | null, by: string): Promise<void>
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

  async getCatalog(): Promise<CatalogEntry[]> {
    const rows = await this.get<PricingCatalogRow>('pricing_catalog', 'order=freight_type.asc')
    return rows.map(rowToCatalog)
  }

  async upsertClient(display: string, key: string): Promise<string> {
    const rows = await this.post<{ id: string }>('billing_clients', [{ name: display, name_normalized: key }], { onConflict: 'name_normalized', representation: true })
    return rows[0].id
  }

  async upsertInvoiceHeader(row: Row): Promise<string> {
    const rows = await this.post<{ id: string }>('invoices', [row], { onConflict: 'fiscal_year,invoice_number', representation: true })
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

  async setInvoiceTotals(invoiceId: string, totals: { total: number; profit: number; paidUsd: number }): Promise<void> {
    await this.patch('invoices', `id=eq.${encodeURIComponent(invoiceId)}`, {
      total: totals.total,
      profit: totals.profit,
      paid_usd: totals.paidUsd,
      updated_at: new Date().toISOString(),
    })
  }

  async nextInvoiceNumber(fiscalYear: number): Promise<number> {
    const rows = await this.get<{ invoice_number: number }>('invoices', `fiscal_year=eq.${fiscalYear}&select=invoice_number&order=invoice_number.desc&limit=1`)
    return (rows[0]?.invoice_number ?? 0) + 1
  }

  async listInvoices(filter: ListFilter): Promise<{ rows: InvoiceHeaderDbRow[]; count: number }> {
    const page = Math.max(1, filter.page ?? 1)
    const pageSize = Math.min(200, Math.max(1, filter.pageSize ?? 25))
    const parts: string[] = ['select=*', 'order=fiscal_year.desc,invoice_number.desc']
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

  async getInvoiceBundle(invoiceId: string): Promise<InvoiceBundle | null> {
    const headers = await this.get<InvoiceHeaderDbRow>('invoices', `id=eq.${encodeURIComponent(invoiceId)}&limit=1`)
    const header = headers[0]
    if (!header) return null
    const [lines, payments, packages] = await Promise.all([
      this.get<LineItemDbRow>('invoice_line_items', `invoice_id=eq.${invoiceId}&order=line_no.asc`),
      this.get<PaymentDbRow>('invoice_payments', `invoice_id=eq.${invoiceId}&order=created_at.asc`),
      this.get<PackageLinkDbRow>('invoice_packages', `invoice_id=eq.${invoiceId}`),
    ])
    return { header, lines, payments, packages }
  }

  async getBundlesByDateRange(from: string, to: string): Promise<InvoiceBundle[]> {
    const headers = await this.get<InvoiceHeaderDbRow>('invoices', `issue_date=gte.${from}&issue_date=lte.${to}&select=*`)
    return Promise.all(
      headers.map(async (header) => {
        const lines = await this.get<LineItemDbRow>('invoice_line_items', `invoice_id=eq.${header.id}`)
        return { header, lines, payments: [], packages: [] }
      }),
    )
  }

  async findPackageIdByToken(token: string): Promise<string | null> {
    const byAlmacen = await this.get<{ id: string }>('packages', `almacen_id=eq.${encodeURIComponent(token)}&select=id&limit=1`)
    if (byAlmacen[0]) return byAlmacen[0].id
    const byTracking = await this.get<{ id: string }>('packages', `tracking_number=eq.${encodeURIComponent(token)}&select=id&limit=1`)
    return byTracking[0]?.id ?? null
  }

  async linkPackage(invoiceId: string, packageId: string, source: 'auto' | 'manual', matchedOc: string | null, by: string): Promise<void> {
    await this.post('invoice_packages', [{ invoice_id: invoiceId, package_id: packageId, source, matched_oc: matchedOc, created_by: by }], { onConflict: 'invoice_id,package_id' })
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
