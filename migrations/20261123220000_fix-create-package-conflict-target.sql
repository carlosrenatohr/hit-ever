-- ============================================================================
-- fix-create-package-conflict-target — 42P10 al crear paquetes (ADR-013)
-- ============================================================================
-- Síntoma: el alta de un paquete desde el panel devolvía
--   "42P10 there is no unique or exclusion constraint matching the ON CONFLICT
--    specification"
-- y el paquete nunca se creaba; el cliente que el panel crea primero quedaba
-- huérfano porque el reintento lo volvía a crear.
--
-- Causa: ADR-013 (20260929051106) movió la identidad del paquete a
-- (organization_id, almacen_id) y eliminó la constraint (provider_id, almacen_id).
-- El cuerpo de `create_package` de 20 args (20261026222000, recopiado en
-- 20261116150000) y el de `create_package_v2` (20261123180000) se copiaron de
-- una versión anterior y conservaron el target retirado. La sobrecarga de 19
-- args quedó correcta porque nunca se recopió.
--
-- Fix: parchear SOLO la cláusula del conflicto sobre la definición viva
-- (pg_get_functiondef + regexp_replace) en vez de recopiar ~200 líneas por
-- función — recopiar es justamente lo que reintrodujo el target viejo. El
-- bloque es idempotente (si ya está bien, no toca nada) y falla ruidoso si
-- algo quedara sin reparar.
--
-- Ventana de deploy: aplicar esta migración antes de desplegar el panel que
-- vuelve a llamar `create_package_v2`.
--
-- Aplicación en prod (la CLI rechaza multi-statement y comentarios): ejecutar
-- el bloque DO solo. Verificación al final del archivo.
-- ============================================================================

do $$
declare
  fn       record;
  def      text;
  repaired int := 0;
  leftover int;
begin
  -- 0. La constraint tenant-scoped debe existir: sin ella no hay target válido.
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.packages'::regclass
      and conname = 'packages_organization_id_almacen_id_key'
  ) then
    raise exception 'packages_organization_id_almacen_id_key missing — ADR-013 identity not in place';
  end if;

  -- 1. Reparar cada sobrecarga que todavía apunte al target retirado.
  for fn in
    select p.oid, p.proname, p.pronargs
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('create_package', 'create_package_v2')
      and p.prosrc ~* 'on\s+conflict\s*\(\s*provider_id\s*,\s*almacen_id\s*\)'
  loop
    def := regexp_replace(
      pg_get_functiondef(fn.oid),
      'on\s+conflict\s*\(\s*provider_id\s*,\s*almacen_id\s*\)',
      'on conflict (organization_id, almacen_id)',
      'i'
    );
    execute def;
    repaired := repaired + 1;
    raise notice 'repaired %(%): conflict target -> (organization_id, almacen_id)', fn.proname, fn.pronargs;
  end loop;

  -- 2. Ninguna sobrecarga puede quedar con el target viejo.
  select count(*) into leftover
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('create_package', 'create_package_v2')
    and p.prosrc ~* 'on\s+conflict\s*\(\s*provider_id\s*,\s*almacen_id\s*\)';

  if leftover > 0 then
    raise exception 'create_package still targets (provider_id, almacen_id): % function(s) left', leftover;
  end if;

  raise notice 'conflict target verified on every create_package overload (% repaired)', repaired;
end $$;

-- ---------------------------------------------------------------------------
-- Verificación post-aplicado
--   select p.proname, p.pronargs,
--          position('on conflict (organization_id, almacen_id)' in p.prosrc) > 0 as ok,
--          position('on conflict (provider_id, almacen_id)' in p.prosrc) > 0 as stale
--   from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.proname in ('create_package','create_package_v2')
--   order by p.proname, p.pronargs;
-- Esperado: ok = true y stale = false en las tres sobrecargas (19, 20 y 21 args).
--
-- Prueba de que el target planifica bien (rollback deliberado, no deja filas):
--   do $$ begin
--     insert into public.packages (provider_id, organization_id, almacen_id)
--     select id, 'suite', 'ZZ-CONFLICT-PLAN-CHECK' from public.providers limit 1
--     on conflict (organization_id, almacen_id) do nothing;
--     raise exception 'PLAN_OK (rollback intentional)';
--   end $$;
-- ---------------------------------------------------------------------------
