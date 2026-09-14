-- RPC: list unassigned packages (no client_id) for a given org + date range.
-- Returns a small sample for the dashboard CTA + full count.
-- Multitenant: scoped to p_org, date-range on received_at.

CREATE OR REPLACE FUNCTION public.unassigned_packages(
  p_org   text,
  p_from  date default null,
  p_to    date default null,
  p_limit int  default 50
)
returns jsonb language sql stable
set search_path = public
as $$
  with unassigned as (
    select p.id, p.almacen_id, p.tracking_number, p.referencia_name,
           p.received_at, p.effective_service_type, p.weight_lb
    from public.packages p
    where p.organization_id = p_org
      and p.deleted_at is null
      and p.client_id is null
      and (p_from is null or p.received_at >= p_from)
      and (p_to   is null or p.received_at < p_to + 1)
    order by p.received_at desc nulls last
  ),
  total as (select count(*) as count from unassigned),
  sample as (select coalesce(json_agg(t), '[]'::json) as items
             from (select * from unassigned limit p_limit) t)
  select json_build_object(
    'count',  (select count from total),
    'sample', (select items from sample)
  );
$$;
