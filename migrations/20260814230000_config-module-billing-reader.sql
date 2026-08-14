-- ============================================================================
-- Config module: billing role in config_reader() + audit_logs index
-- ============================================================================
-- The config_reader() RLS helper (created in
-- 20260814215624_config-module-rls-reader.sql) gated reads on
-- current_staff_role() in ('admin', 'staff'). The Worker config module
-- authorizes the 'billing' role on all reads and writes, so the helper
-- must match — otherwise billing users get 403 on direct PostgREST reads.
--
-- Additionally, a btree index on audit_logs(request_id) speeds up the
-- audit log correlation queries (ADR-011) that filter by request_id.
--
-- NOTE: applied directly via `db query` because the `db migrations up`
-- parser is currently broken (rejects ALL SQL); this file documents the
-- change for reproducibility.

create or replace function public.config_reader()
  returns boolean language sql stable security definer
  set search_path = public, auth as $$
  select public.current_staff_role() in ('admin', 'billing', 'staff')
$$;

grant execute on function public.config_reader() to authenticated;

create index if not exists idx_audit_logs_request_id on public.audit_logs(request_id);
