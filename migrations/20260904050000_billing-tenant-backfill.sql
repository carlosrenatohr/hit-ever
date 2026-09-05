-- ============================================================================
-- T1+T2 backfill: reassign Solo Guegue demo billing clients to their agency.
-- ============================================================================
-- Migration 20260904020000 seeded the 5 demo clients before billing tables had
-- organization_id, so they landed under the default 'hit'. Packages were seeded
-- with an explicit organization_id and are correct. This reassigns only the
-- demo client rows; real hit clients are untouched (matched by name_normalized).

UPDATE billing_clients
SET organization_id = 'solo-guegue'
WHERE name_normalized IN (
  'maría josé ruiz',
  'carlos andrés martínez',
  'ana lucía pérez',
  'roberto carlos lópez',
  'daniela fernanda castillo'
)
AND organization_id = 'hit';
