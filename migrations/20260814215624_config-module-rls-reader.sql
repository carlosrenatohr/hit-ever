-- ============================================================================
-- Config module RLS fix — viewers must NOT read config tables.
-- ============================================================================
-- Review finding (dredd-sentinel): the four staff_read_* policies created in
-- 20260814214034_config-module.sql gated on public.is_staff(), which is true
-- for ANY active app_users row — including role='viewer' (see
-- 20260711130000_fix-viewer-write-rls.sql for the identical precedent on the
-- write RPCs). Viewers would have read agencies, audit_logs (which carries
-- actor emails) and rate data directly via PostgREST with their JWT.
--
-- Same shape as is_writer(): a config_reader() helper (admin|staff only) used
-- by the config policies. This replaces only the policies this same feature
-- created in the previous migration (no other tables touched). The DROP is
-- scoped to those four policies and is required because Postgres combines
-- SELECT policies with OR — adding a new policy cannot restrict the old one.

create or replace function public.config_reader()
  returns boolean language sql stable security definer
  set search_path = public, auth as $$
  select public.current_staff_role() in ('admin', 'staff')
$$;

grant execute on function public.config_reader() to authenticated;

drop policy if exists staff_read_agencies   on public.agencies;
drop policy if exists staff_read_audit_logs on public.audit_logs;
drop policy if exists staff_read_rate_tables on public.rate_tables;
drop policy if exists staff_read_rate_rows   on public.rate_rows;

create policy staff_read_agencies   on public.agencies    for select to authenticated using (public.config_reader());
create policy staff_read_audit_logs on public.audit_logs  for select to authenticated using (public.config_reader());
create policy staff_read_rate_tables on public.rate_tables for select to authenticated using (public.config_reader());
create policy staff_read_rate_rows   on public.rate_rows   for select to authenticated using (public.config_reader());
