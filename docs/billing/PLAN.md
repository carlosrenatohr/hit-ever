# Plan: Billing Module (Freight Billing) — InsForge-native

> Language note: this plan, all migrations, git artifacts, and project code are in **English**.
> Spanish is reserved for end-user-facing copy only. A durable copy of this plan is committed
> into the repo as documentation (see Stage 0).

## Context

The team currently runs freight billing (AIR/MAR) from an Excel workbook
(`Recibos venta (1).xlsx`) with manual formulas, hand-typed prices, `#REF!` subtotals, and an
unnormalized payment field (14+ variants for the same thing). We want a billing module
**linked to the packages that already exist** (`packages` in InsForge, ingested by the
`hit-ever2` Worker and shown in `hit-panel`) that: (a) imports the history, (b) creates new
invoices from packages with automatic catalog-driven pricing, (c) manages payment states like
shipments do, and (d) produces reports and exportable invoices. Immediate goal: **something
functional, delivered in measurable stages**, using the data we already have first and then
feeding in new packages.

The original guide MD assumed **MongoDB + Node + React standalone**: wrong stack for this
workspace. The *domain model* from that spec (header+line-items, enums, normalization,
catalog, commissions, statuses, reporting) is reused as-is; only the tech mapping changes to
**InsForge (Postgres) + Worker Hono (hit-ever2) + panel Astro/Preact (hit-panel)**.

### Fixed decisions (owner answers)
- **Stack:** InsForge-native. No new infra, no new repo (overkill for now).
- **Write path:** endpoints in the **`hit-ever2` Worker (Hono)**, in a **separate,
  self-contained, dev/agent-friendly, well-documented module**. The panel consumes those
  endpoints (not InsForge-direct for billing).
- **Currency:** invoice priced in **USD** (catalog). Each payment records `currency` (USD/NIO)
  + optional manual `fx_rate` + `amount_usd`.
- **History:** import **only the 2025 + 2026 (Q1/Q2/Q3) sheets**. **Daniel is NOT imported**
  (agent commissions = out of scope; the field is kept for the future). Link to `packages.id`
  where the `OC` matches (best-effort); orphans stay valid and are **manually assignable from
  the panel** (same pattern as manual status).
- **Payment states like shipments:** yes — explicit `InvoiceStatus`
  (DRAFT/ISSUED/PARTIAL/PAID/VOID).
- **Invoice numbering:** per-year auto-increment sequence (`max+1`), matching the sheet's
  `=A_prev+1`. Kept as-is for now.
- **Printing/export:** browser print now (`window.print()` + `@media print`), but the
  render/export layer is built as a **pluggable template** so the owner's custom invoice
  format (shared later, driven from the panel) can slot in without rework.
- **Roles/permissions:** billing access is gated by roles/permissions that **do not exist
  yet**. Design the gating (endpoint middleware + UI nav) around reserved permission strings
  (`invoices:read`, `invoices:write`) from day one; wiring the concrete roles is a later step.
- **Worktree:** mandatory and **the very first action**, for parallel work.

## Excel analysis findings (source of truth)

- 6 sheets / 3 schemas. Valid: **2025** 147 invoices (line-item), **2026 Q1/Q2/Q3** 81/61/16
  (header-level), **Daniel** 16 (excluded). ANULADO=44, `#REF!` subtotals ≈12.
- **BD catalog (USD/lb)** — static, no formulas:
  - AIR: cost 4.5 · regular 6.5 · especial 6.0 · VIP 5.5 · Madres 6.25 · Dario 4.3
  - MAR: cost 1.25 · regular 2.5 · especial 2.3 · VIP 2.25 · Madres —(null) · Dario 1.3
  - Payment enum (BD col J): `BAC USD, BAC NIO, EFECTIVO, Lafise USD, Lafise NIO, PARCIAL, SALDO A FAVOR`
- **Computation graph (real formulas):** `unit_price = VLOOKUP(freightType→BD, tier)` ·
  `total = lbs × unit_price` · `freight_cost = lbs × BD.Cost` · `profit = total − freight_cost` ·
  `margin = profit/total` · `commission = profit × 0.5` (Daniel). `numero_factura` =
  per-year auto-increment.
- **Data-quality to handle on ingest:** unnormalized `Pago` (regex → method/bank/currency or
  quarantine); `numero_factura` float↔int (coerce); **dirty `OC`** (floats from eaten commas
  `663714.6648`, ambiguous CSV) → best-effort link; ANULADO→`VOID`; `TOTAL x` subtotals with
  `#REF!`→drop; AI-garbage columns (`__xludf.DUMMYFUNCTION`, "I do not have enough…")→ignore;
  free-text `cliente` with trailing spaces→normalize+dedupe; `direccion` (2025) always `-`→useless.

## Real DB facts (basis of the link)

- Table `packages` (hit-ever2 `db/0001_init.sql`): PK `id` (uuid) — **the invoice FK target**;
  `almacen_id` = guía (unique only per provider, do NOT use as FK); `service_type` enum
  `aereo`/`maritimo` (= AIR/MAR); `weight_lb`, `pieces`, `declared_value`; `referencia_name`
  (customer, PII, free-text); `casillero`. **No customer table exists.**
- Migrations live in **`hit-ever2/migrations/`**, applied with
  `npx @insforge/cli db migrations up --all`. Timestamp-named.
- Worker → InsForge over REST with **admin key (RLS bypass)**, hand-rolled client
  (`src/lib/insforge.ts`, `InsforgeClient implements TrackingRepository`), factory in
  `src/lib/repository.ts`. Project `a4qvtp8s.us-east.insforge.app`.
- Panel: static Astro+Preact SPA, single route, state-driven nav (`View` in `App.tsx`,
  `NAV` in `Shell.tsx`); Chart.js reports; **printable output = `window.print()` +
  `@media print`** (no PDF lib); CSV via `toCSV`/`downloadCSV` in `src/lib/format.ts`;
  roles `admin/staff/viewer`.

## Module architecture

**Self-contained billing module in the Worker** (Hono), mounted at `/api/billing/*`:

```
hit-ever2/src/modules/billing/
  README.md            # module doc: purpose, endpoints, model, how to run the import
  domain/              # zod schemas, enums, canonical types, calc.ts (pure derived fns)
  catalog/             # pricing catalog service (reads pricing_catalog) + quote
  repo/                # InsforgeBillingRepo (REST) behind BillingRepository (storage-agnostic)
  service/             # BillingService: create/quote/applyPayment/void/closeMonth + linkPackage
  routes/              # Hono router /billing (auth-guarded)
  middleware/          # auth: verify session JWT + role/permission
  render/              # invoice render/export: pluggable template (browser-print now, custom later)
  ingest/
    adapters/          # lineItem.adapter.ts (2025), headerLevel.adapter.ts (2026 Q*)
    normalize/         # payment.ts, client.ts, freight.ts
    import-xlsx.ts     # idempotent offline runner (tsx, admin key, run locally)
```

**Panel** (hit-panel), consumes the endpoints:
```
hit-panel/src/lib/billing.ts             # HTTP client to /api/billing (like the /track fetch)
hit-panel/src/components/billing/        # Facturacion.tsx (list+filters, Shipments.tsx pattern),
                                         # InvoiceDetail.tsx (drawer: line-items/payments/packages/actions),
                                         # InvoiceForm.tsx, Exceptions.tsx (queue)
```
+ a `NAV` entry in `Shell.tsx` (permission-gated) + `'facturacion'` in the `View` union in `App.tsx`.

### Postgres schema (migration in `hit-ever2/migrations/`)

Tables (RLS **enabled, default-deny** — access only through the Worker with the admin key;
money never leaves to the browser except through authenticated endpoints):
- `pricing_catalog` — 1 row per freightType: `cost` + tiers (`regular, especial, vip, madres, dario`).
- `billing_clients` — name dedupe (`name_normalized` unique), optional `casillero`, `to_review` bool.
- `billing_agents` — for future commissions (Daniel not imported; table kept).
- `invoices` — header: `id uuid PK`, `invoice_number int`, `fiscal_year int`
  (unique `(fiscal_year, invoice_number)` = idempotency), `client_id fk`, `client_name_raw`,
  `issue_date`, `status` enum, `address`, `special_price bool`, `observations`,
  `tracking_orders text[]` (raw OC), `source jsonb` (`{sheet, rows}` traceability), timestamps.
- `invoice_line_items` — `invoice_id fk`, `description`, `freight_type` (AIR/MAR), `quantity_lbs`,
  `unit_price`, `total`, `list_price`, `freight_cost`, `profit`, `price_tier`, flags (`price_off_catalog`).
- `invoice_payments` — `invoice_id fk`, `method` enum, `bank` enum, `currency` enum, `amount`,
  `amount_usd`, `fx_rate`, `paid_at`, `raw` (original cell, audit/quarantine).
- `invoice_packages` — invoice↔package join: `invoice_id fk`, `package_id fk`, `source`
  (`auto`|`manual`), `matched_oc text`. Supports multi-package invoices and **manual assignment**
  from the panel.
- Enums: `invoice_status` (DRAFT/ISSUED/PARTIAL/PAID/VOID), `billing_freight_type` (AIR/MAR),
  `payment_method` (BANK_TRANSFER/CASH/CREDIT_BALANCE), `payment_bank` (BAC/LAFISE/BANPRO),
  `currency` (USD/NIO), `price_tier` (REGULAR/ESPECIAL/VIP/MADRES/DARIO).

Derived fields are **always computed in `domain/calc.ts`**, never hardcoded; hard validation on
ingest (log if off by >0.01): `total ≈ lbs×unit_price`, `profit ≈ total−freight_cost`,
`unit_price ≈ a catalog tier`.

### Endpoint authentication + permissions (Stage 0 tech decision)

Billing endpoints expose money → **auth + role/permission required**. The panel is a browser SPA
authenticated with InsForge (JWT). The Worker today only serves `/track` (public) and admin
routes (`src/routes/admin.ts`). The billing module adds **middleware that verifies the InsForge
access token and resolves role/permission** (`app_users`). Confirm in Stage 0 the InsForge-JWT
verification mechanism in the Worker; there is precedent on the `feat/clerk-acl` branch
(`clerk_permissions()`, `module:action` model → future `invoices:read`/`invoices:write`).
Gate on reserved permission strings now even though the concrete roles are defined later.

## Stages (measurable, incremental)

**Stage 0 — Worktree + skeleton + schema + auth + plan doc.**
FIRST: create `feat/billing` worktrees in hit-ever2 and hit-panel (`.claude/worktrees/` pattern).
Commit a copy of this plan as `hit-ever2/docs/billing/PLAN.md` (English) for reference/handoff.
Scaffold `src/modules/billing/` + README. Migration `..._billing-schema.sql` (tables+enums+RLS+
indexes+join). Apply migration. Auth middleware (verify JWT + role/permission, reserved
`invoices:*` strings).
**Measurable:** migration `up` succeeds; `GET /api/billing/health` = 200 only for authorized
staff, 401/403 otherwise; anon denied; tables exist; plan doc committed.

**Stage 1 — Catalog + pricing engine.**
Seed `pricing_catalog` from BD (AIR/MAR + 5 tiers + cost). `domain/calc.ts` (pure fns
replicating the VLOOKUP graph). Endpoints `GET /catalog`, `GET /quote?freightType&tier&lbs`.
**Measurable:** quote returns exact catalog numbers (AIR regular 6.5, MAR cost 1.25…); vitest
tests for derived calcs pass (`pnpm check` gate).

**Stage 2 — Historical import (2025 + 2026).**
`import-xlsx.ts` (tsx, offline, admin key): adapters (LineItem 2025 / HeaderLevel 2026),
normalize (payment→canonical+quarantine, client dedupe, freight TIPO num/string→AIR/MAR), Zod,
idempotent upsert by `(fiscal_year, invoice_number)`. Best-effort link by `OC` tokens →
`invoice_packages(source='auto')`. Exception queue (`price_off_catalog`, quarantined payment,
client-to-review, unlinked). **Daniel not imported.**
**Measurable (spec §10 acceptance):** run 2× = same state; Σ `total` per year = xls excluding
ANULADO+subtotals (±0.01); 0 `Pago` silently dropped; 0 `#REF!`; import report prints counts
(imported/void/quarantined/linked).

**Stage 3 — Service + CRUD/state endpoints.**
`POST /invoices` (create, auto-calc total/profit/margin), `GET /invoices` (filters
status/freight/month/client, paginated — mirror `listPackages`), `GET /invoices/:id`,
`POST /invoices/:id/payments` (apply payment → recompute PARTIAL/PAID), `POST /invoices/:id/void`,
`POST /invoices/:id/packages` (manual link/unlink), `POST /close-month` (aggregation, replaces
`TOTAL JUNIO`).
**Measurable:** create invoice from freight+tier+lbs → correct derived fields; payment
transitions status; manual link attaches a package; monthly close matches Stage-2 reporting.

**Stage 4 — Panel: list + detail + reports.**
`Facturacion.tsx` (filters+table copying `Shipments.tsx`), `InvoiceDetail` (line-items, payments,
linked packages, actions), reports (revenue/profit by month/freight, receivables, exceptions)
reusing the `Reports.tsx` + Chart.js pattern. `hit-panel/src/lib/billing.ts` client.
Nav permission-gated.
**Measurable:** historical invoices render+filter; detail shows line-items/payments; report
totals = Stage-3 numbers.

**Stage 5 — Create-from-package + manual link + exports.**
In `Shipments`: select package(s) → "Crear factura" prefilled (client=`referencia_name`,
freight=`service_type`, lbs=`weight_lb`, price=catalog). Manual link/assign of orphan invoices to
packages from the drawer (like manual status). Printable invoice via the `render/` pluggable
template (browser print now, standard simple format) + CSV (`toCSV`/`downloadCSV`).
**Measurable:** creating an invoice from a real package sets `invoice_packages`; PDF prints; CSV
exports; the exception queue lets the user resolve unlinked/quarantined items.

**Stage 6 — Deferred (later; small, phased is fine).**
VAT/tax; public customer receipt via the Worker; concrete `invoices:read/write` role wiring
(clerk-acl precedent); custom panel-driven print format when the owner shares it (slots into
`render/`); Daniel-style agents/commissions if reactivated. This "what's missing for the next
version" list is also captured in the committed `docs/billing/PLAN.md`.

## Key files to create/touch

- **New (hit-ever2):** `migrations/<ts>_billing-schema.sql`, all `src/modules/billing/**`,
  `docs/billing/PLAN.md`, router mount in the main Hono app (`src/index.ts`).
- **Reuse (hit-ever2):** `InsforgeClient`/`repository.ts` pattern for `InsforgeBillingRepo`;
  existing Zod; new error/normalization catalog.
- **New (hit-panel):** `src/lib/billing.ts`, `src/components/billing/**`.
- **Touch (hit-panel):** `src/components/App.tsx` (`View`), `src/components/Shell.tsx` (`NAV`),
  `src/lib/types.ts` (+billing types), `src/lib/format.ts` (+currency formatter; reuse `toCSV`).

## Verification (end-to-end)

- **Gates:** hit-ever2 `pnpm check` (vitest + `wrangler deploy --dry-run`); hit-panel `astro check`.
- **Stage 1/3:** vitest tests for `calc.ts` and the service.
- **Stage 2 (import acceptance):** run `import-xlsx.ts` 2× → same state; compare Σ`total` per year
  against the xls (excl. ANULADO+subtotals); assert 0 dropped payments, 0 `#REF!`; print the
  counts report.
- **Manual e2e:** `pnpm dev` Worker (:8787) + panel (:4321); create an invoice from a real
  package, apply payment (PARTIAL→PAID), void (VOID), link/unlink a package manually, print PDF,
  export CSV; verify totals/states against the Excel.

## Open soft items (do not block the start)

- Custom "standard" invoice format (logo/legal/RUC) — Stage 5/6; simple receipt by default,
  `render/` kept pluggable so the future panel-driven format drops in.
- VAT/withholding — Stage 6 (assume net totals like the xls for now).
- Default tier: the 2026 formula did a `VLOOKUP` to a fixed tier; in the module the tier is
  **explicit and selectable** with catalog values; default = REGULAR (confirmable).
- Exact InsForge-JWT verification mechanism in the Worker — resolved in Stage 0.
