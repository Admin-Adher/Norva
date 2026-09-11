-- Serialize import hydration with exact-file replacement and certification.
-- A SELECT cursor without a cache lock can carry an old certificate across an
-- observation's commit and reinsert it after the global invalidation succeeds.
-- Lock only existing exact cache rows before writing any owner projection; read
-- them again after the wait. New rows outside the captured set are left to the
-- normal cache fanout / next hydration, not read unlocked inside this transaction.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

-- Existing ownership, signature, ACL and security attributes are preserved.
CREATE OR REPLACE FUNCTION public.hydrate_catalog_episode_file_tracks(p_user_id uuid, p_source_id uuid, p_parent_series_id text, p_episode_ids text[] DEFAULT NULL::text[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_hydration_file_ids text[];
  v_hydration_provider_ids text[];
  v_hydration_provider_id text;
  v_episode record;
  v_title_id uuid;
  v_title_ids uuid[] := '{}'::uuid[];
  v_count integer := 0;
begin
  if p_user_id is null
     or p_source_id is null
     or coalesce(btrim(p_parent_series_id), '') = '' then
    return 0;
  end if;

  -- Exact-file hydration serialization v1: provider lock precedes cache rows,
  -- matching episode observation/fanout, then owner ledgers/facets are written.
  select coalesce(array_agg(provider_id order by provider_id),'{}'::text[])
    into v_hydration_provider_ids
  from (
    select distinct membership.provider_identity_id::text provider_id
    from public.catalog_series_episode_memberships membership
    where membership.user_id=p_user_id and membership.source_id=p_source_id
      and membership.parent_series_id=btrim(p_parent_series_id)
      and (p_episode_ids is null or membership.episode_id=any(p_episode_ids))
  ) providers;
  foreach v_hydration_provider_id in array v_hydration_provider_ids loop
    perform pg_advisory_xact_lock(hashtextextended(
      'catalog-series-episode-provider:' || v_hydration_provider_id,0));
  end loop;
  select coalesce(array_agg(locked.file_key),'{}'::text[]) into v_hydration_file_ids
  from (
    select cache.server_host || ':' || cache.external_id file_key
    from public.catalog_file_tracks cache
    where cache.item_type='episode' and cache.server_host=any(v_hydration_provider_ids)
      and (cache.audio_probed_at is not null or cache.subtitle_probed_at is not null)
      and exists (
        select 1 from public.catalog_series_episode_memberships membership
        where membership.user_id=p_user_id and membership.source_id=p_source_id
          and membership.parent_series_id=btrim(p_parent_series_id)
          and membership.provider_identity_id::text=cache.server_host
          and membership.episode_id=cache.external_id
          and (p_episode_ids is null or membership.episode_id=any(p_episode_ids))
      )
    order by cache.server_host,cache.external_id
    for share of cache
  ) locked;

  for v_episode in
    select membership.episode_id
    from public.catalog_series_episode_memberships membership
    join public.cloud_sources source
      on source.id = membership.source_id
     and source.user_id = membership.user_id
     and source.deleted_at is null
     and source.enabled = true
    join public.catalog_file_tracks cache
      on cache.server_host = membership.provider_identity_id::text
     and cache.item_type = 'episode'
     and cache.external_id = membership.episode_id
     and (
       cache.audio_probed_at is not null
       or cache.subtitle_probed_at is not null
     )
    where membership.user_id = p_user_id
      and membership.source_id = p_source_id
      and membership.parent_series_id = btrim(p_parent_series_id)
      and (membership.provider_identity_id::text || ':' || membership.episode_id)=any(v_hydration_file_ids)
      and (
        p_episode_ids is null
        or membership.episode_id = any(p_episode_ids)
      )
    order by
      membership.season_number nulls last,
      membership.episode_number nulls last,
      membership.episode_id
  loop
    v_title_id := public.merge_catalog_episode_file_observation(
      p_user_id,
      p_source_id,
      btrim(p_parent_series_id),
      v_episode.episode_id,
      true,
      true
    );
    if v_title_id is not null then
      if not (v_title_id = any(v_title_ids)) then
        v_title_ids := array_append(v_title_ids, v_title_id);
      end if;
      v_count := v_count + 1;
    end if;
  end loop;

  foreach v_title_id in array v_title_ids
  loop
    perform public.recompute_cloud_title_file_languages(p_user_id, v_title_id);
  end loop;

  return v_count;
end
$function$;

-- Existing ownership, signature, ACL and security attributes are preserved.
CREATE OR REPLACE FUNCTION public.hydrate_catalog_episode_file_tracks(p_user_id uuid, p_source_id uuid, p_generation_id uuid, p_head_revision bigint, p_config_revision bigint, p_source_visibility_epoch bigint, p_user_visibility_epoch bigint, p_parent_series_id text, p_episode_ids text[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_hydration_file_ids text[];
  v_hydration_provider_ids text[];
  v_hydration_provider_id text;
  v_episode record; v_title_id uuid; v_title_ids uuid[]:='{}'::uuid[];
  v_audio_languages text[]; v_subtitle_languages text[];
  v_audio_observed boolean; v_subtitle_observed boolean; v_count integer:=0;
begin
  perform public.norva_set_catalog_delete_proof(
    p_source_id,p_user_id,p_generation_id,p_head_revision,p_config_revision,
    p_source_visibility_epoch,p_user_visibility_epoch
  );
  if coalesce(btrim(p_parent_series_id),'')='' then return 0; end if;
  -- Exact-file hydration serialization v1: provider lock precedes cache rows,
  -- matching episode observation/fanout, then owner ledgers/facets are written.
  select coalesce(array_agg(provider_id order by provider_id),'{}'::text[])
    into v_hydration_provider_ids
  from (
    select distinct membership.provider_identity_id::text provider_id
    from public.catalog_series_episode_memberships membership
    where membership.user_id=p_user_id and membership.source_id=p_source_id
        and membership.generation_id=p_generation_id
      and membership.parent_series_id=btrim(p_parent_series_id)
      and (p_episode_ids is null or membership.episode_id=any(p_episode_ids))
  ) providers;
  foreach v_hydration_provider_id in array v_hydration_provider_ids loop
    perform pg_advisory_xact_lock(hashtextextended(
      'catalog-series-episode-provider:' || v_hydration_provider_id,0));
  end loop;
  select coalesce(array_agg(locked.file_key),'{}'::text[]) into v_hydration_file_ids
  from (
    select cache.server_host || ':' || cache.external_id file_key
    from public.catalog_file_tracks cache
    where cache.item_type='episode' and cache.server_host=any(v_hydration_provider_ids)
      and (cache.audio_probed_at is not null or cache.subtitle_probed_at is not null)
      and exists (
        select 1 from public.catalog_series_episode_memberships membership
        where membership.user_id=p_user_id and membership.source_id=p_source_id
        and membership.generation_id=p_generation_id
          and membership.parent_series_id=btrim(p_parent_series_id)
          and membership.provider_identity_id::text=cache.server_host
          and membership.episode_id=cache.external_id
          and (p_episode_ids is null or membership.episode_id=any(p_episode_ids))
      )
    order by cache.server_host,cache.external_id
    for share of cache
  ) locked;
  -- A wait may outlive the source generation/config/visibility snapshot.
  perform public.norva_set_catalog_delete_proof(
    p_source_id,p_user_id,p_generation_id,p_head_revision,p_config_revision,
    p_source_visibility_epoch,p_user_visibility_epoch
  );

  for v_episode in
    select membership.parent_title_id,membership.parent_variant_id,
      membership.provider_identity_id,membership.parent_series_id,membership.episode_id,
      membership.season_number,membership.episode_number,
      cache.audio_tracks,cache.subtitle_tracks,cache.audio_probed_at,
      cache.subtitle_probed_at,cache.audio_lang_verified_at,cache.audio_lang_verification
    from public.catalog_series_episode_memberships membership
    join public.catalog_file_tracks cache
      on cache.server_host=membership.provider_identity_id::text
     and cache.item_type='episode' and cache.external_id=membership.episode_id
    where membership.user_id=p_user_id and membership.source_id=p_source_id
      and membership.generation_id=p_generation_id
      and membership.parent_series_id=btrim(p_parent_series_id)
      and (membership.provider_identity_id::text || ':' || membership.episode_id)=any(v_hydration_file_ids)
      and (p_episode_ids is null or membership.episode_id=any(p_episode_ids))
      and (cache.audio_probed_at is not null or cache.subtitle_probed_at is not null)
    order by membership.season_number nulls last,
      membership.episode_number nulls last,membership.episode_id
  loop
    if exists (
      select 1 from public.catalog_series_episode_memberships conflicting
      where conflicting.generation_id=p_generation_id
        and conflicting.provider_identity_id=v_episode.provider_identity_id
        and conflicting.episode_id=v_episode.episode_id
        and conflicting.parent_series_id is distinct from v_episode.parent_series_id
    ) then
      raise exception 'Ambiguous provider episode coordinates' using errcode='23505';
    end if;
    v_audio_observed:=v_episode.audio_probed_at is not null;
    v_subtitle_observed:=v_episode.subtitle_probed_at is not null;
    v_audio_languages:=case when v_audio_observed
      then public.cloud_file_track_languages(v_episode.audio_tracks) else '{}'::text[] end;
    v_subtitle_languages:=case when v_subtitle_observed
      then public.cloud_file_track_languages(v_episode.subtitle_tracks) else '{}'::text[] end;
    insert into public.cloud_title_file_language_observations as observation (
      user_id,title_id,variant_id,file_external_id,audio_languages,subtitle_languages,
      audio_observed,subtitle_observed,audio_verified_at,audio_verification,updated_at
    ) values (
      p_user_id,v_episode.parent_title_id,v_episode.parent_variant_id,v_episode.episode_id,
      v_audio_languages,v_subtitle_languages,v_audio_observed,v_subtitle_observed,null,
      case when v_audio_observed then coalesce(v_episode.audio_lang_verification,'{}'::jsonb) else '{}'::jsonb end,
      clock_timestamp()
    ) on conflict (user_id,variant_id,file_external_id) do update set
      title_id=excluded.title_id,
      audio_languages=case when observation.audio_verified_at is not null then observation.audio_languages
        when excluded.audio_observed then excluded.audio_languages else observation.audio_languages end,
      subtitle_languages=case when excluded.subtitle_observed then excluded.subtitle_languages else observation.subtitle_languages end,
      audio_observed=observation.audio_observed or excluded.audio_observed,
      subtitle_observed=observation.subtitle_observed or excluded.subtitle_observed,
      audio_verified_at=observation.audio_verified_at,
      audio_verification=case when observation.audio_verified_at is not null then observation.audio_verification
        when excluded.audio_observed then excluded.audio_verification else observation.audio_verification end,
      updated_at=clock_timestamp();
    if v_audio_observed and v_episode.audio_lang_verified_at is not null
       and cardinality(v_audio_languages)>0 then
      update public.cloud_title_file_language_observations observation
      set audio_verified_at=v_episode.audio_lang_verified_at,
          audio_verification=coalesce(v_episode.audio_lang_verification,'{}'::jsonb)
            ||jsonb_build_object('status','verified','scope','canonical-episode-file'),
          updated_at=clock_timestamp()
      where observation.user_id=p_user_id
        and observation.title_id=v_episode.parent_title_id
        and observation.variant_id=v_episode.parent_variant_id
        and observation.file_external_id=v_episode.episode_id
        and observation.audio_verified_at is null and observation.audio_observed
        and observation.audio_languages=v_audio_languages;
    elsif v_audio_observed then
      update public.cloud_title_file_language_observations observation
      set audio_verification=coalesce(v_episode.audio_lang_verification,'{}'::jsonb)
            ||jsonb_build_object('scope','canonical-episode-file'),updated_at=clock_timestamp()
      where observation.user_id=p_user_id
        and observation.title_id=v_episode.parent_title_id
        and observation.variant_id=v_episode.parent_variant_id
        and observation.file_external_id=v_episode.episode_id
        and observation.audio_verified_at is null and observation.audio_observed
        and observation.audio_languages=v_audio_languages;
    end if;
    v_title_id:=v_episode.parent_title_id;
    if not (v_title_id=any(v_title_ids)) then v_title_ids:=array_append(v_title_ids,v_title_id); end if;
    v_count:=v_count+1;
  end loop;
  foreach v_title_id in array v_title_ids loop
    perform public.recompute_cloud_title_file_languages(p_user_id,v_title_id);
  end loop;
  return v_count;
end
$function$;

-- Existing ownership, signature, ACL and security attributes are preserved.
CREATE OR REPLACE FUNCTION public.hydrate_cloud_title_file_languages(p_user_id uuid, p_source_id uuid, p_server_key text, p_item_type text, p_external_ids text[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_hydration_file_ids text[];
  v_file record;
  v_title_id uuid;
  v_title_ids uuid[] := '{}'::uuid[];
  v_cache_key text;
  v_audio_languages text[];
  v_audio_verified boolean;
  v_count integer := 0;
begin
  if p_user_id is null
     or p_source_id is null
     or p_item_type is distinct from 'movie' then
    return 0;
  end if;

  v_cache_key := public.catalog_source_file_cache_key(p_source_id, p_user_id);
  if coalesce(btrim(v_cache_key), '') = '' then return 0; end if;

  -- Exact-file hydration serialization v1: cache before owner ledgers/facets.
  select coalesce(array_agg(locked.external_id),'{}'::text[]) into v_hydration_file_ids
  from (
    select cache.external_id from public.catalog_file_tracks cache
    where cache.server_host=v_cache_key and cache.item_type='movie'
      and (cache.audio_probed_at is not null or cache.subtitle_probed_at is not null)
      and exists (
        select 1 from public.cloud_title_variants variant
        where variant.user_id=p_user_id and variant.source_id=p_source_id
          and variant.item_type='movie' and variant.title_id is not null
          and variant.external_id=cache.external_id
          and (p_external_ids is null or variant.external_id=any(p_external_ids))
      )
    order by cache.external_id
    for share of cache
  ) locked;

  for v_file in
    select
      variant.user_id,
      variant.title_id,
      variant.id as variant_id,
      variant.external_id,
      cache.audio_tracks,
      cache.subtitle_tracks,
      cache.audio_probed_at is not null as audio_observed,
      cache.subtitle_probed_at is not null as subtitle_observed,
      cache.audio_lang_verified_at,
      cache.audio_lang_retry_at,
      cache.audio_lang_verification
    from public.cloud_title_variants variant
    join public.catalog_file_tracks cache
      on cache.server_host = v_cache_key
     and cache.item_type = variant.item_type
     and cache.external_id = variant.external_id
    where variant.user_id = p_user_id
      and variant.source_id = p_source_id
      and variant.item_type = 'movie'
      and variant.title_id is not null
      and variant.external_id=any(v_hydration_file_ids)
      and (p_external_ids is null or variant.external_id = any(p_external_ids))
      and (
        cache.audio_probed_at is not null
        or cache.subtitle_probed_at is not null
      )
    order by variant.title_id, variant.id
  loop
    v_audio_languages := case
      when v_file.audio_observed
        then public.cloud_file_track_languages(v_file.audio_tracks)
      else '{}'::text[]
    end;
    v_audio_verified := v_file.audio_observed
      and v_file.audio_lang_verified_at is not null
      and cardinality(v_audio_languages) > 0;

    insert into public.cloud_title_file_language_observations as observation (
      user_id, title_id, variant_id, file_external_id,
      audio_languages, subtitle_languages,
      audio_observed, subtitle_observed,
      audio_verified_at, audio_verification, updated_at
    ) values (
      v_file.user_id,
      v_file.title_id,
      v_file.variant_id,
      v_file.external_id,
      v_audio_languages,
      case
        when v_file.subtitle_observed
          then public.cloud_file_track_languages(v_file.subtitle_tracks)
        else '{}'::text[]
      end,
      v_file.audio_observed,
      v_file.subtitle_observed,
      case when v_audio_verified then v_file.audio_lang_verified_at else null end,
      case
        when v_audio_verified
          then coalesce(v_file.audio_lang_verification, '{}'::jsonb)
        else '{}'::jsonb
      end,
      clock_timestamp()
    )
    on conflict (user_id, variant_id, file_external_id) do update set
      title_id = excluded.title_id,
      audio_languages = case
        when excluded.audio_observed then excluded.audio_languages
        else observation.audio_languages
      end,
      subtitle_languages = case
        when excluded.subtitle_observed then excluded.subtitle_languages
        else observation.subtitle_languages
      end,
      audio_observed = observation.audio_observed or excluded.audio_observed,
      subtitle_observed = observation.subtitle_observed or excluded.subtitle_observed,
      updated_at = clock_timestamp();

    -- The verification-reset trigger correctly clears a changed audio map on
    -- conflict. Restore the certificate only after the canonical map is stored.
    update public.cloud_title_file_language_observations observation
       set audio_verified_at = case
             when v_audio_verified then v_file.audio_lang_verified_at
             else null
           end,
           audio_verification = case
             when v_audio_verified
               then coalesce(v_file.audio_lang_verification, '{}'::jsonb)
             else '{}'::jsonb
           end,
           updated_at = clock_timestamp()
     where observation.user_id = v_file.user_id
       and observation.variant_id = v_file.variant_id
       and observation.file_external_id = v_file.external_id;

    update public.cloud_title_variants variant
       set audio_lang_verified_at = case
             when v_audio_verified then v_file.audio_lang_verified_at
             else null
           end,
           audio_lang_verify_retry_at = case
             when v_audio_verified then null
             else v_file.audio_lang_retry_at
           end
     where variant.user_id = v_file.user_id
       and variant.id = v_file.variant_id;

    if not (v_file.title_id = any(v_title_ids)) then
      v_title_ids := array_append(v_title_ids, v_file.title_id);
    end if;
    v_count := v_count + 1;
  end loop;

  foreach v_title_id in array v_title_ids
  loop
    perform public.recompute_cloud_title_file_languages(p_user_id, v_title_id);
  end loop;

  return v_count;
end
$function$;

-- Existing ownership, signature, ACL and security attributes are preserved.
CREATE OR REPLACE FUNCTION public.hydrate_cloud_title_file_languages(p_user_id uuid, p_source_id uuid, p_generation_id uuid, p_head_revision bigint, p_config_revision bigint, p_source_visibility_epoch bigint, p_user_visibility_epoch bigint, p_server_key text, p_item_type text, p_external_ids text[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_hydration_file_ids text[];
  v_file record; v_title_id uuid; v_title_ids uuid[]:='{}'::uuid[];
  v_cache_key text; v_audio_languages text[]; v_audio_verified boolean; v_count integer:=0;
begin
  perform public.norva_set_catalog_delete_proof(
    p_source_id,p_user_id,p_generation_id,p_head_revision,p_config_revision,
    p_source_visibility_epoch,p_user_visibility_epoch
  );
  if p_item_type is distinct from 'movie'
     or (p_server_key is not null and length(p_server_key)>512) then return 0; end if;
  v_cache_key:=public.catalog_source_file_cache_key(p_source_id,p_user_id);
  if coalesce(btrim(v_cache_key),'')='' then return 0; end if;
  -- Exact-file hydration serialization v1: cache before owner ledgers/facets.
  select coalesce(array_agg(locked.external_id),'{}'::text[]) into v_hydration_file_ids
  from (
    select cache.external_id from public.catalog_file_tracks cache
    where cache.server_host=v_cache_key and cache.item_type='movie'
      and (cache.audio_probed_at is not null or cache.subtitle_probed_at is not null)
      and exists (
        select 1 from public.cloud_title_variants variant
        where variant.user_id=p_user_id and variant.source_id=p_source_id
        and variant.generation_id=p_generation_id
          and variant.item_type='movie' and variant.title_id is not null
          and variant.external_id=cache.external_id
          and (p_external_ids is null or variant.external_id=any(p_external_ids))
      )
    order by cache.external_id
    for share of cache
  ) locked;
  -- A wait may outlive the source generation/config/visibility snapshot.
  perform public.norva_set_catalog_delete_proof(
    p_source_id,p_user_id,p_generation_id,p_head_revision,p_config_revision,
    p_source_visibility_epoch,p_user_visibility_epoch
  );

  for v_file in
    select variant.user_id,variant.title_id,variant.id variant_id,variant.external_id,
      cache.audio_tracks,cache.subtitle_tracks,cache.audio_probed_at is not null audio_observed,
      cache.subtitle_probed_at is not null subtitle_observed,cache.audio_lang_verified_at,
      cache.audio_lang_retry_at,cache.audio_lang_verification
    from public.cloud_title_variants variant
    join public.catalog_file_tracks cache on cache.server_host=v_cache_key
      and cache.item_type=variant.item_type and cache.external_id=variant.external_id
    where variant.user_id=p_user_id and variant.source_id=p_source_id
      and variant.generation_id=p_generation_id and variant.item_type='movie'
      and variant.title_id is not null
      and variant.external_id=any(v_hydration_file_ids)
      and (p_external_ids is null or variant.external_id=any(p_external_ids))
      and (cache.audio_probed_at is not null or cache.subtitle_probed_at is not null)
    order by variant.title_id,variant.id
  loop
    v_audio_languages:=case when v_file.audio_observed then public.cloud_file_track_languages(v_file.audio_tracks) else '{}'::text[] end;
    v_audio_verified:=v_file.audio_observed and v_file.audio_lang_verified_at is not null and cardinality(v_audio_languages)>0;
    insert into public.cloud_title_file_language_observations as observation (
      user_id,title_id,variant_id,file_external_id,audio_languages,subtitle_languages,
      audio_observed,subtitle_observed,audio_verified_at,audio_verification,updated_at
    ) values (
      v_file.user_id,v_file.title_id,v_file.variant_id,v_file.external_id,v_audio_languages,
      case when v_file.subtitle_observed then public.cloud_file_track_languages(v_file.subtitle_tracks) else '{}'::text[] end,
      v_file.audio_observed,v_file.subtitle_observed,
      case when v_audio_verified then v_file.audio_lang_verified_at else null end,
      case when v_audio_verified then coalesce(v_file.audio_lang_verification,'{}'::jsonb) else '{}'::jsonb end,
      clock_timestamp()
    ) on conflict (user_id,variant_id,file_external_id) do update set
      title_id=excluded.title_id,
      audio_languages=case when excluded.audio_observed then excluded.audio_languages else observation.audio_languages end,
      subtitle_languages=case when excluded.subtitle_observed then excluded.subtitle_languages else observation.subtitle_languages end,
      audio_observed=observation.audio_observed or excluded.audio_observed,
      subtitle_observed=observation.subtitle_observed or excluded.subtitle_observed,
      updated_at=clock_timestamp();
    update public.cloud_title_file_language_observations observation
      set audio_verified_at=case when v_audio_verified then v_file.audio_lang_verified_at else null end,
          audio_verification=case when v_audio_verified then coalesce(v_file.audio_lang_verification,'{}'::jsonb) else '{}'::jsonb end,
          updated_at=clock_timestamp()
    where observation.user_id=v_file.user_id and observation.variant_id=v_file.variant_id
      and observation.file_external_id=v_file.external_id;
    update public.cloud_title_variants variant
      set audio_lang_verified_at=case when v_audio_verified then v_file.audio_lang_verified_at else null end,
          audio_lang_verify_retry_at=case when v_audio_verified then null else v_file.audio_lang_retry_at end,
          write_head_revision=p_head_revision,write_config_revision=p_config_revision,
          write_source_visibility_epoch=p_source_visibility_epoch,
          write_user_visibility_epoch=p_user_visibility_epoch
    where variant.user_id=v_file.user_id and variant.source_id=p_source_id
      and variant.generation_id=p_generation_id and variant.id=v_file.variant_id;
    if not (v_file.title_id=any(v_title_ids)) then v_title_ids:=array_append(v_title_ids,v_file.title_id); end if;
    v_count:=v_count+1;
  end loop;
  foreach v_title_id in array v_title_ids loop
    perform public.recompute_cloud_title_file_languages(p_user_id,v_title_id);
  end loop;
  return v_count;
end
$function$;

COMMIT;
