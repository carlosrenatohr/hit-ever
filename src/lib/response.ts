import type { Context } from 'hono'
import type { ApiError, ApiSuccess } from '../types/index.js'

// ─── Success ──────────────────────────────────────────────────────────────────
export function ok<T>(
    c: Context,
    data: T,
    meta?: ApiSuccess<T>['meta'],
    status: 200 | 201 | 202 = 200,
) {
    return c.json<ApiSuccess<T>>({ ok: true, data, ...(meta ? { meta } : {}) }, status)
}

// ─── Error ────────────────────────────────────────────────────────────────────
export function err(
    c: Context,
    code: string,
    message: string,
    status: 400 | 401 | 403 | 404 | 422 | 429 | 500 | 503 = 400,
    details?: unknown,
) {
    return c.json<ApiError>(
        { ok: false, error: { code, message, ...(details ? { details } : {}) } },
        status,
    )
}

// ─── Convenience aliases ──────────────────────────────────────────────────────
export const Res = { ok, err }
