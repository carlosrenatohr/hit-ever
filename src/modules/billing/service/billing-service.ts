// ============================================================================
// BillingService — orchestrates invoice creation, payments, void, linking, close.
// ============================================================================
// New invoices are always priced fresh from the catalog (the dynamic engine); the
// service never trusts client-supplied money. Status is recomputed from payments,
// mirroring how packages derive their status. Pure helpers (computeStatus,
// paymentUsd, aggregateClose) are exported for unit tests.

import { CatalogService } from '../catalog/catalog.js'
import { margin, round2 } from '../domain/calc.js'
import type { Currency, FreightType, InvoiceStatus, PaymentBank, PaymentMethod, PriceTier } from '../domain/enums.js'
import { normalizeClientName } from '../ingest/normalize/client.js'
import type { BillingRepository, ExceptionsPayload, InvoiceBundle } from '../repo/billing-repo.js'

const EPS = 0.01

export interface CreateLineInput {
  freightType: FreightType
  tier: PriceTier
  quantityLbs: number
  description?: string | null
}
export interface CreateInvoiceInput {
  clientName: string
  issueDate?: string | null
  address?: string | null
  specialPrice?: boolean
  observations?: string | null
  status?: InvoiceStatus
  lines: CreateLineInput[]
  packageIds?: string[]
}
export interface ApplyPaymentInput {
  method: PaymentMethod
  bank?: PaymentBank | null
  currency: Currency
  amount: number
  fxRate?: number | null
  paidAt?: string | null
}

export interface InvoiceView {
  id: string
  invoiceNumber: number
  fiscalYear: number
  clientId: string | null
  clientName: string | null
  issueDate: string | null
  paidAt: string | null
  status: InvoiceStatus
  address: string | null
  specialPrice: boolean
  observations: string | null
  trackingOrders: string[]
  total: number
  profit: number
  margin: number | null
  paidUsd: number
  outstanding: number
  lines: Array<{
    lineNo: number
    description: string | null
    freightType: FreightType
    quantityLbs: number
    unitPrice: number
    total: number
    freightCost: number
    profit: number
    priceTier: PriceTier | null
    priceOffCatalog: boolean
  }>
  payments: Array<{
    method: string | null
    bank: string | null
    currency: string | null
    amount: number | null
    amountUsd: number | null
    fxRate: number | null
    paidAt: string | null
    raw: string | null
    quarantined: boolean
  }>
  packages: Array<{ packageId: string; source: 'auto' | 'manual'; matchedOc: string | null }>
}

export interface MonthlyClose {
  year: number
  month: number
  invoices: number
  revenue: number
  profit: number
  receivables: number
  byFreight: Record<FreightType, { revenue: number; profit: number; lbs: number }>
}

/** Customer-safe receipt — deliberately omits cost, profit, margin, freight cost, OC. */
export interface PublicReceipt {
  invoiceNumber: number
  issueDate: string | null
  clientName: string | null
  status: InvoiceStatus
  lines: Array<{ description: string | null; freightType: FreightType; quantityLbs: number; unitPrice: number; total: number }>
  total: number
  paidUsd: number
  outstanding: number
}

export interface YearReport {
  year: number
  invoices: number
  revenue: number
  profit: number
  receivables: number
  byMonth: Array<{ month: number; revenue: number; profit: number; invoices: number }>
  byFreight: Record<FreightType, { revenue: number; profit: number; lbs: number }>
}

export interface DateRangeSummary {
  from: string
  to: string
  invoices: number
  revenue: number
  profit: number
  receivables: number
  byFreight: Record<FreightType, { revenue: number; profit: number; lbs: number }>
}

/** Outstanding = billed but not fully paid, else 0. VOID never counts. */
function outstandingOf(status: InvoiceStatus, total: number, paidUsd: number): number {
  if (status === 'VOID' || status === 'PAID') return 0
  return round2(Math.max(0, total - paidUsd))
}

/** Recompute workflow status from paid-vs-total. VOID is terminal (never auto-changed). */
export function computeStatus(currentStatus: InvoiceStatus, total: number, paidUsd: number): InvoiceStatus {
  if (currentStatus === 'VOID') return 'VOID'
  if (total > 0 && paidUsd >= total - EPS) return 'PAID'
  if (paidUsd > 0) return 'PARTIAL'
  return currentStatus === 'DRAFT' ? 'DRAFT' : 'ISSUED'
}

/** Reconcile a payment to USD: USD passes through; NIO needs an fx rate (NIO per USD). */
export function paymentUsd(currency: Currency, amount: number, fxRate?: number | null): number | null {
  if (currency === 'USD') return round2(amount)
  if (currency === 'NIO' && fxRate && fxRate > 0) return round2(amount / fxRate)
  return null // unreconciled (no rate) — recorded but not counted toward paid
}

export function toView(b: InvoiceBundle): InvoiceView {
  const total = round2(b.lines.reduce((s, l) => s + (l.total || 0), 0))
  const profit = round2(b.lines.reduce((s, l) => s + (l.profit || 0), 0))
  const paidUsd = round2(b.payments.reduce((s, p) => s + (p.amount_usd || 0), 0))
  return {
    id: b.header.id,
    invoiceNumber: b.header.invoice_number,
    fiscalYear: b.header.fiscal_year,
    clientId: b.header.client_id,
    clientName: b.header.client_name_raw,
    issueDate: b.header.issue_date,
    paidAt: b.header.paid_at,
    status: b.header.status,
    address: b.header.address,
    specialPrice: b.header.special_price,
    observations: b.header.observations,
    trackingOrders: b.header.tracking_orders ?? [],
    total,
    profit,
    margin: margin(total, profit),
    paidUsd,
    outstanding: outstandingOf(b.header.status, total, paidUsd),
    lines: b.lines.map((l) => ({
      lineNo: l.line_no,
      description: l.description,
      freightType: l.freight_type,
      quantityLbs: l.quantity_lbs,
      unitPrice: l.unit_price,
      total: l.total,
      freightCost: l.freight_cost,
      profit: l.profit,
      priceTier: (l.price_tier as PriceTier | null) ?? null,
      priceOffCatalog: l.price_off_catalog,
    })),
    payments: b.payments.map((p) => ({
      method: p.method,
      bank: p.bank,
      currency: p.currency,
      amount: p.amount,
      amountUsd: p.amount_usd,
      fxRate: p.fx_rate,
      paidAt: p.paid_at,
      raw: p.raw,
      quarantined: p.quarantined,
    })),
    packages: b.packages.map((p) => ({ packageId: p.package_id, source: p.source, matchedOc: p.matched_oc })),
  }
}

/** Aggregate bundles for a month into the close report (excludes VOID). */
export function aggregateClose(year: number, month: number, bundles: InvoiceBundle[]): MonthlyClose {
  const byFreight: MonthlyClose['byFreight'] = {
    AIR: { revenue: 0, profit: 0, lbs: 0 },
    MAR: { revenue: 0, profit: 0, lbs: 0 },
  }
  let revenue = 0
  let profit = 0
  let receivables = 0
  let invoices = 0
  for (const b of bundles) {
    if (b.header.status === 'VOID') continue
    invoices++
    for (const l of b.lines) {
      revenue += l.total || 0
      profit += l.profit || 0
      const f = byFreight[l.freight_type]
      if (f) {
        f.revenue += l.total || 0
        f.profit += l.profit || 0
        f.lbs += l.quantity_lbs || 0
      }
    }
    if (b.header.status === 'ISSUED' || b.header.status === 'PARTIAL') {
      receivables += Math.max(0, (b.header.total || 0) - (b.header.paid_usd || 0))
    }
  }
  for (const f of Object.values(byFreight)) {
    f.revenue = round2(f.revenue)
    f.profit = round2(f.profit)
    f.lbs = round2(f.lbs)
  }
  return { year, month, invoices, revenue: round2(revenue), profit: round2(profit), receivables: round2(receivables), byFreight }
}

/** Aggregate a year's bundles into a monthly + by-freight report (excludes VOID). */
export function aggregateYear(year: number, bundles: InvoiceBundle[]): YearReport {
  const byMonth = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, revenue: 0, profit: 0, invoices: 0 }))
  const byFreight: YearReport['byFreight'] = { AIR: { revenue: 0, profit: 0, lbs: 0 }, MAR: { revenue: 0, profit: 0, lbs: 0 } }
  let revenue = 0
  let profit = 0
  let receivables = 0
  let invoices = 0
  for (const b of bundles) {
    if (b.header.status === 'VOID') continue
    invoices++
    const m = b.header.issue_date ? new Date(b.header.issue_date).getUTCMonth() : null
    for (const l of b.lines) {
      revenue += l.total || 0
      profit += l.profit || 0
      const f = byFreight[l.freight_type]
      if (f) {
        f.revenue += l.total || 0
        f.profit += l.profit || 0
        f.lbs += l.quantity_lbs || 0
      }
      if (m != null) {
        byMonth[m].revenue += l.total || 0
        byMonth[m].profit += l.profit || 0
      }
    }
    if (m != null) byMonth[m].invoices++
    if (b.header.status === 'ISSUED' || b.header.status === 'PARTIAL') {
      receivables += Math.max(0, (b.header.total || 0) - (b.header.paid_usd || 0))
    }
  }
  for (const r of byMonth) {
    r.revenue = round2(r.revenue)
    r.profit = round2(r.profit)
  }
  for (const f of Object.values(byFreight)) {
    f.revenue = round2(f.revenue)
    f.profit = round2(f.profit)
    f.lbs = round2(f.lbs)
  }
  return { year, invoices, revenue: round2(revenue), profit: round2(profit), receivables: round2(receivables), byMonth, byFreight }
}

/** Aggregate bundles for an arbitrary date range (excludes VOID). */
export function aggregateRange(from: string, to: string, bundles: InvoiceBundle[]): DateRangeSummary {
  const byFreight: DateRangeSummary['byFreight'] = {
    AIR: { revenue: 0, profit: 0, lbs: 0 },
    MAR: { revenue: 0, profit: 0, lbs: 0 },
  }
  let revenue = 0
  let profit = 0
  let receivables = 0
  let invoices = 0
  for (const b of bundles) {
    if (b.header.status === 'VOID') continue
    invoices++
    for (const l of b.lines) {
      revenue += l.total || 0
      profit += l.profit || 0
      const f = byFreight[l.freight_type]
      if (f) {
        f.revenue += l.total || 0
        f.profit += l.profit || 0
        f.lbs += l.quantity_lbs || 0
      }
    }
    if (b.header.status === 'ISSUED' || b.header.status === 'PARTIAL') {
      receivables += Math.max(0, (b.header.total || 0) - (b.header.paid_usd || 0))
    }
  }
  for (const f of Object.values(byFreight)) {
    f.revenue = round2(f.revenue)
    f.profit = round2(f.profit)
    f.lbs = round2(f.lbs)
  }
  return { from, to, invoices, revenue: round2(revenue), profit: round2(profit), receivables: round2(receivables), byFreight }
}

export class BillingService {
  private catalog: CatalogService
  constructor(private readonly repo: BillingRepository) {
    this.catalog = new CatalogService(repo)
  }

  async list(filter: Parameters<BillingRepository['listInvoices']>[0]) {
    const { rows, count } = await this.repo.listInvoices(filter)
    return {
      count,
      rows: rows.map((h) => ({
        id: h.id,
        invoiceNumber: h.invoice_number,
        fiscalYear: h.fiscal_year,
        clientName: h.client_name_raw,
        issueDate: h.issue_date,
        paidAt: h.paid_at,
        status: h.status,
        total: h.total,
        profit: h.profit,
        paidUsd: h.paid_usd,
        outstanding: outstandingOf(h.status, h.total, h.paid_usd),
      })),
    }
  }

  async get(id: string, organizationId?: string): Promise<InvoiceView | null> {
    const b = await this.repo.getInvoiceBundle(id, organizationId)
    return b ? toView(b) : null
  }

  async createInvoice(input: CreateInvoiceInput, actor: string, organizationId: string = 'hit'): Promise<InvoiceView> {
    if (!input.lines?.length) throw new Error('An invoice needs at least one line.')
    const issueDate = input.issueDate ?? new Date().toISOString().slice(0, 10)
    const fiscalYear = new Date(issueDate).getUTCFullYear()

    // Resolve the client first: its default rate table drives per-tenant pricing.
    const { display, key } = normalizeClientName(input.clientName)
    const clientId = await this.repo.upsertClient(display, key, organizationId)
    const defaultRateTableId = await this.repo.getClientDefaultRateTable(clientId)

    // Validate client-supplied package links BEFORE writing anything: a package
    // from another agency must never be attached to an invoice.
    for (const pkgId of input.packageIds ?? []) {
      if (!(await this.repo.packageBelongsToOrg(pkgId, organizationId))) {
        throw new Error(`Package ${pkgId} not found in your agency.`)
      }
    }

    // Price every line from the org's rate tables (client default first, legacy
    // catalog fallback); rejects a tier the org does not offer.
    const lineRows = []
    for (let i = 0; i < input.lines.length; i++) {
      const l = input.lines[i]
      const q = await this.catalog.quoteOrg(organizationId, l.freightType, l.tier, l.quantityLbs, defaultRateTableId)
      if (!q) throw new Error(`Tier ${l.tier} is not offered for ${l.freightType}.`)
      lineRows.push({
        line_no: i + 1,
        description: l.description ?? null,
        freight_type: l.freightType,
        quantity_lbs: l.quantityLbs,
        unit: 'lbs',
        unit_price: q.unitPrice,
        total: q.total,
        list_price: null,
        freight_cost: q.freightCost,
        profit: q.profit,
        price_tier: l.tier,
        price_off_catalog: false,
        organization_id: organizationId,
      })
    }
    const total = round2(lineRows.reduce((s, r) => s + r.total, 0))
    const profit = round2(lineRows.reduce((s, r) => s + r.profit, 0))

    const invoiceNumber = await this.repo.nextInvoiceNumber(fiscalYear, organizationId)

    const invoiceId = await this.repo.createInvoiceHeader({
      organization_id: organizationId,
      invoice_number: invoiceNumber,
      fiscal_year: fiscalYear,
      client_id: clientId,
      client_name_raw: display,
      issue_date: issueDate,
      status: input.status ?? 'ISSUED',
      address: input.address ?? null,
      special_price: input.specialPrice ?? false,
      observations: input.observations ?? null,
      tracking_orders: [],
      total,
      profit,
      paid_usd: 0,
    })
    await this.repo.insertLineItems(invoiceId, lineRows)
    for (const pkgId of input.packageIds ?? []) {
      await this.repo.linkPackage(invoiceId, pkgId, 'manual', null, actor, organizationId)
      // Package history entry: the invoice trace must live with the package too.
      await this.repo.insertPackageEvent(pkgId, `Factura #${invoiceNumber} generada`, new Date().toISOString())
    }
    return (await this.get(invoiceId, organizationId))!
  }

  async applyPayment(id: string, input: ApplyPaymentInput, organizationId: string): Promise<InvoiceView> {
    const b = await this.repo.getInvoiceBundle(id, organizationId)
    if (!b) throw new Error('Invoice not found.')
    if (b.header.status === 'VOID') throw new Error('Cannot pay a voided invoice.')

    const amountUsd = paymentUsd(input.currency, input.amount, input.fxRate)
    await this.repo.insertPayment(id, {
      method: input.method,
      bank: input.bank ?? null,
      currency: input.currency,
      amount: round2(input.amount),
      amount_usd: amountUsd,
      fx_rate: input.fxRate ?? null,
      paid_at: input.paidAt ?? new Date().toISOString(),
      raw: null,
      quarantined: false,
      organization_id: organizationId,
    })
    const total = round2(b.lines.reduce((s, l) => s + (l.total || 0), 0))
    const paidUsd = round2(b.payments.reduce((s, p) => s + (p.amount_usd || 0), 0) + (amountUsd ?? 0))
    const status = computeStatus(b.header.status, total, paidUsd)
    // Stamp paid_at when the invoice reaches PAID (for the issued->paid days badge).
    await this.repo.setInvoiceStatus(id, status, status === 'PAID' ? { paid_at: input.paidAt ?? new Date().toISOString() } : {})
    await this.repo.setInvoiceTotals(id, { total, profit: round2(b.lines.reduce((s, l) => s + (l.profit || 0), 0)), paidUsd })
    return (await this.get(id, organizationId))!
  }

  async voidInvoice(id: string, reason?: string, organizationId?: string): Promise<InvoiceView> {
    const b = await this.repo.getInvoiceBundle(id, organizationId)
    if (!b) throw new Error('Invoice not found.')
    await this.repo.setInvoiceStatus(id, 'VOID', reason ? { observations: reason } : {})
    return (await this.get(id, organizationId))!
  }

  async linkPackage(id: string, packageId: string, actor: string, organizationId: string): Promise<InvoiceView> {
    await this.repo.linkPackage(id, packageId, 'manual', null, actor, organizationId)
    const v = await this.get(id, organizationId)
    if (!v) throw new Error('Invoice not found.')
    await this.repo.insertPackageEvent(packageId, `Factura #${v.invoiceNumber} enlazada`, new Date().toISOString())
    return v
  }

  async unlinkPackage(id: string, packageId: string, organizationId?: string): Promise<InvoiceView> {
    await this.repo.unlinkPackage(id, packageId)
    const v = await this.get(id, organizationId)
    if (!v) throw new Error('Invoice not found.')
    return v
  }

  async closeMonth(year: number, month: number, organizationId?: string): Promise<MonthlyClose> {
    const from = `${year}-${String(month).padStart(2, '0')}-01`
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
    const to = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
    const bundles = await this.repo.getBundlesByDateRange(from, to, organizationId)
    return aggregateClose(year, month, bundles)
  }

  async yearReport(year: number, organizationId?: string): Promise<YearReport> {
    const bundles = await this.repo.getBundlesByDateRange(`${year}-01-01`, `${year}-12-31`, organizationId)
    return aggregateYear(year, bundles)
  }

  async summary(from: string, to: string, organizationId?: string): Promise<DateRangeSummary> {
    const bundles = await this.repo.getBundlesByDateRange(from, to, organizationId)
    return aggregateRange(from, to, bundles)
  }

  async exceptions(organizationId?: string): Promise<ExceptionsPayload> {
    return this.repo.getExceptions(organizationId)
  }

  /** Get (or lazily create) the invoice's public share token. */
  async shareInvoice(id: string, organizationId?: string): Promise<string> {
    const b = await this.repo.getInvoiceBundle(id, organizationId)
    if (!b) throw new Error('Invoice not found.')
    let token = b.header.public_token
    if (!token) {
      token = crypto.randomUUID()
      await this.repo.setPublicToken(id, token)
    }
    return token
  }

  /** Customer-safe receipt by public token, or null if the token is unknown. */
  async publicReceipt(token: string): Promise<PublicReceipt | null> {
    const b = await this.repo.getPublicBundle(token)
    if (!b) return null
    const total = round2(b.lines.reduce((s, l) => s + (l.total || 0), 0))
    const paidUsd = round2(b.header.paid_usd || 0)
    return {
      invoiceNumber: b.header.invoice_number,
      issueDate: b.header.issue_date,
      clientName: b.header.client_name_raw,
      status: b.header.status,
      lines: b.lines.map((l) => ({ description: l.description, freightType: l.freight_type, quantityLbs: l.quantity_lbs, unitPrice: l.unit_price, total: l.total })),
      total,
      paidUsd,
      outstanding: outstandingOf(b.header.status, total, paidUsd),
    }
  }
}
