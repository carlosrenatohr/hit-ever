-- ============================================================================
-- package-create-hardening prereqs — de la huérfana 20260923015138 (eliminada)
-- ============================================================================
-- Esa migración quedó sin registrar en el tracker (se aplicó out-of-band a prod)
-- y su timestamp quedó atrás del head, bloqueando la cadena. Este archivo rescata
-- las partes VIVAS y aún necesarias para environments nuevos (29051106 y las
-- migraciones bumped del mismo día referencian provider_agencies.is_default, y el
-- trigger packages_tenant_guard solo estaba definido acá). Se descarta su §3
-- (create_package v-viejo, supersedeado por 20260923155734 + 20260929051106).
-- Idempotente; en prod re-aplica definiciones idénticas a las vivas (no-op).

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
