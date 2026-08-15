-- ============================================================================
-- create_package RPC -- tenant-scoped, idempotent manual package creation
-- ============================================================================
-- SECURITY DEFINER RPC that lets panel users (admin|staff) create packages
-- manually, mirroring what the scraper does via toPackageRow().
--
-- - organization_id resolves from app_users.agency (NEVER from the payload).
-- - provider_id resolves from the agency: hit -> everest, suite -> suite_demo
--   (or p_provider_code override if given and active).
-- - Idempotency: ON CONFLICT (provider_id, almacen_id) DO UPDATE sets the
--   mutable fields, so re-submitting the same guia from the same tenant
--   is a no-op (or update, preserving events + notes).
-- - Audit: single insert into audit_logs in the same transaction.
--
-- Follows the pattern of set_manual_status / add_package_tag / add_package_note
-- from migration 20260814214034_config-module.sql.
-- ============================================================================

create or replace function public.create_package(
  p_almacen_id       text,
  p_tracking_number  text default null,
  p_service_type     text default null,
  p_referencia_name  text default null,
  p_casillero        text default null,
  p_weight_lb        numeric default null,
  p_pieces           integer default null,
  p_volume_cf        numeric default null,
  p_dimensions       text default null,
  p_origin_office    text default null,
  p_dest_office      text default null,
  p_description      text default null,
  p_remitente        text default null,
  p_declared_value   numeric default null,
  p_photo_ref        text default null,
  p_received_at      timestamptz default null,
  p_provider_code    text default null
)
  returns json language plpgsql security definer set search_path = public, auth as $$
declare
  v_agency   text;
  v_by       text;
  v_provider uuid;
  v_pkg_id   uuid;
  v_guia     text := p_almacen_id;
begin
  -- 1. Authorization: admin|staff only
  if not public.is_writer() then
    raise exception 'not authorized';
  end if;

  -- 2. Resolve agency + actor email from session
  select coalesce(email, 'panel'), coalesce(agency, 'hit')
    into v_by, v_agency
    from public.app_users where id = auth.uid();
  if v_agency is null then
    raise exception 'user has no agency';
  end if;

  -- 3. Resolve provider_id: prefer p_provider_code override if given and active,
  --    otherwise pick the default provider for the agency.
  if p_provider_code is not null then
    select id into v_provider
    from public.providers
    where code = p_provider_code and active;
    if v_provider is null then
      raise exception 'provider % not found or inactive', p_provider_code;
    end if;
  else
    select id into v_provider
    from public.providers
    where active
      and (case v_agency
             when 'hit'   then code = 'everest'
             when 'suite' then code = 'suite_demo'
             else false
           end)
    limit 1;
    if v_provider is null then
      raise exception 'no active provider for agency %', v_agency;
    end if;
  end if;

  -- 4. Insert (idempotent: merge on provider_id + almacen_id)
  insert into public.packages (
    provider_id, organization_id, almacen_id, tracking_number, service_type,
    referencia_name, casillero, weight_lb, pieces, volume_cf, dimensions,
    origin_office, dest_office, description, remitente, declared_value,
    photo_ref, received_at, last_event_at, scraped_at, updated_at
  ) values (
    v_provider, v_agency, v_guia, p_tracking_number,
    p_service_type::public.service_type,
    p_referencia_name, p_casillero, p_weight_lb, p_pieces, p_volume_cf, p_dimensions,
    p_origin_office, p_dest_office, p_description, p_remitente, p_declared_value,
    p_photo_ref,
    p_received_at,
    p_received_at,
    now(),
    now(), now()
  )
  on conflict (provider_id, almacen_id) do update
    set tracking_number  = excluded.tracking_number,
        service_type     = excluded.service_type,
        referencia_name  = excluded.referencia_name,
        casillero        = excluded.casillero,
        weight_lb        = excluded.weight_lb,
        pieces           = excluded.pieces,
        volume_cf        = excluded.volume_cf,
        dimensions       = excluded.dimensions,
        origin_office    = excluded.origin_office,
        dest_office      = excluded.dest_office,
        description      = excluded.description,
        remitente        = excluded.remitente,
        declared_value   = excluded.declared_value,
        photo_ref        = excluded.photo_ref,
        scraped_at       = excluded.scraped_at,
        updated_at       = now()
  returning id into v_pkg_id;

  -- 5. Audit
  insert into public.audit_logs (
    organization_id, actor_id, actor_email, actor_type,
    action, entity_type, entity_id, metadata
  ) values (
    v_agency, auth.uid(), v_by, 'user',
    'package.create', 'package', v_pkg_id::text,
    jsonb_build_object(
      'almacen_id', v_guia,
      'provider_id', v_provider::text,
      'tracking_number', p_tracking_number,
      'service_type', p_service_type,
      'weight_lb', p_weight_lb,
      'pieces', p_pieces
    )
  );

  return json_build_object(
    'id', v_pkg_id,
    'almacen_id', v_guia,
    'organization_id', v_agency
  );
end $$;

grant execute on function public.create_package to authenticated;
