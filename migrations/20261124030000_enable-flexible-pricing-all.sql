-- ============================================================================
-- Flexible pricing — enable for every agency
-- ============================================================================
-- Owner branch: fix/billing-weight-rate-resolution.
-- Additive, idempotent, reversible. Process documented in
-- docs/feature-flags-per-agency.md.
--
-- Why: the owner asked for fixed-fee billing to be available to all agencies.
-- The flag turns on the UI/API surface; each agency still needs its own rate
-- cards and its own default. No card or price is copied between tenants, and a
-- package without a configured card fails with an actionable error instead of
-- borrowing another agency's tariff.
--
-- ROLLBACK (explicit):
--   update public.agencies set flexible_pricing_enabled = false where slug <> 'hit' and slug <> 'suite';
--   alter table public.agencies alter column flexible_pricing_enabled set default false;
-- ============================================================================

ALTER TABLE public.agencies
  ALTER COLUMN flexible_pricing_enabled SET DEFAULT TRUE;

UPDATE public.agencies
  SET flexible_pricing_enabled = TRUE
  WHERE NOT flexible_pricing_enabled;
