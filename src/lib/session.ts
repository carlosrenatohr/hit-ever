import type { EverestSession, SessionCookie } from '../types/index.js'

// ─── Constants ────────────────────────────────────────────────────────────────
const SESSION_TTL_MS = 13 * 60 * 1000 // 13 minutes (Everest sessions ≈ 15 min)
const REDIS_KEY = 'everest:session:v1'

// ─── Client ───────────────────────────────────────────────────────────────────
/**
 * Minimal Upstash Redis HTTP client.
 * Uses the Upstash REST API so it works inside a Cloudflare Worker without
 * any Node.js native modules.
 */
export class UpstashRedisClient {
    constructor(
        private readonly url: string,
        private readonly token: string,
    ) { }

    async get<T>(key: string): Promise<T | null> {
        const res = await fetch(`${this.url}/get/${encodeURIComponent(key)}`, {
            headers: { Authorization: `Bearer ${this.token}` },
        })
        if (!res.ok) return null
        const { result } = (await res.json()) as { result: string | null }
        if (!result) return null
        try {
            return JSON.parse(result) as T
        } catch {
            return null
        }
    }

    async set(key: string, value: unknown, exSeconds?: number): Promise<void> {
        const body = exSeconds
            ? ['SET', key, JSON.stringify(value), 'EX', String(exSeconds)]
            : ['SET', key, JSON.stringify(value)]

        await fetch(`${this.url}/pipeline`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${this.token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify([body]),
        })
    }

    async del(key: string): Promise<void> {
        await fetch(`${this.url}/del/${encodeURIComponent(key)}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${this.token}` },
        })
    }
}

// ─── Session Store ────────────────────────────────────────────────────────────
/**
 * Session vault backed by Upstash Redis.
 * Stores, retrieves and invalidates Everest ASPSESSIONID cookies.
 */
export class SessionStore {
    private redis: UpstashRedisClient

    constructor(redisUrl: string, redisToken: string) {
        this.redis = new UpstashRedisClient(redisUrl, redisToken)
    }

    async get(): Promise<EverestSession | null> {
        const session = await this.redis.get<EverestSession>(REDIS_KEY)
        if (!session) return null
        if (Date.now() >= session.expiresAt) {
            await this.invalidate()
            return null
        }
        return session
    }

    async save(cookies: SessionCookie[]): Promise<EverestSession> {
        const now = Date.now()
        const session: EverestSession = {
            cookies,
            createdAt: now,
            expiresAt: now + SESSION_TTL_MS,
        }
        // TTL set to SESSION_TTL_MS / 1000 seconds on Redis side as well
        await this.redis.set(REDIS_KEY, session, Math.floor(SESSION_TTL_MS / 1000))
        return session
    }

    async invalidate(): Promise<void> {
        await this.redis.del(REDIS_KEY)
    }

    isExpired(session: EverestSession): boolean {
        return Date.now() >= session.expiresAt
    }

    /** How many ms remain on the current session */
    ttlMs(session: EverestSession): number {
        return Math.max(0, session.expiresAt - Date.now())
    }
}

/** Converts a plain cookie-jar array into a Cookie header string */
export function cookiesToHeader(cookies: SessionCookie[]): string {
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ')
}
