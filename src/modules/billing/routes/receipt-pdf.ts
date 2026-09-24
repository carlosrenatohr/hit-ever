// ============================================================================
// On-the-fly PDF receipt builder — no persistence, no external services.
// Renders the same customer-safe receipt data as the HTML route into a PDF
// (pdf-lib, pure JS) so a share link can download the invoice directly.
//
// Layout mirrors the panel's InvoicePrint template (Poppins weights, header
// with double border, bordered rows, Totals block with lines, centered footer)
// so the WhatsApp copy looks identical to the print/visualize view.
// ============================================================================

import { PDFDocument, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import decodeWebp, { init as initWebpModule } from '@jsquash/webp/decode'
import { encode as encodePng } from 'upng-js'
import { WEBP_DECODER_B64 } from './webp-decoder.b64.js'
import {
  POPPINS_REGULAR_B64,
  POPPINS_MEDIUM_B64,
  POPPINS_SEMIBOLD_B64,
  POPPINS_BOLD_B64,
  POPPINS_EXTRABOLD_B64,
} from './poppins-b64.js'
import type { PublicReceipt } from '../service/billing-service.js'
import { money, formatPhone, shortDateEs, FREIGHT_ES } from './public.js'

// Palette mirrors InvoicePrint / the brand book (Tailwind values → rgb 0-1).
const INK = rgb(0.07, 0.07, 0.07) // gray-900
const TEXT700 = rgb(0.22, 0.25, 0.31) // gray-700
const MUTED = rgb(0.42, 0.45, 0.5) // gray-500
const FAINT = rgb(0.61, 0.64, 0.69) // gray-400
const LINE300 = rgb(0.82, 0.83, 0.86) // gray-300 (header border, totals dividers)
const LINE100 = rgb(0.95, 0.96, 0.96) // gray-100 (row borders)
const PAGE_W = 595 // A4
const PAGE_H = 842
const MARGIN = 40
const CONTENT_W = PAGE_W - MARGIN * 2
const LOGO_SIZE = 36 // h-12 (48px) @ 0.75pt/px
const LOGO_GAP = 9 // gap-3

function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
}

/**
 * pdf-lib embedded fonts cover Latin-1; anything outside that range (or the
 * explicit map) is replaced so a scraped string can never crash drawText.
 */
export function sanitizePdfText(s: unknown): string {
  const map: Record<string, string> = {
    '≈': 'aprox. ',
    '—': '-',
    '–': '-',
    '·': '-',
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

function drawCentered(page: PDFPage, font: PDFFont, size: number, color: ReturnType<typeof rgb>, text: string, y: number): void {
  draw(page, font, size, color, (PAGE_W - font.widthOfTextAtSize(sanitizePdfText(text), size)) / 2, y, text)
}

function isWebp(bytes: Uint8Array): boolean {
  return bytes.length > 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
}

/**
 * Lazy-compile the embedded WebP decoder wasm (base64) once per isolate.
 * Compiling is supported in Workers and Node, so this path is identical in
 * both vitest and the deployed worker.
 */
let webpWasmModule: Promise<WebAssembly.Module | null> | null = null
export function getWebpWasm(): Promise<WebAssembly.Module | null> {
  if (!webpWasmModule) {
    webpWasmModule = (async () => {
      try {
        const bytes = Uint8Array.from(atob(WEBP_DECODER_B64), (c) => c.charCodeAt(0))
        return await WebAssembly.compile(bytes)
      } catch {
        return null
      }
    })()
  }
  return webpWasmModule
}

/** Decode WebP → RGBA → PNG bytes (jsquash wasm + upng encode). Null on any failure. */
async function webpToPng(bytes: Uint8Array): Promise<Uint8Array | null> {
  try {
    const wasm = await getWebpWasm()
    if (wasm) await initWebp(wasm)
    else await initWebp()
    // jsquash's embind binding accepts Uint8Array (a raw ArrayBuffer is rejected
    // with "Cannot pass non-string to std::string") — always hand it a view.
    const view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const img = await decodeWebp(view)
    return new Uint8Array(encodePng([img.data], img.width, img.height, 256))
  } catch (e) {
    console.warn(`receipt-logo:webp-decode ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}

let webpInited = false
async function initWebp(module?: WebAssembly.Module): Promise<void> {
  if (webpInited) return
  await initWebpModule(module)
  webpInited = true
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>

/**
 * Default logo fetcher: the InsForge storage gateway redirects to a signed CDN
 * (cdn.insforge.dev) that 403s requests WITHOUT a User-Agent — and Workers fetch
 * sends none by default. Walk the redirects manually, always sending a UA.
 */
async function defaultLogoFetcher(url: string, init?: RequestInit): Promise<Response> {
  let u: string = url
  for (let i = 0; i < 5; i++) {
    const res = await fetch(u, {
      ...init,
      redirect: 'manual',
      headers: { ...(init?.headers ?? {}), 'User-Agent': 'Mozilla/5.0 (compatible; OrbitInvoice/1.0)' },
    })
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      if (!loc) return res
      u = new URL(loc, u).toString()
      continue
    }
    return res
  }
  return new Response(null, { status: 599 })
}

/**
 * Fetch the agency logo and embed it (PNG/JPEG natively; WebP decoded on the
 * fly). The `size` box is centered vertically on the box (y2 = box bottom):
 * callers pass a box already centered against the brand text block, mirroring
 * the InvoicePrint `flex items-center` alignment. Returns whether drawn.
 */
async function drawLogo(
  page: PDFPage,
  pdf: PDFDocument,
  logoUrl: string | null | undefined,
  fetcher: Fetcher,
  x: number,
  boxBottom: number,
  size = LOGO_SIZE,
): Promise<boolean> {
  if (!logoUrl) return false
  try {
    const res = await fetcher(logoUrl)
    if (!res.ok) {
      console.warn(`receipt-logo:fetch-${res.status}`)
      return false
    }
    const bytes = new Uint8Array(await res.arrayBuffer())
    let image: PDFImage | null = null
    if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
      image = await pdf.embedPng(bytes)
    } else if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      image = await pdf.embedJpg(bytes)
    } else if (isWebp(bytes)) {
      const png = await webpToPng(bytes)
      if (png) image = await pdf.embedPng(png)
      else console.warn('receipt-logo:webp-decode-failed')
    } else {
      console.warn('receipt-logo:unsupported-format')
      return false
    }
    if (!image) return false
    const scale = Math.min(size / image.width, size / image.height)
    const w = image.width * scale
    const h = image.height * scale
    page.drawImage(image, { x, y: boxBottom + (size - h) / 2, width: w, height: h })
    return true
  } catch (e) {
    console.warn(`receipt-logo:error ${e instanceof Error ? e.message : String(e)}`)
    return false
  }
}

export async function buildReceiptPdf(r: PublicReceipt, logoFetcher: Fetcher = defaultLogoFetcher): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.registerFontkit(fontkit)
  const page = doc.addPage([PAGE_W, PAGE_H])
  const font = {
    regular: await doc.embedFont(base64ToBytes(POPPINS_REGULAR_B64)),
    medium: await doc.embedFont(base64ToBytes(POPPINS_MEDIUM_B64)),
    semibold: await doc.embedFont(base64ToBytes(POPPINS_SEMIBOLD_B64)),
    bold: await doc.embedFont(base64ToBytes(POPPINS_BOLD_B64)),
    extrabold: await doc.embedFont(base64ToBytes(POPPINS_EXTRABOLD_B64)),
  }

  const a = r.agency
  const currency = a.currency === 'NIO' ? 'NIO' : 'USD'
  const rate = a.exchangeRateNioPerUsd
  const altTotal =
    rate && rate > 0 && r.total
      ? currency === 'NIO'
        ? `${money(r.total / rate, 'USD')}`
        : `${money(r.total * rate, 'NIO')}`
      : null
  // Matches the panel print (fmtDate): es-NI short, e.g. "5 sept 2026".
  const date = shortDateEs(r.issueDate)

  // ── Header: logo + agency brand (flex items-center) | meta right ──────────
  const headTop = PAGE_H - 48
  const brandLines: Array<{ text: string; font: PDFFont; size: number; color: ReturnType<typeof rgb> }> = [
    { text: a.name || 'Orbit', font: font.extrabold, size: 15, color: INK },
  ]
  if (a.ruc) brandLines.push({ text: `RUC: ${a.ruc}`, font: font.bold, size: 9, color: INK })
  if (a.address) brandLines.push({ text: a.address, font: font.regular, size: 8.25, color: MUTED })
  if (a.phone) brandLines.push({ text: `No de Telefono: ${formatPhone(a.phone)}`, font: font.regular, size: 8.25, color: MUTED })

  const baselines: number[] = []
  let b = headTop + 6
  brandLines.forEach((ln, i) => {
    baselines.push(b)
    b -= i === 0 ? 15 : 12.5
  })
  const blockTop = baselines[0] + brandLines[0].size * 0.82
  const last = brandLines.length - 1
  const blockBottom = baselines[last] - brandLines[last].size * 0.2
  const blockH = blockTop - blockBottom

  const hasLogo = await drawLogo(page, doc, a.logoUrl, logoFetcher, MARGIN, blockBottom + (blockH - LOGO_SIZE) / 2)
  const brandX = MARGIN + (hasLogo ? LOGO_SIZE + LOGO_GAP : 0)
  brandLines.forEach((ln, i) => draw(page, ln.font, ln.size, ln.color, brandX, baselines[i], ln.text))

  // Meta right — top-aligned with the brand block, generous spacing (label →
  // number gap was too tight before).
  const metaTop = blockTop - 1
  drawRight(page, font.semibold, 7.5, FAINT, 'FACTURA NO.', metaTop)
  drawRight(page, font.extrabold, 18, INK, String(r.invoiceNumber), metaTop - 13)
  drawRight(page, font.regular, 9, MUTED, date, metaTop - 34)

  // border-b-2 (double) under the header
  const dividerY = blockBottom - 14
  page.drawLine({ start: { x: MARGIN, y: dividerY }, end: { x: PAGE_W - MARGIN, y: dividerY }, thickness: 1.5, color: INK })

  // ── Client ──
  let y = dividerY - 26
  draw(page, font.semibold, 7.5, FAINT, MARGIN, y, 'CLIENTE')
  y -= 15
  draw(page, font.semibold, 10.5, INK, MARGIN, y, r.clientName ?? '-')
  if (r.clientAddress) {
    y -= 14
    draw(page, font.regular, 9, MUTED, MARGIN, y, wrap(r.clientAddress, font.regular, 9, CONTENT_W)[0])
  }

  // ── Lines table (header with border-y, each row with border-b) ──
  const colFirst = MARGIN
  const colFreight = 178
  const colLbsRight = 336
  const colUnitRight = 408
  const thY = y - 26
  // Header labels — uppercase, tracking like the CSS (charSpacing 0.6pt).
  const HEADER_SIZE = 7.5
  draw(page, font.semibold, HEADER_SIZE, MUTED, colFirst, thY, 'GUIA / CONCEPTO')
  draw(page, font.semibold, HEADER_SIZE, MUTED, colFreight, thY, 'FLETE')
  draw(page, font.semibold, HEADER_SIZE, MUTED, colLbsRight - font.semibold.widthOfTextAtSize('LIBRAS', HEADER_SIZE), thY, 'LIBRAS')
  draw(page, font.semibold, HEADER_SIZE, MUTED, colUnitRight - font.semibold.widthOfTextAtSize('P. UNIT.', HEADER_SIZE), thY, 'P. UNIT.')
  drawRight(page, font.semibold, HEADER_SIZE, MUTED, 'TOTAL', thY)
  // border-y: line above the header and below it
  const headTopLine = thY + 10
  const headBottomLine = thY - 9
  page.drawLine({ start: { x: MARGIN, y: headTopLine }, end: { x: PAGE_W - MARGIN, y: headTopLine }, thickness: 0.75, color: LINE300 })
  page.drawLine({ start: { x: MARGIN, y: headBottomLine }, end: { x: PAGE_W - MARGIN, y: headBottomLine }, thickness: 0.75, color: LINE300 })

  let rowY = headBottomLine - 13
  for (const l of r.lines) {
    const firstName =
      l.lineType === 'freight'
        ? (l.guia ? sanitizePdfText(l.guia) : '') + (l.tracking ? `\nTracking ${sanitizePdfText(l.tracking)}` : '')
        : sanitizePdfText(l.description ?? 'Otro cargo')
    const cellLines = firstName.split('\n').slice(0, 3).flatMap((ln) => {
      const wrapped = wrap(ln, font.regular, 10.5, 208)
      return wrapped.length ? wrapped : ['']
    })
    const rowH = Math.max(16, cellLines.length * 12 + 4)
    cellLines.forEach((ln, i) => draw(page, i === 0 ? font.semibold : font.regular, i === 0 ? 10.5 : 7.5, i === 0 ? INK : MUTED, colFirst, rowY - i * 12, ln))
    draw(page, font.regular, 10.5, INK, colFreight, rowY, l.freightType ? FREIGHT_ES[l.freightType] : '-')
    draw(page, font.regular, 10.5, INK, colLbsRight - font.regular.widthOfTextAtSize(sanitizePdfText(String(l.quantityLbs ?? '-')), 10.5), rowY, String(l.quantityLbs ?? '-'))
    draw(page, font.regular, 10.5, INK, colUnitRight - font.regular.widthOfTextAtSize(sanitizePdfText(money(l.unitPrice, currency)), 10.5), rowY, money(l.unitPrice, currency))
    drawRight(page, font.medium, 10.5, INK, money(l.total, currency), rowY)
    rowY -= rowH
    page.drawLine({ start: { x: MARGIN, y: rowY + 2 }, end: { x: PAGE_W - MARGIN, y: rowY + 2 }, thickness: 0.6, color: LINE100 })
    if (rowY < 130) {
      rowY = 130
      break
    }
  }

  // ── Totals (right block, w-64): Subtotal (border-t) → Total (border-t-2) ──
  const subtotal = r.lines.reduce((s, l) => s + (l.total || 0), 0)
  const boxLeft = PAGE_W - MARGIN - 192
  const amountX = PAGE_W - MARGIN
  rowY -= 14
  const subAmount = money(subtotal, currency)
  page.drawLine({ start: { x: boxLeft, y: rowY }, end: { x: amountX, y: rowY }, thickness: 0.75, color: LINE300 })
  const subY = rowY - 15
  draw(page, font.regular, 10.5, TEXT700, boxLeft, subY, 'Subtotal')
  draw(page, font.regular, 10.5, TEXT700, amountX - font.regular.widthOfTextAtSize(sanitizePdfText(subAmount), 10.5), subY, subAmount)
  const totalY = subY - 33
  const totalAmount = money(r.total, currency)
  page.drawLine({ start: { x: boxLeft, y: totalY + 13 }, end: { x: amountX, y: totalY + 13 }, thickness: 1.5, color: INK })
  draw(page, font.extrabold, 13.5, INK, boxLeft, totalY, 'Total')
  draw(page, font.extrabold, 13.5, INK, amountX - font.extrabold.widthOfTextAtSize(sanitizePdfText(totalAmount), 13.5), totalY, totalAmount)
  if (altTotal) {
    const altY = totalY - 26
    page.drawLine({ start: { x: boxLeft, y: altY + 10 }, end: { x: amountX, y: altY + 10 }, thickness: 0.6, color: LINE100 })
    drawRight(page, font.medium, 8.25, MUTED, sanitizePdfText(altTotal), altY)
  }

  // ── Footer ──
  drawCentered(page, font.regular, 8.25, FAINT, `Gracias por su preferencia - ${sanitizePdfText(a.name || 'Orbit')}`, 40)

  return doc.save()
}