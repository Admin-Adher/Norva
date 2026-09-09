begin;
set local lock_timeout = '3s';
set local statement_timeout = '45s';

-- Selection files have no provider-account identity. Share work only through
-- the server manifest's exact external id AND URL digest, then publish results
-- separately through each current owner's generation/visibility fence.
create table public.catalog_selection_audio_jobs (
  id uuid not null unique default gen_random_uuid(),
  external_id text not null check (external_id ~ '^norva-selection:movie:[a-f0-9]{64}$'),
  url_sha256 text not null check (url_sha256 ~ '^[a-f0-9]{64}$'),
  state text not null default 'queued' check (state in ('queued','running','retry_wait','completed','failed')),
  priority integer not null default 0 check (priority between 0 and 1000),
  attempt_count integer not null default 0 check (attempt_count between 0 and 8),
  next_attempt_at timestamptz not null default now(),
  lease_token uuid,
  lease_until timestamptz,
  profile jsonb not null default '{}'::jsonb check (jsonb_typeof(profile)='object' and octet_length(profile::text)<=65536),
  progress jsonb not null default '{}'::jsonb check (jsonb_typeof(progress)='object' and octet_length(progress::text)<=262144),
  result jsonb not null default '{}'::jsonb check (jsonb_typeof(result)='object' and octet_length(result::text)<=262144),
  error_code text check (error_code ~ '^[A-Z][A-Z0-9_]{0,95}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  hydration_pending boolean not null default false,
  primary key (external_id,url_sha256),
  check ((state='running') = (lease_token is not null and lease_until is not null)),
  check ((state in ('completed','failed')) = (completed_at is not null))
);
create index catalog_selection_audio_jobs_due_idx
  on public.catalog_selection_audio_jobs(priority desc,next_attempt_at,created_at)
  where state in ('queued','retry_wait','running');
alter table public.catalog_selection_audio_jobs enable row level security;
alter table public.catalog_selection_audio_jobs force row level security;
revoke all on public.catalog_selection_audio_jobs from public,anon,authenticated,service_role;
grant select on public.catalog_selection_audio_jobs to service_role;

create or replace function public.selection_audio_tracks_complete(p_tracks jsonb)
returns boolean language sql immutable set search_path='' as $function$
  select jsonb_typeof(p_tracks)='array'
    and jsonb_array_length(case when jsonb_typeof(p_tracks)='array' then p_tracks else '[]'::jsonb end)>0
    and cardinality(public.catalog_audio_track_indexes(p_tracks))=
      jsonb_array_length(case when jsonb_typeof(p_tracks)='array' then p_tracks else '[]'::jsonb end)
    and not exists (
      select 1 from jsonb_array_elements(case when jsonb_typeof(p_tracks)='array' then p_tracks else '[]'::jsonb end) track
      where public.norva_canonical_language_code(coalesce(track->>'lang',track->>'language')) is null
    )
$function$;

create or replace function public.selection_audio_job_owners(p_external_id text,p_url_sha256 text)
returns jsonb language plpgsql stable security definer set search_path='' as $function$
begin
  perform public.norva_credential_require_service_role();
  return coalesce((
    select jsonb_agg(jsonb_build_object('user_id',owner.user_id,'source_id',owner.source_id)
      order by owner.user_id,owner.source_id)
    from (
      select distinct variant.user_id,variant.source_id
      from public.cloud_catalog_visible_title_variants variant
      join public.cloud_media_items media on media.id=variant.media_item_id
        and media.user_id=variant.user_id and media.source_id=variant.source_id
        and media.generation_id=variant.generation_id and media.item_type='movie' and media.available
      where variant.item_type='movie' and variant.external_id=p_external_id
        and variant.external_id ~ '^norva-selection:movie:[a-f0-9]{64}$'
        and public.norva_selection_source_identity_valid(variant.source_id,variant.user_id)
        and encode(sha256(convert_to(variant.playback_hint->>'targetUrl','UTF8')),'hex')=p_url_sha256
        and media.playback_hint->>'targetUrl'=variant.playback_hint->>'targetUrl'
    ) owner
  ),'[]'::jsonb);
end
$function$;

create or replace function public.seed_selection_audio_jobs(p_manifest jsonb)
returns integer language plpgsql volatile security definer set search_path='' as $function$
declare v_count integer;
begin
  perform public.norva_credential_require_service_role();
  if jsonb_typeof(p_manifest) is distinct from 'array' or jsonb_array_length(p_manifest)>250 then
    raise exception 'A bounded Selection manifest is required' using errcode='22023';
  end if;
  if exists(select 1 from jsonb_array_elements(p_manifest) entry
    where coalesce(entry->>'externalId','') !~ '^norva-selection:movie:[a-f0-9]{64}$'
      or coalesce(entry->>'urlSha256','') !~ '^[a-f0-9]{64}$'
      or coalesce(entry->>'priority','0') !~ '^([0-9]{1,3}|1000)$') then
    raise exception 'Invalid Selection manifest identity' using errcode='22023';
  end if;
  with manifest as materialized (
    select entry->>'externalId' external_id,entry->>'urlSha256' url_sha256,
      max(coalesce((entry->>'priority')::integer,0)) priority
    from jsonb_array_elements(p_manifest) entry group by 1,2
  ), candidates as (
    select distinct manifest.* from manifest
    join public.cloud_catalog_visible_title_variants variant on variant.item_type='movie'
      and variant.external_id=manifest.external_id
    join public.cloud_media_items media on media.id=variant.media_item_id
      and media.user_id=variant.user_id and media.source_id=variant.source_id
      and media.generation_id=variant.generation_id and media.item_type='movie' and media.available
    left join public.catalog_file_tracks cache on cache.server_host='source:'||variant.source_id::text
      and cache.item_type='movie' and cache.external_id=variant.external_id
    where public.norva_selection_source_identity_valid(variant.source_id,variant.user_id)
      and encode(sha256(convert_to(variant.playback_hint->>'targetUrl','UTF8')),'hex')=manifest.url_sha256
      and media.playback_hint->>'targetUrl'=variant.playback_hint->>'targetUrl'
      and not coalesce(public.selection_audio_tracks_complete(case when cache.audio_probed_at is not null
        and cache.audio_lang_verification->>'urlSha256'=manifest.url_sha256 then cache.audio_tracks
        when media.metadata->'selectionPlaybackValidation'->>'urlSha256'=manifest.url_sha256
          then media.metadata->'codecProfile'->'audioTracks' else null end),false)
  )
  insert into public.catalog_selection_audio_jobs as job(external_id,url_sha256,priority)
    select external_id,url_sha256,priority from candidates
  on conflict (external_id,url_sha256) do update set priority=greatest(job.priority,excluded.priority)
    where job.state in ('queued','retry_wait') and excluded.priority>job.priority;
  get diagnostics v_count=row_count;
  return v_count;
end
$function$;

create or replace function public.claim_selection_audio_job()
returns jsonb language plpgsql volatile security definer set search_path='' as $function$
declare v_job public.catalog_selection_audio_jobs%rowtype; v_now timestamptz:=clock_timestamp();
begin
  perform public.norva_credential_require_service_role();
  -- The transaction lock protects admission across distinct file rows. SKIP
  -- LOCKED alone would allow simultaneous jobs for two different files.
  if not pg_try_advisory_xact_lock(hashtextextended('selection-audio-global-worker-v1',0)) then return null; end if;
  if exists(select 1 from public.catalog_selection_audio_jobs where state='running' and lease_until>v_now) then return null; end if;
  update public.catalog_selection_audio_jobs set state='failed',error_code='ATTEMPT_LIMIT',
    lease_token=null,lease_until=null,updated_at=v_now,completed_at=v_now
    where state='running' and lease_until<=v_now and attempt_count>=8;
  select job.* into v_job from public.catalog_selection_audio_jobs job
    where ((job.state in ('queued','retry_wait') and job.next_attempt_at<=v_now)
      or (job.state='running' and job.lease_until<=v_now)) and job.attempt_count<8
      and jsonb_array_length(public.selection_audio_job_owners(job.external_id,job.url_sha256))>0
    order by job.priority desc,job.next_attempt_at,job.created_at,job.external_id
    limit 1 for update skip locked;
  if not found then return null; end if;
  update public.catalog_selection_audio_jobs set state='running',attempt_count=attempt_count+1,
    lease_token=gen_random_uuid(),lease_until=v_now+interval '5 minutes',error_code=null,updated_at=v_now
    where external_id=v_job.external_id and url_sha256=v_job.url_sha256 returning * into v_job;
  return to_jsonb(v_job);
end
$function$;

create or replace function public.checkpoint_selection_audio_job(
  p_external_id text,p_url_sha256 text,p_lease_token uuid,p_profile jsonb,p_progress jsonb
) returns boolean language plpgsql volatile security definer set search_path='' as $function$
declare v_count integer;
begin
  perform public.norva_credential_require_service_role();
  if jsonb_typeof(p_profile) is distinct from 'object' or jsonb_typeof(p_progress) is distinct from 'object'
    or octet_length(p_profile::text)>65536 or octet_length(p_progress::text)>262144 then
    raise exception 'Invalid Selection audio checkpoint' using errcode='22023';
  end if;
  update public.catalog_selection_audio_jobs set profile=p_profile,progress=p_progress,
    lease_until=clock_timestamp()+interval '5 minutes',updated_at=clock_timestamp()
    where external_id=p_external_id and url_sha256=p_url_sha256 and state='running'
      and lease_token=p_lease_token and lease_until>clock_timestamp();
  get diagnostics v_count=row_count;
  return v_count=1;
end
$function$;

create or replace function public.finish_selection_audio_job(
  p_external_id text,p_url_sha256 text,p_lease_token uuid,p_result jsonb,
  p_error_code text default null,p_retryable boolean default false
) returns boolean language plpgsql volatile security definer set search_path='' as $function$
declare
  v_job public.catalog_selection_audio_jobs%rowtype; v_audio jsonb; v_verification jsonb;
  v_verified boolean; v_evidence jsonb; v_track jsonb; v_now timestamptz:=clock_timestamp();
begin
  perform public.norva_credential_require_service_role();
  select * into v_job from public.catalog_selection_audio_jobs where external_id=p_external_id
    and url_sha256=p_url_sha256 and state='running' and lease_token=p_lease_token and lease_until>v_now for update;
  if not found then return false; end if;
  if p_error_code is not null then
    if p_error_code !~ '^[A-Z][A-Z0-9_]{0,95}$' then raise exception 'Invalid Selection error code' using errcode='22023'; end if;
    update public.catalog_selection_audio_jobs set
      state=case when p_retryable and attempt_count<8 then 'retry_wait' else 'failed' end,
      next_attempt_at=v_now+make_interval(secs=>least(21600,300*(2^(attempt_count-1))::integer)),
      completed_at=case when p_retryable and attempt_count<8 then null else v_now end,
      error_code=p_error_code,lease_token=null,lease_until=null,updated_at=v_now
      where external_id=p_external_id and url_sha256=p_url_sha256;
    return true;
  end if;
  v_audio:=p_result->'audioTracks'; v_verification:=p_result->'verification';
  if jsonb_typeof(p_result) is distinct from 'object' or octet_length(p_result::text)>262144
    or jsonb_typeof(v_audio) is distinct from 'array' or jsonb_array_length(v_audio) not between 1 and 64
    or cardinality(public.catalog_audio_track_indexes(v_audio))<>jsonb_array_length(v_audio)
    or jsonb_typeof(p_result->'subtitleTracks') is distinct from 'array'
    or jsonb_array_length(p_result->'subtitleTracks')>128
    or jsonb_typeof(v_verification) is distinct from 'object'
    or v_verification->>'urlSha256' is distinct from p_url_sha256 then
    raise exception 'Invalid exact-file Selection audio result' using errcode='22023';
  end if;
  v_verified:=coalesce((p_result->>'verified')::boolean,false);
  if v_verified then
    if not public.selection_audio_tracks_complete(v_audio)
      or v_verification->>'method' is distinct from 'selection-strict-lid-v1'
      or v_verification->>'status' is distinct from 'verified'
      or coalesce(v_verification->>'profileFingerprint','')=''
      or v_verification->>'profileFingerprint' is distinct from v_job.profile->>'fingerprint'
      or v_job.profile->>'urlSha256' is distinct from p_url_sha256
      or public.catalog_audio_track_indexes(v_job.profile->'audioTracks') is distinct from public.catalog_audio_track_indexes(v_audio)
      or (p_result->'profile' is not null and p_result->'profile' is distinct from v_job.profile)
      or jsonb_typeof(v_verification->'tracks') is distinct from 'array'
      or jsonb_array_length(v_verification->'tracks')<>jsonb_array_length(v_audio) then
      raise exception 'Incomplete strict Selection evidence' using errcode='22023';
    end if;
    for v_track in select value from jsonb_array_elements(v_audio) loop
      select proof->'evidence' into v_evidence from jsonb_array_elements(v_verification->'tracks') proof
        where proof->>'index'=v_track->>'index';
      if v_evidence is null or v_evidence->>'method' is distinct from 'whisper-strict-consensus-v4'
        or coalesce(v_evidence->>'index',v_evidence->>'streamIndex') is distinct from v_track->>'index'
        or public.norva_canonical_language_code(v_evidence->>'language') is distinct from
          public.norva_canonical_language_code(coalesce(v_track->>'lang',v_track->>'language'))
        or coalesce((v_evidence->>'consensus')::integer,0)<4
        or coalesce((v_evidence->>'sampleCount')::integer,(v_evidence->>'independentWindows')::integer,0)<4
        or jsonb_typeof(v_evidence->'samples') is distinct from 'array'
        or jsonb_array_length(v_evidence->'samples')<>coalesce((v_evidence->>'sampleCount')::integer,(v_evidence->>'independentWindows')::integer,0)
        or coalesce((v_evidence->>'rejectedSpeechSampleCount')::integer,0)<>0
        or coalesce((v_evidence->>'minSampleProbability')::numeric,0)<0.95
        or coalesce((v_evidence->>'minSampleWordCount')::integer,0)<12
        or coalesce((v_evidence->>'minSampleUniqueWordCount')::integer,0)<8
        or v_evidence->>'profileFingerprint' is distinct from v_verification->>'profileFingerprint'
        or (v_evidence->>'consensus')::integer<>jsonb_array_length(v_evidence->'samples')
        or jsonb_array_length(v_evidence->'samples') not between 4 and 6
        or (select count(distinct sample->>'offset') from jsonb_array_elements(v_evidence->'samples') sample)
          <>jsonb_array_length(v_evidence->'samples')
        or exists(select 1 from jsonb_array_elements(v_evidence->'samples') sample
          where public.norva_canonical_language_code(sample->>'language') is distinct from
              public.norva_canonical_language_code(v_evidence->>'language')
            or coalesce((sample->>'offset')::numeric,-1)<0
            or coalesce((sample->>'probability')::numeric,0) not between 0.95 and 1
            or coalesce((sample->>'wordCount')::integer,0)<12
            or coalesce((sample->>'uniqueWordCount')::integer,0)<8) then
        raise exception 'Invalid strict Selection evidence' using errcode='22023';
      end if;
    end loop;
  elsif v_verification->>'status' is distinct from 'probed' then
    raise exception 'Unverified Selection evidence must remain probed' using errcode='22023';
  end if;
  update public.catalog_selection_audio_jobs set state='completed',
    result=jsonb_build_object('audioTracks',v_audio,'subtitleTracks',p_result->'subtitleTracks',
      'verified',v_verified,'verification',v_verification),
    profile=coalesce(p_result->'profile',profile),error_code=null,lease_token=null,lease_until=null,
    completed_at=v_now,updated_at=v_now,hydration_pending=true where external_id=p_external_id and url_sha256=p_url_sha256;
  return true;
end
$function$;

create or replace function public.pending_selection_audio_hydrations(p_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path='' as $function$
begin
  perform public.norva_credential_require_service_role();
  return coalesce((select jsonb_agg(to_jsonb(pending)) from (
    select id,external_id,url_sha256 from public.catalog_selection_audio_jobs
    where state='completed' and hydration_pending
    order by completed_at,id limit greatest(1,least(coalesce(p_limit,20),100))
  ) pending),'[]'::jsonb);
end
$function$;

create or replace function public.ack_selection_audio_hydration(p_external_id text,p_url_sha256 text)
returns boolean language plpgsql volatile security definer set search_path='' as $function$
declare v_count integer;
begin
  perform public.norva_credential_require_service_role();
  update public.catalog_selection_audio_jobs set hydration_pending=false,updated_at=clock_timestamp()
    where external_id=p_external_id and url_sha256=p_url_sha256 and state='completed' and hydration_pending;
  get diagnostics v_count=row_count;
  return v_count=1;
end
$function$;

create or replace function public.hydrate_selection_audio_results(
  p_user_id uuid,p_source_id uuid,p_generation_id uuid,p_head_revision bigint,p_config_revision bigint,
  p_source_visibility_epoch bigint,p_user_visibility_epoch bigint,p_external_ids text[]
) returns integer language plpgsql volatile security definer set search_path='' as $function$
declare
  v_snapshot jsonb; v_file record; v_stale record; v_ids text[]:='{}'::text[]; v_key text; v_changed integer;
begin
  perform public.norva_credential_require_service_role();
  if not public.norva_selection_source_identity_valid(p_source_id,p_user_id) then
    raise exception 'Canonical Selection ownership is required' using errcode='42501';
  end if;
  if p_external_ids is null or cardinality(p_external_ids)>250 then
    raise exception 'A bounded Selection file batch is required' using errcode='22023';
  end if;
  perform 1 from public.cloud_sources source where source.id=p_source_id and source.user_id=p_user_id for share;
  perform 1 from public.cloud_source_catalog_heads head
    join public.cloud_source_lifecycle lifecycle on lifecycle.user_id=head.user_id and lifecycle.source_id=head.source_id
    where head.source_id=p_source_id and head.user_id=p_user_id for share of head,lifecycle;
  perform 1 from public.cloud_user_catalog_visibility_epochs epoch where epoch.user_id=p_user_id for share;
  v_snapshot:=public.norva_get_catalog_write_snapshot(p_source_id,p_user_id);
  if (v_snapshot->>'generationId')::uuid is distinct from p_generation_id
    or (v_snapshot->>'headRevision')::bigint is distinct from p_head_revision
    or (v_snapshot->>'configRevision')::bigint is distinct from p_config_revision
    or (v_snapshot->>'sourceVisibilityEpoch')::bigint is distinct from p_source_visibility_epoch
    or (v_snapshot->>'userVisibilityEpoch')::bigint is distinct from p_user_visibility_epoch
    or (v_snapshot->>'isCatalogVisible')::boolean is distinct from true then
    raise exception 'Selection catalogue snapshot changed' using errcode='PT409';
  end if;
  v_key:=public.catalog_source_file_cache_key(p_source_id,p_user_id);
  if v_key is distinct from 'source:'||p_source_id::text then
    raise exception 'Selection file cache identity changed' using errcode='PT409';
  end if;
  -- An import can retain an external id while changing its physical URL.
  -- Invalidate positively identified old-file evidence immediately, even when
  -- the new file's analysis has not completed. Never display certificate A on B.
  for v_stale in
    select variant.id variant_id,variant.title_id,variant.external_id,
      encode(sha256(convert_to(variant.playback_hint->>'targetUrl','UTF8')),'hex') current_digest
    from public.cloud_catalog_visible_title_variants variant
    join public.cloud_media_items media on media.id=variant.media_item_id and media.user_id=variant.user_id
      and media.source_id=variant.source_id and media.generation_id=variant.generation_id and media.item_type='movie' and media.available
    join public.catalog_file_tracks cache on cache.server_host=v_key and cache.item_type='movie' and cache.external_id=variant.external_id
    where variant.user_id=p_user_id and variant.source_id=p_source_id and variant.generation_id=p_generation_id
      and variant.item_type='movie' and variant.external_id=any(p_external_ids)
      and media.playback_hint->>'targetUrl'=variant.playback_hint->>'targetUrl'
      and nullif(variant.playback_hint->>'targetUrl','') is not null
      and nullif(cache.audio_lang_verification->>'urlSha256','') is not null
      and cache.audio_lang_verification->>'urlSha256' is distinct from
        encode(sha256(convert_to(variant.playback_hint->>'targetUrl','UTF8')),'hex')
    for update of cache
  loop
    update public.catalog_file_tracks set audio_tracks='[]'::jsonb,subtitle_tracks='[]'::jsonb,
      audio_probed_at=null,subtitle_probed_at=null,audio_lang_verified_at=null,audio_lang_retry_at=null,
      audio_lang_verification=jsonb_build_object('status','unidentified','urlSha256',v_stale.current_digest),updated_at=clock_timestamp()
      where server_host=v_key and item_type='movie' and external_id=v_stale.external_id;
    delete from public.cloud_title_file_language_observations observation where observation.user_id=p_user_id
      and observation.variant_id=v_stale.variant_id and observation.file_external_id=v_stale.external_id;
    perform public.norva_set_catalog_delete_proof(p_source_id,p_user_id,p_generation_id,p_head_revision,
      p_config_revision,p_source_visibility_epoch,p_user_visibility_epoch);
    update public.cloud_title_variants variant set audio_lang_verified_at=null,audio_lang_verify_retry_at=null,
      write_head_revision=p_head_revision,write_config_revision=p_config_revision,
      write_source_visibility_epoch=p_source_visibility_epoch,write_user_visibility_epoch=p_user_visibility_epoch
      where variant.id=v_stale.variant_id and variant.user_id=p_user_id and variant.source_id=p_source_id
        and variant.generation_id=p_generation_id;
    perform public.recompute_cloud_title_file_languages(p_user_id,v_stale.title_id);
  end loop;
  for v_file in
    select distinct job.external_id,job.result,job.completed_at
    from public.catalog_selection_audio_jobs job
    join public.cloud_catalog_visible_title_variants variant on variant.external_id=job.external_id
      and variant.user_id=p_user_id and variant.source_id=p_source_id and variant.generation_id=p_generation_id
      and variant.item_type='movie' and variant.external_id=any(p_external_ids)
    join public.cloud_media_items media on media.id=variant.media_item_id and media.user_id=variant.user_id
      and media.source_id=variant.source_id and media.generation_id=variant.generation_id and media.item_type='movie' and media.available
    where job.state='completed'
      and encode(sha256(convert_to(variant.playback_hint->>'targetUrl','UTF8')),'hex')=job.url_sha256
      and media.playback_hint->>'targetUrl'=variant.playback_hint->>'targetUrl'
  loop
    insert into public.catalog_file_tracks as cache(
      server_host,item_type,external_id,audio_tracks,subtitle_tracks,audio_probed_at,subtitle_probed_at,
      audio_lang_verified_at,audio_lang_retry_at,audio_lang_verification,updated_at
    ) values(v_key,'movie',v_file.external_id,v_file.result->'audioTracks',v_file.result->'subtitleTracks',
      v_file.completed_at,v_file.completed_at,
      case when (v_file.result->>'verified')::boolean then v_file.completed_at else null end,null,
      v_file.result->'verification',clock_timestamp())
    on conflict(server_host,item_type,external_id) do update set
      audio_tracks=excluded.audio_tracks,audio_probed_at=excluded.audio_probed_at,
      subtitle_tracks=case when cache.subtitle_probed_at is null or
          cache.audio_lang_verification->>'urlSha256' is distinct from excluded.audio_lang_verification->>'urlSha256'
        then excluded.subtitle_tracks else cache.subtitle_tracks end,
      subtitle_probed_at=case when cache.audio_lang_verification->>'urlSha256' is distinct from excluded.audio_lang_verification->>'urlSha256'
        then excluded.subtitle_probed_at else coalesce(cache.subtitle_probed_at,excluded.subtitle_probed_at) end,
      audio_lang_verified_at=excluded.audio_lang_verified_at,audio_lang_retry_at=null,
      audio_lang_verification=excluded.audio_lang_verification,updated_at=clock_timestamp()
    where cache.audio_lang_verification->>'urlSha256' is distinct from excluded.audio_lang_verification->>'urlSha256'
      or (cache.audio_lang_verified_at is null and (excluded.audio_lang_verified_at is not null
        or cardinality(public.cloud_file_track_languages(cache.audio_tracks))=0
        or (not coalesce(public.selection_audio_tracks_complete(cache.audio_tracks),false)
          and public.selection_audio_tracks_complete(excluded.audio_tracks))));
    get diagnostics v_changed=row_count;
    -- Hydrate even if a stronger cache entry was preserved: a fresh enrolment
    -- may still be missing its exact-file observation.
    v_ids:=array_append(v_ids,v_file.external_id);
  end loop;
  if cardinality(v_ids)=0 then return 0; end if;
  return public.hydrate_cloud_title_file_languages(p_user_id,p_source_id,p_generation_id,p_head_revision,
    p_config_revision,p_source_visibility_epoch,p_user_visibility_epoch,v_key,'movie',v_ids);
end
$function$;

revoke all on function public.selection_audio_tracks_complete(jsonb) from public,anon,authenticated;
revoke all on function public.selection_audio_job_owners(text,text) from public,anon,authenticated;
revoke all on function public.seed_selection_audio_jobs(jsonb) from public,anon,authenticated;
revoke all on function public.claim_selection_audio_job() from public,anon,authenticated;
revoke all on function public.checkpoint_selection_audio_job(text,text,uuid,jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.finish_selection_audio_job(text,text,uuid,jsonb,text,boolean) from public,anon,authenticated;
revoke all on function public.hydrate_selection_audio_results(uuid,uuid,uuid,bigint,bigint,bigint,bigint,text[]) from public,anon,authenticated;
revoke all on function public.pending_selection_audio_hydrations(integer) from public,anon,authenticated;
revoke all on function public.ack_selection_audio_hydration(text,text) from public,anon,authenticated;
grant execute on function public.selection_audio_tracks_complete(jsonb) to service_role;
grant execute on function public.selection_audio_job_owners(text,text) to service_role;
grant execute on function public.seed_selection_audio_jobs(jsonb) to service_role;
grant execute on function public.claim_selection_audio_job() to service_role;
grant execute on function public.checkpoint_selection_audio_job(text,text,uuid,jsonb,jsonb) to service_role;
grant execute on function public.finish_selection_audio_job(text,text,uuid,jsonb,text,boolean) to service_role;
grant execute on function public.hydrate_selection_audio_results(uuid,uuid,uuid,bigint,bigint,bigint,bigint,text[]) to service_role;
grant execute on function public.pending_selection_audio_hydrations(integer) to service_role;
grant execute on function public.ack_selection_audio_hydration(text,text) to service_role;
notify pgrst,'reload schema';
commit;
