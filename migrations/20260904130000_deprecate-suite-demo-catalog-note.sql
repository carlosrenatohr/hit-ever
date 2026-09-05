-- ============================================================================
-- T32+T33: deprecate suite_demo provider; document pricing_catalog's role
-- ============================================================================
-- T32: suite_demo was a demo fixture (40 seeded packages, casillero 8899).
-- The owner contract settled on suite using global_connection only, and the
-- suite junction link was already removed (20260904080000). Setting
-- active = false keeps the row (packages still reference it) while excluding
-- it from every ingest walk (getActiveProviders filters active = true).
update providers
set active = false
where code = 'suite_demo';

-- T33: per the T12 decision, per-tenant pricing lives in rate_tables/rate_rows;
-- pricing_catalog intentionally stays GLOBAL as the legacy fallback (hit's
-- historical prices + the offline import engine). No organization_id column —
-- documented instead of migrated.
comment on table pricing_catalog is
  'DEPRECATED as a pricing source: global legacy fallback only (historical hit prices + offline import engine). Per-agency pricing lives in rate_tables/rate_rows (org-scoped). See docs/plans/multi-agency-production-readiness.md (T12/T33).';
