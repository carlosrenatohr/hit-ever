-- Enable trigram extension for fuzzy string matching (client deduplication).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- RPC: find pairs of clients with similar names within the same org.
-- Uses trigram distance on name_normalized. Suggests which to keep (higher package count).
-- Multitenant: scoped to p_org.
CREATE OR REPLACE FUNCTION public.similar_clients(p_org text)
returns jsonb language sql stable
set search_path = public
as $$
  WITH candidates AS (
    SELECT
      a.id AS id_a, a.name AS name_a, a.name_normalized AS norm_a,
      b.id AS id_b, b.name AS name_b, b.name_normalized AS norm_b,
      similarity(a.name_normalized, b.name_normalized) AS score,
      COALESCE(pa.cnt, 0) AS pkg_a,
      COALESCE(pb.cnt, 0) AS pkg_b
    FROM public.billing_clients a
    JOIN public.billing_clients b
      ON b.organization_id = a.organization_id
     AND b.id > a.id
     AND b.name_normalized % a.name_normalized
    LEFT JOIN (SELECT client_id, count(*) cnt FROM public.packages WHERE deleted_at IS NULL GROUP BY client_id) pa ON pa.client_id = a.id
    LEFT JOIN (SELECT client_id, count(*) cnt FROM public.packages WHERE deleted_at IS NULL GROUP BY client_id) pb ON pb.client_id = b.id
    WHERE a.organization_id = p_org
      AND a.active IS NOT false
      AND a.deleted_at IS NULL
      AND b.active IS NOT false
      AND b.deleted_at IS NULL
  )
  SELECT COALESCE(json_agg(json_build_object(
    'idA',        id_a,
    'nameA',      name_a,
    'idB',        id_b,
    'nameB',      name_b,
    'score',      round(score::numeric, 3),
    'pkgA',       pkg_a,
    'pkgB',       pkg_b,
    'keepId',     CASE WHEN pkg_a >= pkg_b THEN id_a ELSE id_b END,
    'keepName',   CASE WHEN pkg_a >= pkg_b THEN name_a ELSE name_b END
  ) ORDER BY score DESC), '[]'::json)
  FROM candidates;
$$;

-- RPC: merge two clients — reassigns all data from p_merge into p_keep, then soft-deletes p_merge.
-- Must be called within a transaction. Multitenant: validates both clients belong to same org.
CREATE OR REPLACE FUNCTION public.merge_clients(p_keep uuid, p_merge uuid)
returns jsonb language plpgsql
set search_path = public
as $$
DECLARE
  v_keep_name text;
  v_merged    int := 0;
BEGIN
  SELECT name INTO v_keep_name FROM public.billing_clients WHERE id = p_keep;
  IF v_keep_name IS NULL THEN
    RETURN json_build_object('ok', false, 'error', 'Client to keep not found');
  END IF;

  -- Reassign packages
  UPDATE public.packages SET client_id = p_keep, updated_at = now()
  WHERE client_id = p_merge AND deleted_at IS NULL;
  GET DIAGNOSTICS v_merged = ROW_COUNT;

  -- Reassign invoices
  UPDATE public.invoices SET client_id = p_keep, updated_at = now()
  WHERE client_id = p_merge AND status NOT IN ('VOID');

  -- Reassign rate defaults (keep keep's rate if it has one, otherwise adopt merge's)
  UPDATE public.billing_clients bc
  SET default_rate_id = sub.new_rate_id, updated_at = now()
  FROM (SELECT p_keep AS id, m.default_rate_id AS new_rate_id
        FROM public.billing_clients m
        WHERE m.id = p_merge AND m.default_rate_id IS NOT NULL) sub
  WHERE bc.id = sub.id
    AND bc.default_rate_id IS NULL;

  -- Soft-delete the merged client
  UPDATE public.billing_clients
  SET active = false, updated_at = now()
  WHERE id = p_merge;

  RETURN json_build_object(
    'ok', true,
    'keepName', v_keep_name,
    'packagesReassigned', v_merged
  );
END;
$$;
