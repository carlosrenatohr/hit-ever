// ============================================================================
// Migration orchestrator — ParsedInvoice[] -> InsForge, idempotent + auditable.
// ============================================================================
// Pure transforms (deriveStatus, isEmptyPlaceholder, buildLineRows) are exported
// for unit testing. runMigration() does the I/O: dedupe clients, upsert headers
// (conflict on fiscal_year+invoice_number => re-runnable), replace line-items and
// payments, and best-effort link packages by OC token. Everything dubious is
// counted into the report (nothing silently dropped).

import { computeAmounts, inferTier, round2 } from '../domain/calc.js'
import type { FreightType, InvoiceStatus } from '../domain/enums.js'
import type { CatalogEntry } from '../domain/types.js'
import type { BillingRepository, LineItemRow, PaymentRow } from '../repo/billing-repo.js'
import { normalizeClientName } from './normalize/client.js'
import type { ParsedInvoice } from './types.js'

export interface AmountMismatch {
  invoice: number
  year: number
  field: 'total' | 'profit'
  sheet: number
  computed: number
}

export interface ImportReport {
  invoicesUpserted: number
  voided: number
  skippedEmpty: number
  lineItems: number
  payments: number
  quarantinedPayments: number
  packagesLinked: number
  ocTokensUnmatched: number
  priceOffCatalog: number
  amountMismatches: AmountMismatch[]
  totalsByYear: Record<number, { stored: number; canonical: number }>
}

/** An invoice with no client, no lines and no payment cell is a blank placeholder row. */
export function isEmptyPlaceholder(inv: ParsedInvoice): boolean {
  return (
    !inv.isVoid &&
    inv.clientRaw.trim() === '' &&
    inv.lines.length === 0 &&
    (inv.payment == null || inv.payment.raw.trim() === '')
  )
}

/** Workflow status, mirroring how packages derive their status. */
export function deriveStatus(inv: ParsedInvoice): InvoiceStatus {
  if (inv.isVoid) return 'VOID'
  const p = inv.payment
  if (p?.isPartial) return 'PARTIAL'
  if (p && !p.quarantined && !p.isNoPayment && p.method != null) return 'PAID'
  return 'ISSUED'
}

const EPS = 0.01

/** Recompute canonical line rows from the catalog; collect mismatches vs the sheet. */
export function buildLineRows(
  inv: ParsedInvoice,
  catalog: Map<FreightType, CatalogEntry>,
): { rows: LineItemRow[]; priceOffCatalog: number; mismatches: AmountMismatch[]; storedTotal: number; canonicalTotal: number } {
  const rows: LineItemRow[] = []
  const mismatches: AmountMismatch[] = []
  let priceOffCatalog = 0
  let storedTotal = 0
  let canonicalTotal = 0

  inv.lines.forEach((line, idx) => {
    if (line.freightType == null) return
    const entry = catalog.get(line.freightType)
    if (!entry) return
    const canonical = computeAmounts(line.quantityLbs, line.unitPrice, entry.cost)
    const tier = inferTier(entry, line.unitPrice)
    if (tier == null) priceOffCatalog++

    // Historical fidelity: store what was actually billed (the sheet figures) and
    // fall back to the canonical computation only when the sheet cell is blank.
    // New invoices (Stage 3) are always computed fresh from the catalog instead.
    const total = line.sheetTotal ?? canonical.total
    const freightCost = line.sheetFreightCost ?? canonical.freightCost
    const profit = line.sheetProfit ?? round2(total - freightCost)

    // Flag (don't discard) where the sheet disagrees with the catalog math.
    if (line.sheetTotal != null && Math.abs(line.sheetTotal - canonical.total) > EPS) {
      mismatches.push({ invoice: inv.invoiceNumber, year: inv.fiscalYear, field: 'total', sheet: line.sheetTotal, computed: canonical.total })
    }
    if (line.sheetProfit != null && Math.abs(line.sheetProfit - canonical.profit) > EPS) {
      mismatches.push({ invoice: inv.invoiceNumber, year: inv.fiscalYear, field: 'profit', sheet: line.sheetProfit, computed: canonical.profit })
    }

    storedTotal += total
    canonicalTotal += canonical.total

    rows.push({
      line_no: idx + 1,
      description: line.description,
      freight_type: line.freightType,
      quantity_lbs: line.quantityLbs,
      unit: 'lbs',
      unit_price: line.unitPrice,
      total,
      list_price: line.listPrice,
      freight_cost: freightCost,
      profit,
      price_tier: tier,
      price_off_catalog: tier == null,
    })
  })

  return { rows, priceOffCatalog, mismatches, storedTotal, canonicalTotal }
}

/** Build payment rows: every non-empty Pago cell becomes one row (0 silently lost). */
export function buildPaymentRows(inv: ParsedInvoice): { rows: PaymentRow[]; quarantined: number } {
  const p = inv.payment
  if (!p || p.raw.trim() === '') return { rows: [], quarantined: 0 }
  const quarantined = p.quarantined || p.isNoPayment
  const row: PaymentRow = {
    method: p.method,
    bank: p.bank,
    currency: p.currency,
    amount: null,
    amount_usd: null,
    fx_rate: null,
    paid_at: inv.paidAt,
    raw: p.raw,
    quarantined,
  }
  return { rows: [row], quarantined: quarantined ? 1 : 0 }
}

export async function runMigration(
  repo: BillingRepository,
  catalogEntries: CatalogEntry[],
  invoices: ParsedInvoice[],
  opts: { dryRun?: boolean; linkPackages?: boolean } = {},
): Promise<ImportReport> {
  const catalog = new Map<FreightType, CatalogEntry>(catalogEntries.map((e) => [e.freightType, e]))
  const dryRun = opts.dryRun ?? false
  const linkPackages = opts.linkPackages ?? true

  const report: ImportReport = {
    invoicesUpserted: 0,
    voided: 0,
    skippedEmpty: 0,
    lineItems: 0,
    payments: 0,
    quarantinedPayments: 0,
    packagesLinked: 0,
    ocTokensUnmatched: 0,
    priceOffCatalog: 0,
    amountMismatches: [],
    totalsByYear: {},
  }

  // Cache client ids by normalized key within a run to avoid redundant upserts.
  const clientCache = new Map<string, string>()

  for (const inv of invoices) {
    if (isEmptyPlaceholder(inv)) {
      report.skippedEmpty++
      continue
    }
    if (inv.isVoid) report.voided++

    const status = deriveStatus(inv)

    // Client dedupe (skip for void / empty client).
    let clientId: string | null = null
    if (!inv.isVoid && inv.clientRaw.trim() !== '') {
      const { display, key } = normalizeClientName(inv.clientRaw)
      if (!dryRun) {
        clientId = clientCache.get(key) ?? (await repo.upsertClient(display, key))
        clientCache.set(key, clientId)
      }
    }

    const { rows: lineRows, priceOffCatalog, mismatches, storedTotal, canonicalTotal } = buildLineRows(inv, catalog)
    const { rows: payRows, quarantined } = buildPaymentRows(inv)

    report.priceOffCatalog += priceOffCatalog
    report.amountMismatches.push(...mismatches)
    report.lineItems += lineRows.length
    report.payments += payRows.length
    report.quarantinedPayments += quarantined
    if (!inv.isVoid) {
      const y = (report.totalsByYear[inv.fiscalYear] ??= { stored: 0, canonical: 0 })
      y.stored += storedTotal
      y.canonical += canonicalTotal
    }

    if (!dryRun) {
      const invoiceId = await repo.upsertInvoiceHeader({
        invoice_number: inv.invoiceNumber,
        fiscal_year: inv.fiscalYear,
        client_id: clientId,
        client_name_raw: inv.isVoid ? 'ANULADO' : inv.clientRaw,
        issue_date: inv.issueDate,
        status,
        paid_at: status === 'PAID' ? inv.paidAt : null,
        address: inv.address,
        special_price: inv.specialPrice,
        observations: inv.observations,
        tracking_orders: inv.oc,
        source: inv.source,
      })
      report.invoicesUpserted++
      await repo.replaceLineItems(invoiceId, lineRows)
      await repo.replacePayments(invoiceId, payRows)
      // Maintain denormalized header totals (imported payments carry no USD amount).
      const total = round2(lineRows.reduce((s, r) => s + (Number(r.total) || 0), 0))
      const profit = round2(lineRows.reduce((s, r) => s + (Number(r.profit) || 0), 0))
      await repo.setInvoiceTotals(invoiceId, { total, profit, paidUsd: 0 })

      if (linkPackages) {
        for (const token of inv.oc) {
          const pkgId = await repo.findPackageIdByToken(token)
          if (pkgId) {
            await repo.linkPackage(invoiceId, pkgId, 'auto', token, 'import')
            report.packagesLinked++
          } else {
            report.ocTokensUnmatched++
          }
        }
      }
    } else {
      report.invoicesUpserted++
    }
  }

  // Round year totals for a clean report.
  for (const y of Object.values(report.totalsByYear)) {
    y.stored = Math.round(y.stored * 100) / 100
    y.canonical = Math.round(y.canonical * 100) / 100
  }
  return report
}
