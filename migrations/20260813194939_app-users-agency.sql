-- app_users.agency: which agency/brand the user belongs to (drives shell branding).
-- Additive: new column, default 'hit'; existing rows keep current behavior.
alter table public.app_users
  add column agency text not null default 'hit';

alter table public.app_users
  add constraint app_users_agency_check check (agency in ('hit', 'suite'));