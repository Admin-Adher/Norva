-- Isolated RPC contract fixture only. No production/customer data or network.
create role anon;
create role authenticated;
create role service_role;
create function public.norva_credential_require_service_role() returns void language plpgsql as $$
begin if current_setting('request.jwt.claim.role',true) is distinct from 'service_role' then
 raise exception 'service role required' using errcode='42501'; end if; end $$;
create table public.fixture_epoch(value bigint);
insert into public.fixture_epoch values(7);
create function public.norva_user_catalog_visibility_epoch(uuid) returns bigint language sql stable as $$select value from public.fixture_epoch$$;
create table public.cloud_titles(id uuid primary key,user_id uuid,item_type text,provider_tmdb_id text,identity_key text);
create index on public.cloud_titles(user_id,item_type,provider_tmdb_id);
create table public.cloud_source_catalog_generation_candidate_titles(title_id uuid,user_id uuid,source_id uuid,generation_id uuid,item_type text,provider_tmdb_id text);
create index on public.cloud_source_catalog_generation_candidate_titles(user_id,item_type,provider_tmdb_id,title_id);
create table public.cloud_source_catalog_heads(user_id uuid,source_id uuid,active_generation_id uuid);
create table public.cloud_catalog_visible_sources(user_id uuid,id uuid);
create table public.selection_shared_visible_enrollments(user_id uuid,source_id uuid,release_id uuid);
create table public.selection_shared_titles(release_id uuid,item_type text,provider_tmdb_id text,identity_key text);
create function public.norva_selection_shared_uuid(text) returns uuid language sql immutable as $$select md5($1)::uuid$$;
create table public.fixture_hydration(owner_id uuid,id uuid,payload jsonb,visible boolean default true);
create table public.fixture_control(name text primary key,value text);
-- Model the already-deployed bounded hydration RPC, keeping its ownership and
-- visibility checks explicit. This does not retest its implementation.
create function public.norva_get_visible_catalog_titles_by_ids(p_user uuid,p_ids uuid[],p_epoch bigint)
returns jsonb language sql stable as $$
 select jsonb_build_object('contract',coalesce((select value from public.fixture_control where name='contract'),'catalog-title-hydration-v3'),
 'visibilityEpoch',coalesce((select value::bigint from public.fixture_control where name='epoch'),p_epoch),
 'items',coalesce((select jsonb_agg(payload order by id) from public.fixture_hydration
 where owner_id=p_user and id=any(p_ids) and visible),'[]'))
$$;
set request.jwt.claim.role='service_role';
