// ─── Cloudflare Worker Bindings ───────────────────────────────────────────────
export interface CloudflareBindings {
    // Upstash Redis (via HTTP binding or env vars)
    UPSTASH_REDIS_URL: string
    UPSTASH_REDIS_TOKEN: string

    // Everest credentials
    EVEREST_USERNAME: string
    EVEREST_PASSWORD: string
    EVEREST_BASE_URL: string // https://everest.cargotrack.net

    // OpenAI (future: AI parsing)
    OPENAI_API_KEY: string

    // Cloudflare Browser Rendering (future binding)
    // BROWSER: Fetcher  // uncomment when Browser Rendering API is enabled
}

// ─── Session ──────────────────────────────────────────────────────────────────
export interface EverestSession {
    cookies: SessionCookie[]
    createdAt: number // unix ms
    expiresAt: number // unix ms (createdAt + 13 min)
}

export interface SessionCookie {
    name: string
    value: string
    domain: string
    path: string
    expires?: number
    httpOnly?: boolean
    secure?: boolean
}

// ─── Scraper Results ──────────────────────────────────────────────────────────
export interface ShipmentEvent {
    date: string       // "2025-01-20"
    time?: string      // "14:32"
    description: string
    location?: string
    status?: ShipmentStatus
}

export type ShipmentStatus =
    | 'received'
    | 'in_transit'
    | 'at_warehouse'
    | 'out_for_delivery'
    | 'delivered'
    | 'exception'
    | 'unknown'

export interface ShipmentData {
    trackingId: string       // guía / almacén number (e.g. "852786")
    warehouseId?: string
    weight?: string          // "3.20 lbs"
    description?: string
    origin?: string
    destination?: string
    status: ShipmentStatus
    events: ShipmentEvent[]
    rawHtml?: string         // for AI parsing upstream (optional, never sent to client)
    scrapedAt: number        // unix ms
}

// ─── API Response Shapes ──────────────────────────────────────────────────────
export interface ApiSuccess<T = unknown> {
    ok: true
    data: T
    meta?: {
        cachedAt?: number
        scrapedAt?: number
        latencyMs?: number
    }
}

export interface ApiError {
    ok: false
    error: {
        code: string
        message: string
        details?: unknown
    }
}

export type ApiResponse<T = unknown> = ApiSuccess<T> | ApiError
