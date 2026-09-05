import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../../../index.js'
import { roleHasPermission } from '../middleware/auth.js'

// The billing endpoints delegate token verification to InsForge and read the
// caller's role from app_users. We stub global fetch to simulate both upstream
// calls so the gate can be tested without a live backend.

const ctx = { waitUntil() {}, passThroughOnException() {} }
const ENV = { INSFORGE_API_URL: 'https://db.test', INSFORGE_API_KEY: 'admin-key' } as never

function health(headers: Record<string, string> = {}): Promise<Response> {
  return worker.fetch(new Request('https://t.test/api/billing/health', { headers }), ENV, ctx as never)
}

/**
 * Route the stubbed fetch by URL:
 *  - /api/auth/sessions/current  -> valid iff the bearer token is `goodToken`
 *  - /api/database/records/app_users -> returns the row map for the user id
 */
function stubBackend(opts: { validToken?: string; users?: Record<string, unknown> }) {
  vi.stubGlobal('fetch', async (input: Request | string, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? ''
    if (url.includes('/api/auth/sessions/current')) {
      const token = auth.replace(/^Bearer\s+/i, '')
      if (opts.validToken && token === opts.validToken) {
        return new Response(JSON.stringify({ user: { id: 'u1', email: 'u1@test' } }), { status: 200 })
      }
      return new Response('unauthorized', { status: 401 })
    }
    if (url.includes('/api/database/records/app_users')) {
      const row = opts.users?.['u1']
      return new Response(JSON.stringify(row ? [row] : []), { status: 200 })
    }
    return new Response('not found', { status: 404 })
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('roleHasPermission', () => {
  it('admin/billing read+write, staff read-only, viewer none', () => {
    expect(roleHasPermission('admin', 'invoices:write')).toBe(true)
    expect(roleHasPermission('billing', 'invoices:write')).toBe(true)
    expect(roleHasPermission('staff', 'invoices:read')).toBe(true)
    expect(roleHasPermission('staff', 'invoices:write')).toBe(false)
    expect(roleHasPermission('viewer', 'invoices:read')).toBe(false)
  })
})

describe('GET /api/billing/health — auth gate', () => {
  it('401 when no bearer token is sent', async () => {
    const res = await health()
    expect(res.status).toBe(401)
    const body = (await res.json()) as { ok: boolean; error: { code: string } }
    expect(body.error.code).toBe('UNAUTHORIZED')
  })

  it('401 when the token is invalid (InsForge rejects it)', async () => {
    stubBackend({ validToken: 'goodToken', users: { u1: { role: 'admin', active: true, agency: 'hit' } } })
    const res = await health({ Authorization: 'Bearer badToken' })
    expect(res.status).toBe(401)
  })

  it('403 when the user has no app_users row', async () => {
    stubBackend({ validToken: 'goodToken', users: {} })
    const res = await health({ Authorization: 'Bearer goodToken' })
    expect(res.status).toBe(403)
  })

  it('403 when the account is inactive', async () => {
    stubBackend({ validToken: 'goodToken', users: { u1: { role: 'admin', active: false, agency: 'hit' } } })
    const res = await health({ Authorization: 'Bearer goodToken' })
    expect(res.status).toBe(403)
  })

  it('200 for an active staff member, echoing the role', async () => {
    stubBackend({ validToken: 'goodToken', users: { u1: { role: 'staff', active: true, name: 'Ana', agency: 'hit' } } })
    const res = await health({ Authorization: 'Bearer goodToken' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; data: { user: { role: string } } }
    expect(body.ok).toBe(true)
    expect(body.data.user.role).toBe('staff')
  })
})
