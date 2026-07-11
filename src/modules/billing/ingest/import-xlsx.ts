// ============================================================================
// Offline historical import runner (Node, not the Worker).
// ============================================================================
// Reads the sales workbook, routes each sheet to its adapter, and upserts into
// InsForge via the billing repository. Idempotent: re-running produces the same
// state (conflict on fiscal_year+invoice_number). Only the 2025 + 2026 sheets are
// imported (Daniel is out of scope; BD is the catalog, already seeded).
//
// Usage:
//   pnpm import:billing -- --file "/mnt/c/Users/honch/Downloads/Recibos venta (1).xlsx"
//   pnpm import:billing -- --file "<path>" --dry-run     # parse + report, no writes
//
// Credentials: process.env.INSFORGE_API_URL / INSFORGE_API_KEY, else read from
// .insforge/project.json (oss_host + api_key).

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ExcelJS from 'exceljs'
import { InsforgeBillingRepo } from '../repo/billing-repo.js'
import { HeaderLevelAdapter } from './adapters/headerLevel.adapter.js'
import { LineItemAdapter } from './adapters/lineItem.adapter.js'
import { runMigration } from './migrate.js'
import type { ParsedInvoice, RawRow, SheetAdapter } from './types.js'

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

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

/** Unwrap an ExcelJS cell value to a primitive the adapters understand. */
function cellVal(v: unknown): string | number | Date | null {
  if (v == null) return null
  if (v instanceof Date) return v
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    if ('result' in o) return cellVal(o.result) // formula -> cached result
    if ('error' in o) return null // #REF! etc.
    if ('text' in o) return String(o.text) // hyperlink
    if ('richText' in o && Array.isArray(o.richText)) return (o.richText as { text: string }[]).map((t) => t.text).join('')
    return null
  }
  return v as string | number
}

/** Read a worksheet into 0-based RawRow[] (row 0 = header). */
function sheetToRows(ws: ExcelJS.Worksheet): RawRow[] {
  const rows: RawRow[] = []
  const cols = ws.columnCount
  for (let r = 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r)
    const arr: RawRow = []
    for (let c = 1; c <= cols; c++) arr.push(cellVal(row.getCell(c).value))
    rows.push(arr)
  }
  return rows
}

async function main() {
  const file = arg('file')
  if (!file) throw new Error('Missing --file "<path to xlsx>".')
  const dryRun = flag('dry-run')

  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(file)

  // Sheet -> (adapter, fiscal year). Daniel and BD are intentionally excluded.
  const plan: { sheet: string; adapter: SheetAdapter; year: number }[] = [
    { sheet: '2025', adapter: new LineItemAdapter('2025'), year: 2025 },
    { sheet: '2026 Q1', adapter: new HeaderLevelAdapter('2026 Q1'), year: 2026 },
    { sheet: '2026 Q2', adapter: new HeaderLevelAdapter('2026 Q2'), year: 2026 },
    { sheet: '2026 Q3', adapter: new HeaderLevelAdapter('2026 Q3'), year: 2026 },
  ]

  const invoices: ParsedInvoice[] = []
  for (const { sheet, adapter, year } of plan) {
    const ws = wb.getWorksheet(sheet)
    if (!ws) {
      console.warn(`[import] sheet "${sheet}" not found — skipping`)
      continue
    }
    const parsed = adapter.extract(sheetToRows(ws), year)
    console.log(`[import] ${sheet}: parsed ${parsed.length} invoices`)
    invoices.push(...parsed)
  }

  const { url, key } = loadCreds()
  const repo = new InsforgeBillingRepo(url, key)
  const catalog = await repo.getCatalog()
  if (catalog.length === 0) throw new Error('pricing_catalog is empty — apply the billing migration first.')

  console.log(`[import] ${dryRun ? 'DRY RUN' : 'WRITING'} — ${invoices.length} invoices, catalog has ${catalog.length} freight types`)
  const report = await runMigration(repo, catalog, invoices, { dryRun })

  console.log('\n──────── import report ────────')
  console.log(JSON.stringify(report, null, 2))
  console.log('───────────────────────────────')
  console.log(
    `invoices=${report.invoicesUpserted} void=${report.voided} skippedEmpty=${report.skippedEmpty} ` +
      `lines=${report.lineItems} payments=${report.payments} (quarantined=${report.quarantinedPayments}) ` +
      `linked=${report.packagesLinked} unmatchedOc=${report.ocTokensUnmatched} priceOffCatalog=${report.priceOffCatalog} ` +
      `mismatches=${report.amountMismatches.length}`,
  )
}

main().catch((e) => {
  console.error('[import] FAILED:', e instanceof Error ? e.message : e)
  process.exit(1)
})
