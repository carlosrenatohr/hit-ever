import { describe, expect, it } from 'vitest'
import { buildReceiptPdf, sanitizePdfText, getWebpWasm } from './receipt-pdf.js'
import type { PublicReceipt } from '../service/billing-service.js'

// 1×1 PNG used to assert the logo-embedding path without network.
const TINY_PNG = new Uint8Array(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
)

const receipt: PublicReceipt = {
  invoiceNumber: 7,
  issueDate: '2026-09-05',
  clientName: 'Ana Martínez',
  clientAddress: 'Managua, Nicaragua',
  status: 'ISSUED',
  lines: [
    { lineType: 'freight', description: null, freightType: 'AIR', quantityLbs: 5, unitPrice: 6.5, total: 32.5, guia: '25001234', tracking: 'TRACK-1' },
    { lineType: 'other', description: 'Almacenaje', freightType: null, quantityLbs: null, unitPrice: 5, total: 5, guia: null, tracking: null },
  ],
  total: 37.5,
  paidUsd: 0,
  outstanding: 37.5,
  agency: { name: 'Original Express', logoUrl: null, ruc: null, address: null, phone: '505 8123 4567', currency: 'USD', exchangeRateNioPerUsd: 37 },
}

describe('sanitizePdfText', () => {
  it('maps non-common glyphs to ASCII-ish equivalents (≈ → aprox., — → -)', () => {
    expect(sanitizePdfText('Total ≈ C$1,234 — ok')).toBe('Total aprox. C$1,234 - ok')
  })

  it('maps the middle dot separator and keeps Latin-1 accents', () => {
    expect(sanitizePdfText('Café ñ · hola — smile 😀')).toBe('Café ñ - hola - smile')
  })
})

describe('buildReceiptPdf', () => {
  it('produces a valid PDF byte stream on the fly', async () => {
    const bytes = await buildReceiptPdf(receipt)
    const head = new TextDecoder().decode(bytes.slice(0, 5))
    expect(head).toBe('%PDF-')
    expect(bytes.length).toBeGreaterThan(1000)
  })

  it('compiles the embedded WebP decoder wasm (encoded base64, lazy)', async () => {
    const wasm = await getWebpWasm()
    expect(wasm).toBeInstanceOf(WebAssembly.Module)
  })

  it('embeds the agency logo in the header (PNG fetcher)', async () => {
    const withLogo: PublicReceipt = { ...receipt, agency: { ...receipt.agency, logoUrl: 'https://cdn.test/logos/original-express.webp' } }
    const fetcher = async () => new Response(TINY_PNG, { status: 200 })
    const bytes = await buildReceiptPdf(withLogo, fetcher)
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-')
    // The embedded XObject image makes the PDF bigger than the text-only version.
    const textOnly = await buildReceiptPdf(receipt)
    expect(bytes.length).toBeGreaterThan(textOnly.length)
  })
})