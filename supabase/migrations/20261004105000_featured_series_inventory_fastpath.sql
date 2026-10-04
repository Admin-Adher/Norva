begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

-- A due featured inventory is already eligible without scanning the entire
-- account's audio evidence. Retry and provider inventory backoff stay binding.
do $guard$ begin
 if btrim(pg_get_functiondef('public.catalog_series_inventory_candidates(uuid,uuid,integer)'::regprocedure),E' \n\r')<>btrim($before$CREATE OR REPLACE FUNCTION public.catalog_series_inventory_candidates(p_user uuid, p_source uuid, p_limit integer DEFAULT 4)
 RETURNS TABLE(parent_series_id text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with scoped_sources as materialized (
   select * from public.cloud_catalog_visible_sources where id=p_source and user_id=p_user
 ), scoped_variants as materialized (
   select scoped.* from ( SELECT variant.id,
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
   FROM public.cloud_title_variants variant
     JOIN scoped_sources source ON source.id = variant.source_id AND source.user_id = variant.user_id
     LEFT JOIN public.cloud_source_catalog_heads head ON head.source_id = variant.source_id AND head.user_id = variant.user_id
  WHERE variant.generation_id IS NULL OR head.active_generation_id = variant.generation_id) scoped
   where scoped.user_id=p_user and scoped.source_id=p_source and scoped.item_type='series'
 ), unknowns as materialized (
    select variant_id from public.cloud_catalog_unidentified_audio_variants(p_user,'series',p_source)
  )
  select v.external_id
  from scoped_variants v
  join public.cloud_titles t on t.id=v.title_id and t.user_id=v.user_id and t.item_type=v.item_type
  join public.cloud_sources s on s.id=v.source_id and s.user_id=v.user_id
    and s.enabled and s.deleted_at is null and s.source_type='xtream' and s.sync_status='ready'
  join public.cloud_source_catalog_heads h on h.source_id=v.source_id and h.user_id=v.user_id
    and h.active_generation_id=v.generation_id
  join public.catalog_source_provider_identities i on i.source_id=v.source_id and i.user_id=v.user_id
    and i.verified_at is not null
  join public.cloud_source_lifecycle l on l.source_id=v.source_id and l.user_id=v.user_id
  left join unknowns u on u.variant_id=v.id
  left join public.catalog_series_inventory_state inv on inv.user_id=v.user_id and inv.source_id=v.source_id
    and inv.generation_id=v.generation_id
    and inv.parent_variant_id=v.id and inv.parent_series_id=v.external_id and inv.provider_identity_id=i.identity_id
  left join public.catalog_provider_inventory_backoff b on b.source_id=s.id and b.provider_identity_id=i.identity_id
  where v.user_id=p_user and v.source_id=p_source and v.item_type='series' and btrim(v.external_id)<>''
    and (b.provider_identity_id is null or b.next_retry_at<=now())
    and (inv.source_id is null or inv.next_retry_at<=now()
      or ((select public.catalog_owned_language_metadata_enabled_for_source(p_user,p_source))
        and u.variant_id is not null and inv.consecutive_failures=0
        and inv.last_succeeded_at<now()-interval '6 hours'
        and not exists(select 1 from public.catalog_owned_language_declarations d
          where d.variant_id=v.id and d.user_id=v.user_id and d.source_id=v.source_id
            and d.generation_id=v.generation_id and d.provider_identity_id=i.identity_id
            and d.config_revision=l.config_revision and d.source_visibility_epoch=l.visibility_epoch)))
  order by public.catalog_featured_language_rank(v.user_id,v.title_id), (u.variant_id is null), (inv.source_id is not null),
    inv.next_retry_at nulls first,t.release_year desc nulls last,v.external_id,v.id
  limit greatest(1,least(100,coalesce(p_limit,4)))
$function$$before$,E' \n\r') then raise exception 'Featured series inventory function drift';end if;
end $guard$;
CREATE OR REPLACE FUNCTION public.catalog_series_inventory_candidates(p_user uuid, p_source uuid, p_limit integer DEFAULT 4)
 RETURNS TABLE(parent_series_id text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
 SET jit TO 'off'
AS $function$
declare selected_count integer;
begin
 return query
  select v.external_id
  from public.cloud_title_variants v
  join public.catalog_featured_language_titles featured on featured.user_id=v.user_id and featured.title_id=v.title_id and featured.expires_at>now()
  join public.cloud_catalog_visible_sources visible_source on visible_source.id=v.source_id and visible_source.user_id=v.user_id
  join public.cloud_titles t on t.id=v.title_id and t.user_id=v.user_id and t.item_type=v.item_type
  join public.cloud_sources s on s.id=v.source_id and s.user_id=v.user_id
    and s.enabled and s.deleted_at is null and s.source_type='xtream' and s.sync_status='ready'
  join public.cloud_source_catalog_heads h on h.source_id=v.source_id and h.user_id=v.user_id
    and h.active_generation_id=v.generation_id
  join public.catalog_source_provider_identities i on i.source_id=v.source_id and i.user_id=v.user_id
    and i.verified_at is not null
  join public.cloud_source_lifecycle l on l.source_id=v.source_id and l.user_id=v.user_id
  left join public.catalog_series_inventory_state inv on inv.user_id=v.user_id and inv.source_id=v.source_id
    and inv.generation_id=v.generation_id
    and inv.parent_variant_id=v.id and inv.parent_series_id=v.external_id and inv.provider_identity_id=i.identity_id
  left join public.catalog_provider_inventory_backoff b on b.source_id=s.id and b.provider_identity_id=i.identity_id
  where v.user_id=p_user and v.source_id=p_source and v.item_type='series' and btrim(v.external_id)<>''
    and (b.provider_identity_id is null or b.next_retry_at<=now())
    and (inv.source_id is null or inv.next_retry_at<=now())
  order by featured.display_rank, (inv.source_id is not null),
    inv.next_retry_at nulls first,t.release_year desc nulls last,v.external_id,v.id
  limit greatest(1,least(100,coalesce(p_limit,4)));
 get diagnostics selected_count=row_count;
 if selected_count>0 then return; end if;
 return query
with scoped_sources as materialized (
   select * from public.cloud_catalog_visible_sources where id=p_source and user_id=p_user
 ), scoped_variants as materialized (
   select scoped.* from ( SELECT variant.id,
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
   FROM public.cloud_title_variants variant
     JOIN scoped_sources source ON source.id = variant.source_id AND source.user_id = variant.user_id
     LEFT JOIN public.cloud_source_catalog_heads head ON head.source_id = variant.source_id AND head.user_id = variant.user_id
  WHERE variant.generation_id IS NULL OR head.active_generation_id = variant.generation_id) scoped
   where scoped.user_id=p_user and scoped.source_id=p_source and scoped.item_type='series'
 ), unknowns as materialized (
    select variant_id from public.cloud_catalog_unidentified_audio_variants(p_user,'series',p_source)
  )
  select v.external_id
  from scoped_variants v
  join public.cloud_titles t on t.id=v.title_id and t.user_id=v.user_id and t.item_type=v.item_type
  join public.cloud_sources s on s.id=v.source_id and s.user_id=v.user_id
    and s.enabled and s.deleted_at is null and s.source_type='xtream' and s.sync_status='ready'
  join public.cloud_source_catalog_heads h on h.source_id=v.source_id and h.user_id=v.user_id
    and h.active_generation_id=v.generation_id
  join public.catalog_source_provider_identities i on i.source_id=v.source_id and i.user_id=v.user_id
    and i.verified_at is not null
  join public.cloud_source_lifecycle l on l.source_id=v.source_id and l.user_id=v.user_id
  left join unknowns u on u.variant_id=v.id
  left join public.catalog_series_inventory_state inv on inv.user_id=v.user_id and inv.source_id=v.source_id
    and inv.generation_id=v.generation_id
    and inv.parent_variant_id=v.id and inv.parent_series_id=v.external_id and inv.provider_identity_id=i.identity_id
  left join public.catalog_provider_inventory_backoff b on b.source_id=s.id and b.provider_identity_id=i.identity_id
  where v.user_id=p_user and v.source_id=p_source and v.item_type='series' and btrim(v.external_id)<>''
    and (b.provider_identity_id is null or b.next_retry_at<=now())
    and (inv.source_id is null or inv.next_retry_at<=now()
      or ((select public.catalog_owned_language_metadata_enabled_for_source(p_user,p_source))
        and u.variant_id is not null and inv.consecutive_failures=0
        and inv.last_succeeded_at<now()-interval '6 hours'
        and not exists(select 1 from public.catalog_owned_language_declarations d
          where d.variant_id=v.id and d.user_id=v.user_id and d.source_id=v.source_id
            and d.generation_id=v.generation_id and d.provider_identity_id=i.identity_id
            and d.config_revision=l.config_revision and d.source_visibility_epoch=l.visibility_epoch)))
  order by public.catalog_featured_language_rank(v.user_id,v.title_id), (u.variant_id is null), (inv.source_id is not null),
    inv.next_retry_at nulls first,t.release_year desc nulls last,v.external_id,v.id
  limit greatest(1,least(100,coalesce(p_limit,4)));
end
$function$;
notify pgrst,'reload schema';
commit;
