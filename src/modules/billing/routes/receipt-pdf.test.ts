import { describe, expect, it } from 'vitest'
import { buildReceiptPdf, sanitizePdfText } from './receipt-pdf.js'
import type { PublicReceipt } from '../service/billing-service.js'

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
  it('maps non-WinAnsi glyphs to ASCII-ish equivalents', () => {
    expect(sanitizePdfText('Total ≈ C$1,234 — ok')).toBe('Total aprox. C$1,234 - ok')
  })

  it('collapses whitespace, keeps Latin-1 accents and drops emoji/out-of-range bytes', () => {
    expect(sanitizePdfText('Café ñ — smile 😀')).toBe('Café ñ - smile')
  })
})

describe('buildReceiptPdf', () => {
  it('produces a valid PDF byte stream on the fly', async () => {
    const bytes = await buildReceiptPdf(receipt)
    const head = new TextDecoder().decode(bytes.slice(0, 5))
    expect(head).toBe('%PDF-')
    expect(bytes.length).toBeGreaterThan(1000)
  })
})