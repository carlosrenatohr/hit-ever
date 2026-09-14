-- Backfill received_at / last_event_at from the events table.
-- Fixes packages where inverted HTML order caused received_at to be the
-- LATEST event and last_event_at the OLDEST (315 of 337 packages in hit).
-- Multitenant: covers all organizations; runs idempotently.

UPDATE public.packages p
SET received_at    = sub.evt_min,
    last_event_at  = sub.evt_max,
    updated_at     = now()
FROM (
  SELECT package_id,
         MIN(occurred_at) AS evt_min,
         MAX(occurred_at) AS evt_max
  FROM public.events
  GROUP BY package_id
) sub
WHERE p.id = sub.package_id
  AND p.deleted_at IS NULL
  AND (
    -- received_at is after the earliest event (date inverted)
    p.received_at > sub.evt_min
    -- or last_event_at is before the latest event (date inverted)
    OR p.last_event_at < sub.evt_max
    -- or received_at/last_event_at are swapped (received after last)
    OR p.received_at > p.last_event_at
  );
