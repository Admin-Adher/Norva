begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

-- Physical title hydration must not hash every shared variant for each card.
-- Bind the physical title's indexed identity before reading its shared variants.
create view public.selection_shared_runtime_physical_variants with(security_invoker=true,security_barrier=true) as
 SELECT variant.id,
    variant.user_id,
    variant.title_id,
    variant.source_id,
    variant.media_item_id,
    variant.item_type,
    variant.external_id,
    variant.raw_title,
    variant.label,
    variant.language,
    variant.quality,
    variant.resolution,
    variant.container_extension,
    variant.poster_url,
    variant.playback_hint,
    variant.codec_profile,
    variant.compatibility_tier,
    variant.playback_cost_score,
    variant.last_observed_ttff_ms,
    variant.observed_success_rate,
    variant.metadata,
    variant.created_at,
    variant.updated_at,
    variant.audio_whisper_attempted_at,
    variant.audio_whisper_retry_at,
    variant.audio_lang_verified_at,
    variant.audio_lang_verify_retry_at,
    variant.generation_id,
    variant.ingest_job_id,
    variant.ingest_attempt,
    variant.ingest_lease_owner,
    variant.write_head_revision,
    variant.write_config_revision,
    variant.write_source_visibility_epoch,
    variant.write_user_visibility_epoch
   FROM cloud_title_variants variant
     JOIN cloud_catalog_visible_sources source ON source.id = variant.source_id AND source.user_id = variant.user_id
     LEFT JOIN cloud_source_catalog_heads head ON head.source_id = variant.source_id AND head.user_id = variant.user_id
  WHERE variant.generation_id IS NULL OR head.active_generation_id = variant.generation_id;
revoke all on public.selection_shared_runtime_physical_variants from public,anon,authenticated;
grant select on public.selection_shared_runtime_physical_variants to service_role;
create function public.norva_selection_title_runtime_variants(p_title_id uuid,p_user_id uuid)
returns setof public.cloud_catalog_visible_title_variants language sql stable set search_path='' as $f$
 select * from public.selection_shared_runtime_physical_variants v where v.user_id=p_user_id and v.title_id=p_title_id
 union all
 select v.id,v.user_id,v.title_id,v.source_id,v.media_item_id,v.item_type,v.external_id,v.raw_title,v.label,v.language,v.quality,v.resolution,v.container_extension,v.poster_url,v.playback_hint,v.codec_profile,v.compatibility_tier,v.playback_cost_score,v.last_observed_ttff_ms,v.observed_success_rate,v.metadata,v.created_at,v.updated_at,v.audio_whisper_attempted_at,v.audio_whisper_retry_at,v.audio_lang_verified_at,v.audio_lang_verify_retry_at,v.generation_id,v.ingest_job_id,v.ingest_attempt,v.ingest_lease_owner,v.write_head_revision,v.write_config_revision,v.write_source_visibility_epoch,v.write_user_visibility_epoch from public.cloud_titles target
 join public.selection_shared_visible_variants v on v.user_id=target.user_id and v.item_type=target.item_type and v.shared_identity_key=target.identity_key
 where target.user_id=p_user_id and target.id=p_title_id
$f$;
revoke all on function public.norva_selection_title_runtime_variants(uuid,uuid) from public,anon,authenticated;
grant execute on function public.norva_selection_title_runtime_variants(uuid,uuid) to service_role;
do $migration$
declare definition text; header text;
begin
 definition:=pg_get_functiondef('public.norva_visible_catalog_title_runtime(uuid,uuid)'::regprocedure);
 if position('public.cloud_catalog_visible_title_variants' in definition)=0 then raise exception 'Title runtime consumer drift'; end if;
 execute replace(replace(definition,'FUNCTION public.norva_visible_catalog_title_runtime(',
   'FUNCTION public.norva_title_runtime_shared_physical('),'public.cloud_catalog_visible_title_variants','public.selection_shared_runtime_physical_variants');
 execute replace(replace(definition,'FUNCTION public.norva_visible_catalog_title_runtime(',
   'FUNCTION public.norva_title_runtime_shared_impl('),'public.cloud_catalog_visible_title_variants','public.norva_selection_title_runtime_variants(p_title_id,p_user_id)');
 header:=replace(split_part(definition,'AS $function$',1),'LANGUAGE sql','LANGUAGE plpgsql');
 execute header||$body$AS $wrapper$ begin
   if public.norva_selection_shared_active(p_user_id) then
     return query select * from public.norva_title_runtime_shared_impl(p_title_id,p_user_id);
   else return query select * from public.norva_title_runtime_shared_physical(p_title_id,p_user_id); end if;
 end $wrapper$;$body$;
end $migration$;
revoke all on function public.norva_title_runtime_shared_physical(uuid,uuid),public.norva_title_runtime_shared_impl(uuid,uuid) from public,anon,authenticated;
grant execute on function public.norva_title_runtime_shared_physical(uuid,uuid),public.norva_title_runtime_shared_impl(uuid,uuid) to service_role;
commit;
