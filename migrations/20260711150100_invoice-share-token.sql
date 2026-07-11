-- ============================================================================
-- Public shareable receipt token.
-- ============================================================================
-- An unguessable per-invoice token, generated on demand when staff "shares" an
-- invoice. The public receipt endpoint (no auth) looks up by this token and
-- returns only customer-safe fields (no cost/profit/margin/OC).
alter table invoices add column if not exists public_token uuid;
create unique index if not exists idx_invoices_public_token on invoices (public_token) where public_token is not null;
