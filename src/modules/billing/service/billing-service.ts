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
import { SERVICE_TYPE_TO_FREIGHT } from '../domain/enums.js'
import { cleanClientDisplay, clientMatchKey, normalizeClientName } from '../ingest/normalize/client.js'
import { BillingError } from '../domain/errors.js'
import type { BillingRepository, ExceptionsPayload, InvoiceBundle } from '../repo/billing-repo.js'

const EPS = 0.01

export interface CreateLineInput {
  freightType: FreightType
  tier: PriceTier
  quantityLbs: number
  description?: string | null
  /** Explicit rate table for this line (overrides the client's default). Must
   * belong to the caller's agency — the server validates. */
  rateTableId?: string | null
  /** Package billed by this freight line. The server validates it and
   * snapshots guía/tracking into the line. */
  packageId?: string | null
}
export interface CreateOtherLineInput {
  /** Charge concept template used (traceability + prefill source). */
  conceptId?: string | null
  /** Extra free text appended to the concept name in the description. */
  description?: string | null
  /** Final amount for the line — always admin-set, never quoted. */
  amount: number
}
export interface CreateInvoiceInput {
  clientName: string
  issueDate?: string | null
  address?: string | null
  specialPrice?: boolean
  observations?: string | null
  status?: InvoiceStatus
  lines: CreateLineInput[]
  otherLines?: CreateOtherLineInput[]
  packageIds?: string[]
}
export interface ApplyPaymentInput {
  method: string
  bank?: string | null
  currency: Currency
  amount: number
  fxRate?: number | null
  paidAt?: string | null
  /** Optional free-text reference (transfer/transaction number). */
  reference?: string | null
  /** Optional free-text comment about the payment. */
  comments?: string | null
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
  closedAt: string | null
  closedBy: string | null
  lines: Array<{
    lineNo: number
    description: string | null
    freightType: FreightType | null
    lineType: 'freight' | 'other'
    quantityLbs: number | null
    unitPrice: number
    total: number
    freightCost: number
    profit: number
    priceTier: PriceTier | null
    priceOffCatalog: boolean
    packageId: string | null
    packageGuia: string | null
    packageTracking: string | null
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
  packages: Array<{ packageId: string; source: 'auto' | 'manual'; matchedOc: string | null; guia: string | null; tracking: string | null; active: boolean }>
  /** True when a live invoice bills packages whose active link is missing or
   *  released — the half-invoice integrity net (panel shows a warning banner). */
  integrityWarning: boolean | null
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
  clientAddress: string | null
  status: InvoiceStatus
  lines: Array<{ lineType: 'freight' | 'other'; description: string | null; freightType: FreightType | null; quantityLbs: number | null; unitPrice: number; total: number; guia: string | null; tracking: string | null }>
  total: number
  paidUsd: number
  outstanding: number
  agency: { name: string; logoUrl: string | null; ruc: string | null; address: string | null; phone: string | null; currency: Currency; exchangeRateNioPerUsd: number | null }
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

/** Resolve legacy lines that predate the per-line package snapshot. */
function resolvePackageLinks(lines: InvoiceBundle['lines'], packages: InvoiceBundle['packages']): Array<InvoiceBundle['packages'][number] | null> {
  const used = new Set<string>()
  return lines.map((line) => {
    if (line.line_type === 'other') return null
    const direct = line.package_id ? packages.find((p) => p.package_id === line.package_id) : null
    if (direct) {
      used.add(direct.package_id)
      return direct
    }
    if (packages.length === 1) return packages[0]
    const next = packages.find((p) => !used.has(p.package_id)) ?? null
    if (next) used.add(next.package_id)
    return next
  })
}

export function toView(b: InvoiceBundle): InvoiceView {
  const total = round2(b.lines.reduce((s, l) => s + (l.total || 0), 0))
  const profit = round2(b.lines.reduce((s, l) => s + (l.profit || 0), 0))
  const paidUsd = round2(b.payments.reduce((s, p) => s + (p.amount_usd || 0), 0))
  const resolvedPackages = resolvePackageLinks(b.lines, b.packages)
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
    closedAt: b.header.closed_at ?? null,
    closedBy: b.header.closed_by ?? null,
    lines: b.lines.map((l, i) => ({
      ...(() => {
        const pkg = resolvedPackages[i]
        return {
          packageId: l.package_id ?? pkg?.package_id ?? null,
          packageGuia: l.package_guia ?? pkg?.packages?.almacen_id ?? pkg?.matched_oc ?? null,
          packageTracking: l.package_tracking ?? pkg?.packages?.tracking_number ?? null,
        }
      })(),
      lineNo: l.line_no,
      description: l.description,
      freightType: l.freight_type,
      lineType: (l.line_type as 'freight' | 'other') ?? 'freight',
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
      reference: p.reference,
      comments: p.comments,
    })),
    packages: b.packages.map((p) => ({ packageId: p.package_id, source: p.source, matchedOc: p.matched_oc, guia: p.packages?.almacen_id ?? p.matched_oc ?? null, tracking: p.packages?.tracking_number ?? null, active: p.active !== false })),
    // Integrity warning (live invoices only — released links on VOID are by
    // design): a billed package without an active link means the invoice bills
    // something the linked-packages view doesn't reflect (double-billing risk).
    integrityWarning: b.header.status === 'VOID'
      ? null
      : (() => {
          const activeLinks = new Set(b.packages.filter((p) => p.active !== false).map((p) => p.package_id))
          const billedPkgs = new Set(b.lines.filter((l) => (l.line_type ?? 'freight') !== 'other' && l.package_id).map((l) => l.package_id))
          return billedPkgs.size > activeLinks.size || [...billedPkgs].some((id) => !activeLinks.has(id))
        })(),
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

  /**
   * Compensating rollback for a half-created invoice: release the links created
   * so far and archive the header. Packages go back to billable and no ghost
   * invoice survives. Best effort — failures inside the rollback are logged,
   * never re-thrown (the original error must win).
   */
  private async rollbackPartialInvoice(args: {
    invoiceId: string
    invoiceNumber: number
    organizationId: string
    actor: string
    flow: 'createInvoice' | 'createBulkInvoice'
    packageCount: number
    linkedCount: number | null
    supportCode: string
    error: unknown
  }): Promise<void> {
    const { invoiceId, invoiceNumber, organizationId, actor, flow, packageCount, linkedCount, supportCode, error } = args
    const message = error instanceof Error ? error.message : String(error)
    console.error(JSON.stringify({
      evt: 'billing.invoice.failed',
      flow,
      org: organizationId,
      actor,
      invoiceId,
      invoiceNumber,
      packageCount,
      linkedCount,
      supportCode,
      error: message,
    }))
    try {
      await this.repo.releasePackageLinksByInvoice(invoiceId, 'system:creation-failed')
      await this.repo.setInvoiceArchived(invoiceId, organizationId, 'system:creation-failed', `Creación incompleta revertida automáticamente (${supportCode})`)
      // One best-effort audit row on the failure path only (never on the happy
      // path): filter "billing.invoice.failed" in Workers Logs for the live trail.
      await this.repo.insertAuditLog({
        organizationId,
        actorEmail: actor,
        action: 'invoice.create_failed',
        entityType: 'invoice',
        entityId: invoiceId,
        metadata: { flow, invoice_number: invoiceNumber, package_count: packageCount, linked_count: linkedCount, support_code: supportCode, error: message },
      })
    } catch (rollbackError) {
      console.error(JSON.stringify({
        evt: 'billing.invoice.rollback_failed',
        flow,
        org: organizationId,
        invoiceId,
        invoiceNumber,
        supportCode,
        error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
      }))
    }
  }

  /**
   * Validate + resolve a set of packages for billing against one invoice.
   * Enforces org scope (via getPackagesForBulk), invoiceable status, client
   * match (client_id, or referencia_name for legacy rows), positive weight,
   * service type, and the active-link invariant. Returns a map id → snapshot
   * fields used to stamp each freight line and link the package.
   */
  private async resolveInvoicePackages(

    packageIds: string[],
    clientId: string | null,
    clientName: string | null,
    organizationId: string,
    excludeInvoiceId?: string,
  ): Promise<Map<string, { guia: string; tracking: string | null; serviceType: string | null; freightType: FreightType; weightLb: number | null }>> {
    const invoiceable = new Set(['en_destino', 'entregado'])
    const result = new Map<string, { guia: string; tracking: string | null; serviceType: string | null; freightType: FreightType; weightLb: number | null }>()
    if (packageIds.length === 0) return result
    const pkgs = await this.repo.getPackagesForBulk(packageIds, organizationId)
    const byId = new Map(pkgs.map((p) => [p.id, p]))
    // One batched read for the whole set — a per-package lookup here was the
    // fetch that scaled N subrequests and killed large invoices mid-loop.
    const activeLinks = await this.repo.getActivePackageLinks(packageIds)
    for (const id of packageIds) {
      const p = byId.get(id)
      if (!p) throw new Error(`El paquete ${id} no existe en tu agencia.`)
      if (!invoiceable.has(p.effective_status)) {
        throw new Error(`El paquete ${p.almacen_id} no está facturable (estado: ${p.effective_status}).`)
      }
      const refName = (p.referencia_name ?? '').trim() || null
      if (p.client_id && clientId && p.client_id !== clientId) {
        throw new Error(`El paquete ${p.almacen_id} pertenece a otro cliente.`)
      }
      if (!p.client_id && (!clientName || !refName || clientMatchKey(refName) !== clientMatchKey(clientName))) {
        throw new Error(`El paquete ${p.almacen_id} no tiene cliente asignado para ${clientName ?? 'esta factura'}.`)
      }
      if (p.weight_lb == null || p.weight_lb <= 0) {
        throw new Error(`El paquete ${p.almacen_id} no tiene peso.`)
      }
      if (!p.effective_service_type && !p.service_type) {
        throw new Error(`El paquete ${p.almacen_id} no tiene tipo de servicio.`)
      }
      const active = activeLinks.get(id)
      if (active && active !== excludeInvoiceId) {
        throw new Error(`El paquete ${p.almacen_id} ya está facturado (factura ${active}).`)
      }
      result.set(id, {
        guia: p.almacen_id,
        tracking: p.tracking_number,
        serviceType: p.effective_service_type ?? p.service_type,
        freightType: SERVICE_TYPE_TO_FREIGHT[p.effective_service_type ?? p.service_type ?? ''] ?? 'AIR',
        weightLb: p.weight_lb,
      })
    }
    return result
  }

  /** A client's packages in this agency, each marked eligible or not with a reason.
   *  Feeds the guided new-invoice flow (select client → pick unbilled guides). */
  async listUnbilledPackagesForClient(
    clientId: string,
    organizationId: string,
  ): Promise<{
    clientId: string
    packages: Array<{
      packageId: string
      guia: string | null
      tracking: string | null
      status: string
      serviceType: string | null
      freightType: FreightType | null
      weightLb: number | null
      eligible: boolean
      reason: string | null
    }>
  }> {
    const pkgs = await this.repo.getPackagesForClient(clientId, organizationId)
    const invoiceable = new Set(['en_destino', 'entregado'])
    // One batched read for the whole client (subrequest budget, not N).
    const activeLinks = await this.repo.getActivePackageLinks(pkgs.map((p) => p.id))
    const packages: Array<{
      packageId: string
      guia: string | null
      tracking: string | null
      status: string
      serviceType: string | null
      freightType: FreightType | null
      weightLb: number | null
      eligible: boolean
      reason: string | null
    }> = []
    for (const p of pkgs) {
      let reason: string | null = null
      if (!invoiceable.has(p.effective_status)) {
        reason = `Estado ${p.effective_status} no facturable`
      } else if (p.weight_lb == null || p.weight_lb <= 0) {
        reason = 'Sin peso'
      } else if (!p.effective_service_type && !p.service_type) {
        reason = 'Sin servicio'
      } else {
        const active = activeLinks.get(p.id)
        if (active) reason = 'Ya facturado'
      }
      packages.push({
        packageId: p.id,
        guia: p.almacen_id,
        tracking: p.tracking_number,
        status: p.effective_status,
        serviceType: p.effective_service_type ?? p.service_type,
        freightType: (p.effective_service_type ?? p.service_type) ? (SERVICE_TYPE_TO_FREIGHT[p.effective_service_type ?? p.service_type ?? ''] ?? null) : null,
        weightLb: p.weight_lb,
        eligible: reason === null,
        reason,
      })
    }
    return { clientId, packages }
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
        closedAt: h.closed_at ?? null,
        closedBy: h.closed_by ?? null,
        outstanding: outstandingOf(h.status, h.total, h.paid_usd),
      })),
    }
  }

  async get(id: string, organizationId?: string): Promise<InvoiceView | null> {
    const b = await this.repo.getInvoiceBundle(id, organizationId)
    return b ? toView(b) : null
  }

  async createInvoice(input: CreateInvoiceInput, actor: string, organizationId: string = 'hit'): Promise<InvoiceView> {
    if (!input.lines?.length) throw new Error('La factura necesita al menos una línea.')
    const issueDate = input.issueDate ?? new Date().toISOString().slice(0, 10)
    const fiscalYear = new Date(issueDate).getUTCFullYear()

    // Resolve the client first: its default rate drives per-tenant pricing
    // (rate card for migrated orgs, legacy table fallback).
    const { display, key } = normalizeClientName(input.clientName)
    const clientId = await this.repo.upsertClient(display, key, organizationId)
    const defaultRateTableId = clientId ? (await this.repo.getClientDefaultRateCard(clientId)) ?? (await this.repo.getClientDefaultRateTable(clientId)) : null
    // Deactivated clients can't be billed again (historical invoices stay intact).
    const clientActive = await this.repo.getClientLifecycle(clientId)
    if (clientActive === false) {
      throw new Error('El cliente está desactivado — reactiva su cuenta antes de facturar.')
    }

    // Package links come from the per-line packageId (guided flow) or the
    // legacy packageIds array. Validate them together (org, invoiceable,
    // client match, active-link) and resolve the guía/tracking snapshot.
    const linePkgIds = input.lines.filter((l) => l.packageId).map((l) => l.packageId as string)
    const packageIds = [...new Set([...(input.packageIds ?? []), ...linePkgIds])]
    const packageInfo = await this.resolveInvoicePackages(packageIds, clientId, display, organizationId)

    // Price every line from the org's rate tables (per-line table overrides the
    // client's default; legacy catalog fallback); rejects a tier the org does not offer.
    const lineRows = []
    for (let i = 0; i < input.lines.length; i++) {
      const l = input.lines[i]
      const q = await this.catalog.quoteOrg(organizationId, l.freightType, l.tier, l.quantityLbs, l.rateTableId ?? defaultRateTableId)
      if (!q) throw new Error(`El nivel ${l.tier} no está disponible para ${l.freightType}.`)
      const info = l.packageId ? packageInfo.get(l.packageId) : undefined
      lineRows.push({
        line_no: i + 1,
        description: l.description ?? null,
        freight_type: l.freightType,
        line_type: 'freight',
        concept_id: null,
        quantity_lbs: l.quantityLbs,
        unit: 'lbs',
        unit_price: q.unitPrice,
        total: q.total,
        list_price: null,
        freight_cost: q.freightCost,
        profit: q.profit,
        price_tier: l.tier,
        price_off_catalog: false,
        package_id: l.packageId ?? null,
        package_guia: info?.guia ?? null,
        package_tracking: info?.tracking ?? null,
        organization_id: organizationId,
        // Pricing provenance (snapshot — never recalculated from the current tariff).
        rate_card_id: q.rateCardId ?? null,
        rate_card_version_id: q.rateCardVersionId ?? null,
        rate_card_entry_id: q.rateCardEntryId ?? null,
        base_unit_price: q.unitPrice,
        discount_amount: 0,
        surcharge_amount: 0,
        pricing_source: q.pricingSource,
      })
    }
    // "Other" charges: admin-set amounts (never quoted). Each may reference a
    // concept template (validated against the agency) with extra free text.
    const otherLines = input.otherLines ?? []
    for (const o of otherLines) {
      if (!(o.amount > 0)) throw new Error('Los cargos adicionales necesitan un monto mayor a cero.')
      if (o.conceptId && !(await this.repo.conceptBelongsToOrg(o.conceptId, organizationId))) {
        throw new Error(`El concepto ${o.conceptId} no existe en tu agencia.`)
      }
    }
    let lineNo = lineRows.length
    for (const o of otherLines) {
      lineNo++
      let name = (o.description ?? '').trim()
      if (o.conceptId) {
        const concept = await this.repo.getChargeConcept(o.conceptId, organizationId)
        if (concept) name = name ? `${concept.name} — ${name}` : concept.name
      }
      lineRows.push({
        line_no: lineNo,
        description: name || 'Otro cargo',
        freight_type: null,
        line_type: 'other',
        concept_id: o.conceptId ?? null,
        quantity_lbs: null,
        unit: 'item',
        unit_price: round2(o.amount),
        total: round2(o.amount),
        list_price: null,
        freight_cost: 0,
        profit: round2(o.amount),
        price_tier: null,
        price_off_catalog: false,
        organization_id: organizationId,
      })
    }
    const total = round2(lineRows.reduce((s, r) => s + r.total, 0))
    const profit = round2(lineRows.reduce((s, r) => s + r.profit, 0))

    const invoiceNumber = await this.repo.nextInvoiceNumber(fiscalYear, organizationId)
    // Only an explicit DRAFT stays open (editable, payments blocked) until
    // closeInvoice() locks it. Anything else is final at creation and is
    // auto-closed here — the panel's "Nueva factura" flow (ISSUED) keeps
    // accepting payments exactly as before the financial lock existed.
    // Clamped defensively: PARTIAL/PAID/VOID can never be born, they are
    // derived from payments / the void override only.
    const initialStatus: InvoiceStatus = input.status === 'DRAFT' ? 'DRAFT' : 'ISSUED'

    const invoiceId = await this.repo.createInvoiceHeader({
      organization_id: organizationId,
      invoice_number: invoiceNumber,
      fiscal_year: fiscalYear,
      client_id: clientId,
      client_name_raw: display,
      issue_date: issueDate,
      status: initialStatus,
      closed_at: initialStatus === 'DRAFT' ? null : new Date().toISOString(),
      closed_by: initialStatus === 'DRAFT' ? null : actor,
      address: input.address ?? null,
      special_price: input.specialPrice ?? false,
      observations: input.observations ?? null,
      tracking_orders: [],
      total,
      profit,
      paid_usd: 0,
    })
    await this.repo.insertLineItems(invoiceId, lineRows)
    // Everything from here on is post-header work that must complete together:
    // lines, links, package events and the invoice event. If any step fails the
    // invoice is compensated (archived + links released) so no half-invoice
    // ghost survives blocking reports while letting the packages re-bill.
    const supportCode = `F-${crypto.randomUUID().slice(0, 8).toUpperCase()}`
    let linkedCount: number | null = null
    try {
      // matched_oc carries the guía: the linked-packages view must show the
      // guía, never a raw UUID. Batched posts keep the fetch budget constant.
      await this.repo.linkPackages(
        invoiceId,
        packageIds.map((pkgId) => ({ packageId: pkgId, matchedOc: packageInfo.get(pkgId)?.guia ?? null })),
        'manual',
        actor,
        organizationId,
      )
      const now = new Date().toISOString()
      await this.repo.insertPackageEvents(
        packageIds.map((pkgId) => ({ packageId: pkgId, description: `Factura #${invoiceNumber} generada`, occurredAt: now })),
      )
      // Integrity guard: linking fewer packages than the invoice bills silently
      // re-opens those packages for a second invoice (double billing).
      const linked = await this.repo.listActiveLinkedPackageIds(invoiceId)
      linkedCount = linked.length
      const missing = packageIds.filter((pkgId) => !linked.includes(pkgId))
      if (missing.length > 0) {
        throw new Error(`only linked ${linked.length} of ${packageIds.length} packages (${missing.length} missing)`)
      }
    } catch (e) {
      await this.rollbackPartialInvoice({
        invoiceId, invoiceNumber, organizationId, actor,
        flow: 'createInvoice', packageCount: packageIds.length, linkedCount, supportCode, error: e,
      })
      throw new BillingError(
        'INVOICE_CREATION_REVERTED',
        `No se pudo crear la factura completa. Se revirtió automáticamente: no se creó ninguna factura. Reintenta; si vuelve a pasar, envía este código a soporte: ${supportCode}.`,
        422,
      )
    }
    await this.repo.insertInvoiceEvent(invoiceId, organizationId, 'Factura generada', `Total ${total.toFixed(2)} USD`, actor)
    return (await this.get(invoiceId, organizationId))!
  }

  /**
   * Edit an open DRAFT invoice: re-quote lines, update totals, replace line items.
   * Only DRAFT with closed_at IS NULL is editable. Throws if the invoice is
   * closed, void, or not found. Returns the updated view.
   */
  async updateInvoice(
    id: string,
    input: {
      issueDate?: string | null
      observations?: string | null
      lines?: Array<{ freightType: FreightType; tier: PriceTier; quantityLbs: number; description?: string | null; rateTableId?: string | null; packageId?: string | null }>
      otherLines?: Array<{ conceptId?: string | null; description?: string | null; amount: number }>
    },
    actor: string,
    organizationId: string,
  ): Promise<InvoiceView> {
    const b = await this.repo.getInvoiceBundle(id, organizationId)
    if (!b) throw new Error('Factura no encontrada.')
    if (b.header.status === 'VOID') throw new Error('No se puede editar una factura anulada.')
    if (b.header.closed_at) throw new Error('La factura está cerrada — la edición está bloqueada.')

    // Update header fields if provided.
    const headerPatch: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (input.issueDate !== undefined) {
      headerPatch.issue_date = input.issueDate ?? null
    }
    if (input.observations !== undefined) {
      headerPatch.observations = input.observations ?? null
    }

    // Re-quote freight lines if provided.
    let lineRows: Array<Record<string, unknown>> | null = null
    let linePkgIds: string[] = []
    let packageInfo = new Map<string, { guia: string; tracking: string | null; serviceType: string | null; freightType: FreightType; weightLb: number | null }>()
    if (input.lines) {
      if (input.lines.length === 0) throw new Error('La factura necesita al menos una línea.')
      const clientId = b.header.client_id
      const defaultRateTableId = clientId ? (await this.repo.getClientDefaultRateCard(clientId)) ?? (await this.repo.getClientDefaultRateTable(clientId)) : null
      // Validate any per-line packages against this invoice (org, invoiceable,
      // client match, active-link) and resolve their guía/tracking snapshots.
      linePkgIds = input.lines.filter((l) => l.packageId).map((l) => l.packageId as string)
      packageInfo = await this.resolveInvoicePackages(linePkgIds, b.header.client_id, b.header.client_name_raw, organizationId, id)
      lineRows = []
      for (let i = 0; i < input.lines.length; i++) {
        const l = input.lines[i]
        const q = await this.catalog.quoteOrg(organizationId, l.freightType, l.tier, l.quantityLbs, l.rateTableId ?? defaultRateTableId)
        if (!q) throw new Error(`El nivel ${l.tier} no está disponible para ${l.freightType}.`)
        const info = l.packageId ? packageInfo.get(l.packageId) : undefined
        lineRows.push({
          line_no: i + 1,
          description: l.description ?? null,
          freight_type: l.freightType,
          line_type: 'freight',
          concept_id: null,
          quantity_lbs: l.quantityLbs,
          unit: 'lbs',
          unit_price: q.unitPrice,
          total: q.total,
          list_price: null,
          freight_cost: q.freightCost,
          profit: q.profit,
          price_tier: l.tier,
          price_off_catalog: false,
          package_id: l.packageId ?? null,
          package_guia: info?.guia ?? null,
          package_tracking: info?.tracking ?? null,
          organization_id: organizationId,
          rate_card_id: q.rateCardId ?? null,
          rate_card_version_id: q.rateCardVersionId ?? null,
          rate_card_entry_id: q.rateCardEntryId ?? null,
          base_unit_price: q.unitPrice,
          discount_amount: 0,
          surcharge_amount: 0,
          pricing_source: q.pricingSource,
        })
      }
    }

    // Re-build "other" lines if provided.
    let otherRows: Array<Record<string, unknown>> | null = null
    if (input.otherLines) {
      otherRows = []
      let lineNo = (lineRows ?? []).length || b.lines.filter((l) => l.line_type === 'freight').length
      for (const o of input.otherLines) {
        if (!(o.amount > 0)) throw new Error('Los cargos adicionales necesitan un monto mayor a cero.')
        if (o.conceptId && !(await this.repo.conceptBelongsToOrg(o.conceptId, organizationId))) {
          throw new Error(`El concepto ${o.conceptId} no existe en tu agencia.`)
        }
        lineNo++
        let name = (o.description ?? '').trim()
        if (o.conceptId) {
          const concept = await this.repo.getChargeConcept(o.conceptId, organizationId)
          if (concept) name = name ? `${concept.name} — ${name}` : concept.name
        }
        otherRows.push({
          line_no: lineNo,
          description: name || 'Otro cargo',
          freight_type: null,
          line_type: 'other',
          concept_id: o.conceptId ?? null,
          quantity_lbs: null,
          unit: 'item',
          unit_price: round2(o.amount),
          total: round2(o.amount),
          list_price: null,
          freight_cost: 0,
          profit: round2(o.amount),
          price_tier: null,
          price_off_catalog: false,
          organization_id: organizationId,
        })
      }
    }

    // If lines changed, replace them and recompute totals.
    if (lineRows || otherRows) {
      const allRows = [...(lineRows ?? []), ...(otherRows ?? [])]
      if (allRows.length > 0) {
        await this.repo.replaceLineItems(id, allRows)
        const total = round2(allRows.reduce((s, r) => s + ((r.total as number) || 0), 0))
        const profit = round2(allRows.reduce((s, r) => s + ((r.profit as number) || 0), 0))
        headerPatch.total = total
        headerPatch.profit = profit
        // Sync package links while the draft stays open. Only when the edited
        // lines actually carry packageIds — legacy edits that don't send them
        // leave the existing links untouched.
        if (linePkgIds.length > 0) {
          const desired = new Set(linePkgIds)
          const current = b.packages.filter((p) => p.active !== false).map((p) => p.package_id)
          for (const pkgId of linePkgIds) {
            if (!current.includes(pkgId)) {
              await this.repo.linkPackage(id, pkgId, 'manual', packageInfo.get(pkgId)?.guia ?? null, actor, organizationId)
              await this.repo.insertPackageEvent(pkgId, `Factura #${b.header.invoice_number} enlazada`, new Date().toISOString())
              await this.repo.insertInvoiceEvent(id, organizationId, 'Paquete enlazado', pkgId, actor)
            }
          }
          for (const pkgId of current) {
            if (!desired.has(pkgId)) {
              await this.repo.unlinkPackage(id, pkgId)
              await this.repo.insertPackageEvent(pkgId, `Factura #${b.header.invoice_number} desenlazada`, new Date().toISOString())
              await this.repo.insertInvoiceEvent(id, organizationId, 'Paquete desenlazado', pkgId, actor)
            }
          }
        }
      }
    }

    await this.repo.patchInvoiceHeader(id, organizationId, headerPatch)
    await this.repo.insertInvoiceEvent(id, organizationId, 'Factura actualizada', `Campos: ${Object.keys(input).filter((k) => input[k as keyof typeof input] !== undefined).join(', ')}`, actor)
    return (await this.get(id, organizationId))!
  }

  /**
   * Financial lock: freeze the invoice (lines, links, descriptions, amounts)
   * and enable payment registration. One-way — only a DRAFT is open in the
   * DRAFT-only model; a closed invoice can take payments or go VOID (admin
   * override). Closing a DRAFT promotes it to ISSUED (it left the edit phase).
   * The write itself is a compare-and-set (closed_at IS NULL) so concurrent
   * closes/voids can't clobber each other.
   */
  async closeInvoice(id: string, organizationId: string, actor: string | null): Promise<InvoiceView> {
    const b = await this.repo.getInvoiceBundle(id, organizationId)
    if (!b) throw new Error('Factura no encontrada.')
    if (b.header.status === 'VOID') throw new Error('No se puede cerrar una factura anulada.')
    if (b.header.closed_at) throw new Error('La factura ya está cerrada.')
    const status = b.header.status === 'DRAFT' ? 'ISSUED' : b.header.status
    const won = await this.repo.closeInvoiceIfOpen(id, organizationId, b.header.status, status, new Date().toISOString(), actor)
    if (!won) throw new Error('La factura ya fue cerrada o anulada — recarga la página.')
    const total = round2(b.lines.reduce((s, l) => s + (l.total || 0), 0))
    await this.repo.insertInvoiceEvent(id, organizationId, 'Factura cerrada', `Total fijado en ${total.toFixed(2)} USD`, actor)
    for (const p of b.packages) {
      if (p.active !== false) {
        await this.repo.insertPackageEvent(p.package_id, `Factura #${b.header.invoice_number} cerrada`, new Date().toISOString())
      }
    }
    return (await this.get(id, organizationId))!
  }

  async applyPayment(id: string, input: ApplyPaymentInput, organizationId: string, actor?: string | null): Promise<InvoiceView> {
    const b = await this.repo.getInvoiceBundle(id, organizationId)
    if (!b) throw new Error('Factura no encontrada.')
    if (b.header.status === 'VOID') throw new Error('No se puede pagar una factura anulada.')
    // Financial lock: the total must be frozen before money starts flowing.
    // Legacy/import invoices with payments were already backfilled as closed.
    if (!b.header.closed_at) throw new Error('Cierra la factura antes de registrar pagos.')

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
      reference: input.reference?.trim() || null,
      comments: input.comments?.trim() || null,
      organization_id: organizationId,
    })
    const total = round2(b.lines.reduce((s, l) => s + (l.total || 0), 0))
    const paidUsd = round2(b.payments.reduce((s, p) => s + (p.amount_usd || 0), 0) + (amountUsd ?? 0))
    const status = computeStatus(b.header.status, total, paidUsd)
    // Stamp paid_at when the invoice reaches PAID (for the issued->paid days badge).
    await this.repo.setInvoiceStatus(id, status, status === 'PAID' ? { paid_at: input.paidAt ?? new Date().toISOString() } : {})
    await this.repo.setInvoiceTotals(id, { total, profit: round2(b.lines.reduce((s, l) => s + (l.profit || 0), 0)), paidUsd })
    const ref = input.reference?.trim() ? ` · Ref ${input.reference.trim()}` : ''
    await this.repo.insertInvoiceEvent(id, organizationId, `Pago registrado (${input.method})`, `${input.amount.toFixed(2)} ${input.currency}${ref}`, actor ?? null)
    const payDesc = status === 'PAID' ? `Pago total de factura #${b.header.invoice_number}` : `Pago parcial de factura #${b.header.invoice_number}`
    for (const p of b.packages) {
      if (p.active !== false) {
        await this.repo.insertPackageEvent(p.package_id, payDesc, new Date().toISOString())
      }
    }
    return (await this.get(id, organizationId))!
  }

  async voidInvoice(id: string, reason?: string, organizationId?: string): Promise<InvoiceView> {
    const b = await this.repo.getInvoiceBundle(id, organizationId)
    if (!b) throw new Error('Factura no encontrada.')
    await this.repo.setInvoiceStatus(id, 'VOID', reason ? { observations: reason } : {})
    // Release all active package links so the packages can be re-invoiced.
    await this.repo.releasePackageLinksByInvoice(id, 'system:void')
    for (const p of b.packages) {
      if (p.active !== false) {
        await this.repo.insertPackageEvent(p.package_id, `Factura #${b.header.invoice_number} anulada`, new Date().toISOString())
      }
    }
    if (organizationId) {
      await this.repo.insertInvoiceEvent(id, organizationId, 'Factura anulada', reason ?? null, null)
    }
    return (await this.get(id, organizationId))!
  }

  /**
   * Archive (soft delete): hides the invoice from every operational read (list,
   * detail, mutations, reports, public receipt) and releases its active package
   * links so the packages become re-invoiced-able — otherwise archiving a
   * mistaken DRAFT would trap them behind an invoice the panel can no longer
   * open. Mirrors voidInvoice's audit trail (invoice event + per-package event);
   * restore is future work (same stance as ClientService.delete).
   */
  async archiveInvoice(id: string, reason: string | null, organizationId: string, actor: string): Promise<void> {
    const b = await this.repo.getInvoiceBundle(id, organizationId)
    if (!b) throw new Error('Factura no encontrada.')
    await this.repo.setInvoiceArchived(id, organizationId, actor, reason)
    await this.repo.releasePackageLinksByInvoice(id, 'system:archive')
    for (const p of b.packages) {
      if (p.active !== false) {
        await this.repo.insertPackageEvent(p.package_id, `Factura #${b.header.invoice_number} archivada`, new Date().toISOString())
      }
    }
    await this.repo.insertInvoiceEvent(id, organizationId, 'Factura archivada', reason, actor)
  }

  async linkPackage(id: string, packageId: string, actor: string, organizationId: string): Promise<InvoiceView> {
    // Closed invoices are frozen: no package may be attached after the lock.
    const before = await this.repo.getInvoiceBundle(id, organizationId)
    if (!before) throw new Error('Factura no encontrada.')
    if (before.header.closed_at) throw new Error('La factura está cerrada — los vínculos de paquetes están congelados.')
    // Tenant pin (same rule as createInvoice's packageIds): a package from
    // another agency can never be attached to this invoice.
    if (!(await this.repo.packageBelongsToOrg(packageId, organizationId))) {
      throw new Error(`El paquete ${packageId} no existe en tu agencia.`)
    }
    // Active-link invariant: a package with an active invoice cannot be linked
    // to another invoice.
    const active = await this.repo.getActivePackageLink(packageId)
    if (active && active.invoiceId !== id) {
      throw new Error(`El paquete ${packageId} ya está facturado (factura ${active.invoiceId}).`)
    }
    const [pkg] = await this.repo.getPackagesForBulk([packageId], organizationId)
    await this.repo.linkPackage(id, packageId, 'manual', pkg?.almacen_id ?? null, actor, organizationId)
    const v = await this.get(id, organizationId)
    if (!v) throw new Error('Factura no encontrada.')
    await this.repo.insertPackageEvent(packageId, `Factura #${v.invoiceNumber} enlazada`, new Date().toISOString())
    await this.repo.insertInvoiceEvent(id, organizationId, 'Paquete enlazado', packageId, actor)
    return v
  }

  async unlinkPackage(id: string, packageId: string, organizationId?: string): Promise<InvoiceView> {
    // Same freeze as linking: links are frozen once the invoice is closed.
    const before = await this.repo.getInvoiceBundle(id, organizationId)
    if (!before) throw new Error('Factura no encontrada.')
    if (before.header.closed_at) throw new Error('La factura está cerrada — los vínculos de paquetes están congelados.')
    await this.repo.unlinkPackage(id, packageId)
    const v = await this.get(id, organizationId)
    if (!v) throw new Error('Factura no encontrada.')
    await this.repo.insertPackageEvent(packageId, `Factura #${before.header.invoice_number} desenlazada`, new Date().toISOString())
    if (organizationId) {
      await this.repo.insertInvoiceEvent(id, organizationId, 'Paquete desenlazado', packageId, null)
    }
    return v
  }

  /** Linear history for the invoice detail timeline (org-scoped). */
  async events(id: string, organizationId: string) {
    return this.repo.listInvoiceEvents(id, organizationId)
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

  /** -- Package IDs that have at least one invoice link (org-scoped). -- */
  async linkedPackageIds(organizationId: string): Promise<string[]> {
    return this.repo.listLinkedPackageIds(organizationId)
  }

  /** Get (or lazily create) the invoice's public share token. */
  async shareInvoice(id: string, organizationId?: string): Promise<string> {
    const b = await this.repo.getInvoiceBundle(id, organizationId)
    if (!b) throw new Error('Factura no encontrada.')
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
    const resolvedPackages = resolvePackageLinks(b.lines, b.packages)
    // Fetch agency info for multi-tenant branding
    const agencyInfo = await this.repo.getAgencyInfo(b.header.organization_id)
    return {
      invoiceNumber: b.header.invoice_number,
      issueDate: b.header.issue_date,
      clientName: b.header.client_name_raw,
      clientAddress: b.header.address ?? null,
      status: b.header.status,
      lines: b.lines.map((l, i) => {
        // Resolve guia/tracking: prefer line snapshot, fall back to linked packages
        let guia = l.package_guia ?? null
        let tracking = l.package_tracking ?? null
        const pkg = resolvedPackages[i]
        if (!guia && pkg) guia = pkg.packages?.almacen_id ?? pkg.matched_oc ?? null
        if (!tracking && pkg) tracking = pkg.packages?.tracking_number ?? null
        if (l.line_type === 'other') { guia = null; tracking = null }
        return { lineType: (l.line_type as 'freight' | 'other') ?? 'freight', description: l.description, freightType: l.freight_type, quantityLbs: l.quantity_lbs, unitPrice: l.unit_price, total: l.total, guia, tracking }
      }),
      total,
      paidUsd,
      outstanding: outstandingOf(b.header.status, total, paidUsd),
      agency: {
        name: agencyInfo?.name ?? b.header.organization_id ?? 'Factura',
        logoUrl: agencyInfo?.logoUrl ?? null,
        ruc: agencyInfo?.ruc ?? null,
        address: agencyInfo?.address ?? null,
        phone: agencyInfo?.phone ?? null,
        currency: agencyInfo?.currency ?? 'USD',
        exchangeRateNioPerUsd: agencyInfo?.exchangeRateNioPerUsd ?? null,
      },
    }
  }

  // ─── Bulk invoicing (from Paquetería) ────────────────────────────────────────

  /**
   * Pre-validate a package selection without creating anything.
   * Returns per-package eligibility so the UI can explain why a selection is blocked.
   * Does NOT throw on ineligible packages — returns structured reasons instead.
   */
  async checkBulkEligibility(
    packageIds: string[],
    organizationId: string,
  ): Promise<{
    eligible: boolean
    reasons: Array<{ packageId: string; guia: string | null; code: string; message: string }>
  }> {
    if (!packageIds.length) return { eligible: false, reasons: [] }
    const pkgs = await this.repo.getPackagesForBulk(packageIds, organizationId)
    const foundIds = new Set(pkgs.map((p) => p.id))
    const reasons: Array<{ packageId: string; guia: string | null; code: string; message: string }> = []

    // One batched read instead of one per package (subrequest budget).
    const activeLinks = await this.repo.getActivePackageLinks(packageIds)

    // Missing or wrong-org packages
    for (const id of packageIds) {
      if (!foundIds.has(id)) {
        reasons.push({ packageId: id, guia: null, code: 'PACKAGE_NOT_FOUND', message: 'El paquete no existe en tu agencia.' })
      }
    }

    const invoiceable = new Set(['en_destino', 'entregado'])
    let clientName: string | null = null
    let clientId: string | null = null

    for (const p of pkgs) {
      // Status check
      if (!invoiceable.has(p.effective_status)) {
        reasons.push({ packageId: p.id, guia: p.almacen_id, code: 'PACKAGE_NOT_INVOICEABLE', message: `El paquete ${p.almacen_id} no está facturable (estado: ${p.effective_status}).` })
      }
      // Client check
      const name = (p.referencia_name ?? '').trim() || null
      if (!p.client_id && !name) {
        reasons.push({ packageId: p.id, guia: p.almacen_id, code: 'PACKAGE_CLIENT_MISSING', message: `El paquete ${p.almacen_id} no tiene cliente asignado.` })
      }
      // Mixed client check
      if (p.client_id && clientId && p.client_id !== clientId) {
        reasons.push({ packageId: p.id, guia: p.almacen_id, code: 'BULK_MIXED_CLIENTS', message: `El paquete ${p.almacen_id} pertenece a otro cliente.` })
      } else if (name && clientName && clientMatchKey(name) !== clientMatchKey(clientName) && !p.client_id) {
        reasons.push({ packageId: p.id, guia: p.almacen_id, code: 'BULK_MIXED_CLIENTS', message: `El paquete ${p.almacen_id} pertenece a otro cliente.` })
      }
      if (p.client_id) clientId = p.client_id
      if (name) clientName = name

      // Active invoice check
      const active = activeLinks.get(p.id)
      if (active) {
        reasons.push({ packageId: p.id, guia: p.almacen_id, code: 'PACKAGE_ALREADY_INVOICED', message: `El paquete ${p.almacen_id} ya está facturado.` })
      }

      // Weight check
      if (p.weight_lb == null || p.weight_lb <= 0) {
        reasons.push({ packageId: p.id, guia: p.almacen_id, code: 'PACKAGE_MISSING_WEIGHT', message: `El paquete ${p.almacen_id} no tiene peso.` })
      }
      // Service check
      if (!p.effective_service_type && !p.service_type) {
        reasons.push({ packageId: p.id, guia: p.almacen_id, code: 'PACKAGE_MISSING_SERVICE', message: `El paquete ${p.almacen_id} no tiene tipo de servicio.` })
      }
    }

    return { eligible: reasons.length === 0, reasons }
  }

  /**
   * Preview: validate + price a batch of packages before creating the invoice.
   * All packages must be in the same org, have an invoiceable status
   * (en_destino | entregado), and belong to one client (resolved from
   * client_id, falling back to referencia_name). Returns one priced line per
   * package with the snapshot data needed for the bulk create.
   */
  async previewBulkPackages(
    packageIds: string[],
    organizationId: string,
  ): Promise<{
    clientName: string
    clientId: string | null
    lines: Array<{
      packageId: string
      guia: string
      tracking: string | null
      serviceType: string | null
      freightType: FreightType
      weightLb: number | null
      tier: string
      unitPrice: number
      total: number
      freightCost: number
      profit: number
    }>
    total: number
    profit: number
  }> {
    if (!packageIds.length) throw new Error('No hay paquetes seleccionados.')
    if (packageIds.length > 100) throw new Error('Demasiados paquetes (máximo 100).')

    const pkgs = await this.repo.getPackagesForBulk(packageIds, organizationId)
    if (pkgs.length === 0) throw new Error('No hay paquetes en tu agencia.')

    // Validate: all invoiceable (en_destino | entregado)
    const invoiceable = new Set(['en_destino', 'entregado'])
    const bad = pkgs.filter((p) => !invoiceable.has(p.effective_status))
    if (bad.length) {
      throw new Error(`${bad.length} paquete(s) no están facturables (deben estar en destino o entregados).`)
    }

    // Validate: no package already has an active invoice link (one batched read).
    const activeLinks = await this.repo.getActivePackageLinks(packageIds)
    for (const p of pkgs) {
      const active = activeLinks.get(p.id)
      if (active) {
        throw new Error(`El paquete ${p.almacen_id} ya está facturado (factura ${active}).`)
      }
    }

    // Resolve client: prefer client_id (UUID) + referencia_name (display).
    // All packages must belong to one client.
    let clientName: string | null = null
    let clientId: string | null = null
    for (const p of pkgs) {
      const name = (p.referencia_name ?? '').trim() || null
      if (clientId && p.client_id && p.client_id !== clientId) {
        throw new Error('Los paquetes pertenecen a clientes distintos — facturá un cliente a la vez.')
      }
      if (clientName && name && clientMatchKey(name) !== clientMatchKey(clientName) && !p.client_id) {
        throw new Error('Los paquetes pertenecen a clientes distintos — facturá un cliente a la vez.')
      }
      if (p.client_id) clientId = p.client_id
      if (name) clientName = name
    }
    if (!clientName && !clientId) {
      throw new Error('Los paquetes no tienen cliente asignado — asigna un cliente primero.')
    }

    // Get the client's default rate (card for migrated orgs, legacy table fallback).
    const defaultRateTableId = clientId ? (await this.repo.getClientDefaultRateCard(clientId)) ?? (await this.repo.getClientDefaultRateTable(clientId)) : null
    // Deactivated clients can't be billed again (historical invoices stay intact).
    if (clientId) {
      const clientActive = await this.repo.getClientLifecycle(clientId)
      if (clientActive === false) {
        throw new Error('El cliente está desactivado — reactiva su cuenta antes de facturar.')
      }
    }

    // Price each line (one line per package, freight from effective_service_type, tier = REGULAR).
    const lines: Array<{
      packageId: string; guia: string; tracking: string | null; serviceType: string | null
      freightType: FreightType; weightLb: number | null; tier: string
      unitPrice: number; total: number; freightCost: number; profit: number
      rateCardId: string | null; rateCardVersionId: string | null; rateCardEntryId: string | null
      pricingSource: string
    }> = []
    for (const p of pkgs) {
      const effectiveService = p.effective_service_type ?? p.service_type
      const freightType = SERVICE_TYPE_TO_FREIGHT[effectiveService ?? ''] ?? 'AIR'
      const weightLb = p.weight_lb ?? 1 // minimum 1 lb for pricing
      const q = await this.catalog.quoteOrg(organizationId, freightType, 'REGULAR', weightLb, defaultRateTableId)
      lines.push({
        packageId: p.id,
        guia: p.almacen_id,
        tracking: p.tracking_number,
        serviceType: effectiveService,
        freightType,
        weightLb: p.weight_lb,
        tier: 'REGULAR',
        unitPrice: q ? round2(q.unitPrice) : 0,
        total: q ? round2(q.total) : 0,
        freightCost: q ? round2(q.freightCost) : 0,
        profit: q ? round2(q.profit) : 0,
        rateCardId: q?.rateCardId ?? null,
        rateCardVersionId: q?.rateCardVersionId ?? null,
        rateCardEntryId: q?.rateCardEntryId ?? null,
        pricingSource: q?.pricingSource ?? 'catalog',
      })
    }

    const total = round2(lines.reduce((s, l) => s + l.total, 0))
    const profit = round2(lines.reduce((s, l) => s + l.profit, 0))
    return { clientName: clientName ? cleanClientDisplay(clientName) : clientId!, clientId, lines, total, profit }
  }

  /**
   * Create: atomically build a DRAFT invoice from bulk-selected packages.
   * Snapshots each package's guide + tracking into the line item so the
   * invoice stays readable even if the package row changes. Links all
   * packages and emits timeline events.
   */
  async createBulkInvoice(
    input: { clientName: string; packageIds: string[]; observations?: string | null; issueDate?: string | null },
    actor: string,
    organizationId: string = 'hit',
  ): Promise<InvoiceView> {
    if (!input.packageIds?.length) throw new Error('No hay paquetes seleccionados.')

    // Re-validate + price via the preview path (single source of truth).
    const preview = await this.previewBulkPackages(input.packageIds, organizationId)

    const issueDate = input.issueDate ?? new Date().toISOString().slice(0, 10)
    const fiscalYear = new Date(issueDate).getUTCFullYear()
    const { display, key } = normalizeClientName(preview.clientName)
    const clientId = await this.repo.upsertClient(display, key, organizationId)
    const invoiceNumber = await this.repo.nextInvoiceNumber(fiscalYear, organizationId)

    // Build line rows — one freight line per package with snapshots.
    const lineRows = preview.lines.map((l, i) => ({
      line_no: i + 1,
      description: `${l.serviceType ?? 'paquete'}`,
      freight_type: l.freightType,
      line_type: 'freight',
      concept_id: null,
      quantity_lbs: l.weightLb ?? 1,
      unit: 'lbs',
      unit_price: l.unitPrice,
      total: l.total,
      list_price: null,
      freight_cost: l.freightCost,
      profit: l.profit,
      price_tier: l.tier,
      price_off_catalog: l.unitPrice === 0,
      package_id: l.packageId,
      package_guia: l.guia,
      package_tracking: l.tracking,
      organization_id: organizationId,
      rate_card_id: l.rateCardId,
      rate_card_version_id: l.rateCardVersionId,
      rate_card_entry_id: l.rateCardEntryId,
      base_unit_price: l.unitPrice,
      discount_amount: 0,
      surcharge_amount: 0,
      pricing_source: l.pricingSource,
    }))

    const total = round2(lineRows.reduce((s, r) => s + r.total, 0))
    const profit = round2(lineRows.reduce((s, r) => s + r.profit, 0))

    // Create as DRAFT (stays open until closeInvoice is called).
    const invoiceId = await this.repo.createInvoiceHeader({
      organization_id: organizationId,
      invoice_number: invoiceNumber,
      fiscal_year: fiscalYear,
      client_id: clientId,
      client_name_raw: display,
      issue_date: issueDate,
      status: 'DRAFT',
      closed_at: null,
      closed_by: null,
      address: null,
      special_price: false,
      observations: input.observations ?? null,
      tracking_orders: [],
      total,
      profit,
      paid_usd: 0,
    })

    await this.repo.insertLineItems(invoiceId, lineRows)

    // Link every package + emit timeline events, batched and guarded like the
    // guided flow: any failure compensates the whole invoice (archive + release).
    const supportCode = `F-${crypto.randomUUID().slice(0, 8).toUpperCase()}`
    const bulkPackageIds = preview.lines.map((l) => l.packageId)
    let linkedCount: number | null = null
    try {
      // matched_oc carries the guía so the linked-packages view shows the guide,
      // never a raw UUID.
      await this.repo.linkPackages(
        invoiceId,
        preview.lines.map((l) => ({ packageId: l.packageId, matchedOc: l.guia })),
        'manual',
        actor,
        organizationId,
      )
      const now = new Date().toISOString()
      await this.repo.insertPackageEvents(
        bulkPackageIds.map((pkgId) => ({ packageId: pkgId, description: `Factura #${invoiceNumber} generada`, occurredAt: now })),
      )
      const linked = await this.repo.listActiveLinkedPackageIds(invoiceId)
      linkedCount = linked.length
      const missing = bulkPackageIds.filter((pkgId) => !linked.includes(pkgId))
      if (missing.length > 0) {
        throw new Error(`only linked ${linked.length} of ${bulkPackageIds.length} packages (${missing.length} missing)`)
      }
    } catch (e) {
      await this.rollbackPartialInvoice({
        invoiceId, invoiceNumber, organizationId, actor,
        flow: 'createBulkInvoice', packageCount: bulkPackageIds.length, linkedCount, supportCode, error: e,
      })
      throw new BillingError(
        'INVOICE_CREATION_REVERTED',
        `No se pudo crear la factura completa. Se revirtió automáticamente: no se creó ninguna factura. Reintenta; si vuelve a pasar, envía este código a soporte: ${supportCode}.`,
        422,
      )
    }

    await this.repo.insertInvoiceEvent(invoiceId, organizationId, 'Factura generada', `Bulk: ${input.packageIds.length} paquetes, total ${total.toFixed(2)} USD`, actor)
    return (await this.get(invoiceId, organizationId))!
  }
}
