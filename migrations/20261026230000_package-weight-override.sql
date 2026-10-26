-- ============================================================================
-- weight_override — el peso editado a mano sobrevive al scrape
-- ============================================================================
-- Panel → set_package_weight (security definer, owner project_admin) escribe
-- weight_override_lb en vez de weight_lb; el ingest (merge-duplicates) solo
-- envía weight_lb en el payload, así que el override nunca lo pisa.
--
-- effective_weight_lb es GENERATED: coalesce(weight_override_lb, weight_lb),
-- inmutable — las lecturas (billing, panel, stats) lo consumen directo sin
-- repetir el coalesce en cada query.
--
-- Aditiva e idempotente; dueña de la rama feat/weight-override. Reemplaza
-- set_package_weight (misma firma: p_guia, p_weight_lb → el panel no cambia
-- la llamada) y las RPCs de peso/lectura (sums y muestra) para usar el peso
-- efectivo. El cambio queda en package_notes + audit_logs, como antes.

alter table packages
  add column if not exists weight_override_lb numeric;

comment on column packages.weight_override_lb is
  'Peso fijado por el staff (set_package_weight). El scrape no lo toca: el ingest solo envía weight_lb en el payload de merge-duplicates.';

alter table packages
  add column if not exists effective_weight_lb numeric
  generated always as (coalesce(weight_override_lb, weight_lb)) stored;

comment on column packages.effective_weight_lb is
  'Peso con el que se factura y se reporta: override del staff si existe, si no el scrapeado.';

-- ─── set_package_weight: escribe el override ────────────────────────────────
-- Misma firma que 20260929105752 (p_guia, p_weight_lb); "previous" es el
-- efectivo anterior, para que el rastro sea legible incluso tras un scrape.

create or replace function public.set_package_weight(
  p_guia      text,
  p_weight_lb numeric
)
  returns json
  language plpgsql
  security definer
  set search_path = public, auth
as $$
declare
  v_id    uuid;
  v_org   text;
  v_actor text;
  v_prev  numeric;
begin
  if not public.is_writer() then
    raise exception 'No tenés permisos para realizar esta acción.';
  end if;

  if p_weight_lb is null or p_weight_lb <= 0 then
    raise exception 'El peso debe ser mayor a cero.';
  end if;

  select coalesce(email, 'panel'), coalesce(agency, 'hit')
    into v_actor, v_org
    from public.app_users
   where id = auth.uid();

  -- Guía es identidad única por tenant (ADR-013); SECURITY DEFINER ⇒ filtro org obligatorio.
  select id, effective_weight_lb into v_id, v_prev
    from public.packages
   where almacen_id = p_guia
     and organization_id = v_org
     and deleted_at is null;

  if v_id is null then
    raise exception 'No encontramos la guía % en tu agencia.', p_guia;
  end if;

  update public.packages
     set weight_override_lb = p_weight_lb,
         updated_at = now()
   where id = v_id;

  -- Historial legible en el detalle del paquete (pane "Etiquetas y notas internas").
  insert into public.package_notes (package_id, body, created_by)
  values (
    v_id,
    'Peso fijado a mano: ' || coalesce(v_prev::text, 'sin peso') || ' → ' || p_weight_lb::text || ' lb (el scrape ya no lo pisa)',
    v_actor
  );

  insert into public.audit_logs
    (organization_id, actor_id, actor_email, actor_type, action, entity_type, entity_id, metadata)
  values
    (v_org, auth.uid(), v_actor, 'user', 'set_package_weight', 'package', p_guia,
     jsonb_build_object('from', v_prev, 'to', p_weight_lb));

  return json_build_object('guia', p_guia, 'weightLb', p_weight_lb, 'previousLb', v_prev);
end;
$$;

-- ─── customer_weight_stats: sums con el peso efectivo ───────────────────────

CREATE OR REPLACE FUNCTION public.customer_weight_stats(p_org text, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date)
 RETURNS json
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
  select coalesce(json_object_agg(c.id, json_build_object(
    'clientId',       c.id,
    'name',           c.name,
    'weightLb',       coalesce(g.w, 0),
    'weightMaritimo', coalesce(g.wm, 0),
    'weightAereo',    coalesce(g.wa, 0),
    'countTotal',     coalesce(g.ct, 0),
    'countMaritimo',  coalesce(g.cm, 0),
    'countAereo',     coalesce(g.ca, 0)
  )), '{}'::json)
  from public.billing_clients c
  left join (
    select p.client_id,
           sum(p.effective_weight_lb)                                                       as w,
           sum(p.effective_weight_lb) filter (where p.effective_service_type = 'maritimo')  as wm,
           sum(p.effective_weight_lb) filter (where p.effective_service_type = 'aereo')     as wa,
           count(*)                                                               as ct,
           count(*) filter (where p.effective_service_type = 'maritimo')          as cm,
           count(*) filter (where p.effective_service_type = 'aereo')             as ca
    from public.packages p
    where p.organization_id = p_org
      and p.deleted_at is null
      and public.client_is_active(p.client_id)
      and (p_from is null or coalesce(p.received_at, p.updated_at) >= p_from)
      and (p_to is null or coalesce(p.received_at, p.updated_at) < p_to + 1)
    group by p.client_id
  ) g on g.client_id = c.id
  where c.organization_id = p_org
    and c.deleted_at is null
$function$;

-- ─── customer_aggregate_stats: totals + tops con el peso efectivo ───────────

CREATE OR REPLACE FUNCTION public.customer_aggregate_stats(p_org text, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date, p_status text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select json_build_object(
    'totalWeightLb',       coalesce(sum(p.effective_weight_lb), 0),
    'weightMaritimo',      coalesce(sum(p.effective_weight_lb) filter (where p.effective_service_type = 'maritimo'), 0),
    'weightAereo',         coalesce(sum(p.effective_weight_lb) filter (where p.effective_service_type = 'aereo'), 0),
    'packageCountTotal',   count(*),
    'packageCountMaritimo', count(*) filter (where p.effective_service_type = 'maritimo'),
    'packageCountAereo',   count(*) filter (where p.effective_service_type = 'aereo'),
    'topMaritimo', (select json_build_object('clientId', c.id, 'name', c.name, 'weightLb', t.w)
                    from (select p2.client_id, sum(p2.effective_weight_lb) w
                          from public.packages p2
                          where p2.organization_id = p_org
                            and p2.deleted_at is null
                            and p2.client_id is not null
                            and public.client_matches_status(p2.client_id, p_status)
                            and p2.effective_service_type = 'maritimo'
                            and (p_from is null or coalesce(p2.received_at, p2.updated_at) >= p_from)
                            and (p_to is null or coalesce(p2.received_at, p2.updated_at) < p_to + 1)
                          group by p2.client_id order by w desc nulls last limit 1) t
                    join public.billing_clients c on c.id = t.client_id),
    'topAereo', (select json_build_object('clientId', c.id, 'name', c.name, 'weightLb', t.w)
                 from (select p3.client_id, sum(p3.effective_weight_lb) w
                       from public.packages p3
                       where p3.organization_id = p_org
                         and p3.deleted_at is null
                         and p3.client_id is not null
                         and public.client_matches_status(p3.client_id, p_status)
                         and p3.effective_service_type = 'aereo'
                         and (p_from is null or coalesce(p3.received_at, p3.updated_at) >= p_from)
                         and (p_to is null or coalesce(p3.received_at, p3.updated_at) < p_to + 1)
                       group by p3.client_id order by w desc nulls last limit 1) t
                 join public.billing_clients c on c.id = t.client_id),
    'topBillingMaritimo', (select json_build_object('clientId', c.id, 'name', c.name, 'weightLb', t.w)
                           from (select p4.client_id, sum(p4.effective_weight_lb) w
                                 from public.packages p4
                                 inner join public.invoice_packages ip on ip.package_id = p4.id and ip.active = true
                                 inner join public.invoices i on i.id = ip.invoice_id and i.status <> 'VOID'
                                 where p4.organization_id = p_org
                                   and p4.deleted_at is null
                                   and p4.client_id is not null
                                   and public.client_matches_status(p4.client_id, p_status)
                                   and p4.effective_service_type = 'maritimo'
                                   and (p_from is null or coalesce(p4.received_at, p4.updated_at) >= p_from)
                                   and (p_to is null or coalesce(p4.received_at, p4.updated_at) < p_to + 1)
                                 group by p4.client_id order by w desc nulls last limit 1) t
                           join public.billing_clients c on c.id = t.client_id),
    'topBillingAereo', (select json_build_object('clientId', c.id, 'name', c.name, 'weightLb', t.w)
                        from (select p5.client_id, sum(p5.effective_weight_lb) w
                              from public.packages p5
                              inner join public.invoice_packages ip on ip.package_id = p5.id and ip.active = true
                              inner join public.invoices i on i.id = ip.invoice_id and i.status <> 'VOID'
                              where p5.organization_id = p_org
                                and p5.deleted_at is null
                                and p5.client_id is not null
                                and public.client_matches_status(p5.client_id, p_status)
                                and p5.effective_service_type = 'aereo'
                                and (p_from is null or coalesce(p5.received_at, p5.updated_at) >= p_from)
                                and (p_to is null or coalesce(p5.received_at, p5.updated_at) < p_to + 1)
                              group by p5.client_id order by w desc nulls last limit 1) t
                        join public.billing_clients c on c.id = t.client_id)
  )
  from public.packages p
  where p.organization_id = p_org
    and p.deleted_at is null
    and public.client_matches_status(p.client_id, p_status)
    and (p_from is null or coalesce(p.received_at, p.updated_at) >= p_from)
    and (p_to is null or coalesce(p.received_at, p.updated_at) < p_to + 1)
$function$;

-- ─── unassigned_packages: la muestra usa el peso efectivo ───────────────────

CREATE OR REPLACE FUNCTION public.unassigned_packages(
  p_org   text,
  p_from  date,
  p_to    date,
  p_limit int
)
returns jsonb language sql stable
set search_path = public
as $$
  with unassigned as (
    select p.id, p.almacen_id, p.tracking_number, p.referencia_name,
           p.received_at, p.effective_service_type, p.effective_weight_lb
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
