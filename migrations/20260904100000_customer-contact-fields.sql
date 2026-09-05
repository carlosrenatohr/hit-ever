-- ============================================================================
-- T22: customer contact fields on billing_clients
-- ============================================================================
-- All nullable: existing rows keep working, the upsert-by-name path (import and
-- invoice creation) never sets them — only the panel's customer form does.

ALTER TABLE billing_clients
  ADD COLUMN IF NOT EXISTS email text,
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS address text;
