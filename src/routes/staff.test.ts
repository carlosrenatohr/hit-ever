import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../index.js'

// Replace the real ingest chain (Cargotrack + InsForge) with a stub: the route
// tests below exercise auth, role gate, cooldown and the envelope, not scraping.
vi.mock('../services/ingest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/ingest.js')>()
  return {
    ...actual,
    IngestService: class {
      async ingestOne(_provider: string, _guia: string): Promise<boolean> {
        return true
      }
      async ingestOneAnyProvider(_guia: string): Promise<string | null> {
        return 'everest'
      }
    },
  }
})

const ctx = { waitUntil() {}, passThroughOnException() {} }

const ENV = {
  INSFORGE_API_URL: 'https://a4qvtp8s.us-east.insforge.app',
  INSFORGE_API_KEY: 'admin-key',
  UPSTASH_REDIS_URL: 'https://u.upstash.io',
  UPSTASH_REDIS_TOKEN: 't',
}

let role: string
let incrResult = 1
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  role = 'admin'
  incrResult = 1
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/auth/sessions/current')) {
      return new Response(JSON.stringify({ user: { id: 'u1', email: 'a@b.c' } }), { status: 200 })
    }
    if (url.includes('/api/database/records/app_users')) {
      return new Response(
        JSON.stringify([{ role, active: true, name: null, email: 'a@b.c' }]),
        { status: 200 },
      )
    }
    if (url.includes('/incr/')) {
      return new Response(JSON.stringify({ result: incrResult }), { status: 200 })
    }
    if (url.includes('/expire/')) {
      return new Response(JSON.stringify({ result: 1 }), { status: 200 })
    }
    if (url.includes('/ttl/')) {
      return new Response(JSON.stringify({ result: 250 }), { status: 200 })
    }
    throw new Error(`unexpected fetch: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function post(path: string, token?: string): Promise<Response> {
  const headers: Record<string, string> = {}
  if (token) headers.Authorization = `Bearer ${token}`
  return Promise.resolve(
    worker.fetch(new Request(`https://t.test${path}`, { method: 'POST', headers }), ENV as never, ctx as never),
  )
}

describe('POST /staff/packages/:guia/refresh', () => {
  it('rejects a malformed guia with 422 INVALID_PARAM', async () => {
    const res = await post('/staff/packages/bad%20guia/refresh', 'token')
    expect(res.status).toBe(422)
    const body = (await res.json()) as { ok: boolean; error: { code: string } }
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe('INVALID_PARAM')
  })

  it('rejects a missing bearer token with 401 UNAUTHORIZED before any fetch', async () => {
    const res = await post('/staff/packages/123456/refresh')
    expect(res.status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a non-admin role with 403 FORBIDDEN', async () => {
    role = 'staff'
    const res = await post('/staff/packages/123456/refresh', 'token')
    expect(res.status).toBe(403)
    const body = (await res.json()) as { ok: boolean; error: { code: string } }
    expect(body.error.code).toBe('FORBIDDEN')
  })

  it('refreshes a package for an admin', async () => {
    const res = await post('/staff/packages/123456/refresh', 'token')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; data: { guia: string; provider: string } }
    expect(body.ok).toBe(true)
    expect(body.data).toEqual({ guia: '123456', provider: 'everest' })
  })

  it('returns 429 with Retry-After while a guia is on cooldown', async () => {
    const first = await post('/staff/packages/123456/refresh', 'token')
    expect(first.status).toBe(200)
    incrResult = 2
    const second = await post('/staff/packages/123456/refresh', 'token')
    expect(second.status).toBe(429)
    expect(second.headers.get('Retry-After')).toBe('250')
    const body = (await second.json()) as {
      ok: boolean
      error: { code: string; details: { retryAfterSeconds: number } }
    }
    expect(body.error.code).toBe('RATE_LIMITED')
    expect(body.error.details.retryAfterSeconds).toBe(250)
  })
})
