import { parseEverestHtml, parseWithAI } from '../lib/parser.js'
import { SessionStore, cookiesToHeader } from '../lib/session.js'
import type { CloudflareBindings, EverestSession, SessionCookie, ShipmentData } from '../types/index.js'

// ─── Constants ────────────────────────────────────────────────────────────────
const LOGIN_PATH = '/default.asp'
const TRACK_PATH = '/almacen.asp'          // guessed – verify against live site

// ─── Scraper Service ──────────────────────────────────────────────────────────
/**
 * EverestScraperService
 *
 * Handles:
 *  1. Login to everest.cargotrack.net  (form POST to /default.asp)
 *  2. Session management via Upstash Redis (SessionStore)
 *  3. Fetching tracking pages with injected session cookies
 *  4. Parsing the response HTML into structured ShipmentData
 *
 * NOTE: This service is intentionally designed for Cloudflare Workers –
 * all HTTP is done via the Workers `fetch` API (no puppeteer/playwright here).
 * Playwright runs OUTSIDE the Worker (as a separate Node.js process or
 * Cloudflare Browser Rendering) and its output is fed back here.
 */
export class EverestScraperService {
    private store: SessionStore
    private baseUrl: string
    private username: string
    private password: string
    private openaiKey?: string

    constructor(env: CloudflareBindings) {
        this.store = new SessionStore(env.UPSTASH_REDIS_URL, env.UPSTASH_REDIS_TOKEN)
        this.baseUrl = (env.EVEREST_BASE_URL ?? 'https://everest.cargotrack.net').replace(/\/$/, '')
        this.username = env.EVEREST_USERNAME
        this.password = env.EVEREST_PASSWORD
        this.openaiKey = env.OPENAI_API_KEY
    }

    // ─── Public API ─────────────────────────────────────────────────────────────

    /**
     * Returns a valid session, either from cache or by logging in fresh.
     */
    async getSession(): Promise<EverestSession> {
        const cached = await this.store.get()
        if (cached) return cached
        return this.login()
    }

    /**
     * Fetches tracking data for the given ID.
     * Automatically refreshes the session if expired.
     */
    async track(trackingId: string): Promise<ShipmentData | null> {
        const session = await this.getSession()

        const html = await this.fetchTrackingPage(trackingId, session)
        if (!html) return null

        // 1. Try regex/structural parser first (fast, free)
        const parsed = parseEverestHtml(html, trackingId)
        if (parsed) return parsed

        // 2. Fall back to AI parsing if OpenAI key is available
        if (this.openaiKey) {
            return parseWithAI(html, this.openaiKey)
        }

        return null
    }

    /**
     * Forces a fresh login and stores the new session.
     * Useful for manual cache-bust via admin endpoint.
     */
    async refreshSession(): Promise<EverestSession> {
        await this.store.invalidate()
        return this.login()
    }

    // ─── Private helpers ────────────────────────────────────────────────────────

    /**
     * Performs the login flow against the Classic ASP form.
     *
     * Everest uses a simple HTML form POST. The response sets an
     * ASPSESSIONID cookie which we store in Redis.
     *
     * NOTE: When Playwright is integrated, this method will be replaced by
     * a call to the Browser Rendering endpoint. The cookie extraction logic
     * (extractCookies) stays the same.
     */
    private async login(): Promise<EverestSession> {
        const loginUrl = `${this.baseUrl}${LOGIN_PATH}`

        const formBody = new URLSearchParams({
            // Adjust field names to match the actual Everest login form
            // (inspect default.asp source or use Playwright to record the flow)
            txtUser: this.username,
            txtPassword: this.password,
            btnLogin: 'Entrar',
        })

        const response = await fetch(loginUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                    '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                Referer: loginUrl,
                Origin: this.baseUrl,
            },
            body: formBody.toString(),
            redirect: 'manual', // catch the redirect to grab Set-Cookie
        })

        const cookies = this.extractCookies(response.headers)

        if (cookies.length === 0) {
            throw new Error(
                `Login to Everest failed – no cookies received. ` +
                `Status: ${response.status}. Verify credentials or form field names.`,
            )
        }

        return this.store.save(cookies)
    }

    /**
     * Fetches the tracking/shipment page for a given ID.
     * Returns the raw HTML string, or null on network failure.
     *
     * If the response status is 302 (session expired redirect),
     * we invalidate the session and retry once.
     */
    private async fetchTrackingPage(
        trackingId: string,
        session: EverestSession,
        retried = false,
    ): Promise<string | null> {
        const trackUrl = `${this.baseUrl}${TRACK_PATH}?id=${encodeURIComponent(trackingId)}`

        const response = await fetch(trackUrl, {
            headers: {
                Cookie: cookiesToHeader(session.cookies),
                'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                    '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                Referer: `${this.baseUrl}/`,
            },
            redirect: 'manual',
        })

        // Session expired – Everest redirects back to login
        if ((response.status === 302 || response.status === 301) && !retried) {
            const fresh = await this.refreshSession()
            return this.fetchTrackingPage(trackingId, fresh, true)
        }

        if (!response.ok && response.status !== 200) return null

        return response.text()
    }

    /**
     * Extracts Set-Cookie headers into a typed SessionCookie array.
     */
    private extractCookies(headers: Headers): SessionCookie[] {
        const rawCookies = headers.getSetCookie?.() ?? []

        // Fallback for older runtimes that don't have getSetCookie()
        if (rawCookies.length === 0) {
            const single = headers.get('set-cookie')
            if (single) rawCookies.push(single)
        }

        return rawCookies.map((raw) => this.parseCookieString(raw))
    }

    private parseCookieString(raw: string): SessionCookie {
        const parts = raw.split(';').map((p) => p.trim())
        const [nameVal, ...attrs] = parts
        const eqIdx = (nameVal ?? '').indexOf('=')
        const name = nameVal?.slice(0, eqIdx) ?? ''
        const value = nameVal?.slice(eqIdx + 1) ?? ''

        const cookie: SessionCookie = {
            name,
            value,
            domain: this.baseUrl,
            path: '/',
        }

        for (const attr of attrs) {
            const lower = attr.toLowerCase()
            if (lower === 'httponly') cookie.httpOnly = true
            else if (lower === 'secure') cookie.secure = true
            else if (lower.startsWith('path=')) cookie.path = attr.slice(5)
            else if (lower.startsWith('domain=')) cookie.domain = attr.slice(7)
            else if (lower.startsWith('expires=')) {
                cookie.expires = Date.parse(attr.slice(8))
            }
        }

        return cookie
    }
}
