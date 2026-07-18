# Graph Report - .  (2026-07-17)

## Corpus Check
- 79 files · ~66,491 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 536 nodes · 1192 edges · 23 communities (14 shown, 9 thin omitted)
- Extraction: 96% EXTRACTED · 4% INFERRED · 0% AMBIGUOUS · INFERRED: 43 edges (avg confidence: 0.76)
- Token cost: 193,827 input · 0 output

## Community Hubs (Navigation)
- Core domain & architecture
- Billing domain logic
- Billing migrations & service
- Cargotrack ingestion & parsing
- Worker HTTP app & routes
- Billing XLSX import & adapters
- Legacy Everest scraper (session)
- Package config & dependencies
- Billing InsForge repo (HTTP)
- InsForge tracking client
- TypeScript config
- Public tracking domain & API
- Tracking types & InsForge rows
- In-memory repository (tests)
- Repository factory & seed
- Package record mapping
- Rate limiter
- TrackingRepository interface
- Event record mapping
- Everest list/search fixtures
- Detail-page fixtures
- Update-email fixtures
- CORS allowlist

## God Nodes (most connected - your core abstractions)
1. `BillingRepository` - 29 edges
2. `InsforgeBillingRepo` - 29 edges
3. `FreightType` - 25 edges
4. `InsforgeClient` - 19 edges
5. `IngestService (live ingestion path)` - 19 edges
6. `TrackingRepository` - 18 edges
7. `BillingService` - 18 edges
8. `runMigration()` - 17 edges
9. `IngestService` - 16 edges
10. `MemoryRepository` - 15 edges

## Surprising Connections (you probably didn't know these)
- `GPT-4o-mini AI parsing (planned)` --semantically_similar_to--> `IngestService (live ingestion path)`  [INFERRED] [semantically similar]
  docs/everest-scraper-plan.md → README.md
- `Supabase persistence (planned, superseded by InsForge)` --semantically_similar_to--> `InsForge backend (Hit Cargo Data Source)`  [INFERRED] [semantically similar]
  docs/everest-scraper-plan.md → AGENTS.md
- `Playwright session feeder (external Node process)` --semantically_similar_to--> `IngestService (live ingestion path)`  [INFERRED] [semantically similar]
  docs/playwright-plan.md → README.md
- `Cargotrack warehouse-receipt update email (HTML)` --semantically_similar_to--> `Cargotrack warehouse-receipt update email (PDF)`  [INFERRED] [semantically similar]
  fixtures/correo_update.html → fixtures/correo_update.pdf
- `Custom domains (api.hit-cargo.com)` --references--> `GET /track/:id public tracking API`  [INFERRED]
  docs/production-deployment.md → README.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Cargotrack scrape to InsForge ingestion flow** — readme_cargotrack, readme_ingest_service, readme_casillero_filter, docs_session_log_2026_06_batching, agents_insforge [INFERRED 0.75]
- **50-subrequest-limit mitigation strategies** — docs_known_issues_subrequest_limit, readme_cron_schedules, docs_session_log_2026_06_batching, docs_backfill_runbook_chunked_backfill, docs_scaling_and_hosting_workers_paid [INFERRED 0.75]
- **Delivery harness quality gate (pnpm check across CI and deploy)** — readme_delivery_harness, _github_workflows_ci_gate, _github_workflows_deploy_workflow [INFERRED 0.75]
- **Cargotrack detail-page fixture set (Everest + Global Connection)** — fixtures_detalle_everest_detail_page, fixtures_detalle_gc_global_connection_detail_page, fixtures_detalle_gc_incountry_global_connection_in_country_detail_page [INFERRED 0.75]

## Communities (23 total, 9 thin omitted)

### Community 0 - "Core domain & architecture"
Cohesion: 0.05
Nodes (78): CI merge gate (pnpm check on PR), Post-deploy health check (root 200 / billing 401), Deploy Worker to Cloudflare workflow, InsForge backend (Hit Cargo Data Source), Detail status from summary-row color fix, service_type parsing precedence fix, v1.0.0 first stable release, Chunked historical backfill procedure (+70 more)

### Community 1 - "Billing domain logic"
Cohesion: 0.06
Nodes (61): CatalogService, Quote, amountsDiffer(), computeAmounts(), inferTier(), LineAmounts, margin(), quoteLine() (+53 more)

### Community 2 - "Billing migrations & service"
Cohesion: 0.07
Nodes (20): round2(), AmountMismatch, buildLineRows(), buildPaymentRows(), deriveStatus(), ImportReport, isEmptyPlaceholder(), runMigration() (+12 more)

### Community 3 - "Cargotrack ingestion & parsing"
Cohesion: 0.09
Nodes (23): scheduled(), DetailEvent, HEX_TO_STATUS, inputVal(), isHitPackage(), ListRow, mapService(), num() (+15 more)

### Community 4 - "Worker HTTP app & routes"
Cohesion: 0.08
Nodes (31): app, email(), STATIC_ALLOWED_ORIGINS, almacenIdFromEmail(), getRepository(), Res, intParam(), timingSafeEqual() (+23 more)

### Community 5 - "Billing XLSX import & adapters"
Cohesion: 0.13
Nodes (30): HDR_2025, HDR_2026, HeaderLevelAdapter, buildLine(), hasLineData(), LineItemAdapter, COLS_2025, COLS_2026 (+22 more)

### Community 6 - "Legacy Everest scraper (session)"
Cohesion: 0.12
Nodes (16): clean(), extractCells(), inferStatus(), parseEverestHtml(), parseWithAI(), STATUS_MAP, cookiesToHeader(), SessionStore (+8 more)

### Community 7 - "Package config & dependencies"
Cohesion: 0.07
Nodes (27): exceljs, hono, @hono/zod-validator, dependencies, hono, @hono/zod-validator, zod, devDependencies (+19 more)

### Community 10 - "TypeScript config"
Cohesion: 0.18
Nodes (10): ESNext, compilerOptions, jsx, jsxImportSource, lib, module, moduleResolution, skipLibCheck (+2 more)

### Community 11 - "Public tracking domain & API"
Cohesion: 0.24
Nodes (9): trackParamSchema, effectiveStatus(), normalizeTracking(), PublicEvent, PublicShipment, STATUS_LABEL, STATUS_STEP, TEXT_STATUS_PATTERNS (+1 more)

### Community 12 - "Tracking types & InsForge rows"
Cohesion: 0.29
Nodes (7): DetailData, DbEventRow, DbPackageRow, DbProviderRow, NOTE: confirm the API host and the exact API key format in the Insforge dashboar, ServiceType, ShipmentStatus

### Community 14 - "Repository factory & seed"
Cohesion: 0.25
Nodes (4): SEED_EVENTS, SEED_PACKAGES, SEED_PROVIDERS, Provider

### Community 19 - "Everest list/search fixtures"
Cohesion: 0.67
Nodes (3): Almacén list page — Everest (Cargotrack), Casillero search page — Everest (Cargotrack), Casillero search result page — Everest (Cargotrack)

### Community 20 - "Detail-page fixtures"
Cohesion: 1.00
Nodes (3): Package detail page — Everest (Cargotrack), Package detail page — Global Connection (Cargotrack), Package detail — Global Connection In Country (Cargotrack)

## Knowledge Gaps
- **77 isolated node(s):** `name`, `type`, `packageManager`, `dev`, `deploy` (+72 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **9 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `CloudflareBindings` connect `Worker HTTP app & routes` to `Billing domain logic`, `Cargotrack ingestion & parsing`, `Legacy Everest scraper (session)`, `Public tracking domain & API`, `Repository factory & seed`?**
  _High betweenness centrality (0.096) - this node is a cross-community bridge._
- **Why does `InsforgeBillingRepo` connect `Billing InsForge repo (HTTP)` to `Billing domain logic`, `Billing migrations & service`, `Billing XLSX import & adapters`?**
  _High betweenness centrality (0.069) - this node is a cross-community bridge._
- **Why does `BillingRepository` connect `Billing migrations & service` to `Billing InsForge repo (HTTP)`, `Billing domain logic`?**
  _High betweenness centrality (0.057) - this node is a cross-community bridge._
- **Are the 7 inferred relationships involving `IngestService (live ingestion path)` (e.g. with `service_type parsing precedence fix` and `Silent days cap (withinDays discard)`) actually correct?**
  _`IngestService (live ingestion path)` has 7 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `type`, `packageManager` to the rest of the system?**
  _77 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Core domain & architecture` be split into smaller, more focused modules?**
  _Cohesion score 0.05028305028305028 - nodes in this community are weakly interconnected._
- **Should `Billing domain logic` be split into smaller, more focused modules?**
  _Cohesion score 0.06288448393711552 - nodes in this community are weakly interconnected._