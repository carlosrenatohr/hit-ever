import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { almacenIdFromEmail, isHitPackage, parseAlmacenList, parseDetail } from './cargotrack.js'

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url)), 'utf8')
}

describe('parseAlmacenList', () => {
  const rows = parseAlmacenList(fixture('almacen.html'))

  it('parses the 15 package rows', () => {
    expect(rows.length).toBe(15)
  })

  it('first row = 926791, air, AMAZON', () => {
    const r = rows[0]
    expect(r.almacenId).toBe('926791')
    expect(r.serviceType).toBe('aereo')
    expect(r.remitente).toBe('AMAZON')
    expect(r.destinatario).toContain('HIT CARGO')
    expect(r.weightLb).toBe(2.8)
  })

  it('maps row color to status (924788 green = en_almacen, sea)', () => {
    const r = rows.find((x) => x.almacenId === '924788')
    expect(r?.status).toBe('en_almacen')
    expect(r?.serviceType).toBe('maritimo')
  })

  it('detects HIT ownership by recipient', () => {
    expect(isHitPackage(rows[0])).toBe(true)
  })
})

describe('parseDetail', () => {
  const d = parseDetail(fixture('detalle.html'))

  it('extracts the key form fields', () => {
    expect(d.almacenId).toBe('926791')
    expect(d.consigneeId).toBe('37458')
    expect(d.shipper).toBe('AMAZON')
    expect(d.reference).toContain('MARTHA OROZCO')
    expect(d.description).toBe('ELECTRONICO')
    expect(d.trackingNumber?.startsWith('1Z2V8757')).toBe(true)
    expect(d.trackingNumber).not.toMatch(/\s/) // no spaces despite the line break in the HTML
  })

  it('parses events and structured notes', () => {
    expect(d.events.length).toBeGreaterThanOrEqual(1)
    expect(d.events[0].description).toMatch(/recib/i)
    expect(d.notes.length).toBeGreaterThanOrEqual(1)
    expect(d.notes[0].body).toMatch(/flete|recib/i)
    expect(d.notes[0].author).toMatch(/everest|loreta/i)
  })
})

describe('almacenIdFromEmail', () => {
  it('extracts the warehouse number (almacén #) from the Cargotrack email', () => {
    expect(almacenIdFromEmail(fixture('correo_update.html'))).toBe('923950')
  })
})
