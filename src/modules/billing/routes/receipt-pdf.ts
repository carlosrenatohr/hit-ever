// ============================================================================
// On-the-fly PDF receipt builder — no persistence, no external services.
// Renders the same customer-safe receipt data as the HTML route into a PDF
// (pdf-lib, pure JS) so a share link can download the invoice directly.
// ============================================================================

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import type { PublicReceipt } from '../service/billing-service.js'
import { money, formatPhone, FREIGHT_ES } from './public.js'

const INK = rgb(0.07, 0.07, 0.07)
const MUTED = rgb(0.42, 0.42, 0.42)
const BRAND = rgb(0.75, 0.13, 0.13)
const LINE = rgb(0.86, 0.86, 0.86)
const PAGE_W = 595 // A4
const PAGE_H = 842
const MARGIN = 48
const CONTENT_W = PAGE_W - MARGIN * 2

/**
 * pdf-lib StandardFonts use WinAnsi: characters outside Latin-1 throw on
 * drawText. Map the common non-WinAnsi glyphs (≈ — ’ “ ” …) to ASCII-ish
 * equivalents and drop anything else out of range — scraped text can carry
 * arbitrary bytes.
 */
export function sanitizePdfText(s: unknown): string {
  const map: Record<string, string> = {
    '≈': 'aprox. ',
    '—': '-',
    '–': '-',
    '’': "'",
    '‘': "'",
    '“': '"',
    '”': '"',
    '…': '...',
  }
  let out = ''
  for (const ch of String(s ?? '')) {
    const mapped = map[ch]
    if (mapped !== undefined) {
      out += mapped
      continue
    }
    const code = ch.codePointAt(0) ?? 0
    out += code <= 255 ? ch : ' '
  }
  return out.replace(/\s+/g, ' ').trim()
}

function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(' ')
  const lines: string[] = []
  let line = ''
  for (const w of words) {
    const candidate = line ? `${line} ${w}` : w
    if (font.widthOfTextAtSize(candidate, size) > maxWidth && line) {
      lines.push(line)
      line = w
    } else {
      line = candidate
    }
  }
  if (line) lines.push(line)
  return lines.length ? lines : ['']
}

function draw(
  page: PDFPage,
  font: PDFFont,
  size: number,
  color: ReturnType<typeof rgb>,
  x: number,
  y: number,
  text: string,
): void {
  page.drawText(sanitizePdfText(text), { x, y, size, font, color })
}

function drawRight(page: PDFPage, font: PDFFont, size: number, color: ReturnType<typeof rgb>, text: string, y: number): void {
  draw(page, font, size, color, MARGIN + CONTENT_W - font.widthOfTextAtSize(sanitizePdfText(text), size), y, text)
}

export async function buildReceiptPdf(r: PublicReceipt): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([PAGE_W, PAGE_H])
  const helv = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)

  const a = r.agency
  const currency = a.currency === 'NIO' ? 'NIO' : 'USD'
  const rate = a.exchangeRateNioPerUsd
  const altTotal =
    rate && rate > 0 && r.total
      ? currency === 'NIO'
        ? `Equiv. USD: ${money(r.total / rate, 'USD')} (tasa ${rate})`
        : `Equiv. córdobas: ${money(r.total * rate, 'NIO')} (tasa ${rate})`
      : null
  const date = r.issueDate
    ? new Date(r.issueDate).toLocaleDateString('es-NI', { year: 'numeric', month: 'long', day: 'numeric' })
    : '—'

  // ── Header: agency brand (text only, no logo fetch) + invoice meta ──
  const headTop = PAGE_H - 56
  draw(page, bold, 16, INK, MARGIN, headTop, a.name || 'Orbit')
  let ly = headTop - 18
  if (a.ruc) {
    draw(page, helv, 9, INK, MARGIN, ly, `RUC: ${sanitizePdfText(a.ruc)}`)
    ly -= 12
  }
  if (a.address) {
    draw(page, helv, 9, MUTED, MARGIN, ly, a.address)
    ly -= 12
  }
  if (a.phone) {
    draw(page, helv, 9, MUTED, MARGIN, ly, `No de Telefono: ${sanitizePdfText(formatPhone(a.phone))}`)
    ly -= 12
  }

  drawRight(page, helv, 9, MUTED, 'FACTURA N.°', headTop)
  drawRight(page, bold, 20, BRAND, String(r.invoiceNumber), headTop - 16)
  drawRight(page, helv, 9, MUTED, date, headTop - 36)

  const dividerY = Math.min(ly, headTop - 40) - 8
  page.drawLine({ start: { x: MARGIN, y: dividerY }, end: { x: PAGE_W - MARGIN, y: dividerY }, thickness: 1.2, color: INK })

  // ── Client ──
  let y = dividerY - 22
  draw(page, helv, 8, MUTED, MARGIN, y, 'CLIENTE')
  y -= 14
  draw(page, bold, 11, INK, MARGIN, y, r.clientName ?? '—')
  if (r.clientAddress) {
    y -= 13
    draw(page, helv, 9, MUTED, MARGIN, y, wrap(r.clientAddress, helv, 9, CONTENT_W)[0])
  }

  // ── Lines table ──
  const colFirst = MARGIN
  const colFreight = 300
  const colLbs = 374
  const colUnit = 424
  const headY = y - 24
  draw(page, helv, 8, MUTED, colFirst, headY, 'Guía / Concepto')
  draw(page, helv, 8, MUTED, colFreight, headY, 'Flete')
  draw(page, helv, 8, MUTED, colLbs, headY, 'Libras')
  draw(page, helv, 8, MUTED, colUnit, headY, 'P. unit.')
  drawRight(page, helv, 8, MUTED, 'Total', headY)
  page.drawLine({ start: { x: MARGIN, y: headY - 6 }, end: { x: PAGE_W - MARGIN, y: headY - 6 }, thickness: 0.6, color: LINE })

  let rowY = headY - 22
  for (const l of r.lines) {
    const firstName =
      l.lineType === 'freight'
        ? (l.guia ? sanitizePdfText(l.guia) : '') + (l.tracking ? `\nTracking ${sanitizePdfText(l.tracking)}` : '')
        : sanitizePdfText(l.description ?? 'Otro cargo')
    const cellLines = firstName.split('\n').slice(0, 3).flatMap((ln) => {
      const wrapped = wrap(ln, helv, 9, 215)
      return wrapped.length ? wrapped : ['']
    })
    const rowH = Math.max(14, cellLines.length * 11 + 3)
    cellLines.forEach((ln, i) => draw(page, helv, 9, INK, colFirst, rowY - i * 11, ln))
    draw(page, helv, 9, INK, colFreight, rowY, l.freightType ? FREIGHT_ES[l.freightType] : '—')
    draw(page, helv, 9, INK, colLbs, rowY, l.quantityLbs != null ? String(l.quantityLbs) : '—')
    draw(page, helv, 9, INK, colUnit, rowY, money(l.unitPrice, currency))
    drawRight(page, helv, 9, INK, money(l.total, currency), rowY)
    rowY -= rowH
    if (rowY < 90) {
      // Overflow safeguard (v1: no multi-page) — stop drawing further rows.
      rowY = 90
      break
    }
  }
  page.drawLine({ start: { x: MARGIN, y: rowY }, end: { x: PAGE_W - MARGIN, y: rowY }, thickness: 0.6, color: LINE })

  // ── Totals ──
  const subtotal = r.lines.reduce((s, l) => s + (l.total || 0), 0)
  rowY -= 14
  drawRight(page, helv, 10, INK, `Subtotal  ${money(subtotal, currency)}`, rowY)
  rowY -= 20
  drawRight(page, bold, 14, INK, `Total  ${money(r.total, currency)}`, rowY)
  if (altTotal) {
    rowY -= 13
    drawRight(page, helv, 9, MUTED, altTotal, rowY)
  }

  // ── Footer ──
  draw(page, helv, 9, MUTED, MARGIN, 40, `Gracias por su preferencia · ${sanitizePdfText(a.name || 'Orbit')}`)

  return doc.save()
}