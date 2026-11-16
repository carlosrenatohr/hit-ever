-- ============================================================================
-- Flexible pricing — additive schema (Stage 2, fixed-first scope)
-- ============================================================================
-- Owner branch: feat/flexible-pricing-schema. Additive only: no column is
-- dropped, no existing constraint changes meaning, no backfill. NULL on every
-- new packages column means "priced under the legacy engine" — historical
-- behavior stays byte-identical.
--
-- Model (decided in the flexible-pricing plan):
--   * rate_cards gains the concept of pricing kind (weight | fixed | volume),
--     an org default flag per kind, an optional provider link and a stable
--     service_key. The card's NAME is the service label the agency defines
--     ("Documentos", ...) — no services catalog is introduced.
--   * rate_card_versions gains INDEPENDENT customer-price and provider-cost
--     model/unit columns. NULL keeps the legacy shared price_model/unit.
--   * client_rate_assignments: per-client default rate card per pricing kind
--     (transport_mode NULL = applies to any mode). Unique active assignment.
--   * packages gains the pricing snapshot written at creation (card refs,
--     kind, models, units, rates, computed charge/cost, currency, audit).
--     invoices later read customer_charge instead of re-quoting.
--
-- Isolation: everything is org-scoped. client_rate_assignments is validated
-- same-org at the DB level (trigger) and read-scoped by RLS like packages.
--
-- ROLLBACK (explicit, when safe):
--   drop trigger ... ; drop function ... ; drop table client_rate_assignments;
--   alter table rate_cards / rate_card_versions / packages drop column ...;
--   (columns are nullable / defaulted — dropping restores previous state)
-- ============================================================================

-- ─── rate_cards: pricing kind + default + provider + service key ────────────

ALTER TABLE public.rate_cards
  ADD COLUMN IF NOT EXISTS pricing_kind TEXT NOT NULL DEFAULT 'weight'
    CHECK (pricing_kind IN ('weight', 'fixed', 'volume')),
  ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS provider_id UUID REFERENCES public.providers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS service_key TEXT;

-- One org default per pricing kind (partial unique; weight default is new but
-- optional — orgs without it keep legacy resolution).
CREATE UNIQUE INDEX IF NOT EXISTS uq_rate_cards_default_per_kind
  ON public.rate_cards (organization_id, pricing_kind)
  WHERE is_default AND active;

CREATE INDEX IF NOT EXISTS idx_rate_cards_kind
  ON public.rate_cards (organization_id, pricing_kind)
  WHERE active;

COMMENT ON COLUMN public.rate_cards.pricing_kind IS
  'What this card prices: weight (legacy), fixed (per guía/package), volume (deferred).';
COMMENT ON COLUMN public.rate_cards.is_default IS
  'Org default for its pricing_kind — at most one active per (organization_id, pricing_kind).';
COMMENT ON COLUMN public.rate_cards.provider_id IS
  'Optional provider this card is priced against (set null = any provider).';
COMMENT ON COLUMN public.rate_cards.service_key IS
  'Stable machine key for the service, for future integrations. Nullable by design.';

-- ─── rate_card_versions: independent customer price / provider cost ─────────

ALTER TABLE public.rate_card_versions
  ADD COLUMN IF NOT EXISTS customer_price_model TEXT
    CHECK (customer_price_model IS NULL OR customer_price_model IN ('WEIGHT', 'VOLUME', 'FIXED')),
  ADD COLUMN IF NOT EXISTS customer_unit TEXT
    CHECK (customer_unit IS NULL OR customer_unit IN ('lb', 'ft3', 'package', 'piece')),
  ADD COLUMN IF NOT EXISTS provider_cost_model TEXT
    CHECK (provider_cost_model IS NULL OR provider_cost_model IN ('WEIGHT', 'VOLUME', 'FIXED')),
  ADD COLUMN IF NOT EXISTS provider_cost_unit TEXT
    CHECK (provider_cost_unit IS NULL OR provider_cost_unit IN ('lb', 'ft3', 'package', 'piece'));

COMMENT ON COLUMN public.rate_card_versions.customer_price_model IS
  'Customer pricing model. NULL = legacy behavior (shared price_model/unit).';
COMMENT ON COLUMN public.rate_card_versions.provider_cost_model IS
  'Provider cost model, independent of the customer price. NULL = legacy (cost scales like price).';

-- ─── client_rate_assignments: per-client default per pricing kind ───────────

CREATE TABLE IF NOT EXISTS public.client_rate_assignments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL REFERENCES public.agencies(slug),
  client_id       UUID NOT NULL REFERENCES public.billing_clients(id) ON DELETE CASCADE,
  rate_card_id    UUID NOT NULL REFERENCES public.rate_cards(id) ON DELETE CASCADE,
  pricing_kind    TEXT NOT NULL
    CHECK (pricing_kind IN ('weight', 'fixed', 'volume')),
  transport_mode  TEXT
    CHECK (transport_mode IS NULL OR transport_mode IN ('AIR', 'MAR')),
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cra_client
  ON public.client_rate_assignments (client_id) WHERE active;
CREATE INDEX IF NOT EXISTS idx_cra_org
  ON public.client_rate_assignments (organization_id);

-- One active assignment per (client, kind, mode); transport_mode NULL = ANY.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cra_active_per_scope
  ON public.client_rate_assignments
    (client_id, pricing_kind, COALESCE(transport_mode, 'ANY'))
  WHERE active;

ALTER TABLE public.client_rate_assignments ENABLE ROW LEVEL SECURITY;

-- The card and the client must belong to the same org (DB-level guard, same
-- spirit as packages_client_same_org). SECURITY DEFINER trigger function.
CREATE OR REPLACE FUNCTION public.validate_client_rate_assignment_org()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.billing_clients c
    JOIN public.rate_cards r ON r.id = NEW.rate_card_id
    WHERE c.id = NEW.client_id
      AND c.organization_id = NEW.organization_id
      AND r.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'client, rate card and organization must belong to the same agency'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.pricing_kind <> (SELECT pricing_kind FROM public.rate_cards WHERE id = NEW.rate_card_id) THEN
    RAISE EXCEPTION 'assignment pricing_kind must match the rate card pricing_kind'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS client_rate_assignments_org_guard ON public.client_rate_assignments;
CREATE TRIGGER client_rate_assignments_org_guard
  BEFORE INSERT OR UPDATE OF client_id, rate_card_id, pricing_kind, organization_id
  ON public.client_rate_assignments
  FOR EACH ROW EXECUTE FUNCTION public.validate_client_rate_assignment_org();

-- Session-scoped read (staff only); writes go through the Worker (admin key).
CREATE OR REPLACE FUNCTION public.can_access_client_rate_assignment(p_assignment_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.client_rate_assignments a
    WHERE a.id = p_assignment_id
      AND a.organization_id = (SELECT public.session_agency())
  )
$$;

GRANT EXECUTE ON FUNCTION public.can_access_client_rate_assignment(uuid) TO authenticated;

CREATE POLICY staff_read_client_rate_assignments ON public.client_rate_assignments
  FOR SELECT TO authenticated
  USING (public.config_reader() AND public.can_access_client_rate_assignment(id));

COMMENT ON TABLE public.client_rate_assignments IS
  'Per-client default rate card per pricing kind (transport_mode NULL = any mode). One active assignment per scope.';

-- ─── packages: pricing snapshot (all nullable — NULL = legacy) ──────────────

ALTER TABLE public.packages
  ADD COLUMN IF NOT EXISTS rate_card_id UUID REFERENCES public.rate_cards(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rate_card_version_id UUID REFERENCES public.rate_card_versions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rate_card_entry_id UUID REFERENCES public.rate_card_entries(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS pricing_kind TEXT
    CHECK (pricing_kind IS NULL OR pricing_kind IN ('weight', 'fixed', 'volume')),
  ADD COLUMN IF NOT EXISTS customer_price_model TEXT
    CHECK (customer_price_model IS NULL OR customer_price_model IN ('WEIGHT', 'VOLUME', 'FIXED')),
  ADD COLUMN IF NOT EXISTS customer_unit TEXT
    CHECK (customer_unit IS NULL OR customer_unit IN ('lb', 'ft3', 'package', 'piece')),
  ADD COLUMN IF NOT EXISTS customer_rate NUMERIC,
  ADD COLUMN IF NOT EXISTS customer_charge NUMERIC,
  ADD COLUMN IF NOT EXISTS provider_cost_model TEXT
    CHECK (provider_cost_model IS NULL OR provider_cost_model IN ('WEIGHT', 'VOLUME', 'FIXED')),
  ADD COLUMN IF NOT EXISTS provider_cost_unit TEXT
    CHECK (provider_cost_unit IS NULL OR provider_cost_unit IN ('lb', 'ft3', 'package', 'piece')),
  ADD COLUMN IF NOT EXISTS provider_rate NUMERIC,
  ADD COLUMN IF NOT EXISTS provider_cost NUMERIC,
  ADD COLUMN IF NOT EXISTS pricing_currency TEXT,
  ADD COLUMN IF NOT EXISTS priced_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS priced_by TEXT,
  ADD COLUMN IF NOT EXISTS pricing_snapshot JSONB;

CREATE INDEX IF NOT EXISTS idx_packages_pricing_kind
  ON public.packages (organization_id, pricing_kind)
  WHERE pricing_kind IS NOT NULL;

COMMENT ON COLUMN public.packages.customer_charge IS
  'Stored customer charge at creation (fixed pricing). NULL = legacy: invoices quote from rate tables.';
COMMENT ON COLUMN public.packages.pricing_snapshot IS
  'Full pricing context at creation (card refs, models, rates, inputs). Never backfilled — historical packages stay NULL.';
COMMENT ON COLUMN public.packages.pricing_currency IS
  'Currency of the stored charge (agency currency). Separate from the customer-facing invoice currency.';
