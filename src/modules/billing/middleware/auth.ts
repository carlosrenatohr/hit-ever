// ============================================================================
// Billing auth middleware — verifies the panel user's InsForge session and gates
// on a reserved permission string.
// ============================================================================
// The panel is a browser SPA signed in with InsForge Auth; it sends the user's
// access token as `Authorization: Bearer <jwt>`. Billing endpoints expose money,
// so every route is gated. Two steps:
//
//   1. Validate the token by delegating to InsForge:
//      GET /api/auth/sessions/current  -> { user: { id, email, ... } }
//      (We do not hold the JWT signing secret in the Worker, so we let InsForge
//       verify the signature/expiry. One extra subrequest per call; acceptable.)
//   2. Resolve the caller's role from `app_users` using the Worker's admin key
//      (RLS bypass), then map role -> permissions.
//
// Roles that actually exist today: admin | staff | viewer (staff_role enum). The
// concrete billing-specific roles/permissions are future work (see the plan's
// Stage 6 and the feat/clerk-acl `module:action` precedent). We reserve the
// permission strings now so wiring them later is a config change, not a refactor.

import type { Context, MiddlewareHandler } from 'hono'
import { Res } from '../../../lib/response.js'
import type { CloudflareBindings } from '../../../types/index.js'

export type BillingRole = 'admin' | 'billing' | 'staff' | 'viewer'
export type BillingPermission = 'invoices:read' | 'invoices:write' | 'clients:read' | 'clients:write'

export interface BillingSession {
  userId: string
  email: string | null
  name: string | null
  role: BillingRole
  agency: string
}

// Permission map. `billing` is the dedicated billing role; `admin` is superuser;
// `staff` (ops) gets read-only billing; `viewer` has none. Handlers only ask for a
// permission, never a role, so this is the single place to retune access.
const ROLE_PERMISSIONS: Record<BillingRole, BillingPermission[]> = {
  admin: ['invoices:read', 'invoices:write', 'clients:read', 'clients:write'],
  billing: ['invoices:read', 'invoices:write', 'clients:read', 'clients:write'],
  staff: ['invoices:read', 'clients:read'],
  viewer: [],
}

export function roleHasPermission(role: BillingRole, permission: BillingPermission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false
}

/** Hono `Variables` contract so handlers can read the authenticated session. */
export type BillingEnv = {
  Bindings: CloudflareBindings
  Variables: { billingSession: BillingSession }
}

type SessionResult =
  | { ok: true; session: BillingSession }
  | { ok: false; code: string; message: string; status: 401 | 403 | 503 }

function bearer(c: Context): string | null {
  const h = c.req.header('Authorization') ?? ''
  const m = /^Bearer\s+(.+)$/i.exec(h)
  return m ? m[1].trim() : null
}

/**
 * Validate the caller's token and resolve their role. Kept as a standalone async
 * function (not inline in the middleware) so it can be unit-tested with a stubbed
 * `fetch`. Never throws for auth failures — returns a typed result instead.
 */
export async function resolveBillingSession(env: CloudflareBindings, token: string): Promise<SessionResult> {
  if (!env.INSFORGE_API_URL || !env.INSFORGE_API_KEY) {
    return { ok: false, code: 'BILLING_UNCONFIGURED', message: 'InsForge is not configured.', status: 503 }
  }
  const apiUrl = env.INSFORGE_API_URL.replace(/\/$/, '')

  // 1. Delegate token verification to InsForge.
  let whoRes: Response
  try {
    whoRes = await fetch(`${apiUrl}/api/auth/sessions/current`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  } catch {
    return { ok: false, code: 'AUTH_UPSTREAM', message: 'Could not reach the auth service.', status: 503 }
  }
  if (whoRes.status === 401 || whoRes.status === 403) {
    return { ok: false, code: 'UNAUTHORIZED', message: 'Invalid or expired session.', status: 401 }
  }
  if (!whoRes.ok) {
    return { ok: false, code: 'AUTH_UPSTREAM', message: `Auth service returned ${whoRes.status}.`, status: 503 }
  }
  const whoBody = (await whoRes.json().catch(() => null)) as { user?: { id?: string; email?: string }; data?: { user?: { id?: string; email?: string } } } | null
  const user = whoBody?.user ?? whoBody?.data?.user
  if (!user?.id) {
    return { ok: false, code: 'UNAUTHORIZED', message: 'Session has no user.', status: 401 }
  }

  // 2. Resolve the role from app_users using the admin key (RLS bypass).
  let rowsRes: Response
  try {
    rowsRes = await fetch(
      `${apiUrl}/api/database/records/app_users?id=eq.${encodeURIComponent(user.id)}&select=role,active,name,email,agency&limit=1`,
      { headers: { Authorization: `Bearer ${env.INSFORGE_API_KEY}`, 'Content-Type': 'application/json' } },
    )
  } catch {
    return { ok: false, code: 'AUTH_UPSTREAM', message: 'Could not reach the database.', status: 503 }
  }
  if (!rowsRes.ok) {
    return { ok: false, code: 'AUTH_UPSTREAM', message: `Role lookup returned ${rowsRes.status}.`, status: 503 }
  }
  const rows = (await rowsRes.json().catch(() => [])) as Array<{ role?: string; active?: boolean; name?: string | null; email?: string | null; agency?: string | null }>
  const row = rows[0]
  if (!row || row.active === false) {
    return { ok: false, code: 'FORBIDDEN', message: 'Account is not an active staff member.', status: 403 }
  }
  const role = row.role as BillingRole
  if (!ROLE_PERMISSIONS[role]) {
    return { ok: false, code: 'FORBIDDEN', message: `Role "${row.role}" has no billing access.`, status: 403 }
  }

  return {
    ok: true,
    session: { userId: user.id, email: row.email ?? user.email ?? null, name: row.name ?? null, role, agency: row.agency ?? 'hit' },
  }
}

/**
 * Middleware factory. Usage: `router.use('*', billingAuth('invoices:read'))` then
 * tighten writes with `router.post('/invoices', billingAuth('invoices:write'), ...)`.
 * On success the session is stashed at `c.get('billingSession')`.
 */
export function billingAuth(permission: BillingPermission): MiddlewareHandler<BillingEnv> {
  return async (c, next) => {
    const token = bearer(c)
    if (!token) {
      return Res.err(c, 'UNAUTHORIZED', 'Missing bearer token.', 401)
    }
    const result = await resolveBillingSession(c.env, token)
    if (!result.ok) {
      return Res.err(c, result.code, result.message, result.status)
    }
    if (!roleHasPermission(result.session.role, permission)) {
      return Res.err(c, 'FORBIDDEN', `Requires permission "${permission}".`, 403)
    }
    c.set('billingSession', result.session)
    await next()
  }
}
