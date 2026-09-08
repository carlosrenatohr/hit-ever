-- ============================================================================
-- Suite is a demo agency — disable scraping so demos never trigger sync/scrape.
-- ============================================================================
-- `suite` is a demo tenant (no billing clients, seeded demo packages). Same
-- treatment as solo-guegue (20260904140000): is_scrapable=false refuses all
-- ingest/sync paths server-side (isAgencyScrapable guard) and the panel hides
-- the refresh actions. The agency stays for tests/demos; delete is out of scope.
-- Idempotent: re-running changes nothing.

update agencies
set is_scrapable = false,
    updated_at   = now()
where slug = 'suite';