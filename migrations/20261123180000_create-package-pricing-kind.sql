-- ============================================================================
-- create_package_v2: el tipo de tarifa elegido manda (weight vs fixed)
-- ============================================================================
-- Owner branch: fix/worker-package-pricing-kind.
--
-- Por qué una función nueva y no un parámetro más en create_package:
--   * create_package tiene DOS firmas en producción (19 args, owner postgres; y
--     20 args con p_rate_card_id, owner project_admin). Agregar una tercera
--     firma de 21 args con default deja a PostgREST sin candidato único
--     (PGRST203) para la llamada de 20 args que hace el panel.
--   * La firma de 19 args no se puede dropear desde la CLI (owner postgres).
--   Por eso v2 nace con nombre propio y create_package queda intacta; el panel
--   la usa desde este cambio y la vieja solo sirve a builds previos.
--
-- Bug que corrige: con flexible pricing encendido, todo paquete con
-- service_type (aereo|maritimo) auto-resolvía la tarjeta FIJA del cliente o de
-- la agencia y se guardaba como cuota fija, aunque el operador eligiera "Por
-- peso". pricing_kind no es editable después, así que el dato quedaba cruzado.
--
-- Reglas:
--   * p_pricing_kind = 'weight' → no se resuelve ninguna tarjeta fija. Cargar
--     p_rate_card_id junto a weight es un error explícito.
--   * p_pricing_kind = 'fixed'  → resolución fija de siempre (tarjeta explícita
--     → asignación del cliente → default de la agencia).
--   * p_pricing_kind = null     → comportamiento legacy (auto-resolución fija).
--
-- ROLLBACK: drop function public.create_package_v2(...) y el panel vuelve a
-- llamar create_package.
-- ============================================================================

create or replace function public.create_package_v2(
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
  p_status           text default null,
  p_rate_card_id     uuid default null,
  p_pricing_kind     text default null
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
  -- Flexible pricing (fixed-first):
  v_card_id       uuid;
  v_card_kind     text;
  v_version_id    uuid;
  v_entry_id      uuid;
  v_entry_price   numeric;
  v_entry_cost    numeric;
  v_entry_unit    text;
  v_currency      text;
  v_mode          text := case p_service_type when 'aereo' then 'AIR' when 'maritimo' then 'MAR' else null end;
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

  -- 2d. Flexible pricing (fixed-first), resuelto SERVER-SIDE y persistido como
  --     snapshot al crear. Solo agencias con flexible_pricing_enabled. Reglas:
  --       * Una guía = un paquete: pieces NUNCA multiplica el cargo.
  --       * El único input de dinero es la tarifa configurada por el owner
  --         (entry price / cost): peso y volumen no participan.
  --       * Resolución: tarjeta explícita → asignación del cliente → default
  --         de la agencia. Sin tarjeta → paquete sin pricing (factura legacy).
  --       * Tarjeta explícita inválida → error accionable (nunca fallback).
  if p_pricing_kind is not null and p_pricing_kind not in ('weight','fixed') then
    raise exception 'invalid pricing kind: % (expected weight|fixed)', p_pricing_kind;
  end if;

  if exists (select 1 from public.agencies where slug = v_agency and flexible_pricing_enabled) then
    if p_pricing_kind = 'weight' then
      -- Elección explícita del operador: un paquete por peso NUNCA se cobra con
      -- una tarjeta de cuota fija. En create_package, cualquier servicio con
      -- v_mode resuelto caía en la auto-resolución fija del cliente/agencia y
      -- guardaba el paquete como cuota fija (campo no editable después).
      if p_rate_card_id is not null then
        raise exception 'a weight package cannot carry a fixed rate card';
      end if;
      v_card_id := null;
      v_card_kind := null;
    elsif p_rate_card_id is not null then
      select id, pricing_kind into v_card_id, v_card_kind
        from public.rate_cards
        where id = p_rate_card_id and organization_id = v_agency and coalesce(active, true);
      if v_card_id is null then
        raise exception 'rate card % not found for agency %', p_rate_card_id, v_agency;
      end if;
      if v_card_kind not in ('fixed', 'weight') then
        raise exception 'pricing kind % is under construction', v_card_kind;
      end if;
    elsif v_mode is not null then
      -- Auto-resolución solo para servicio fijo: asignación activa del cliente,
      -- luego default de la agencia.
      select a.rate_card_id into v_card_id
        from public.client_rate_assignments a
        where a.client_id = p_client_id and a.pricing_kind = 'fixed' and a.active
          and (a.transport_mode is null or a.transport_mode = v_mode)
        limit 1;
      if v_card_id is null then
        select c.id into v_card_id
          from public.rate_cards c
          where c.organization_id = v_agency and c.pricing_kind = 'fixed'
            and coalesce(c.active, true) and c.is_default
          limit 1;
      end if;
      if v_card_id is not null then
        select pricing_kind into v_card_kind from public.rate_cards where id = v_card_id;
      end if;
    end if;

    if v_card_id is not null and v_card_kind = 'fixed' then
      select v.id, e.id, e.price, coalesce(e.cost, 0), e.unit, v.currency
        into v_version_id, v_entry_id, v_entry_price, v_entry_cost, v_entry_unit, v_currency
        from public.rate_card_versions v
        join public.rate_card_entries e on e.rate_card_version_id = v.id
        where v.rate_card_id = v_card_id
          and v.status = 'published'
          and e.service_type = v_mode
        order by v.version desc
        limit 1;
      if v_entry_id is null then
        -- La tarjeta elegida no cubre este modo: accionable, sin fallback.
        raise exception 'rate card has no % price for service %', v_card_kind, p_service_type;
      end if;
    end if;
  elsif p_rate_card_id is not null then
    raise exception 'flexible pricing is not enabled for agency %', v_agency;
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
    client_id, manual_status, manual_status_at, manual_status_by,
    rate_card_id, rate_card_version_id, rate_card_entry_id,
    pricing_kind, customer_price_model, customer_unit, customer_rate, customer_charge,
    provider_cost_model, provider_cost_unit, provider_rate, provider_cost,
    pricing_currency, priced_at, priced_by, pricing_snapshot
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
    case when p_status is null then null else v_by end,
    v_card_id,
    v_version_id,
    v_entry_id,
    v_card_kind,
    case when v_entry_id is null then null else 'FIXED' end,
    case when v_entry_id is null then null else v_entry_unit end,
    case when v_entry_id is null then null else v_entry_price end,
    -- Una guía = un paquete: el cargo es el precio plano, pieces nunca multiplica.
    case when v_entry_id is null then null else v_entry_price end,
    case when v_entry_id is null then null else 'FIXED' end,
    case when v_entry_id is null then null else 'package' end,
    case when v_entry_id is null then null else v_entry_cost end,
    case when v_entry_id is null then null else v_entry_cost end,
    case when v_entry_id is null then null else v_currency end,
    case when v_entry_id is null then null else now() end,
    case when v_entry_id is null then null else v_by end,
    case when v_entry_id is null then null else jsonb_build_object(
      'pricingKind', 'fixed',
      'customerPriceModel', 'FIXED',
      'customerUnit', v_entry_unit,
      'customerRate', v_entry_price,
      'customerCharge', v_entry_price,
      'providerCostModel', 'FIXED',
      'providerCostUnit', 'package',
      'providerRate', v_entry_cost,
      'providerCost', v_entry_cost,
      'currency', v_currency,
      'inputs', jsonb_build_object('weightLb', p_weight_lb, 'pieces', p_pieces),
      'pieces', p_pieces
    ) end
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
      'pieces', p_pieces,
      'pricing_kind', v_card_kind,
      'rate_card_id', v_card_id,
      'customer_charge', v_entry_price
    )
  );

  return json_build_object(
    'id', v_pkg_id,
    'almacen_id', v_guia,
    'organization_id', v_agency,
    'warning', v_warning
  );
end $$;

grant execute on function public.create_package_v2(text, text, text, text, text, numeric, integer, numeric, text, text, text, text, text, numeric, text, timestamptz, text, uuid, text, uuid, text) to authenticated;