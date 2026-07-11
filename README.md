# hit-ever-scraper

> **Cloudflare Worker • Hono API** — tracking API for [Hit Cargo](https://hit-cargo.com).

**Workspace:** product context (priorities, other repos, part-time team) lives in [`../CLAUDE.md`](../CLAUDE.md) at the root of the `hit` workspace (one level up from this folder).

The Worker exposes a clean public tracking API that the Hit Cargo Astro site consumes. It **reads from our own database (InsForge)** — it does **not** scrape live on request. A background pipeline scrapes Cargotrack (Everest + Global Connection), filters to HIT's mailbox, and writes InsForge; the public `/track` endpoint then serves a minimal, PII-free payload from that database.

For the full, copy-pasteable request/response catalog (every endpoint, every status code, curl + Postman), see **[docs/e2e-testing.md](docs/e2e-testing.md)** — it is the source of truth for the API contract.

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
                       Cargotrack (Classic ASP)
                       ├─ Everest  (mailbox 37458 filter)
                       └─ Global Connection (account 100% HIT)
```

The site reads InsForge through the Worker, never Cargotrack directly, so a public lookup is a fast DB read with no live login involved. The internal panel (`hit-panel`, a separate repo) talks to InsForge directly instead of going through the Worker — it authenticates each staff member with their own InsForge account and relies on row-level security to decide what they can see and change, rather than the Worker's single admin API key.

Cargotrack itself only tolerates one active session per account, so all scraping — cron, the email hook, and manual backfills — funnels through one cached login and stays throttled. Running several ingestion requests at once just kicks each other's sessions out; there's no way to speed this up by parallelizing.

---

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | — | API root / info |
| `GET` | `/track/:id` | public + per-IP rate limit | Public tracking. Minimal payload from InsForge (no PII/mailbox/value/photo). `200 / 404 / 422 / 429 / 503`. |
| `GET` | `/admin/health` | — | Health check (`environment: configured \| missing-env`) |
| `POST` | `/admin/session/refresh` | body `{secret}` | ⚠ **Legacy/broken** — forces a Cargotrack login via the dead `scraper.ts` path (wrong form fields, won't authenticate). The real login lives in `ingest.ts`. |
| `POST` | `/admin/ingest` | Bearer | Run ingestion for **one** provider. `?provider=<code>&pages=N&days=D` or chunked `?offset=N&days=D` (`days` cap 250). |
| `POST` | `/admin/refresh-open` | Bearer | Re-scrape all still-open (non-delivered) packages of a provider. |
| `POST` | `/admin/packages/:guia/refresh` | Bearer | Re-scrape one package by guía. |
| `POST` | `/admin/packages/:guia/status` | Bearer | Manual status override (wins over scraped). |
| `POST` | `/admin/packages/:guia/tags` | Bearer | Internal tag (not exposed publicly). |
| `POST` | `/admin/packages/:guia/notes` | Bearer | Internal note (not exposed publicly). |
| `POST` | `/hooks/provider-email` | `X-Hook-Secret` or `?secret=` | Re-scrape one package from a provider update email. |

Bearer = `Authorization: Bearer <ADMIN_SECRET>`. Cloudflare Email Routing also delivers the Cargotrack update email straight to the Worker's `email()` handler (same re-scrape path). Full request/response detail (params, status codes, curl) is in [docs/e2e-testing.md](docs/e2e-testing.md).

### Response envelope

All responses share one envelope. Add `?pretty=1` for indented JSON.

- Success: `{ "ok": true, "data": { … }, "meta"?: { "cachedAt"?, "latencyMs"? } }`
- Error: `{ "ok": false, "error": { "code": "…", "message": "…" } }`

### `GET /track/:guia` — `data` is a `PublicShipment`

```json
{
  "ok": true,
  "data": {
    "guia": "910500",
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

`status` (internal enum): `en_almacen | parcial | en_transito | en_destino | entregado | excepcion | desconocido`. `statusLabel` is the Spanish user label and `step` (1..4, `0` for excepción/desconocido) drives the site's 4-step bar (Miami → En tránsito → Nicaragua → Entregado). A manual override (`/admin/packages/:guia/status`) wins over the scraped status. Full status/label/step mapping and the `404`/`422` cases are in [docs/e2e-testing.md §1.3](docs/e2e-testing.md).

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
curl "http://localhost:8787/track/910500?pretty=1"
```

### Test & gate

```bash
pnpm test     # vitest (parser fixtures + route validation)
pnpm check    # gate: vitest + `wrangler deploy --dry-run` (the CI merge gate, F3)
```

---

## Deployment

Secrets are Cloudflare secrets (`wrangler secret put <KEY>`), already set in prod:

```bash
wrangler secret put INSFORGE_API_URL
wrangler secret put INSFORGE_API_KEY     # admin key — server only, never in the site
wrangler secret put EVEREST_USERNAME
wrangler secret put EVEREST_PASSWORD
wrangler secret put GC_USERNAME          # Global Connection
wrangler secret put GC_PASSWORD
wrangler secret put UPSTASH_REDIS_URL
wrangler secret put UPSTASH_REDIS_TOKEN
wrangler secret put ADMIN_SECRET         # Bearer for /admin/* and /hooks/*
```

```bash
pnpm run deploy   # wrangler deploy --minify   (note: `pnpm deploy` collides with pnpm's builtin)
pnpm cf-typegen   # regenerate CloudflareBindings types
```

**Four** cron schedules run as a backstop (the email hook is the primary freshness mechanism), staggered so no two providers scrape at once: `0 */2 * * *` ingests Everest and `30 */2 * * *` ingests Global Connection (list-walk within `INGEST_WINDOW_DAYS`, default **7 days**); `15 */6 * * *` and `45 */6 * * *` re-scrape each provider's still-open packages so late provider notes aren't missed. They're split on purpose — Global Connection has no mailbox filter, so it opens a detail page per row, and running both providers in one invocation blows past the Workers free-plan subrequest limit. Source of truth: `wrangler.jsonc` `triggers.crons` + the `scheduled()` dispatch in `index.ts`.

The base schema lives in `db/*.sql`; everything added for the internal dashboard (staff roles, RLS policies, the write RPCs, the `effective_status` and `status_rank` generated columns) is in `migrations/*.sql`, applied with `npx @insforge/cli db migrations up --all` against the linked InsForge project.

---

## Cargotrack scraping — operational rules

- **Login follows a redirect chain:** `GET /` → `POST /` (`user`/`password`/`action=login`/`Submit=Log In`) → `validate.asp` → `validate_final.asp` → `/appl2.0/agent/default.asp`. The `accessdenied=` in those URLs is part of a **successful** login, not a denial. Workers' `fetch` drops cookies across redirects, so the Worker walks the chain manually, accumulating cookies. List: `/appl2.0/agent/whs.asp?offset=15,30,…` (15 rows/page). Detail: `/appl2.0/agent/whs_detail.asp?id=<guia>`.
- **Single session:** Cargotrack allows one active session per account. A Worker login while a human is logged into the browser returns empty lists. **Run ingestion when no human is logged in.** Sessions last ~2-3 min; the Worker caches one in Upstash.
- **History goes back further than you'd guess:** Everest's warehouse list is a persistent ledger, not just a "recent activity" view — we've paged back to April 2025 without hitting a wall. A one-time deep backfill (e.g. "everything since January") is just walking `?offset=` further than the routine ingestion window (`INGEST_WINDOW_DAYS`, currently **7 days**); find the right offset by checking the dates on a page, not by guessing. Global Connection is the opposite: its list caps out around a dozen rows regardless of offset, so whatever's there is already everything there is.

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
│   └── parser.ts            # legacy/aux parser helpers
├── services/
│   ├── ingest.ts            # IngestService: scrape → filter → upsert (chunked + batched) — THE live path
│   └── scraper.ts           # ⚠ legacy/dead path (EverestScraperService); only refreshSession() is reachable, and its login uses wrong form fields — do not build on this
└── routes/
    ├── track.ts             # GET /track/:id  (+ route validation test)
    ├── admin.ts             # /admin/health, /admin/ingest, /admin/packages/:guia/*
    └── hooks.ts             # POST /hooks/provider-email

db/         0001_init.sql, 0002_provider_notes.sql        # base InsForge schema (⚠ global_connection provider row is commented out — lives in DB but not reproducible from SQL)
migrations/ dashboard-auth · dashboard-effective-status · packages-status-rank  # staff roles, RLS, write RPCs + generated columns for hit-panel
fixtures/   captured Cargotrack HTML for parser tests
docs/       e2e-testing.md (API contract), production-deployment.md (go-live runbook),
            backfill-runbook.md (deep backfill procedure), session-log-2026-06.md (Cargotrack gotchas)
```

---

## Roadmap

- [x] Public tracking API reading from InsForge (live, real data)
- [x] Multi-provider ingestion (Everest + Global Connection) — chunked, batched, strict mailbox filter
- [x] Admin tools: manual status override, tags, notes
- [x] Email trigger (Cloudflare Email Routing + `/hooks/provider-email`) re-scrape
- [x] Delivery harness (`pnpm check` + CI on PR)
- [x] Global Connection backfilled and ingesting on its own cron tick
- [x] Historical backfill back to January 2026 (Everest — see `docs/backfill-runbook.md`)
- [x] Internal dashboard (`hit-panel`) reading InsForge directly via per-user auth + RLS
- [ ] Email-trigger bridge wired (Make.com → `/hooks/provider-email`)
- [ ] Custom API domain `api.hit-cargo.com` (currently `*.workers.dev`)
- [ ] Write notes back to Cargotrack (`remarks.asp`) + HIT's own notes / billing custom fields
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
| Scraping source | Cargotrack (Classic ASP) — Everest + Global Connection |
