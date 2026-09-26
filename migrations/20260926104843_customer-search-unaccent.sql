-- ============================================================================
-- Customer search: name_unaccent generated column (accent-insensitive search)
-- ============================================================================
-- Background: the previous attempt expanded the query into LIKE bracket classes
-- (`Mendez` → `m[eé][nñ]d[eé]z`). Bracket expressions DO NOT MATCH in this
-- cluster (verified on PG 15.18 / en_US.utf8: `'a' ilike '[a]'` = f), so the
-- autocomplete silently returned zero rows. Instead of classes, this indexes a
-- STORED generated column with unaccent(name) and the worker filters
-- `name_unaccent=ilike.*<folded-query>*` (the query is accent-folded client-
-- side, src/lib/text.ts foldAccents, matching unaccent() output).
--
-- `unaccent()` is declared STABLE in this build, which generated columns
-- reject, so we wrap it in an IMMUTABLE SQL function: the regdictionary cast is
-- catalog-fixed, so the wrapper is genuinely immutable in practice.
--
-- Additive-only. Owner: fix/worker-customer-search-brackets. `name_unaccent`
-- needs no backfill (generated, computed on write) and is never written by the
-- app; the worker is the only writer to billing_clients.

create extension if not exists unaccent;

create or replace function public.unaccent_text(input text)
  returns text
  language sql
  immutable
  parallel safe
as $$
  select public.unaccent('unaccent'::regdictionary, input)
$$;

grant execute on function public.unaccent_text(text) to public;

alter table billing_clients
  add column if not exists name_unaccent text generated always as (public.unaccent_text(name)) stored;

-- Tenant-scoped prefix for the ilike search (organization_id, name_unaccent).
create index if not exists idx_billing_clients_search_unaccent
  on billing_clients (organization_id, name_unaccent);

COMMENT ON COLUMN billing_clients.name_unaccent IS
  'Accent-free copy of name (unaccent_text()) driving the accent-insensitive autocomplete; generated, never written.';