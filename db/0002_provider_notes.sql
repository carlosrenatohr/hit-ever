-- ============================================================================
-- Provider notes log (read-only mirror of Cargotrack's "Notas" per package)
-- ============================================================================
-- Stores each note as scraped from the detail page ("Freight received",
-- "Loaded on LG-…", "> RETIRADO", etc.) for internal control and decisions.
-- This is separate from HIT's OWN future notes/custom fields. RLS default-deny
-- (only the Worker's service key reads/writes).

create table if not exists package_provider_notes (
  id          uuid primary key default gen_random_uuid(),
  package_id  uuid not null references packages(id) on delete cascade,
  body        text not null,
  author      text,
  noted_at    text,                               -- raw source date, e.g. "5/28/2026 11:32:00 AM"
  scraped_at  timestamptz not null default now(),
  unique (package_id, body, author, noted_at)     -- dedup on re-scrape
);

create index if not exists idx_provnotes_package on package_provider_notes (package_id);

alter table package_provider_notes enable row level security;
