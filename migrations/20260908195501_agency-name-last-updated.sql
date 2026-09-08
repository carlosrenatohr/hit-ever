-- ============================================================================
-- Agency name monthly change limit — track when the display name was last edited.
-- ============================================================================
-- The agency name (shown in the logo section of Config > Información) may only
-- change once per month. name_last_updated lets the Worker enforce the rule
-- server-side (rejecting a second change within 30 days) and lets the panel
-- warn the user before they edit. Additive + idempotent.

alter table agencies
  add column if not exists name_last_updated timestamptz;