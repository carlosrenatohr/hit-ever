# hit-ever

Tracking API for [Hit Cargo](https://hit-cargo.com), a logistics business moving packages between the US and Nicaragua.

It runs on Cloudflare Workers at the edge and serves package tracking to the public site as a fast database read — never a live scrape on request. A background pipeline keeps that database fresh by pulling from two upstream carrier systems, one of them a Classic ASP portal that only allows a single active session at a time. That constraint, plus the Workers runtime, shaped most of the interesting decisions here: a repository interface you can swap for an in-memory seed to run the whole API with zero external services, a single response envelope, and a `pnpm check` gate wired into CI.

For the full request/response catalog (every endpoint, every status code, curl + Postman), see **[docs/e2e-testing.md](docs/e2e-testing.md)** — the source of truth for the API contract.

---

## Architecture

```
Astro site ──GET /track/:guia──▶ Worker ──read──▶ InsForge (Postgres)
                                    ▲                  ▲    ▲
                                    │ write            │    │ read (per-user JWT + RLS)
                       Ingestion (background) ─────────┘    │
                         ├─ cron, staggered per provider    hit-panel (internal dashboard)
                         ├─ email hook  /hooks/provider-email
                         └─ manual      POST /admin/ingest
                                    │ scrape (login + list + detail)
                                    ▼
                       Upstream carrier portals (Classic ASP)
                       ├─ Provider A (mailbox-filtered)
                       └─ Provider B (dedicated account)
```

The site reads InsForge through the Worker, never the carrier portals directly, so a public lookup is a fast DB read with no live login involved. The internal panel (`hit-panel`, a separate repo) talks to InsForge directly instead of going through the Worker — it authenticates each staff member with their own InsForge account and relies on row-level security to decide what they can see and change, rather than the Worker's single admin API key.

The upstream tolerates only one active session per account, so all scraping — cron, the email hook, and manual backfills — funnels through one cached login and stays throttled. Running several ingestion requests at once just evicts each other's sessions; there's no way to speed this up by parallelizing.

---

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | — | API root / info |
| `GET` | `/track/:id` | public | Public tracking. Minimal payload from InsForge (no PII/mailbox/value/photo). `200 / 404 / 422 / 429 / 503`. |
| `GET` | `/admin/health` | — | Health check (`environment: configured \| missing-env`) |
| `POST` | `/admin/ingest` | Bearer | Run ingestion. `?pages=N&days=D` or chunked `?offset=N&days=D`. |
| `POST` | `/admin/packages/:guia/status` | Bearer | Manual status override (wins over scraped). |
| `POST` | `/admin/packages/:guia/tags` | Bearer | Internal tag (not exposed publicly). |
| `POST` | `/admin/packages/:guia/notes` | Bearer | Internal note (not exposed publicly). |
| `POST` | `/hooks/provider-email` | `X-Hook-Secret` | Re-scrape one package from a provider update email. |

Bearer = `Authorization: Bearer <ADMIN_SECRET>`. Cloudflare Email Routing also delivers the carrier update email straight to the Worker's `email()` handler (same re-scrape path).

### Response envelope

All responses share one envelope. Add `?pretty=1` for indented JSON.

- Success: `{ "ok": true, "data": { … }, "meta"?: { "cachedAt"?, "latencyMs"? } }`
- Error: `{ "ok": false, "error": { "code": "…", "message": "…" } }`

### `GET /track/:guia` — `data` is a `PublicShipment`

```json
{
  "ok": true,
  "data": {
    "guia": "100200",
    "status": "en_transito",
    "statusLabel": "En camino",
    "step": 2,
    "serviceType": "aereo",
    "weightLb": 2.75,
    "pieces": 1,
    "receivedAt": "2026-06-12T14:31:00Z",
    "lastEventAt": "2026-06-12T14:31:00Z",
    "events": [{ "date": "2026-06-12T14:31:00Z", "description": "Recibido", "office": "MIA" }]
  },
  "meta": { "cachedAt": 1749731460000, "latencyMs": 42 }
}
```

`status` (internal enum): `en_almacen | parcial | en_transito | en_destino | entregado | excepcion | desconocido`. `statusLabel` is the Spanish user label and `step` (1..4, `0` for excepción/desconocido) drives the site's 4-step bar (Miami → En tránsito → Nicaragua → Entregado). A manual override (`/admin/packages/:guia/status`) wins over the scraped status. Full status/label/step mapping and the `404`/`422` cases are in [docs/e2e-testing.md](docs/e2e-testing.md).

---

## Local development

```bash
pnpm install
cp .dev.vars.example .dev.vars   # fill in secrets (see below)
pnpm dev                          # → http://localhost:8787
```

**Demo mode:** leave `INSFORGE_API_URL` empty and the Worker falls back to an in-memory repository seeded with sample data — `/track` works with zero external services, handy for UI work.

```bash
curl http://localhost:8787/admin/health
curl "http://localhost:8787/track/100200?pretty=1"
```

### Test & gate

```bash
pnpm test     # vitest (parser fixtures + route validation)
pnpm check    # gate: vitest + `wrangler deploy --dry-run` (the CI merge gate)
```

---

## Deployment

Secrets are Cloudflare secrets (`wrangler secret put <KEY>`):

```bash
wrangler secret put INSFORGE_API_URL
wrangler secret put INSFORGE_API_KEY     # admin key — server only, never in the site
wrangler secret put PROVIDER_A_USERNAME
wrangler secret put PROVIDER_A_PASSWORD
wrangler secret put PROVIDER_B_USERNAME
wrangler secret put PROVIDER_B_PASSWORD
wrangler secret put UPSTASH_REDIS_URL
wrangler secret put UPSTASH_REDIS_TOKEN
wrangler secret put ADMIN_SECRET         # Bearer for /admin/* and /hooks/*
```

```bash
pnpm run deploy   # wrangler deploy --minify   (note: `pnpm deploy` collides with pnpm's builtin)
pnpm cf-typegen   # regenerate CloudflareBindings types
```

Two cron schedules run as a backstop (the email hook is the primary freshness mechanism): one refreshes each provider on its own staggered tick. They're split on purpose — one provider has no mailbox filter, so it opens a detail page per row, and running both in a single invocation blows past the Workers free-plan subrequest limit.

The base schema lives in `db/*.sql`; everything added for the internal dashboard (staff roles, RLS policies, the write RPCs, the `effective_status` column) is in `migrations/*.sql`, applied with `npx @insforge/cli db migrations up --all` against the linked InsForge project.

---

## Upstream scraping — engineering notes

The carrier portals are Classic ASP apps, which forced a few non-obvious decisions:

- **Cookies across redirects.** Login goes through a redirect chain, and the Workers `fetch` runtime doesn't carry cookies across redirects the way a browser does — so the Worker walks the chain manually and accumulates the session cookies itself.
- **One session per account.** The upstream tolerates a single live session at a time, so every ingestion path (cron, email hook, manual backfill) funnels through one cached login and stays serialized. Concurrent logins just evict each other, so parallelizing is a non-starter. Sessions are short-lived and cached in Upstash.
- **Pagination is a ledger, not a feed.** One provider exposes a persistent, deep history you can page back through; the other caps at a small window regardless of offset. Backfills are just walking pagination against a known date range rather than guessing.

---

## Project structure

```
src/
├── index.ts                 # Hono app + middleware; fetch/scheduled(cron)/email handlers
├── types/
│   ├── tracking.ts          # domain types + toPublicShipment() + status mapping
│   └── index.ts             # CloudflareBindings
├── lib/
│   ├── repository.ts        # TrackingRepository interface; InsforgeClient + in-memory demo
│   ├── insforge.ts          # InsForge (PostgREST-style) client
│   ├── cargotrack.ts        # login + list/detail HTML parsers + mailbox filter
│   ├── response.ts          # Res.ok / Res.err envelope helpers
│   ├── ratelimit.ts         # per-IP rate limit (Upstash; fails open)
│   ├── session.ts           # Upstash session cache
│   └── parser.ts            # aux parser helpers
├── services/
│   ├── ingest.ts            # IngestService: scrape → filter → upsert (chunked + batched)
│   └── scraper.ts           # fetch/login orchestration
└── routes/
    ├── track.ts             # GET /track/:id  (+ route validation test)
    ├── admin.ts             # /admin/health, /admin/ingest, /admin/packages/:guia/*
    └── hooks.ts             # POST /hooks/provider-email

db/         base InsForge schema
migrations/ staff roles, RLS, RPCs for hit-panel
fixtures/   captured HTML for parser tests
docs/       e2e-testing.md — API contract
```

---

## Roadmap

- [x] Public tracking API reading from InsForge (live, real data)
- [x] Multi-provider ingestion — chunked, batched, strict mailbox filter
- [x] Admin tools: manual status override, tags, notes
- [x] Email trigger (Cloudflare Email Routing + `/hooks/provider-email`) re-scrape
- [x] Delivery gate (`pnpm check` + CI on PR)
- [x] Second provider backfilled and ingesting on its own cron tick
- [x] Historical backfill to January 2026
- [x] Internal dashboard (`hit-panel`) reading InsForge directly via per-user auth + RLS
- [ ] Email-trigger bridge wired (Make.com → `/hooks/provider-email`)
- [ ] Custom API domain `api.hit-cargo.com` (currently `*.workers.dev`)
- [ ] Write notes back upstream + HIT's own notes / billing custom fields
- [ ] Automated web↔worker integration test (today: unit + route + parser tests only)

---

## Tech stack

| Layer | Technology |
|-------|-----------|
| Runtime | Cloudflare Workers |
| Framework | [Hono](https://hono.dev) v4 |
| Validation | [Zod](https://zod.dev) v4 + `@hono/zod-validator` |
| Persistence | [InsForge](https://insforge.dev) (Postgres + REST) behind a repository interface |
| Session cache / rate limit | [Upstash Redis](https://upstash.com) (HTTP REST) |
| Scraping source | Classic ASP carrier portals |
