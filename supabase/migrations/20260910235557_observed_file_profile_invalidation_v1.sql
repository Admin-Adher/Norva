-- An observed Gateway file version is global to the verified provider/file,
-- not to the owner who happened to probe it. No inference or provider I/O here.
begin;
set local statement_timeout='30s';
set local lock_timeout='3s';

alter table public.catalog_file_tracks
  add column observed_profile_fingerprint text,
  add column observed_profile_probed_at timestamptz,
  add column observed_profile_snapshot jsonb,
  add constraint catalog_file_tracks_observed_profile_complete check (
    (observed_profile_fingerprint is null and observed_profile_probed_at is null
      and observed_profile_snapshot is null)
    or (observed_profile_fingerprint is not null
      and observed_profile_fingerprint ~ '^[a-f0-9]{64}$'
      and observed_profile_probed_at is not null and isfinite(observed_profile_probed_at)
      and observed_profile_snapshot is not null
      and jsonb_typeof(observed_profile_snapshot)='object')
  );

-- A late finalizer uses the existing upsert + record transaction. Raising here
-- rolls back BOTH the stale languages and their certificate, including fanout.
create function public.guard_catalog_observed_profile_certificate()
returns trigger language plpgsql security definer set search_path='' as $function$
begin
  if TG_OP='UPDATE' and OLD.observed_profile_fingerprint is not null then
    if NEW.observed_profile_fingerprint is null
       or NEW.observed_profile_probed_at < OLD.observed_profile_probed_at
       or (NEW.observed_profile_probed_at=OLD.observed_profile_probed_at
           and (NEW.observed_profile_fingerprint is distinct from OLD.observed_profile_fingerprint
             or NEW.observed_profile_snapshot is distinct from OLD.observed_profile_snapshot))
       or (NEW.observed_profile_fingerprint=OLD.observed_profile_fingerprint
           and NEW.observed_profile_snapshot is distinct from OLD.observed_profile_snapshot) then
      raise exception 'Observed file profile moved backwards or is ambiguous' using errcode='PT409';
    end if;
  end if;
  if NEW.audio_lang_verified_at is not null and NEW.observed_profile_fingerprint is not null then
    if NEW.audio_lang_verification->>'profileFingerprint'
          is distinct from NEW.observed_profile_fingerprint
       or nullif(NEW.audio_lang_verification->>'profileProbedAt','')::timestamptz
          is distinct from NEW.observed_profile_probed_at
       or public.vod_language_profile_file_size_bytes(NEW.audio_lang_verification)
          is distinct from public.vod_language_profile_file_size_bytes(NEW.observed_profile_snapshot)
       or public.catalog_audio_track_indexes(NEW.audio_tracks)
          is distinct from public.vod_language_profile_audio_indices(NEW.observed_profile_snapshot) then
      raise exception 'Certificate does not match the observed file profile' using errcode='PT409';
    end if;
  end if;
  return NEW;
end
$function$;
alter function public.guard_catalog_observed_profile_certificate() owner to postgres;
create trigger catalog_observed_profile_certificate_guard
before insert or update on public.catalog_file_tracks
for each row execute function public.guard_catalog_observed_profile_certificate();
revoke all on function public.guard_catalog_observed_profile_certificate() from public,anon,authenticated;

-- No new cache->job lock edge: observation never mutates the jobs table. The
-- existing job->cache order is retained during claiming/finalization.
create function public.guard_catalog_validation_observed_profile()
returns trigger language plpgsql security definer set search_path='' as $function$
declare v_cache public.catalog_file_tracks%rowtype;
begin
  if NEW.state not in ('queued','running','finalizing') then return NEW; end if;
  select cache.* into v_cache from public.catalog_file_tracks cache
  where cache.server_host=NEW.identity_key and cache.item_type=NEW.item_type
    and cache.external_id=NEW.external_id for share;
  if v_cache.observed_profile_fingerprint is not null and (
       NEW.profile_fingerprint is distinct from v_cache.observed_profile_fingerprint
    or NEW.profile_probed_at is distinct from v_cache.observed_profile_probed_at
    or NEW.profile_snapshot is distinct from v_cache.observed_profile_snapshot
    or NEW.file_size_bytes is distinct from public.vod_language_profile_file_size_bytes(v_cache.observed_profile_snapshot)
  ) then
    raise exception 'Validation job uses an obsolete observed file profile' using errcode='PT409';
  end if;
  return NEW;
end
$function$;
alter function public.guard_catalog_validation_observed_profile() owner to postgres;
create trigger catalog_validation_observed_profile_guard
before insert or update of state,lease_owner,profile_fingerprint,profile_snapshot,profile_probed_at,file_size_bytes
on public.catalog_file_audio_validation_jobs
for each row execute function public.guard_catalog_validation_observed_profile();
revoke all on function public.guard_catalog_validation_observed_profile() from public,anon,authenticated;

-- Only server-origin Gateway observations call this RPC. Its SHA is
-- computed by the same Edge serializer as strict LID (not JSONB text hashing).
-- The identity is derived here; neither URLs nor editable provider labels bind it.
create function public.observe_catalog_file_profile(
  p_user_id uuid, p_source_id uuid, p_variant_id uuid,
  p_item_type text, p_external_id text, p_profile_fingerprint text,
  p_profile jsonb, p_audio_tracks jsonb, p_subtitle_tracks jsonb,
  p_audio_probe_complete boolean default true, p_subtitle_probe_complete boolean default true
) returns jsonb language plpgsql security definer set search_path='' as $function$
declare
  v_identity text;
  v_generation uuid;
  v_parent_series_id text;
  v_stored_profile jsonb;
  v_snapshot jsonb;
  v_at timestamptz;
  v_cache public.catalog_file_tracks%rowtype;
  v_keep_certificate boolean;
  v_provenance jsonb;
  v_fanout integer;
  v_changed boolean;
  v_audio_observed boolean;
  v_subtitle_observed boolean;
  v_raw_audio jsonb;
  v_raw_subtitles jsonb;
  v_owner record;
  v_reset_owners integer:=0;
begin
  if p_user_id is null or p_source_id is null or p_variant_id is null
     or p_item_type not in ('movie','episode') or p_item_type is null
     or coalesce(btrim(p_external_id),'')='' or length(p_external_id)>512
     or coalesce(p_profile_fingerprint,'') !~ '^[a-f0-9]{64}$'
     or jsonb_typeof(p_profile) is distinct from 'object'
     or p_audio_probe_complete is null or p_subtitle_probe_complete is null
     or jsonb_typeof(p_audio_tracks) is distinct from 'array'
     or jsonb_typeof(p_subtitle_tracks) is distinct from 'array' then
    raise exception 'Exact Gateway observation with explicit facet completion required' using errcode='22023';
  end if;
  v_raw_audio:=coalesce(p_profile->'audioTracks',p_profile->'audio_tracks');
  v_raw_subtitles:=coalesce(p_profile->'subtitles',p_profile->'subtitleTracks',p_profile->'subtitle_tracks');
  if jsonb_typeof(v_raw_audio) is distinct from 'array'
     or jsonb_typeof(v_raw_subtitles) is distinct from 'array'
     or jsonb_array_length(v_raw_audio)>32 or jsonb_array_length(v_raw_subtitles)>32
     or jsonb_array_length(v_raw_audio)<>cardinality(public.catalog_audio_track_indexes(v_raw_audio))
     or jsonb_array_length(v_raw_subtitles)<>cardinality(public.catalog_audio_track_indexes(v_raw_subtitles)) then
    raise exception 'Invalid observed profile stream inventory' using errcode='22023';
  end if;
  v_snapshot:=public.vod_language_profile_snapshot(p_profile);
  v_at:=nullif(v_snapshot->>'probedAt','')::timestamptz;
  if v_at is null or not isfinite(v_at) or v_at>clock_timestamp()+interval '5 minutes'
     or (v_snapshot->>'probeSource' is distinct from 'gatewayprobe'
       and not (v_snapshot->>'probeSource'='gatewayinband' and v_snapshot->>'metadataComplete'='true'))
     or coalesce(v_snapshot->>'container','') not in
       ('mkv','matroska','matroskawebm','webm','mp4','mov','movmp4m4a3gp3g2mj2','avi','ogg','flv','mpg','mpeg','ts','mpegts')
     or public.vod_language_profile_file_size_bytes(v_snapshot) is null
     or v_snapshot->>'durationSeconds' is null
     or (v_snapshot->>'durationSeconds')::numeric not between 1 and 86400
     or jsonb_array_length(p_audio_tracks)>32
     or jsonb_array_length(p_subtitle_tracks)>32
     or (not p_audio_probe_complete and p_audio_tracks<>'[]'::jsonb)
     or (not p_subtitle_probe_complete and p_subtitle_tracks<>'[]'::jsonb) then
    raise exception 'Observed profile and track inventory differ' using errcode='22023';
  end if;
  if p_audio_probe_complete and (
       jsonb_array_length(p_audio_tracks)=0
    or jsonb_array_length(p_audio_tracks)<>cardinality(public.catalog_audio_track_indexes(p_audio_tracks))
    or public.vod_language_profile_snapshot(jsonb_set(p_profile,'{audioTracks}',p_audio_tracks))
       is distinct from v_snapshot) then
    raise exception 'Complete audio observation requires the exact nonempty map' using errcode='22023';
  end if;
  if p_subtitle_probe_complete and (
       jsonb_array_length(p_subtitle_tracks)<>cardinality(public.catalog_audio_track_indexes(p_subtitle_tracks))
    or public.catalog_audio_track_indexes(p_subtitle_tracks)
       is distinct from public.catalog_audio_track_indexes(v_raw_subtitles)) then
    raise exception 'Complete subtitle observation requires the exact map' using errcode='22023';
  end if;
  select identity.identity_id::text into v_identity
  from public.catalog_source_provider_identities identity
  join public.cloud_catalog_visible_title_variants variant
    on variant.source_id=identity.source_id and variant.user_id=identity.user_id
  where identity.source_id=p_source_id and identity.user_id=p_user_id
    and identity.verified_at is not null and variant.id=p_variant_id;
  if not found then raise exception 'Observed file ownership changed' using errcode='PT409'; end if;
  -- Episode mutations already share this lock with the existing episode fanout.
  if p_item_type='episode' then
    perform pg_advisory_xact_lock(hashtextextended('catalog-series-episode-provider:'||v_identity,0));
  end if;
  insert into public.catalog_file_tracks(server_host,item_type,external_id)
  values(v_identity,p_item_type,p_external_id) on conflict do nothing;
  select cache.* into v_cache from public.catalog_file_tracks cache
  where cache.server_host=v_identity and cache.item_type=p_item_type
    and cache.external_id=p_external_id for update;

  -- Same lock order as the existing finalizer: cache, source, active head,
  -- verified identity, variant. Owner fanout keeps its four revision fences.
  perform 1 from public.cloud_sources source where source.id=p_source_id
    and source.user_id=p_user_id and source.deleted_at is null and source.enabled for share;
  if not found then raise exception 'Observed source is no longer visible' using errcode='PT409'; end if;
  select head.active_generation_id into v_generation from public.cloud_source_catalog_heads head
  where head.source_id=p_source_id and head.user_id=p_user_id for share;
  perform 1 from public.catalog_source_provider_identities identity
  where identity.source_id=p_source_id and identity.user_id=p_user_id
    and identity.identity_id::text=v_identity and identity.verified_at is not null for share;
  if not found then raise exception 'Observed provider identity changed' using errcode='PT409'; end if;
  select variant.codec_profile,variant.external_id into v_stored_profile,v_parent_series_id
  from public.cloud_catalog_visible_title_variants variant
  where variant.id=p_variant_id and variant.source_id=p_source_id and variant.user_id=p_user_id
    and variant.generation_id=v_generation
    and variant.item_type=case when p_item_type='movie' then 'movie' else 'series' end;
  if not found then raise exception 'Observed exact variant changed' using errcode='PT409'; end if;
  if p_item_type='movie' then
    if v_parent_series_id is distinct from p_external_id
       or public.vod_language_profile_snapshot(v_stored_profile) is distinct from v_snapshot then
      raise exception 'Observed movie profile no longer matches its owner' using errcode='PT409';
    end if;
  else
    perform 1 from public.catalog_series_episode_memberships membership
    where membership.user_id=p_user_id and membership.source_id=p_source_id
      and membership.generation_id=v_generation and membership.parent_variant_id=p_variant_id
      and membership.parent_series_id=v_parent_series_id and membership.parent_item_type='series'
      and membership.provider_identity_id::text=v_identity and membership.episode_id=p_external_id for share;
    if not found then raise exception 'Observed exact episode membership changed' using errcode='PT409'; end if;
  end if;
  if v_cache.observed_profile_probed_at is not null and v_at<v_cache.observed_profile_probed_at then
    return jsonb_build_object('accepted',false,'reason','stale_observation');
  end if;
  if v_cache.observed_profile_probed_at=v_at and (
       v_cache.observed_profile_fingerprint is distinct from p_profile_fingerprint
    or v_cache.observed_profile_snapshot is distinct from v_snapshot) then
    raise exception 'Ambiguous observed file version' using errcode='PT409';
  end if;
  -- First binding may retain an already valid exact certificate. A mismatched
  -- legacy certificate is not trusted just because the track index is unchanged.
  v_keep_certificate:=v_cache.audio_lang_verified_at is not null
    and v_cache.audio_lang_verification->>'profileFingerprint'=p_profile_fingerprint
    and nullif(v_cache.audio_lang_verification->>'profileProbedAt','')::timestamptz=v_at
    and public.vod_language_profile_file_size_bytes(v_cache.audio_lang_verification)
        =public.vod_language_profile_file_size_bytes(v_snapshot)
    and public.catalog_audio_track_indexes(v_cache.audio_tracks)
        =public.vod_language_profile_audio_indices(v_snapshot);
  v_changed:=v_cache.observed_profile_fingerprint is distinct from p_profile_fingerprint;
  -- A failed facet on the SAME version cannot erase existing valid evidence.
  -- A changed version, however, must not inherit any old unobserved facet.
  v_audio_observed:=p_audio_probe_complete or coalesce(v_keep_certificate,false)
    or (not v_changed and v_cache.audio_probed_at is not null);
  v_subtitle_observed:=p_subtitle_probe_complete
    or (not v_changed and v_cache.subtitle_probed_at is not null);
  v_provenance:=case when coalesce(v_keep_certificate,false) then v_cache.audio_lang_verification
    else jsonb_build_object('status','observed','reason','observed-file-profile',
      'profileFingerprint',p_profile_fingerprint,'profileProbedAt',v_at,
      'fileSizeBytes',public.vod_language_profile_file_size_bytes(v_snapshot)) end;
  update public.catalog_file_tracks cache set
    observed_profile_fingerprint=p_profile_fingerprint,observed_profile_probed_at=v_at,
    observed_profile_snapshot=v_snapshot,
    audio_tracks=case when coalesce(v_keep_certificate,false) then cache.audio_tracks
      when p_audio_probe_complete then p_audio_tracks
      when not v_changed then cache.audio_tracks else '[]'::jsonb end,
    subtitle_tracks=case when p_subtitle_probe_complete then p_subtitle_tracks
      when not v_changed then cache.subtitle_tracks else '[]'::jsonb end,
    audio_probed_at=case when v_audio_observed then v_at else null end,
    subtitle_probed_at=case when v_subtitle_observed then v_at else null end,
    audio_lang_verified_at=case when coalesce(v_keep_certificate,false) then cache.audio_lang_verified_at else null end,
    audio_lang_verification=v_provenance,
    audio_lang_retry_at=case when v_changed then null else cache.audio_lang_retry_at end,
    updated_at=clock_timestamp()
  where cache.server_host=v_identity and cache.item_type=p_item_type and cache.external_id=p_external_id;

  if v_changed then
    -- Reset the exact-file ledger BEFORE the established merges. The episode
    -- merge deliberately retains certified rows; without this reset it would
    -- retain a certificate belonging to the previous file version forever.
    for v_owner in
      select variant.user_id,variant.title_id,variant.id as variant_id,variant.source_id,
        head.head_revision,lifecycle.config_revision,
        lifecycle.visibility_epoch as source_visibility_epoch,epoch.visibility_epoch as user_visibility_epoch
      from public.cloud_catalog_visible_title_variants variant
      join public.catalog_source_provider_identities identity
        on identity.source_id=variant.source_id and identity.user_id=variant.user_id
       and identity.identity_id::text=v_identity and identity.verified_at is not null
      join public.cloud_source_catalog_heads head
        on head.source_id=variant.source_id and head.user_id=variant.user_id
       and head.active_generation_id=variant.generation_id
      join public.cloud_source_lifecycle lifecycle
        on lifecycle.source_id=variant.source_id and lifecycle.user_id=variant.user_id
      join public.cloud_user_catalog_visibility_epochs epoch on epoch.user_id=variant.user_id
      where variant.title_id is not null and (
        (p_item_type='movie' and variant.item_type='movie' and variant.external_id=p_external_id)
        or (p_item_type='episode' and variant.item_type='series' and exists (
          select 1 from public.catalog_series_episode_memberships membership
          where membership.user_id=variant.user_id and membership.source_id=variant.source_id
            and membership.generation_id=variant.generation_id and membership.parent_variant_id=variant.id
            and membership.parent_title_id=variant.title_id and membership.parent_series_id=variant.external_id
            and membership.parent_item_type='series' and membership.provider_identity_id::text=v_identity
            and membership.episode_id=p_external_id)))
      order by variant.user_id,variant.title_id,variant.id
      for share of head,lifecycle,epoch,identity
    loop
      perform 1 from public.cloud_titles title where title.user_id=v_owner.user_id
        and title.id=v_owner.title_id for update;
      update public.cloud_title_file_language_observations observation
        set audio_languages='{}'::text[],subtitle_languages='{}'::text[],
          audio_observed=false,subtitle_observed=false,audio_verified_at=null,
          audio_verification=v_provenance,updated_at=clock_timestamp()
      where observation.user_id=v_owner.user_id and observation.variant_id=v_owner.variant_id
        and observation.title_id=v_owner.title_id and observation.file_external_id=p_external_id;
      if p_item_type='movie' then
        update public.cloud_title_variants variant set audio_lang_verified_at=null,audio_lang_verify_retry_at=null,
          write_head_revision=v_owner.head_revision,write_config_revision=v_owner.config_revision,
          write_source_visibility_epoch=v_owner.source_visibility_epoch,
          write_user_visibility_epoch=v_owner.user_visibility_epoch
        where variant.user_id=v_owner.user_id and variant.id=v_owner.variant_id;
        -- These legacy presentation maps are written only for a single-file
        -- title. Clear them too; clearing just derived facets leaves a stale UI.
        update public.cloud_titles title set audio_tracks='[]'::jsonb,audio_languages='{}'::text[],
          audio_probed_at=null,subtitle_tracks='[]'::jsonb,subtitle_probed_at=null
        where title.user_id=v_owner.user_id and title.id=v_owner.title_id and title.item_type='movie'
          and not exists(select 1 from public.cloud_catalog_visible_title_variants sibling
            where sibling.user_id=v_owner.user_id and sibling.title_id=v_owner.title_id
              and sibling.id<>v_owner.variant_id);
      end if;
      perform public.recompute_cloud_title_file_languages(v_owner.user_id,v_owner.title_id);
      v_reset_owners:=v_reset_owners+1;
    end loop;
  end if;
  -- These established RPCs propagate canonical data, not the raw arguments.
  if p_item_type='movie' then
    v_fanout:=public.norva_fanout_file_tracks_to_users_fenced(
      v_identity,p_item_type,p_external_id,p_audio_tracks,p_subtitle_tracks,v_audio_observed,v_subtitle_observed);
  else
    v_fanout:=public.fanout_episode_file_tracks_to_users(
      v_identity,p_item_type,p_external_id,p_audio_tracks,p_subtitle_tracks,v_audio_observed,v_subtitle_observed);
  end if;
  -- A metadata observation is NOT an inconclusive speech attempt. Do not call
  -- record_catalog_file_audio_verification(false), which installs a 1-day retry.
  if greatest(coalesce(v_fanout,0),v_reset_owners)=0 then
    raise exception 'Observed profile fanout incomplete' using errcode='PT409';
  end if;
  return jsonb_build_object('accepted',true,'certificateRetained',coalesce(v_keep_certificate,false),
    'profileChanged',v_changed,'audioObserved',v_audio_observed,'subtitleObserved',v_subtitle_observed,
    'owners',greatest(coalesce(v_fanout,0),v_reset_owners));
end
$function$;
alter function public.observe_catalog_file_profile(uuid,uuid,uuid,text,text,text,jsonb,jsonb,jsonb,boolean,boolean) owner to postgres;
revoke all on function public.observe_catalog_file_profile(uuid,uuid,uuid,text,text,text,jsonb,jsonb,jsonb,boolean,boolean)
from public,anon,authenticated;
grant execute on function public.observe_catalog_file_profile(uuid,uuid,uuid,text,text,text,jsonb,jsonb,jsonb,boolean,boolean) to service_role;

-- Unversioned legacy observations cannot overwrite a bound file. Add the
-- condition to ON CONFLICT itself, so a concurrent first binding is also safe.
-- Raw discovery remains available for files not yet observed by the new path.
do $migration$
declare v_name text; v_definition text; v_old text:='    updated_at = clock_timestamp();';
begin
  foreach v_name in array array['upsert_catalog_file_tracks','upsert_catalog_file_detected_tracks'] loop
    v_definition:=replace(pg_get_functiondef((
      'public.'||v_name||'(text,text,text,jsonb,jsonb,boolean,boolean)')::regprocedure),chr(13),'');
    if length(v_definition)-length(replace(v_definition,v_old,''))<>length(v_old)
       or position('on conflict (server_host, item_type, external_id) do update set' in v_definition)=0 then
      raise exception 'Unversioned cache writer drifted; refusing migration' using errcode='55000';
    end if;
    execute replace(v_definition,v_old,
      '    updated_at = clock_timestamp()'||chr(10)||'  where cache.observed_profile_fingerprint is null;');
  end loop;
end
$migration$;
notify pgrst,'reload schema';
commit;
