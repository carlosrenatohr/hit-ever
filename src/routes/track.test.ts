import { describe, expect, it } from 'vitest'
import worker from '../index.js'
import { resolveTrackOrg } from './track.js'

// Minimal stubs: malformed ids fail Zod validation BEFORE the handler runs,
// so the repository / rate limiter (and thus env) are never touched.
const ctx = { waitUntil() {}, passThroughOnException() {} }
function get(path: string): Promise<Response> {
    return Promise.resolve(worker.fetch(new Request(`https://t.test${path}`), {} as never, ctx as never))
}

describe('GET /track/:id — param validation', () => {
    // Regression: Zod v4 renamed `.errors` → `.issues`. Reading `result.error.errors[0]`
    // threw a TypeError that the global onError swallowed into a 500, so malformed ids
    // returned 500 INTERNAL_ERROR instead of the documented 422 INVALID_PARAM
    // (see docs/e2e-testing.md §1.3.3). This locks the contract.
    it('rejects a malformed id with 422 INVALID_PARAM, not 500', async () => {
        const res = await get('/track/abc%20123')
        expect(res.status).toBe(422)
        const body = (await res.json()) as { ok: boolean; error: { code: string } }
        expect(body.ok).toBe(false)
        expect(body.error.code).toBe('INVALID_PARAM')
    })
})

describe('resolveTrackOrg — tenant del track público (ADR-013)', () => {
    it('prefiere ?org= sobre el env', () => {
        expect(resolveTrackOrg('orbit', 'hit')).toBe('orbit')
    })

    it('cae al env y después al default hit', () => {
        expect(resolveTrackOrg(undefined, 'suite')).toBe('suite')
        expect(resolveTrackOrg('', undefined)).toBe('hit')
        expect(resolveTrackOrg(undefined, undefined)).toBe('hit')
    })

    it('rechaza un ?org= malformado (ruta 422)', () => {
        expect(resolveTrackOrg('no es slug', 'hit')).toBeNull()
        expect(resolveTrackOrg('../etc', 'hit')).toBeNull()
        expect(resolveTrackOrg('ORG!', 'hit')).toBeNull()
    })

    it('un env malformado no tumba el endpoint: cae a hit', () => {
        expect(resolveTrackOrg(undefined, 'no es slug')).toBe('hit')
    })
})

describe('GET /track/:id — tenant scope (ADR-013)', () => {
    it('rejects a malformed ?org with 422 INVALID_ORG before touching the repo', async () => {
        const res = await get('/track/926791?org=no%20es%20slug')
        expect(res.status).toBe(422)
        const body = (await res.json()) as { ok: boolean; error: { code: string } }
        expect(body.ok).toBe(false)
        expect(body.error.code).toBe('INVALID_ORG')
    })

    it('serves the demo guía with a valid ?org (fail-open rate limit, in-memory repo)', async () => {
        const res = await get('/track/926791?org=hit')
        expect(res.status).toBe(200)
    })
})
