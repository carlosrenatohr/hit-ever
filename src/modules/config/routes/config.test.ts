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
      if (init?.method === 'POST' && table === 'audit_logs') {
        postedAudits.push((init.body as string | null) ?? '')
      }
      return new Response(JSON.stringify(opts.tables?.[table] ?? []), { status: 200 })
    }
    return new Response('not found', { status: 404 })
  })
}

let postedAudits: string[] = []

afterEach(() => {
  vi.unstubAllGlobals()
  postedAudits = []
})

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

  it('200 for staff, scoped to their agency, no storage keys', async () => {
    stubBackend({
      validToken: 'goodToken',
      users: { u1: staff },
      tables: {
        agencies: [
          { slug: 'hit', name: 'HIT Cargo', logo_url: null, logo_key: 'hit/logo.png' },
          { slug: 'suite', name: 'Suite', logo_url: null, logo_key: 'suite/logo.png' },
        ],
      },
    })
    const res = await call('/api/config/branding', { Authorization: 'Bearer goodToken' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; data: { agencies: Array<Record<string, unknown>> } }
    expect(body.data.agencies).toHaveLength(1)
    expect(body.data.agencies[0].slug).toBe('suite')
    expect(body.data.agencies[0]).not.toHaveProperty('logoKey')
  })

  it('admin sees every agency', async () => {
    stubBackend({
      validToken: 'goodToken',
      users: { u1: admin },
      tables: {
        agencies: [
          { slug: 'hit', name: 'HIT Cargo', logo_url: null, logo_key: null },
          { slug: 'suite', name: 'Suite', logo_url: null, logo_key: null },
        ],
      },
    })
    const res = await call('/api/config/branding', { Authorization: 'Bearer goodToken' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { agencies: unknown[] } }
    expect(body.data.agencies).toHaveLength(2)
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

describe('PATCH /api/config/branding/:slug — branding write', () => {
  it('staff cannot brand (config:write is admin/billing only)', async () => {
    stubBackend({ validToken: 'goodToken', users: { u1: staff }, tables: {} })
    const res = await call(
      '/api/config/branding/suite',
      { Authorization: 'Bearer goodToken', 'Content-Type': 'application/json' },
      { method: 'PATCH', body: { logoKey: 'suite/logo.png' } },
    )
    expect(res.status).toBe(403)
  })

  it('billing is pinned to their own agency', async () => {
    stubBackend({ validToken: 'goodToken', users: { u1: { role: 'billing', active: true, agency: 'hit' } }, tables: {} })
    const res = await call(
      '/api/config/branding/suite',
      { Authorization: 'Bearer goodToken', 'Content-Type': 'application/json' },
      { method: 'PATCH', body: { logoKey: 'suite/logo.png' } },
    )
    expect(res.status).toBe(403)
  })

  it('admin brands another agency: URL derived server-side, audited', async () => {
    stubBackend({
      validToken: 'goodToken',
      users: { u1: admin },
      tables: {
        agencies: [
          { slug: 'hit', name: 'HIT Cargo', logo_url: null, logo_key: null },
          { slug: 'suite', name: 'Suite', logo_url: null, logo_key: null },
        ],
      },
    })
    const res = await call(
      '/api/config/branding/suite',
      { Authorization: 'Bearer goodToken', 'Content-Type': 'application/json' },
      { method: 'PATCH', body: { logoKey: 'logos/suite.webp' } },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; data: { slug: string; logoUrl: string } }
    expect(body.ok).toBe(true)
    expect(body.data.slug).toBe('suite')
    expect(body.data.logoUrl).toBe('https://db.test/api/storage/buckets/branding/objects/logos/suite.webp')
    expect(postedAudits).toHaveLength(1)
    const audit = JSON.parse(postedAudits[0])[0] as { action: string; organization_id: string; metadata: { logo_key: string } }
    expect(audit.action).toBe('branding.update')
    expect(audit.organization_id).toBe('suite')
    expect(audit.metadata.logo_key).toBe('logos/suite.webp')
  })

  it('404 for an unknown agency (no silent 200)', async () => {
    stubBackend({ validToken: 'goodToken', users: { u1: admin }, tables: { agencies: [] } })
    const res = await call(
      '/api/config/branding/nope',
      { Authorization: 'Bearer goodToken', 'Content-Type': 'application/json' },
      { method: 'PATCH', body: { logoKey: 'logos/x.webp' } },
    )
    expect(res.status).toBe(404)
    expect(postedAudits).toHaveLength(0)
  })

  it('422 for a malformed object key', async () => {
    stubBackend({ validToken: 'goodToken', users: { u1: admin }, tables: {} })
    const res = await call(
      '/api/config/branding/suite',
      { Authorization: 'Bearer goodToken', 'Content-Type': 'application/json' },
      { method: 'PATCH', body: { logoKey: 'https://evil.example/x.webp' } },
    )
    expect(res.status).toBe(422)
    expect(postedAudits).toHaveLength(0)
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
    expect(postedAudits).toHaveLength(1)
    const audit = JSON.parse(postedAudits[0])[0] as { action: string; organization_id: string; actor_id: string }
    expect(audit.action).toBe('rate_table.create')
    expect(audit.organization_id).toBe('hit')
    expect(audit.actor_id).toBe('u1')
  })
})

describe('PUT /api/config/rates/:id/rows — row replacement', () => {
  const tables = {
    rate_tables: [
      { id: 'rt1', organization_id: 'suite', name: 'Regular', freight_type: 'MAR', created_at: '2026-08-14T00:00:00Z', updated_at: '2026-08-14T00:00:00Z', rate_rows: [] },
    ],
    rate_rows: [],
  }

  it('422 on duplicate tiers (refine)', async () => {
    stubBackend({ validToken: 'goodToken', users: { u1: admin }, tables })
    const res = await call(
      '/api/config/rates/rt1/rows?organizationId=suite',
      { Authorization: 'Bearer goodToken', 'Content-Type': 'application/json' },
      {
        method: 'PUT',
        body: {
          rows: [
            { tier: 'REGULAR', price: 2.5, cost: 1.2 },
            { tier: 'REGULAR', price: 3, cost: 1.5 },
          ],
        },
      },
    )
    expect(res.status).toBe(422)
    expect(postedAudits).toHaveLength(0)
  })

  it('200 with nullable cost, scoped to the requested org, audited', async () => {
    stubBackend({ validToken: 'goodToken', users: { u1: admin }, tables })
    const res = await call(
      '/api/config/rates/rt1/rows?organizationId=suite',
      { Authorization: 'Bearer goodToken', 'Content-Type': 'application/json' },
      {
        method: 'PUT',
        body: {
          rows: [
            { tier: 'REGULAR', price: 2.5, cost: null },
            { tier: 'VIP', price: 8, cost: 4.1 },
          ],
        },
      },
    )
    expect(res.status).toBe(200)
    expect(postedAudits).toHaveLength(1)
    const audit = JSON.parse(postedAudits[0])[0] as { action: string; organization_id: string; metadata: { tiers: string[] } }
    expect(audit.action).toBe('rate_rows.replace')
    expect(audit.organization_id).toBe('suite')
    expect(audit.metadata.tiers).toEqual(['REGULAR', 'VIP'])
  })

  it('403 when the table belongs to another org', async () => {
    stubBackend({ validToken: 'goodToken', users: { u1: admin }, tables })
    const res = await call(
      '/api/config/rates/rt1/rows?organizationId=hit',
      { Authorization: 'Bearer goodToken', 'Content-Type': 'application/json' },
      { method: 'PUT', body: { rows: [{ tier: 'REGULAR', price: 2.5, cost: null }] } },
    )
    expect(res.status).toBe(403)
  })
})

describe('PATCH/DELETE /api/config/rates/:id — org-scoped writes', () => {
  const tables = {
    rate_tables: [
      { id: 'rt1', organization_id: 'suite', name: 'Regular', freight_type: 'MAR', created_at: '2026-08-14T00:00:00Z', updated_at: '2026-08-14T00:00:00Z', rate_rows: [] },
    ],
  }

  it('admin renames a table in another org (asymmetry fixed)', async () => {
    stubBackend({ validToken: 'goodToken', users: { u1: admin }, tables })
    const res = await call(
      '/api/config/rates/rt1?organizationId=suite',
      { Authorization: 'Bearer goodToken', 'Content-Type': 'application/json' },
      { method: 'PATCH', body: { name: 'Regular 2026' } },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; data: { name: string } }
    expect(body.data.name).toBe('Regular 2026')
  })

  it('staff cannot pass an organizationId', async () => {
    stubBackend({ validToken: 'goodToken', users: { u1: staff }, tables })
    const res = await call(
      '/api/config/rates/rt1?organizationId=suite',
      { Authorization: 'Bearer goodToken', 'Content-Type': 'application/json' },
      { method: 'PATCH', body: { name: 'X' } },
    )
    expect(res.status).toBe(403)
  })

  it('admin deletes a table in another org and audits it', async () => {
    stubBackend({ validToken: 'goodToken', users: { u1: admin }, tables })
    const res = await call('/api/config/rates/rt1?organizationId=suite', { Authorization: 'Bearer goodToken' }, { method: 'DELETE' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; data: { deleted: boolean } }
    expect(body.data.deleted).toBe(true)
    expect(postedAudits).toHaveLength(1)
  })
})

describe('POST /api/config/rates/assign-client', () => {
  it('assigns a default rate and audits it', async () => {
    stubBackend({
      validToken: 'goodToken',
      users: { u1: admin },
      tables: {
        rate_tables: [
          { id: 'rt1', organization_id: 'hit', name: 'Regular', freight_type: 'AIR', created_at: '2026-08-14T00:00:00Z', updated_at: '2026-08-14T00:00:00Z', rate_rows: [] },
        ],
      },
    })
    const res = await call(
      '/api/config/rates/assign-client',
      { Authorization: 'Bearer goodToken', 'Content-Type': 'application/json' },
      { method: 'POST', body: { clientId: 'c1', rateTableId: 'rt1' } },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; data: { clientId: string; defaultRateId: string } }
    expect(body.data.clientId).toBe('c1')
    expect(body.data.defaultRateId).toBe('rt1')
    expect(postedAudits).toHaveLength(1)
    const audit = JSON.parse(postedAudits[0])[0] as { action: string; entity_type: string }
    expect(audit.action).toBe('client.default_rate.set')
    expect(audit.entity_type).toBe('billing_client')
  })
})

describe('POST /api/config/rates/override-package', () => {
  it('applies an override, stores the actor id (never the email), audits', async () => {
    stubBackend({
      validToken: 'goodToken',
      users: { u1: admin },
      tables: {
        packages: [{ id: 'p1', almacen_id: '123-ABC' }],
        rate_tables: [
          { id: 'rt1', organization_id: 'hit', name: 'Premium', freight_type: 'AIR', created_at: '2026-08-14T00:00:00Z', updated_at: '2026-08-14T00:00:00Z', rate_rows: [] },
        ],
      },
    })
    const res = await call(
      '/api/config/rates/override-package',
      { Authorization: 'Bearer goodToken', 'Content-Type': 'application/json' },
      { method: 'POST', body: { guia: '123-ABC', rateTableId: 'rt1' } },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; data: { packageId: string; guia: string } }
    expect(body.data.packageId).toBe('p1')
    expect(postedAudits).toHaveLength(1)
    const audit = JSON.parse(postedAudits[0])[0] as { action: string; entity_type: string }
    expect(audit.action).toBe('package.rate_override.set')
    expect(audit.entity_type).toBe('package')
  })

  it('404 for an unknown guia', async () => {
    stubBackend({ validToken: 'goodToken', users: { u1: admin }, tables: {} })
    const res = await call(
      '/api/config/rates/override-package',
      { Authorization: 'Bearer goodToken', 'Content-Type': 'application/json' },
      { method: 'POST', body: { guia: 'nope-1', rateTableId: null } },
    )
    expect(res.status).toBe(404)
  })
})

describe('GET /api/config/audit — read-only trail', () => {
  it('lists audit rows for the caller org', async () => {
    stubBackend({
      validToken: 'goodToken',
      users: { u1: admin },
      tables: {
        audit_logs: [
          { id: 'a1', organization_id: 'hit', actor_email: 'a@x.com', action: 'rate_table.create', created_at: '2026-08-14T00:00:00Z' },
        ],
      },
    })
    const res = await call('/api/config/audit?organizationId=hit', { Authorization: 'Bearer goodToken' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; data: { rows: unknown[] } }
    expect(body.ok).toBe(true)
    expect(body.data.rows).toHaveLength(1)
  })

  it('422 for a non-ISO date filter', async () => {
    stubBackend({ validToken: 'goodToken', users: { u1: admin }, tables: {} })
    const res = await call('/api/config/audit?from=not-a-date', { Authorization: 'Bearer goodToken' })
    expect(res.status).toBe(422)
  })
})
