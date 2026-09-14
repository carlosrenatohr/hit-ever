-- Match unassigned packages to billing_clients by normalized referencia_name.
-- Creates missing clients (Allan Arauz, Shane Rodriguez, Stephanie Montenegro)
-- and flags unmatchable packages via package_tags.
-- Multitenant: matches within each package's own organization_id.

-- 1. Assign client_id where normalized(referencia_name) matches billing_clients.name_normalized.
UPDATE public.packages p
SET client_id = c.id,
    updated_at = now()
FROM public.billing_clients c
WHERE p.client_id IS NULL
  AND p.deleted_at IS NULL
  AND p.referencia_name IS NOT NULL
  AND c.organization_id = p.organization_id
  AND c.name_normalized = lower(trim(regexp_replace(p.referencia_name, '\s+', ' ', 'g')));

-- 2. Create missing billing_clients (from Excel review, flagged for staff validation).
-- Uses ON CONFLICT to be idempotent.
WITH new_clients(id, name, name_normalized, org) AS (
  VALUES
    ('a0b1c2d3-0001-4000-8000-000000000001'::uuid, 'Allan Arauz',           'allan arauz',           'hit'),
    ('a0b1c2d3-0002-4000-8000-000000000002'::uuid, 'Shane Rodriguez',       'shane rodriguez',       'hit'),
    ('a0b1c2d3-0003-4000-8000-000000000003'::uuid, 'Stephanie Montenegro',  'stephanie montenegro',  'hit')
)
INSERT INTO public.billing_clients (id, name, name_normalized, to_review, organization_id, created_at, updated_at)
SELECT id, name, name_normalized, true, org, now(), now()
FROM new_clients
ON CONFLICT (organization_id, name_normalized) DO NOTHING;

-- 3. Link packages to newly created clients by referência → client match.
UPDATE public.packages p
SET client_id = c.id,
    updated_at = now()
FROM public.billing_clients c
WHERE p.client_id IS NULL
  AND p.deleted_at IS NULL
  AND c.organization_id = p.organization_id
  AND c.name_normalized = lower(trim(regexp_replace(p.referencia_name, '\s+', ' ', 'g')));

-- 4. Tag remaining unassigned packages for staff review.
-- Uses LEFT JOIN to avoid duplicates (no unique constraint on package_id+label).
INSERT INTO public.package_tags (id, package_id, label, value, created_at)
SELECT gen_random_uuid(), p.id, 'to-review', 'client', now()
FROM public.packages p
WHERE p.client_id IS NULL
  AND p.deleted_at IS NULL
  AND p.referencia_name IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.package_tags pt
    WHERE pt.package_id = p.id AND pt.label = 'to-review' AND pt.value = 'client'
  );
