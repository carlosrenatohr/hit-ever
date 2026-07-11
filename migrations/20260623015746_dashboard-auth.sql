-- Dashboard staff auth, role-based RLS, write RPCs, and a stats RPC.
-- Internal admin panel reads ops tables directly with the signed-in user's JWT (RLS authorizes
-- by staff role); writes go through SECURITY DEFINER RPCs. The public /track endpoint is unaffected
-- (it is served by the Worker with the admin key; anon has no policies → stays denied).

-- ── Staff users ────────────────────────────────────────────────────────────────
do $$ begin
  create type public.staff_role as enum ('admin', 'staff', 'viewer');
exception when duplicate_object then null; end $$;

create table if not exists public.app_users (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text not null,
  name       text,
  role       public.staff_role not null default 'viewer',
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

-- app_users is staff-only metadata: never expose to anon.
revoke all on public.app_users from anon;
grant select, insert, update, delete on public.app_users to authenticated;

-- ── Role helpers (SECURITY DEFINER to avoid RLS recursion on app_users) ─────────
create or replace function public.current_staff_role()
  returns public.staff_role language sql stable security definer
  set search_path = public, auth as $$
  select role from public.app_users where id = auth.uid() and active = true
$$;

create or replace function public.is_staff()
  returns boolean language sql stable security definer
  set search_path = public, auth as $$
  select exists (select 1 from public.app_users where id = auth.uid() and active = true)
$$;

create or replace function public.is_admin()
  returns boolean language sql stable security definer
  set search_path = public, auth as $$
  select exists (select 1 from public.app_users
                 where id = auth.uid() and active = true and role = 'admin')
$$;

grant execute on function public.current_staff_role(), public.is_staff(), public.is_admin() to authenticated;

-- ── RLS ─────────────────────────────────────────────────────────────────────────
alter table public.app_users enable row level security;

-- A user sees their own row; admins see/manage everyone.
drop policy if exists app_users_self_read on public.app_users;
create policy app_users_self_read on public.app_users
  for select to authenticated using (id = auth.uid() or public.is_admin());

drop policy if exists app_users_admin_write on public.app_users;
create policy app_users_admin_write on public.app_users
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- Any active staff (admin/staff/viewer) can READ the ops tables. Writes go through RPCs below,
-- so no staff INSERT/UPDATE/DELETE policies are granted on these tables.
do $$
declare t text;
begin
  foreach t in array array['packages','events','providers','package_tags','package_notes','package_provider_notes']
  loop
    execute format('drop policy if exists staff_read on public.%I', t);
    execute format('create policy staff_read on public.%I for select to authenticated using (public.is_staff())', t);
  end loop;
end $$;

-- ── Write RPCs (staff-only; SECURITY DEFINER) ───────────────────────────────────
create or replace function public.set_manual_status(p_guia text, p_status text, p_note text default null)
  returns json language plpgsql security definer set search_path = public, auth as $$
declare v_id uuid; v_by text;
begin
  if not public.is_staff() then raise exception 'not authorized'; end if;
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
  if not public.is_staff() then raise exception 'not authorized'; end if;
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
  if not public.is_staff() then raise exception 'not authorized'; end if;
  if coalesce(trim(p_body), '') = '' then raise exception 'note body required'; end if;
  select id into v_id from public.packages where almacen_id = p_guia;
  if v_id is null then raise exception 'package % not found', p_guia; end if;
  select coalesce(email, 'panel') into v_by from public.app_users where id = auth.uid();
  insert into public.package_notes (package_id, body, created_by)
  values (v_id, p_body, v_by);
  return json_build_object('guia', p_guia, 'noted', true);
end $$;

grant execute on function
  public.set_manual_status(text, text, text),
  public.add_package_tag(text, text, text),
  public.add_package_note(text, text)
  to authenticated;

-- ── Stats RPC for the overview (effective status = manual_status ?? status) ──────
create or replace function public.dashboard_stats()
  returns json language sql stable security definer set search_path = public, auth as $$
  select case when public.is_staff() then json_build_object(
    'total',        (select count(*) from public.packages),
    'by_status',    (select coalesce(json_object_agg(s, c), '{}'::json) from (
                       select coalesce(manual_status, status)::text s, count(*) c
                       from public.packages group by 1) t),
    'by_provider',  (select coalesce(json_object_agg(code, c), '{}'::json) from (
                       select pr.code, count(*) c
                       from public.packages p join public.providers pr on pr.id = p.provider_id
                       group by pr.code) t),
    'last_scraped', (select coalesce(json_object_agg(code, ls), '{}'::json) from (
                       select pr.code, max(p.scraped_at) ls
                       from public.packages p join public.providers pr on pr.id = p.provider_id
                       group by pr.code) t),
    'delivered_30d',(select count(*) from public.packages
                       where coalesce(manual_status, status) = 'entregado'
                         and coalesce(last_event_at, received_at) > now() - interval '30 days')
  ) else null end
$$;

grant execute on function public.dashboard_stats() to authenticated;
