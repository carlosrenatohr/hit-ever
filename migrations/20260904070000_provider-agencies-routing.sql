-- ============================================================================
-- Provider routing data: GC serves all three agencies; route by casillero
-- ============================================================================
-- Agency ↔ provider contract (owner decision, 2026-09-04):
--   hit         → everest + global_connection
--   suite       → global_connection only
--   solo-guegue → global_connection only
-- One shared GC Cargotrack account feeds all three, so ingestion routes each
-- package by casillero prefix. GC→hit has a NULL filter = default owner: any
-- casillero that matches no filter lands in hit, exactly as ingestion behaved
-- when GC was hit-only. Filters are data — adjust rows, not code.

alter table provider_agencies
  add column if not exists casillero_filter text;

-- Backfill existing links from the providers row filter
-- (everest→'37458', GC→null, suite_demo→'8899').
update provider_agencies pa
set casillero_filter = p.casillero_filter
from providers p
where p.id = pa.provider_id
  and pa.casillero_filter is distinct from p.casillero_filter;

-- hit also works with GC (default owner — NULL filter).
insert into provider_agencies (provider_id, agency_slug, casillero_filter)
select id, 'hit', null from providers where code = 'global_connection'
on conflict (provider_id, agency_slug) do nothing;

-- suite works with GC only: its mailbox is 8899 (evidence: all 40 suite packages).
insert into provider_agencies (provider_id, agency_slug, casillero_filter)
select id, 'suite', '8899' from providers where code = 'global_connection'
on conflict (provider_id, agency_slug) do nothing;

-- solo-guegue: GC-only, casilleros 5012-5056 (demo clients) → prefix '50'.
update provider_agencies
set casillero_filter = '50'
where agency_slug = 'solo-guegue'
  and provider_id = (select id from providers where code = 'global_connection');
