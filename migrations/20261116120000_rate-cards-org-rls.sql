-- ============================================================================
-- Rate cards RLS: org-scoped reads (fixes cross-tenant leak)
-- ============================================================================
-- Owner branch: fix/config-rate-card-rls-org-scope. Additive-safe, idempotent.
--
-- Problem: the three rate-card read policies only required config_reader(),
-- so ANY staff user of ANY agency could SELECT every agency's rate cards
-- (and their prices AND provider costs) by querying the tables directly.
-- Tenant isolation relied on the panel never issuing cross-org queries —
-- the same gap that 20260905010000_rls-package-org-scope.sql closed for
-- packages. With independent provider costs about to live in these tables
-- (flexible pricing), the leak becomes a cross-tenant financial exposure.
--
-- Fix (approved decision, flexible-pricing plan Stage 1):
--   * rate_cards        → org read from the session directly.
--   * rate_card_versions / rate_card_entries → resolved through their
--     parent card via SECURITY DEFINER helpers, mirroring the established
--     can_access_package() pattern (avoids recursive RLS evaluation).
--   * The Worker is unaffected: it uses the admin key (bypasses RLS) and
--     already scopes every read by organization_id itself.
--   * The panel is unaffected: it reads rate cards only through the Worker
--     (configApi), never from the tables directly.
--
-- Behavior change matrix:
--   same-org staff  → unchanged (sees own agency's cards)
--   cross-org staff → previously leaked rows, now 0 rows (the fix)
--   Worker (admin)  → unchanged (RLS bypass)
--
-- ROLLBACK (explicit, restores the previous state):
--   drop function if exists public.can_access_rate_card_version(uuid);
--   drop function if exists public.can_access_rate_card_entry(uuid);
--   drop policy if exists staff_read_rate_cards         on public.rate_cards;
--   drop policy if exists staff_read_rate_card_versions on public.rate_card_versions;
--   drop policy if exists staff_read_rate_card_entries  on public.rate_card_entries;
--   create policy staff_read_rate_cards         on public.rate_cards         for select to authenticated using (public.config_reader());
--   create policy staff_read_rate_card_versions on public.rate_card_versions for select to authenticated using (public.config_reader());
--   create policy staff_read_rate_card_entries  on public.rate_card_entries  for select to authenticated using (public.config_reader());
--
-- Post-migration validation (run as a suite staff user):
--   select count(*) from rate_cards where organization_id <> 'suite';  -- expect 0
-- ============================================================================

-- ─── Parent-access helpers (SECURITY DEFINER, house pattern) ────────────────

CREATE OR REPLACE FUNCTION public.can_access_rate_card_version(p_version_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.rate_card_versions v
    JOIN public.rate_cards c ON c.id = v.rate_card_id
    WHERE v.id = p_version_id
      AND c.organization_id = (SELECT public.session_agency())
  )
$$;

CREATE OR REPLACE FUNCTION public.can_access_rate_card_entry(p_entry_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.rate_card_entries e
    JOIN public.rate_card_versions v ON v.id = e.rate_card_version_id
    JOIN public.rate_cards c ON c.id = v.rate_card_id
    WHERE e.id = p_entry_id
      AND c.organization_id = (SELECT public.session_agency())
  )
$$;

GRANT EXECUTE ON FUNCTION public.can_access_rate_card_version(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_access_rate_card_entry(uuid) TO authenticated;

COMMENT ON FUNCTION public.can_access_rate_card_version(uuid) IS
  'RLS helper: true when the rate card version belongs to the session''s agency (app_users.agency).';
COMMENT ON FUNCTION public.can_access_rate_card_entry(uuid) IS
  'RLS helper: true when the rate card entry''s parent card belongs to the session''s agency.';

-- ─── Org-scoped read policies (replace the unscoped ones) ───────────────────

DROP POLICY IF EXISTS staff_read_rate_cards ON public.rate_cards;
CREATE POLICY staff_read_rate_cards ON public.rate_cards
  FOR SELECT TO authenticated
  USING (public.config_reader() AND organization_id = (SELECT public.session_agency()));

DROP POLICY IF EXISTS staff_read_rate_card_versions ON public.rate_card_versions;
CREATE POLICY staff_read_rate_card_versions ON public.rate_card_versions
  FOR SELECT TO authenticated
  USING (public.config_reader() AND public.can_access_rate_card_version(id));

DROP POLICY IF EXISTS staff_read_rate_card_entries ON public.rate_card_entries;
CREATE POLICY staff_read_rate_card_entries ON public.rate_card_entries
  FOR SELECT TO authenticated
  USING (public.config_reader() AND public.can_access_rate_card_entry(id));

COMMENT ON POLICY staff_read_rate_cards ON public.rate_cards IS
  'Org-scoped: config-role staff may only read their own agency''s rate cards.';
