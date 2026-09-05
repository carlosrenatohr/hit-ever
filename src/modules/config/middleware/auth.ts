// ============================================================================
// Config auth middleware — gates /api/config on the caller's InsForge session.
// ============================================================================
// Same contract as the billing module (src/modules/billing/middleware/auth.ts):
// validate the panel user's token by delegating to InsForge, then resolve the
// role AND the agency from app_users using the Worker admin key (RLS bypass).
// The agency (organization_id) always comes from the session — never from the
// payload (ADR-009). Permission strings are reserved so wiring changes are a
// config tweak, not a refactor.

import type { Context, MiddlewareHandler } from 'hono'
import { Res } from '../../../lib/response.js'
import type { CloudflareBindings } from '../../../types/index.js'

export type ConfigRole = 'admin' | 'billing' | 'staff' | 'viewer'
export type ConfigPermission = 'config:read' | 'config:write' | 'rates:read' | 'rates:write' | 'audit:read'

export interface ConfigSession {
  userId: string
  email: string | null
  name: string | null
  role: ConfigRole
  agency: string
}

// Matrix: admin/billing write everything, staff reads config+rates+audit,
// viewer has none. Handlers only ask for a permission, never a role.
const ROLE_PERMISSIONS: Record<ConfigRole, ConfigPermission[]> = {
  admin: ['config:read', 'config:write', 'rates:read', 'rates:write', 'audit:read'],
  billing: ['config:read', 'config:write', 'rates:read', 'rates:write', 'audit:read'],
  staff: ['config:read', 'rates:read', 'audit:read'],
  viewer: [],
}

export function roleHasPermission(role: ConfigRole, permission: ConfigPermission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false
}

/** Hono `Variables` contract so handlers can read the authenticated session. */
export type ConfigEnv = {
  Bindings: CloudflareBindings
  Variables: { configSession: ConfigSession; requestId: string }
}

type SessionResult =
  | { ok: true; session: ConfigSession }
  | { ok: false; code: string; message: string; status: 401 | 403 | 503 }

function bearer(c: Context): string | null {
  const h = c.req.header('Authorization') ?? ''
  const m = /^Bearer\s+(.+)$/i.exec(h)
  return m ? m[1].trim() : null
}

/**
 * Validate the caller's token and resolve role + agency. Standalone async
 * function (not inline) so it can be unit-tested with a stubbed `fetch`.
 * Never throws for auth failures — returns a typed result instead.
 */
export async function resolveConfigSession(env: CloudflareBindings, token: string): Promise<SessionResult> {
  if (!env.INSFORGE_API_URL || !env.INSFORGE_API_KEY) {
    return { ok: false, code: 'CONFIG_UNCONFIGURED', message: 'InsForge is not configured.', status: 503 }
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

  // 2. Resolve role + agency from app_users using the admin key (RLS bypass).
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
  const role = row.role as ConfigRole
  if (!ROLE_PERMISSIONS[role]) {
    return { ok: false, code: 'FORBIDDEN', message: `Role "${row.role}" has no config access.`, status: 403 }
  }

  return {
    ok: true,
    session: {
      userId: user.id,
      email: row.email ?? user.email ?? null,
      name: row.name ?? null,
      role,
      // app_users.agency is NOT NULL FK → agencies.slug: no fallback — a missing
      // value must surface as an error, never silently resolve to another tenant.
      agency: row.agency as string,
    },
  }
}

/**
 * Middleware factory. Usage: `router.use('*', configAuth('rates:read'))` then
 * tighten writes with `router.post('/rates', configAuth('rates:write'), ...)`.
 * On success the session is stashed at `c.get('configSession')`.
 */
export function configAuth(permission: ConfigPermission): MiddlewareHandler<ConfigEnv> {
  return async (c, next) => {
    const token = bearer(c)
    if (!token) {
      return Res.err(c, 'UNAUTHORIZED', 'Missing bearer token.', 401)
    }
    const result = await resolveConfigSession(c.env, token)
    if (!result.ok) {
      return Res.err(c, result.code, result.message, result.status)
    }
    if (!roleHasPermission(result.session.role, permission)) {
      return Res.err(c, 'FORBIDDEN', `Requires permission "${permission}".`, 403)
    }
    c.set('configSession', result.session)
    await next()
  }
}
