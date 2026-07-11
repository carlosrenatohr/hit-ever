import { describe, expect, it } from 'vitest'
import type { RawRow } from '../types.js'
import { HeaderLevelAdapter } from './headerLevel.adapter.js'
import { LineItemAdapter } from './lineItem.adapter.js'

// Column order per shared.ts. Header row is index 0 (skipped by the adapters).
const HDR_2026: RawRow = ['numero_factura', 'cliente', 'fecha', 'OC', 'TIPO DE FLETE', 'Cantidad (LBS)', 'unidad_medida', 'precio_unitario', 'TOTAL', 'precio_total_original', 'Pago', 'Fecha de Pago', 'Costo Flete', 'Ganancia', 'Observaciones', 'Precio especial']
const HDR_2025: RawRow = ['numero_factura', 'cliente', 'fecha', 'OC', 'direccion', 'TIPO', 'descripcion', 'Cantidad (LBS)', 'unidad_medida', 'precio_unitario', 'precio_total', 'precio_total_original', 'Pago', 'Fecha de Pago', 'Costo Flete', 'Ganancia', 'Observaciones', 'Precio especial']

describe('HeaderLevelAdapter (2026)', () => {
  it('parses one invoice per row, drops subtotals and empty placeholders, voids ANULADO', () => {
    const rows: RawRow[] = [
      HDR_2026,
      [331, 'Rikkert Fajardo', new Date('2026-06-25'), '167470', 'AIR', 5, null, 6.5, 32.5, null, 'EFECTIVO', null, 22.5, 10, null, null],
      ['TOTAL JUNIO', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null],
      [333, 'ANULADO', null, null, null, null, null, null, null, null, null, null, null, null, null, null],
      [277, null, null, null, null, 0, null, 0, 0, null, null, null, null, null, null, null], // empty placeholder
    ]
    const out = new HeaderLevelAdapter('2026 Q3').extract(rows, 2026)
    expect(out.map((i) => i.invoiceNumber)).toEqual([331, 333, 277]) // subtotal dropped
    const first = out[0]
    expect(first.lines).toHaveLength(1)
    expect(first.lines[0]).toMatchObject({ freightType: 'AIR', quantityLbs: 5, unitPrice: 6.5 })
    expect(first.payment?.method).toBe('CASH')
    expect(out[1].isVoid).toBe(true)
    expect(out[1].lines).toHaveLength(0)
  })
})

describe('LineItemAdapter (2025)', () => {
  it('groups repeated invoice numbers into one invoice with multiple lines', () => {
    const rows: RawRow[] = [
      HDR_2025,
      [6, 'Yardley Chavarria ', new Date('2025-05-29'), '-', '-', 2, 'Flete Mar Alv.', 2, 'lbs', 2.5, 5.0, 5.0, null, null, 2.5, 2.5, null, null],
      [6, 'Yardley Chavarria ', new Date('2025-05-29'), '-', '-', 2, 'Flete Mar CD', 1, 'lbs', 2.5, 2.5, 2.5, null, null, 1.25, 1.25, null, null],
      [7, 'Jessy Salazar', new Date('2025-06-03'), null, '-', 1, 'Flete C. Aereo', 3.3, 'lbs', 6.0, 19.8, 19.8, 'BAC USD', null, 14.85, 4.95, null, null],
    ]
    const out = new LineItemAdapter('2025').extract(rows, 2025)
    expect(out).toHaveLength(2)
    const inv6 = out.find((i) => i.invoiceNumber === 6)!
    expect(inv6.lines).toHaveLength(2)
    expect(inv6.lines[0]).toMatchObject({ freightType: 'MAR', quantityLbs: 2, unitPrice: 2.5 })
    expect(inv6.source.rows).toEqual([2, 3])
    const inv7 = out.find((i) => i.invoiceNumber === 7)!
    expect(inv7.payment?.bank).toBe('BAC')
  })
})
