import { describe, expect, it } from 'vitest'
import { BACKFILL_ORGS, buildBackfillPlan, cardName, type RateTableDb } from './backfill-rate-cards.js'

// Real inventory (2026-09-08), from docs/plans/configuracion-rate-cards-v2.md §1.
function row(tier: string, price: number, cost: number): { tier: string; price: number; cost: number; price_model: string } {
  return { tier, price, cost, price_model: 'weight' }
}

function table(id: string, org: string, name: string, freight: 'AIR' | 'MAR', rows: ReturnType<typeof row>[]): RateTableDb {
  return { id, organization_id: org, name, freight_type: freight, rate_rows: rows }
}

function hitTables(): RateTableDb[] {
  return [
    table('t-hit-air', 'hit', 'Regular', 'AIR', [
      row('REGULAR', 6.5, 4.5),
      row('ESPECIAL', 6.0, 4.5),
      row('VIP', 5.5, 4.5),
      row('MADRES', 6.25, 4.5),
      row('DARIO', 4.3, 4.5),
    ]),
    table('t-hit-mar', 'hit', 'Regular', 'MAR', [
      row('REGULAR', 2.5, 1.25),
      row('ESPECIAL', 2.3, 1.25),
      row('VIP', 2.25, 1.25),
      row('DARIO', 1.3, 1.25),
    ]),
  ]
}

function soloTables(): RateTableDb[] {
  return [
    table('t-eee', 'solo-guegue', 'eee', 'AIR', []),
    table('t-solo-air', 'solo-guegue', 'Estándar', 'AIR', [row('REGULAR', 7.0, 4.5)]),
    table('t-solo-mar', 'solo-guegue', 'Estándar', 'MAR', [row('REGULAR', 2.9, 1.25)]),
  ]
}

function suiteTables(): RateTableDb[] {
  return hitTables().map((t) => ({ ...t, id: `suite-${t.id}`, organization_id: 'suite' }))
}

describe('cardName', () => {
  it('REGULAR keeps the table name; other tiers get a suffix', () => {
    expect(cardName('Regular', 'REGULAR')).toBe('Regular')
    expect(cardName('Regular', 'VIP')).toBe('Regular · VIP')
    expect(cardName('Regular', 'DARIO')).toBe('Regular · Dario')
    expect(cardName('Regular', 'CUSTOM')).toBe('Regular · CUSTOM')
  })
})

describe('buildBackfillPlan', () => {
  it('maps the real inventory to 9 cards (hit 4 + solo 1 + suite 4) and 3 skips', () => {
    const { cards, skipped } = buildBackfillPlan([...hitTables(), ...soloTables(), ...suiteTables()])
    expect(cards).toHaveLength(9)
    expect(skipped).toHaveLength(3)

    const hit = cards.filter((c) => c.org === 'hit').map((c) => c.sourceKey).sort()
    expect(hit).toEqual(['hit:Regular:DARIO', 'hit:Regular:ESPECIAL', 'hit:Regular:REGULAR', 'hit:Regular:VIP'].sort())

    const solo = cards.filter((c) => c.org === 'solo-guegue')
    expect(solo).toHaveLength(1)
    expect(solo[0].sourceKey).toBe('solo-guegue:Estándar:REGULAR')
    expect(solo[0].name).toBe('Estándar')
    expect(solo[0].air.price).toBe(7.0)
    expect(solo[0].mar.price).toBe(2.9)

    const suite = cards.filter((c) => c.org === 'suite')
    expect(suite).toHaveLength(4)

    // Skipped: hit MADRES (no MAR), suite MADRES (no MAR), solo-guegue eee (empty).
    const reasons = skipped.map((s) => `${s.org}:${s.tableName}:${s.tier}=${s.reason}`)
    expect(reasons).toContain('hit:Regular:MADRES=missing MAR')
    expect(reasons).toContain('suite:Regular:MADRES=missing MAR')
    expect(reasons).toContain('solo-guegue:eee:=empty table (no prices)')
  })

  it('card names are unique per org (simple_pair)', () => {
    const { cards } = buildBackfillPlan([...hitTables(), ...suiteTables()])
    for (const org of ['hit', 'suite']) {
      const names = cards.filter((c) => c.org === org).map((c) => c.name)
      expect(new Set(names).size).toBe(names.length)
    }
  })

  it('aborts on an unexpected agency with rate tables', () => {
    const rogue = table('x', 'mystery', 'Tabla', 'AIR', [row('REGULAR', 1, 1)])
    expect(() => buildBackfillPlan([...hitTables(), rogue])).toThrow(/Unexpected agency with rate tables: mystery/)
  })

  it('aborts on a null cost', () => {
    const bad = table('b', 'hit', 'Regular', 'AIR', [{ tier: 'REGULAR', price: 1, cost: null, price_model: 'weight' }])
    expect(() => buildBackfillPlan([bad])).toThrow(/Null cost/)
  })

  it('aborts on a non-weight model', () => {
    const bad = table('b', 'hit', 'Regular', 'AIR', [{ tier: 'REGULAR', price: 1, cost: 0.5, price_model: 'volume' }])
    expect(() => buildBackfillPlan([bad])).toThrow(/Non-weight model/)
  })

  it('BACKFILL_ORGS contains exactly hit, solo-guegue, suite', () => {
    expect(BACKFILL_ORGS).toEqual(['hit', 'solo-guegue', 'suite'])
  })
})