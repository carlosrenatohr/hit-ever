-- ============================================================================
-- T16: dynamic price tiers — enum → text
-- ============================================================================
-- Each agency creates its own tiers (REGULAR, ESPECIAL, VIP, or whatever it
-- names them). Two columns are typed as the `price_tier` enum; both widen to
-- text. Data-preserving: existing values keep their exact strings. The enum
-- type itself stays in the DB (additive-only; harmless, unused afterwards).
-- Widening is idempotent: ALTER TYPE text on an already-text column is a no-op.

ALTER TABLE rate_rows
  ALTER COLUMN tier TYPE text USING tier::text;

ALTER TABLE invoice_line_items
  ALTER COLUMN price_tier TYPE text USING price_tier::text;
