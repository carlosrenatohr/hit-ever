-- Add 'solo-guegue' to app_users.agency CHECK constraint for demo agency.
-- Additive: widens the allowed values; no existing rows affected.
-- NOTE: slug is 'solo-guegue' (standardized everywhere — matches agencies.slug).

-- Drop the old CHECK constraint
ALTER TABLE public.app_users
  DROP CONSTRAINT IF EXISTS app_users_agency_check;

-- Re-create with the new slug included
ALTER TABLE public.app_users
  ADD CONSTRAINT app_users_agency_check CHECK (agency IN ('hit', 'suite', 'solo-guegue'));
