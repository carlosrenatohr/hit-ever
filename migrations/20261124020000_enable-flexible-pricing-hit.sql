-- ============================================================================
-- Flexible pricing — enable for HIT Cargo (explicit owner approval 2026-11-24)
-- ============================================================================
-- Owner branch: docs/config-feature-flags-per-agency.
-- Additive, idempotent, reversible. Process documented in
-- docs/feature-flags-per-agency.md.
--
-- Why HIT: the owner asked to review the flexible-pricing surface with a real
-- production agency of its own (the flag was pilot-only on `suite`). This is an
-- explicit approval, which is what the original flag migration requires.
--
-- Scope: the flag only turns on the UI/API surface. It does not rewrite existing
-- packages and is not a security boundary (RLS + the Worker's gate remain).
--
-- ROLLBACK (explicit):
--   update public.agencies set flexible_pricing_enabled = false where slug = 'hit';
-- ============================================================================

-- Single statement on purpose: `insforge db query` runs one statement per call.
-- The row is verified right after applying (see docs/feature-flags-per-agency.md §5).
UPDATE public.agencies
  SET flexible_pricing_enabled = TRUE
  WHERE slug = 'hit'
  AND NOT flexible_pricing_enabled;
