-- Run after 20260921183000_catalog_movie_audio_scope.sql. All sentinels roll back.
begin;
set local lock_timeout='2s';
set local statement_timeout='30s';
set local enable_nestloop=on;

do $contracts$
declare p pg_proc;
begin
  select * into strict p from pg_proc where oid='public.norva_catalog_movie_effective_audio_languages(uuid,uuid,text)'::regprocedure;
  if p.prosecdef or p.provolatile<>'s'
    or p.proconfig is distinct from array['search_path=""','enable_nestloop=off']
    or not has_function_privilege('service_role',p.oid,'execute')
    or has_function_privilege('anon',p.oid,'execute')
    or has_function_privilege('authenticated',p.oid,'execute')
    or exists(select 1 from aclexplode(p.proacl) a where a.grantee=0) then
    raise exception 'Movie audio helper lost its private invoker contract';
  end if;
  if exists(select 1 from public.cloud_catalog_effective_audio_languages('00000000-0000-0000-0000-000000000000','movie',null,null)) then
    raise exception 'An empty owner received another account audio evidence';
  end if;
  if current_setting('enable_nestloop')<>'on' then raise exception 'Planner setting leaked'; end if;
end $contracts$;

create or replace function public.norva_catalog_movie_effective_audio_languages(p_user_id uuid,p_source_id uuid,p_language text)
returns table(title_id uuid,variant_id uuid,language text)
language sql stable security invoker set search_path='' set enable_nestloop=off
as $sentinel$ select p_user_id,p_source_id,p_language $sentinel$;

do $dispatch$
declare
  owner_id constant uuid:='00000000-0000-0000-0000-000000000001';
  source_id constant uuid:='00000000-0000-0000-0000-000000000002';
  actual record;
  kind text;
begin
  select * into strict actual from public.cloud_catalog_effective_audio_languages(owner_id,'movie',source_id,'fr');
  if actual.title_id<>owner_id or actual.variant_id<>source_id or actual.language<>'fr' then
    raise exception 'Movie dispatcher changed scope or requested language';
  end if;
  foreach kind in array array['series',null::text,'unknown'] loop
    if exists(select 1 from public.cloud_catalog_effective_audio_languages(owner_id,kind,source_id,'fr')) then
      raise exception 'Non-movie query entered the movie helper';
    end if;
  end loop;
  if current_setting('enable_nestloop')<>'on' then raise exception 'Dispatcher leaked planner state'; end if;
  raise notice 'PASS: private invoker, empty owner, scope/language forwarding, isolated series/null/unknown dispatch, restored planner';
end $dispatch$;
rollback;
