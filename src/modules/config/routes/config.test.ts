import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../../../index.js'
import { roleHasPermission } from '../middleware/auth.js'

// Same contract as the billing module tests: the config endpoints delegate
// token verification to InsForge and read role + agency from app_users. We
// stub global fetch to simulate both upstream calls plus the config tables.

const ctx = { waitUntil() {}, passThroughOnException() {} }
const ENV = { INSFORGE_API_URL: 'https://db.test', INSFORGE_API_KEY: 'admin-key' } as never

function call(path: string, headers: Record<string, string> = {}, init: { method?: string; body?: unknown } = {}): Promise<Response> {
  const body = init.body === undefined ? undefined : JSON.stringify(init.body)
  return worker.fetch(new Request(`https://t.test${path}`, { method: init.method ?? 'GET', headers, body }), ENV, ctx as never)
}

/**
 * Route the stubbed fetch by URL:
 *  - /api/auth/sessions/current  -> valid iff the bearer token is `goodToken`
 *  - /api/database/records/app_users -> returns the row map for the user id
 *  - any config table            -> rows from `tables` or an empty list
 */
function stubBackend(opts: { validToken?: string; users?: Record<string, unknown>; tables?: Record<string, unknown[]> }) {
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
    if (url.includes('/api/database/records/')) {
      const table = url.split('/api/database/records/')[1].split('?')[0]
      return new Response(JSON.stringify(opts.tables?.[table] ?? []), { status: 200 })
    }
    return new Response('not found', { status: 404 })
  })
}

afterEach(() => vi.unstubAllGlobals())

const admin = { role: 'admin', active: true, agency: 'hit', name: 'Boss' }
const staff = { role: 'staff', active: true, agency: 'suite', name: 'Ana' }
const viewer = { role: 'viewer', active: true, agency: 'hit' }

describe('roleHasPermission', () => {
  it('admin/billing write everything, staff read-only, viewer none', () => {
    expect(roleHasPermission('admin', 'rates:write')).toBe(true)
    expect(roleHasPermission('billing', 'config:write')).toBe(true)
    expect(roleHasPermission('staff', 'rates:read')).toBe(true)
    expect(roleHasPermission('staff', 'audit:read')).toBe(true)
    expect(roleHasPermission('staff', 'rates:write')).toBe(false)
    expect(roleHasPermission('viewer', 'rates:read')).toBe(false)
  })
})

describe('GET /api/config/branding — auth gate', () => {
  it('401 when no bearer token is sent', async () => {
    const res = await call('/api/config/branding')
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('UNAUTHORIZED')
  })

  it('200 for staff, returning the agencies', async () => {
    stubBackend({
      validToken: 'goodToken',
      users: { u1: staff },
      tables: { agencies: [{ slug: 'hit', name: 'HIT Cargo', logo_url: null, logo_key: null }] },
    })
    const res = await call('/api/config/branding', { Authorization: 'Bearer goodToken' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; data: { agencies: Array<{ slug: string }> } }
    expect(body.data.agencies[0].slug).toBe('hit')
  })

  it('403 when the user has no app_users row', async () => {
    stubBackend({ validToken: 'goodToken', users: {} })
    const res = await call('/api/config/branding', { Authorization: 'Bearer goodToken' })
    expect(res.status).toBe(403)
  })
})

describe('GET /api/config/rates — tenant scoping', () => {
  it('staff is pinned to their session agency (organizationId ignored → 403)', async () => {
    stubBackend({ validToken: 'goodToken', users: { u1: staff }, tables: {} })
    const res = await call('/api/config/rates?organizationId=hit', { Authorization: 'Bearer goodToken' })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('FORBIDDEN')
  })

  it('staff lists their own agency rates', async () => {
    stubBackend({ validToken: 'goodToken', users: { u1: staff }, tables: {} })
    const res = await call('/api/config/rates', { Authorization: 'Bearer goodToken' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; data: { organizationId: string; tables: unknown[] } }
    expect(body.data.organizationId).toBe('suite')
  })

  it('admin may read any agency', async () => {
    stubBackend({ validToken: 'goodToken', users: { u1: admin }, tables: {} })
    const res = await call('/api/config/rates?organizationId=suite', { Authorization: 'Bearer goodToken' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { organizationId: string } }
    expect(body.data.organizationId).toBe('suite')
  })
})

describe('POST /api/config/rates — write gate', () => {
  it('staff cannot create a rate table (403)', async () => {
    stubBackend({ validToken: 'goodToken', users: { u1: staff }, tables: {} })
    const res = await call(
      '/api/config/rates',
      {
        Authorization: 'Bearer goodToken',
        'Content-Type': 'application/json',
      },
      { method: 'POST', body: { name: 'Premium', freightType: 'AIR' } },
    )
    expect(res.status).toBe(403)
  })

  it('admin creates a rate table for their org and audits it', async () => {
    stubBackend({
      validToken: 'goodToken',
      users: { u1: admin },
      tables: {
        rate_tables: [
          { id: 'rt1', organization_id: 'hit', name: 'Premium', freight_type: 'AIR', created_at: '2026-08-14T00:00:00Z', updated_at: '2026-08-14T00:00:00Z', rate_rows: [] },
        ],
      },
    })
    const res = await call(
      '/api/config/rates',
      {
        Authorization: 'Bearer goodToken',
        'Content-Type': 'application/json',
      },
      { method: 'POST', body: { name: 'Premium', freightType: 'AIR' } },
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as { ok: boolean; data: { id: string; organizationId: string } }
    expect(body.ok).toBe(true)
    expect(body.data.organizationId).toBe('hit')
    expect(body.data.id).toBe('rt1')
  })
})
