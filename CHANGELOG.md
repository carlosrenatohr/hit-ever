# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.70.8] — 2026-09-24

### Fixed
- The invoice number no longer touches the \`Factura No.\` label (label-to-number gap widened from 13pt to 26pt; date pushed down accordingly).

## [1.70.7] — 2026-09-23

### Changed
- **Receipt PDF layout now mirrors the panel print template (InvoicePrint)**: Poppins embedded (latin subset) for 400/500/600/700/800, logo vertically centered against the brand block, generous spacing under the "Factura No." label, bordered header, a bottom border per line row, and lines around the Subtotal/Total block. WhatsApp and print views are now visually identical.
- **HTML receipt view loads Poppins** (Google Fonts) and shares the same short es-NI date as the print — matching the PDF.
- **Common characters only** across PDF/HTML/filenames: `≈`, `—`, `·`, `N.º` replaced by `C$…`, `-`, ``, `Factura No.` (Poppins latin subset covers the range shown).

## [1.70.6] — 2026-09-23

### Fixed
- **Logo in receipts finally works**: the storage gateway redirects to a signed CDN that 403s requests without a User-Agent — and Workers fetch sends none. The logo fetcher now walks redirects manually with a UA header (verified in workerd locally: 200, PNG).
- The secondary currency line shows just the symbol+amount (\`C$3,700.00\`), no \`≈\`, no rate.

## [1.70.5] — 2026-09-23

### Changed
- The WhatsApp PDF downloads as \`Factura #7 — <Agencia>.pdf\` (same wording as the receipt page title in the print/save flow) instead of the ambiguous \`factura-7.pdf\` — RFC 5987 UTF-8 filename.

## [1.70.4] — 2026-09-23

### Fixed
- Receipt PDF and HTML routes send \`Cache-Control: no-store\` — per-token content must never be served from a browser/WhatsApp/edge cache. The panel also sends a fresh \`?ts=\` on the WhatsApp link so each share is a new URL.

## [1.70.3] — 2026-09-23

### Added
- The receipt PDF and HTML receipt show only the equivalent amount in the other currency (`≈ C$3,700.00`), without the exchange rate.

### Fixed
- The WebP logo decoder now receives a `Uint8Array` (jsquash's embind binding rejects raw `ArrayBuffer`), and logo failures log `receipt-logo:*` warnings for observability — the deployed logo path is no longer silent.

## [1.70.2] — 2026-09-23

### Added
- The on-the-fly receipt PDF now embeds the agency logo (object-contain, like the HTML receipt). Logos are stored as WebP, so the worker decodes them to PNG on the fly (jsquash wasm, ~138 KB binding); PNG/JPEG logos embed natively.

## [1.70.1] — 2026-09-23

### Added
- `GET /billing/r/:token/pdf` — the public receipt rendered on the fly as a PDF (pdf-lib) and downloaded as an attachment; nothing is persisted. New route only: the existing HTML preview (`/billing/r/:token`) is untouched. The WhatsApp share link now points here so the recipient gets the PDF directly.

## [1.0.1] — 2026-09-23

### Added
- Public invoice receipt shows the grand total in the secondary currency (USD↔córdobas) at the agency's exchange rate, below the prominent main-currency total — mirrors the printed invoice shared via WhatsApp. `getAgencyInfo` reads `exchange_rate_nio_per_usd`.

## [1.0.0] — 2026-07-10

First stable release of the HIT Cargo tracking worker — a Cloudflare Worker (Hono) that scrapes
Cargotrack (Everest + Global Connection), stores HIT's shipments in InsForge, and serves a public,
PII-free tracking API. In production, serving real data to the website and the internal panel.

### Added — Public tracking API
- `GET /track/:id` — reads from our database (not a live scrape). Primary lookup by waybill /
  warehouse number (guía); falls back to the carrier tracking number.
- **Minimal public payload** — status (4-step pipeline), events, service type, weight, pieces,
  dates and offices. Never exposes mailbox (casillero), customer name, declared value or photo.
- **Per-IP rate limiting** (Upstash) against enumeration/abuse; `422` for malformed ids; `404` for
  ids not in our database (bounded surface, since the DB only holds HIT's packages).
- **CORS** allow-list: `hit-cargo.com` / `www`, plus the landing's Cloudflare Pages production and
  preview origins, and local dev.

### Added — Scraper & parser (Cargotrack, Everest + Global Connection)
- Fetch-based login → session cookie (cached in Upstash) → Warehouse list walk → detail parse.
  No headless browser. Follows Cargotrack's login redirect chain and paginates by row offset.
- Regex parser with real HTML fixtures and tests. Responses decoded as **Windows-1252** (Classic
  ASP), fixing mojibake on accented characters.
- Row-color → status mapping (official legend). Detail status read from the summary row's
  `ntextrowbg<color>` class — the authoritative source — instead of a free-text scan.

### Added — Ingestion (multi-provider)
- Repository interface (`TrackingRepository`) so persistence is storage-agnostic; InsForge
  (PostgREST) implementation + an in-memory one for tests. Schema: `packages`, `events`,
  `package_provider_notes`, with RLS and an `effective_status` (manual override wins) generated
  column, plus a `status_rank` column for the panel's default ordering.
- Chunked backfill and a routine cron staggered per provider and per job type to stay under the
  Worker's 50-subrequest limit.
- **Open-package refresh** — revisits not-yet-delivered packages by id, independent of where they
  have scrolled in the list, so late provider notes (e.g. a `RETIRADO`) aren't missed.
- **Email trigger** hook (Cloudflare Email Routing) for near-real-time refresh of a single package.
- Strict mailbox (casillero) ownership filter for Everest's shared account; accept-all for Global
  Connection. Global Connection's `RETIRADO` note is mirrored to a "delivered" manual status.
- Uploaded package photos captured to `photo_ref`.
- Admin endpoints (Bearer-authed): backfill/ingest, force-refresh one or open packages, and
  tags / notes / manual-status by waybill.

### Fixed — data quality
- **`service_type`** parsed from the `shipping_instructions` option code (A/O/T), not only full
  words, and read from the reliable field first — a `??` precedence bug had been silently
  discarding the good value on both providers.
- **Detail status** taken from the summary-row color instead of a whole-document text scan, which
  had matched the disabled `Hold` form field and stamped every detail-refreshed package as
  `excepcion`; also mapped the previously-unknown `On Hand` / `In Country` states. A corrective
  sweep recomputed all affected packages.
- Provider notes de-duplicated; their upsert made non-fatal so it never fails a chunk.
- Accept Global Connection's root login landing; per-provider cron stagger; `/admin/ingest` day cap
  raised to 250 for deep backfills.

### Security
- Credentials and admin secret in Cloudflare Secrets (never in the repo or DB). Public endpoint is
  read-only and PII-free; write/admin and the email hook are authenticated.
