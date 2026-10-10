begin;
set local lock_timeout='3s';
set local statement_timeout='30s';
-- Scope candidates and canonicalize each distinct code once. All source,
-- generation, identity, membership, fingerprint and observation guards remain.
create or replace function public.norva_catalog_series_owned_audio_declarations(p_user_id uuid,p_source_id uuid)
returns table(user_id uuid,source_id uuid,item_type text,title_id uuid,variant_id uuid,language text)
language sql stable security invoker set search_path='' set jit=off set enable_nestloop=off
as $function$
with scoped_episode_evidence as materialized (
  select * from public.cloud_catalog_xtream_series_episode_audio_evidence(p_user_id,p_source_id)
  where 'series'::text='series'
), candidates as materialized (
  select v.user_id,v.source_id,v.item_type,v.title_id,v.id as variant_id,v.external_id,d.audio_languages
  from public.catalog_owned_language_declarations d
  join public.cloud_catalog_visible_title_variants v
    on v.id=d.variant_id and v.user_id=d.user_id and v.source_id=d.source_id and v.generation_id=d.generation_id
  join public.cloud_titles t on t.id=v.title_id and t.user_id=v.user_id and t.item_type=v.item_type
  join public.cloud_source_lifecycle lifecycle
    on lifecycle.source_id=d.source_id and lifecycle.user_id=d.user_id
      and lifecycle.config_revision=d.config_revision and lifecycle.visibility_epoch=d.source_visibility_epoch
  join public.catalog_source_provider_identities i
    on i.user_id=d.user_id and i.source_id=d.source_id and i.identity_id=d.provider_identity_id and i.verified_at is not null
  where v.user_id=p_user_id and v.item_type='series'::text and (p_source_id is null or v.source_id=p_source_id)
    and v.source_id in (select gate_source.id from public.cloud_catalog_visible_sources gate_source
      where gate_source.user_id=p_user_id and (p_source_id is null or gate_source.id=p_source_id)
        and public.catalog_owned_language_metadata_enabled_for_source(gate_source.user_id,gate_source.id))
    and ((v.item_type='movie' and d.item_type='movie' and d.file_external_id=v.external_id)
      or (v.item_type='series' and d.item_type='episode' and exists (
        select 1 from public.catalog_series_episode_memberships m
        where m.user_id=v.user_id and m.source_id=v.source_id and m.generation_id=v.generation_id
          and m.parent_variant_id=v.id and m.parent_title_id=v.title_id and m.parent_series_id=v.external_id
          and m.provider_identity_id=d.provider_identity_id and m.episode_id=d.file_external_id
          and m.payload_fingerprint=d.payload_fingerprint)))
), declared_codes as materialized (
  select language,language='yue' or public.norva_canonical_language_code(language)=language as accepted
  from (select distinct unnest(audio_languages) as language from candidates) raw
), observation_codes as materialized (
  select language,language='yue' or public.norva_canonical_language_code(language) is not null as accepted
  from (select distinct unnest(o.audio_languages) as language from public.cloud_title_file_language_observations o
    join candidates v on v.user_id=o.user_id and v.title_id=o.title_id and v.variant_id=o.variant_id
      and v.external_id=o.file_external_id where o.audio_observed) raw
), observed_variants as materialized (
  select distinct v.variant_id from candidates v
  join public.cloud_title_file_language_observations o
    on o.user_id=v.user_id and o.title_id=v.title_id and o.variant_id=v.variant_id
      and o.file_external_id=v.external_id and o.audio_observed
  cross join lateral unnest(o.audio_languages) raw(language)
  join observation_codes code on code.language=raw.language and code.accepted
)
select distinct v.user_id,v.source_id,v.item_type,v.title_id,v.variant_id,c.language
from candidates v cross join lateral unnest(v.audio_languages) c(language)
join declared_codes code on code.language=c.language and code.accepted
where not exists(select 1 from observed_variants o where o.variant_id=v.variant_id)
  and (v.item_type='movie' or not exists(select 1 from scoped_episode_evidence e where e.variant_id=v.variant_id))

$function$;
revoke all on function public.norva_catalog_series_owned_audio_declarations(uuid,uuid) from public,anon,authenticated;
grant execute on function public.norva_catalog_series_owned_audio_declarations(uuid,uuid) to service_role;

-- Preserve the existing movie/other-type body and permissions; the planner
-- adjustment is restricted to the new series helper.
create or replace function public.cloud_catalog_owned_audio_declarations_scoped(p_user_id uuid,p_source_id uuid,p_item_type text)
returns table(user_id uuid,source_id uuid,item_type text,title_id uuid,variant_id uuid,language text)
language plpgsql stable security invoker set search_path=''
as $function$
begin
 if p_item_type='series' then
  return query select * from public.norva_catalog_series_owned_audio_declarations(p_user_id,p_source_id);
 else
  return query
with scoped_episode_evidence as materialized (
   select * from public.cloud_catalog_xtream_series_episode_audio_evidence(p_user_id,p_source_id)
   where p_item_type='series'
 )  SELECT DISTINCT v.user_id,
    v.source_id,
    v.item_type,
    v.title_id,
    v.id AS variant_id,
    c.language
   FROM public.catalog_owned_language_declarations d
     JOIN public.cloud_catalog_visible_title_variants v ON v.id = d.variant_id AND v.user_id = d.user_id AND v.source_id = d.source_id AND v.generation_id = d.generation_id
     JOIN public.cloud_titles t ON t.id = v.title_id AND t.user_id = v.user_id AND t.item_type = v.item_type
     JOIN public.cloud_source_lifecycle lifecycle ON lifecycle.source_id = d.source_id AND lifecycle.user_id = d.user_id AND lifecycle.config_revision = d.config_revision AND lifecycle.visibility_epoch = d.source_visibility_epoch
     JOIN public.catalog_source_provider_identities i ON i.user_id = d.user_id AND i.source_id = d.source_id AND i.identity_id = d.provider_identity_id AND i.verified_at IS NOT NULL
     CROSS JOIN LATERAL unnest(d.audio_languages) c(language)
  WHERE (v.source_id IN (SELECT gate_source.id FROM public.cloud_catalog_visible_sources gate_source

   WHERE gate_source.user_id=p_user_id AND (p_source_id IS NULL OR gate_source.id=p_source_id)

   AND public.catalog_owned_language_metadata_enabled_for_source(gate_source.user_id,gate_source.id))) AND (c.language = 'yue'::text OR public.norva_canonical_language_code(c.language) = c.language) AND (v.item_type = 'movie'::text AND d.item_type = 'movie'::text AND d.file_external_id = v.external_id OR v.item_type = 'series'::text AND d.item_type = 'episode'::text AND (EXISTS ( SELECT 1
           FROM public.catalog_series_episode_memberships m
          WHERE m.user_id = v.user_id AND m.source_id = v.source_id AND m.generation_id = v.generation_id AND m.parent_variant_id = v.id AND m.parent_title_id = v.title_id AND m.parent_series_id = v.external_id AND m.provider_identity_id = d.provider_identity_id AND m.episode_id = d.file_external_id AND m.payload_fingerprint = d.payload_fingerprint))) AND NOT (EXISTS ( SELECT 1
           FROM public.cloud_title_file_language_observations o
             CROSS JOIN LATERAL unnest(o.audio_languages) code(value)
          WHERE o.user_id = v.user_id AND o.title_id = v.title_id AND o.variant_id = v.id AND o.audio_observed AND o.file_external_id = v.external_id AND (code.value = 'yue'::text OR public.norva_canonical_language_code(code.value) IS NOT NULL))) AND (v.item_type = 'movie'::text OR NOT (v.id IN (SELECT e.variant_id FROM scoped_episode_evidence e WHERE e.variant_id IS NOT NULL)))
 and v.user_id=p_user_id and v.item_type=p_item_type
 and (p_source_id is null or v.source_id=p_source_id);
 end if;
end
$function$;
revoke all on function public.cloud_catalog_owned_audio_declarations_scoped(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.cloud_catalog_owned_audio_declarations_scoped(uuid,uuid,text) to service_role;
commit;
