-- ============================================================================
-- Flexible pricing — activation flag (Stage 1a, pilot isolation)
-- ============================================================================
-- Owner branch: feat/flexible-pricing-flag. Additive, idempotent, reversible.
--
-- Purpose: kill-switch + activation switch for the flexible pricing feature
-- (independent customer price vs provider cost, fixed-fee services first).
-- This flag is NOT a security boundary — the real boundaries are RLS and the
-- Worker's server-side gate (requireFlexiblePricing). It exists so the new
-- UI/API surface can be switched on per agency without code changes.
--
-- Isolation contract (flexible-pricing plan, Stage 1):
--   * default false → hit, solo-guegue and original-express keep the current
--     behavior with zero changes.
--   * true ONLY for 'suite' — the designated pilot/test agency. Never enable
--     it for a production agency without explicit approval.
--
-- ROLLBACK (explicit):
--   update public.agencies set flexible_pricing_enabled = false where slug = 'suite';
--   alter table public.agencies drop column if exists flexible_pricing_enabled;
-- ============================================================================

ALTER TABLE public.agencies
  ADD COLUMN IF NOT EXISTS flexible_pricing_enabled BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.agencies.flexible_pricing_enabled IS
  'Flexible pricing activation (pilot: suite only). Kill-switch, not a security boundary — RLS and the Worker gate are.';

-- One-time rollout: enable ONLY the pilot agency. Idempotent on re-run; if the
-- pilot is later turned off manually, re-running this migration flips it back
-- on by design — remove this statement after the feature is stable.
UPDATE public.agencies
  SET flexible_pricing_enabled = TRUE
  WHERE slug = 'suite'
  AND NOT flexible_pricing_enabled;
