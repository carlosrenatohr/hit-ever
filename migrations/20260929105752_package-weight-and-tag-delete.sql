-- Peso editable y etiqueta borrable desde el panel (módulo de paquetería).
--
-- Mismo molde que `set_package_service` / `add_package_tag` de
-- 20260929051106: SECURITY DEFINER + `is_writer()` + org-scope (ADR-013) +
-- mensajes en español + traza en `audit_logs`. `package_tags` y `packages`
-- solo tienen política de SELECT para staff ⇒ las escrituras van por RPC.
--
-- `set_package_weight` escribe `weight_lb` directo, sin columna override: el
-- valor manual vive hasta que el próximo ingest/refresh del proveedor lo
-- reescriba (decisión de diseño — evita 2 columnas nuevas en todas las filas).
-- El rastro del cambio queda en `package_notes` (visible en el detalle) y en
-- `audit_logs`.
--
-- `delete_package_tag` borra por (guía, label[, value]). `package_tags` NO
-- tiene unicidad por (package_id, label) — ver nota en
-- 20260914140000_match-unassigned-clients.sql — así que borra todas las
-- coincidencias y devuelve cuántas.

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
  select id, weight_lb into v_id, v_prev
    from public.packages
   where almacen_id = p_guia
     and organization_id = v_org
     and deleted_at is null;

  if v_id is null then
    raise exception 'No encontramos la guía % en tu agencia.', p_guia;
  end if;

  update public.packages
     set weight_lb  = p_weight_lb,
         updated_at = now()
   where id = v_id;

  -- Historial legible en el detalle del paquete (pane "Etiquetas y notas internas").
  insert into public.package_notes (package_id, body, created_by)
  values (
    v_id,
    'Peso actualizado: ' || coalesce(v_prev::text, 'sin peso') || ' → ' || p_weight_lb::text || ' lb',
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

grant execute on function public.set_package_weight(text, numeric) to authenticated;

create or replace function public.delete_package_tag(
  p_guia  text,
  p_label text,
  p_value text default null
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
  v_n     integer;
begin
  if not public.is_writer() then
    raise exception 'No tenés permisos para realizar esta acción.';
  end if;

  if coalesce(trim(p_label), '') = '' then
    raise exception 'La etiqueta no puede quedar vacía.';
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

  delete from public.package_tags
   where package_id = v_id
     and label = p_label
     and (p_value is null or value = p_value);

  get diagnostics v_n = row_count;

  -- Idempotente: dos clics o una etiqueta ya borrada no son un error.
  if v_n > 0 then
    insert into public.audit_logs
      (organization_id, actor_id, actor_email, actor_type, action, entity_type, entity_id, metadata)
    values
      (v_org, auth.uid(), v_actor, 'user', 'delete_package_tag', 'package', p_guia,
       jsonb_build_object('label', p_label, 'value', p_value, 'deleted', v_n));
  end if;

  return json_build_object('guia', p_guia, 'tag', p_label, 'deleted', v_n);
end;
$$;

grant execute on function public.delete_package_tag(text, text, text) to authenticated;
