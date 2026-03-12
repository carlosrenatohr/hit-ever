# Playwright Integration Plan — Everest Scraper

> **Status**: Pending — Worker stub ready, awaiting Playwright implementation.
> **Target Date**: 15 de Marzo 🎂

---

## Context

The Cloudflare Worker (`hit-ever-scraper`) handles: session caching, data parsing,
and the HTTP API. **Playwright runs as a separate Node.js process** that the Worker
can call out to, or that runs on a schedule to pre-warm session cookies.

There are two integration modes (choose one per phase):

| Mode | How it works | When to use |
|------|-------------|-------------|
| **A. External Node.js process** | A Node script uses Playwright to login, extracts cookies, then POSTs them to `/admin/session/refresh`. The Worker always uses cached sessions. | Phase 1 (now) – simplest |
| **B. Cloudflare Browser Rendering** | The Worker itself calls the Browser Rendering API (Puppeteer-compatible). No external server needed. | Phase 2 (needs CF paid plan) |

---

## Phase 1: Playwright as a Session Feeder (External)

### Step 1 — Bootstrap the Playwright project

```bash
mkdir everest-playwright && cd everest-playwright
npm init -y
npm install playwright @playwright/chromium dotenv
npx playwright install chromium
```

Required env vars (`.env` file alongside the script):
```
EVEREST_USERNAME=...
EVEREST_PASSWORD=...
EVEREST_BASE_URL=https://everest.cargotrack.net
WORKER_URL=https://hit-ever-scraper.workers.dev   # or localhost:8787 in dev
ADMIN_SECRET=...                                   # matches wrangler secret
```

---

### Step 2 — Login script (`scripts/login.ts`)

```typescript
import { chromium, Page } from 'playwright'
import * as dotenv from 'dotenv'
dotenv.config()

const BASE = process.env.EVEREST_BASE_URL!

async function login(): Promise<void> {
  const browser = await chromium.launch({
    headless: true,                  // set false to watch/debug
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  })
  const page = await context.newPage()

  // ── 1. Navigate to login page ──────────────────────────────────────────────
  await page.goto(`${BASE}/default.asp`, { waitUntil: 'networkidle' })

  // ── 2. TODO: Inspect & fill the actual form field names ───────────────────
  // Run this interactively with headless:false to identify selectors:
  //   await page.fill('#txtUser', process.env.EVEREST_USERNAME!)
  //   await page.fill('#txtPassword', process.env.EVEREST_PASSWORD!)
  //   await page.click('input[type="submit"]')
  //
  // Once you confirm field names, replace above with real selectors.

  // ── 3. Wait for post-login redirect ───────────────────────────────────────
  await page.waitForNavigation({ waitUntil: 'networkidle' })

  // ── 4. Extract cookies ────────────────────────────────────────────────────
  const cookies = await context.cookies()
  const sessionCookies = cookies.filter(
    (c) => c.name.startsWith('ASPSESSION') || c.name === 'session',
  )

  console.log('Session cookies extracted:', sessionCookies.map((c) => c.name))

  // ── 5. POST cookies to Worker admin endpoint ───────────────────────────────
  // Option A: Call /admin/session/refresh to force re-login via Worker
  // Option B: Store raw cookies in Upstash Redis directly via REST API

  await browser.close()
}

login().catch(console.error)
```

---

### Step 3 — Tracking page scrape (`scripts/scrape.ts`)

```typescript
// After login, navigate to the tracking/warehouse view:
//
// TODO: Verify the actual URL pattern. Possible candidates:
//   - /almacen.asp?id=852786
//   - /buscar.asp?guia=852786
//   - /seguimiento.asp?numero=852786
//
// Use headless:false in your first run and log page.url() after form submit.

async function scrapeTracking(page: Page, trackingId: string): Promise<string> {
  await page.goto(`${BASE}/almacen.asp?id=${trackingId}`, { waitUntil: 'networkidle' })

  // Capture the raw HTML of the tracking table
  const tableHtml = await page.evaluate(() => {
    const table = document.querySelector('table[id^="Almacen"]')
    return table?.outerHTML ?? document.body.innerHTML
  })

  return tableHtml
}
```

---

### Step 4 — Cron / scheduled runner

```typescript
// scripts/refresh-session.ts
// Run this on a cron every 12 minutes to keep the session alive:
//
//   */12 * * * * node --require ts-node/register scripts/refresh-session.ts
//
// Or use GitHub Actions / a simple Railway cron to call:
//   POST /admin/session/refresh  { "secret": "$ADMIN_SECRET" }
```

---

## Phase 2: Cloudflare Browser Rendering (Future)

Once you have access to **Cloudflare Browser Rendering** (available on paid plans):

1. Enable in CF Dashboard → Workers & Pages → Browser Rendering.
2. Uncomment the `"browser"` binding in `wrangler.jsonc`.
3. Replace `EverestScraperService.login()` with a Puppeteer-compatible script
   running inside the Worker via `env.BROWSER.fetch(...)`.
4. No external process needed — the Worker becomes fully self-contained.

Reference: https://developers.cloudflare.com/browser-rendering/

---

## What I Need From You 🙋

To advance the Playwright integration, please provide:

### 🔑 Credentials and access
- [ ] **Everest username & password** — to test the login flow.
- [ ] **A known tracking ID** (e.g., `852786`) — to validate the scrape output.

### 🌐 Site inspection tasks (do with DevTools open on everest.cargotrack.net)
- [ ] **Login form field names** — open DevTools → Elements, find `default.asp` form and note:
  - Input name for username: probably `txtUser` or `Usuario`
  - Input name for password: probably `txtPassword` or `Clave`
  - Submit button name/value
- [ ] **Post-login redirect URL** — what's the URL after you log in?
- [ ] **Tracking page URL** — after you search for a guía, what's the URL?
  - E.g.: `almacen.asp?id=852786` or `detalle.asp?almacen=852786`
- [ ] **Table structure** — in DevTools, right-click the tracking table → "Copy outerHTML"
  and paste it so the regex parser can be tuned.

### 🛠 Infrastructure (optional but recommended)
- [ ] **Upstash Redis account** — free tier at https://console.upstash.com is enough.
  - Create a database, copy REST URL and token into `.dev.vars`.
- [ ] **Cloudflare account access** — to deploy the Worker and set secrets:
  ```bash
  wrangler secret put EVEREST_USERNAME
  wrangler secret put EVEREST_PASSWORD
  wrangler secret put UPSTASH_REDIS_URL
  wrangler secret put UPSTASH_REDIS_TOKEN
  wrangler secret put ADMIN_SECRET
  ```

---

## Testing Checklist

Once Playwright scripts are wired up:

- [ ] `node scripts/login.ts` — resolves without error, prints cookie names
- [ ] `GET http://localhost:8787/admin/health` — returns `{ "ok": true }`
- [ ] `GET http://localhost:8787/track/852786` — returns shipment JSON
- [ ] `POST http://localhost:8787/admin/session/refresh` — refreshes Redis session
- [ ] Session auto-refresh on 302 redirect (simulate by invalidating Redis manually)
- [ ] CORS works from localhost:4321 (Astro dev)
