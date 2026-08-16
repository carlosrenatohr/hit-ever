// ============================================================================
// Photo proxy — GET /api/photo?url=<provider photo>
// ============================================================================
// The panel renders package photos directly from the provider host
// (gc/everest.cargotrack.net), but its strict CSP (img-src) blocks those
// third-party hosts. Instead of widening the CSP, the panel fetches the photo
// through this authenticated route and displays the result as a blob URL.
//
// Security posture:
//  - Staff gate: only authenticated staff (admin/billing/staff) may proxy —
//    viewers and anonymous callers get 401/403. Same contract as /api/config.
//  - SSRF guard: the ?url= is validated against an allowlist (provider host +
//    /items/ photo path only), so this can never be used to fetch an arbitrary
//    host. The raw URL already sits in our own DB (photo_ref), so it is not a
//    secret in the query string — but the route still refuses non-provider URLs.
//  - The upstream fetch is cached at the Cloudflare edge (cacheTtl) so repeated
//    panel views don't hammer Cargotrack.

import { Hono } from 'hono'
import { Res } from '../lib/response.js'
import { configAuth, type ConfigEnv } from '../modules/config/middleware/auth.js'

// Only Cargotrack's photo files — never an arbitrary URL (SSRF guard).
const PHOTO_SRC_RE = /^https:\/\/(gc|everest)\.cargotrack\.net\/items\/[A-Za-z0-9_./-]+$/

const photo = new Hono<ConfigEnv>()

photo.get('/', configAuth('rates:read'), async (c) => {
  const url = c.req.query('url')
  if (!url || !PHOTO_SRC_RE.test(url)) {
    return Res.err(c, 'INVALID_PHOTO_URL', 'Photo URL is not an allowed provider image.', 422)
  }
  try {
    // Cache at the edge for a day — photos are immutable and stable per package.
    const upstream = await fetch(url, { cf: { cacheTtl: 86400, cacheEverything: true } } as RequestInit)
    if (!upstream.ok) {
      return Res.err(c, 'PHOTO_UPSTREAM', `Provider returned ${upstream.status}.`, 503)
    }
    const contentType = upstream.headers.get('content-type') ?? 'image/jpeg'
    const headers = new Headers()
    headers.set('content-type', contentType)
    headers.set('cache-control', 'public, max-age=86400')
    return new Response(upstream.body, { status: 200, headers })
  } catch {
    return Res.err(c, 'PHOTO_UPSTREAM', 'Could not reach the provider image.', 503)
  }
})

export { photo as photoRouter }
