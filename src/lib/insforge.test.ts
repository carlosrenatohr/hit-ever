import { afterEach, describe, expect, it, vi } from 'vitest'
import { InsforgeClient } from './insforge.js'

afterEach(() => vi.unstubAllGlobals())

/** fetch stub routed by URL, so the pre-check GET, the upsert POST and the audit POST can differ. */
function stubFetch(handler: (url: string, init?: RequestInit) => Response): { url: string; body: string }[] {
  const calls: { url: string; body: string }[] = []
  vi.stubGlobal('fetch', async (input: Request | string, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url
    calls.push({ url, body: String(init?.body ?? '') })
    return handler(url, init)
  })
  return calls
}

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
    expect(urls[0]).not.toContain('organization_id=eq') // sin org → sin filtro (legacy admin API)
    expect(urls[1]).toContain('tracking_number=eq.TRK1')
    expect(urls[1]).toContain('deleted_at=is.null')
  })

  it('scopes lookups by tenant when org is provided (ADR-013)', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', async (input: Request | string) => {
      urls.push(typeof input === 'string' ? input : input.url)
      return new Response(JSON.stringify([]), { status: 200 })
    })
    const client = new InsforgeClient('https://db.test', 'key')

    await client.getPackageByGuia('926791', 'hit')
    await client.getPackageByTracking('TRK1', 'orbit')

    expect(urls[0]).toContain('organization_id=eq.hit')
    expect(urls[1]).toContain('organization_id=eq.orbit')
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
})

describe('InsforgeClient — upsert per-tenant identity (ADR-013)', () => {
  const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    provider_id: 'everest',
    organization_id: 'hit',
    almacen_id: 'g1',
    tracking_number: null,
    status: 'en_almacen',
    scraped_at: 'x',
    ...over,
  })

  it('upsert never sends deleted_at — a re-scrape cannot resurrect a deleted package', async () => {
    const calls = stubFetch((url) =>
      url.includes('/packages?on_conflict=')
        ? new Response(JSON.stringify([{ id: 'p1', almacen_id: 'g1' }]), { status: 201 })
        : new Response('[]', { status: 200 }),
    )

    await new InsforgeClient('https://db.test', 'key').upsertPackages([row()])

    const posts = calls.filter((c) => c.body)
    expect(posts.length).toBeGreaterThan(0)
    for (const p of posts) {
      const rows = JSON.parse(p.body) as Record<string, unknown>[]
      for (const r of rows) expect(r).not.toHaveProperty('deleted_at')
    }
  })

  it('upserts with on_conflict=organization_id,almacen_id (guía identity per tenant)', async () => {
    const calls = stubFetch(() => new Response('[]', { status: 200 }))

    await new InsforgeClient('https://db.test', 'key').upsertPackages([row()])

    const post = calls.find((c) => c.body)
    expect(post?.url).toContain('/packages?on_conflict=organization_id,almacen_id')
  })

  it('skips + audits a guía owned by ANOTHER provider of the same tenant (never merges)', async () => {
    const calls = stubFetch((url) => {
      if (url.includes('/audit_logs')) return new Response('', { status: 201 })
      if (url.includes('select=almacen_id,provider_id'))
        return new Response(JSON.stringify([{ almacen_id: 'g1', provider_id: 'gc' }]), { status: 200 })
      if (url.includes('/packages?on_conflict='))
        return new Response(JSON.stringify([{ id: 'p2', almacen_id: 'g2' }]), { status: 201 })
      return new Response('[]', { status: 200 })
    })
    const client = new InsforgeClient('https://db.test', 'key')

    const out = await client.upsertPackages([
      row(), // g1: dueño 'gc' → se omite (dos paquetes físicos distintos)
      row({ almacen_id: 'g2' }), // g2: sin dueño → upsert normal
    ])

    expect(out).toEqual([{ id: 'p2', almacen_id: 'g2' }])

    const upsertPost = calls.find((c) => c.url.includes('/packages?on_conflict='))
    const sent = JSON.parse(upsertPost?.body ?? '[]') as { almacen_id: string }[]
    expect(sent.map((r) => r.almacen_id)).toEqual(['g2'])

    const audit = calls.find((c) => c.url.includes('/audit_logs'))
    expect(audit).toBeDefined()
    const auditRows = JSON.parse(audit?.body ?? '[]') as {
      organization_id: string
      action: string
      actor_type: string
      entity_type: string
      entity_id: string
      metadata: Record<string, unknown>
    }[]
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0]).toMatchObject({
      organization_id: 'hit',
      action: 'package.ingest_skipped',
      actor_type: 'system',
      entity_type: 'package',
      entity_id: 'g1',
    })
    expect(auditRows[0].metadata).toMatchObject({
      incoming_provider_id: 'everest',
      existing_provider_id: 'gc',
    })
  })

  it('merges normally when the existing guía belongs to the SAME provider', async () => {
    const calls = stubFetch((url) => {
      if (url.includes('select=almacen_id,provider_id'))
        return new Response(JSON.stringify([{ almacen_id: 'g1', provider_id: 'everest' }]), { status: 200 })
      if (url.includes('/packages?on_conflict='))
        return new Response(JSON.stringify([{ id: 'p1', almacen_id: 'g1' }]), { status: 201 })
      return new Response('[]', { status: 200 })
    })

    const out = await new InsforgeClient('https://db.test', 'key').upsertPackages([row()])

    expect(out).toEqual([{ id: 'p1', almacen_id: 'g1' }])
    expect(calls.some((c) => c.url.includes('/audit_logs'))).toBe(false)
  })

  it('skips the pre-check entirely when rows carry no org/provider keys', async () => {
    const calls = stubFetch(() => new Response(JSON.stringify([]), { status: 201 }))

    await new InsforgeClient('https://db.test', 'key').upsertPackages([{ almacen_id: 'g9' }])

    expect(calls.some((c) => c.url.includes('select=almacen_id,provider_id'))).toBe(false)
    expect(calls.some((c) => c.url.includes('/audit_logs'))).toBe(false)
  })
})
