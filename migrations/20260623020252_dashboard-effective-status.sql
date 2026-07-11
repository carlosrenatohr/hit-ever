-- Effective status as a stored generated column so the dashboard can filter/sort/index on the
-- status the customer actually sees (manual override wins over the scraped status).
alter table public.packages
  add column if not exists effective_status public.shipment_status
  generated always as (coalesce(manual_status, status)) stored;

create index if not exists idx_packages_effective_status on public.packages (effective_status);
create index if not exists idx_packages_received_at on public.packages (received_at desc);
create index if not exists idx_packages_tracking on public.packages (tracking_number);
