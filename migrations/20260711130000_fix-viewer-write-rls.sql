-- Security fix (audit H1/panel): the `viewer` role must be read-only.
--
-- The three write RPCs guarded on public.is_staff(), which returns true for ANY active
-- user — including role='viewer'. The panel only hides the write UI for viewers (client-side),
-- so a logged-in viewer could still call the RPCs directly and override statuses / add tags/notes.
-- Add public.is_writer() (admin|staff only) and re-guard the write RPCs with it. Reads still use
-- is_staff() (viewers keep read access).

create or replace function public.is_writer()
  returns boolean language sql stable security definer
  set search_path = public, auth as $$
  select public.current_staff_role() in ('admin', 'staff')
$$;

grant execute on function public.is_writer() to authenticated;

-- Re-create the three write RPCs: bodies unchanged except the guard (is_staff → is_writer).
create or replace function public.set_manual_status(p_guia text, p_status text, p_note text default null)
  returns json language plpgsql security definer set search_path = public, auth as $$
declare v_id uuid; v_by text;
begin
  if not public.is_writer() then raise exception 'not authorized'; end if;
  select id into v_id from public.packages where almacen_id = p_guia;
  if v_id is null then raise exception 'package % not found', p_guia; end if;
  select coalesce(email, 'panel') into v_by from public.app_users where id = auth.uid();
  update public.packages set
    manual_status      = p_status::public.shipment_status,
    manual_status_by   = coalesce(v_by, 'panel'),
    manual_status_note = p_note,
    manual_status_at   = now(),
    updated_at         = now()
  where id = v_id;
  return json_build_object('guia', p_guia, 'manual_status', p_status);
end $$;

create or replace function public.add_package_tag(p_guia text, p_label text, p_value text default null)
  returns json language plpgsql security definer set search_path = public, auth as $$
declare v_id uuid; v_by text;
begin
  if not public.is_writer() then raise exception 'not authorized'; end if;
  select id into v_id from public.packages where almacen_id = p_guia;
  if v_id is null then raise exception 'package % not found', p_guia; end if;
  select coalesce(email, 'panel') into v_by from public.app_users where id = auth.uid();
  insert into public.package_tags (package_id, label, value, created_by)
  values (v_id, p_label, p_value, v_by);
  return json_build_object('guia', p_guia, 'tag', p_label);
end $$;

create or replace function public.add_package_note(p_guia text, p_body text)
  returns json language plpgsql security definer set search_path = public, auth as $$
declare v_id uuid; v_by text;
begin
  if not public.is_writer() then raise exception 'not authorized'; end if;
  if coalesce(trim(p_body), '') = '' then raise exception 'note body required'; end if;
  select id into v_id from public.packages where almacen_id = p_guia;
  if v_id is null then raise exception 'package % not found', p_guia; end if;
  select coalesce(email, 'panel') into v_by from public.app_users where id = auth.uid();
  insert into public.package_notes (package_id, body, created_by)
  values (v_id, p_body, v_by);
  return json_build_object('guia', p_guia, 'noted', true);
end $$;
