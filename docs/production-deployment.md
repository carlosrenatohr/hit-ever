# Production deployment — HIT CARGO (web + tracker)

Operational guide to take the whole system to production: the **website** (Astro on Cloudflare
Pages), the **tracking API** (Hono Worker on Cloudflare Workers), the **database** (InsForge), the
**session/rate-limit store** (Upstash Redis), and the **freshness pipeline** (cron + email trigger
against Cargotrack). Written for a 3-person part-time team — checklist-driven, copy-pasteable,
security-first.

> Truth lives in the repo, the gate (`pnpm check`) and live checks — not in prose. Verify each step.
> This file covers BOTH repos. Worker repo: `hit-ever2`. Web repo: `hit-cargo-web-v-1.2`.

---

## 0. TL;DR — order of operations

1. Merge code (PRs → CI green → branch protection) on both repos.
2. Decide the **Workers plan** (free vs paid — see §7). Free works with the staggered cron already in place.
3. Set **all Worker secrets** in Cloudflare (§4) and **rotate** anything that passed through chat (§5).
4. Verify **InsForge RLS** is default-deny and the admin key is server-only (§6).
5. Point **domains**: `api.hit-cargo.com` → Worker, `hit-cargo.com` → Pages (§3).
6. Set **`PUBLIC_API_URL`** in Pages env and confirm the site's **CSP `connect-src`** allows the API host (§8).
7. Update the Worker **CORS** origins to the production web domain (§7).
8. Run the **post-deploy validation** (§11) and watch the **first cron ticks** (§9, §10).

---

## 1. Architecture & current state

```
 Browser ─▶ hit-cargo.com (Astro/Pages) ─fetch▶ api.hit-cargo.com (Hono Worker)
                                                        │  reads
                                                        ▼
                                                   InsForge (Postgres/REST)
                                                        ▲  writes
   Cargotrack (Everest + Global Connection) ──ingest──┘
        ▲                         ▲
   cron (every 2h, staggered)   email trigger (Make.com → /hooks/provider-email)
                         (session + rate-limit cache: Upstash Redis)
```

| Component | Where | State today |
|---|---|---|
| Worker (tracking API) | `hit-ever-scraper` · `*.workers.dev` · CF account `b91df20a…bead73` | **Deployed**; needs custom domain + CORS update |
| Website | Astro 6 + Preact · GitHub `carlosrenatohr/hit-landing` | On Pages; needs `PUBLIC_API_URL` + custom domain |
| Database | InsForge `a4qvtp8s.us-east.insforge.app` (project `8f6f1654…`) | **Live**: 77 packages / 222 events / 111 notes |
| Cache | Upstash Redis `allowing-redbird-69307.upstash.io` | Configured (Worker secret) |
| Source | Cargotrack: Everest (`provexpro`, mailbox 37458) + Global Connection (`hitcargo`, no filter) | Login + ingest working |
| Domain | `hit-cargo.com` (registrar: Namecheap) | Not yet on Cloudflare / not pointed |

**The site never scrapes live.** Worker scrapes → writes InsForge → site reads InsForge via the Worker.

---

## 2. Prerequisites (access & tooling)

- **Cloudflare** account (owner of `hit-ever-scraper`); ability to add Pages project + custom domains.
- **InsForge** project access (admin API key).
- **Upstash** account (Redis REST URL + token).
- **Namecheap** access to `hit-cargo.com` DNS (to delegate to Cloudflare or add records).
- **GitHub** push access to both repos; admin to set branch protection.
- **Make.com** (free) or a Gmail Apps Script account for the email trigger.
- Local: Node 20.x, `pnpm`, `wrangler` (in repo), `npx @insforge/cli`.

---

## 3. Domains & DNS

Target: `hit-cargo.com` (+ `www`) → website; `api.hit-cargo.com` → Worker.

**Recommended: move DNS to Cloudflare** (simplest, enables Pages + Worker custom domains + WAF/rate rules).
1. Cloudflare → Add site `hit-cargo.com` → copy the 2 Cloudflare nameservers.
2. Namecheap → Domain → Nameservers → Custom DNS → paste the Cloudflare nameservers. (Propagation up to 24h.)
3. In Cloudflare DNS, add records (Pages/Worker steps below create most automatically).

**Alternative: keep Namecheap DNS** — add a `CNAME api → hit-ever-scraper.<account>.workers.dev` and a
`CNAME`/ALIAS for the apex to Pages. Custom-domain SSL is easier when DNS is on Cloudflare; prefer moving it.

**`api.hit-cargo.com` → Worker:** Cloudflare → Workers & Pages → `hit-ever-scraper` → Settings →
Domains & Routes → **Add Custom Domain** → `api.hit-cargo.com`. Cloudflare provisions the cert + DNS.

**`hit-cargo.com` → Pages:** see §8.

---

## 4. Worker — production config

### 4.1 Secrets (set each via `wrangler secret put <KEY>`, run in `hit-ever2/`)

| Secret | Purpose | Notes |
|---|---|---|
| `INSFORGE_API_URL` | DB REST base | non-secret-ish but set as secret |
| `INSFORGE_API_KEY` | DB admin key | **server-only**, bypasses RLS — never ship to client |
| `EVEREST_USERNAME` / `EVEREST_PASSWORD` | Everest login | |
| `GC_USERNAME` / `GC_PASSWORD` | Global Connection login | user is `hitcargo` (8 chars) |
| `UPSTASH_REDIS_URL` / `UPSTASH_REDIS_TOKEN` | session + rate-limit store | |
| `ADMIN_SECRET` | Bearer for `/admin/*` and the hook | long random string |
| `OPENAI_API_KEY` | optional AI parse fallback | only if used |

`EVEREST_BASE_URL` and the cron live in `wrangler.jsonc` (non-secret). `GC_BASE_URL` isn't read by the
Worker — the GC base URL comes from the `providers` table (`gc.cargotrack.net`).

Confirm what's set: `pnpm exec wrangler secret list`.

> Setting a secret with special characters (`#`, `!`): pipe the raw value, don't echo it —
> `printf %s "$VALUE" | pnpm exec wrangler secret put KEY`. A `${!k}`-style indirect expansion in zsh
> uploaded empty secrets once; use direct `$VAR`.

### 4.2 CORS — restrict to the production site

`src/index.ts` CORS `origin` currently lists `https://hit-cargo.com`, `https://www.hit-cargo.com`,
and localhost. Keep the prod domains; drop localhost before go-live if you want a tight surface
(optional — localhost can't be reached from third-party sites anyway).

### 4.3 Deploy

```
cd hit-ever2
pnpm check            # gate: vitest + wrangler dry-run bundle — must be green
pnpm exec wrangler deploy --minify
```

Deploy output must show both cron schedules: `0 */2 * * *` and `30 */2 * * *`.

### 4.4 Plan & the 50-subrequest limit (IMPORTANT)

Workers **free plan = 50 subrequests per invocation**. Ingestion opens one detail page per row, and
Global Connection has **no mailbox filter** (every row is HIT's), so it can't share an invocation with
Everest. Two mitigations are already in code:
- **Backfill / manual:** `/admin/ingest?provider=<code>&offset=N` ingests ONE provider per request.
- **Cron:** staggered — `0 */2` ingests Everest, `30 */2` ingests Global Connection (the handler
  branches on `event.cron`). Never reintroduce a single-invocation "all providers" cron on the free plan.

**Recommendation:** **Workers Paid ($5/mo)** raises the limit to 1000 subrequests and removes this
constraint entirely (you could ingest all providers per tick and backfill bigger pages). Not required
today — the staggered cron is free-tier-safe — but worth it as volume grows or providers are added.

---

## 5. Secrets inventory & rotation (security)

**Rotate any secret that has ever been pasted into a chat, a screenshot, or a shared terminal.**
During the build the following passed through the working session and should be rotated before/at
go-live, then re-set as Worker secrets:

- `INSFORGE_API_KEY` (rotate in InsForge dashboard)
- `UPSTASH_REDIS_TOKEN` (rotate in Upstash console)
- `OPENAI_API_KEY` (rotate in the OpenAI dashboard — only if still used)
- `ADMIN_SECRET` (pick a new long random string)
- Cargotrack `EVEREST_*` / `GC_*` (change the passwords in Cargotrack if feasible)

Never commit `.dev.vars`, `.env`, or `.insforge/project.json` (all gitignored). `.dev.vars` is for
local dev only; production values live exclusively as Cloudflare secrets / Pages env vars.

---

## 6. InsForge (database) — production readiness

- **RLS default-deny** on all tables; the Worker uses the admin key (bypasses RLS) and is the only
  writer/reader. The public `/track` payload is shaped in code (no PII) — the client never talks to
  InsForge directly. Verify: an anonymous (no-key) REST call to `/api/database/records/packages`
  must return no rows / be denied.
- Migrations applied: `db/0001_init.sql` (schema + RLS), `db/0002_provider_notes.sql` (provider notes).
  New changes go through `npx @insforge/cli` migrations — never hand-edit prod tables.
- **Backups:** confirm InsForge's backup/retention for the project; the data is reconstructable from
  Cargotrack via backfill, but events/notes history and any manual overrides are not.
- Columns holding internal data (`casillero`, `referencia_name`, `declared_value`, `remitente`,
  photos) must **never** appear in the `/track` payload — they don't today; keep it that way when
  adding fields (`toPublicShipment` in `src/types/tracking.ts` is the gate).

---

## 7. Security checklist (go / no-go)

- [ ] No fake data on the site (ratings/testimonials removed) — brand honesty.
- [ ] All credentials are Cloudflare secrets / Pages env; none in git; weak/chat-exposed ones rotated (§5).
- [ ] Rate limiting active on `/track` (per-IP, Upstash) — burst returns `429`.
- [ ] `/admin/*` and `/hooks/*` require `Authorization: Bearer ADMIN_SECRET` / `X-Hook-Secret`.
- [ ] Public payload minimal: no casillero, customer name, value, photo, or other resellers' data.
- [ ] A foreign/unknown id returns `404` (the DB only holds HIT packages → bounded enumeration surface).
- [ ] Input validation: malformed id → `422` (Zod).
- [ ] InsForge RLS default-deny; admin key server-only.
- [ ] CSP on the site aligned; `connect-src` includes the API host (§8).
- [ ] CORS on the Worker restricted to the production web origin.
- [ ] Scraping footprint kept low: one cached session, throttled, recent-window only, back off on failure.

---

## 8. Website — production config (Cloudflare Pages)

Repo: `hit-cargo-web-v-1.2` (Astro 6 + Preact). Build: `pnpm build` → `dist`.

1. **Pages project** → connect the GitHub repo (`carlosrenatohr/hit-landing`), build command `pnpm build`,
   output `dist`, Node 20.
2. **Env var** → Settings → Environment variables → `PUBLIC_API_URL = https://api.hit-cargo.com`
   (production). Without it, the tracking portal shows the "coming soon" fallback.
3. **CSP `connect-src`** must include `https://api.hit-cargo.com` (and drop `*.workers.dev` once the
   custom domain is live). Check `astro.config.mjs` / `public/_headers` / `Layout.astro` meta — keep
   the header and meta aligned. Do not reformat the hash-pinned GTM snippet.
4. **Custom domain** → Pages → Custom domains → add `hit-cargo.com` + `www.hit-cargo.com`
   (auto DNS + cert when DNS is on Cloudflare).
5. Redeploy and hard-refresh; confirm a real guía renders the 4-step bar + timeline.

---

## 9. Cron & freshness pipeline

- **Cron (backstop):** every 2h, staggered — Everest at `:00`, Global Connection at `:30` (UTC).
  Each tick ingests one provider, last-60-days window, reusing one cached session.
- **Single session caveat:** Cargotrack allows ONE active session per account. If a human is logged
  into the Everest/GC browser when a cron tick runs, that provider's list can come back empty. The
  cron runs around the clock; for clean data, avoid staying logged into Cargotrack during ingest, or
  shift the cron to off-hours.
- **Email trigger (primary freshness):** Cargotrack sends an update email (to a personal Gmail). Bridge
  it to `POST /hooks/provider-email` with header `X-Hook-Secret: <ADMIN_SECRET>` and the raw email body.
  - **Use Make.com Free**: Gmail "watch" trigger → HTTP module (POST, custom header). Free, no expiry.
  - Or a **Gmail Apps Script** (~30 lines, `onNewMail` → `UrlFetchApp.fetch`). Free forever.
  - **Not Zapier free** — custom-header webhooks are paywalled there.
  - The handler extracts the warehouse number and re-scrapes just that package (idempotent upsert).

---

## 10. Monitoring & observability

- **Worker logs:** Cloudflare Observability (enabled in `wrangler.jsonc`, `head_sampling_rate: 1`).
  In the dashboard or via the MCP, filter `$metadata.service = hit-ever-scraper`, `level = error`.
  Watch for: ingest results `{everest:N, global_connection:M}` where `-1` = a failed provider (open
  the matching error log), `Too many subrequests`, and login failures (`did not reach the agent area`).
- **Health:** `GET /admin/health` → service + env sanity.
- **Data freshness (no logs needed):** check `scraped_at` advancing per provider:
  `GET {INSFORGE}/api/database/records/packages?select=almacen_id,scraped_at&order=scraped_at.desc&limit=5`.
  After a cron tick, the relevant provider's `scraped_at` should move to ~the tick time.
- **Cargotrack page changes:** parser is fixtures-tested; if a provider returns 0 unexpectedly or text
  looks wrong, re-capture a fixture and re-run `pnpm test`.

---

## 11. Post-deploy validation (run after go-live)

```
# Worker up
curl -s https://api.hit-cargo.com/admin/health

# Public track: happy path (use a real guía), bounded errors
curl -s https://api.hit-cargo.com/track/926791        # → 200 minimal payload + timeline
curl -s https://api.hit-cargo.com/track/000000        # → 404 (unknown)
curl -s "https://api.hit-cargo.com/track/abc%20123"   # → 422 (malformed)
# burst → 429 (rate limit) after the per-IP threshold

# Payload has NO PII (no casillero/name/value/photo) — eyeball the 200 above

# Site → enter a real guía → 4-step bar + timeline; loading/error/not-found states OK

# InsForge RLS: anonymous read denied
curl -s "$INSFORGE_API_URL/api/database/records/packages?select=id"   # (no Authorization) → denied/empty
```

---

## 12. Rollback

- **Worker:** `pnpm exec wrangler deployments list` then `wrangler rollback [<version-id>]`. Secrets are
  unaffected by rollback.
- **Pages:** Pages → Deployments → pick a previous build → "Rollback to this deployment".
- **InsForge:** schema changes are migration-based; keep a down-migration or a pre-change export for
  anything destructive.

---

## 13. Cost (current plan)

| Service | Plan | Cost |
|---|---|---|
| Cloudflare Workers | Free (staggered cron stays under 50 subrequests) | $0 — **Paid $5/mo recommended** for headroom (1000 subrequests) |
| Cloudflare Pages | Free | $0 |
| InsForge | check project tier | per InsForge |
| Upstash Redis | Free (pay-as-you-go) | ~$0 at this volume |
| Make.com | Free | $0 |
| Domain | Namecheap | annual |

---

## 14. Open items before / at go-live

- [ ] Push + merge both feature branches (`feat/tracker-api`, `feat/mvp-pages-tracker`); set branch
      protection (CI green + 1 review) on `main`/`master`.
- [ ] Workers Paid decision (§4.4).
- [ ] Rotate chat-exposed secrets (§5).
- [ ] Custom domains: `api.hit-cargo.com` (Worker) + `hit-cargo.com` (Pages); move DNS to Cloudflare.
- [ ] `PUBLIC_API_URL` in Pages env + CSP `connect-src` updated to the API host.
- [ ] Email trigger wired (Make.com) and tested against `/hooks/provider-email`.
- [ ] First cron ticks validated per provider (`scraped_at` advances; no `-1` in logs).
- [ ] End-to-end web↔worker test still missing (only parser fixtures + a `/track` route test exist).

---

## 15. Known limitations / risks

- **Single Cargotrack session** — concurrent human login can blank an ingest. Mitigation: cached
  session + cron timing + email trigger (fewer logins than polling).
- **Cargotrack HTML changes** — would break the parser. Mitigation: fixtures + regression tests; the
  DB decouples the site from live scraping.
- **GC has no delivered color** — delivery is inferred from a `RETIRADO` note → `manual_status`.
  If they change that wording, delivered detection drifts (the match is `/retirad/i`).
- **GC pagination** — GC currently fits one list page; `?offset` is a no-op there. If GC volume grows
  past one page, confirm its pagination before assuming offsets work.
- **Free-plan subrequest ceiling** — adding providers or bigger pages on the free plan needs more cron
  staggering or the paid plan.
