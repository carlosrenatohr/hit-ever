# Billing module (Freight Billing)

Self-contained invoicing module for AIR/MAR cargo, linked to the tracked `packages`.
Lives entirely under `src/modules/billing/` and is mounted at **`/api/billing/*`**
from `src/index.ts`. Nothing else in the Worker depends on it.

> New here? Read this file, then the workspace plan: `docs/billing/PLAN.md`.
> Everything in this module is English (code, comments, docs). Spanish is only for
> end-user copy, which this module does not produce.

## Why it exists

The team ran billing from an Excel workbook (`Recibos venta (1).xlsx`) with manual
formulas, hand-typed prices, `#REF!` subtotals, and an unnormalized payment field.
This module replaces that with: catalog-driven pricing, auto-computed totals, invoice
payment states (like shipment states), historical import, reports, and exportable
invoices — all behind authenticated endpoints the panel consumes.

## Layout

```
domain/        enums.ts, types.ts, calc.ts   — vocabulary + pure derived-amount math
catalog/       pricing catalog service + quote           (Stage 1)
repo/          InsforgeBillingRepo behind BillingRepository port  (Stage 1/3)
service/       BillingService: create/quote/applyPayment/void/closeMonth  (Stage 3)
routes/        Hono router mounted at /api/billing        (health now; CRUD Stage 3)
middleware/    auth.ts — verify InsForge JWT + role/permission
render/         invoice render/export: pluggable template (Stage 5)
ingest/        adapters/ + normalize/ + import-xlsx.ts    (Stage 2, offline runner)
```

## Data model

Postgres tables (migration `migrations/20260711093000_billing-schema.sql`):
`pricing_catalog`, `billing_clients`, `billing_agents`, `invoices`,
`invoice_line_items`, `invoice_payments`, `invoice_packages` (invoice↔package join).
All have **RLS default-deny**: only this module (using the Worker admin key) reads or
writes them. Import idempotency key: `invoices (fiscal_year, invoice_number)`.

Derived amounts follow the Excel formula graph, computed in `domain/calc.ts`:
`total = quantity_lbs × unit_price` · `freight_cost = quantity_lbs × catalog.cost` ·
`profit = total − freight_cost` · `margin = profit / total` ·
`commission = profit × agent.rate`.

## Auth

Every route is gated by `middleware/auth.ts`. The panel sends the signed-in user's
InsForge access token as `Authorization: Bearer <jwt>`. The middleware:
1. delegates verification to InsForge (`GET /api/auth/sessions/current`);
2. resolves the caller's role from `app_users` with the admin key;
3. checks a reserved permission string (`invoices:read` / `invoices:write`).

Concrete billing roles are future work; the permission strings are reserved now so
wiring them later is config, not a refactor (see the clerk-acl `module:action`
precedent and Stage 6 in the plan).

## Endpoints (current)

- `GET /api/billing/health` — authenticated liveness check; 200 only for an active
  staff member with `invoices:read`, echoing the caller's role.

## Local dev

```
pnpm dev            # wrangler dev on :8787
pnpm check          # vitest + wrangler dry-run (the CI gate)
```

Migrations apply against the linked InsForge project with:
```
npx @insforge/cli db migrations up --all
```
