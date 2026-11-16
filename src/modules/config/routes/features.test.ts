import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../../../index.js'
import { ConfigService } from '../service/config-service.js'

// Stage 1 isolation guards: the flexible-pricing flag is resolved from the
// SESSION agency (never from ?organizationId=), the panel-facing /features
// endpoint reports it without leaking other agencies' state, and the server
// gate throws for agencies that have not opted in.

const ctx = { waitUntil() {}, passThroughOnException() {} }
const ENV = { INSFORGE_API_URL: 'https://db.test', INSFORGE_API_KEY: 'admin-key' } as never

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubBackend(agencies: unknown[], sessionAgency = 'suite') {
  vi.stubGlobal('fetch', async (input: Request | string) => {
    const url = typeof input === 'string' ? input : input.url
    if (url.includes('/api/auth/sessions/current')) {
      return new Response(JSON.stringify({ user: { id: 'u1', email: 'u1@test' } }), { status: 200 })
    }
    if (url.includes('/api/database/records/app_users')) {
      return new Response(JSON.stringify([{ role: 'staff', active: true, agency: sessionAgency }]), { status: 200 })
    }
    if (url.includes('/api/database/records/agencies')) {
      return new Response(JSON.stringify(agencies), { status: 200 })
    }
    return new Response('not found', { status: 404 })
  })
}

describe('GET /api/config/features', () => {
  it('reports flexiblePricing=true for an opted-in agency', async () => {
    stubBackend([{ flexible_pricing_enabled: true }])
    const res = await worker.fetch(new Request('https://t.test/api/config/features', { headers: { Authorization: 'Bearer goodToken' } }), ENV, ctx as never)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data?: { flexiblePricing?: boolean } }
    expect(body.data?.flexiblePricing).toBe(true)
  })

  it('reports flexiblePricing=false for production agencies (default)', async () => {
    stubBackend([{ flexible_pricing_enabled: false }])
    const res = await worker.fetch(new Request('https://t.test/api/config/features', { headers: { Authorization: 'Bearer goodToken' } }), ENV, ctx as never)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data?: { flexiblePricing?: boolean } }
    expect(body.data?.flexiblePricing).toBe(false)
  })

  it('is self-scoped: ignores ?organizationId= and reads the session agency', async () => {
    const requested: string[] = []
    vi.stubGlobal('fetch', async (input: Request | string) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('/api/database/records/agencies')) {
        requested.push(url)
        return new Response(JSON.stringify([{ flexible_pricing_enabled: false }]), { status: 200 })
      }
      if (url.includes('/api/auth/sessions/current')) return new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200 })
      if (url.includes('/api/database/records/app_users')) return new Response(JSON.stringify([{ role: 'staff', active: true, agency: 'suite' }]), { status: 200 })
      return new Response('not found', { status: 404 })
    })
    const res = await worker.fetch(
      new Request('https://t.test/api/config/features?organizationId=original-express', { headers: { Authorization: 'Bearer goodToken' } }),
      ENV,
      ctx as never,
    )
    expect(res.status).toBe(200)
    expect(requested.length).toBe(1)
    expect(requested[0]).toContain('slug=eq.suite')
    expect(requested[0]).not.toContain('original-express')
  })
})

describe('flexible pricing gate (service)', () => {
  const repo = {
    getFlexiblePricingFlag: async (org: string) => org === 'suite',
  } as never

  it('assertFlexiblePricing passes for the pilot agency', async () => {
    const svc = new ConfigService(repo)
    await expect(svc.assertFlexiblePricing('suite')).resolves.toBeUndefined()
  })

  it('assertFlexiblePricing throws for agencies that have not opted in', async () => {
    const svc = new ConfigService(repo)
    await expect(svc.assertFlexiblePricing('original-express')).rejects.toThrow(/not enabled/i)
  })

  it('isFlexiblePricingEnabled defaults to false when the column is missing', async () => {
    const missing = { getFlexiblePricingFlag: async () => false } as never
    const svc = new ConfigService(missing)
    await expect(svc.isFlexiblePricingEnabled('hit')).resolves.toBe(false)
  })
})
