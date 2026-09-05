-- ============================================================================
-- Suite Cargo uses GC only — unlink the suite_demo fixture provider
-- ============================================================================
-- Owner decision (2026-09-04): suite works with global_connection only, same as
-- solo-guegue. suite_demo stays as a provider row (its 40 demo packages still
-- reference it) but is no longer linked to the suite agency, so suite users see
-- exactly one provider (GC) in their filter. Reversible: re-insert the row.
delete from provider_agencies
where agency_slug = 'suite'
  and provider_id = (select id from providers where code = 'suite_demo');
