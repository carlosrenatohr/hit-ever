-- ============================================================================
-- package-unique-per-tenant — una guía = un paquete por tenant (ADR-013)
-- ============================================================================
-- Regla de negocio (docs/adr/013.md en el workspace):
--   * La identidad de un paquete es (organization_id, almacen_id): la misma guía
--     NO puede existir dos veces bajo el mismo tenant, y PUEDE existir en dos
--     tenants distintos — en silencio, nunca se muestra un aviso cross-tenant.
--   * Idempotencia: re-crear una guía propia hace merge en la fila existente y
--     la restaura si estaba dada de baja (crear a mano = intención explícita).
--     El ingest nunca mergea la misma guía con OTRO provider dentro del tenant
--     (serían dos paquetes físicos distintos): la omite y lo audita — ver
--     InsforgeClient.upsertPackages (pre-check + audit_logs).
--   * Toda RPC SECURITY DEFINER keyeada por guía debe filtrar organization_id:
--     con la guía duplicable entre tenants, sin ese filtro serían writes
--     cross-tenant (la RLS no aplica dentro de SECURITY DEFINER).
--
-- Alcance (aditiva, idempotente, dueña de rama feat/track-guia-per-tenant):
--   0. Limpieza segura de duplicados "stub" (0 dependientes, sin datos) →
--      hard-delete + audit_logs. Cualquier otro duplicado → RAISE accionable.
--      (Auditoría de datos 2026-09-28: prod tenía 1 dup real — hit/963831,
--      stub vacío de global_connection contra la fila real de everest.)
--   1. Swap de constraint: DROP unique (provider_id, almacen_id) →
--      ADD unique (organization_id, almacen_id) + COMMENT con la regla.
--   2. create_package: conflict target (organization_id, almacen_id); restaura
--      filas dadas de baja; elimina el bloqueo cross-tenant (step 4) y el
--      warning de tracking cross-tenant (step 5); mensajes en español.
--      Firma SIN cambios (19 params) — CREATE OR REPLACE no cambia firma.
--   3. RPCs por guía: org-scope + mensajes en español + guard is_writer en
--      set_package_client/set_package_service (viewer escribía: misma clase de
--      bug que arregló 20260711130000 para las 3 RPCs originales).
--
-- Ventana de deploy: aplicar la migración y redeployear el Worker seguido —
-- upsertPackages pasa a on_conflict=organization_id,almacen_id y el código
-- viejo contra el constraint nuevo fallaría ("no unique constraint matching
-- the ON CONFLICT specification"). El cron de ingest puede fallar durante esa
-- ventana (minutos). Aplicar: npx @insforge/cli db migrations up --all
--
-- FAIL-SAFE (el servidor de migraciones aplica sentencia a sentencia, sin tx
-- por archivo — verificado contra prod con 20260904020000): §1 y §2 viven
-- cada uno en UN bloque DO con guard. Si queda algún duplicado rico sin
-- resolver, §1 se revierte entero (la tabla nunca queda sin unique) y §2 no
-- reemplaza create_package — el sistema sigue funcionando con la semántica
-- vieja. En ese caso: resolver los dups indicados por el raise y RE-EJECUTAR
-- la migración completa (idempotente: los guards ya no frenan). Verificar
-- SIEMPRE post-aplicado (queries al final del file).
-- ============================================================================

-- ─── 0. Duplicados stub → hard-delete seguro + audit ─────────────────────────
-- Solo se elimina automáticamente una fila estrictamente vacía (sin eventos,
-- tags, notas, provider notes, links de factura, ni datos de envío/manual).
-- Cualquier caso más rico detiene la migración con un error accionable.
do $$
declare
  g        record;
  keeper   uuid;
  dup      record;
  n_deps   int;
begin
  for g in
    select organization_id, almacen_id
      from public.packages
     group by 1, 2
    having count(*) > 1
  loop
    -- Keeper determinista: la fila con datos reales.
    select p.id into keeper
      from public.packages p
     where p.organization_id = g.organization_id
       and p.almacen_id = g.almacen_id
     order by (p.tracking_number is not null) desc,
              (p.received_at is not null) desc,
              (p.manual_status is not null) desc,
              (p.weight_lb is not null) desc,
              (select count(*) from public.events e where e.package_id = p.id) desc,
              p.scraped_at desc
     limit 1;

    for dup in
      select p.id
        from public.packages p
       where p.organization_id = g.organization_id
         and p.almacen_id = g.almacen_id
         and p.id <> keeper
    loop
      if exists (
        select 1 from public.packages p
         where p.id = dup.id
           and (p.tracking_number is not null
             or p.received_at is not null
             or p.manual_status is not null
             or p.client_id is not null
             or p.weight_lb is not null
             or p.pieces is not null)
      ) then
        raise exception 'unique-per-tenant: duplicate % of (%, %) keeper=% carries shipment data — resolve manually before applying',
          dup.id, g.organization_id, g.almacen_id, keeper;
      end if;

      select count(*) into n_deps from (
        select 1 from public.events            where package_id = dup.id
        union all select 1 from public.package_tags         where package_id = dup.id
        union all select 1 from public.package_notes        where package_id = dup.id
        union all select 1 from public.package_provider_notes where package_id = dup.id
        union all select 1 from public.invoice_packages     where package_id = dup.id
        union all select 1 from public.invoice_line_items   where package_id = dup.id
      ) s;
      if n_deps > 0 then
        raise exception 'unique-per-tenant: duplicate % of (%, %) keeper=% has % dependent rows — resolve manually before applying',
          dup.id, g.organization_id, g.almacen_id, keeper, n_deps;
      end if;

      insert into public.audit_logs
        (organization_id, actor_id, actor_email, actor_type, action, entity_type, entity_id, metadata)
      values
        (g.organization_id, null, null, 'system',
         'package.duplicate_stub_removed', 'package', dup.id::text,
         jsonb_build_object(
           'almacen_id', g.almacen_id,
           'keeper_package_id', keeper,
           'reason', 'unique-per-tenant (ADR-013): empty duplicate stub removed'
         ));

      delete from public.packages where id = dup.id;
      raise notice 'unique-per-tenant: removed empty duplicate stub % for (%, %)', dup.id, g.organization_id, g.almacen_id;
    end loop;
  end loop;
end $$;

-- ─── 1. Constraint swap ──────────────────────────────────────────────────────
-- El viejo unique (provider_id, almacen_id) impedía que dos tenants compartan
-- provider y guía (el caso OE/HIT 22222). Se reemplaza por la identidad
-- por tenant. idx_packages_provider_almacen (lookup) se mantiene.
-- TODOO en UN bloque DO: si §0 frenó (dup rico sin resolver) o queda algún
-- (org, guía) duplicado, el raise revierte drop+add JUNTOS — aunque el
-- servidor aplique sentencia a sentencia, la tabla nunca queda sin unique.
do $$
begin
  if exists (
    select 1 from public.packages
     group by organization_id, almacen_id
    having count(*) > 1
  ) then
    raise exception 'unique-per-tenant: unresolved duplicates on (organization_id, almacen_id) remain — resolve manually and re-run this migration';
  end if;

  alter table public.packages drop constraint if exists packages_provider_id_almacen_id_key;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.packages'::regclass
       and conname = 'packages_organization_id_almacen_id_key'
  ) then
    alter table public.packages
      add constraint packages_organization_id_almacen_id_key unique (organization_id, almacen_id);
  end if;
end $$;

comment on constraint packages_organization_id_almacen_id_key on public.packages is
  'Business rule (ADR-013): one guía (almacen_id) per tenant. The same guía in different tenants is allowed and never surfaced to users.';

-- ─── 2. create_package — idempotente por tenant, sin avisos cross-tenant ─────
-- Tripwire REAL (el servidor de migraciones aplica sentencia a sentencia, así
-- que un raise suelto no basta): TODO §2 vive dentro de un `do` con guard — si el
-- unique por tenant no está, NADA de §2 se aplica y la create_package VIGENTE
-- queda intacta (el panel sigue operando con la semántica vieja). Recovery en el
-- header del archivo: resolver los dups y re-ejecutar la migración (idempotente).
do $sec2$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.packages'::regclass
       and conname = 'packages_organization_id_almacen_id_key'
  ) then
    raise exception 'unique-per-tenant: packages_organization_id_almacen_id_key missing — resolve duplicates and re-run this migration';
  end if;

  execute $ddl$drop function if exists public.create_package(text, text, text, text, text, numeric, integer, numeric, text, text, text, text, text, numeric, text, timestamptz, text)$ddl$;

  execute $ddl$create or replace function public.create_package(
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
  returns json language plpgsql security definer set search_path = public, auth as $fn$
declare
  v_agency      text;
  v_by          text;
  v_provider    uuid;
  v_pkg_id      uuid;
  v_guia        text := p_almacen_id;
begin
  -- 1. Authorization: admin|staff only
  if not public.is_writer() then
    raise exception 'No tenés permisos para realizar esta acción.';
  end if;

  -- 2. Resolve agency + actor email from session (never from the payload)
  select coalesce(email, 'panel'), coalesce(agency, 'hit')
    into v_by, v_agency
    from public.app_users where id = auth.uid();
  if v_agency is null then
    raise exception 'Tu usuario no tiene una agencia asignada. Contactá al administrador.';
  end if;

  -- 2b. Cliente obligatorio y de esta tenant. El trigger packages_client_same_org
  --     da el fallback de integridad; este pre-check devuelve un error accionable.
  if p_client_id is null then
    raise exception 'Elegí un cliente: el paquete nace con uno. Si todavía no existe, crealo primero en Facturación › Clientes.';
  end if;
  if not exists (
    select 1 from public.billing_clients
    where id = p_client_id
      and organization_id = v_agency
      and coalesce(active, true)
  ) then
    raise exception 'El cliente seleccionado no existe o no está activo en tu agencia. Crealo primero en Facturación › Clientes.';
  end if;

  -- 2c. Estado inicial manual (opcional). Se persiste en manual_status para que
  --     el effective quede correcto desde el arranque sin pisar el espacio
  --     "scraped" de `status`.
  if p_status is not null
     and p_status not in ('en_almacen','parcial','en_transito','en_destino','entregado','excepcion','desconocido') then
    raise exception 'Estado inválido: % — elegí uno de los estados disponibles.', p_status;
  end if;

  -- 3. Resolve provider: el override debe ser un provider ACTIVO linkeado a ESTA
  --    agencia en la junction; si no, el default de la agencia (is_default).
  if p_provider_code is not null then
    select pa.provider_id into v_provider
    from public.provider_agencies pa
    join public.providers p on p.id = pa.provider_id
    where pa.agency_slug = v_agency
      and p.code = p_provider_code
      and p.active;
    if v_provider is null then
      raise exception 'El proveedor % no está habilitado para tu agencia.', p_provider_code;
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
      raise exception 'Tu agencia no tiene un proveedor por defecto configurado.';
    end if;
  end if;

  -- 4. Insert idempotente sobre la identidad por tenant (ADR-013):
  --    * misma guía + mismo tenant → merge en la fila existente;
  --    * la fila estaba dada de baja → se restaura (crear a mano es una
  --      intención explícita; el ingest nunca limpia deleted_at);
  --    * misma guía + otro tenant → insert normal, sin aviso ni audit.
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
  on conflict (organization_id, almacen_id) do update
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
        updated_at       = now(),
        deleted_at       = null,
        deleted_by       = null,
        delete_reason    = null
  returning id into v_pkg_id;

  if v_pkg_id is null then
    -- Inalcanzable con el conflict target por tenant; defensa con copy en español.
    raise exception 'No pudimos crear la guía %. Intentá de nuevo o contactá al administrador.', v_guia;
  end if;

  -- 5. Timeline: la creación manual SIEMPRE deja fila visible en el historial
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

  -- 6. Audit
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
    'organization_id', v_agency
  );
  end
  $fn$;$ddl$;
end
$sec2$;

grant execute on function public.create_package(text, text, text, text, text, numeric, integer, numeric, text, text, text, text, text, numeric, text, timestamptz, text, uuid, text) to authenticated;

-- ─── 3. RPCs por guía: org-scope + mensajes en español ──────────────────────
-- Copia de las versiones vigentes (config-module 20260814214034, package-edit-rpcs
-- 20260914020000, package-soft-delete 20260908233000) con:
--   * organization_id en el select de la guía (la resolución de sesión pasa
--     ANTES: el filtro org necesita v_agency/v_org);
--   * guard is_writer() donde estaba is_staff() (viewer escribía);
--   * mensajes de error al usuario en español (docs/tone-and-language.md).
-- Grants persisten sobre CREATE OR REPLACE; se re-emiten por idempotencia.

-- organization_id y actor salen de la sesión (auth.uid() -> app_users.agency),
-- nunca del payload.
create or replace function public.set_manual_status(p_guia text, p_status text, p_note text default null)
  returns json language plpgsql security definer set search_path = public, auth as $$
declare v_id uuid; v_by text; v_agency text;
begin
  if not public.is_writer() then raise exception 'No tenés permisos para realizar esta acción.'; end if;
  select coalesce(email, 'panel'), coalesce(agency, 'hit')
    into v_by, v_agency
    from public.app_users where id = auth.uid();
  if p_status not in ('en_almacen','parcial','en_transito','en_destino','entregado','excepcion','desconocido') then
    raise exception 'Estado inválido: % — elegí uno de los estados disponibles.', p_status;
  end if;
  -- Guía es identidad única por tenant (ADR-013); SECURITY DEFINER ⇒ filtro org obligatorio.
  select id into v_id from public.packages where almacen_id = p_guia and organization_id = v_agency;
  if v_id is null then raise exception 'No encontramos la guía % en tu agencia.', p_guia; end if;
  update public.packages set
    manual_status      = p_status::public.shipment_status,
    manual_status_by   = coalesce(v_by, 'panel'),
    manual_status_note = p_note,
    manual_status_at   = now(),
    updated_at         = now()
  where id = v_id;
  insert into public.audit_logs
    (organization_id, actor_id, actor_email, actor_type, action, entity_type, entity_id, metadata)
  values
    (v_agency, auth.uid(), v_by, 'user', 'set_manual_status', 'package', p_guia,
     jsonb_build_object('status', p_status, 'note', p_note));
  return json_build_object('guia', p_guia, 'manual_status', p_status);
end $$;

grant execute on function public.set_manual_status(text, text, text) to authenticated;

create or replace function public.add_package_tag(p_guia text, p_label text, p_value text default null)
  returns json language plpgsql security definer set search_path = public, auth as $$
declare v_id uuid; v_by text; v_agency text;
begin
  if not public.is_writer() then raise exception 'No tenés permisos para realizar esta acción.'; end if;
  select coalesce(email, 'panel'), coalesce(agency, 'hit')
    into v_by, v_agency
    from public.app_users where id = auth.uid();
  -- Guía es identidad única por tenant (ADR-013); SECURITY DEFINER ⇒ filtro org obligatorio.
  select id into v_id from public.packages where almacen_id = p_guia and organization_id = v_agency;
  if v_id is null then raise exception 'No encontramos la guía % en tu agencia.', p_guia; end if;
  insert into public.package_tags (package_id, label, value, created_by)
  values (v_id, p_label, p_value, v_by);
  insert into public.audit_logs
    (organization_id, actor_id, actor_email, actor_type, action, entity_type, entity_id, metadata)
  values
    (v_agency, auth.uid(), v_by, 'user', 'add_package_tag', 'package', p_guia,
     jsonb_build_object('label', p_label, 'value', p_value));
  return json_build_object('guia', p_guia, 'tag', p_label);
end $$;

grant execute on function public.add_package_tag(text, text, text) to authenticated;

create or replace function public.add_package_note(p_guia text, p_body text)
  returns json language plpgsql security definer set search_path = public, auth as $$
declare v_id uuid; v_by text; v_agency text;
begin
  if not public.is_writer() then raise exception 'No tenés permisos para realizar esta acción.'; end if;
  if coalesce(trim(p_body), '') = '' then raise exception 'La nota no puede quedar vacía.'; end if;
  select coalesce(email, 'panel'), coalesce(agency, 'hit')
    into v_by, v_agency
    from public.app_users where id = auth.uid();
  -- Guía es identidad única por tenant (ADR-013); SECURITY DEFINER ⇒ filtro org obligatorio.
  select id into v_id from public.packages where almacen_id = p_guia and organization_id = v_agency;
  if v_id is null then raise exception 'No encontramos la guía % en tu agencia.', p_guia; end if;
  insert into public.package_notes (package_id, body, created_by)
  values (v_id, p_body, v_by);
  insert into public.audit_logs
    (organization_id, actor_id, actor_email, actor_type, action, entity_type, entity_id, metadata)
  values
    (v_agency, auth.uid(), v_by, 'user', 'add_package_note', 'package', p_guia,
     jsonb_build_object('body', p_body));
  return json_build_object('guia', p_guia, 'noted', true);
end $$;

grant execute on function public.add_package_note(text, text) to authenticated;

-- set_package_client / set_package_service: is_staff() → is_writer() (viewer
-- escribía; misma clase de bug que 20260711130000 re-guardó en las 3 RPCs
-- originales) + org-scope + mensajes en español.
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
  if not public.is_writer() then
    raise exception 'No tenés permisos para realizar esta acción.';
  end if;

  select coalesce(email, 'panel'), coalesce(agency, 'hit')
    into v_actor, v_org
    from public.app_users
   where id = auth.uid();

  -- Guía es identidad única por tenant (ADR-013); SECURITY DEFINER ⇒ filtro org obligatorio.
  select id
    into v_id
    from public.packages
   where almacen_id = p_guia
     and organization_id = v_org
     and deleted_at is null;

  if v_id is null then
    raise exception 'No encontramos la guía % en tu agencia.', p_guia;
  end if;

  if p_client_id is not null then
    -- Validate client exists, is active, and belongs to the same org.
    select name into v_client_name
      from public.billing_clients
     where id = p_client_id
       and organization_id = v_org
       and deleted_at is null;

    if v_client_name is null then
      raise exception 'El cliente seleccionado no existe o no está activo en tu agencia.';
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
  v_org   text;
  v_actor text;
begin
  if not public.is_writer() then
    raise exception 'No tenés permisos para realizar esta acción.';
  end if;

  select coalesce(email, 'panel'), coalesce(agency, 'hit')
    into v_actor, v_org
    from public.app_users
   where id = auth.uid();

  -- Guía es identidad única por tenant (ADR-013); SECURITY DEFINER ⇒ filtro org obligatorio.
  select id into v_id
    from public.packages
   where almacen_id = p_guia
     and organization_id = v_org
     and deleted_at is null;

  if v_id is null then
    raise exception 'No encontramos la guía % en tu agencia.', p_guia;
  end if;

  if p_service_type is not null and p_service_type not in ('aereo', 'maritimo') then
    raise exception 'Tipo de servicio inválido: % — elegí aéreo o marítimo.', p_service_type;
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

-- delete_package (versión vigente 20260908233000): org-scope directo en el
-- select (con unicidad por tenant ya no hace falta order/limit ni el chequeo
-- post-hoc de org distinto) + mensajes en español.
create or replace function public.delete_package(
  p_guia   text,
  p_reason text default null
)
  returns json language plpgsql security definer set search_path = public, auth as $$
declare
  v_agency        text;
  v_by            text;
  v_pkg_id        uuid;
  v_pkg_client    uuid;
  v_active_invoice uuid;
  v_events        int;
  v_notes         int;
  v_tags          int;
  v_prov_notes    int;
  v_line_items    int;
begin
  -- 1. Authorization: admin|staff only (same gate as create_package)
  if not public.is_writer() then
    raise exception 'No tenés permisos para realizar esta acción.';
  end if;

  -- 2. Resolve agency + actor email from session (never from the payload)
  select coalesce(email, 'panel'), coalesce(agency, 'hit')
    into v_by, v_agency
    from public.app_users where id = auth.uid();
  if v_agency is null then
    raise exception 'Tu usuario no tiene una agencia asignada. Contactá al administrador.';
  end if;

  -- 3. Resolve the package by guía within the session agency (ADR-013: única por tenant)
  select id, client_id
    into v_pkg_id, v_pkg_client
    from public.packages
   where almacen_id = p_guia
     and organization_id = v_agency;
  if v_pkg_id is null then
    raise exception 'No encontramos la guía % en tu agencia.', p_guia;
  end if;

  -- 4. Impact counts for the audit trail
  select count(*) into v_events     from public.events                  where package_id = v_pkg_id;
  select count(*) into v_notes      from public.package_notes           where package_id = v_pkg_id;
  select count(*) into v_tags       from public.package_tags            where package_id = v_pkg_id;
  select count(*) into v_prov_notes from public.package_provider_notes  where package_id = v_pkg_id;
  select count(*) into v_line_items from public.invoice_line_items      where package_id = v_pkg_id;
  select invoice_id into v_active_invoice
    from public.invoice_packages
   where package_id = v_pkg_id and active = true
   limit 1;

  -- 5. Soft delete (UPDATE, never DELETE). Idempotent: re-running on an
  --    already-deleted package is a no-op success (no resurrection).
  update public.packages
    set deleted_at = now(),
        deleted_by = v_by,
        delete_reason = p_reason,
        updated_at = now()
    where id = v_pkg_id;

  -- 6. Audit in the same transaction
  insert into public.audit_logs (
    organization_id, actor_id, actor_email, actor_type,
    action, entity_type, entity_id, metadata
  ) values (
    v_agency, auth.uid(), v_by, 'user',
    'package.delete', 'package', v_pkg_id::text,
    jsonb_build_object(
      'almacen_id', p_guia,
      'client_id', v_pkg_client::text,
      'active_invoice_id', v_active_invoice,
      'events', v_events,
      'notes', v_notes,
      'tags', v_tags,
      'provider_notes', v_prov_notes,
      'invoice_line_items', v_line_items,
      'reason', p_reason
    )
  );

  return json_build_object('id', v_pkg_id, 'almacen_id', p_guia, 'deleted', true);
end $$;

grant execute on function public.delete_package(text, text) to authenticated;

-- ─── Verificación post-aplicado (correr a mano después del `migrations up`) ──
-- Esperado: (a) "packages_organization_id_almacen_id_key" presente y el viejo
-- ausente; (b) 0 filas en la query de duplicados.
--   select conname from pg_constraint
--    where conrelid = 'public.packages'::regclass
--      and conname in ('packages_organization_id_almacen_id_key','packages_provider_id_almacen_id_key')
--    order by 1;
--
--   select organization_id, almacen_id, count(*)
--     from public.packages
--    group by 1, 2
--   having count(*) > 1;
