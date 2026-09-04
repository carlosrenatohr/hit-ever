-- Add 'solo-gueguense' to app_users.agency CHECK constraint for demo agency.
-- Additive: widens the allowed values; no existing rows affected.

-- Drop the old CHECK constraint
ALTER TABLE public.app_users
  DROP CONSTRAINT IF EXISTS app_users_agency_check;

-- Re-create with the new slug included
ALTER TABLE public.app_users
  ADD CONSTRAINT app_users_agency_check CHECK (agency IN ('hit', 'suite', 'solo-gueguense'));
