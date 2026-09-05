import { describe, it, expect } from 'vitest'
import { resolveProviderOrg, toPackageRow } from './ingest.js'
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
  const ORG = 'hit'

  it('uses list.weightLb when both list and detail have it', () => {
    const row = toPackageRow(PROVIDER_ID, ORG, BASE_URL, '123456',
      makeList({ weightLb: 5.0 }),
      makeDetail({ weightLb: 3.0 }),
    )
    expect(row.weight_lb).toBe(5.0)
  })

  it('falls back to detail.weightLb when list has no weight', () => {
    const row = toPackageRow(PROVIDER_ID, ORG, BASE_URL, '123456',
      makeList({ weightLb: undefined }),
      makeDetail({ weightLb: 2.8 }),
    )
    expect(row.weight_lb).toBe(2.8)
  })

  it('returns null when neither list nor detail has weight', () => {
    const row = toPackageRow(PROVIDER_ID, ORG, BASE_URL, '123456',
      makeList({ weightLb: undefined }),
      makeDetail({ weightLb: undefined }),
    )
    expect(row.weight_lb).toBeNull()
  })

  it('uses list.volumeCf when both list and detail have it', () => {
    const row = toPackageRow(PROVIDER_ID, ORG, BASE_URL, '123456',
      makeList({ volumeCf: 1.0 }),
      makeDetail({ volumeCf: 0.5 }),
    )
    expect(row.volume_cf).toBe(1.0)
  })

  it('falls back to detail.volumeCf when list has no volume', () => {
    const row = toPackageRow(PROVIDER_ID, ORG, BASE_URL, '123456',
      makeList({ volumeCf: undefined }),
      makeDetail({ volumeCf: 0.481 }),
    )
    expect(row.volume_cf).toBe(0.481)
  })

  it('uses list.pieces when both list and detail have it', () => {
    const row = toPackageRow(PROVIDER_ID, ORG, BASE_URL, '123456',
      makeList({ pieces: 2 }),
      makeDetail({ pieces: 1 }),
    )
    expect(row.pieces).toBe(2)
  })

  it('falls back to detail.pieces when list has no pieces', () => {
    const row = toPackageRow(PROVIDER_ID, ORG, BASE_URL, '123456',
      makeList({ pieces: undefined }),
      makeDetail({ pieces: 3 }),
    )
    expect(row.pieces).toBe(3)
  })

  it('stamps the organization_id resolved by the caller (no hardcoded fallback)', () => {
    const row = toPackageRow(PROVIDER_ID, 'solo-guegue', BASE_URL, '123456')
    expect(row.organization_id).toBe('solo-guegue')
  })
})

describe('resolveProviderOrg (junction routing)', () => {
  // Mirrors the live junction: everest→hit(37458); GC→hit(default), GC→suite(8899), GC→solo-guegue(50).
  const GC_LINKS = [
    { agencySlug: 'hit', casilleroFilter: null },
    { agencySlug: 'suite', casilleroFilter: '8899' },
    { agencySlug: 'solo-guegue', casilleroFilter: '50' },
  ]

  it('single-link provider always resolves to its agency', () => {
    expect(resolveProviderOrg([{ agencySlug: 'hit', casilleroFilter: '37458' }], null)).toBe('hit')
  })

  it('routes shared-provider packages by casillero prefix', () => {
    expect(resolveProviderOrg(GC_LINKS, '88991234')).toBe('suite')
    expect(resolveProviderOrg(GC_LINKS, '5012')).toBe('solo-guegue')
    expect(resolveProviderOrg(GC_LINKS, '5056')).toBe('solo-guegue')
  })

  it('defaults unmatched or unknown casilleros to the NULL-filter owner', () => {
    expect(resolveProviderOrg(GC_LINKS, '153899')).toBe('hit')
    expect(resolveProviderOrg(GC_LINKS, null)).toBe('hit')
  })

  it('prefers the most specific filter when prefixes overlap', () => {
    const links = [
      { agencySlug: 'a', casilleroFilter: '50' },
      { agencySlug: 'b', casilleroFilter: '5012' },
    ]
    expect(resolveProviderOrg(links, '5012x')).toBe('b')
    expect(resolveProviderOrg(links, '5099')).toBe('a')
  })

  it('returns null instead of guessing when routing is ambiguous', () => {
    expect(resolveProviderOrg([], '5012')).toBeNull()
    expect(resolveProviderOrg([
      { agencySlug: 'a', casilleroFilter: '1' },
      { agencySlug: 'b', casilleroFilter: null },
      { agencySlug: 'c', casilleroFilter: null },
    ], '999')).toBeNull()
  })
})
