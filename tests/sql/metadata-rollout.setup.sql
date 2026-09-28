-- Networkless disposable PostgreSQL fixture. Existing intake is stubbed;
-- this exercises the new gate, capacity, privileges and rollout state machine.
create role anon;
create role authenticated;
create role service_role;
create schema auth;
create table auth.users(id uuid primary key,deleted_at timestamptz,banned_until timestamptz);
create table public.cloud_sources(id uuid primary key,user_id uuid,enabled boolean,deleted_at timestamptz,sync_status text);
create table public.catalog_language_metadata_capacity(singleton boolean,max_workers int,expires_at timestamptz);
create table public.catalog_vod_language_intake(state text,lease_until timestamptz);
create table public.fixture_global(enabled boolean);
insert into public.fixture_global values(false);
create function public.catalog_language_metadata_lane_enabled() returns boolean language sql stable
as $$select enabled from public.fixture_global$$;
create function public.catalog_language_metadata_available() returns boolean language sql as $$select false$$;
create function public.norva_credential_require_service_role() returns void language plpgsql as $$
begin
 if current_setting('request.jwt.claim.role',true) is distinct from 'service_role' then
  raise exception 'service role required' using errcode='42501';
 end if;
end $$;
create function public.claim_catalog_vod_language_file(p_user uuid,p_source uuid) returns jsonb language plpgsql as $$
begin
 if public.catalog_language_metadata_lane_enabled() then
  if not public.catalog_language_metadata_available() then return '{"skipped":"metadata-capacity"}'; end if;
  return '{"path":"metadata"}';
 end if;
 return '{"path":"legacy"}';
end $$;
create function public.metadata_rollout_assert(ok boolean,label text) returns void language plpgsql as $$
begin
 if ok is distinct from true then raise exception 'metadata_rollout_%',label; end if;
 raise notice 'PASS %',label;
end $$;
insert into auth.users(id) select ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid from generate_series(1,200) n;
insert into public.cloud_sources select id,id,true,null,'ready' from auth.users;
