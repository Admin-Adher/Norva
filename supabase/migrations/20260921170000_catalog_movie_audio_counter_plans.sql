begin;
set local lock_timeout = '2s';
set local statement_timeout = '15s';

-- Existing RPCs remain untouched for series and legacy callers. Refuse an
-- unexpected installation rather than obscure an earlier planner change.
do $guard$
declare
  signature text;
  function_oid oid;
begin
  foreach signature in array array[
    'public.cloud_catalog_audio_language_counts(uuid,text,uuid)',
    'public.cloud_catalog_unidentified_audio_count(uuid,text,uuid)'
  ] loop
    function_oid := to_regprocedure(signature);
    if function_oid is null or exists (
      select 1 from pg_proc p where p.oid=function_oid
        and (p.prosecdef or p.provolatile<>'s'
          or p.proconfig is distinct from array['search_path=""']
          or not has_function_privilege('service_role',p.oid,'execute')
          or has_function_privilege('anon',p.oid,'execute')
          or has_function_privilege('authenticated',p.oid,'execute')
          or exists(select 1 from aclexplode(p.proacl) a where a.grantee=0))
    ) then
      raise exception 'Unexpected catalogue counter contract: %', signature;
    end if;
  end loop;
end $guard$;

-- Movie catalogues benefit from hash/merge joins over their large visible
-- variant set. Series episode evidence needs its existing nested-loop plans.
-- Keep this setting on private movie-only helpers, never on shared relations.
create or replace function public.norva_catalog_movie_audio_language_counts(
  p_user_id uuid,
  p_source_id uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
set enable_nestloop = off
as $function$
  select coalesce(jsonb_object_agg(language,count),'{}'::jsonb) from (
    select language,count(distinct title_id) as count
    from public.cloud_catalog_effective_audio_languages(p_user_id,'movie',p_source_id)
    group by language
  ) counts
$function$;

create or replace function public.norva_catalog_movie_unidentified_audio_count(
  p_user_id uuid,
  p_source_id uuid
)
returns bigint
language sql
stable
security invoker
set search_path = ''
set enable_nestloop = off
as $function$
  select count(distinct title_id)
  from public.cloud_catalog_unidentified_audio_variants(p_user_id,'movie',p_source_id)
$function$;

revoke all on function public.norva_catalog_movie_audio_language_counts(uuid,uuid) from public,anon,authenticated;
revoke all on function public.norva_catalog_movie_unidentified_audio_count(uuid,uuid) from public,anon,authenticated;
grant execute on function public.norva_catalog_movie_audio_language_counts(uuid,uuid) to service_role;
grant execute on function public.norva_catalog_movie_unidentified_audio_count(uuid,uuid) to service_role;

-- Edge routes movies to these two RPCs explicitly. Do not replace the original
-- counters: their SQL body, execution context and series plans stay unchanged.
do $verify$
declare
  signature text;
begin
  foreach signature in array array[
    'public.norva_catalog_movie_audio_language_counts(uuid,uuid)',
    'public.norva_catalog_movie_unidentified_audio_count(uuid,uuid)'
  ] loop
    if exists (
      select 1 from pg_proc p where p.oid=signature::regprocedure
        and (p.prosecdef or p.provolatile<>'s'
          or p.proconfig is distinct from array['search_path=""','enable_nestloop=off']
          or not has_function_privilege('service_role',p.oid,'execute')
          or has_function_privilege('anon',p.oid,'execute')
          or has_function_privilege('authenticated',p.oid,'execute')
          or exists(select 1 from aclexplode(p.proacl) a where a.grantee=0))
    ) then
      raise exception 'Unexpected private movie counter contract: %', signature;
    end if;
  end loop;
end $verify$;

commit;
