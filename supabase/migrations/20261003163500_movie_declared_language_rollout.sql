-- Reconcile the deployed optimized movie projection with the source-scoped
-- metadata rollout. The retired global flag alone hid successfully imported
-- technical declarations while all sources were admitted by the rollout.
-- Exact observations still outrank declarations; declarations outrank hints.
-- This full definition also records the deployed optimization for rebuilds.
begin;set local lock_timeout='3s';set local statement_timeout='30s';
CREATE OR REPLACE FUNCTION public.norva_catalog_movie_effective_audio_languages(p_user_id uuid, p_source_id uuid, p_language text)
 RETURNS TABLE(title_id uuid, variant_id uuid, language text)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
 SET enable_nestloop TO 'off'
AS $function$
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
  where v.source_id in (select gate_source.id from public.cloud_catalog_visible_sources gate_source
      where gate_source.user_id=p_user_id and (p_source_id is null or gate_source.id=p_source_id)
        and public.catalog_owned_language_metadata_enabled_for_source(gate_source.user_id,gate_source.id))
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
$function$

;
revoke all on function public.norva_catalog_movie_effective_audio_languages(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.norva_catalog_movie_effective_audio_languages(uuid,uuid,text) to service_role;
commit;
