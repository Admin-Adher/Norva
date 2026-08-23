begin;
set local lock_timeout = '2s';
set local statement_timeout = '5min';

-- Resolve provider identity from the bounded private sample accumulated by the
-- seal worker.  This replaces the former whole-generation DISTINCT scan that
-- was accidentally executed on every BUILDING job claim.
create or replace function public.norva_catalog_manifest_progress_strong_identity(
  p_generation_id uuid
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_progress public.cloud_source_catalog_manifest_seal_progress%rowtype;
  v_current_identity uuid;
  v_candidate_identity uuid;
begin
  select progress.* into v_progress
  from public.cloud_source_catalog_manifest_seal_progress progress
  where progress.generation_id = p_generation_id;
  if not found then
    raise exception 'catalog manifest progress not found'
      using errcode = 'P0002';
  end if;

  select link.identity_id into v_current_identity
  from public.catalog_source_provider_identities link
  join public.provider_identities identity on identity.id = link.identity_id
  where link.source_id = v_progress.source_id
    and link.user_id = v_progress.user_id
    and identity.status = 'active'
  order by link.identity_id
  limit 1;

  with candidate_sample as materialized (
    select array(
      select distinct external_id
      from unnest(v_progress.strong_identity_sample) external_id
      where coalesce(external_id, '') <> ''
        and octet_length(external_id) <= 128
      order by external_id
    ) as stream_sample
  ), scored as (
    select identity.id,
      cardinality(array(
        select value from unnest(identity.stream_sample) value
        intersect
        select value from unnest(sample.stream_sample) value
      ))::numeric / nullif(cardinality(array(
        select value from unnest(identity.stream_sample) value
        union
        select value from unnest(sample.stream_sample) value
      )), 0) as score
    from candidate_sample sample
    join public.provider_identities identity
      on identity.status = 'active'
     and identity.stream_sample && sample.stream_sample
    where cardinality(sample.stream_sample) >= 32
  )
  select scored.id into v_candidate_identity
  from scored
  where scored.score >= 0.5
  order by scored.score desc, scored.id
  limit 1;

  return jsonb_build_object(
    'currentKnown', v_current_identity is not null,
    'candidateKnown', v_candidate_identity is not null,
    'match', v_current_identity is not null
      and v_candidate_identity = v_current_identity,
    'distinct', v_current_identity is not null
      and v_candidate_identity is not null
      and v_candidate_identity <> v_current_identity
  );
end
$function$;
revoke all on function
  public.norva_catalog_manifest_progress_strong_identity(uuid)
from public, anon, authenticated, service_role;

create or replace function public.norva_catalog_manifest_progress_result(
  p_generation_id uuid
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_progress public.cloud_source_catalog_manifest_seal_progress%rowtype;
  v_checksum text;
  v_sample jsonb;
  v_strong_identity jsonb;
begin
  select progress.* into v_progress
  from public.cloud_source_catalog_manifest_seal_progress progress
  where progress.generation_id = p_generation_id
    and progress.phase = 'complete';
  if not found then
    raise exception 'catalog manifest progress is not complete'
      using errcode = '55000', detail = 'reason=manifest_seal_incomplete';
  end if;
  v_checksum := encode(extensions.digest(jsonb_build_array(
    'norva-catalog-content-manifest-v2', v_progress.media_items_count,
    v_progress.lane_sum_0::text, v_progress.lane_xor_0::text,
    v_progress.lane_sum_1::text, v_progress.lane_xor_1::text,
    v_progress.lane_sum_2::text, v_progress.lane_xor_2::text,
    v_progress.lane_sum_3::text, v_progress.lane_xor_3::text
  )::text, 'sha256'), 'hex');
  select coalesce(jsonb_agg(jsonb_build_object(
      'itemType', normalized.item_type,
      'externalIdHash', normalized.external_id_hash
    ) order by normalized.order_hash, normalized.item_type,
      normalized.external_id_hash),
    '[]'::jsonb)
  into v_sample
  from jsonb_to_recordset(v_progress.identity_sample) sample(
    "orderHash" text, "itemType" text, "externalIdHash" text
  )
  cross join lateral (select sample."orderHash", sample."itemType",
    sample."externalIdHash") normalized(
      order_hash, item_type, external_id_hash
    );
  v_strong_identity :=
    public.norva_catalog_manifest_progress_strong_identity(p_generation_id);
  return jsonb_build_object(
    'counts', jsonb_build_object(
      'mediaItems', v_progress.media_items_count,
      'titleVariants', v_progress.title_variants_count,
      'liveChannels', v_progress.live_channels_count,
      'liveVariants', v_progress.live_variants_count,
      'episodeMemberships', v_progress.episode_memberships_count,
      'seriesInventory', v_progress.series_inventory_count
    ),
    'checksum', v_checksum,
    'identityEvidence', jsonb_build_object(
      'complete', true,
      'sampleSize', jsonb_array_length(v_sample),
      'sample', v_sample,
      'movieCount', v_progress.movie_items_count,
      'seriesCount', v_progress.series_items_count,
      'strongIdentity', v_strong_identity,
      'contentManifestChecksum', v_checksum
    )
  );
end
$function$;
revoke all on function public.norva_catalog_manifest_progress_result(uuid)
from public, anon, authenticated, service_role;

-- Strong identity is durable metadata once the bounded seal completes.  While
-- BUILDING, return an explicit unknown result instead of rescanning all media.
create or replace function public.norva_credential_strong_identity_signals(
  p_transition_id uuid,
  p_user_id uuid
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_result jsonb;
begin
  select generation.identity_evidence -> 'strongIdentity' into v_result
  from public.cloud_source_transitions transition
  join public.cloud_source_catalog_generations generation
    on generation.id = transition.candidate_catalog_generation_id
   and generation.transition_id = transition.id
   and generation.user_id = transition.user_id
  where transition.id = p_transition_id
    and transition.user_id = p_user_id
    and generation.state in ('ready','active','retained');
  return coalesce(v_result, jsonb_build_object(
    'currentKnown', false,
    'candidateKnown', false,
    'match', false,
    'distinct', false
  ));
end
$function$;

-- Manifest reads are metadata-only.  The old implementation performed whole
-- generation scans inside PostgREST calls; all physical work now belongs to
-- the resumable, lease-fenced seal RPC below.
create or replace function public.norva_compute_catalog_generation_manifest(
  p_generation_id uuid
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_generation public.cloud_source_catalog_generations%rowtype;
begin
  select generation.* into v_generation
  from public.cloud_source_catalog_generations generation
  where generation.id = p_generation_id;
  if not found then
    raise exception 'catalog generation not found' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'counts', v_generation.manifest_counts,
    'checksum', v_generation.manifest_checksum,
    'identityEvidence', case
      when v_generation.manifest_checksum is not null
        and coalesce((v_generation.identity_evidence ->> 'complete')::boolean,
                     false)
      then v_generation.identity_evidence
      else jsonb_build_object(
        'complete', false, 'sampleSize', 0, 'sample', '[]'::jsonb,
        'movieCount', 0, 'seriesCount', 0,
        'contentManifestChecksum', null
      )
    end
  );
end
$function$;

-- Metadata-only generation lookup.  The previous definition called the
-- whole-generation strong-identity sampler even while BUILDING, making a
-- resumable import O(n^2) across claims.
create or replace function public.norva_get_credential_catalog_generation(
  p_transition_id uuid,
  p_user_id uuid
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_result jsonb;
begin
  perform public.norva_credential_require_service_role();
  select jsonb_build_object(
    'transitionId', transition.id,
    'transitionRevision', transition.revision,
    'generationId', generation.id,
    'generationState', upper(generation.state),
    'generationRevision', generation.revision,
    'configRevision', generation.config_revision,
    'manifestCounts', generation.manifest_counts,
    'manifestChecksum', generation.manifest_checksum,
    'identityEvidence', generation.identity_evidence,
    'strongIdentity', coalesce(
      generation.identity_evidence -> 'strongIdentity',
      jsonb_build_object(
        'currentKnown', false,
        'candidateKnown', false,
        'match', false,
        'distinct', false
      )
    ),
    'gatewayCompleteAt', generation.gateway_complete_at,
    'headRevision', head.head_revision,
    'isActiveHead', head.active_generation_id = generation.id
  ) into v_result
  from public.cloud_source_transitions transition
  join public.cloud_source_catalog_generations generation
    on generation.id = transition.candidate_catalog_generation_id
   and generation.transition_id = transition.id
  join public.cloud_source_catalog_heads head
    on head.source_id = transition.old_source_id
   and head.user_id = transition.user_id
  where transition.id = p_transition_id
    and transition.user_id = p_user_id;
  if v_result is null then
    raise exception 'credential catalog generation not found'
      using errcode = 'P0002';
  end if;
  return v_result;
end
$function$;

create or replace function public.norva_get_active_catalog_identity_evidence(
  p_user_id uuid,
  p_source_id uuid
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_generation public.cloud_source_catalog_generations%rowtype;
begin
  perform public.norva_credential_require_service_role();
  select generation.* into v_generation
  from public.cloud_source_catalog_heads head
  join public.cloud_source_catalog_generations generation
    on generation.id = head.active_generation_id
   and generation.source_id = head.source_id
   and generation.user_id = head.user_id
  where head.source_id = p_source_id and head.user_id = p_user_id;
  if not found then
    raise exception 'active catalog generation not found' using errcode = 'P0002';
  end if;
  if v_generation.manifest_checksum is null
     or not coalesce(
       (v_generation.identity_evidence ->> 'complete')::boolean, false
     ) then
    raise exception 'active catalog identity evidence is not sealed'
      using errcode = '40001', detail = 'reason=manifest_seal_incomplete';
  end if;
  return jsonb_build_object(
    'sourceId', p_source_id,
    'generationId', v_generation.id,
    'identityEvidence', v_generation.identity_evidence
  );
end
$function$;

create or replace function public.norva_preview_credential_catalog_manifest(
  p_transition_id uuid,
  p_user_id uuid,
  p_generation_id uuid,
  p_job_id uuid,
  p_worker text,
  p_expected_attempt integer
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_generation public.cloud_source_catalog_generations%rowtype;
  v_progress public.cloud_source_catalog_manifest_seal_progress%rowtype;
begin
  perform public.norva_credential_require_service_role();
  select generation.* into v_generation
  from public.cloud_source_credential_transition_jobs job
  join public.cloud_source_transitions transition
    on transition.id = job.transition_id and transition.user_id = job.user_id
  join public.cloud_source_catalog_generations generation
    on generation.id = job.catalog_generation_id
   and generation.user_id = job.user_id
   and generation.source_id = job.source_id
  where job.id = p_job_id and job.transition_id = p_transition_id
    and job.user_id = p_user_id and job.catalog_generation_id = p_generation_id
    and job.job_kind = 'build_candidate_generation'
    and job.state = 'processing' and job.lease_owner = p_worker
    and job.lease_sequence = p_expected_attempt and job.lease_until > now()
    and transition.state = 'importing' and generation.state in ('building','ready');
  if not found then
    raise exception 'candidate manifest lease CAS failed' using errcode = '40001';
  end if;
  select progress.* into v_progress
  from public.cloud_source_catalog_manifest_seal_progress progress
  where progress.generation_id = p_generation_id;
  return public.norva_compute_catalog_generation_manifest(p_generation_id)
    || jsonb_build_object(
      'transitionId', p_transition_id,
      'generationId', p_generation_id,
      'generationRevision', v_generation.revision,
      'sealPhase', case when found then v_progress.phase else null end,
      'processedRows', case when found then v_progress.processed_rows else 0 end,
      'complete', v_generation.state = 'ready'
    );
end
$function$;
revoke all on function public.norva_preview_credential_catalog_manifest(
  uuid,uuid,uuid,uuid,text,integer
) from public, anon, authenticated, service_role;

-- Every physical catalogue statement fences against the generation row.  The
-- WHERE predicate is rechecked after a concurrent row-lock wait, so a writer
-- that started before sealing cannot commit after the fence.  Active writes
-- invalidate stored evidence; the next transition must reseal it.
create or replace function public.norva_catalog_generation_row_changed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_generation_id uuid;
begin
  if tg_op = 'DELETE' then
    -- Expand/backfill deliberately leaves a short compatibility window where
    -- legacy rows may still carry generation_id = NULL.  The row guard owns
    -- the rollout/flag policy for those rows; there is no generation manifest
    -- to revise until the contract has made the key NOT NULL.
    for v_generation_id in
      select distinct generation_id from old_rows where generation_id is not null
    loop
      update public.cloud_source_catalog_generations generation
      set revision = generation.revision + 1,
          manifest_counts = case when generation.state = 'active'
            then '{}'::jsonb else generation.manifest_counts end,
          manifest_checksum = case when generation.state = 'active'
            then null else generation.manifest_checksum end,
          identity_evidence = case when generation.state = 'active'
            then '{}'::jsonb else generation.identity_evidence end,
          updated_at = clock_timestamp()
      where generation.id = v_generation_id
        and generation.state in ('building','active')
        and not generation.manifest_sealing;
      if not found then
        -- A bounded terminal purge is the only statement allowed to mutate a
        -- generation outside BUILDING/ACTIVE.  Every other zero-row CAS is a
        -- closed/finalized generation, including the old-writer race where a
        -- seal reached READY and cleared manifest_sealing before this AFTER
        -- STATEMENT trigger resumed.
        if tg_op = 'DELETE'
           and current_setting('norva.catalog_purge_generation', true)
             is not distinct from v_generation_id::text
           and exists (
             select 1 from public.cloud_source_catalog_generations generation
             where generation.id = v_generation_id
               and generation.state = 'purging'
           ) then
          null;
        elsif exists (
          select 1 from public.cloud_source_catalog_generations generation
          where generation.id = v_generation_id
            and generation.manifest_sealing
        ) then
          raise exception 'catalog generation is sealed for manifest snapshot'
            using errcode = '40001', detail = 'reason=manifest_sealing';
        else
          raise exception 'catalog generation changed during catalog statement'
            using errcode = '40001',
              detail = 'reason=manifest_generation_changed';
        end if;
      end if;
    end loop;
  else
    for v_generation_id in
      select distinct generation_id from new_rows where generation_id is not null
    loop
      update public.cloud_source_catalog_generations generation
      set revision = generation.revision + 1,
          manifest_counts = case when generation.state = 'active'
            then '{}'::jsonb else generation.manifest_counts end,
          manifest_checksum = case when generation.state = 'active'
            then null else generation.manifest_checksum end,
          identity_evidence = case when generation.state = 'active'
            then '{}'::jsonb else generation.identity_evidence end,
          updated_at = clock_timestamp()
      where generation.id = v_generation_id
        and generation.state in ('building','active')
        and not generation.manifest_sealing;
      if not found then
        if exists (
          select 1 from public.cloud_source_catalog_generations generation
          where generation.id = v_generation_id
            and generation.manifest_sealing
        ) then
          raise exception 'catalog generation is sealed for manifest snapshot'
            using errcode = '40001', detail = 'reason=manifest_sealing';
        else
          raise exception 'catalog generation changed during catalog statement'
            using errcode = '40001',
              detail = 'reason=manifest_generation_changed';
        end if;
      end if;
    end loop;
  end if;
  return null;
end
$function$;

commit;
