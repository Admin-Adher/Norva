-- Feature flags — an admin-managed key/bool store surfaced in the Système page. This migration builds
-- the MANAGEMENT surface (define / toggle / delete); a flag has effect once a consumer reads it (each
-- consumer is wired per-flag). RLS-on with no policy → only the is_admin()-gated RPCs below can touch
-- it. `public.feature_flag(key)` is a tiny reader other code can call (defaults false when absent).
create table if not exists public.admin_feature_flags (
  key         text primary key,
  enabled     boolean not null default false,
  description text,
  updated_at  timestamptz not null default now(),
  updated_by  text
);
alter table public.admin_feature_flags enable row level security;

insert into public.admin_feature_flags(key, description) values
  ('enrichment_paused', 'Met en pause l''enrichissement (à câbler côté crons)'),
  ('signups_open',      'Autorise les nouvelles inscriptions'),
  ('maintenance_banner','Affiche une bannière de maintenance dans l''app')
on conflict (key) do nothing;

-- Tiny reader for other server code / RPCs (SQL): defaults to false when the flag doesn't exist.
create or replace function public.feature_flag(p_key text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select enabled from public.admin_feature_flags where key = p_key), false);
$$;

create or replace function public.admin_flags_list()
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare v jsonb;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('key',key,'enabled',enabled,'description',description,
           'updated_at',updated_at,'updated_by',updated_by) order by key), '[]'::jsonb)
    into v from public.admin_feature_flags;
  return v;
end; $$;

create or replace function public.admin_flag_set(p_key text, p_enabled boolean)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare v_email text; v_key text := btrim(coalesce(p_key,''));
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  if v_key = '' then raise exception 'empty key' using errcode = '22023'; end if;
  v_email := nullif(auth.jwt() ->> 'email', '');
  update public.admin_feature_flags set enabled = coalesce(p_enabled, false), updated_at = now(), updated_by = v_email
    where key = v_key;
  if not found then raise exception 'unknown flag' using errcode = 'P0002'; end if;
  return jsonb_build_object('key', v_key, 'enabled', coalesce(p_enabled, false));
end; $$;

create or replace function public.admin_flag_create(p_key text, p_description text default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare v_key text := lower(regexp_replace(btrim(coalesce(p_key,'')), '[^a-z0-9_]+', '_', 'g'));
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  if v_key = '' then raise exception 'empty key' using errcode = '22023'; end if;
  insert into public.admin_feature_flags(key, description, updated_by)
    values (left(v_key,60), nullif(btrim(coalesce(p_description,'')),''), nullif(auth.jwt() ->> 'email',''))
    on conflict (key) do update set description = coalesce(excluded.description, admin_feature_flags.description);
  return jsonb_build_object('key', v_key);
end; $$;

create or replace function public.admin_flag_delete(p_key text)
returns boolean language plpgsql volatile security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  delete from public.admin_feature_flags where key = p_key;
  return found;
end; $$;

revoke all on function public.admin_flags_list(), public.admin_flag_set(text, boolean),
  public.admin_flag_create(text, text), public.admin_flag_delete(text) from public, anon;
grant execute on function public.admin_flags_list(), public.admin_flag_set(text, boolean),
  public.admin_flag_create(text, text), public.admin_flag_delete(text) to authenticated;
