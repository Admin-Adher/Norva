begin;
set local lock_timeout='2s';
set local statement_timeout='30s';

-- Preserve the deployed precedence and private invoker contract. Refuse drift.
do $guard$
declare p pg_proc;
begin
  if to_regprocedure('public.norva_catalog_movie_effective_audio_languages(uuid,uuid,text)') is not null
    or md5(pg_get_viewdef('public.cloud_catalog_owned_audio_declarations'::regclass,true))<>'58c12496982052988d6a87303aa0659f'
    or (select md5(prosrc) from pg_proc where oid='public.cloud_catalog_effective_audio_languages_before_owned(uuid,text,uuid,text)'::regprocedure)<>'dc93dc32d35d6ae4893361b2a8f485d4' then
    raise exception 'Unexpected movie audio dependency contract';
  end if;
  select * into strict p from pg_proc where oid='public.cloud_catalog_effective_audio_languages(uuid,text,uuid,text)'::regprocedure;
  if md5(p.prosrc)<>'abf2858d2b088299239318265127d84d' or p.prosecdef or p.provolatile<>'s'
    or p.proconfig is distinct from array['search_path=""']
    or not has_function_privilege('service_role',p.oid,'execute')
    or has_function_privilege('anon',p.oid,'execute')
    or has_function_privilege('authenticated',p.oid,'execute')
    or exists(select 1 from aclexplode(p.proacl) a where a.grantee=0) then
    raise exception 'Unexpected effective audio contract';
  end if;
end $guard$;

-- Share the visible movie scope across observations, owned declarations and
-- fallback hints. Keep all observed languages until precedence is resolved:
-- filtering earlier would revive a stale hint for a conflicting language.
create or replace function public.norva_catalog_movie_effective_audio_languages(p_user_id uuid,p_source_id uuid,p_language text)
returns table(title_id uuid,variant_id uuid,language text)
language sql stable security invoker set search_path='' set enable_nestloop=off as $body$
with variants as materialized (
  select v.id,v.title_id,v.user_id,v.source_id,v.generation_id,v.external_id
  from public.cloud_catalog_visible_title_variants v
  join public.cloud_titles t on t.id=v.title_id and t.user_id=v.user_id and t.item_type=v.item_type
  where v.user_id=p_user_id and v.item_type='movie' and (p_source_id is null or v.source_id=p_source_id)
), codes as materialized (
  select raw_code,case raw_code when 'yue' then 'yue' else public.norva_canonical_language_code(raw_code) end code
  from (select distinct unnest(audio_languages) raw_code from public.cloud_title_file_language_observations
    where user_id=p_user_id and audio_observed) raw
), observed as materialized (
  select v.title_id,v.id variant_id,c.code language
  from variants v
  join public.cloud_title_file_language_observations o on o.user_id=v.user_id and o.title_id=v.title_id
    and o.variant_id=v.id and o.file_external_id=v.external_id and o.audio_observed
  cross join lateral unnest(o.audio_languages) raw(value)
  join codes c on c.raw_code=raw.value and c.code is not null
), observed_variants as materialized (
  select distinct variant_id from observed
), declared as materialized (
  select v.title_id,v.id variant_id,c.language
  from variants v
  join public.catalog_owned_language_declarations d on d.user_id=v.user_id and d.source_id=v.source_id
    and d.variant_id=v.id and d.generation_id=v.generation_id and d.item_type='movie' and d.file_external_id=v.external_id
  join public.cloud_source_lifecycle l on l.source_id=d.source_id and l.user_id=d.user_id
    and l.config_revision=d.config_revision and l.visibility_epoch=d.source_visibility_epoch
  join public.catalog_source_provider_identities i on i.user_id=d.user_id and i.source_id=d.source_id
    and i.identity_id=d.provider_identity_id and i.verified_at is not null
  cross join lateral unnest(d.audio_languages) c(language)
  where exists(select 1 from public.admin_feature_flags where key='owned_provider_language_metadata_enabled' and enabled)
    and (c.language='yue' or public.norva_canonical_language_code(c.language)=c.language)
    and not exists(select 1 from observed_variants o where o.variant_id=v.id)
), declared_variants as materialized (
  select distinct variant_id from declared
), effective as (
  select * from observed
  union
  select * from declared
  union
  select v.title_id,v.id,case h.language when 'fil' then 'tl' else h.language end
  from variants v join public.cloud_catalog_provider_language_hints h
    on h.user_id=v.user_id and h.source_id=v.source_id and h.title_id=v.title_id and h.variant_id=v.id and h.item_type='movie'
  where not exists(select 1 from observed_variants o where o.variant_id=v.id)
    and not exists(select 1 from declared_variants d where d.variant_id=v.id)
)
select * from effective where p_language is null or language=p_language
$body$;

revoke all on function public.norva_catalog_movie_effective_audio_languages(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.norva_catalog_movie_effective_audio_languages(uuid,uuid,text) to service_role;

create or replace function public.cloud_catalog_effective_audio_languages(
  p_user_id uuid,p_item_type text,p_source_id uuid,p_language text
)
returns table(title_id uuid,variant_id uuid,language text)
language plpgsql stable security invoker set search_path='' as $function$
begin
  if p_item_type='movie' then
    return query select e.* from public.norva_catalog_movie_effective_audio_languages(p_user_id,p_source_id,p_language) e;
  else
    -- The existing non-movie query and planner settings remain byte-for-byte.
    return query
with declared as materialized (
    select d.title_id,d.variant_id,d.language from public.cloud_catalog_owned_audio_declarations d
    where d.user_id=p_user_id and d.item_type=p_item_type and (p_source_id is null or d.source_id=p_source_id)
  )
  select b.* from public.cloud_catalog_effective_audio_languages_before_owned(p_user_id,p_item_type,p_source_id,p_language) b
    where (p_language is null or b.language=p_language)
      and not exists(select 1 from declared d where d.variant_id=b.variant_id)
  union
  select d.* from declared d where p_language is null or d.language=p_language;
  end if;
end
$function$;

commit;
