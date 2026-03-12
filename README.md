# hit-ever-scraper

> **Cloudflare Worker • Hono API** — Everest CargoTrack silent scraper for [Hit Cargo](https://hitcargo.com).

Microservice that scrapes `everest.cargotrack.net` (Classic ASP) and exposes a clean REST API for shipment tracking. Powers the dynamic tracking form on the Hit Cargo Astro website.

---

## Architecture

```
Astro Website
     │
     │  GET /track/:id
     ▼
Cloudflare Worker  (this repo)
  ├─ Hono API  ──────────────────── routes/track.ts
  ├─ Session Store ──────────────── Upstash Redis (via REST)
  └─ Scraper Service ────────────── services/scraper.ts
         │
         │  fetch() with ASPSESSIONID cookies
         ▼
  everest.cargotrack.net
  (Classic ASP logistics system)
```

**Future path**: Replace `fetch()` scraping with **Cloudflare Browser Rendering** + Playwright for full JS-rendered pages.

---

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | API root / info |
| `GET` | `/track/:id` | Fetch shipment tracking data |
| `GET` | `/admin/health` | Health check |
| `POST` | `/admin/session/refresh` | Force fresh Everest login |

### Example response — `GET /track/852786`

```json
{
  "ok": true,
  "data": {
    "trackingId": "852786",
    "status": "at_warehouse",
    "weight": "3.20 lbs",
    "events": [
      { "date": "20/01/2025", "time": "14:32", "description": "Ingreso a almacén Miami", "status": "at_warehouse" }
    ],
    "scrapedAt": 1741780000000
  },
  "meta": {
    "scrapedAt": 1741780000000,
    "latencyMs": 1240
  }
}
```

---

## Local Development

### 1. Install dependencies

```bash
pnpm install
```

### 2. Configure secrets

```bash
cp .dev.vars.example .dev.vars
# then fill in your Everest credentials, Upstash Redis, etc.
```

### 3. Run dev server

```bash
pnpm dev
# → http://localhost:8787
```

### 4. Test endpoints

```bash
# Health check
curl http://localhost:8787/admin/health

# Track a shipment (requires valid Everest session)
curl http://localhost:8787/track/852786

# Force session refresh
curl -X POST http://localhost:8787/admin/session/refresh \
  -H "Content-Type: application/json" \
  -d '{"secret":"your-admin-secret"}'
```

---

## Deployment

### Set secrets in Cloudflare

```bash
wrangler secret put EVEREST_USERNAME
wrangler secret put EVEREST_PASSWORD
wrangler secret put UPSTASH_REDIS_URL
wrangler secret put UPSTASH_REDIS_TOKEN
wrangler secret put OPENAI_API_KEY     # optional
wrangler secret put ADMIN_SECRET
```

### Deploy

```bash
pnpm deploy
```

### Generate TypeScript bindings

```bash
pnpm cf-typegen
```

---

## Project Structure

```
src/
├── index.ts              # Hono app + middleware (CORS, logger, timing, headers)
├── types/
│   └── index.ts          # Shared TypeScript interfaces
├── lib/
│   ├── response.ts       # Typed API response helpers (Res.ok / Res.err)
│   ├── session.ts        # Upstash Redis client + SessionStore
│   └── parser.ts         # Regex HTML parser + GPT-4o-mini AI fallback
├── services/
│   └── scraper.ts        # EverestScraperService (login, fetch, parse)
└── routes/
    ├── track.ts           # GET /track/:id
    └── admin.ts           # GET /admin/health, POST /admin/session/refresh

docs/
├── everest-scraper-plan.md   # Architecture & roadmap
└── playwright-plan.md        # Playwright integration guide + checklist
```

---

## Roadmap

- [x] **v1.0.0** — Hono API scaffold, SessionStore, regex parser, AI parser stub
- [ ] **v1.1.0** — Playwright login script (external) + `/admin/session/refresh` integration
- [ ] **v1.2.0** — Tune regex parser from real HTML samples
- [ ] **v1.3.0** — Cloudflare Browser Rendering (replace external Playwright)
- [ ] **v2.0.0** — Supabase integration (shipment history, client portal)

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Cloudflare Workers |
| Framework | [Hono](https://hono.dev) v4 |
| Validation | [Zod](https://zod.dev) + `@hono/zod-validator` |
| Session Cache | [Upstash Redis](https://upstash.com) (HTTP REST) |
| Future Scraping | Cloudflare Browser Rendering + Playwright |
| Future AI Parsing | GPT-4o-mini |
| Future Persistence | Supabase PostgreSQL |
