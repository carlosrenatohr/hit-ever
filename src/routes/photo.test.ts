import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../index.js'

const ctx = { waitUntil() {}, passThroughOnException() {} }
const ENV = { INSFORGE_API_URL: 'https://db.test', INSFORGE_API_KEY: 'admin-key' } as never

function call(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return worker.fetch(new Request(`https://t.test${path}`, { method: 'GET', headers }), ENV, ctx as never)
}

/**
 * Stub the auth upstream (sessions/current + app_users) so the staff gate can
 * be exercised, and capture any provider-image fetch.
 */
function stubAuth(opts: { validToken?: string; role?: string; agency?: string; active?: boolean }) {
  const { validToken = 'goodToken', role = 'staff', agency = 'hit', active = true } = opts
  let upstreamUrl: string | null = null
  vi.stubGlobal('fetch', async (input: Request | string, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? ''
    if (url.includes('/api/auth/sessions/current')) {
      const token = auth.replace(/^Bearer\s+/i, '')
      if (token === validToken) return new Response(JSON.stringify({ user: { id: 'u1', email: 'u1@test' } }), { status: 200 })
      return new Response('unauthorized', { status: 401 })
    }
    if (url.includes('/api/database/records/app_users')) {
      return new Response(JSON.stringify([{ role, active, agency, name: 'Ana' }]), { status: 200 })
    }
    if (/cargotrack\.net\/items\//.test(url)) {
      upstreamUrl = url
      return new Response('image-bytes', { status: 200, headers: { 'content-type': 'image/jpeg' } })
    }
    return new Response('not found', { status: 404 })
  })
  return { getUpstream: () => upstreamUrl }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('GET /api/photo — staff-gated provider photo proxy', () => {
  it('401 when no bearer token is sent', async () => {
    const res = await call('/api/photo?url=https%3A%2F%2Fgc.cargotrack.net%2Fitems%2FDP_1.jpg')
    expect(res.status).toBe(401)
  })

  it('422 (SSRF guard) when the URL is not a provider photo', async () => {
    stubAuth({})
    const res = await call('/api/photo?url=https%3A%2F%2Fevil.example%2Fx.jpg', { Authorization: 'Bearer goodToken' })
    expect(res.status).toBe(422)
  })

  it('422 when url is missing', async () => {
    stubAuth({})
    const res = await call('/api/photo', { Authorization: 'Bearer goodToken' })
    expect(res.status).toBe(422)
  })

  it('403 for a viewer (no rates:read)', async () => {
    stubAuth({ role: 'viewer' })
    const res = await call('/api/photo?url=https%3A%2F%2Fgc.cargotrack.net%2Fitems%2FDP_1.jpg', {
      Authorization: 'Bearer goodToken',
    })
    expect(res.status).toBe(403)
  })

  it('200 for staff: streams the provider image with content-type + cache-control', async () => {
    const { getUpstream } = stubAuth({ role: 'staff' })
    const res = await call('/api/photo?url=https%3A%2F%2Feverest.cargotrack.net%2Fitems%2FDP_202605271016294178.jpg', {
      Authorization: 'Bearer goodToken',
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/jpeg')
    expect(res.headers.get('cache-control')).toContain('max-age=86400')
    expect(await res.text()).toBe('image-bytes')
    expect(getUpstream()).toBe('https://everest.cargotrack.net/items/DP_202605271016294178.jpg')
  })

  it('503 when the provider image fails', async () => {
    stubAuth({ role: 'admin' })
    vi.stubGlobal('fetch', async (input: Request | string) => {
      const url = typeof input === 'string' ? input : input.url
      if (/cargotrack\.net\/items\//.test(url)) return new Response('gone', { status: 404 })
      return new Response('not found', { status: 404 })
    })
    const res = await call('/api/photo?url=https%3A%2F%2Fgc.cargotrack.net%2Fitems%2FDP_missing.jpg', {
      Authorization: 'Bearer goodToken',
    })
    expect(res.status).toBe(503)
  })
})
