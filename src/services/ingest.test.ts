import { describe, expect, it } from 'vitest'
import { toPackageRow } from './ingest.js'
import type { ListRow } from '../lib/cargotrack.js'
import type { DetailData } from '../lib/cargotrack.js'

const baseUrl = 'https://everest.cargotrack.net'

function makeList(over: Partial<ListRow> = {}): ListRow {
  return {
    almacenId: '926791',
    status: 'en_almacen',
    weightLb: 2.8,
    volumeCf: 0.05,
    pieces: 1,
    serviceType: 'aereo',
    declaredValue: 49.99,
    ...over,
  }
}

function makeDetail(over: Partial<DetailData> = {}): DetailData {
  return {
    almacenId: '926791',
    consigneeId: '37458',
    trackingNumber: '1Z2V8757YW0098887142',
    serviceType: 'aereo',
    statusFromDetail: 'en_almacen',
    events: [],
    notes: [],
    ...over,
  }
}

describe('toPackageRow', () => {
  it('always sets provider_id, almacen_id, status, scraped_at, updated_at', () => {
    const row = toPackageRow('p1', baseUrl, '926791')
    expect(row.provider_id).toBe('p1')
    expect(row.almacen_id).toBe('926791')
    expect(row.status).toBe('desconocido')
    expect(typeof row.scraped_at).toBe('string')
    expect(typeof row.updated_at).toBe('string')
  })

  it('with list only: list-only fields populated, detail-only fields OMITTED', () => {
    const row = toPackageRow('p1', baseUrl, '926791', makeList())
    expect(row.weight_lb).toBe(2.8)
    expect(row.volume_cf).toBe(0.05)
    expect(row.pieces).toBe(1)
    expect(row.declared_value).toBe(49.99)
    expect(row.service_type).toBe('aereo')
    // detail-only fields must be absent so the merge-duplicate upsert leaves the DB value alone
    expect('tracking_number' in row).toBe(false)
    expect('referencia_name' in row).toBe(false)
    expect('casillero' in row).toBe(false)
    expect('description' in row).toBe(false)
    expect('photo_ref' in row).toBe(false)
    expect('origin_office' in row).toBe(false)
    expect('dest_office' in row).toBe(false)
    expect('remitente' in row).toBe(false)
    expect('received_at' in row).toBe(false)
    expect('last_event_at' in row).toBe(false)
  })

  it('with detail only (email-trigger re-scrape): list-only fields OMITTED — this is the bug fix', () => {
    // Before the fix this row would carry weight_lb: null and the merge-duplicate upsert
    // would clobber the weight pulled by the original list-walk ingest.
    const row = toPackageRow('p1', baseUrl, '926791', undefined, makeDetail())
    expect(row.tracking_number).toBe('1Z2V8757YW0098887142')
    expect(row.casillero).toBe('37458')
    expect(row.service_type).toBe('aereo')
    // list-only fields must be absent
    expect('weight_lb' in row).toBe(false)
    expect('volume_cf' in row).toBe(false)
    expect('pieces' in row).toBe(false)
    expect('declared_value' in row).toBe(false)
    // no events → timestamps must be absent too (same protection)
    expect('received_at' in row).toBe(false)
    expect('last_event_at' in row).toBe(false)
  })

  it('with both list and detail: every field is set', () => {
    const row = toPackageRow('p1', baseUrl, '926791', makeList(), makeDetail())
    expect(row.weight_lb).toBe(2.8)
    expect(row.tracking_number).toBe('1Z2V8757YW0098887142')
    expect(row.casillero).toBe('37458')
    expect(row.service_type).toBe('aereo')
  })

  it('with neither: only the required fields, no list/detail keys at all', () => {
    const row = toPackageRow('p1', baseUrl, '926791')
    const allowed = new Set(['provider_id', 'almacen_id', 'status', 'scraped_at', 'updated_at'])
    for (const k of Object.keys(row)) {
      expect(allowed.has(k)).toBe(true)
    }
  })

  it('does not include weight_lb when the list had no weight (e.g. cell blank in Cargotrack)', () => {
    // The parser returns undefined for unparseable cells; we must not turn that into a NULL
    // write that would erase a previously-stored weight.
    const row = toPackageRow('p1', baseUrl, '926791', makeList({ weightLb: undefined }))
    expect('weight_lb' in row).toBe(false)
  })

  it('does not clobber existing manual_status override when no RETIRADO note on this re-scrape', () => {
    // The RETIRADO branch already used this trick; verify it still does after the refactor.
    const row = toPackageRow('p1', baseUrl, '926791', makeList(), makeDetail())
    expect('manual_status' in row).toBe(false)
    expect('manual_status_by' in row).toBe(false)
    expect('manual_status_at' in row).toBe(false)
  })

  it('adds manual_status only when a RETIRADO note is found and the scrape status is not entregado', () => {
    const row = toPackageRow(
      'p1',
      baseUrl,
      '926791',
      makeList(),
      makeDetail({ notes: [{ body: 'RETIRADO en oficina MGA' }] }),
    )
    expect(row.manual_status).toBe('entregado')
    expect(row.manual_status_by).toBe('cargotrack-note')
    expect(typeof row.manual_status_at).toBe('string')
  })
})
