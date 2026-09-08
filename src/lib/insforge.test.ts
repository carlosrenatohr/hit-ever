import { afterEach, describe, expect, it, vi } from 'vitest'
import { InsforgeClient } from './insforge.js'

afterEach(() => vi.unstubAllGlobals())

describe('InsforgeClient — soft-deleted packages', () => {
  it('getPackageByGuia and getPackageByTracking exclude deleted packages', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', async (input: Request | string) => {
      urls.push(typeof input === 'string' ? input : input.url)
      return new Response(JSON.stringify([]), { status: 200 })
    })
    const client = new InsforgeClient('https://db.test', 'key')

    await client.getPackageByGuia('926791')
    await client.getPackageByTracking('TRK1')

    expect(urls[0]).toContain('almacen_id=eq.926791')
    expect(urls[0]).toContain('deleted_at=is.null')
    expect(urls[1]).toContain('tracking_number=eq.TRK1')
    expect(urls[1]).toContain('deleted_at=is.null')
  })

  it('getOpenAlmacenIds skips deleted packages (no refresh budget spent)', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', async (input: Request | string) => {
      urls.push(typeof input === 'string' ? input : input.url)
      return new Response(JSON.stringify([]), { status: 200 })
    })

    await new InsforgeClient('https://db.test', 'key').getOpenAlmacenIds('everest', 10)

    expect(urls[0]).toContain('deleted_at=is.null')
  })

  it('upsert never sends deleted_at — a re-scrape cannot resurrect a deleted package', async () => {
    const bodies: string[] = []
    vi.stubGlobal('fetch', async (_input: Request | string, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ''))
      return new Response(JSON.stringify([{ id: 'p1', almacen_id: 'g1' }]), { status: 201 })
    })

    await new InsforgeClient('https://db.test', 'key').upsertPackages([
      { provider_id: 'everest', organization_id: 'hit', almacen_id: 'g1', tracking_number: null, status: 'en_almacen', scraped_at: 'x' },
    ])

    expect(bodies.length).toBeGreaterThan(0)
    for (const raw of bodies) {
      const rows = JSON.parse(raw) as Record<string, unknown>[]
      for (const row of rows) expect(row).not.toHaveProperty('deleted_at')
    }
  })
})