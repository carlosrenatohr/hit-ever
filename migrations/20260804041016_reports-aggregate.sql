-- reports_aggregate: server-side aggregation for the Reports panel.
-- Replaces client-side truncation-at-5000 when filtering packages by status/provider/service/date-range.
-- Mirrors the filter logic of hit-panel's listPackages (src/lib/insforge.ts).
-- Patrón: plpgsql + is_staff() guard + SECURITY DEFINER (como dashboard_stats).

CREATE OR REPLACE FUNCTION public.reports_aggregate(
  p_provider_id bigint default null,
  p_status public.shipment_status default null,
  p_service text default null,
  p_search text default null,
  p_from date default null,
  p_to date default null
) returns json
language plpgsql stable security definer
as $func$
DECLARE
  srch text := null;
  out_val json;
BEGIN
  IF NOT public.is_staff() THEN
    RAISE EXCEPTION 'insufficient_permissions';
  END IF;

  IF p_search IS NOT NULL AND trim(p_search) <> '' THEN
    srch := '%' || trim(both '()' from replace(p_search, '*', '')) || '%';
  END IF;

  SELECT json_build_object(
    'total', count(*),
    'by_status', coalesce((select json_object_agg(s, c) from (
      select coalesce(manual_status, status)::text s, count(*) c from public.packages
      where (p_provider_id IS NULL OR provider_id = p_provider_id)
        AND (p_status IS NULL OR coalesce(manual_status, status) = p_status)
        AND (p_service IS NULL OR service_type = p_service)
        AND (p_from IS NULL OR received_at >= p_from)
        AND (p_to IS NULL OR received_at < p_to + interval '1 day')
        AND (srch IS NULL OR almacen_id ilike srch OR tracking_number ilike srch OR casillero ilike srch OR referencia_name ilike srch)
      group by 1) t), '{}'::json),
    'by_provider', coalesce((select json_object_agg(code, c) from (
      select pr.code, count(*) c from public.packages x join public.providers pr on pr.id = x.provider_id
      where (p_provider_id IS NULL OR x.provider_id = p_provider_id)
        AND (p_status IS NULL OR coalesce(x.manual_status, x.status) = p_status)
        AND (p_service IS NULL OR x.service_type = p_service)
        AND (p_from IS NULL OR x.received_at >= p_from)
        AND (p_to IS NULL OR x.received_at < p_to + interval '1 day')
        AND (srch IS NULL OR x.almacen_id ilike srch OR x.tracking_number ilike srch OR x.casillero ilike srch OR x.referencia_name ilike srch)
      group by pr.code) t), '{}'::json'),
    'by_service', coalesce((select json_object_agg(svc, c) from (
      select coalesce(service_type, '—') svc, count(*) c from public.packages
      where (p_provider_id IS NULL OR provider_id = p_provider_id)
        AND (p_status IS NULL OR coalesce(manual_status, status) = p_status)
        AND (p_service IS NULL OR service_type = p_service)
        AND (p_from IS NULL OR received_at >= p_from)
        AND (p_to IS NULL OR received_at < p_to + interval '1 day')
        AND (srch IS NULL OR almacen_id ilike srch OR tracking_number ilike srch OR casillero ilike srch OR referencia_name ilike srch)
      group by 1) t), '{}'::json'),
    'received_by_month', coalesce((select json_object_agg(m, c) from (
      select to_char(received_at, 'YYYY-MM') m, count(*) c from public.packages
      where received_at IS NOT NULL
        AND (p_provider_id IS NULL OR provider_id = p_provider_id)
        AND (p_status IS NULL OR coalesce(manual_status, status) = p_status)
        AND (p_service IS NULL OR service_type = p_service)
        AND (p_from IS NULL OR received_at >= p_from)
        AND (p_to IS NULL OR received_at < p_to + interval '1 day')
        AND (srch IS NULL OR almacen_id ilike srch OR tracking_number ilike srch OR casillero ilike srch OR referencia_name ilike srch)
      group by 1) t), '{}'::json')
  )
  INTO out_val
  FROM (SELECT 1 FROM public.packages WHERE 1=1 LIMIT 1) _;

  RETURN out_val;
END;
$func$;

revoke execute on function public.reports_aggregate(bigint, public.shipment_status, text, text, date, date) from public;
grant execute on function public.reports_aggregate(bigint, public.shipment_status, text, text, date, date) to authenticated;
