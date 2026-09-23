-- ============================================================================
-- package-create-manual-flow — cliente + estado inicial + evento de timeline
-- ============================================================================
-- Additive, idempotente, dueña de la rama feat/create-package-manual-flow.
-- Depende de 20260923015138 (package-create-hardening) que redefinió
-- create_package con resolución data-driven + preflight cross-org.
--
-- Contexto (Original Express, operación 100% manual sin scrap): al crear un
-- paquete a mano el flujo dejaba el paquete SIN cliente (y 'desconocido' por
-- default de columna), sin ninguna fila en el historial de eventos del paquete,
-- y el detalle mostraba "Scraped (Aéreo)" aunque nada se hubiera scrapeado.
--
-- Alcance:
--   1. p_client_id (obligatorio): el paquete manual SIEMPRE nace con cliente.
--      Validado contra billing_clients de LA MISMA agencia + active. El trigger
--      packages_client_same_org también valida, pero acá el raise es accionable.
--   2. p_status (opcional, validado contra el enum): se guarda en manual_status
--      (con _at/_by) — NUNCA en `status`, que es el valor "scraped"; así
--      effective_status = manual_status ?? status es correcto desde el minuto 0
--      y el guard packages_tenant_guard (no toca manual_status) lo preserva.
--   3. events: fila "creado manualmente por <actor>" (source='panel') en el
--      timeline del paquete, solo cuando la creación es REAL (xmax=0). Un merge
--      idempotente (misma guía + mismo provider re-enviada) no re-registra.

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
  p_provider_code    text default null,
  p_client_id        uuid default null,
  p_status           text default null
)
  returns json language plpgsql security definer set search_path = public, auth as $$
declare
  v_agency      text;
  v_by          text;
  v_provider    uuid;
  v_pkg_id      uuid;
  v_guia        text := p_almacen_id;
  v_foreign_id  uuid;
  v_foreign_org text;
  v_dup_id      uuid;
  v_dup_org     text;
  v_warning     text := null;
begin
  -- 1. Authorization: admin|staff only
  if not public.is_writer() then
    raise exception 'not authorized';
  end if;

  -- 2. Resolve agency + actor email from session (never from the payload)
  select coalesce(email, 'panel'), coalesce(agency, 'hit')
    into v_by, v_agency
    from public.app_users where id = auth.uid();
  if v_agency is null then
    raise exception 'user has no agency';
  end if;

  -- 2b. Cliente obligatorio y de esta tenant. El trigger packages_client_same_org
  --     da el fallback de integridad; este pre-check devuelve un error accionable.
  if p_client_id is null then
    raise exception 'client is required — create the client first (billing_clients)';
  end if;
  if not exists (
    select 1 from public.billing_clients
    where id = p_client_id
      and organization_id = v_agency
      and coalesce(active, true)
  ) then
    raise exception 'client % not found or not active for agency % — create the client first (billing_clients)', p_client_id, v_agency;
  end if;

  -- 2c. Estado inicial manual (opcional). Se persiste en manual_status para que
  --     el effective quede correcto desde el arranque sin pisar el espacio
  --     "scraped" de `status`.
  if p_status is not null
     and p_status not in ('en_almacen','parcial','en_transito','en_destino','entregado','excepcion','desconocido') then
    raise exception 'invalid status: % (expected en_almacen|parcial|en_transito|en_destino|entregado|excepcion|desconocido)', p_status;
  end if;

  -- 3. Resolve provider: el override debe ser un provider ACTIVO linkeado a ESTA
  --    agencia en la junction; si no, el default de la agencia (is_default); si
  --    no, error accionable apuntando al runbook de onboarding §2.5.
  if p_provider_code is not null then
    select pa.provider_id into v_provider
    from public.provider_agencies pa
    join public.providers p on p.id = pa.provider_id
    where pa.agency_slug = v_agency
      and p.code = p_provider_code
      and p.active;
    if v_provider is null then
      raise exception 'provider % is not available for agency % (docs/client-onboarding-runbook.md §2.5)', p_provider_code, v_agency;
    end if;
  else
    select pa.provider_id into v_provider
    from public.provider_agencies pa
    join public.providers p on p.id = pa.provider_id
    where pa.agency_slug = v_agency
      and pa.is_default
      and p.active
    limit 1;
    if v_provider is null then
      raise exception 'no default provider for agency % — set provider_agencies.is_default (docs/client-onboarding-runbook.md §2.5)', v_agency;
    end if;
  end if;

  -- 4. Insert (idempotente: merge en provider_id + almacen_id). El WHERE vuelve
  --    el merge un no-op para filas de OTRA tenant: jamás se sobrescribe un
  --    ledger ajeno. Sin id devuelto → se reporta abajo (un raise borraría el
  --    audit del mismo rollback).
  insert into public.packages as pk (
    provider_id, organization_id, almacen_id, tracking_number, service_type,
    referencia_name, casillero, weight_lb, pieces, volume_cf, dimensions,
    origin_office, dest_office, description, remitente, declared_value,
    photo_ref, received_at, last_event_at, scraped_at, updated_at,
    client_id, manual_status, manual_status_at, manual_status_by
  ) values (
    v_provider, v_agency, v_guia, p_tracking_number,
    p_service_type::public.service_type,
    p_referencia_name, p_casillero, p_weight_lb, p_pieces, p_volume_cf, p_dimensions,
    p_origin_office, p_dest_office, p_description, p_remitente, p_declared_value,
    p_photo_ref,
    p_received_at,
    p_received_at,
    now(),
    now(),
    p_client_id,
    p_status::public.shipment_status,
    case when p_status is null then null else now() end,
    case when p_status is null then null else v_by end
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
    where pk.organization_id = v_agency
  returning id into v_pkg_id;

  if v_pkg_id is null then
    -- Choque de ledger cross-tenant: bloquear + informar al admin (audit visible
    -- en Config > Auditoría). Devuelve error JSON en vez de raise (ver cabecera).
    select id, organization_id into v_foreign_id, v_foreign_org
    from public.packages
    where provider_id = v_provider and almacen_id = v_guia;

    insert into public.audit_logs (
      organization_id, actor_id, actor_email, actor_type,
      action, entity_type, entity_id, metadata
    ) values (
      v_agency, auth.uid(), v_by, 'user',
      'package.create.blocked_cross_org', 'package', v_foreign_id::text,
      jsonb_build_object(
        'almacen_id', v_guia,
        'provider_id', v_provider::text,
        'existing_organization_id', v_foreign_org
      )
    );

    return json_build_object(
      'error', 'cross_org_conflict',
      'almacen_id', v_guia,
      'message', format('guide %s already exists in tenant %s — creation blocked (manual writes never overwrite another tenant)', v_guia, v_foreign_org)
    );
  end if;

  -- 5. Tracking duplicado en otra org: se crea igual (avisar, no bloquear) +
  --    audit_logs (esta tenant) + events en la fila preexistente (su tenant
  --    verifica antes de entregar) + warning en la respuesta para el panel.
  if p_tracking_number is not null then
    select id, organization_id into v_dup_id, v_dup_org
    from public.packages
    where tracking_number = p_tracking_number
      and organization_id <> v_agency
      and deleted_at is null
    order by updated_at desc
    limit 1;

    if v_dup_id is not null then
      v_warning := format('tracking %s already exists in tenant %s', p_tracking_number, v_dup_org);

      insert into public.audit_logs (
        organization_id, actor_id, actor_email, actor_type,
        action, entity_type, entity_id, metadata
      ) values (
        v_agency, auth.uid(), v_by, 'user',
        'package.create.tracking_duplicate', 'package', v_pkg_id::text,
        jsonb_build_object(
          'tracking_number', p_tracking_number,
          'existing_package_id', v_dup_id::text,
          'existing_organization_id', v_dup_org
        )
      );

      insert into public.events (package_id, occurred_at, office, description, status, source)
      values (
        v_dup_id, now(), null,
        format('tracking %s also registered in another tenant — verify before delivery', p_tracking_number),
        null, 'system'
      );
    end if;
  end if;

  -- 6. Timeline: la creación manual SIEMPRE deja fila visible en el historial
  --    del paquete. xmax=0 ⇒ fila insertada en esta transacción (un merge
  --    idempotente de la misma guía no re-registra el evento).
  if (select xmax = 0 from public.packages where id = v_pkg_id) then
    insert into public.events (package_id, occurred_at, office, description, status, source)
    values (
      v_pkg_id, now(), null,
      'Paquete creado manualmente por ' || v_by,
      p_status::public.shipment_status,
      'panel'
    );
  end if;

  -- 7. Audit
  insert into public.audit_logs (
    organization_id, actor_id, actor_email, actor_type,
    action, entity_type, entity_id, metadata
  ) values (
    v_agency, auth.uid(), v_by, 'user',
    'package.create', 'package', v_pkg_id::text,
    jsonb_build_object(
      'almacen_id', v_guia,
      'provider_id', v_provider::text,
      'client_id', p_client_id::text,
      'manual_status', p_status,
      'tracking_number', p_tracking_number,
      'service_type', p_service_type,
      'weight_lb', p_weight_lb,
      'pieces', p_pieces
    )
  );

  return json_build_object(
    'id', v_pkg_id,
    'almacen_id', v_guia,
    'organization_id', v_agency,
    'warning', v_warning
  );
end $$;

grant execute on function public.create_package to authenticated;