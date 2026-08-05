import { describe, it, expect } from 'vitest'
import { toPackageRow } from './ingest.js'
import type { ListRow, DetailData } from '../lib/cargotrack.js'

const BASE_URL = 'https://everest.cargotrack.net'
const PROVIDER_ID = 'test-provider'

function makeDetail(overrides: Partial<DetailData> = {}): DetailData {
  return {
    almacenId: '123456',
    statusFromDetail: 'en_transito',
    events: [],
    notes: [],
    ...overrides,
  }
}

function makeList(overrides: Partial<ListRow> = {}): ListRow {
  return {
    almacenId: '123456',
    status: 'en_transito',
    ...overrides,
  }
}

describe('toPackageRow fallback chain', () => {
  it('uses list.weightLb when both list and detail have it', () => {
    const row = toPackageRow(PROVIDER_ID, BASE_URL, '123456',
      makeList({ weightLb: 5.0 }),
      makeDetail({ weightLb: 3.0 }),
    )
    expect(row.weight_lb).toBe(5.0)
  })

  it('falls back to detail.weightLb when list has no weight', () => {
    const row = toPackageRow(PROVIDER_ID, BASE_URL, '123456',
      makeList({ weightLb: undefined }),
      makeDetail({ weightLb: 2.8 }),
    )
    expect(row.weight_lb).toBe(2.8)
  })

  it('returns null when neither list nor detail has weight', () => {
    const row = toPackageRow(PROVIDER_ID, BASE_URL, '123456',
      makeList({ weightLb: undefined }),
      makeDetail({ weightLb: undefined }),
    )
    expect(row.weight_lb).toBeNull()
  })

  it('uses list.volumeCf when both list and detail have it', () => {
    const row = toPackageRow(PROVIDER_ID, BASE_URL, '123456',
      makeList({ volumeCf: 1.0 }),
      makeDetail({ volumeCf: 0.5 }),
    )
    expect(row.volume_cf).toBe(1.0)
  })

  it('falls back to detail.volumeCf when list has no volume', () => {
    const row = toPackageRow(PROVIDER_ID, BASE_URL, '123456',
      makeList({ volumeCf: undefined }),
      makeDetail({ volumeCf: 0.481 }),
    )
    expect(row.volume_cf).toBe(0.481)
  })

  it('uses list.pieces when both list and detail have it', () => {
    const row = toPackageRow(PROVIDER_ID, BASE_URL, '123456',
      makeList({ pieces: 2 }),
      makeDetail({ pieces: 1 }),
    )
    expect(row.pieces).toBe(2)
  })

  it('falls back to detail.pieces when list has no pieces', () => {
    const row = toPackageRow(PROVIDER_ID, BASE_URL, '123456',
      makeList({ pieces: undefined }),
      makeDetail({ pieces: 3 }),
    )
    expect(row.pieces).toBe(3)
  })
})
