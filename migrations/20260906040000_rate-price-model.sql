-- ============================================================================
-- Rate price model: weight (per lb), volume (per ft³), fixed (per package)
-- ============================================================================
-- Currently rate_rows.price is always USD/lb and computeAmounts always does
-- total = quantity_lbs * unit_price. Adding a price_model column lets agencies
-- price by weight, by volume (ft³), or a fixed amount per package — without
-- changing the money fields on existing rows (they all default to 'weight').
--
-- 'weight': total = quantity_lbs × price   (current behavior, zero migration)
-- 'volume': total = volume_cf × price      (panel sends volume_cf as quantity)
-- 'fixed':  total = price                  (panel sends 1 as quantity)

alter table rate_rows
  add column if not exists price_model text not null default 'weight'
  check (price_model in ('weight', 'volume', 'fixed'));

comment on column rate_rows.price_model is
  'How this row prices a line: weight (USD/lb, default), volume (USD/ft³), or fixed (USD/package).';

-- Existing rows are all weight-priced — the default handles it. No backfill.
