import { describe, expect, it } from 'vitest'
import worker from '../index.js'

// Minimal stubs: malformed ids fail Zod validation BEFORE the handler runs,
// so the repository / rate limiter (and thus env) are never touched.
const ctx = { waitUntil() {}, passThroughOnException() {} }
function get(path: string): Promise<Response> {
    return worker.fetch(new Request(`https://t.test${path}`), {} as never, ctx as never)
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
