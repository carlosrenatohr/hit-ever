-- Package edit RPCs: client assignment + durable service type override.
-- Phase 2: set_package_client (assign/clear billing client on a package).
-- Phase 3: service_type_override columns + set_package_service + effective_service_type.

-- ─── Phase 2: set_package_client ──────────────────────────────────────────────
-- SECURITY DEFINER: admin/staff only. Validates same-org, syncs referencia_name.
create or replace function public.set_package_client(
  p_guia      text,
  p_client_id uuid default null
)
  returns json
  language plpgsql
  security definer
  set search_path = public, auth
as $$
declare
  v_id          uuid;
  v_org         text;
  v_client_name text;
  v_actor       text;
begin
  if not public.is_staff() then
    raise exception 'not authorized';
  end if;

  select id, organization_id
    into v_id, v_org
    from public.packages
   where almacen_id = p_guia
     and deleted_at is null;

  if v_id is null then
    raise exception 'package % not found', p_guia;
  end if;

  select coalesce(email, 'panel') into v_actor
    from public.app_users
   where id = auth.uid();

  if p_client_id is not null then
    -- Validate client exists, is active, and belongs to the same org.
    select name into v_client_name
      from public.billing_clients
     where id = p_client_id
       and organization_id = v_org
       and deleted_at is null;

    if v_client_name is null then
      raise exception 'client % not found in organization %', p_client_id, v_org;
    end if;

    update public.packages
       set client_id        = p_client_id,
           referencia_name  = v_client_name,
           updated_at       = now()
     where id = v_id;

    return json_build_object(
      'guia',     p_guia,
      'clientId', p_client_id,
      'name',     v_client_name,
      'action',   'assigned'
    );
  else
    -- Clear client assignment.
    update public.packages
       set client_id  = null,
           updated_at = now()
     where id = v_id;

    return json_build_object(
      'guia',   p_guia,
      'action', 'cleared'
    );
  end if;
end;
$$;

grant execute on function public.set_package_client(text, uuid) to authenticated;

-- ─── Phase 3: service_type_override + effective_service_type ──────────────────
-- Mirror of manual_status/effective_status for service type.
alter table public.packages
  add column if not exists service_type_override public.service_type;

comment on column public.packages.service_type_override is
  'Manual override for service type (aereo/maritimo). Takes precedence over scraped service_type when non-null.';

alter table public.packages
  add column if not exists service_type_override_by text;

alter table public.packages
  add column if not exists service_type_override_at timestamptz;

-- Stored generated column: coalesce(override, scraped). Read by panel + billing.
alter table public.packages
  add column if not exists effective_service_type public.service_type
  generated always as (coalesce(service_type_override, service_type)) stored;

comment on column public.packages.effective_service_type is
  'Effective service type: manual override if set, otherwise the scraped value. Read by panel, billing, and reports.';

create index if not exists idx_packages_effective_service
  on public.packages (effective_service_type);

-- ─── set_package_service RPC ─────────────────────────────────────────────────
create or replace function public.set_package_service(
  p_guia         text,
  p_service_type text default null
)
  returns json
  language plpgsql
  security definer
  set search_path = public, auth
as $$
declare
  v_id    uuid;
  v_actor text;
begin
  if not public.is_staff() then
    raise exception 'not authorized';
  end if;

  select id into v_id
    from public.packages
   where almacen_id = p_guia
     and deleted_at is null;

  if v_id is null then
    raise exception 'package % not found', p_guia;
  end if;

  select coalesce(email, 'panel') into v_actor
    from public.app_users
   where id = auth.uid();

  if p_service_type is not null and p_service_type not in ('aereo', 'maritimo') then
    raise exception 'invalid service_type: % (expected aereo or maritimo)', p_service_type;
  end if;

  update public.packages
     set service_type_override     = p_service_type::public.service_type,
         service_type_override_by  = v_actor,
         service_type_override_at  = now(),
         updated_at                = now()
   where id = v_id;

  return json_build_object(
    'guia',         p_guia,
    'serviceType',  p_service_type,
    'action',       case when p_service_type is null then 'cleared' else 'set' end
  );
end;
$$;

grant execute on function public.set_package_service(text, text) to authenticated;

-- ─── Refresh billing customer_weight_stats + customer_aggregate_stats ────────
-- Update functions to use effective_service_type instead of service_type so
-- manual service edits are reflected in customer stats and KPI cards.
create or replace function public.customer_weight_stats(
  p_org  text,
  p_from date default null,
  p_to   date default null
)
  returns json
  language sql
  stable
  security definer
  set search_path = public, auth
as $$
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
           sum(p.weight_lb)                                                   as w,
           sum(p.weight_lb) filter (where p.effective_service_type = 'maritimo') as wm,
           sum(p.weight_lb) filter (where p.effective_service_type = 'aereo')    as wa,
           count(*)                                                           as ct,
           count(*) filter (where p.effective_service_type = 'maritimo')       as cm,
           count(*) filter (where p.effective_service_type = 'aereo')          as ca
    from public.packages p
    where p.organization_id = p_org
      and p.deleted_at is null
      and public.client_is_active(p.client_id)
      and (p_from is null or p.received_at >= p_from)
      and (p_to is null or p.received_at < p_to + 1)
    group by p.client_id
  ) g on g.client_id = c.id
  where c.organization_id = p_org
    and c.deleted_at is null
$$;

grant execute on function public.customer_weight_stats(text, date, date) to authenticated;

create or replace function public.customer_aggregate_stats(
  p_org  text,
  p_from date default null,
  p_to   date default null
)
  returns json
  language sql
  stable
  security definer
  set search_path = public, auth
as $$
  select json_build_object(
    'totalWeightLb',       coalesce(sum(p.weight_lb), 0),
    'weightMaritimo',      coalesce(sum(p.weight_lb) filter (where p.effective_service_type = 'maritimo'), 0),
    'weightAereo',         coalesce(sum(p.weight_lb) filter (where p.effective_service_type = 'aereo'), 0),
    'packageCountTotal',   count(*),
    'packageCountMaritimo', count(*) filter (where p.effective_service_type = 'maritimo'),
    'packageCountAereo',   count(*) filter (where p.effective_service_type = 'aereo'),
    'topMaritimo', (select json_build_object('clientId', c.id, 'name', c.name, 'weightLb', t.w)
                    from (select p2.client_id, sum(p2.weight_lb) w
                          from public.packages p2
                          where p2.organization_id = p_org
                            and p2.deleted_at is null
                            and p2.effective_service_type = 'maritimo'
                            and public.client_is_active(p2.client_id)
                            and (p_from is null or p2.received_at >= p_from)
                            and (p_to is null or p2.received_at < p_to + 1)
                          group by p2.client_id order by w desc limit 1) t
                    join public.billing_clients c on c.id = t.client_id),
    'topAereo', (select json_build_object('clientId', c.id, 'name', c.name, 'weightLb', t.w)
                 from (select p2.client_id, sum(p2.weight_lb) w
                       from public.packages p2
                       where p2.organization_id = p_org
                         and p2.deleted_at is null
                         and p2.effective_service_type = 'aereo'
                         and public.client_is_active(p2.client_id)
                         and (p_from is null or p2.received_at >= p_from)
                         and (p_to is null or p2.received_at < p_to + 1)
                       group by p2.client_id order by w desc limit 1) t
                 join public.billing_clients c on c.id = t.client_id)
  )
  from public.packages p
  where p.organization_id = p_org
    and p.deleted_at is null
    and (p_from is null or p.received_at >= p_from)
    and (p_to is null or p.received_at < p_to + 1)
$$;

grant execute on function public.customer_aggregate_stats(text, date, date) to authenticated;
