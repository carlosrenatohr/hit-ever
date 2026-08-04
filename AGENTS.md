# AGENTS.md

<!-- INSFORGE:START -->
## InsForge backend

This project uses [InsForge](https://insforge.dev): an all-in-one, open-source Postgres-based backend (BaaS) that gives this app a database, authentication, file storage, edge functions, realtime, an AI model gateway, and payments through one platform.

- **Project:** **Hit Cargo Data Source** (API base `https://a4qvtp8s.us-east.insforge.app`)
- **Skills:** these InsForge skills are installed for supported coding agents. Reach for them before implementing any InsForge feature instead of guessing the API:
  - `insforge`: app code with the `@insforge/sdk` client (database CRUD, auth, storage, edge functions, realtime, AI, email, and Stripe payments).
  - `insforge-cli`: backend and infrastructure via the `insforge` CLI (projects, SQL, migrations, RLS policies, storage buckets, functions, secrets, payment setup, schedules, deploys).
  - `insforge-debug`: diagnosing failures (SDK/HTTP errors, RLS denials, auth and OAuth issues) and running security or performance audits.
  - `insforge-integrations`: wiring external auth providers (Clerk, Auth0, WorkOS, Better Auth, etc.) for JWT-based RLS, or the OKX x402 payment facilitator.
  - `find-skills`: discovering additional skills on demand.
- **Credentials:** app code reads keys from `.env.local`; the CLI reads `.insforge/project.json`. Never hardcode or commit keys.

Key patterns:

- Database inserts take an array: `insert([{ ... }])`.
- Reference users with `auth.users(id)`; use `auth.uid()` in RLS policies.
- For storage uploads, persist both the returned `url` and `key`.
<!-- INSFORGE:END -->

## Workspace context — AGENTS.md (root)

This sub-repo (`hit-ever2`) is one of five in the workspace. The **canonical** AGENTS.md lives at the workspace root (`/hit/AGENTS.md`) and covers cross-repo architecture, coding standards, CI/deploy, security, and agent workflow. This file only adds repo-specific context; defer to the root AGENTS.md for everything else.

Key standards enforced here (mirror of workspace AGENTS.md):

- **Agent workflow:** use Codebase Memory (`search_graph`, `trace_path`) before `grep`/`read`; `read` only the file you edit or config; verify with `pnpm check` (vitest + wrangler deploy --dry-run); never merge without green gate + 1 review.
- **Conventional Commits** in English; body plain English; atomic commits. Author: `Renato <honchkrow1995@gmail.com>`.
- **TypeScript + Zod** on all Hono handlers via `zValidator`. No hand-rolled input parsing.
- **Envelope contract (immutable):** `{ ok: true, data, meta? }` on success, `{ ok: false, error: { code, message } }` on error. Breaking shape → version by path (`/v2/...`), notify sitio + panel (rebuild needed).
- **PII allowlist:** `toPublicShipment()` is allowlist-based — add fields only via code change, never expose raw DB rows.
- **Rate limit** per-IP on public `/track` (Upstash Redis, fails open); `/admin/*` and `/hooks/*` gated by timing-safe Bearer `ADMIN_SECRET`.
- **Secrets:** in Cloudflare secrets (`wrangler secret put`), never in `wrangler.jsonc` `[vars]`; never in query strings.
- **Migrations:** aditivas, una por PR, aplicar con `npx @insforge/cli db migrations up --all`.

### Local dev
```bash
pnpm install
cp .dev.vars.example .dev.vars   # fill secrets for local ingest/Cargotrack
pnpm dev          # http://localhost:8787 (demo mode with MemoryRepository if INSFORGE_API_URL empty)
pnpm check        # gate: vitest + wrangler deploy --dry-run
pnpm run deploy   # wrangler deploy --minify  (⚠ not `pnpm deploy` — collides with pnpm builtin)
pnpm cf-typegen   # regenerate CloudflareBindings
```

