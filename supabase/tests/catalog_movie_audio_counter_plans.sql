-- Run after 20260921170000_catalog_movie_audio_counter_plans.sql.
-- Sentinel helpers prove that the original counters remain independent of
-- the new movie route. Every helper replacement is rolled back.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';
set local enable_nestloop = on;

do $contracts$
declare
  signature text;
  expected_config text[];
begin
  foreach signature in array array[
    'public.cloud_catalog_audio_language_counts(uuid,text,uuid)',
    'public.cloud_catalog_unidentified_audio_count(uuid,text,uuid)',
    'public.norva_catalog_movie_audio_language_counts(uuid,uuid)',
    'public.norva_catalog_movie_unidentified_audio_count(uuid,uuid)'
  ] loop
    expected_config := case when signature like 'public.norva_catalog_movie_%'
      then array['search_path=""','enable_nestloop=off']
      else array['search_path=""'] end;
    if exists (
      select 1 from pg_proc p where p.oid=signature::regprocedure
        and (p.prosecdef or p.provolatile<>'s'
          or p.proconfig is distinct from expected_config
          or not has_function_privilege('service_role',p.oid,'execute')
          or has_function_privilege('anon',p.oid,'execute')
          or has_function_privilege('authenticated',p.oid,'execute')
          or exists(select 1 from aclexplode(p.proacl) a where a.grantee=0))
    ) then
      raise exception 'Counter contract failed: %', signature;
    end if;
  end loop;
end $contracts$;

do $empty_scope$
declare
  empty_owner constant uuid := '00000000-0000-0000-0000-000000000000';
begin
  if public.norva_catalog_movie_audio_language_counts(empty_owner,null) is distinct from '{}'::jsonb
    or public.norva_catalog_movie_unidentified_audio_count(empty_owner,null) is distinct from 0::bigint then
    raise exception 'Private movie counters did not isolate an empty owner';
  end if;
  if current_setting('enable_nestloop')<>'on' then
    raise exception 'Movie planner setting leaked after successful call';
  end if;
end $empty_scope$;

create or replace function public.norva_catalog_movie_audio_language_counts(
  p_user_id uuid,p_source_id uuid
)
returns jsonb language plpgsql stable security invoker
set search_path = '' set enable_nestloop = off
as $sentinel$
begin
  raise exception using errcode='PNR01',message='Movie audio sentinel';
end $sentinel$;

create or replace function public.norva_catalog_movie_unidentified_audio_count(
  p_user_id uuid,p_source_id uuid
)
returns bigint language plpgsql stable security invoker
set search_path = '' set enable_nestloop = off
as $sentinel$
begin
  raise exception using errcode='PNR02',message='Movie unidentified sentinel';
end $sentinel$;

do $independence$
declare
  empty_owner constant uuid := '00000000-0000-0000-0000-000000000000';
  kind text;
  audio jsonb;
  unidentified bigint;
begin
  foreach kind in array array['movie','series',null::text,'unknown'] loop
    audio := public.cloud_catalog_audio_language_counts(empty_owner,kind,null);
    unidentified := public.cloud_catalog_unidentified_audio_count(empty_owner,kind,null);
    if audio is distinct from '{}'::jsonb or unidentified is distinct from 0::bigint then
      raise exception 'Original count changed for empty owner';
    end if;
    if current_setting('enable_nestloop')<>'on' then
      raise exception 'Movie planner setting leaked to original counter';
    end if;
  end loop;
  begin
    perform public.norva_catalog_movie_audio_language_counts(empty_owner,null);
    raise exception 'Movie audio helper was not called';
  exception when sqlstate 'PNR01' then null;
  end;
  begin
    perform public.norva_catalog_movie_unidentified_audio_count(empty_owner,null);
    raise exception 'Movie unidentified helper was not called';
  exception when sqlstate 'PNR02' then null;
  end;
  if current_setting('enable_nestloop')<>'on' then
    raise exception 'Movie planner setting leaked after helper exception';
  end if;
  raise notice 'PASS: four service-only contracts, empty owner isolated, eight independent original calls, two movie sentinels, setting restored after success and exceptions';
end $independence$;

rollback;
