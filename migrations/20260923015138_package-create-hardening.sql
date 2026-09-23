-- ============================================================================
-- package-create-hardening — proveedor data-driven + guardas anti-pisada
-- ============================================================================
-- Additive, idempotente, dueña de la rama feat/package-create-hardening.
-- Depende de 20260922060000 (tenant original-express) por el FK de la junction.
--
-- Contexto: crear un paquete de la agencia nueva 'original-express' fallaba
-- porque create_package resolvía el proveedor con un CASE hardcodeado
-- (20260904030000:62-71) → 'no active provider for agency original-express', y
-- el panel nunca envía p_provider_code (override muerto). Además el upsert del
-- scraper (merge-duplicates) podía pisar datos manuales con nulls o incluso
-- cambiar organization_id de una fila ajena (20260904030000:91-106 no incluye
-- el org en el DO UPDATE, pero sí la payload del scraper).
--
-- Alcance:
--   1. provider_agencies.is_default  default de creación por agencia (data-driven,
--                                     reemplaza el CASE); semilla = mapeo actual.
--   2. fila OE (GC → original-express, sin prefijo aún) + índice único de 1
--                                     default por agencia.
--   3. create_package reescrito: override validado contra la junction de LA
--                                     agencia → is_default → error accionable
--                                     (runbook §2.5); preflight cross-org (nunca
--                                     pisar el ledger de otra org) + aviso de
--                                     tracking duplicado (audit + timeline +
--                                     warning en la respuesta).
--   4. packages_tenant_guard: congela organization_id (escape GUC
--                                     hit.allow_org_move) + "scrape nunca borra"
--                                     (un NULL entrante no borra valor existente),
--                                     informando en audit_logs + events con dedup
--                                     de 24h (los scrapes se repiten cada run).
--
-- Sin cambio de contrato: firma de create_package idéntica; el panel actual
-- sigue funcionando (resuelve por is_default). Errores de resolución siguen
-- siendo raise; solo el bloqueo cross-org devuelve JSON de error (un raise
-- borraría la fila de audit_logs del mismo rollback).

-- ─── 1. provider_agencies.is_default + semilla = CASE actual ────────────────
alter table provider_agencies
  add column if not exists is_default boolean not null default false;

-- Mapeo exacto de create_package pre-cambio: hit→everest, suite→suite_demo no
-- existía como link (suite solo tiene GC), solo-guegue→GC. suite usa su único
-- provider disponible (GC), así su default creado = el que ya usaba.
update provider_agencies pa
set is_default = true
from providers p
where p.id = pa.provider_id
  and ( (pa.agency_slug = 'hit'           and p.code = 'everest')
     or (pa.agency_slug = 'suite'         and p.code = 'global_connection')
     or (pa.agency_slug = 'solo-guegue'   and p.code = 'global_connection') );

-- ─── 2. Original Express: default GC, aún sin prefijo (modo manual) ─────────
-- is_scrapable=false + guard del §4/§3 impiden que su link NULL (catch-all)
-- compita en el ruteo de ingest hasta que tenga prefijo de casillero.
insert into provider_agencies (provider_id, agency_slug, casillero_filter, is_default)
select id, 'original-express', null, true
from providers where code = 'global_connection'
on conflict (provider_id, agency_slug) do nothing;

update provider_agencies
set is_default = true
where agency_slug = 'original-express'
  and provider_id = (select id from providers where code = 'global_connection');

-- Un solo default por agencia: el contrato de create_package.
create unique index if not exists uq_provider_agencies_one_default
  on provider_agencies (agency_slug)
  where is_default;

-- ─── 3. create_package: resolución data-driven + preflight cross-org ────────
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
    now()
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

-- ─── 4. packages_tenant_guard: org freeze + "scrape nunca borra" ─────────────
-- Mismo patrón que package_client_same_org (20260906030000): BEFORE UPDATE,
-- SECURITY DEFINER + search_path pineado, precedente de guardar tenant en write.
-- El dedup de 24h evita spam en Auditoría/timeline: el scraper reenvía la misma
-- payload (con su organization_id y nulls) en cada invocación.
create or replace function public.packages_tenant_guard()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_restored text[] := array[]::text[];
  v_desc     text;
begin
  -- 4a. Freeze de tenant: ninguna escritura mueve un paquete de organización.
  --     Backfill legítimo escapa con set_config('hit.allow_org_move','on',true).
  if new.organization_id is distinct from old.organization_id
     and coalesce(current_setting('hit.allow_org_move', true), 'off') <> 'on' then
    if not exists (
      select 1 from public.audit_logs
      where organization_id = old.organization_id
        and action = 'package.org_move_blocked'
        and entity_id = old.id::text
        and created_at > now() - interval '24 hours'
    ) then
      insert into public.audit_logs (
        organization_id, actor_id, actor_email, actor_type,
        action, entity_type, entity_id, metadata
      ) values (
        old.organization_id, auth.uid(), null, 'system',
        'package.org_move_blocked', 'package', old.id::text,
        jsonb_build_object(
          'attempted_organization_id', new.organization_id,
          'almacen_id', old.almacen_id
        )
      );
    end if;
    new.organization_id := old.organization_id;
  end if;

  -- 4b. "Scrape nunca borra": un NULL entrante no borra un valor existente.
  --     Cubre scraper parcial, re-create en blanco y cualquier escritor futuro.
  --     (manual_status* ya está protegido porque la payload no lo envía.)
  if new.tracking_number is null and old.tracking_number is not null then
    new.tracking_number := old.tracking_number; v_restored := v_restored || 'tracking_number';
  end if;
  if new.weight_lb is null and old.weight_lb is not null then
    new.weight_lb := old.weight_lb; v_restored := v_restored || 'weight_lb';
  end if;
  if new.pieces is null and old.pieces is not null then
    new.pieces := old.pieces; v_restored := v_restored || 'pieces';
  end if;
  if new.volume_cf is null and old.volume_cf is not null then
    new.volume_cf := old.volume_cf; v_restored := v_restored || 'volume_cf';
  end if;
  if new.dimensions is null and old.dimensions is not null then
    new.dimensions := old.dimensions; v_restored := v_restored || 'dimensions';
  end if;
  if new.referencia_name is null and old.referencia_name is not null then
    new.referencia_name := old.referencia_name; v_restored := v_restored || 'referencia_name';
  end if;
  if new.casillero is null and old.casillero is not null then
    new.casillero := old.casillero; v_restored := v_restored || 'casillero';
  end if;
  if new.description is null and old.description is not null then
    new.description := old.description; v_restored := v_restored || 'description';
  end if;
  if new.remitente is null and old.remitente is not null then
    new.remitente := old.remitente; v_restored := v_restored || 'remitente';
  end if;
  if new.declared_value is null and old.declared_value is not null then
    new.declared_value := old.declared_value; v_restored := v_restored || 'declared_value';
  end if;
  if new.received_at is null and old.received_at is not null then
    new.received_at := old.received_at; v_restored := v_restored || 'received_at';
  end if;
  if new.origin_office is null and old.origin_office is not null then
    new.origin_office := old.origin_office; v_restored := v_restored || 'origin_office';
  end if;
  if new.dest_office is null and old.dest_office is not null then
    new.dest_office := old.dest_office; v_restored := v_restored || 'dest_office';
  end if;

  if cardinality(v_restored) > 0 then
    v_desc := 'manual values preserved (provider sent empty): ' || array_to_string(v_restored, ', ');

    if not exists (
      select 1 from public.audit_logs
      where organization_id = old.organization_id
        and action = 'package.scrape_values_preserved'
        and entity_id = old.id::text
        and created_at > now() - interval '24 hours'
    ) then
      insert into public.audit_logs (
        organization_id, actor_id, actor_email, actor_type,
        action, entity_type, entity_id, metadata
      ) values (
        old.organization_id, auth.uid(), null, 'system',
        'package.scrape_values_preserved', 'package', old.id::text,
        jsonb_build_object(
          'restored', to_jsonb(v_restored),
          'almacen_id', old.almacen_id
        )
      );
    end if;

    if not exists (
      select 1 from public.events
      where package_id = old.id
        and description = v_desc
        and occurred_at > now() - interval '24 hours'
    ) then
      insert into public.events (package_id, occurred_at, office, description, status, source)
      values (old.id, now(), null, v_desc, null, 'system');
    end if;
  end if;

  return new;
end $$;

comment on function public.packages_tenant_guard is
  'Tenant guard: freezes packages.organization_id (escape hatch GUC hit.allow_org_move) and stops NULL updates from erasing existing values ("scrape never erases"); reports to audit_logs + events with a 24h dedup.';

drop trigger if exists packages_tenant_guard on public.packages;
create trigger packages_tenant_guard
  before update on public.packages
  for each row execute function public.packages_tenant_guard();
