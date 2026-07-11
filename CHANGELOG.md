# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
