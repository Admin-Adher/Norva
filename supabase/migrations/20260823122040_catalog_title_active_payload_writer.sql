begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

drop function if exists public.norva_upsert_active_catalog_title_payloads(
  uuid,uuid,uuid,bigint,bigint,bigint,bigint,jsonb
);
drop function if exists public.norva_mark_active_catalog_title_projection_refreshed(
  uuid,uuid,uuid,bigint,bigint,bigint,bigint
);
drop function if exists public.norva_begin_active_catalog_title_projection_refresh(
  uuid,uuid,uuid,bigint,bigint,bigint,bigint
);

-- Establish one durable refresh run after the head has switched to the
-- transition generation.  Retries return the same UUID; a stale worker cannot
-- reconcile or mark completion for a different run.
create or replace function public.norva_begin_active_catalog_title_projection_refresh(
  p_source_id uuid,
  p_user_id uuid,
  p_generation_id uuid,
  p_job_id uuid,
  p_worker text,
  p_lease_sequence integer,
  p_head_revision bigint,
  p_config_revision bigint,
  p_source_visibility_epoch bigint,
  p_user_visibility_epoch bigint
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_role text := coalesce(
    nullif(auth.jwt() ->> 'role', ''),
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('role', true), 'none'),
    ''
  );
  v_generation public.cloud_source_catalog_generations%rowtype;
  v_job public.cloud_source_credential_transition_jobs%rowtype;
  v_transition public.cloud_source_transitions%rowtype;
  v_epoch bigint;
  v_run_id uuid;
  v_generation_revision bigint;
  v_replayed boolean := false;
  v_checkpoint_progress jsonb;
  v_checkpoint_revision bigint;
  v_checkpoint_head_revision bigint;
  v_checkpoint_config_revision bigint;
  v_checkpoint_source_epoch bigint;
  v_checkpoint_user_epoch bigint;
begin
  if v_role <> 'service_role'
     and not (v_role in ('', 'postgres') and session_user = 'postgres') then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if not public.norva_catalog_title_active_payload_indexes_ready() then
    raise exception 'active title payload index contract is not ready'
      using errcode = '55000', detail = 'reason=title_projection_index_drift';
  end if;
  if p_job_id is null or nullif(btrim(p_worker),'') is null
     or p_lease_sequence is null or p_lease_sequence < 1 then
    raise exception 'active title refresh lease proof is invalid'
      using errcode = '22023';
  end if;
  select transition.* into v_transition
  from public.cloud_source_transitions transition
  join public.cloud_source_credential_transition_jobs job
    on job.transition_id = transition.id and job.user_id = transition.user_id
  where job.id = p_job_id and transition.user_id = p_user_id
    and transition.old_source_id = p_source_id
    and transition.candidate_catalog_generation_id = p_generation_id
    and transition.state = 'committing'
  for update of transition;
  if not found then
    raise exception 'active title refresh transition CAS failed'
      using errcode = '40001', detail = 'reason=credential_transition_changed';
  end if;
  select job.* into v_job
  from public.cloud_source_credential_transition_jobs job
  where job.id = p_job_id
    and job.user_id = p_user_id
    and job.source_id = p_source_id
    and job.transition_id = v_transition.id
    and job.catalog_generation_id = p_generation_id
    and job.job_kind = 'post_switch_verify'
    and job.state = 'processing'
    and job.lease_owner = p_worker
    and job.lease_sequence = p_lease_sequence
    and job.lease_until > now()
  for update;
  if not found then
    raise exception 'active title refresh job lease CAS failed'
      using errcode = '40001', detail = 'reason=credential_job_lease_changed';
  end if;
  select generation.* into v_generation
  from public.cloud_source_catalog_generations generation
  where generation.id = p_generation_id
    and generation.user_id = p_user_id
    and generation.source_id = p_source_id
    and generation.state = 'active'
    and generation.transition_id is not null
    and not generation.manifest_sealing
  for update;
  if not found then
    raise exception 'active title refresh generation CAS failed'
      using errcode = '40001', detail = 'reason=catalog_generation_changed';
  end if;
  if v_generation.transition_id is distinct from v_transition.id then
    raise exception 'active title refresh generation transition drift'
      using errcode = '40001', detail = 'reason=credential_transition_changed';
  end if;
  insert into public.cloud_user_catalog_visibility_epochs(
    user_id,visibility_epoch,updated_at
  ) values (p_user_id,1,now()) on conflict (user_id) do nothing;
  select epoch.visibility_epoch into v_epoch
  from public.cloud_user_catalog_visibility_epochs epoch
  where epoch.user_id = p_user_id for update;
  if v_epoch is distinct from p_user_visibility_epoch
     or v_generation.config_revision is distinct from p_config_revision
     or not exists (
       select 1
       from public.cloud_source_catalog_heads head
       join public.cloud_source_lifecycle lifecycle
         on lifecycle.source_id = head.source_id
        and lifecycle.user_id = head.user_id
       join public.cloud_source_transitions transition
         on transition.id = v_generation.transition_id
        and transition.user_id = v_generation.user_id
       where head.source_id = p_source_id and head.user_id = p_user_id
         and head.active_generation_id = p_generation_id
         and head.head_revision = p_head_revision
         and lifecycle.config_revision = p_config_revision
         and lifecycle.visibility_epoch = p_source_visibility_epoch
         and transition.state = 'committing'
         and public.norva_source_catalog_visible_internal(
           p_source_id,p_user_id
         )
     ) then
    raise exception 'active title refresh snapshot CAS failed'
      using errcode = '40001', detail = 'reason=catalog_generation_changed';
  end if;
  if v_generation.title_projection_refresh_run_id is null then
    v_run_id := gen_random_uuid();
    update public.cloud_source_catalog_generations generation
    set title_projection_refresh_run_id = v_run_id,
        title_projection_inventory_completed_at = null,
        title_projection_refreshed_at = null,
        revision = generation.revision + 1,
        updated_at = clock_timestamp()
    where generation.id = p_generation_id
    returning generation.revision into v_generation_revision;
    update public.cloud_source_credential_transition_jobs job
    set title_projection_refresh_run_id = v_run_id,
        title_inventory_observed_count = null,
        title_pruned_variant_count = null,
        title_inventory_completed_at = null,
        title_prune_completed_at = null,
        updated_at = clock_timestamp()
    where job.id = p_job_id;
  else
    v_run_id := v_generation.title_projection_refresh_run_id;
    if v_job.title_projection_refresh_run_id is distinct from v_run_id then
      raise exception 'active title refresh ledger CAS failed'
        using errcode = '40001', detail = 'reason=title_refresh_run_changed';
    end if;
    v_generation_revision := v_generation.revision;
    v_replayed := true;
  end if;
  insert into public.cloud_source_catalog_title_refresh_actions (
    refresh_run_id,action_kind,job_id,transition_id,user_id,source_id,
    generation_id,baseline_count
  )
  select v_run_id,kind.action_kind,p_job_id,v_transition.id,p_user_id,
    p_source_id,p_generation_id,count(item.id)::bigint
  from (values
    ('live'::text,'live'::text),
    ('vod'::text,'movie'::text),
    ('series'::text,'series'::text)
  ) kind(action_kind,item_type)
  left join public.cloud_media_items item
    on item.generation_id = p_generation_id
   and item.source_id = p_source_id and item.user_id = p_user_id
   and item.item_type = kind.item_type
  group by kind.action_kind
  on conflict (refresh_run_id,action_kind) do nothing;
  if (
       select count(*)
       from public.cloud_source_catalog_title_refresh_actions action
       where action.refresh_run_id = v_run_id
         and action.job_id = p_job_id
         and action.transition_id = v_transition.id
         and action.user_id = p_user_id and action.source_id = p_source_id
         and action.generation_id = p_generation_id
        and action.state in ('started','pruning','complete')
     ) <> 3 then
    raise exception 'active title refresh baseline ledger drift'
      using errcode = '40001', detail = 'reason=title_refresh_run_changed';
  end if;
  select checkpoint.progress,checkpoint.checkpoint_revision,
    checkpoint.head_revision,checkpoint.config_revision,
    checkpoint.source_visibility_epoch,checkpoint.user_visibility_epoch
  into v_checkpoint_progress,v_checkpoint_revision,
    v_checkpoint_head_revision,v_checkpoint_config_revision,
    v_checkpoint_source_epoch,v_checkpoint_user_epoch
  from public.cloud_source_catalog_title_refresh_checkpoints checkpoint
  where checkpoint.job_id = p_job_id
    and checkpoint.refresh_run_id = v_run_id
    and checkpoint.transition_id = v_transition.id
    and checkpoint.user_id = p_user_id and checkpoint.source_id = p_source_id
    and checkpoint.generation_id = p_generation_id
  for update;
  if found then
    if v_checkpoint_revision is distinct from v_job.checkpoint_revision
       or v_checkpoint_head_revision is distinct from p_head_revision
       or v_checkpoint_config_revision is distinct from p_config_revision
       or v_checkpoint_source_epoch is distinct from p_source_visibility_epoch
    then
      raise exception 'active title refresh checkpoint revision drift'
        using errcode = '40001',
          detail = 'reason=credential_job_checkpoint_changed';
    end if;
    if v_checkpoint_user_epoch is distinct from v_epoch then
      update public.cloud_source_catalog_title_refresh_checkpoints checkpoint
      set user_visibility_epoch = v_epoch,
          updated_at = clock_timestamp()
      where checkpoint.job_id = p_job_id
        and checkpoint.refresh_run_id = v_run_id
        and checkpoint.checkpoint_revision = v_checkpoint_revision
        and checkpoint.user_visibility_epoch = v_checkpoint_user_epoch;
      if not found then
        raise exception 'active title refresh checkpoint epoch repin failed'
          using errcode = '40001',
            detail = 'reason=credential_job_checkpoint_changed';
      end if;
    end if;
  else
    v_checkpoint_revision := v_job.checkpoint_revision;
    if v_checkpoint_revision <> 0 then
      raise exception 'active title refresh checkpoint row is missing'
        using errcode = '40001',
          detail = 'reason=credential_job_checkpoint_changed';
    end if;
    -- A Gateway spool may legitimately answer 202 before it has a signed
    -- manifest.  Persist the run's database-owned catalog version and an
    -- explicit zero-progress checkpoint now, in the same transaction that
    -- creates the refresh run.  Requeueing this state does not consume the
    -- worker failure budget; the first 200 response binds its digest once.
    v_checkpoint_progress := jsonb_build_object(
      'version',1,
      'catalogVersion',v_generation_revision,
      'action','live_categories',
      'actionComplete',false,
      'cursor','',
      'spoolToken','',
      'contentSha256','',
      'processedCategories',0,
      'processedItems',0,
      'observedItems',0,
      'categoryCount',0
    );
    v_checkpoint_revision := 1;
    insert into public.cloud_source_catalog_title_refresh_checkpoints (
      job_id,refresh_run_id,transition_id,user_id,source_id,generation_id,
      checkpoint_revision,head_revision,config_revision,
      source_visibility_epoch,user_visibility_epoch,progress
    ) values (
      p_job_id,v_run_id,v_transition.id,p_user_id,p_source_id,p_generation_id,
      v_checkpoint_revision,p_head_revision,p_config_revision,
      p_source_visibility_epoch,p_user_visibility_epoch,v_checkpoint_progress
    );
    update public.cloud_source_credential_transition_jobs job
    set checkpoint_revision = v_checkpoint_revision,
        updated_at = clock_timestamp()
    where job.id = p_job_id and job.checkpoint_revision = 0;
    if not found then
      raise exception 'active title refresh initial checkpoint CAS failed'
        using errcode = '40001',
          detail = 'reason=credential_job_checkpoint_changed';
    end if;
  end if;
  return jsonb_build_object(
    'contract','catalog-title-active-refresh-run-v1',
    'generationId',p_generation_id,'refreshRunId',v_run_id,
    'jobId',p_job_id,'leaseSequence',p_lease_sequence,
    'headRevision',p_head_revision,'configRevision',p_config_revision,
    'sourceVisibilityEpoch',p_source_visibility_epoch,
    'visibilityEpoch',v_epoch,'generationRevision',v_generation_revision,
    'checkpointRevision',v_checkpoint_revision,
    'checkpoint',v_checkpoint_progress,
    'replayed',v_replayed
  );
end
$function$;

revoke all on function public.norva_begin_active_catalog_title_projection_refresh(
  uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint
) from public,anon,authenticated,service_role;
grant execute on function public.norva_begin_active_catalog_title_projection_refresh(
  uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint
) to service_role;

-- Private lock primitive shared by every post-switch inventory/materialization
-- writer.  The order is deliberately transition -> exact job -> generation ->
-- user epoch; no caller may acquire a payload row before this fence.
create or replace function public.norva_lock_active_catalog_refresh_lease(
  p_source_id uuid,
  p_user_id uuid,
  p_generation_id uuid,
  p_refresh_run_id uuid,
  p_job_id uuid,
  p_worker text,
  p_lease_sequence integer,
  p_head_revision bigint,
  p_config_revision bigint,
  p_source_visibility_epoch bigint,
  p_user_visibility_epoch bigint
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_transition public.cloud_source_transitions%rowtype;
  v_job public.cloud_source_credential_transition_jobs%rowtype;
  v_generation public.cloud_source_catalog_generations%rowtype;
  v_epoch bigint;
begin
  perform public.norva_credential_require_service_role();
  if p_refresh_run_id is null or p_job_id is null
     or nullif(btrim(p_worker),'') is null or length(p_worker) > 160
     or p_lease_sequence is null or p_lease_sequence < 1
     or p_head_revision is null or p_head_revision < 0
     or p_config_revision is null or p_config_revision < 0
     or p_source_visibility_epoch is null
     or p_source_visibility_epoch < 1
     or p_user_visibility_epoch is null
     or p_user_visibility_epoch < 1 then
    raise exception 'active catalog refresh lease proof is invalid'
      using errcode = '22023';
  end if;
  select transition.* into v_transition
  from public.cloud_source_transitions transition
  where transition.user_id = p_user_id
    and transition.old_source_id = p_source_id
    and transition.candidate_catalog_generation_id = p_generation_id
    and transition.state = 'committing'
  for update;
  if not found then
    raise exception 'active catalog refresh transition CAS failed'
      using errcode = '40001', detail = 'reason=credential_transition_changed';
  end if;
  select job.* into v_job
  from public.cloud_source_credential_transition_jobs job
  where job.id = p_job_id and job.transition_id = v_transition.id
    and job.user_id = p_user_id and job.source_id = p_source_id
    and job.catalog_generation_id = p_generation_id
    and job.job_kind = 'post_switch_verify'
    and job.state = 'processing' and job.lease_owner = p_worker
    and job.lease_sequence = p_lease_sequence and job.lease_until > now()
    and job.title_projection_refresh_run_id = p_refresh_run_id
  for update;
  if not found then
    raise exception 'active catalog refresh job lease CAS failed'
      using errcode = '40001', detail = 'reason=credential_job_lease_changed';
  end if;
  select generation.* into v_generation
  from public.cloud_source_catalog_generations generation
  where generation.id = p_generation_id
    and generation.user_id = p_user_id and generation.source_id = p_source_id
    and generation.transition_id = v_transition.id
    and generation.state = 'active' and not generation.manifest_sealing
    and generation.title_projection_refresh_run_id = p_refresh_run_id
  for update;
  if not found then
    raise exception 'active catalog refresh generation CAS failed'
      using errcode = '40001', detail = 'reason=catalog_generation_changed';
  end if;
  insert into public.cloud_user_catalog_visibility_epochs(
    user_id,visibility_epoch,updated_at
  ) values (p_user_id,1,now()) on conflict (user_id) do nothing;
  select epoch.visibility_epoch into v_epoch
  from public.cloud_user_catalog_visibility_epochs epoch
  where epoch.user_id = p_user_id for update;
  if v_epoch is distinct from p_user_visibility_epoch
     or v_generation.config_revision is distinct from p_config_revision
     or not exists (
       select 1
       from public.cloud_source_catalog_heads head
       join public.cloud_source_lifecycle lifecycle
         on lifecycle.source_id = head.source_id
        and lifecycle.user_id = head.user_id
       where head.source_id = p_source_id and head.user_id = p_user_id
         and head.active_generation_id = p_generation_id
         and head.head_revision = p_head_revision
         and lifecycle.config_revision = p_config_revision
         and lifecycle.visibility_epoch = p_source_visibility_epoch
         and public.norva_source_catalog_visible_internal(
           p_source_id,p_user_id
         )
     ) then
    raise exception 'active catalog refresh snapshot CAS failed'
      using errcode = '40001', detail = 'reason=catalog_generation_changed';
  end if;
  return jsonb_build_object(
    'transitionId',v_transition.id,
    'visibilityEpoch',v_epoch,
    'generationRevision',v_generation.revision
  );
end
$function$;

revoke all on function public.norva_lock_active_catalog_refresh_lease(
  uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint
) from public,anon,authenticated,service_role;

-- Payload writes are forbidden while the Gateway spool is still in its 202
-- pre-manifest state and are scoped to the one action named by the durable
-- checkpoint.  The exact job lease is locked first by the caller.
create or replace function public.norva_require_active_catalog_refresh_action(
  p_job_id uuid,
  p_refresh_run_id uuid,
  p_action text,
  p_catalog_version bigint default null
) returns void
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if p_action not in (
       'live_categories','vod_categories','series_categories',
       'live_streams','vod_streams','series_streams'
     )
     or not exists (
       select 1
       from public.cloud_source_catalog_title_refresh_checkpoints checkpoint
       join public.cloud_source_credential_transition_jobs job
         on job.id = checkpoint.job_id
        and job.checkpoint_revision = checkpoint.checkpoint_revision
       where checkpoint.job_id = p_job_id
         and checkpoint.refresh_run_id = p_refresh_run_id
         and checkpoint.progress ->> 'action' = p_action
         and checkpoint.progress ->> 'contentSha256' ~ '^[0-9a-f]{64}$'
         and not (checkpoint.progress ->> 'actionComplete')::boolean
         and (
           p_catalog_version is null
           or (checkpoint.progress ->> 'catalogVersion')::bigint =
              p_catalog_version
         )
     ) then
    raise exception 'active catalog refresh action checkpoint is not bound'
      using errcode = '40001',
        detail = 'reason=credential_job_checkpoint_changed';
  end if;
end
$function$;

revoke all on function public.norva_require_active_catalog_refresh_action(
  uuid,uuid,text,bigint
) from public,anon,authenticated,service_role;

-- Visible payload/membership writes advance the user epoch.  Adopt that epoch
-- into the durable continuation in the same transaction, otherwise neither
-- the old nor the new snapshot can checkpoint or survive a lease reclaim.
create or replace function public.norva_adopt_active_catalog_refresh_epoch(
  p_job_id uuid,
  p_refresh_run_id uuid,
  p_old_epoch bigint,
  p_new_epoch bigint
) returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  if p_new_epoch is null or p_old_epoch is null or p_new_epoch <= p_old_epoch
  then
    raise exception 'active catalog refresh epoch adoption is invalid'
      using errcode = '40001',
        detail = 'reason=credential_job_checkpoint_changed';
  end if;
  update public.cloud_source_catalog_title_refresh_checkpoints checkpoint
  set user_visibility_epoch = p_new_epoch,
      updated_at = clock_timestamp()
  from public.cloud_source_credential_transition_jobs job
  where checkpoint.job_id = p_job_id
    and checkpoint.refresh_run_id = p_refresh_run_id
    and checkpoint.user_visibility_epoch = p_old_epoch
    and job.id = checkpoint.job_id
    and job.checkpoint_revision = checkpoint.checkpoint_revision
    and job.state = 'processing';
  if not found then
    raise exception 'active catalog refresh epoch checkpoint CAS failed'
      using errcode = '40001',
        detail = 'reason=credential_job_checkpoint_changed';
  end if;
end
$function$;

revoke all on function public.norva_adopt_active_catalog_refresh_epoch(
  uuid,uuid,bigint,bigint
) from public,anon,authenticated,service_role;

-- Provider inventory is refreshed through one exact-lease RPC while the head
-- remains compensable.  Existing rows retain playback/TMDB enrichment and only
-- advance their provider version/run marker; newly discovered rows are fully
-- inserted.  Thus an expired worker cannot mutate inventory after reclaim.
create or replace function public.norva_upsert_active_catalog_media_items(
  p_source_id uuid,
  p_user_id uuid,
  p_generation_id uuid,
  p_refresh_run_id uuid,
  p_job_id uuid,
  p_worker text,
  p_lease_sequence integer,
  p_head_revision bigint,
  p_config_revision bigint,
  p_source_visibility_epoch bigint,
  p_user_visibility_epoch bigint,
  p_catalog_version bigint,
  p_items jsonb
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_lock jsonb;
  v_transition_id uuid;
  v_previous_context text := current_setting(
    'norva.catalog_active_variant_refresh', true
  );
  v_expected integer;
  v_written integer;
  v_epoch bigint;
  v_result jsonb;
  v_action text;
begin
  perform public.norva_credential_require_service_role();
  if p_catalog_version is null or p_catalog_version < 0
     or p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) > 500
     or octet_length(p_items::text) > 4194304
     or exists (
       select 1 from jsonb_array_elements(p_items) item(value)
       where jsonb_typeof(item.value) <> 'object'
          or exists (
            select 1 from jsonb_object_keys(item.value) supplied(key)
            where supplied.key not in (
              'item_type','external_id','parent_external_id','title','subtitle',
              'poster_url','backdrop_url','metadata','playback_hint','available',
              'added_at','rating_num','release_year','dedup_key',
              'is_dedup_primary'
            )
          )
          or item.value ->> 'item_type' not in ('live','movie','series')
          or nullif(btrim(item.value ->> 'external_id'),'') is null
          or length(item.value ->> 'external_id') > 1200
          or nullif(btrim(item.value ->> 'title'),'') is null
          or length(item.value ->> 'title') > 2000
          or jsonb_typeof(coalesce(item.value -> 'metadata','{}'::jsonb))
             <> 'object'
          or jsonb_typeof(coalesce(item.value -> 'playback_hint','{}'::jsonb))
             <> 'object'
     ) then
    raise exception 'active media item batch is invalid or oversized'
      using errcode = '22023';
  end if;
  select count(*)::integer into v_expected
  from jsonb_array_elements(p_items);
  if v_expected is distinct from (
    select count(*)::integer from (
      select distinct item.value ->> 'item_type',
        btrim(item.value ->> 'external_id')
      from jsonb_array_elements(p_items) item(value)
    ) unique_item
  ) then
    raise exception 'active media item batch contains duplicates'
      using errcode = '22023';
  end if;
  if v_expected > 0 then
    if (
      select count(distinct item.value ->> 'item_type')
      from jsonb_array_elements(p_items) item(value)
    ) <> 1 then
      raise exception 'active media item batch crosses provider actions'
        using errcode = '22023';
    end if;
    select case min(item.value ->> 'item_type')
      when 'live' then 'live_streams'
      when 'movie' then 'vod_streams'
      else 'series_streams' end
    into v_action
    from jsonb_array_elements(p_items) item(value);
  end if;
  v_lock := public.norva_lock_active_catalog_refresh_lease(
    p_source_id,p_user_id,p_generation_id,p_refresh_run_id,p_job_id,
    p_worker,p_lease_sequence,p_head_revision,p_config_revision,
    p_source_visibility_epoch,p_user_visibility_epoch
  );
  v_transition_id := (v_lock ->> 'transitionId')::uuid;
  if v_expected > 0 then
    perform public.norva_require_active_catalog_refresh_action(
      p_job_id,p_refresh_run_id,v_action,p_catalog_version
    );
  end if;
  create temporary table if not exists pg_temp.norva_active_media_input (
    ordinal bigint not null,
    item_type text not null,
    external_id text not null,
    parent_external_id text,
    title text not null,
    subtitle text,
    poster_url text,
    backdrop_url text,
    metadata jsonb not null,
    playback_hint jsonb not null,
    available boolean not null,
    added_at bigint,
    rating_num numeric,
    release_year integer,
    dedup_key text,
    is_dedup_primary boolean not null,
    primary key (item_type,external_id)
  ) on commit drop;
  truncate table pg_temp.norva_active_media_input;
  insert into pg_temp.norva_active_media_input
  select input.ordinality,row.item_type,btrim(row.external_id),
    nullif(btrim(row.parent_external_id),''),btrim(row.title),row.subtitle,
    row.poster_url,row.backdrop_url,coalesce(row.metadata,'{}'::jsonb),
    coalesce(row.playback_hint,'{}'::jsonb),coalesce(row.available,true),
    row.added_at,row.rating_num,row.release_year,row.dedup_key,
    coalesce(row.is_dedup_primary,true)
  from jsonb_array_elements(p_items) with ordinality input(value,ordinality)
  cross join lateral jsonb_to_record(input.value) as row(
    item_type text,external_id text,parent_external_id text,title text,
    subtitle text,poster_url text,backdrop_url text,metadata jsonb,
    playback_hint jsonb,available boolean,added_at bigint,
    rating_num numeric,release_year integer,dedup_key text,
    is_dedup_primary boolean
  );
  perform set_config(
    'norva.catalog_active_variant_refresh',
    jsonb_build_object(
      'transitionId',v_transition_id,'userId',p_user_id,
      'sourceId',p_source_id,'generationId',p_generation_id,
      'refreshRunId',p_refresh_run_id,'jobId',p_job_id,
      'worker',p_worker,'leaseSequence',p_lease_sequence
    )::text,true
  );
  begin
    with upserted as (
      insert into public.cloud_media_items as item (
        user_id,source_id,item_type,external_id,parent_external_id,title,
        subtitle,poster_url,backdrop_url,metadata,playback_hint,available,
        added_at,rating_num,release_year,catalog_version,dedup_key,
        is_dedup_primary,generation_id,projection_refresh_run_id,
        write_head_revision,write_config_revision,
        write_source_visibility_epoch,write_user_visibility_epoch
      )
      select p_user_id,p_source_id,input.item_type,input.external_id,
        input.parent_external_id,input.title,input.subtitle,input.poster_url,
        input.backdrop_url,input.metadata,input.playback_hint,input.available,
        input.added_at,input.rating_num,input.release_year,p_catalog_version,
        input.dedup_key,input.is_dedup_primary,p_generation_id,
        p_refresh_run_id,p_head_revision,p_config_revision,
        p_source_visibility_epoch,p_user_visibility_epoch
      from pg_temp.norva_active_media_input input
      on conflict (source_id,generation_id,item_type,external_id) do update set
        parent_external_id=coalesce(
          excluded.parent_external_id,item.parent_external_id
        ),
        title=excluded.title,
        subtitle=coalesce(excluded.subtitle,item.subtitle),
        poster_url=coalesce(excluded.poster_url,item.poster_url),
        backdrop_url=coalesce(excluded.backdrop_url,item.backdrop_url),
        -- Xtream compact records omit unavailable provider keys.  Incoming
        -- provider values therefore win when present while crawler/playback
        -- enrichment absent from the response survives byte-for-byte.
        metadata=coalesce(item.metadata,'{}'::jsonb)
          || coalesce(excluded.metadata,'{}'::jsonb),
        playback_hint=(
          coalesce(item.playback_hint,'{}'::jsonb)
          || coalesce(excluded.playback_hint,'{}'::jsonb)
        ) || jsonb_strip_nulls(jsonb_build_object(
          'codecProfile',item.playback_hint -> 'codecProfile',
          'codec_profile',item.playback_hint -> 'codec_profile',
          'audioMode',item.playback_hint -> 'audioMode'
        )) || case
          -- An observed codec/container proof is stronger than the bare
          -- provider extension repeated by a later refresh.
          when (
            item.playback_hint ? 'codecProfile'
            or item.playback_hint ? 'codec_profile'
            or item.metadata ? 'codecProfileObservedAt'
          ) and item.playback_hint ? 'container'
          then jsonb_build_object(
            'container',item.playback_hint -> 'container'
          )
          else '{}'::jsonb
        end,
        available=excluded.available,
        -- cmi_set_sort_cols derives added_at/rating_num from the merged
        -- metadata.  A resolved TMDB year remains stronger than raw parsing.
        release_year=coalesce(item.release_year,excluded.release_year),
        catalog_version=excluded.catalog_version,
        dedup_key=coalesce(excluded.dedup_key,item.dedup_key),
        -- Dedup-primary ownership is an operational cross-row decision, not
        -- the per-item provider default carried by xtreamRows.
        is_dedup_primary=item.is_dedup_primary,
        projection_refresh_run_id=excluded.projection_refresh_run_id,
        -- BEFORE INSERT guards deliberately consume transient active-write
        -- proofs.  On an INSERT .. ON CONFLICT DO UPDATE path that means
        -- excluded.* has already been scrubbed.  Use the RPC arguments that
        -- were fence-checked by norva_lock_active_catalog_refresh_lease so the
        -- UPDATE trigger receives the exact same proof.
        write_head_revision=p_head_revision,
        write_config_revision=p_config_revision,
        write_source_visibility_epoch=p_source_visibility_epoch,
        write_user_visibility_epoch=p_user_visibility_epoch
      returning id
    ) select count(*)::integer into v_written from upserted;
  exception when others then
    perform set_config(
      'norva.catalog_active_variant_refresh',coalesce(v_previous_context,''),true
    );
    raise;
  end;
  perform set_config(
    'norva.catalog_active_variant_refresh',coalesce(v_previous_context,''),true
  );
  if v_written <> v_expected then
    raise exception 'active media item write count mismatch'
      using errcode = '40001', detail = 'reason=catalog_payload_changed';
  end if;
  if v_written > 0 then
    v_epoch := public.norva_bump_user_catalog_visibility_epoch(p_user_id);
    perform public.norva_adopt_active_catalog_refresh_epoch(
      p_job_id,p_refresh_run_id,
      (v_lock ->> 'visibilityEpoch')::bigint,v_epoch
    );
    delete from public.cloud_catalog_facet_summary where user_id = p_user_id;
  else
    v_epoch := (v_lock ->> 'visibilityEpoch')::bigint;
  end if;
  select jsonb_build_object(
    'contract','catalog-active-media-writer-v1',
    'generationId',p_generation_id,'refreshRunId',p_refresh_run_id,
    'jobId',p_job_id,'leaseSequence',p_lease_sequence,
    'catalogVersion',p_catalog_version,'visibilityEpoch',v_epoch,
    'writtenItems',v_written,
    'items',coalesce(jsonb_agg(jsonb_build_object(
      'mediaItemId',item.id,'itemType',item.item_type,
      'externalId',item.external_id
    ) order by input.ordinal),'[]'::jsonb)
  ) into v_result
  from pg_temp.norva_active_media_input input
  join public.cloud_media_items item
    on item.source_id = p_source_id
   and item.generation_id = p_generation_id
   and item.item_type = input.item_type
   and item.external_id = input.external_id
   and item.catalog_version = p_catalog_version
   and item.projection_refresh_run_id = p_refresh_run_id;
  if jsonb_array_length(v_result -> 'items') <> v_expected
     or octet_length(v_result::text) > 1048576 then
    raise exception 'active media response is incomplete or oversized'
      using errcode = '54000';
  end if;
  return v_result;
end
$function$;

revoke all on function public.norva_upsert_active_catalog_media_items(
  uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,
  bigint,jsonb
) from public,anon,authenticated,service_role;
grant execute on function public.norva_upsert_active_catalog_media_items(
  uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,
  bigint,jsonb
) to service_role;

-- Category discovery uses the same durable run.  Upsert-only markers make a
-- partial/empty response fail the terminal proof because any staging category
-- not re-observed remains NULL instead of being silently accepted by a caller
-- supplied count.
create or replace function public.norva_upsert_active_catalog_refresh_categories(
  p_source_id uuid,
  p_user_id uuid,
  p_generation_id uuid,
  p_refresh_run_id uuid,
  p_job_id uuid,
  p_worker text,
  p_lease_sequence integer,
  p_head_revision bigint,
  p_config_revision bigint,
  p_source_visibility_epoch bigint,
  p_user_visibility_epoch bigint,
  p_action_kind text,
  p_categories jsonb
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_lock jsonb;
  v_expected integer;
  v_written integer;
begin
  perform public.norva_credential_require_service_role();
  if p_action_kind not in ('live','vod','series')
     or p_categories is null or jsonb_typeof(p_categories) <> 'array'
     or jsonb_array_length(p_categories) > 500
     or octet_length(p_categories::text) > 524288
     or exists (
       select 1 from jsonb_array_elements(p_categories) category(value)
       where jsonb_typeof(category.value) <> 'object'
          or exists (
            select 1 from jsonb_object_keys(category.value) supplied(key)
            where supplied.key not in (
              'category_ordinal','provider_category_id','category_name'
            )
          )
          or nullif(btrim(category.value ->> 'provider_category_id'),'') is null
          or length(category.value ->> 'provider_category_id') > 1200
          or nullif(btrim(category.value ->> 'category_name'),'') is null
          or length(category.value ->> 'category_name') > 2000
          or coalesce((category.value ->> 'category_ordinal')::integer,-1) < 0
     ) then
    raise exception 'active category batch is invalid or oversized'
      using errcode = '22023';
  end if;
  select count(*)::integer into v_expected
  from jsonb_array_elements(p_categories);
  if v_expected is distinct from (
    select count(*)::integer from (
      select distinct btrim(category.value ->> 'provider_category_id')
      from jsonb_array_elements(p_categories) category(value)
    ) unique_category
  ) then
    raise exception 'active category batch contains duplicates'
      using errcode = '22023';
  end if;
  v_lock := public.norva_lock_active_catalog_refresh_lease(
    p_source_id,p_user_id,p_generation_id,p_refresh_run_id,p_job_id,
    p_worker,p_lease_sequence,p_head_revision,p_config_revision,
    p_source_visibility_epoch,p_user_visibility_epoch
  );
  perform public.norva_require_active_catalog_refresh_action(
    p_job_id,p_refresh_run_id,p_action_kind || '_categories',null
  );
  -- Provider ordinals are page-local and may be reordered between refreshes.
  -- Keep every existing durable ordinal and allocate only genuinely new IDs
  -- after the current maximum while the generation row remains locked.
  with input as materialized (
    select btrim(row.provider_category_id) as provider_category_id,
      btrim(row.category_name) as category_name
    from jsonb_to_recordset(p_categories) row(
      category_ordinal integer,provider_category_id text,category_name text
    )
  ), numbered as materialized (
    select input.*,
      coalesce((
        select max(category.category_ordinal) + 1
        from public.cloud_source_catalog_generation_categories category
        where category.generation_id = p_generation_id
          and category.category_kind = p_action_kind
      ),0) + row_number() over (
        order by input.provider_category_id
      ) - 1 as category_ordinal
    from input
    where not exists (
      select 1
      from public.cloud_source_catalog_generation_categories existing
      where existing.generation_id = p_generation_id
        and existing.category_kind = p_action_kind
        and existing.provider_category_id = input.provider_category_id
    )
  )
  insert into public.cloud_source_catalog_generation_categories (
      generation_id,user_id,source_id,category_kind,category_ordinal,
      provider_category_id,category_name,projection_refresh_run_id
  )
  select p_generation_id,p_user_id,p_source_id,p_action_kind,
    numbered.category_ordinal,numbered.provider_category_id,
    numbered.category_name,p_refresh_run_id
  from numbered
  on conflict (generation_id,category_kind,provider_category_id) do nothing;
  with input as materialized (
    select btrim(row.provider_category_id) as provider_category_id,
      btrim(row.category_name) as category_name
    from jsonb_to_recordset(p_categories) row(
      category_ordinal integer,provider_category_id text,category_name text
    )
  ), updated as (
    update public.cloud_source_catalog_generation_categories category
    set category_name=input.category_name,
        projection_refresh_run_id=p_refresh_run_id,
        updated_at=clock_timestamp()
    from input
    where category.generation_id = p_generation_id
      and category.category_kind = p_action_kind
      and category.provider_category_id = input.provider_category_id
    returning category.provider_category_id
  ) select count(*)::integer into v_written from updated;
  if v_written <> v_expected then
    raise exception 'active category write count mismatch'
      using errcode = '40001', detail = 'reason=catalog_payload_changed';
  end if;
  return jsonb_build_object(
    'contract','catalog-active-category-writer-v1',
    'generationId',p_generation_id,'refreshRunId',p_refresh_run_id,
    'jobId',p_job_id,'leaseSequence',p_lease_sequence,
    'actionKind',p_action_kind,'writtenCategories',v_written,
    'visibilityEpoch',(v_lock ->> 'visibilityEpoch')::bigint
  );
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception 'active category identifiers are malformed'
    using errcode = '22023';
end
$function$;

revoke all on function public.norva_upsert_active_catalog_refresh_categories(
  uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,
  text,jsonb
) from public,anon,authenticated,service_role;
grant execute on function public.norva_upsert_active_catalog_refresh_categories(
  uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,
  text,jsonb
) to service_role;

-- One bounded active projector call owns the shared lock order
-- generation -> epoch -> payload row -> global catalog.  A transition-created
-- generation always writes its durable P payload and may only INSERT a missing
-- cloud_titles FK shell.  It never UPDATEs an A/shared shell, so compensation
-- restores A byte-for-byte by changing only the source head.
create or replace function public.norva_upsert_active_catalog_title_payloads(
  p_source_id uuid,
  p_user_id uuid,
  p_generation_id uuid,
  p_refresh_run_id uuid,
  p_job_id uuid,
  p_worker text,
  p_lease_sequence integer,
  p_head_revision bigint,
  p_config_revision bigint,
  p_source_visibility_epoch bigint,
  p_user_visibility_epoch bigint,
  p_titles jsonb
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_role text := coalesce(
    nullif(auth.jwt() ->> 'role', ''),
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('role', true), 'none'),
    ''
  );
  v_generation public.cloud_source_catalog_generations%rowtype;
  v_transition public.cloud_source_transitions%rowtype;
  v_job public.cloud_source_credential_transition_jobs%rowtype;
  v_transition_id uuid;
  v_head public.cloud_source_catalog_heads%rowtype;
  v_lifecycle public.cloud_source_lifecycle%rowtype;
  v_epoch bigint;
  v_transitional boolean;
  v_expected_count integer;
  v_written_count integer := 0;
  v_shell_count integer := 0;
  v_result jsonb;
  v_generation_revision bigint;
  v_transition_state text;
  v_action text;
  v_previous_context text := current_setting(
    'norva.catalog_candidate_title_write', true
  );
begin
  if v_role <> 'service_role'
     and not (v_role in ('', 'postgres') and session_user = 'postgres') then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if not public.norva_catalog_title_active_payload_indexes_ready() then
    raise exception 'active title payload index contract is not ready'
      using errcode = '55000', detail = 'reason=title_projection_index_drift';
  end if;
  if p_source_id is null or p_user_id is null or p_generation_id is null
     or p_head_revision is null or p_head_revision < 0
     or p_config_revision is null or p_config_revision < 0
     or p_source_visibility_epoch is null or p_source_visibility_epoch < 1
     or p_user_visibility_epoch is null or p_user_visibility_epoch < 1
     or p_titles is null or jsonb_typeof(p_titles) <> 'array'
     or jsonb_array_length(p_titles) > 500
     or octet_length(p_titles::text) > 2097152 then
    raise exception 'active title payload batch is invalid or exceeds bounds'
      using errcode = '22023';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_titles) item(value)
    where jsonb_typeof(item.value) <> 'object'
       or exists (
         select 1 from jsonb_object_keys(item.value) supplied(key)
         where supplied.key not in (
           'user_id','item_type','identity_key','identity_source',
           'provider_tmdb_id','provider_imdb_id','match_status','title',
           'original_title','release_year','poster_url','backdrop_url',
           'metadata','synced_at','version_languages'
         )
       )
       or coalesce(item.value ->> 'item_type', '') not in ('movie','series')
       or nullif(btrim(item.value ->> 'identity_key'), '') is null
       or length(item.value ->> 'identity_key') > 1200
       or coalesce(item.value ->> 'identity_source', '') not in (
         'provider_tmdb','provider_imdb','normalized'
       )
       or coalesce(item.value ->> 'match_status', '') not in (
         'provider_unverified','provider_verified','matched',
         'weak','unmatched','manual'
       )
       or nullif(btrim(item.value ->> 'title'), '') is null
       or length(item.value ->> 'title') > 1000
       or (item.value ? 'user_id'
         and item.value ->> 'user_id' is distinct from p_user_id::text)
       or jsonb_typeof(coalesce(item.value -> 'metadata', '{}'::jsonb))
          <> 'object'
       or (item.value ? 'version_languages'
         and jsonb_typeof(item.value -> 'version_languages') <> 'array')
  ) then
    raise exception 'active title payload contains an invalid row'
      using errcode = '22023';
  end if;
  if (
    select count(*)
    from jsonb_array_elements(p_titles) item(value)
  ) <> (
    select count(*)
    from (
      select distinct item.value ->> 'item_type',
        btrim(item.value ->> 'identity_key')
      from jsonb_array_elements(p_titles) item(value)
    ) unique_input
  ) then
    raise exception 'active title payload contains duplicate identities'
      using errcode = '22023';
  end if;

  -- A non-locking owner lookup chooses the branch; all authoritative locks then
  -- follow transition -> exact post-switch job -> generation -> user epoch.
  select generation.transition_id into v_transition_id
  from public.cloud_source_catalog_generations generation
  where generation.id = p_generation_id
    and generation.user_id = p_user_id
    and generation.source_id = p_source_id;
  if v_transition_id is not null then
    select transition.* into v_transition
    from public.cloud_source_transitions transition
    where transition.id = v_transition_id and transition.user_id = p_user_id
      and transition.old_source_id = p_source_id
      and transition.candidate_catalog_generation_id = p_generation_id
      and transition.state in ('committing','completed')
    for update;
    if not found then
      raise exception 'active transition title snapshot CAS failed'
        using errcode = '40001', detail = 'reason=credential_transition_changed';
    end if;
    v_transition_state := v_transition.state;
    if v_transition_state = 'committing' then
      if p_job_id is null or nullif(btrim(p_worker),'') is null
         or p_lease_sequence is null or p_lease_sequence < 1 then
        raise exception 'active title projector lease proof is required'
          using errcode = '22023';
      end if;
      select job.* into v_job
      from public.cloud_source_credential_transition_jobs job
      where job.id = p_job_id and job.transition_id = v_transition.id
        and job.user_id = p_user_id and job.source_id = p_source_id
        and job.catalog_generation_id = p_generation_id
        and job.job_kind = 'post_switch_verify'
        and job.state = 'processing' and job.lease_owner = p_worker
        and job.lease_sequence = p_lease_sequence and job.lease_until > now()
        and job.title_projection_refresh_run_id = p_refresh_run_id
      for update;
      if not found then
        raise exception 'active title projector job lease CAS failed'
          using errcode = '40001', detail = 'reason=credential_job_lease_changed';
      end if;
      if jsonb_array_length(p_titles) > 0 then
        if (
          select count(distinct item.value ->> 'item_type')
          from jsonb_array_elements(p_titles) item(value)
        ) <> 1 then
          raise exception 'active title payload batch crosses provider actions'
            using errcode = '22023';
        end if;
        select case min(item.value ->> 'item_type')
          when 'movie' then 'vod_streams' else 'series_streams' end
        into v_action
        from jsonb_array_elements(p_titles) item(value);
        perform public.norva_require_active_catalog_refresh_action(
          p_job_id,p_refresh_run_id,v_action,null
        );
      end if;
    elsif p_job_id is not null or p_worker is not null
       or p_lease_sequence is not null then
      raise exception 'terminal title projector cannot carry a job lease'
        using errcode = '22023';
    end if;
  elsif p_job_id is not null or p_worker is not null
     or p_lease_sequence is not null or p_refresh_run_id is not null then
    raise exception 'legacy active title payload cannot carry refresh proof'
      using errcode = '22023';
  end if;

  select generation.* into v_generation
  from public.cloud_source_catalog_generations generation
  where generation.id = p_generation_id
    and generation.user_id = p_user_id
    and generation.source_id = p_source_id
    and generation.state = 'active'
    and not generation.manifest_sealing
  for update;
  if not found then
    raise exception 'active title generation CAS failed'
      using errcode = '40001', detail = 'reason=catalog_generation_changed';
  end if;

  insert into public.cloud_user_catalog_visibility_epochs(
    user_id, visibility_epoch, updated_at
  ) values (p_user_id, 1, now())
  on conflict (user_id) do nothing;
  select epoch.visibility_epoch into v_epoch
  from public.cloud_user_catalog_visibility_epochs epoch
  where epoch.user_id = p_user_id
  for update;
  if v_epoch <> p_user_visibility_epoch then
    raise exception 'active title visibility CAS failed'
      using errcode = '40001', detail = 'reason=catalog_visibility_changed';
  end if;

  select head.* into v_head
  from public.cloud_source_catalog_heads head
  where head.source_id = p_source_id and head.user_id = p_user_id;
  select lifecycle.* into v_lifecycle
  from public.cloud_source_lifecycle lifecycle
  where lifecycle.source_id = p_source_id and lifecycle.user_id = p_user_id;
  if v_head.active_generation_id is distinct from p_generation_id
     or v_head.head_revision is distinct from p_head_revision
     or v_lifecycle.config_revision is distinct from p_config_revision
     or v_lifecycle.visibility_epoch is distinct from p_source_visibility_epoch
     or v_generation.config_revision is distinct from p_config_revision
     or not public.norva_source_catalog_visible_internal(
       p_source_id, p_user_id
     ) then
    raise exception 'active title source snapshot CAS failed'
      using errcode = '40001', detail = 'reason=catalog_generation_changed';
  end if;

  v_transitional := v_generation.transition_id is not null;
  if v_transitional then
    if p_refresh_run_id is null
       or v_generation.title_projection_refresh_run_id is distinct from
          p_refresh_run_id then
      raise exception 'active title refresh run CAS failed'
        using errcode = '40001', detail = 'reason=title_refresh_run_changed';
    end if;
    if v_generation.transition_id is distinct from v_transition.id
       or v_transition_state not in ('committing','completed') then
      raise exception 'active transition title snapshot CAS failed'
        using errcode = '40001', detail = 'reason=credential_transition_changed';
    end if;
  end if;

  create temporary table if not exists pg_temp.norva_active_title_payload_input (
    ordinal bigint not null,
    item_type text not null,
    identity_key text not null,
    identity_source text not null,
    provider_tmdb_id text,
    provider_imdb_id text,
    match_status text not null,
    title text not null,
    original_title text,
    release_year integer,
    poster_url text,
    backdrop_url text,
    catalog_metadata jsonb not null,
    visible_metadata jsonb not null,
    synced_at timestamptz not null,
    version_languages text[] not null,
    primary key (item_type, identity_key)
  ) on commit drop;
  truncate table pg_temp.norva_active_title_payload_input;
  insert into pg_temp.norva_active_title_payload_input (
    ordinal,item_type,identity_key,identity_source,provider_tmdb_id,
    provider_imdb_id,match_status,title,original_title,release_year,
    poster_url,backdrop_url,catalog_metadata,visible_metadata,synced_at,
    version_languages
  )
  select item.ordinality, btrim(row.item_type), btrim(row.identity_key),
    row.identity_source, nullif(btrim(row.provider_tmdb_id), ''),
    nullif(btrim(row.provider_imdb_id), ''), row.match_status,
    btrim(row.title), row.original_title, row.release_year,
    row.poster_url, row.backdrop_url, coalesce(row.metadata, '{}'::jsonb),
    case
      when nullif(btrim(row.provider_tmdb_id), '') is not null
       and nullif(btrim(row.provider_tmdb_id), '') !~ '^(tt)?0+$'
       and coalesce(row.metadata, '{}'::jsonb) <> '{}'::jsonb
        then '{}'::jsonb
      else coalesce(row.metadata, '{}'::jsonb)
    end,
    coalesce(row.synced_at, clock_timestamp()),
    coalesce(row.version_languages, '{}'::text[])
  from jsonb_array_elements(p_titles) with ordinality item(value, ordinality)
  cross join lateral jsonb_to_record(item.value) as row(
    user_id uuid,item_type text,identity_key text,identity_source text,
    provider_tmdb_id text,provider_imdb_id text,match_status text,title text,
    original_title text,release_year integer,poster_url text,
    backdrop_url text,metadata jsonb,synced_at timestamptz,
    version_languages text[]
  );
  select count(*)::integer into v_expected_count
  from pg_temp.norva_active_title_payload_input;

  if v_transitional then
    perform set_config(
      'norva.catalog_candidate_title_write',
      jsonb_build_object(
        'mode','active_transition_projection',
        'userId',p_user_id,'sourceId',p_source_id,
        'generationId',p_generation_id,'headRevision',p_head_revision,
        'configRevision',p_config_revision,
        'sourceVisibilityEpoch',p_source_visibility_epoch,
        'userVisibilityEpoch',p_user_visibility_epoch,
        'refreshRunId',p_refresh_run_id
      )::text,
      true
    );
    begin
      with inserted as (
        insert into public.cloud_titles (
          user_id,item_type,identity_key,identity_source,provider_tmdb_id,
          provider_imdb_id,match_status,title,original_title,release_year,
          poster_url,backdrop_url,metadata,synced_at,version_languages,
          candidate_shell_token
        )
        select p_user_id,input.item_type,input.identity_key,
          input.identity_source,input.provider_tmdb_id,input.provider_imdb_id,
          input.match_status,input.title,input.original_title,
          input.release_year,input.poster_url,input.backdrop_url,
          input.visible_metadata,input.synced_at,input.version_languages,
          gen_random_uuid()
        from pg_temp.norva_active_title_payload_input input
        on conflict (user_id,item_type,identity_key) do nothing
        returning id
      ) select count(*)::integer into v_shell_count from inserted;

      with resolved as materialized (
        select input.*, shell.id as title_id,
          shell.created_at as catalog_created_at,
          shell.candidate_shell_token is not null as shell_created,
          shell.candidate_shell_token as shell_token,
          case when input.catalog_metadata ? 'categoryName'
            then input.catalog_metadata ->> 'categoryName' end
            as genre_category,
          input.catalog_metadata #> '{tmdb,genres}' as genre_payload,
          public.safe_numeric(
            input.catalog_metadata #>> '{tmdb,vote_average}'
          ) as rating_num
        from pg_temp.norva_active_title_payload_input input
        join public.cloud_titles shell
          on shell.user_id = p_user_id
         and shell.item_type = input.item_type
         and shell.identity_key = input.identity_key
      ), upserted as (
        insert into public.cloud_source_catalog_generation_candidate_titles (
          generation_id,title_id,transition_id,user_id,source_id,item_type,
          identity_key,identity_source,provider_tmdb_id,provider_imdb_id,
          match_status,title,original_title,release_year,poster_url,
          backdrop_url,metadata,catalog_metadata,genre_category,genre_payload,
          genre_buckets,rating_num,post_switch_refreshed,synced_at,
          catalog_created_at,shell_created,shell_token,updated_at
        )
        select p_generation_id,resolved.title_id,v_generation.transition_id,
          p_user_id,p_source_id,resolved.item_type,resolved.identity_key,
          resolved.identity_source,resolved.provider_tmdb_id,
          resolved.provider_imdb_id,resolved.match_status,resolved.title,
          resolved.original_title,resolved.release_year,resolved.poster_url,
          resolved.backdrop_url,resolved.visible_metadata,
          resolved.catalog_metadata,resolved.genre_category,
          resolved.genre_payload,public.norva_classify_buckets(
            resolved.genre_category,resolved.genre_payload
          ),resolved.rating_num,(v_transition_state = 'completed'),
          resolved.synced_at,
          resolved.catalog_created_at,resolved.shell_created,
          resolved.shell_token,clock_timestamp()
        from resolved
        on conflict (generation_id,item_type,identity_key) do update set
          identity_source=excluded.identity_source,
          provider_tmdb_id=excluded.provider_tmdb_id,
          provider_imdb_id=excluded.provider_imdb_id,
          match_status=excluded.match_status,title=excluded.title,
          original_title=excluded.original_title,
          release_year=excluded.release_year,poster_url=excluded.poster_url,
          backdrop_url=excluded.backdrop_url,metadata=excluded.metadata,
          catalog_metadata=excluded.catalog_metadata,
          genre_category=excluded.genre_category,
          genre_payload=excluded.genre_payload,
          genre_buckets=excluded.genre_buckets,rating_num=excluded.rating_num,
          post_switch_refreshed=excluded.post_switch_refreshed,
          synced_at=excluded.synced_at,
          catalog_created_at=excluded.catalog_created_at,
          shell_created=
            public.cloud_source_catalog_generation_candidate_titles.shell_created
            or excluded.shell_created,
          shell_token=case when
            public.cloud_source_catalog_generation_candidate_titles.shell_created
            then public.cloud_source_catalog_generation_candidate_titles.shell_token
            else excluded.shell_token end,
          updated_at=clock_timestamp()
        returning title_id
      ) select count(*)::integer into v_written_count from upserted;
      if v_written_count <> v_expected_count then
        raise exception 'active transition title shell visibility race'
          using errcode = '40001',
            detail = 'reason=candidate_title_shell_not_visible';
      end if;
    exception when others then
      perform set_config(
        'norva.catalog_candidate_title_write',
        coalesce(v_previous_context, ''), true
      );
      raise;
    end;
    perform set_config(
      'norva.catalog_candidate_title_write',
      coalesce(v_previous_context, ''), true
    );
  else
    with upserted as (
      insert into public.cloud_titles as title (
        user_id,item_type,identity_key,identity_source,provider_tmdb_id,
        provider_imdb_id,match_status,title,original_title,release_year,
        poster_url,backdrop_url,metadata,synced_at,version_languages
      )
      select p_user_id,input.item_type,input.identity_key,
        input.identity_source,input.provider_tmdb_id,input.provider_imdb_id,
        input.match_status,input.title,input.original_title,input.release_year,
        input.poster_url,input.backdrop_url,input.catalog_metadata,
        input.synced_at,input.version_languages
      from pg_temp.norva_active_title_payload_input input
      on conflict (user_id,item_type,identity_key) do update set
        identity_source=excluded.identity_source,
        provider_tmdb_id=excluded.provider_tmdb_id,
        provider_imdb_id=excluded.provider_imdb_id,
        match_status=excluded.match_status,title=excluded.title,
        original_title=excluded.original_title,
        release_year=excluded.release_year,poster_url=excluded.poster_url,
        backdrop_url=excluded.backdrop_url,metadata=excluded.metadata,
        synced_at=excluded.synced_at,
        version_languages=excluded.version_languages
      returning id
    ) select count(*)::integer into v_written_count from upserted;
  end if;

  if v_written_count <> v_expected_count then
    raise exception 'active title payload result count mismatch'
      using errcode = '40001', detail = 'reason=catalog_payload_changed';
  end if;

  -- A COMMITTING generation is compensable and must not touch the global
  -- overlay.  After terminal success, publish the exact current P payload in
  -- the same generation -> epoch -> P -> catalog lock order.  The P rows are
  -- still locked by the upsert above, so an older promotion page can neither
  -- overwrite a newer projector result nor omit a post-snapshot title.
  if v_transitional
     and v_transition_state = 'completed' then
    insert into public.catalog_titles (
      item_type,provider_tmdb_id,title,original_title,release_year,
      poster_url,backdrop_url,metadata,enriched_at,updated_at
    )
    select distinct on (projection.item_type,projection.provider_tmdb_id)
      projection.item_type,projection.provider_tmdb_id,projection.title,
      projection.original_title,projection.release_year,
      projection.poster_url,projection.backdrop_url,
      projection.catalog_metadata,clock_timestamp(),clock_timestamp()
    from pg_temp.norva_active_title_payload_input input
    join public.cloud_source_catalog_generation_candidate_titles projection
      on projection.generation_id = p_generation_id
     and projection.item_type = input.item_type
     and projection.identity_key = input.identity_key
    where projection.provider_tmdb_id is not null
      and projection.provider_tmdb_id <> ''
      and projection.provider_tmdb_id !~ '^(tt)?0+$'
      and projection.catalog_metadata <> '{}'::jsonb
    order by projection.item_type,projection.provider_tmdb_id,
      projection.updated_at desc,projection.title_id
    on conflict (item_type,provider_tmdb_id) do update set
      title=excluded.title,original_title=excluded.original_title,
      release_year=excluded.release_year,poster_url=excluded.poster_url,
      backdrop_url=excluded.backdrop_url,metadata=excluded.metadata,
      updated_at=excluded.updated_at;
  end if;
  if v_written_count > 0 then
    v_epoch := public.norva_bump_user_catalog_visibility_epoch(p_user_id);
    if v_transition_state = 'committing' then
      perform public.norva_adopt_active_catalog_refresh_epoch(
        p_job_id,p_refresh_run_id,p_user_visibility_epoch,v_epoch
      );
    end if;
    delete from public.cloud_catalog_facet_summary where user_id = p_user_id;
  end if;
  select generation.revision into v_generation_revision
  from public.cloud_source_catalog_generations generation
  where generation.id = p_generation_id;

  if v_transitional then
    select jsonb_build_object(
      'contract','catalog-title-active-payload-writer-v1',
      'storageKind','projection','payloadGenerationId',p_generation_id,
      'refreshRunId',p_refresh_run_id,
      'postSwitchConfirmationRequired',(v_transition_state = 'committing'),
      'headRevision',p_head_revision,'configRevision',p_config_revision,
      'sourceVisibilityEpoch',p_source_visibility_epoch,
      'visibilityEpoch',v_epoch,'generationRevision',v_generation_revision,
      'insertedTitleShells',v_shell_count,
      'writtenTitles',v_written_count,
      'titles',coalesce(jsonb_agg(jsonb_build_object(
        'itemType',input.item_type,'identityKey',input.identity_key,
        'titleId',projection.title_id,'storageKind','projection',
        'payloadGenerationId',p_generation_id,
        'payloadUpdatedAt',projection.updated_at
      ) order by input.ordinal),'[]'::jsonb)
    ) into v_result
    from pg_temp.norva_active_title_payload_input input
    join public.cloud_source_catalog_generation_candidate_titles projection
      on projection.generation_id = p_generation_id
     and projection.item_type = input.item_type
     and projection.identity_key = input.identity_key;
  else
    select jsonb_build_object(
      'contract','catalog-title-active-payload-writer-v1',
      'storageKind','global','payloadGenerationId',null,
      'refreshRunId',p_refresh_run_id,
      'headRevision',p_head_revision,'configRevision',p_config_revision,
      'sourceVisibilityEpoch',p_source_visibility_epoch,
      'visibilityEpoch',v_epoch,'generationRevision',v_generation_revision,
      'insertedTitleShells',0,
      'writtenTitles',v_written_count,
      'titles',coalesce(jsonb_agg(jsonb_build_object(
        'itemType',input.item_type,'identityKey',input.identity_key,
        'titleId',title.id,'storageKind','global',
        'payloadGenerationId',null,'payloadUpdatedAt',title.updated_at
      ) order by input.ordinal),'[]'::jsonb)
    ) into v_result
    from pg_temp.norva_active_title_payload_input input
    join public.cloud_titles title
      on title.user_id = p_user_id and title.item_type = input.item_type
     and title.identity_key = input.identity_key;
  end if;
  if jsonb_array_length(v_result -> 'titles') <> v_expected_count
     or octet_length(v_result::text) > 1048576 then
    raise exception 'active title payload response is incomplete or oversized'
      using errcode = '54000';
  end if;
  return v_result;
end
$function$;

revoke all on function public.norva_upsert_active_catalog_title_payloads(
  uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,jsonb
) from public,anon,authenticated,service_role;
grant execute on function public.norva_upsert_active_catalog_title_payloads(
  uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,jsonb
) to service_role;

-- Post-switch variant materialization is one lease-fenced write.  Direct table
-- writes cannot stamp projection_refresh_run_id because the row guard validates
-- the transaction-local context against this exact job lease.  A reclaimed
-- worker therefore cannot make stale staging variants look refreshed.
create or replace function public.norva_upsert_active_catalog_title_variants(
  p_source_id uuid,
  p_user_id uuid,
  p_generation_id uuid,
  p_refresh_run_id uuid,
  p_job_id uuid,
  p_worker text,
  p_lease_sequence integer,
  p_head_revision bigint,
  p_config_revision bigint,
  p_source_visibility_epoch bigint,
  p_user_visibility_epoch bigint,
  p_catalog_version bigint,
  p_variants jsonb
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_transition public.cloud_source_transitions%rowtype;
  v_job public.cloud_source_credential_transition_jobs%rowtype;
  v_generation public.cloud_source_catalog_generations%rowtype;
  v_epoch bigint;
  v_expected integer;
  v_written integer;
  v_previous_context text := current_setting(
    'norva.catalog_active_variant_refresh', true
  );
  v_result jsonb;
  v_action text;
begin
  perform public.norva_credential_require_service_role();
  if p_refresh_run_id is null or p_job_id is null
     or nullif(btrim(p_worker),'') is null or length(p_worker) > 160
     or p_lease_sequence is null or p_lease_sequence < 1
     or p_catalog_version is null or p_catalog_version < 0
     or p_variants is null or jsonb_typeof(p_variants) <> 'array'
     or jsonb_array_length(p_variants) > 500
     or octet_length(p_variants::text) > 4194304
     or exists (
       select 1
       from jsonb_array_elements(p_variants) row(value)
       where jsonb_typeof(row.value) <> 'object'
          or exists (
            select 1 from jsonb_object_keys(row.value) supplied(key)
            where supplied.key not in (
              'title_id','media_item_id','item_type','external_id','raw_title',
              'label','language','quality','resolution','container_extension',
              'poster_url','playback_hint','codec_profile',
              'compatibility_tier','playback_cost_score',
              'last_observed_ttff_ms','observed_success_rate','metadata'
            )
          )
          or nullif(row.value ->> 'title_id','') is null
          or nullif(row.value ->> 'media_item_id','') is null
          or row.value ->> 'item_type' not in ('movie','series')
          or nullif(btrim(row.value ->> 'external_id'),'') is null
          or nullif(btrim(row.value ->> 'raw_title'),'') is null
          or coalesce(row.value ->> 'compatibility_tier','unknown') not in (
            'direct','remux','audio_transcode','video_transcode','unknown'
          )
          or jsonb_typeof(coalesce(
            row.value -> 'playback_hint','{}'::jsonb
          )) <> 'object'
          or jsonb_typeof(coalesce(
            row.value -> 'codec_profile','{}'::jsonb
          )) <> 'object'
          or jsonb_typeof(coalesce(row.value -> 'metadata','{}'::jsonb))
             <> 'object'
     ) then
    raise exception 'active title variant batch is invalid or oversized'
      using errcode = '22023';
  end if;
  begin
    perform (row.value ->> 'title_id')::uuid,
      (row.value ->> 'media_item_id')::uuid
    from jsonb_array_elements(p_variants) row(value);
  exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'active title variant identifiers are malformed'
      using errcode = '22023';
  end;
  select count(*)::integer into v_expected
  from jsonb_array_elements(p_variants);
  if v_expected is distinct from (
    select count(*)::integer
    from (
      select distinct row.value ->> 'item_type',row.value ->> 'external_id'
      from jsonb_array_elements(p_variants) row(value)
    ) unique_variant
  ) then
    raise exception 'active title variant batch contains duplicates'
      using errcode = '22023';
  end if;
  if v_expected > 0 then
    if (
      select count(distinct row.value ->> 'item_type')
      from jsonb_array_elements(p_variants) row(value)
    ) <> 1 then
      raise exception 'active title variant batch crosses provider actions'
        using errcode = '22023';
    end if;
    select case min(row.value ->> 'item_type')
      when 'movie' then 'vod_streams' else 'series_streams' end
    into v_action
    from jsonb_array_elements(p_variants) row(value);
  end if;

  select transition.* into v_transition
  from public.cloud_source_transitions transition
  where transition.user_id = p_user_id
    and transition.old_source_id = p_source_id
    and transition.candidate_catalog_generation_id = p_generation_id
    and transition.state = 'committing'
  for update;
  if not found then
    raise exception 'active title variant transition CAS failed'
      using errcode = '40001', detail = 'reason=credential_transition_changed';
  end if;
  select job.* into v_job
  from public.cloud_source_credential_transition_jobs job
  where job.id = p_job_id and job.transition_id = v_transition.id
    and job.user_id = p_user_id and job.source_id = p_source_id
    and job.catalog_generation_id = p_generation_id
    and job.job_kind = 'post_switch_verify'
    and job.state = 'processing' and job.lease_owner = p_worker
    and job.lease_sequence = p_lease_sequence and job.lease_until > now()
    and job.title_projection_refresh_run_id = p_refresh_run_id
  for update;
  if not found then
    raise exception 'active title variant job lease CAS failed'
      using errcode = '40001', detail = 'reason=credential_job_lease_changed';
  end if;
  if v_expected > 0 then
    perform public.norva_require_active_catalog_refresh_action(
      p_job_id,p_refresh_run_id,v_action,p_catalog_version
    );
  end if;
  select generation.* into v_generation
  from public.cloud_source_catalog_generations generation
  where generation.id = p_generation_id
    and generation.user_id = p_user_id and generation.source_id = p_source_id
    and generation.transition_id = v_transition.id
    and generation.state = 'active' and not generation.manifest_sealing
    and generation.title_projection_refresh_run_id = p_refresh_run_id
  for update;
  if not found then
    raise exception 'active title variant generation CAS failed'
      using errcode = '40001', detail = 'reason=catalog_generation_changed';
  end if;
  insert into public.cloud_user_catalog_visibility_epochs(
    user_id,visibility_epoch,updated_at
  ) values (p_user_id,1,now()) on conflict (user_id) do nothing;
  select epoch.visibility_epoch into v_epoch
  from public.cloud_user_catalog_visibility_epochs epoch
  where epoch.user_id = p_user_id for update;
  if v_epoch is distinct from p_user_visibility_epoch
     or v_generation.config_revision is distinct from p_config_revision
     or not exists (
       select 1
       from public.cloud_source_catalog_heads head
       join public.cloud_source_lifecycle lifecycle
         on lifecycle.source_id = head.source_id
        and lifecycle.user_id = head.user_id
       where head.source_id = p_source_id and head.user_id = p_user_id
         and head.active_generation_id = p_generation_id
         and head.head_revision = p_head_revision
         and lifecycle.config_revision = p_config_revision
         and lifecycle.visibility_epoch = p_source_visibility_epoch
         and public.norva_source_catalog_visible_internal(
           p_source_id,p_user_id
         )
     ) then
    raise exception 'active title variant snapshot CAS failed'
      using errcode = '40001', detail = 'reason=catalog_generation_changed';
  end if;

  create temporary table if not exists
    pg_temp.norva_active_title_variant_input (
      ordinal bigint not null,
      title_id uuid not null,
      media_item_id uuid not null,
      item_type text not null,
      external_id text not null,
      raw_title text not null,
      label text,language text,quality text,resolution text,
      container_extension text,poster_url text,
      playback_hint jsonb not null,codec_profile jsonb not null,
      compatibility_tier text not null,playback_cost_score integer not null,
      last_observed_ttff_ms integer,observed_success_rate numeric,
      metadata jsonb not null,
      primary key (item_type,external_id)
    ) on commit drop;
  truncate table pg_temp.norva_active_title_variant_input;
  insert into pg_temp.norva_active_title_variant_input
  select input.ordinality,row.title_id,row.media_item_id,row.item_type,
    btrim(row.external_id),btrim(row.raw_title),row.label,row.language,
    row.quality,row.resolution,row.container_extension,row.poster_url,
    coalesce(row.playback_hint,'{}'::jsonb),
    coalesce(row.codec_profile,'{}'::jsonb),
    coalesce(row.compatibility_tier,'unknown'),
    coalesce(row.playback_cost_score,500),row.last_observed_ttff_ms,
    row.observed_success_rate,coalesce(row.metadata,'{}'::jsonb)
  from jsonb_array_elements(p_variants) with ordinality input(value,ordinality)
  cross join lateral jsonb_to_record(input.value) as row(
    title_id uuid,media_item_id uuid,item_type text,external_id text,
    raw_title text,label text,language text,quality text,resolution text,
    container_extension text,poster_url text,playback_hint jsonb,
    codec_profile jsonb,compatibility_tier text,playback_cost_score integer,
    last_observed_ttff_ms integer,observed_success_rate numeric,metadata jsonb
  );
  if exists (
    select 1
    from pg_temp.norva_active_title_variant_input input
    left join public.cloud_source_catalog_generation_candidate_titles projection
      on projection.generation_id = p_generation_id
     and projection.title_id = input.title_id
     and projection.user_id = p_user_id and projection.source_id = p_source_id
     and projection.item_type = input.item_type
    left join public.cloud_media_items item
      on item.id = input.media_item_id and item.generation_id = p_generation_id
     and item.user_id = p_user_id and item.source_id = p_source_id
     and item.item_type = input.item_type
     and item.external_id = input.external_id
     and item.catalog_version = p_catalog_version
     and item.projection_refresh_run_id = p_refresh_run_id
    where projection.title_id is null or item.id is null
  ) then
    raise exception 'active title variant parent/version proof mismatch'
      using errcode = '40001', detail = 'reason=catalog_inventory_count_changed';
  end if;
  perform set_config(
    'norva.catalog_active_variant_refresh',
    jsonb_build_object(
      'transitionId',v_transition.id,'userId',p_user_id,
      'sourceId',p_source_id,'generationId',p_generation_id,
      'refreshRunId',p_refresh_run_id,'jobId',p_job_id,
      'worker',p_worker,'leaseSequence',p_lease_sequence
    )::text,true
  );
  begin
    with upserted as (
      insert into public.cloud_title_variants as variant (
        user_id,title_id,source_id,media_item_id,item_type,external_id,
        raw_title,label,language,quality,resolution,container_extension,
        poster_url,playback_hint,codec_profile,compatibility_tier,
        playback_cost_score,last_observed_ttff_ms,observed_success_rate,
        metadata,generation_id,projection_refresh_run_id,
        write_head_revision,write_config_revision,
        write_source_visibility_epoch,write_user_visibility_epoch
      )
      select p_user_id,input.title_id,p_source_id,input.media_item_id,
        input.item_type,input.external_id,input.raw_title,input.label,
        input.language,input.quality,input.resolution,input.container_extension,
        input.poster_url,input.playback_hint,input.codec_profile,
        input.compatibility_tier,input.playback_cost_score,
        input.last_observed_ttff_ms,input.observed_success_rate,input.metadata,
        p_generation_id,p_refresh_run_id,p_head_revision,p_config_revision,
        p_source_visibility_epoch,p_user_visibility_epoch
      from pg_temp.norva_active_title_variant_input input
      on conflict (source_id,generation_id,item_type,external_id) do update set
        title_id=excluded.title_id,media_item_id=excluded.media_item_id,
        raw_title=excluded.raw_title,label=excluded.label,
        language=excluded.language,quality=excluded.quality,
        resolution=excluded.resolution,
        container_extension=excluded.container_extension,
        poster_url=excluded.poster_url,playback_hint=excluded.playback_hint,
        codec_profile=excluded.codec_profile,
        compatibility_tier=excluded.compatibility_tier,
        playback_cost_score=excluded.playback_cost_score,
        last_observed_ttff_ms=excluded.last_observed_ttff_ms,
        observed_success_rate=excluded.observed_success_rate,
        metadata=excluded.metadata,
        projection_refresh_run_id=excluded.projection_refresh_run_id,
        write_head_revision=p_head_revision,
        write_config_revision=p_config_revision,
        write_source_visibility_epoch=p_source_visibility_epoch,
        write_user_visibility_epoch=p_user_visibility_epoch
      returning id,title_id,item_type,external_id,updated_at
    ) select count(*)::integer into v_written from upserted;
  exception when others then
    perform set_config(
      'norva.catalog_active_variant_refresh',coalesce(v_previous_context,''),true
    );
    raise;
  end;
  perform set_config(
    'norva.catalog_active_variant_refresh',coalesce(v_previous_context,''),true
  );
  if v_written <> v_expected then
    raise exception 'active title variant write count mismatch'
      using errcode = '40001', detail = 'reason=catalog_payload_changed';
  end if;
  select epoch.visibility_epoch into v_epoch
  from public.cloud_user_catalog_visibility_epochs epoch
  where epoch.user_id = p_user_id;
  if v_epoch is distinct from p_user_visibility_epoch then
    perform public.norva_adopt_active_catalog_refresh_epoch(
      p_job_id,p_refresh_run_id,p_user_visibility_epoch,v_epoch
    );
  end if;
  select jsonb_build_object(
    'contract','catalog-title-active-variant-writer-v1',
    'generationId',p_generation_id,'refreshRunId',p_refresh_run_id,
    'jobId',p_job_id,'leaseSequence',p_lease_sequence,
    'catalogVersion',p_catalog_version,'visibilityEpoch',v_epoch,
    'writtenVariants',v_written,
    'variants',coalesce(jsonb_agg(jsonb_build_object(
      'variantId',variant.id,'titleId',variant.title_id,
      'itemType',variant.item_type,'externalId',variant.external_id,
      'updatedAt',variant.updated_at
    ) order by input.ordinal),'[]'::jsonb)
  ) into v_result
  from pg_temp.norva_active_title_variant_input input
  join public.cloud_title_variants variant
    on variant.source_id = p_source_id
   and variant.generation_id = p_generation_id
   and variant.item_type = input.item_type
   and variant.external_id = input.external_id
   and variant.projection_refresh_run_id = p_refresh_run_id;
  if jsonb_array_length(v_result -> 'variants') <> v_expected
     or octet_length(v_result::text) > 1048576 then
    raise exception 'active title variant response is incomplete or oversized'
      using errcode = '54000';
  end if;
  return v_result;
end
$function$;

revoke all on function public.norva_upsert_active_catalog_title_variants(
  uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,
  bigint,jsonb
) from public,anon,authenticated,service_role;
grant execute on function public.norva_upsert_active_catalog_title_variants(
  uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,
  bigint,jsonb
) to service_role;

-- Live logical channels and concrete streams are one lease-fenced
-- materialization unit.  Both layers carry the run marker; no direct live
-- write can be certified after a lease reclaim.
create or replace function public.norva_upsert_active_catalog_live_materialization(
  p_source_id uuid,
  p_user_id uuid,
  p_generation_id uuid,
  p_refresh_run_id uuid,
  p_job_id uuid,
  p_worker text,
  p_lease_sequence integer,
  p_head_revision bigint,
  p_config_revision bigint,
  p_source_visibility_epoch bigint,
  p_user_visibility_epoch bigint,
  p_catalog_version bigint,
  p_channels jsonb,
  p_variants jsonb
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_lock jsonb;
  v_transition_id uuid;
  v_previous_context text := current_setting(
    'norva.catalog_active_variant_refresh', true
  );
  v_expected_channels integer;
  v_expected_variants integer;
  v_written_channels integer;
  v_written_variants integer;
  v_epoch bigint;
begin
  perform public.norva_credential_require_service_role();
  if p_catalog_version is null or p_catalog_version < 0
     or p_channels is null or jsonb_typeof(p_channels) <> 'array'
     or p_variants is null or jsonb_typeof(p_variants) <> 'array'
     or jsonb_array_length(p_channels) > 500
     or jsonb_array_length(p_variants) > 500
     or octet_length(p_channels::text) + octet_length(p_variants::text)
          > 4194304
     or exists (
       select 1 from jsonb_array_elements(p_channels) channel(value)
       where jsonb_typeof(channel.value) <> 'object'
          or exists (
            select 1 from jsonb_object_keys(channel.value) supplied(key)
            where supplied.key not in (
              'logical_id','logical_key','title','lcn','section','category_id',
              'category_name','poster_url','stream_icon','default_stream_id',
              'variant_count','default_variant','variant_preview',
              'playback_hint','metadata','synced_at'
            )
          )
          or nullif(btrim(channel.value ->> 'logical_id'),'') is null
          or nullif(btrim(channel.value ->> 'logical_key'),'') is null
          or nullif(btrim(channel.value ->> 'title'),'') is null
          or jsonb_typeof(coalesce(
            channel.value -> 'default_variant','{}'::jsonb
          )) <> 'object'
          or jsonb_typeof(coalesce(
            channel.value -> 'variant_preview','[]'::jsonb
          )) <> 'array'
          or jsonb_typeof(coalesce(
            channel.value -> 'playback_hint','{}'::jsonb
          )) <> 'object'
          or jsonb_typeof(coalesce(channel.value -> 'metadata','{}'::jsonb))
             <> 'object'
     )
     or exists (
       select 1 from jsonb_array_elements(p_variants) variant(value)
       where jsonb_typeof(variant.value) <> 'object'
          or exists (
            select 1 from jsonb_object_keys(variant.value) supplied(key)
            where supplied.key not in (
              'logical_id','media_item_id','stream_id','external_id','label',
              'rank','health_rank','title','raw_title','category_id',
              'category_name','poster_url','stream_icon','playback_hint',
              'metadata','container_extension','synced_at'
            )
          )
          or nullif(btrim(variant.value ->> 'logical_id'),'') is null
          or nullif(variant.value ->> 'media_item_id','') is null
          or nullif(btrim(variant.value ->> 'stream_id'),'') is null
          or nullif(btrim(variant.value ->> 'external_id'),'') is null
          or nullif(btrim(variant.value ->> 'title'),'') is null
          or jsonb_typeof(coalesce(
            variant.value -> 'playback_hint','{}'::jsonb
          )) <> 'object'
          or jsonb_typeof(coalesce(variant.value -> 'metadata','{}'::jsonb))
             <> 'object'
     ) then
    raise exception 'active live materialization batch is invalid or oversized'
      using errcode = '22023';
  end if;
  begin
    perform (variant.value ->> 'media_item_id')::uuid
    from jsonb_array_elements(p_variants) variant(value);
  exception when invalid_text_representation then
    raise exception 'active live media item identifier is malformed'
      using errcode = '22023';
  end;
  select count(*)::integer into v_expected_channels
  from jsonb_array_elements(p_channels);
  select count(*)::integer into v_expected_variants
  from jsonb_array_elements(p_variants);
  if v_expected_channels is distinct from (
       select count(*)::integer from (
         select distinct btrim(channel.value ->> 'logical_id')
         from jsonb_array_elements(p_channels) channel(value)
       ) unique_channel
     )
     or v_expected_variants is distinct from (
       select count(*)::integer from (
         select distinct btrim(variant.value ->> 'logical_id'),
           btrim(variant.value ->> 'stream_id'),
           coalesce(nullif(btrim(variant.value ->> 'label'),''),'HD')
         from jsonb_array_elements(p_variants) variant(value)
       ) unique_variant
     ) then
    raise exception 'active live materialization batch contains duplicates'
      using errcode = '22023';
  end if;
  v_lock := public.norva_lock_active_catalog_refresh_lease(
    p_source_id,p_user_id,p_generation_id,p_refresh_run_id,p_job_id,
    p_worker,p_lease_sequence,p_head_revision,p_config_revision,
    p_source_visibility_epoch,p_user_visibility_epoch
  );
  v_transition_id := (v_lock ->> 'transitionId')::uuid;
  perform public.norva_require_active_catalog_refresh_action(
    p_job_id,p_refresh_run_id,'live_streams',p_catalog_version
  );

  create temporary table if not exists pg_temp.norva_active_live_channel_input (
    logical_id text primary key,logical_key text not null,title text not null,
    lcn integer,section text not null,category_id text not null,
    category_name text not null,poster_url text,stream_icon text,
    default_stream_id text,variant_count integer not null,
    default_variant jsonb not null,variant_preview jsonb not null,
    playback_hint jsonb not null,metadata jsonb not null,
    synced_at timestamptz not null
  ) on commit drop;
  truncate table pg_temp.norva_active_live_channel_input;
  insert into pg_temp.norva_active_live_channel_input
  select btrim(row.logical_id),btrim(row.logical_key),btrim(row.title),row.lcn,
    coalesce(nullif(btrim(row.section),''),'other'),
    coalesce(nullif(btrim(row.category_id),''),'uncategorized'),
    coalesce(nullif(btrim(row.category_name),''),'Uncategorized'),
    row.poster_url,row.stream_icon,row.default_stream_id,
    coalesce(row.variant_count,0),coalesce(row.default_variant,'{}'::jsonb),
    coalesce(row.variant_preview,'[]'::jsonb),
    coalesce(row.playback_hint,'{}'::jsonb),
    coalesce(row.metadata,'{}'::jsonb),
    coalesce(row.synced_at,clock_timestamp())
  from jsonb_to_recordset(p_channels) row(
    logical_id text,logical_key text,title text,lcn integer,section text,
    category_id text,category_name text,poster_url text,stream_icon text,
    default_stream_id text,variant_count integer,default_variant jsonb,
    variant_preview jsonb,playback_hint jsonb,metadata jsonb,
    synced_at timestamptz
  );
  create temporary table if not exists pg_temp.norva_active_live_variant_input (
    logical_id text not null,media_item_id uuid not null,stream_id text not null,
    external_id text not null,label text not null,rank integer not null,
    health_rank integer not null,title text not null,raw_title text,
    category_id text,category_name text,poster_url text,stream_icon text,
    playback_hint jsonb not null,metadata jsonb not null,
    container_extension text,synced_at timestamptz not null,
    primary key (logical_id,stream_id,label)
  ) on commit drop;
  truncate table pg_temp.norva_active_live_variant_input;
  insert into pg_temp.norva_active_live_variant_input
  select btrim(row.logical_id),row.media_item_id,btrim(row.stream_id),
    btrim(row.external_id),coalesce(nullif(btrim(row.label),''),'HD'),
    coalesce(row.rank,2),coalesce(row.health_rank,1),btrim(row.title),
    row.raw_title,row.category_id,row.category_name,row.poster_url,
    row.stream_icon,coalesce(row.playback_hint,'{}'::jsonb),
    coalesce(row.metadata,'{}'::jsonb),row.container_extension,
    coalesce(row.synced_at,clock_timestamp())
  from jsonb_to_recordset(p_variants) row(
    logical_id text,media_item_id uuid,stream_id text,external_id text,
    label text,rank integer,health_rank integer,title text,raw_title text,
    category_id text,category_name text,poster_url text,stream_icon text,
    playback_hint jsonb,metadata jsonb,container_extension text,
    synced_at timestamptz
  );
  if exists (
    select 1
    from pg_temp.norva_active_live_variant_input input
    left join public.cloud_media_items item
      on item.id = input.media_item_id and item.user_id = p_user_id
     and item.source_id = p_source_id
     and item.generation_id = p_generation_id and item.item_type = 'live'
     and item.external_id = input.external_id
     and item.catalog_version = p_catalog_version
     and item.projection_refresh_run_id = p_refresh_run_id
    where item.id is null
  ) then
    raise exception 'active live media/version proof mismatch'
      using errcode = '40001', detail = 'reason=catalog_inventory_count_changed';
  end if;
  perform set_config(
    'norva.catalog_active_variant_refresh',
    jsonb_build_object(
      'transitionId',v_transition_id,'userId',p_user_id,
      'sourceId',p_source_id,'generationId',p_generation_id,
      'refreshRunId',p_refresh_run_id,'jobId',p_job_id,
      'worker',p_worker,'leaseSequence',p_lease_sequence
    )::text,true
  );
  begin
    with upserted as (
      insert into public.cloud_live_logical_channels as channel (
        user_id,source_id,logical_id,logical_key,title,lcn,section,
        category_id,category_name,poster_url,stream_icon,default_stream_id,
        variant_count,default_variant,variant_preview,playback_hint,metadata,
        synced_at,generation_id,projection_refresh_run_id,
        write_head_revision,write_config_revision,
        write_source_visibility_epoch,write_user_visibility_epoch
      )
      select p_user_id,p_source_id,input.logical_id,input.logical_key,
        input.title,input.lcn,input.section,input.category_id,
        input.category_name,input.poster_url,input.stream_icon,
        null,0,'{}'::jsonb,'[]'::jsonb,
        input.playback_hint,input.metadata,input.synced_at,
        p_generation_id,p_refresh_run_id,p_head_revision,p_config_revision,
        p_source_visibility_epoch,p_user_visibility_epoch
      from pg_temp.norva_active_live_channel_input input
      on conflict (source_id,generation_id,logical_id) do update set
        logical_key=excluded.logical_key,title=excluded.title,lcn=excluded.lcn,
        section=excluded.section,category_id=excluded.category_id,
        category_name=excluded.category_name,poster_url=excluded.poster_url,
        stream_icon=excluded.stream_icon,
        default_stream_id=excluded.default_stream_id,
        variant_count=excluded.variant_count,
        default_variant=excluded.default_variant,
        variant_preview=excluded.variant_preview,
        playback_hint=excluded.playback_hint,metadata=excluded.metadata,
        synced_at=excluded.synced_at,
        projection_refresh_run_id=excluded.projection_refresh_run_id,
        write_head_revision=p_head_revision,
        write_config_revision=p_config_revision,
        write_source_visibility_epoch=p_source_visibility_epoch,
        write_user_visibility_epoch=p_user_visibility_epoch
      returning id
    ) select count(*)::integer into v_written_channels from upserted;
    if exists (
      select 1 from pg_temp.norva_active_live_variant_input input
      where not exists (
        select 1 from public.cloud_live_logical_channels channel
        where channel.user_id = p_user_id and channel.source_id = p_source_id
          and channel.generation_id = p_generation_id
          and channel.logical_id = input.logical_id
          and channel.projection_refresh_run_id = p_refresh_run_id
      )
    ) then
      raise exception 'active live logical channel proof mismatch'
        using errcode = '40001', detail = 'reason=catalog_payload_changed';
    end if;
    with upserted as (
      insert into public.cloud_live_variants as variant (
        user_id,source_id,logical_channel_id,logical_id,media_item_id,
        stream_id,external_id,label,rank,health_rank,title,raw_title,
        category_id,category_name,poster_url,stream_icon,playback_hint,
        metadata,container_extension,synced_at,generation_id,
        projection_refresh_run_id,write_head_revision,write_config_revision,
        write_source_visibility_epoch,write_user_visibility_epoch
      )
      select p_user_id,p_source_id,channel.id,input.logical_id,
        input.media_item_id,input.stream_id,input.external_id,input.label,
        input.rank,input.health_rank,input.title,input.raw_title,
        input.category_id,input.category_name,input.poster_url,
        input.stream_icon,input.playback_hint,input.metadata,
        input.container_extension,input.synced_at,p_generation_id,
        p_refresh_run_id,p_head_revision,p_config_revision,
        p_source_visibility_epoch,p_user_visibility_epoch
      from pg_temp.norva_active_live_variant_input input
      join public.cloud_live_logical_channels channel
        on channel.user_id = p_user_id and channel.source_id = p_source_id
       and channel.generation_id = p_generation_id
       and channel.logical_id = input.logical_id
       and channel.projection_refresh_run_id = p_refresh_run_id
      on conflict (source_id,generation_id,logical_id,stream_id,label)
      do update set
        logical_channel_id=excluded.logical_channel_id,
        media_item_id=excluded.media_item_id,external_id=excluded.external_id,
        rank=excluded.rank,health_rank=excluded.health_rank,
        title=excluded.title,raw_title=excluded.raw_title,
        category_id=excluded.category_id,category_name=excluded.category_name,
        poster_url=excluded.poster_url,stream_icon=excluded.stream_icon,
        playback_hint=excluded.playback_hint,metadata=excluded.metadata,
        container_extension=excluded.container_extension,
        synced_at=excluded.synced_at,
        projection_refresh_run_id=excluded.projection_refresh_run_id,
        write_head_revision=p_head_revision,
        write_config_revision=p_config_revision,
        write_source_visibility_epoch=p_source_visibility_epoch,
        write_user_visibility_epoch=p_user_visibility_epoch
      returning id
    ) select count(*)::integer into v_written_variants from upserted;
    -- The caller supplies only channel identity/display metadata.  Runtime
    -- summaries are recomputed from every run-marked variant accumulated so
    -- far, so split pages merge instead of overwriting one another and a
    -- caller cannot certify a ghost default/count/preview.
    with touched as materialized (
      select input.logical_id
      from pg_temp.norva_active_live_channel_input input
      union
      select input.logical_id
      from pg_temp.norva_active_live_variant_input input
    ), ranked as materialized (
      select variant.*,
        bool_or(variant.health_rank < 3) over (
          partition by variant.logical_id
        ) as has_healthy
      from public.cloud_live_variants variant
      join touched on touched.logical_id = variant.logical_id
      where variant.generation_id = p_generation_id
        and variant.user_id = p_user_id and variant.source_id = p_source_id
        and variant.projection_refresh_run_id = p_refresh_run_id
    ), preview_rows as materialized (
      select distinct on (variant.logical_id,variant.label) variant.*
      from ranked variant
      order by variant.logical_id,variant.label,
        variant.health_rank,variant.rank,variant.id
    ), previews as materialized (
      select variant.logical_id,count(*)::integer as variant_count,
        jsonb_agg(jsonb_build_object(
          'id',p_source_id::text || ':' || variant.stream_id,
          'media_item_id',variant.media_item_id,
          'mediaItemId',variant.media_item_id,
          'label',variant.label,'rank',variant.rank,
          'healthRank',variant.health_rank,
          'source_id',p_source_id,'sourceId',p_source_id,
          'stream_id',variant.stream_id,'streamId',variant.stream_id,
          'external_id',variant.external_id,'item_type','live',
          'raw',variant.raw_title,'title',variant.title,
          'name',variant.title,'poster_url',variant.poster_url,
          'stream_icon',variant.stream_icon,
          'category_id',variant.category_id,
          'category_name',variant.category_name,
          'playback_hint',variant.playback_hint,
          'playbackHint',variant.playback_hint,
          'metadata',variant.metadata,
          'container_extension',variant.container_extension
        ) order by variant.health_rank,variant.rank,variant.label,variant.id)
          as variant_preview
      from preview_rows variant
      group by variant.logical_id
    ), defaults as materialized (
      select distinct on (variant.logical_id)
        variant.logical_id,variant.stream_id,variant.poster_url,
        variant.stream_icon,variant.playback_hint,
        jsonb_build_object(
          'id',p_source_id::text || ':' || variant.stream_id,
          'media_item_id',variant.media_item_id,
          'mediaItemId',variant.media_item_id,
          'label',variant.label,'rank',variant.rank,
          'healthRank',variant.health_rank,
          'source_id',p_source_id,'sourceId',p_source_id,
          'stream_id',variant.stream_id,'streamId',variant.stream_id,
          'external_id',variant.external_id,'item_type','live',
          'raw',variant.raw_title,'title',variant.title,
          'name',variant.title,'poster_url',variant.poster_url,
          'stream_icon',variant.stream_icon,
          'category_id',variant.category_id,
          'category_name',variant.category_name,
          'playback_hint',variant.playback_hint,
          'playbackHint',variant.playback_hint,
          'metadata',variant.metadata,
          'container_extension',variant.container_extension
        ) as default_variant
      from ranked variant
      order by variant.logical_id,
        case when variant.has_healthy and variant.health_rank >= 3
          then 1 else 0 end,
        variant.health_rank,
        (case
          when variant.label like 'HD%' then 0
          when variant.label like 'FHD%'
            or variant.label like 'Super HD%' then 1
          when variant.label like 'SD%' then 2
          when variant.label like '4K%' then 4
          else 1
        end)::numeric
          + case when variant.label ~* '(h265|hevc)' then 0.5 else 0 end,
        variant.rank,variant.id
    )
    update public.cloud_live_logical_channels channel
    set default_stream_id = defaults.stream_id,
        variant_count = previews.variant_count,
        default_variant = defaults.default_variant,
        variant_preview = previews.variant_preview,
        playback_hint = defaults.playback_hint,
        poster_url = coalesce(defaults.poster_url,channel.poster_url),
        stream_icon = coalesce(defaults.stream_icon,channel.stream_icon),
        projection_refresh_run_id = p_refresh_run_id,
        write_head_revision = p_head_revision,
        write_config_revision = p_config_revision,
        write_source_visibility_epoch = p_source_visibility_epoch,
        write_user_visibility_epoch = p_user_visibility_epoch
    from previews
    join defaults on defaults.logical_id = previews.logical_id
    where channel.user_id = p_user_id and channel.source_id = p_source_id
      and channel.generation_id = p_generation_id
      and channel.logical_id = previews.logical_id;
  exception when others then
    perform set_config(
      'norva.catalog_active_variant_refresh',coalesce(v_previous_context,''),true
    );
    raise;
  end;
  perform set_config(
    'norva.catalog_active_variant_refresh',coalesce(v_previous_context,''),true
  );
  if v_written_channels <> v_expected_channels
     or v_written_variants <> v_expected_variants then
    raise exception 'active live materialization write count mismatch'
      using errcode = '40001', detail = 'reason=catalog_payload_changed';
  end if;
  if v_written_channels + v_written_variants > 0 then
    v_epoch := public.norva_bump_user_catalog_visibility_epoch(p_user_id);
    perform public.norva_adopt_active_catalog_refresh_epoch(
      p_job_id,p_refresh_run_id,
      (v_lock ->> 'visibilityEpoch')::bigint,v_epoch
    );
    delete from public.cloud_catalog_facet_summary where user_id = p_user_id;
  else
    v_epoch := (v_lock ->> 'visibilityEpoch')::bigint;
  end if;
  return jsonb_build_object(
    'contract','catalog-active-live-writer-v1',
    'generationId',p_generation_id,'refreshRunId',p_refresh_run_id,
    'jobId',p_job_id,'leaseSequence',p_lease_sequence,
    'catalogVersion',p_catalog_version,'visibilityEpoch',v_epoch,
    'writtenChannels',v_written_channels,
    'writtenVariants',v_written_variants
  );
end
$function$;

revoke all on function public.norva_upsert_active_catalog_live_materialization(
  uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,
  bigint,jsonb,jsonb
) from public,anon,authenticated,service_role;
grant execute on function public.norva_upsert_active_catalog_live_materialization(
  uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,
  bigint,jsonb,jsonb
) to service_role;

-- The title RPC precedes variant writes and therefore leaves COMMITTING rows
-- unconfirmed.  After the exact generation variants have committed (and the
-- membership trigger has advanced the user epoch), this bounded CAS marks only
-- payload versions that still match the writer response.  A crash at either
-- boundary leaves false rows that reconciliation refuses while a variant
-- survives.
create or replace function public.norva_confirm_active_catalog_title_projection_batch(
  p_source_id uuid,
  p_user_id uuid,
  p_generation_id uuid,
  p_refresh_run_id uuid,
  p_job_id uuid,
  p_worker text,
  p_lease_sequence integer,
  p_head_revision bigint,
  p_config_revision bigint,
  p_source_visibility_epoch bigint,
  p_user_visibility_epoch bigint,
  p_titles jsonb
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_transition public.cloud_source_transitions%rowtype;
  v_job public.cloud_source_credential_transition_jobs%rowtype;
  v_generation public.cloud_source_catalog_generations%rowtype;
  v_epoch bigint;
  v_expected integer;
  v_confirmed integer;
  v_generation_revision bigint;
  v_action text;
begin
  perform public.norva_credential_require_service_role();
  if p_refresh_run_id is null or p_job_id is null
     or nullif(btrim(p_worker),'') is null or length(p_worker) > 160
     or p_lease_sequence is null or p_lease_sequence < 1
     or p_titles is null
     or jsonb_typeof(p_titles) <> 'array'
     or jsonb_array_length(p_titles) > 500
     or octet_length(p_titles::text) > 1048576
     or exists (
       select 1
       from jsonb_array_elements(p_titles) row(value)
       where jsonb_typeof(row.value) <> 'object'
          or (select count(*) from jsonb_object_keys(row.value)) <> 4
          or not (row.value ?& array[
            'itemType','identityKey','titleId','payloadUpdatedAt'
          ])
          or row.value ->> 'itemType' not in ('movie','series')
          or nullif(btrim(row.value ->> 'identityKey'),'') is null
          or nullif(row.value ->> 'titleId','') is null
          or nullif(row.value ->> 'payloadUpdatedAt','') is null
     ) then
    raise exception 'active title confirmation batch is invalid or oversized'
      using errcode = '22023';
  end if;
  begin
    perform (row.value ->> 'titleId')::uuid,
      (row.value ->> 'payloadUpdatedAt')::timestamptz
    from jsonb_array_elements(p_titles) row(value);
  exception when invalid_text_representation or datetime_field_overflow then
    raise exception 'active title confirmation proof is malformed'
      using errcode = '22023';
  end;
  select count(*)::integer into v_expected
  from jsonb_array_elements(p_titles);
  if v_expected is distinct from (
    select count(*)::integer
    from (
      select distinct row.value ->> 'itemType',
        row.value ->> 'identityKey',row.value ->> 'titleId'
      from jsonb_array_elements(p_titles) row(value)
    ) unique_row
  ) then
    raise exception 'active title confirmation contains duplicates'
      using errcode = '22023';
  end if;
  if v_expected > 0 then
    if (
      select count(distinct row.value ->> 'itemType')
      from jsonb_array_elements(p_titles) row(value)
    ) <> 1 then
      raise exception 'active title confirmation crosses provider actions'
        using errcode = '22023';
    end if;
    select case min(row.value ->> 'itemType')
      when 'movie' then 'vod_streams' else 'series_streams' end
    into v_action
    from jsonb_array_elements(p_titles) row(value);
  end if;

  select transition.* into v_transition
  from public.cloud_source_transitions transition
  where transition.user_id = p_user_id
    and transition.old_source_id = p_source_id
    and transition.candidate_catalog_generation_id = p_generation_id
    and transition.state = 'committing'
  for update;
  if not found then
    raise exception 'active title confirmation transition CAS failed'
      using errcode = '40001', detail = 'reason=credential_transition_changed';
  end if;
  select job.* into v_job
  from public.cloud_source_credential_transition_jobs job
  where job.id = p_job_id and job.transition_id = v_transition.id
    and job.user_id = p_user_id and job.source_id = p_source_id
    and job.catalog_generation_id = p_generation_id
    and job.job_kind = 'post_switch_verify'
    and job.state = 'processing' and job.lease_owner = p_worker
    and job.lease_sequence = p_lease_sequence and job.lease_until > now()
    and job.title_projection_refresh_run_id = p_refresh_run_id
  for update;
  if not found then
    raise exception 'active title confirmation job lease CAS failed'
      using errcode = '40001', detail = 'reason=credential_job_lease_changed';
  end if;
  if v_expected > 0 then
    perform public.norva_require_active_catalog_refresh_action(
      p_job_id,p_refresh_run_id,v_action,null
    );
  end if;
  select generation.* into v_generation
  from public.cloud_source_catalog_generations generation
  where generation.id = p_generation_id
    and generation.user_id = p_user_id
    and generation.source_id = p_source_id
    and generation.state = 'active'
    and generation.transition_id = v_transition.id
    and generation.title_projection_refresh_run_id = p_refresh_run_id
    and not generation.manifest_sealing
  for update;
  if not found then
    raise exception 'active title confirmation generation CAS failed'
      using errcode = '40001', detail = 'reason=catalog_generation_changed';
  end if;
  insert into public.cloud_user_catalog_visibility_epochs(
    user_id,visibility_epoch,updated_at
  ) values (p_user_id,1,now()) on conflict (user_id) do nothing;
  select epoch.visibility_epoch into v_epoch
  from public.cloud_user_catalog_visibility_epochs epoch
  where epoch.user_id = p_user_id for update;
  if v_epoch is distinct from p_user_visibility_epoch
     or v_generation.config_revision is distinct from p_config_revision
     or not exists (
       select 1
       from public.cloud_source_catalog_heads head
       join public.cloud_source_lifecycle lifecycle
         on lifecycle.source_id = head.source_id
        and lifecycle.user_id = head.user_id
       join public.cloud_source_transitions transition
         on transition.id = v_generation.transition_id
        and transition.user_id = v_generation.user_id
       where head.source_id = p_source_id and head.user_id = p_user_id
         and head.active_generation_id = p_generation_id
         and head.head_revision = p_head_revision
         and lifecycle.config_revision = p_config_revision
         and lifecycle.visibility_epoch = p_source_visibility_epoch
         and transition.state = 'committing'
         and public.norva_source_catalog_visible_internal(
           p_source_id,p_user_id
         )
     ) then
    raise exception 'active title confirmation snapshot CAS failed'
      using errcode = '40001', detail = 'reason=catalog_generation_changed';
  end if;
  with supplied as materialized (
    select row.value ->> 'itemType' as item_type,
      row.value ->> 'identityKey' as identity_key,
      (row.value ->> 'titleId')::uuid as title_id,
      (row.value ->> 'payloadUpdatedAt')::timestamptz as payload_updated_at
    from jsonb_array_elements(p_titles) row(value)
  ), confirmed as (
    update public.cloud_source_catalog_generation_candidate_titles projection
    set post_switch_refreshed = true
    from supplied
    where projection.generation_id = p_generation_id
      and projection.user_id = p_user_id
      and projection.source_id = p_source_id
      and projection.item_type = supplied.item_type
      and projection.identity_key = supplied.identity_key
      and projection.title_id = supplied.title_id
      and projection.updated_at = supplied.payload_updated_at
      and exists (
        select 1
        from public.cloud_title_variants variant
        where variant.generation_id = p_generation_id
          and variant.source_id = p_source_id
          and variant.user_id = p_user_id
          and variant.title_id = supplied.title_id
          and variant.projection_refresh_run_id = p_refresh_run_id
      )
      and not exists (
        select 1
        from public.cloud_title_variants variant
        where variant.generation_id = p_generation_id
          and variant.source_id = p_source_id
          and variant.user_id = p_user_id
          and variant.title_id = supplied.title_id
          and variant.projection_refresh_run_id is distinct from
            p_refresh_run_id
      )
    returning projection.title_id
  ) select count(*)::integer into v_confirmed from confirmed;
  if v_confirmed <> v_expected then
    raise exception 'active title confirmation variant/payload proof mismatch'
      using errcode = '40001',
        detail = 'reason=post_switch_title_confirmation_mismatch';
  end if;
  select generation.revision into v_generation_revision
  from public.cloud_source_catalog_generations generation
  where generation.id = p_generation_id;
  return jsonb_build_object(
    'contract','catalog-title-active-confirm-v1',
    'generationId',p_generation_id,'refreshRunId',p_refresh_run_id,
    'jobId',p_job_id,'leaseSequence',p_lease_sequence,
    'headRevision',p_head_revision,'configRevision',p_config_revision,
    'sourceVisibilityEpoch',p_source_visibility_epoch,
    'visibilityEpoch',v_epoch,'generationRevision',v_generation_revision,
    'confirmedTitles',v_confirmed,'complete',true
  );
end
$function$;

revoke all on function public.norva_confirm_active_catalog_title_projection_batch(
  uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,jsonb
) from public,anon,authenticated,service_role;
grant execute on function public.norva_confirm_active_catalog_title_projection_batch(
  uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,jsonb
) to service_role;

create or replace function public.norva_complete_active_catalog_title_refresh_action(
  p_source_id uuid,
  p_user_id uuid,
  p_generation_id uuid,
  p_refresh_run_id uuid,
  p_job_id uuid,
  p_worker text,
  p_lease_sequence integer,
  p_head_revision bigint,
  p_config_revision bigint,
  p_source_visibility_epoch bigint,
  p_user_visibility_epoch bigint,
  p_action_kind text,
  p_catalog_version bigint,
  p_category_count bigint
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_transition public.cloud_source_transitions%rowtype;
  v_job public.cloud_source_credential_transition_jobs%rowtype;
  v_generation public.cloud_source_catalog_generations%rowtype;
  v_epoch bigint;
  v_item_type text;
  v_category_count bigint;
  v_observed_count bigint;
  v_active_count bigint;
  v_existing public.cloud_source_catalog_title_refresh_actions%rowtype;
  v_checkpoint public.cloud_source_catalog_title_refresh_checkpoints%rowtype;
  v_completed_at timestamptz := clock_timestamp();
  v_action_count integer;
  v_replayed boolean := false;
begin
  perform public.norva_credential_require_service_role();
  if p_action_kind not in ('live','vod','series')
     or p_catalog_version is null or p_catalog_version < 0
     or p_category_count is null or p_category_count < 0
     or p_refresh_run_id is null or p_job_id is null
     or nullif(btrim(p_worker),'') is null
     or p_lease_sequence is null or p_lease_sequence < 1 then
    raise exception 'active title refresh action proof is invalid or unsafe'
      using errcode = '22023';
  end if;
  select transition.* into v_transition
  from public.cloud_source_transitions transition
  where transition.user_id = p_user_id
    and transition.old_source_id = p_source_id
    and transition.candidate_catalog_generation_id = p_generation_id
    and transition.state = 'committing'
  for update;
  if not found then
    raise exception 'active title refresh action transition CAS failed'
      using errcode = '40001', detail = 'reason=credential_transition_changed';
  end if;
  select job.* into v_job
  from public.cloud_source_credential_transition_jobs job
  where job.id = p_job_id and job.transition_id = v_transition.id
    and job.user_id = p_user_id and job.source_id = p_source_id
    and job.catalog_generation_id = p_generation_id
    and job.job_kind = 'post_switch_verify'
    and job.state = 'processing' and job.lease_owner = p_worker
    and job.lease_sequence = p_lease_sequence and job.lease_until > now()
    and job.title_projection_refresh_run_id = p_refresh_run_id
  for update;
  if not found then
    raise exception 'active title refresh action job lease CAS failed'
      using errcode = '40001', detail = 'reason=credential_job_lease_changed';
  end if;
  select generation.* into v_generation
  from public.cloud_source_catalog_generations generation
  where generation.id = p_generation_id
    and generation.user_id = p_user_id
    and generation.source_id = p_source_id
    and generation.transition_id = v_transition.id
    and generation.state = 'active'
    and generation.title_projection_refresh_run_id = p_refresh_run_id
    and not generation.manifest_sealing
  for update;
  if not found then
    raise exception 'active title refresh action generation CAS failed'
      using errcode = '40001', detail = 'reason=catalog_generation_changed';
  end if;
  insert into public.cloud_user_catalog_visibility_epochs(
    user_id,visibility_epoch,updated_at
  ) values (p_user_id,1,now()) on conflict (user_id) do nothing;
  select epoch.visibility_epoch into v_epoch
  from public.cloud_user_catalog_visibility_epochs epoch
  where epoch.user_id = p_user_id for update;
  if v_epoch is distinct from p_user_visibility_epoch
     or v_generation.config_revision is distinct from p_config_revision
     or not exists (
       select 1
       from public.cloud_source_catalog_heads head
       join public.cloud_source_lifecycle lifecycle
         on lifecycle.source_id = head.source_id
        and lifecycle.user_id = head.user_id
       where head.source_id = p_source_id and head.user_id = p_user_id
         and head.active_generation_id = p_generation_id
         and head.head_revision = p_head_revision
         and lifecycle.config_revision = p_config_revision
         and lifecycle.visibility_epoch = p_source_visibility_epoch
         and public.norva_source_catalog_visible_internal(
           p_source_id,p_user_id
         )
     ) then
    raise exception 'active title refresh action snapshot CAS failed'
      using errcode = '40001', detail = 'reason=catalog_generation_changed';
  end if;
  select checkpoint.* into v_checkpoint
  from public.cloud_source_catalog_title_refresh_checkpoints checkpoint
  where checkpoint.job_id = p_job_id
    and checkpoint.refresh_run_id = p_refresh_run_id
    and checkpoint.transition_id = v_transition.id
    and checkpoint.user_id = p_user_id and checkpoint.source_id = p_source_id
    and checkpoint.generation_id = p_generation_id
    and checkpoint.checkpoint_revision = v_job.checkpoint_revision
    and checkpoint.head_revision = p_head_revision
    and checkpoint.config_revision = p_config_revision
    and checkpoint.source_visibility_epoch = p_source_visibility_epoch
    and checkpoint.user_visibility_epoch = p_user_visibility_epoch
    and checkpoint.progress ->> 'action' = case p_action_kind
      when 'live' then 'live_streams'
      when 'vod' then 'vod_streams'
      else 'series_streams' end
    and (checkpoint.progress ->> 'actionComplete')::boolean
    and checkpoint.progress ->> 'contentSha256' ~ '^[0-9a-f]{64}$'
    and (checkpoint.progress ->> 'catalogVersion')::bigint =
      p_catalog_version
    and (checkpoint.progress ->> 'categoryCount')::bigint =
      p_category_count
  for update;
  if not found then
    raise exception 'active title refresh action checkpoint is not terminal'
      using errcode = '40001',
        detail = 'reason=credential_job_checkpoint_changed';
  end if;
  if exists (
    select 1
    from public.cloud_source_catalog_title_refresh_actions action
    where action.refresh_run_id = p_refresh_run_id
      and action.catalog_version <> p_catalog_version
  ) then
    raise exception 'active title refresh catalog version drift'
      using errcode = '40001', detail = 'reason=catalog_version_changed';
  end if;

  v_item_type := case p_action_kind
    when 'vod' then 'movie' else p_action_kind end;
  select count(*)::bigint into v_category_count
  from public.cloud_source_catalog_generation_categories category
  where category.generation_id = p_generation_id
    and category.user_id = p_user_id and category.source_id = p_source_id
    and category.category_kind = p_action_kind;
  if v_category_count is distinct from p_category_count
     or exists (
       select 1
       from public.cloud_source_catalog_generation_categories category
       where category.generation_id = p_generation_id
         and category.user_id = p_user_id
         and category.source_id = p_source_id
         and category.category_kind = p_action_kind
         and category.projection_refresh_run_id is distinct from
           p_refresh_run_id
       limit 1
     ) then
    raise exception 'active title refresh has stale category inventory'
      using errcode = '55000',
        detail = 'reason=post_switch_category_refresh_incomplete';
  end if;
  select count(*)::bigint into v_observed_count
  from public.cloud_media_items item
  where item.generation_id = p_generation_id
    and item.source_id = p_source_id and item.user_id = p_user_id
    and item.item_type = v_item_type;
  if (v_checkpoint.progress ->> 'observedItems')::bigint is distinct from
       v_observed_count
     or (v_checkpoint.progress ->> 'processedItems')::bigint <
       v_observed_count
     or (v_checkpoint.progress ->> 'processedCategories')::bigint <
       p_category_count then
    raise exception 'active title refresh terminal checkpoint counts drifted'
      using errcode = '40001',
        detail = 'reason=credential_job_checkpoint_changed';
  end if;
  if exists (
    select 1
    from public.cloud_media_items item
    where item.generation_id = p_generation_id
      and item.source_id = p_source_id and item.user_id = p_user_id
      and item.item_type = v_item_type
      and (
        item.catalog_version is distinct from p_catalog_version
        or item.projection_refresh_run_id is distinct from p_refresh_run_id
      )
    limit 1
  ) then
    raise exception 'active title refresh has stale provider inventory rows'
      using errcode = '55000',
        detail = 'reason=post_switch_inventory_refresh_incomplete';
  end if;

  if p_action_kind in ('vod','series') then
    if exists (
      select 1
      from public.cloud_title_variants variant
      where variant.generation_id = p_generation_id
        and variant.source_id = p_source_id and variant.user_id = p_user_id
        and variant.item_type = v_item_type
        and variant.projection_refresh_run_id is null
      limit 1
    ) then
      raise exception 'active title refresh action has stale variants'
        using errcode = '55000',
          detail = 'reason=post_switch_variant_refresh_incomplete';
    end if;
    select count(*)::bigint into v_active_count
    from public.cloud_title_variants variant
    where variant.generation_id = p_generation_id
      and variant.source_id = p_source_id and variant.user_id = p_user_id
      and variant.item_type = v_item_type;
    if v_active_count is distinct from v_observed_count
       or exists (
         select 1
         from public.cloud_media_items item
         where item.generation_id = p_generation_id
           and item.source_id = p_source_id and item.user_id = p_user_id
           and item.item_type = v_item_type
           and not exists (
             select 1 from public.cloud_title_variants variant
             where variant.generation_id = p_generation_id
               and variant.source_id = p_source_id
               and variant.user_id = p_user_id
               and variant.media_item_id = item.id
               and variant.projection_refresh_run_id = p_refresh_run_id
           )
         limit 1
       ) then
      raise exception 'active title refresh media/variant proof mismatch'
        using errcode = '55000',
          detail = 'reason=post_switch_variant_refresh_incomplete';
    end if;
  else
    if exists (
      select 1
      from public.cloud_live_logical_channels channel
      where channel.generation_id = p_generation_id
        and channel.source_id = p_source_id and channel.user_id = p_user_id
        and (
          channel.projection_refresh_run_id is distinct from p_refresh_run_id
          or not exists (
            select 1
            from public.cloud_live_variants variant
            where variant.generation_id = channel.generation_id
              and variant.source_id = channel.source_id
              and variant.user_id = channel.user_id
              and variant.logical_channel_id = channel.id
              and variant.projection_refresh_run_id = p_refresh_run_id
          )
          or channel.variant_count is distinct from (
            select count(distinct variant.label)::integer
            from public.cloud_live_variants variant
            where variant.generation_id = channel.generation_id
              and variant.source_id = channel.source_id
              and variant.user_id = channel.user_id
              and variant.logical_channel_id = channel.id
              and variant.projection_refresh_run_id = p_refresh_run_id
          )
          or case
            when jsonb_typeof(channel.variant_preview) = 'array' then
              jsonb_array_length(channel.variant_preview)
                is distinct from channel.variant_count
              or (
                select count(distinct preview.value ->> 'label')::integer
                from jsonb_array_elements(channel.variant_preview) preview(value)
              ) is distinct from channel.variant_count
              or exists (
                select 1
                from jsonb_array_elements(channel.variant_preview) preview(value)
                where not exists (
                  select 1
                  from public.cloud_live_variants variant
                  where variant.generation_id = channel.generation_id
                    and variant.source_id = channel.source_id
                    and variant.user_id = channel.user_id
                    and variant.logical_channel_id = channel.id
                    and variant.projection_refresh_run_id = p_refresh_run_id
                    and variant.stream_id = preview.value ->> 'stream_id'
                    and variant.label = preview.value ->> 'label'
                )
              )
            else true
          end
          or channel.default_stream_id is null
          or channel.default_variant ->> 'stream_id'
               is distinct from channel.default_stream_id
          or not exists (
            select 1
            from public.cloud_live_variants variant
            where variant.generation_id = channel.generation_id
              and variant.source_id = channel.source_id
              and variant.user_id = channel.user_id
              and variant.logical_channel_id = channel.id
              and variant.projection_refresh_run_id = p_refresh_run_id
              and variant.stream_id = channel.default_stream_id
          )
        )
      limit 1
    ) then
      raise exception 'active live refresh action has stale logical channels'
        using errcode = '55000',
          detail = 'reason=post_switch_variant_refresh_incomplete';
    end if;
    if exists (
      select 1
      from public.cloud_live_variants variant
      where variant.generation_id = p_generation_id
        and variant.source_id = p_source_id and variant.user_id = p_user_id
        and variant.projection_refresh_run_id is null
      limit 1
    ) then
      raise exception 'active live refresh action has stale variants'
        using errcode = '55000',
          detail = 'reason=post_switch_variant_refresh_incomplete';
    end if;
    select count(*)::bigint into v_active_count
    from public.cloud_live_variants variant
    where variant.generation_id = p_generation_id
      and variant.source_id = p_source_id and variant.user_id = p_user_id;
    if v_active_count is distinct from v_observed_count
       or exists (
         select 1
         from public.cloud_media_items item
         where item.generation_id = p_generation_id
           and item.source_id = p_source_id and item.user_id = p_user_id
           and item.item_type = 'live'
           and not exists (
             select 1 from public.cloud_live_variants variant
             where variant.generation_id = p_generation_id
               and variant.source_id = p_source_id
               and variant.user_id = p_user_id
               and variant.media_item_id = item.id
               and variant.projection_refresh_run_id = p_refresh_run_id
           )
         limit 1
       ) then
      raise exception 'active live refresh media/variant proof mismatch'
        using errcode = '55000',
          detail = 'reason=post_switch_variant_refresh_incomplete';
    end if;
  end if;

  select action.* into v_existing
  from public.cloud_source_catalog_title_refresh_actions action
  where action.refresh_run_id = p_refresh_run_id
    and action.action_kind = p_action_kind
  for update;
  if not found
     or v_existing.job_id is distinct from p_job_id
     or v_existing.transition_id is distinct from v_transition.id
     or v_existing.user_id is distinct from p_user_id
     or v_existing.source_id is distinct from p_source_id
     or v_existing.generation_id is distinct from p_generation_id then
    raise exception 'active title refresh baseline ledger is missing or drifted'
      using errcode = '40001', detail = 'reason=title_refresh_run_changed';
  end if;
  if v_existing.state = 'complete' then
    if v_existing.checkpoint_revision is distinct from
         v_checkpoint.checkpoint_revision
       or v_existing.content_sha256 is distinct from
         v_checkpoint.progress ->> 'contentSha256'
       or v_existing.catalog_version is distinct from p_catalog_version
       or v_existing.category_count is distinct from p_category_count
       or v_existing.observed_count is distinct from v_observed_count
       or v_existing.active_row_count is distinct from v_active_count
       or v_existing.pruned_count is distinct from 0
       or not v_existing.inventory_complete
       or not v_existing.prune_complete or not v_existing.prune_safe then
      raise exception 'active title refresh action replay drift'
        using errcode = '40001', detail = 'reason=title_refresh_run_changed';
    end if;
    v_completed_at := v_existing.completed_at;
    v_replayed := true;
  else
    if v_existing.state <> 'started'
       or v_observed_count < v_existing.baseline_count then
      raise exception 'active title refresh baseline was destructively reduced'
        using errcode = '55000',
          detail = 'reason=post_switch_prune_requires_terminal_success';
    end if;
    update public.cloud_source_catalog_title_refresh_actions action
    set checkpoint_revision = v_checkpoint.checkpoint_revision,
        content_sha256 = v_checkpoint.progress ->> 'contentSha256',
        catalog_version = p_catalog_version,
        category_count = p_category_count,
        observed_count = v_observed_count,
        active_row_count = v_active_count,
        pruned_count = 0,
        inventory_complete = true,
        prune_complete = true,
        prune_safe = true,
        state = 'complete',
        completed_at = v_completed_at
    where action.refresh_run_id = p_refresh_run_id
      and action.action_kind = p_action_kind;
  end if;
  select count(*)::integer into v_action_count
  from public.cloud_source_catalog_title_refresh_actions action
  where action.refresh_run_id = p_refresh_run_id
    and action.job_id = p_job_id
    and action.action_kind in ('live','vod','series')
    and action.inventory_complete and action.prune_complete and action.prune_safe;
  if v_action_count = 3 then
    update public.cloud_source_credential_transition_jobs job
    set title_inventory_observed_count = totals.observed_count,
        title_pruned_variant_count = totals.pruned_count,
        title_inventory_completed_at = coalesce(
          job.title_inventory_completed_at,v_completed_at
        ),
        title_prune_completed_at = coalesce(
          job.title_prune_completed_at,v_completed_at
        ),
        updated_at = clock_timestamp()
    from (
      select sum(action.observed_count)::bigint as observed_count,
        sum(action.pruned_count)::bigint as pruned_count
      from public.cloud_source_catalog_title_refresh_actions action
      where action.refresh_run_id = p_refresh_run_id
        and action.job_id = p_job_id
    ) totals
    where job.id = p_job_id;
  end if;
  return jsonb_build_object(
    'contract','catalog-title-active-refresh-action-v1',
    'generationId',p_generation_id,'refreshRunId',p_refresh_run_id,
    'jobId',p_job_id,'leaseSequence',p_lease_sequence,
    'actionKind',p_action_kind,'catalogVersion',p_catalog_version,
    'categoryCount',p_category_count,
    'observedCount',v_observed_count,'activeRowCount',v_active_count,
    'prunedCount',0,'completedAt',v_completed_at,
    'visibilityEpoch',v_epoch,'allActionsComplete',(v_action_count = 3),
    'replayed',v_replayed
  );
end
$function$;

revoke all on function public.norva_complete_active_catalog_title_refresh_action(
  uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,
  text,bigint,bigint
) from public,anon,authenticated,service_role;
grant execute on function public.norva_complete_active_catalog_title_refresh_action(
  uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,
  text,bigint,bigint
) to service_role;

-- Re-evaluate the durable action ledger against the current physical rows.
-- Action completion is not a capability that may outlive later writes; this
-- proof is called again at reconcile, mark and terminal cutover.
create or replace function public.norva_active_catalog_refresh_proof_is_current(
  p_source_id uuid,
  p_user_id uuid,
  p_generation_id uuid,
  p_refresh_run_id uuid,
  p_job_id uuid
) returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select public.norva_catalog_title_active_payload_indexes_ready()
    and (
      select count(*) = 3
      from public.cloud_source_catalog_title_refresh_actions action
      where action.refresh_run_id = p_refresh_run_id
        and action.job_id = p_job_id
        and action.user_id = p_user_id
        and action.source_id = p_source_id
        and action.generation_id = p_generation_id
        and action.action_kind in ('live','vod','series')
        and action.state = 'complete'
        and action.inventory_complete
        and action.prune_complete and action.prune_safe
        and action.pruned_count >= 0
    )
    and not exists (
      select 1
      from public.cloud_source_catalog_title_refresh_actions action
      cross join lateral (
        select case action.action_kind
          when 'vod' then 'movie' else action.action_kind end as item_type
      ) kind
      where action.refresh_run_id = p_refresh_run_id
        and action.job_id = p_job_id
        and action.user_id = p_user_id
        and action.source_id = p_source_id
        and action.generation_id = p_generation_id
        and (
          action.state <> 'complete'
          or action.observed_count is distinct from (
            select count(*)::bigint
            from public.cloud_media_items item
            where item.generation_id = p_generation_id
              and item.user_id = p_user_id and item.source_id = p_source_id
              and item.item_type = kind.item_type
          )
          or exists (
            select 1
            from public.cloud_media_items item
            where item.generation_id = p_generation_id
              and item.user_id = p_user_id and item.source_id = p_source_id
              and item.item_type = kind.item_type
              and (
                item.catalog_version is distinct from action.catalog_version
                or item.projection_refresh_run_id is distinct from
                  p_refresh_run_id
              )
            limit 1
          )
          or action.category_count is distinct from (
            select count(*)::bigint
            from public.cloud_source_catalog_generation_categories category
            where category.generation_id = p_generation_id
              and category.user_id = p_user_id
              and category.source_id = p_source_id
              and category.category_kind = action.action_kind
          )
          or exists (
            select 1
            from public.cloud_source_catalog_generation_categories category
            where category.generation_id = p_generation_id
              and category.user_id = p_user_id
              and category.source_id = p_source_id
              and category.category_kind = action.action_kind
              and category.projection_refresh_run_id is distinct from
                p_refresh_run_id
            limit 1
          )
          or (
            action.action_kind in ('vod','series') and (
              action.active_row_count is distinct from (
                select count(*)::bigint
                from public.cloud_title_variants variant
                where variant.generation_id = p_generation_id
                  and variant.user_id = p_user_id
                  and variant.source_id = p_source_id
                  and variant.item_type = kind.item_type
              )
              or exists (
                select 1
                from public.cloud_title_variants variant
                where variant.generation_id = p_generation_id
                  and variant.user_id = p_user_id
                  and variant.source_id = p_source_id
                  and variant.item_type = kind.item_type
                  and variant.projection_refresh_run_id is distinct from
                    p_refresh_run_id
                limit 1
              )
              or exists (
                select 1
                from public.cloud_media_items item
                where item.generation_id = p_generation_id
                  and item.user_id = p_user_id
                  and item.source_id = p_source_id
                  and item.item_type = kind.item_type
                  and not exists (
                    select 1 from public.cloud_title_variants variant
                    where variant.generation_id = item.generation_id
                      and variant.user_id = item.user_id
                      and variant.source_id = item.source_id
                      and variant.media_item_id = item.id
                      and variant.projection_refresh_run_id = p_refresh_run_id
                  )
                limit 1
              )
            )
          )
          or (
            action.action_kind = 'live' and (
              action.active_row_count is distinct from (
                select count(*)::bigint
                from public.cloud_live_variants variant
                where variant.generation_id = p_generation_id
                  and variant.user_id = p_user_id
                  and variant.source_id = p_source_id
              )
              or exists (
                select 1
                from public.cloud_live_variants variant
                where variant.generation_id = p_generation_id
                  and variant.user_id = p_user_id
                  and variant.source_id = p_source_id
                  and variant.projection_refresh_run_id is distinct from
                    p_refresh_run_id
                limit 1
              )
              or exists (
                select 1
                from public.cloud_live_logical_channels channel
                where channel.generation_id = p_generation_id
                  and channel.user_id = p_user_id
                  and channel.source_id = p_source_id
                  and (
                    channel.projection_refresh_run_id is distinct from
                      p_refresh_run_id
                    or not exists (
                      select 1 from public.cloud_live_variants variant
                      where variant.generation_id = channel.generation_id
                        and variant.user_id = channel.user_id
                        and variant.source_id = channel.source_id
                        and variant.logical_channel_id = channel.id
                        and variant.projection_refresh_run_id = p_refresh_run_id
                    )
                    or channel.variant_count is distinct from (
                      select count(distinct variant.label)::integer
                      from public.cloud_live_variants variant
                      where variant.generation_id = channel.generation_id
                        and variant.user_id = channel.user_id
                        and variant.source_id = channel.source_id
                        and variant.logical_channel_id = channel.id
                        and variant.projection_refresh_run_id = p_refresh_run_id
                    )
                    or case
                      when jsonb_typeof(channel.variant_preview) = 'array' then
                        jsonb_array_length(channel.variant_preview)
                          is distinct from channel.variant_count
                        or (
                          select count(
                            distinct preview.value ->> 'label'
                          )::integer
                          from jsonb_array_elements(
                            channel.variant_preview
                          ) preview(value)
                        ) is distinct from channel.variant_count
                        or exists (
                          select 1
                          from jsonb_array_elements(
                            channel.variant_preview
                          ) preview(value)
                          where not exists (
                            select 1
                            from public.cloud_live_variants variant
                            where variant.generation_id = channel.generation_id
                              and variant.user_id = channel.user_id
                              and variant.source_id = channel.source_id
                              and variant.logical_channel_id = channel.id
                              and variant.projection_refresh_run_id =
                                p_refresh_run_id
                              and variant.stream_id =
                                preview.value ->> 'stream_id'
                              and variant.label = preview.value ->> 'label'
                          )
                        )
                      else true
                    end
                    or channel.default_stream_id is null
                    or channel.default_variant ->> 'stream_id'
                         is distinct from channel.default_stream_id
                    or not exists (
                      select 1
                      from public.cloud_live_variants variant
                      where variant.generation_id = channel.generation_id
                        and variant.user_id = channel.user_id
                        and variant.source_id = channel.source_id
                        and variant.logical_channel_id = channel.id
                        and variant.projection_refresh_run_id = p_refresh_run_id
                        and variant.stream_id = channel.default_stream_id
                    )
                  )
                limit 1
              )
              or exists (
                select 1
                from public.cloud_media_items item
                where item.generation_id = p_generation_id
                  and item.user_id = p_user_id
                  and item.source_id = p_source_id
                  and item.item_type = 'live'
                  and not exists (
                    select 1 from public.cloud_live_variants variant
                    where variant.generation_id = item.generation_id
                      and variant.user_id = item.user_id
                      and variant.source_id = item.source_id
                      and variant.media_item_id = item.id
                      and variant.projection_refresh_run_id = p_refresh_run_id
                  )
                limit 1
              )
            )
          )
        )
    )
    and not exists (
      select 1
      from public.cloud_source_catalog_generation_candidate_titles projection
      where projection.generation_id = p_generation_id
        and projection.user_id = p_user_id
        and projection.source_id = p_source_id
        and not projection.post_switch_refreshed
        and exists (
          select 1 from public.cloud_title_variants variant
          where variant.generation_id = p_generation_id
            and variant.user_id = p_user_id
            and variant.source_id = p_source_id
            and variant.title_id = projection.title_id
        )
      limit 1
    )
$function$;

revoke all on function public.norva_active_catalog_refresh_proof_is_current(
  uuid,uuid,uuid,uuid,uuid
) from public,anon,authenticated,service_role;

-- Persist one bounded post-switch continuation under the exact current lease.
-- `p_requeue=false` is a cheap in-lease checkpoint; `p_requeue=true` atomically
-- publishes the same checkpoint and releases the job for a later v3 claim.
create or replace function public.norva_checkpoint_active_catalog_title_refresh(
  p_source_id uuid,
  p_user_id uuid,
  p_generation_id uuid,
  p_refresh_run_id uuid,
  p_job_id uuid,
  p_worker text,
  p_lease_sequence integer,
  p_expected_checkpoint_revision bigint,
  p_head_revision bigint,
  p_config_revision bigint,
  p_source_visibility_epoch bigint,
  p_user_visibility_epoch bigint,
  p_progress jsonb,
  p_requeue boolean default false,
  p_delay_seconds integer default 0
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_lock jsonb;
  v_transition_id uuid;
  v_job_revision bigint;
  v_existing public.cloud_source_catalog_title_refresh_checkpoints%rowtype;
  v_existing_action integer;
  v_next_action integer;
  v_next_revision bigint;
  v_requeued_at timestamptz;
  v_rows integer;
begin
  perform public.norva_credential_require_service_role();
  if p_expected_checkpoint_revision is null
     or p_expected_checkpoint_revision < 0
     or p_requeue is null
     or p_delay_seconds is null or p_delay_seconds < 0
     or p_delay_seconds > 300
     or not public.norva_active_catalog_refresh_checkpoint_safe(p_progress)
  then
    raise exception 'active title refresh checkpoint is invalid or oversized'
      using errcode = '22023';
  end if;
  v_lock := public.norva_lock_active_catalog_refresh_lease(
    p_source_id,p_user_id,p_generation_id,p_refresh_run_id,p_job_id,
    p_worker,p_lease_sequence,p_head_revision,p_config_revision,
    p_source_visibility_epoch,p_user_visibility_epoch
  );
  v_transition_id := (v_lock ->> 'transitionId')::uuid;
  select job.checkpoint_revision into v_job_revision
  from public.cloud_source_credential_transition_jobs job
  where job.id = p_job_id;
  if v_job_revision is distinct from p_expected_checkpoint_revision then
    raise exception 'active title refresh checkpoint revision CAS failed'
      using errcode = '40001',
        detail = 'reason=credential_job_checkpoint_changed';
  end if;
  select checkpoint.* into v_existing
  from public.cloud_source_catalog_title_refresh_checkpoints checkpoint
  where checkpoint.job_id = p_job_id
  for update;
  v_next_action := case p_progress ->> 'action'
    when 'live_categories' then 0 when 'vod_categories' then 1
    when 'series_categories' then 2 when 'live_streams' then 3
    when 'vod_streams' then 4 when 'series_streams' then 5
    when 'complete' then 6 else -1 end;
  if found then
    v_existing_action := case v_existing.progress ->> 'action'
      when 'live_categories' then 0 when 'vod_categories' then 1
      when 'series_categories' then 2 when 'live_streams' then 3
      when 'vod_streams' then 4 when 'series_streams' then 5
      when 'complete' then 6 else -1 end;
    if v_existing.refresh_run_id is distinct from p_refresh_run_id
       or v_existing.transition_id is distinct from v_transition_id
       or v_existing.user_id is distinct from p_user_id
       or v_existing.source_id is distinct from p_source_id
       or v_existing.generation_id is distinct from p_generation_id
       or v_existing.checkpoint_revision is distinct from
          p_expected_checkpoint_revision
       or v_existing.head_revision is distinct from p_head_revision
       or v_existing.config_revision is distinct from p_config_revision
       or v_existing.source_visibility_epoch is distinct from
          p_source_visibility_epoch
       or v_existing.user_visibility_epoch is distinct from
          p_user_visibility_epoch
       or (v_existing.progress ->> 'catalogVersion')::bigint is distinct from
          (p_progress ->> 'catalogVersion')::bigint
       or v_next_action < v_existing_action
       or v_next_action > v_existing_action + 1
       or (
         v_next_action = v_existing_action
         and (
           (p_progress ->> 'processedCategories')::bigint <
             (v_existing.progress ->> 'processedCategories')::bigint
           or (p_progress ->> 'processedItems')::bigint <
             (v_existing.progress ->> 'processedItems')::bigint
           or (p_progress ->> 'observedItems')::bigint <
             (v_existing.progress ->> 'observedItems')::bigint
           or (p_progress ->> 'categoryCount')::bigint <
             (v_existing.progress ->> 'categoryCount')::bigint
         )
       )
       or (
         v_next_action = v_existing_action
         and (
           (
             v_existing.progress ->> 'contentSha256' is distinct from
               p_progress ->> 'contentSha256'
             and not (
               v_existing.progress ->> 'contentSha256' = ''
               and p_progress ->> 'contentSha256' ~ '^[0-9a-f]{64}$'
               and not (v_existing.progress ->> 'actionComplete')::boolean
               and not (p_progress ->> 'actionComplete')::boolean
               and v_existing.progress ->> 'cursor' = ''
               and p_progress ->> 'cursor' = ''
               and v_existing.progress ->> 'spoolToken' = ''
               and (v_existing.progress ->> 'processedCategories')::bigint = 0
               and (v_existing.progress ->> 'processedItems')::bigint = 0
               and (v_existing.progress ->> 'observedItems')::bigint = 0
               and (v_existing.progress ->> 'categoryCount')::bigint = 0
               and (p_progress ->> 'processedCategories')::bigint = 0
               and (p_progress ->> 'processedItems')::bigint = 0
               and (p_progress ->> 'observedItems')::bigint = 0
               and (p_progress ->> 'categoryCount')::bigint = 0
             )
           )
           or (
             (v_existing.progress ->> 'actionComplete')::boolean
             and not (p_progress ->> 'actionComplete')::boolean
           )
         )
       )
       or (
         v_next_action = v_existing_action + 1
         and not (v_existing.progress ->> 'actionComplete')::boolean
       )
       or (
         v_next_action = v_existing_action + 1
         and v_next_action < 6
         and (
           (p_progress ->> 'actionComplete')::boolean
           or p_progress ->> 'contentSha256' <> ''
           or p_progress ->> 'cursor' <> ''
           or p_progress ->> 'spoolToken' <> ''
           or (p_progress ->> 'processedCategories')::bigint <> 0
           or (p_progress ->> 'processedItems')::bigint <> 0
           or (p_progress ->> 'observedItems')::bigint <> 0
           or (p_progress ->> 'categoryCount')::bigint <> 0
         )
       )
       or (
         v_next_action = 6 and v_existing_action = 5
         and (
           p_progress ->> 'contentSha256' is distinct from
             v_existing.progress ->> 'contentSha256'
           or (p_progress ->> 'processedCategories')::bigint is distinct from
             (v_existing.progress ->> 'processedCategories')::bigint
           or (p_progress ->> 'processedItems')::bigint is distinct from
             (v_existing.progress ->> 'processedItems')::bigint
           or (p_progress ->> 'observedItems')::bigint is distinct from
             (v_existing.progress ->> 'observedItems')::bigint
           or (p_progress ->> 'categoryCount')::bigint is distinct from
             (v_existing.progress ->> 'categoryCount')::bigint
         )
       )
    then
      raise exception 'active title refresh checkpoint monotonic CAS failed'
        using errcode = '40001',
          detail = 'reason=credential_job_checkpoint_changed';
    end if;
    if v_next_action = v_existing_action + 1
       and v_existing_action in (3,4,5)
       and not exists (
         select 1
         from public.cloud_source_catalog_title_refresh_actions action
         where action.refresh_run_id = p_refresh_run_id
           and action.job_id = p_job_id
           and action.action_kind = case v_existing_action
             when 3 then 'live' when 4 then 'vod' else 'series' end
           and action.state = 'complete'
           and action.inventory_complete and action.prune_complete
           and action.prune_safe
       ) then
      raise exception 'active title refresh action must be pruned before advancing'
        using errcode = '55000',
          detail = 'reason=post_switch_prune_incomplete';
    end if;
  elsif p_expected_checkpoint_revision <> 0 then
    raise exception 'active title refresh checkpoint row is missing'
      using errcode = '40001',
        detail = 'reason=credential_job_checkpoint_changed';
  elsif v_next_action <> 0 then
    raise exception 'active title refresh checkpoint must start at live categories'
      using errcode = '40001',
        detail = 'reason=credential_job_checkpoint_changed';
  end if;
  if p_progress ->> 'action' = 'complete'
     and not public.norva_active_catalog_refresh_proof_is_current(
       p_source_id,p_user_id,p_generation_id,p_refresh_run_id,p_job_id
     ) then
    raise exception 'active title refresh cannot checkpoint incomplete proof'
      using errcode = '55000',
        detail = 'reason=title_inventory_proof_missing';
  end if;
  v_next_revision := p_expected_checkpoint_revision + 1;
  -- A long prune may requeue under a new lease between bounded slices.  Keep
  -- the action ledger's revision fence in the same transaction as the
  -- checkpoint revision so a reclaimed worker can continue without weakening
  -- the digest/run proof.
  if v_existing.job_id is not null
     and v_next_action = v_existing_action
     and v_next_action in (3,4,5)
     and exists (
       select 1
       from public.cloud_source_catalog_title_refresh_actions action
       where action.refresh_run_id = p_refresh_run_id
         and action.job_id = p_job_id
         and action.action_kind = case v_next_action
           when 3 then 'live' when 4 then 'vod' else 'series' end
         and action.state in ('pruning','complete')
     ) then
    update public.cloud_source_catalog_title_refresh_actions action
    set checkpoint_revision = v_next_revision
    where action.refresh_run_id = p_refresh_run_id
      and action.job_id = p_job_id
      and action.action_kind = case v_next_action
        when 3 then 'live' when 4 then 'vod' else 'series' end
      and action.state in ('pruning','complete')
      and action.checkpoint_revision = p_expected_checkpoint_revision
      and action.content_sha256 = p_progress ->> 'contentSha256';
    if not found then
      raise exception 'active catalog prune checkpoint revision CAS failed'
        using errcode = '40001',
          detail = 'reason=credential_job_checkpoint_changed';
    end if;
  end if;
  if p_requeue then v_requeued_at := clock_timestamp(); end if;
  insert into public.cloud_source_catalog_title_refresh_checkpoints as checkpoint (
    job_id,refresh_run_id,transition_id,user_id,source_id,generation_id,
    checkpoint_revision,head_revision,config_revision,
    source_visibility_epoch,user_visibility_epoch,progress,requeued_at
  ) values (
    p_job_id,p_refresh_run_id,v_transition_id,p_user_id,p_source_id,
    p_generation_id,v_next_revision,p_head_revision,p_config_revision,
    p_source_visibility_epoch,p_user_visibility_epoch,p_progress,v_requeued_at
  ) on conflict (job_id) do update set
    checkpoint_revision=excluded.checkpoint_revision,
    user_visibility_epoch=excluded.user_visibility_epoch,
    progress=excluded.progress,requeued_at=excluded.requeued_at,
    updated_at=clock_timestamp();
  update public.cloud_source_credential_transition_jobs job
  set checkpoint_revision=v_next_revision,
      state=case when p_requeue then 'pending' else job.state end,
      available_at=case when p_requeue then
        clock_timestamp() + make_interval(secs => p_delay_seconds)
        else job.available_at end,
      lease_owner=case when p_requeue then null else job.lease_owner end,
      lease_until=case when p_requeue then null else job.lease_until end,
      updated_at=clock_timestamp()
  where job.id = p_job_id and job.state = 'processing'
    and job.lease_owner = p_worker and job.lease_sequence = p_lease_sequence
    and job.lease_until > now()
    and job.checkpoint_revision = p_expected_checkpoint_revision;
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'active title refresh checkpoint job CAS failed'
      using errcode = '40001', detail = 'reason=credential_job_lease_changed';
  end if;
  return jsonb_build_object(
    'contract','catalog-title-active-refresh-checkpoint-v1',
    'generationId',p_generation_id,'refreshRunId',p_refresh_run_id,
    'jobId',p_job_id,'leaseSequence',p_lease_sequence,
    'checkpointRevision',v_next_revision,'checkpoint',p_progress,
    'visibilityEpoch',(v_lock ->> 'visibilityEpoch')::bigint,
    'leaseRetained',not p_requeue,'requeued',p_requeue,
    'requeuedAt',v_requeued_at
  );
end
$function$;

revoke all on function public.norva_checkpoint_active_catalog_title_refresh(
  uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,
  bigint,jsonb,boolean,integer
) from public,anon,authenticated,service_role;
grant execute on function public.norva_checkpoint_active_catalog_title_refresh(
  uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,
  bigint,jsonb,boolean,integer
) to service_role;

-- Validate one provider action after its stale rows have been consumed.  This
-- helper is private because its scalar arguments are meaningful only while the
-- exact transition/job/generation/epoch locks are held by the prune RPC.
create or replace function public.norva_active_catalog_refresh_action_current(
  p_source_id uuid,
  p_user_id uuid,
  p_generation_id uuid,
  p_refresh_run_id uuid,
  p_action_kind text,
  p_catalog_version bigint,
  p_category_count bigint,
  p_observed_count bigint,
  p_active_count bigint
) returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select p_action_kind in ('live','vod','series')
    and p_category_count = (
      select count(*)::bigint
      from public.cloud_source_catalog_generation_categories category
      where category.generation_id = p_generation_id
        and category.user_id = p_user_id and category.source_id = p_source_id
        and category.category_kind = p_action_kind
        and category.projection_refresh_run_id = p_refresh_run_id
    )
    and not exists (
      select 1
      from public.cloud_source_catalog_generation_categories category
      where category.generation_id = p_generation_id
        and category.user_id = p_user_id and category.source_id = p_source_id
        and category.category_kind = p_action_kind
        and category.projection_refresh_run_id is distinct from p_refresh_run_id
      limit 1
    )
    and p_observed_count = (
      select count(*)::bigint
      from public.cloud_media_items item
      where item.generation_id = p_generation_id
        and item.user_id = p_user_id and item.source_id = p_source_id
        and item.item_type = case p_action_kind
          when 'vod' then 'movie' else p_action_kind end
        and item.catalog_version = p_catalog_version
        and item.projection_refresh_run_id = p_refresh_run_id
    )
    and not exists (
      select 1
      from public.cloud_media_items item
      where item.generation_id = p_generation_id
        and item.user_id = p_user_id and item.source_id = p_source_id
        and item.item_type = case p_action_kind
          when 'vod' then 'movie' else p_action_kind end
        and item.projection_refresh_run_id is distinct from p_refresh_run_id
      limit 1
    )
    and case when p_action_kind in ('vod','series') then
      p_active_count = (
        select count(*)::bigint
        from public.cloud_title_variants variant
        where variant.generation_id = p_generation_id
          and variant.user_id = p_user_id and variant.source_id = p_source_id
          and variant.item_type = case p_action_kind
            when 'vod' then 'movie' else p_action_kind end
          and variant.projection_refresh_run_id = p_refresh_run_id
      )
      and p_active_count = p_observed_count
      and not exists (
        select 1 from public.cloud_title_variants variant
        where variant.generation_id = p_generation_id
          and variant.user_id = p_user_id and variant.source_id = p_source_id
          and variant.item_type = case p_action_kind
            when 'vod' then 'movie' else p_action_kind end
          and variant.projection_refresh_run_id is distinct from p_refresh_run_id
        limit 1
      )
      and not exists (
        select 1 from public.cloud_media_items item
        where item.generation_id = p_generation_id
          and item.user_id = p_user_id and item.source_id = p_source_id
          and item.item_type = case p_action_kind
            when 'vod' then 'movie' else p_action_kind end
          and not exists (
            select 1 from public.cloud_title_variants variant
            where variant.generation_id = item.generation_id
              and variant.user_id = item.user_id
              and variant.source_id = item.source_id
              and variant.media_item_id = item.id
              and variant.projection_refresh_run_id = p_refresh_run_id
          )
        limit 1
      )
    else
      p_active_count = (
        select count(*)::bigint
        from public.cloud_live_variants variant
        where variant.generation_id = p_generation_id
          and variant.user_id = p_user_id and variant.source_id = p_source_id
          and variant.projection_refresh_run_id = p_refresh_run_id
      )
      and p_active_count = p_observed_count
      and not exists (
        select 1 from public.cloud_live_variants variant
        where variant.generation_id = p_generation_id
          and variant.user_id = p_user_id and variant.source_id = p_source_id
          and variant.projection_refresh_run_id is distinct from p_refresh_run_id
        limit 1
      )
      and not exists (
        select 1 from public.cloud_media_items item
        where item.generation_id = p_generation_id
          and item.user_id = p_user_id and item.source_id = p_source_id
          and item.item_type = 'live'
          and not exists (
            select 1 from public.cloud_live_variants variant
            where variant.generation_id = item.generation_id
              and variant.user_id = item.user_id
              and variant.source_id = item.source_id
              and variant.media_item_id = item.id
              and variant.projection_refresh_run_id = p_refresh_run_id
          )
        limit 1
      )
      and not exists (
        select 1 from public.cloud_live_logical_channels channel
        where channel.generation_id = p_generation_id
          and channel.user_id = p_user_id and channel.source_id = p_source_id
          and (
            channel.projection_refresh_run_id is distinct from p_refresh_run_id
            or not exists (
              select 1 from public.cloud_live_variants variant
              where variant.generation_id = channel.generation_id
                and variant.user_id = channel.user_id
                and variant.source_id = channel.source_id
                and variant.logical_channel_id = channel.id
                and variant.projection_refresh_run_id = p_refresh_run_id
            )
            or channel.variant_count is distinct from (
              select count(distinct variant.label)::integer
              from public.cloud_live_variants variant
              where variant.generation_id = channel.generation_id
                and variant.user_id = channel.user_id
                and variant.source_id = channel.source_id
                and variant.logical_channel_id = channel.id
                and variant.projection_refresh_run_id = p_refresh_run_id
            )
            or jsonb_typeof(channel.variant_preview) <> 'array'
            or jsonb_array_length(channel.variant_preview) is distinct from
               channel.variant_count
            or channel.default_stream_id is null
            or channel.default_variant ->> 'stream_id' is distinct from
               channel.default_stream_id
            or not exists (
              select 1 from public.cloud_live_variants variant
              where variant.generation_id = channel.generation_id
                and variant.user_id = channel.user_id
                and variant.source_id = channel.source_id
                and variant.logical_channel_id = channel.id
                and variant.projection_refresh_run_id = p_refresh_run_id
                and variant.stream_id = channel.default_stream_id
            )
          )
        limit 1
      )
    end
$function$;

revoke all on function public.norva_active_catalog_refresh_action_current(
  uuid,uuid,uuid,uuid,text,bigint,bigint,bigint,bigint
) from public,anon,authenticated,service_role;

-- Consume provider-removed rows only after the exact completed spool action was
-- durably checkpointed.  A zero response for a non-empty baseline or a removal
-- over 50% is rejected before the first DELETE.  Every call consumes at most
-- p_limit direct rows and can be resumed after lease reclaim.
create or replace function public.norva_prune_active_catalog_refresh_action_batch(
  p_source_id uuid,
  p_user_id uuid,
  p_generation_id uuid,
  p_refresh_run_id uuid,
  p_job_id uuid,
  p_worker text,
  p_lease_sequence integer,
  p_expected_checkpoint_revision bigint,
  p_head_revision bigint,
  p_config_revision bigint,
  p_source_visibility_epoch bigint,
  p_user_visibility_epoch bigint,
  p_action_kind text,
  p_catalog_version bigint,
  p_limit integer default 500
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_lock jsonb;
  v_transition_id uuid;
  v_checkpoint public.cloud_source_catalog_title_refresh_checkpoints%rowtype;
  v_action public.cloud_source_catalog_title_refresh_actions%rowtype;
  v_expected_progress_action text;
  v_item_type text;
  v_category_count bigint;
  v_category_held bigint;
  v_observed_count bigint;
  v_held_count bigint;
  v_stale_count bigint;
  v_stale_category_count bigint;
  v_active_count bigint;
  v_budget integer;
  v_count integer;
  v_deleted_rows integer := 0;
  v_deleted_provider_items integer := 0;
  v_remaining bigint;
  v_complete boolean := false;
  v_replayed boolean := false;
  v_previous_prune_context text := current_setting(
    'norva.catalog_active_inventory_prune', true
  );
  v_previous_delete_proof text := current_setting(
    'norva.catalog_delete_proof', true
  );
  v_context jsonb;
  v_completed_at timestamptz := clock_timestamp();
  v_action_count integer;
  v_visibility_epoch bigint;
begin
  perform public.norva_credential_require_service_role();
  if p_action_kind not in ('live','vod','series')
     or p_catalog_version is null or p_catalog_version < 0
     or p_expected_checkpoint_revision is null
     or p_expected_checkpoint_revision < 1
     or p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'active catalog prune proof or limit is invalid'
      using errcode = '22023';
  end if;
  v_lock := public.norva_lock_active_catalog_refresh_lease(
    p_source_id,p_user_id,p_generation_id,p_refresh_run_id,p_job_id,
    p_worker,p_lease_sequence,p_head_revision,p_config_revision,
    p_source_visibility_epoch,p_user_visibility_epoch
  );
  v_transition_id := (v_lock ->> 'transitionId')::uuid;
  v_visibility_epoch := (v_lock ->> 'visibilityEpoch')::bigint;
  select checkpoint.* into v_checkpoint
  from public.cloud_source_catalog_title_refresh_checkpoints checkpoint
  where checkpoint.job_id = p_job_id
    and checkpoint.refresh_run_id = p_refresh_run_id
    and checkpoint.transition_id = v_transition_id
    and checkpoint.user_id = p_user_id and checkpoint.source_id = p_source_id
    and checkpoint.generation_id = p_generation_id
  for update;
  v_expected_progress_action := case p_action_kind
    when 'live' then 'live_streams'
    when 'vod' then 'vod_streams'
    else 'series_streams' end;
  if not found
     or v_checkpoint.checkpoint_revision is distinct from
        p_expected_checkpoint_revision
     or v_checkpoint.head_revision is distinct from p_head_revision
     or v_checkpoint.config_revision is distinct from p_config_revision
     or v_checkpoint.source_visibility_epoch is distinct from
        p_source_visibility_epoch
     or v_checkpoint.user_visibility_epoch is distinct from
        p_user_visibility_epoch
     or v_checkpoint.progress ->> 'action' is distinct from
        v_expected_progress_action
     or not coalesce(
       (v_checkpoint.progress ->> 'actionComplete')::boolean,false
     )
     or (v_checkpoint.progress ->> 'catalogVersion')::bigint is distinct from
        p_catalog_version then
    raise exception 'active catalog prune checkpoint proof is stale or incomplete'
      using errcode = '40001',
        detail = 'reason=credential_job_checkpoint_changed';
  end if;
  v_item_type := case p_action_kind when 'vod' then 'movie'
    else p_action_kind end;
  select action.* into v_action
  from public.cloud_source_catalog_title_refresh_actions action
  where action.refresh_run_id = p_refresh_run_id
    and action.action_kind = p_action_kind
  for update;
  if not found or v_action.job_id is distinct from p_job_id
     or v_action.transition_id is distinct from v_transition_id
     or v_action.user_id is distinct from p_user_id
     or v_action.source_id is distinct from p_source_id
     or v_action.generation_id is distinct from p_generation_id then
    raise exception 'active catalog prune action ledger drifted'
      using errcode = '40001', detail = 'reason=title_refresh_run_changed';
  end if;
  if v_action.state = 'started' then
    -- Pin the expensive exact inventory and anti-prune proof once.  Every
    -- continuation below uses the shrinking NULL-marker indexes and never
    -- rescans the already-certified provider inventory.
    select count(*)::bigint into v_category_count
    from public.cloud_source_catalog_generation_categories category
    where category.generation_id = p_generation_id
      and category.user_id = p_user_id and category.source_id = p_source_id
      and category.category_kind = p_action_kind
      and category.projection_refresh_run_id = p_refresh_run_id;
    select count(*)::bigint into v_category_held
    from public.cloud_source_catalog_generation_categories category
    where category.generation_id = p_generation_id
      and category.user_id = p_user_id and category.source_id = p_source_id
      and category.category_kind = p_action_kind;
    select count(*)::bigint into v_observed_count
    from public.cloud_media_items item
    where item.generation_id = p_generation_id
      and item.user_id = p_user_id and item.source_id = p_source_id
      and item.item_type = v_item_type
      and item.catalog_version = p_catalog_version
      and item.projection_refresh_run_id = p_refresh_run_id;
    select count(*)::bigint into v_held_count
    from public.cloud_media_items item
    where item.generation_id = p_generation_id
      and item.user_id = p_user_id and item.source_id = p_source_id
      and item.item_type = v_item_type;
    v_stale_count := v_held_count - v_observed_count;
    v_stale_category_count := v_category_held - v_category_count;
    if (v_held_count > 0 and v_observed_count = 0)
       or v_stale_count * 2 > v_held_count
       or (v_category_held > 0 and v_category_count = 0)
       or v_stale_category_count * 2 > v_category_held then
      raise exception 'active catalog provider inventory is incomplete or implausibly reduced'
        using errcode = '55000',
          detail = 'reason=post_switch_prune_safety_guard';
    end if;
    if (v_checkpoint.progress ->> 'observedItems')::bigint is distinct from
         v_observed_count
       or (v_checkpoint.progress ->> 'categoryCount')::bigint is distinct from
         v_category_count
       or (v_checkpoint.progress ->> 'processedItems')::bigint <
         v_observed_count
       or (v_checkpoint.progress ->> 'processedCategories')::bigint <
         v_category_count then
      raise exception 'active catalog provider checkpoint counts drifted'
        using errcode = '40001',
          detail = 'reason=credential_job_checkpoint_changed';
    end if;
    update public.cloud_source_catalog_title_refresh_actions action
    set checkpoint_revision = p_expected_checkpoint_revision,
        content_sha256 = v_checkpoint.progress ->> 'contentSha256',
        catalog_version = p_catalog_version,
        category_count = v_category_count,
        observed_count = v_observed_count,
        pruned_count = 0,
        inventory_complete = true,
        prune_complete = false,
        prune_safe = true,
        state = 'pruning'
    where action.refresh_run_id = p_refresh_run_id
      and action.action_kind = p_action_kind
      and action.state = 'started';
    if not found then
      raise exception 'active catalog prune start CAS failed'
        using errcode = '40001', detail = 'reason=title_refresh_run_changed';
    end if;
    v_action.checkpoint_revision := p_expected_checkpoint_revision;
    v_action.content_sha256 := v_checkpoint.progress ->> 'contentSha256';
    v_action.catalog_version := p_catalog_version;
    v_action.category_count := v_category_count;
    v_action.observed_count := v_observed_count;
    v_action.pruned_count := 0;
    v_action.inventory_complete := true;
    v_action.prune_safe := true;
    v_action.state := 'pruning';
  else
    v_category_count := v_action.category_count;
    v_observed_count := v_action.observed_count;
  end if;
  if v_action.state = 'complete' then
    if v_action.checkpoint_revision is distinct from
         p_expected_checkpoint_revision
       or v_action.content_sha256 is distinct from
         v_checkpoint.progress ->> 'contentSha256'
       or v_action.catalog_version is distinct from p_catalog_version
       or v_action.category_count is distinct from v_category_count
       or v_action.observed_count is distinct from v_observed_count
       or not public.norva_active_catalog_refresh_action_current(
         p_source_id,p_user_id,p_generation_id,p_refresh_run_id,p_action_kind,
         p_catalog_version,v_category_count,v_observed_count,
         v_action.active_row_count
       ) then
      raise exception 'active catalog prune replay proof drifted'
        using errcode = '40001', detail = 'reason=title_refresh_run_changed';
    end if;
    return jsonb_build_object(
      'contract','catalog-title-active-refresh-prune-v1',
      'generationId',p_generation_id,'refreshRunId',p_refresh_run_id,
      'jobId',p_job_id,'leaseSequence',p_lease_sequence,
      'checkpointRevision',p_expected_checkpoint_revision,
      'actionKind',p_action_kind,'catalogVersion',p_catalog_version,
      'deletedRows',0,'prunedItems',0,
      'prunedItemsTotal',v_action.pruned_count,
      'remainingRows',0,'complete',true,'replayed',true,
      'visibilityEpoch',(v_lock ->> 'visibilityEpoch')::bigint
    );
  elsif v_action.state <> 'pruning'
     or v_action.checkpoint_revision is distinct from
        p_expected_checkpoint_revision
     or v_action.content_sha256 is distinct from
        v_checkpoint.progress ->> 'contentSha256'
     or v_action.catalog_version is distinct from p_catalog_version
     or v_action.category_count is distinct from v_category_count
     or v_action.observed_count is distinct from v_observed_count
     or not v_action.inventory_complete or not v_action.prune_safe
     or v_action.prune_complete then
    raise exception 'active catalog prune continuation proof drifted'
      using errcode = '40001', detail = 'reason=title_refresh_run_changed';
  end if;

  v_context := jsonb_build_object(
    'transitionId',v_transition_id,'userId',p_user_id,
    'sourceId',p_source_id,'generationId',p_generation_id,
    'refreshRunId',p_refresh_run_id,'jobId',p_job_id,
    'worker',p_worker,'leaseSequence',p_lease_sequence
  );
  perform set_config(
    'norva.catalog_active_inventory_prune',v_context::text,true
  );
  perform set_config(
    'norva.catalog_delete_proof',jsonb_build_object(
      'headRevision',p_head_revision,'configRevision',p_config_revision,
      'sourceVisibilityEpoch',p_source_visibility_epoch,
      'userVisibilityEpoch',p_user_visibility_epoch
    )::text,true
  );
  v_budget := p_limit;
  if v_budget > 0 and p_action_kind in ('vod','series') then
    with doomed as (
      select variant.ctid
      from public.cloud_title_variants variant
      where variant.generation_id = p_generation_id
        and variant.user_id = p_user_id and variant.source_id = p_source_id
        and variant.item_type = v_item_type
        and variant.projection_refresh_run_id is null
      order by variant.id limit v_budget for update skip locked
    )
    delete from public.cloud_title_variants variant
    using doomed where variant.ctid = doomed.ctid;
    get diagnostics v_count = row_count;
    v_deleted_rows := v_deleted_rows + v_count;
    v_budget := v_budget - v_count;
  elsif v_budget > 0 then
    with doomed as (
      select variant.ctid
      from public.cloud_live_variants variant
      where variant.generation_id = p_generation_id
        and variant.user_id = p_user_id and variant.source_id = p_source_id
        and variant.projection_refresh_run_id is null
      order by variant.id limit v_budget for update skip locked
    )
    delete from public.cloud_live_variants variant
    using doomed where variant.ctid = doomed.ctid;
    get diagnostics v_count = row_count;
    v_deleted_rows := v_deleted_rows + v_count;
    v_budget := v_budget - v_count;
  end if;
  if v_budget > 0 then
    with doomed as (
      select item.ctid
      from public.cloud_media_items item
      where item.generation_id = p_generation_id
        and item.user_id = p_user_id and item.source_id = p_source_id
        and item.item_type = v_item_type
        and item.projection_refresh_run_id is null
      order by item.id limit v_budget for update skip locked
    )
    delete from public.cloud_media_items item
    using doomed where item.ctid = doomed.ctid;
    get diagnostics v_count = row_count;
    v_deleted_rows := v_deleted_rows + v_count;
    v_deleted_provider_items := v_deleted_provider_items + v_count;
    v_budget := v_budget - v_count;
  end if;
  if v_budget > 0 and p_action_kind = 'live' then
    with doomed as (
      select channel.ctid
      from public.cloud_live_logical_channels channel
      where channel.generation_id = p_generation_id
        and channel.user_id = p_user_id and channel.source_id = p_source_id
        and channel.projection_refresh_run_id is null
        and not exists (
          select 1 from public.cloud_live_variants variant
          where variant.generation_id = channel.generation_id
            and variant.logical_channel_id = channel.id
        )
      order by channel.id limit v_budget for update skip locked
    )
    delete from public.cloud_live_logical_channels channel
    using doomed where channel.ctid = doomed.ctid;
    get diagnostics v_count = row_count;
    v_deleted_rows := v_deleted_rows + v_count;
    v_budget := v_budget - v_count;
  end if;
  if v_budget > 0 then
    with doomed as (
      select category.ctid
      from public.cloud_source_catalog_generation_categories category
      where category.generation_id = p_generation_id
        and category.user_id = p_user_id and category.source_id = p_source_id
        and category.category_kind = p_action_kind
        and category.projection_refresh_run_id is null
      order by category.provider_category_id
      limit v_budget for update skip locked
    )
    delete from public.cloud_source_catalog_generation_categories category
    using doomed where category.ctid = doomed.ctid;
    get diagnostics v_count = row_count;
    v_deleted_rows := v_deleted_rows + v_count;
    v_budget := v_budget - v_count;
  end if;
  if v_budget > 0 and p_action_kind in ('vod','series') then
    with doomed as (
      select projection.ctid
      from public.cloud_source_catalog_generation_candidate_titles projection
      where projection.generation_id = p_generation_id
        and projection.user_id = p_user_id and projection.source_id = p_source_id
        and projection.item_type = v_item_type
        and not projection.post_switch_refreshed
        and not exists (
          select 1 from public.cloud_title_variants variant
          where variant.generation_id = projection.generation_id
            and variant.title_id = projection.title_id
        )
      order by projection.title_id limit v_budget for update skip locked
    )
    delete from public.cloud_source_catalog_generation_candidate_titles projection
    using doomed where projection.ctid = doomed.ctid;
    get diagnostics v_count = row_count;
    v_deleted_rows := v_deleted_rows + v_count;
    v_budget := v_budget - v_count;
  end if;
  perform set_config(
    'norva.catalog_active_inventory_prune',coalesce(v_previous_prune_context,''),true
  );
  perform set_config(
    'norva.catalog_delete_proof',coalesce(v_previous_delete_proof,''),true
  );
  if v_deleted_rows > 0 then
    v_visibility_epoch := public.norva_bump_user_catalog_visibility_epoch(
      p_user_id
    );
    update public.cloud_source_catalog_title_refresh_checkpoints checkpoint
    set user_visibility_epoch = v_visibility_epoch,
        updated_at = clock_timestamp()
    where checkpoint.job_id = p_job_id
      and checkpoint.refresh_run_id = p_refresh_run_id
      and checkpoint.checkpoint_revision = p_expected_checkpoint_revision
      and checkpoint.user_visibility_epoch = p_user_visibility_epoch;
    if not found then
      raise exception 'active catalog prune epoch checkpoint CAS failed'
        using errcode = '40001',
          detail = 'reason=credential_job_checkpoint_changed';
    end if;
  end if;
  update public.cloud_source_catalog_title_refresh_actions action
  set pruned_count = action.pruned_count + v_deleted_provider_items
  where action.refresh_run_id = p_refresh_run_id
    and action.action_kind = p_action_kind;

  select case when exists (select 1 from (
    select item.id::text
    from public.cloud_media_items item
    where item.generation_id = p_generation_id
      and item.user_id = p_user_id and item.source_id = p_source_id
      and item.item_type = v_item_type
      and item.projection_refresh_run_id is null
    union all
    select category.provider_category_id
    from public.cloud_source_catalog_generation_categories category
    where category.generation_id = p_generation_id
      and category.user_id = p_user_id and category.source_id = p_source_id
      and category.category_kind = p_action_kind
      and category.projection_refresh_run_id is null
    union all
    select variant.id::text
    from public.cloud_title_variants variant
    where p_action_kind in ('vod','series')
      and variant.generation_id = p_generation_id
      and variant.user_id = p_user_id and variant.source_id = p_source_id
      and variant.item_type = v_item_type
      and variant.projection_refresh_run_id is null
    union all
    select variant.id::text
    from public.cloud_live_variants variant
    where p_action_kind = 'live' and variant.generation_id = p_generation_id
      and variant.user_id = p_user_id and variant.source_id = p_source_id
      and variant.projection_refresh_run_id is null
    union all
    select channel.id::text
    from public.cloud_live_logical_channels channel
    where p_action_kind = 'live' and channel.generation_id = p_generation_id
      and channel.user_id = p_user_id and channel.source_id = p_source_id
      and channel.projection_refresh_run_id is null
    union all
    select projection.title_id::text
    from public.cloud_source_catalog_generation_candidate_titles projection
    where p_action_kind in ('vod','series')
      and projection.generation_id = p_generation_id
      and projection.user_id = p_user_id and projection.source_id = p_source_id
      and projection.item_type = v_item_type
      and not projection.post_switch_refreshed
      and not exists (
        select 1 from public.cloud_title_variants variant
        where variant.generation_id = projection.generation_id
          and variant.title_id = projection.title_id
      )
  ) remaining limit 1) then 1 else 0 end into v_remaining;
  if v_remaining = 0 then
    if p_action_kind in ('vod','series') then
      select count(*)::bigint into v_active_count
      from public.cloud_title_variants variant
      where variant.generation_id = p_generation_id
        and variant.user_id = p_user_id and variant.source_id = p_source_id
        and variant.item_type = v_item_type;
    else
      select count(*)::bigint into v_active_count
      from public.cloud_live_variants variant
      where variant.generation_id = p_generation_id
        and variant.user_id = p_user_id and variant.source_id = p_source_id;
    end if;
    if not public.norva_active_catalog_refresh_action_current(
      p_source_id,p_user_id,p_generation_id,p_refresh_run_id,p_action_kind,
      p_catalog_version,v_category_count,v_observed_count,v_active_count
    ) then
      raise exception 'active catalog prune final physical proof failed'
        using errcode = '55000',
          detail = 'reason=post_switch_inventory_refresh_incomplete';
    end if;
    update public.cloud_source_catalog_title_refresh_actions action
    set active_row_count = v_active_count,
        prune_complete = true,
        state = 'complete',
        completed_at = coalesce(action.completed_at,v_completed_at)
    where action.refresh_run_id = p_refresh_run_id
      and action.action_kind = p_action_kind;
    v_complete := true;
  end if;
  select count(*)::integer into v_action_count
  from public.cloud_source_catalog_title_refresh_actions action
  where action.refresh_run_id = p_refresh_run_id and action.job_id = p_job_id
    and action.action_kind in ('live','vod','series')
    and action.state = 'complete' and action.inventory_complete
    and action.prune_complete and action.prune_safe;
  if v_action_count = 3 then
    update public.cloud_source_credential_transition_jobs job
    set title_inventory_observed_count = totals.observed_count,
        title_pruned_variant_count = totals.pruned_count,
        title_inventory_completed_at = coalesce(
          job.title_inventory_completed_at,v_completed_at
        ),
        title_prune_completed_at = coalesce(
          job.title_prune_completed_at,v_completed_at
        ),
        updated_at = clock_timestamp()
    from (
      select sum(action.observed_count)::bigint observed_count,
        sum(action.pruned_count)::bigint pruned_count
      from public.cloud_source_catalog_title_refresh_actions action
      where action.refresh_run_id = p_refresh_run_id
        and action.job_id = p_job_id
    ) totals
    where job.id = p_job_id;
  end if;
  return jsonb_build_object(
    'contract','catalog-title-active-refresh-prune-v1',
    'generationId',p_generation_id,'refreshRunId',p_refresh_run_id,
    'jobId',p_job_id,'leaseSequence',p_lease_sequence,
    'checkpointRevision',p_expected_checkpoint_revision,
    'actionKind',p_action_kind,'catalogVersion',p_catalog_version,
    'deletedRows',v_deleted_rows,'prunedItems',v_deleted_provider_items,
    'prunedItemsTotal',(
      select action.pruned_count
      from public.cloud_source_catalog_title_refresh_actions action
      where action.refresh_run_id = p_refresh_run_id
        and action.action_kind = p_action_kind
    ),
    'remainingRows',v_remaining,'complete',v_complete,'replayed',v_replayed,
    'visibilityEpoch',v_visibility_epoch
  );
exception when others then
  perform set_config(
    'norva.catalog_active_inventory_prune',coalesce(v_previous_prune_context,''),true
  );
  perform set_config(
    'norva.catalog_delete_proof',coalesce(v_previous_delete_proof,''),true
  );
  raise;
end
$function$;

revoke all on function public.norva_prune_active_catalog_refresh_action_batch(
  uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,bigint,
  text,bigint,integer
) from public,anon,authenticated,service_role;
grant execute on function public.norva_prune_active_catalog_refresh_action_batch(
  uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,bigint,
  text,bigint,integer
) to service_role;

-- The checkpoint-fenced prune RPC is the only service-callable action terminal.
revoke all on function public.norva_complete_active_catalog_title_refresh_action(
  uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,
  text,bigint,bigint
) from public,anon,authenticated,service_role;

-- After the provider inventory action has completed, retire staged identities
-- that were not observed by the active projector.  A surviving generation
-- variant is a hard failure (refresh/prune was incomplete); a row with no
-- variant is an exact removed/rekeyed identity and is consumed in a bounded
-- batch.  Holding the generation row fences variant insert/update statements.
create or replace function public.norva_reconcile_active_catalog_title_projection_batch(
  p_source_id uuid,
  p_user_id uuid,
  p_generation_id uuid,
  p_refresh_run_id uuid,
  p_job_id uuid,
  p_worker text,
  p_lease_sequence integer,
  p_head_revision bigint,
  p_config_revision bigint,
  p_source_visibility_epoch bigint,
  p_user_visibility_epoch bigint,
  p_limit integer default 500
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_role text := coalesce(
    nullif(auth.jwt() ->> 'role', ''),
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('role', true), 'none'),
    ''
  );
  v_transition public.cloud_source_transitions%rowtype;
  v_job public.cloud_source_credential_transition_jobs%rowtype;
  v_generation public.cloud_source_catalog_generations%rowtype;
  v_epoch bigint;
  v_orphan_sample_count integer := 0;
  v_catalog_version bigint;
begin
  if v_role <> 'service_role'
     and not (v_role in ('', 'postgres') and session_user = 'postgres') then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_refresh_run_id is null or p_job_id is null
     or nullif(btrim(p_worker),'') is null or length(p_worker) > 160
     or p_lease_sequence is null or p_lease_sequence < 1
     or p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'active title reconciliation requires complete inventory and limit 1..500'
      using errcode = '22023';
  end if;
  if not public.norva_catalog_title_active_payload_indexes_ready() then
    raise exception 'active title reconciliation indexes are not ready'
      using errcode = '55000', detail = 'reason=title_projection_index_drift';
  end if;
  perform set_config('lock_timeout','2s',true);
  select transition.* into v_transition
  from public.cloud_source_transitions transition
  where transition.user_id = p_user_id
    and transition.old_source_id = p_source_id
    and transition.candidate_catalog_generation_id = p_generation_id
    and transition.state = 'committing'
  for update;
  if not found then
    raise exception 'active title reconciliation transition CAS failed'
      using errcode = '40001', detail = 'reason=credential_transition_changed';
  end if;
  select job.* into v_job
  from public.cloud_source_credential_transition_jobs job
  where job.id = p_job_id and job.transition_id = v_transition.id
    and job.user_id = p_user_id and job.source_id = p_source_id
    and job.catalog_generation_id = p_generation_id
    and job.job_kind = 'post_switch_verify'
    and job.state = 'processing' and job.lease_owner = p_worker
    and job.lease_sequence = p_lease_sequence and job.lease_until > now()
    and job.title_projection_refresh_run_id = p_refresh_run_id
    and job.title_inventory_completed_at is not null
    and job.title_prune_completed_at is not null
  for update;
  if not found then
    raise exception 'active title reconciliation lacks durable inventory outcome'
      using errcode = '40001', detail = 'reason=title_inventory_proof_missing';
  end if;
  if (
    select count(*)
    from public.cloud_source_catalog_title_refresh_actions action
    where action.refresh_run_id = p_refresh_run_id
      and action.job_id = p_job_id
      and action.transition_id = v_transition.id
      and action.user_id = p_user_id and action.source_id = p_source_id
      and action.generation_id = p_generation_id
      and action.action_kind in ('live','vod','series')
      and action.state = 'complete'
      and action.inventory_complete and action.prune_complete
      and action.prune_safe and action.pruned_count >= 0
  ) <> 3 or (
    select count(distinct action.catalog_version)
    from public.cloud_source_catalog_title_refresh_actions action
    where action.refresh_run_id = p_refresh_run_id
  ) <> 1 then
    raise exception 'active title reconciliation action ledger is incomplete'
      using errcode = '40001', detail = 'reason=title_inventory_proof_missing';
  end if;
  select min(action.catalog_version) into v_catalog_version
  from public.cloud_source_catalog_title_refresh_actions action
  where action.refresh_run_id = p_refresh_run_id;
  select generation.* into v_generation
  from public.cloud_source_catalog_generations generation
  where generation.id = p_generation_id
    and generation.user_id = p_user_id
    and generation.source_id = p_source_id
    and generation.state = 'active'
    and generation.transition_id is not null
    and generation.title_projection_refresh_run_id = p_refresh_run_id
    and not generation.manifest_sealing
  for update;
  if not found then
    raise exception 'active title reconciliation generation CAS failed'
      using errcode = '40001', detail = 'reason=catalog_generation_changed';
  end if;
  if v_generation.transition_id is distinct from v_transition.id then
    raise exception 'active title reconciliation generation transition drift'
      using errcode = '40001', detail = 'reason=credential_transition_changed';
  end if;
  insert into public.cloud_user_catalog_visibility_epochs(
    user_id,visibility_epoch,updated_at
  ) values (p_user_id,1,now()) on conflict (user_id) do nothing;
  select epoch.visibility_epoch into v_epoch
  from public.cloud_user_catalog_visibility_epochs epoch
  where epoch.user_id = p_user_id for update;
  if v_epoch is distinct from p_user_visibility_epoch
     or v_generation.config_revision is distinct from p_config_revision
     or not exists (
       select 1
       from public.cloud_source_catalog_heads head
       join public.cloud_source_lifecycle lifecycle
         on lifecycle.source_id = head.source_id
        and lifecycle.user_id = head.user_id
       join public.cloud_source_transitions transition
         on transition.id = v_generation.transition_id
        and transition.user_id = v_generation.user_id
       where head.source_id = p_source_id and head.user_id = p_user_id
         and head.active_generation_id = p_generation_id
         and head.head_revision = p_head_revision
         and lifecycle.config_revision = p_config_revision
         and lifecycle.visibility_epoch = p_source_visibility_epoch
         and transition.state = 'committing'
         and public.norva_source_catalog_visible_internal(
           p_source_id,p_user_id
         )
     ) then
    raise exception 'active title reconciliation snapshot CAS failed'
      using errcode = '40001', detail = 'reason=catalog_generation_changed';
  end if;
  if not public.norva_active_catalog_refresh_proof_is_current(
    p_source_id,p_user_id,p_generation_id,p_refresh_run_id,p_job_id
  ) then
    raise exception 'active title reconciliation physical proof drifted'
      using errcode = '40001', detail = 'reason=title_inventory_proof_missing';
  end if;

  -- COMMITTING is upsert-only.  A false projection that still owns a variant
  -- proves a skipped title/variant refresh and must compensate.  A false row
  -- with no variant is an inert normalized->provider re-key shell; retain it
  -- until the ordinary terminal generation cleanup rather than deleting before
  -- rollback is no longer possible.
  if exists (
    select 1
    from public.cloud_title_variants variant
    join public.cloud_source_catalog_generation_candidate_titles projection
      on projection.generation_id = variant.generation_id
     and projection.title_id = variant.title_id
    where variant.generation_id = p_generation_id
      and variant.source_id = p_source_id and variant.user_id = p_user_id
      and not projection.post_switch_refreshed
    limit 1
  ) then
    raise exception 'active title inventory still has an unrefreshed variant'
      using errcode = '55000',
        detail = 'reason=post_switch_active_title_not_refreshed';
  end if;
  select count(*)::integer into v_orphan_sample_count
  from (
    select projection.title_id
    from public.cloud_source_catalog_generation_candidate_titles projection
    where projection.generation_id = p_generation_id
      and not projection.post_switch_refreshed
      and not exists (
        select 1 from public.cloud_title_variants variant
        where variant.generation_id = p_generation_id
          and variant.title_id = projection.title_id
      )
    order by projection.title_id
    limit p_limit
  ) orphan_sample;
  update public.cloud_source_catalog_generations generation
  set title_projection_inventory_completed_at = coalesce(
        generation.title_projection_inventory_completed_at,
        clock_timestamp()
      ),
      revision = generation.revision + 1,
      updated_at = clock_timestamp()
  where generation.id = p_generation_id;
  return jsonb_build_object(
    'contract','catalog-title-active-reconcile-v1',
    'generationId',p_generation_id,'refreshRunId',p_refresh_run_id,
    'headRevision',p_head_revision,'configRevision',p_config_revision,
    'sourceVisibilityEpoch',p_source_visibility_epoch,
    'jobId',p_job_id,'leaseSequence',p_lease_sequence,
    'catalogVersion',v_catalog_version,
    'visibilityEpoch',v_epoch,'limit',p_limit,
    'orphanProjectionSampleCount',v_orphan_sample_count,
    'retiredTitles',0,'deletedTitleShells',0,'complete',true
  );
end
$function$;

revoke all on function public.norva_reconcile_active_catalog_title_projection_batch(
  uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,integer
) from public,anon,authenticated,service_role;
grant execute on function public.norva_reconcile_active_catalog_title_projection_batch(
  uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,integer
) to service_role;

-- Called only after every post-switch title batch has completed.  The partial
-- unrefreshed index proves zero remaining without a whole-generation scan.
create or replace function public.norva_mark_active_catalog_title_projection_refreshed(
  p_source_id uuid,
  p_user_id uuid,
  p_generation_id uuid,
  p_refresh_run_id uuid,
  p_job_id uuid,
  p_worker text,
  p_lease_sequence integer,
  p_head_revision bigint,
  p_config_revision bigint,
  p_source_visibility_epoch bigint,
  p_user_visibility_epoch bigint
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_role text := coalesce(
    nullif(auth.jwt() ->> 'role', ''),
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('role', true), 'none'),
    ''
  );
  v_generation public.cloud_source_catalog_generations%rowtype;
  v_transition public.cloud_source_transitions%rowtype;
  v_job public.cloud_source_credential_transition_jobs%rowtype;
  v_epoch bigint;
  v_refreshed_at timestamptz := clock_timestamp();
begin
  if v_role <> 'service_role'
     and not (v_role in ('', 'postgres') and session_user = 'postgres') then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if not public.norva_catalog_title_active_payload_indexes_ready() then
    raise exception 'active title payload index contract is not ready'
      using errcode = '55000', detail = 'reason=title_projection_index_drift';
  end if;
  if p_refresh_run_id is null or p_job_id is null
     or nullif(btrim(p_worker),'') is null or length(p_worker) > 160
     or p_lease_sequence is null or p_lease_sequence < 1 then
    raise exception 'active title projection marker lease proof is invalid'
      using errcode = '22023';
  end if;
  select transition.* into v_transition
  from public.cloud_source_transitions transition
  where transition.user_id = p_user_id
    and transition.old_source_id = p_source_id
    and transition.candidate_catalog_generation_id = p_generation_id
    and transition.state = 'committing'
  for update;
  if not found then
    raise exception 'active title projection marker transition CAS failed'
      using errcode = '40001';
  end if;
  select job.* into v_job
  from public.cloud_source_credential_transition_jobs job
  where job.id = p_job_id and job.transition_id = v_transition.id
    and job.user_id = p_user_id and job.source_id = p_source_id
    and job.catalog_generation_id = p_generation_id
    and job.job_kind = 'post_switch_verify'
    and job.state = 'processing' and job.lease_owner = p_worker
    and job.lease_sequence = p_lease_sequence and job.lease_until > now()
    and job.title_projection_refresh_run_id = p_refresh_run_id
    and job.title_inventory_completed_at is not null
    and job.title_prune_completed_at is not null
  for update;
  if not found then
    raise exception 'active title projection marker job lease CAS failed'
      using errcode = '40001';
  end if;
  if (
    select count(*)
    from public.cloud_source_catalog_title_refresh_actions action
    where action.refresh_run_id = p_refresh_run_id
      and action.job_id = p_job_id
      and action.transition_id = v_transition.id
      and action.user_id = p_user_id and action.source_id = p_source_id
      and action.generation_id = p_generation_id
      and action.state = 'complete' and action.inventory_complete
      and action.prune_complete and action.prune_safe
      and action.pruned_count >= 0
  ) <> 3 then
    raise exception 'active title projection marker action proof is incomplete'
      using errcode = '40001';
  end if;
  select generation.* into v_generation
  from public.cloud_source_catalog_generations generation
  where generation.id = p_generation_id
    and generation.user_id = p_user_id
    and generation.source_id = p_source_id
    and generation.state = 'active'
    and generation.transition_id = v_transition.id
    and generation.title_projection_refresh_run_id = p_refresh_run_id
    and generation.title_projection_inventory_completed_at is not null
    and not generation.manifest_sealing
  for update;
  if not found then
    raise exception 'active title projection marker generation CAS failed'
      using errcode = '40001';
  end if;
  insert into public.cloud_user_catalog_visibility_epochs(
    user_id,visibility_epoch,updated_at
  ) values (p_user_id,1,now()) on conflict (user_id) do nothing;
  select epoch.visibility_epoch into v_epoch
  from public.cloud_user_catalog_visibility_epochs epoch
  where epoch.user_id = p_user_id for update;
  if v_epoch is distinct from p_user_visibility_epoch
     or not exists (
       select 1
       from public.cloud_source_catalog_heads head
       join public.cloud_source_lifecycle lifecycle
         on lifecycle.source_id = head.source_id
        and lifecycle.user_id = head.user_id
       join public.cloud_source_transitions transition
         on transition.id = v_generation.transition_id
        and transition.user_id = v_generation.user_id
       where head.source_id = p_source_id and head.user_id = p_user_id
         and head.active_generation_id = p_generation_id
         and head.head_revision = p_head_revision
         and lifecycle.config_revision = p_config_revision
         and lifecycle.visibility_epoch = p_source_visibility_epoch
         and transition.state = 'committing'
         and public.norva_source_catalog_visible_internal(
           p_source_id,p_user_id
         )
     ) then
    raise exception 'active title projection marker snapshot CAS failed'
      using errcode = '40001';
  end if;
  if not public.norva_active_catalog_refresh_proof_is_current(
    p_source_id,p_user_id,p_generation_id,p_refresh_run_id,p_job_id
  ) then
    raise exception 'active title projection marker physical proof drifted'
      using errcode = '40001', detail = 'reason=title_inventory_proof_missing';
  end if;
  if exists (
    select 1
    from public.cloud_title_variants variant
    join public.cloud_source_catalog_generation_candidate_titles projection
      on projection.generation_id = variant.generation_id
     and projection.title_id = variant.title_id
    where variant.generation_id = p_generation_id
      and variant.source_id = p_source_id and variant.user_id = p_user_id
      and not projection.post_switch_refreshed
    limit 1
  ) then
    raise exception 'active title projection refresh is incomplete'
      using errcode = '55000',
        detail = 'reason=post_switch_title_projection_incomplete';
  end if;
  update public.cloud_source_catalog_generations generation
  set title_projection_refreshed_at = v_refreshed_at,
      revision = generation.revision + 1,
      updated_at = v_refreshed_at
  where generation.id = p_generation_id;
  return jsonb_build_object(
    'contract','catalog-title-active-projection-marker-v1',
    'generationId',p_generation_id,'refreshRunId',p_refresh_run_id,
    'jobId',p_job_id,'leaseSequence',p_lease_sequence,
    'visibilityEpoch',v_epoch,
    'refreshedAt',v_refreshed_at,'complete',true
  );
end
$function$;

revoke all on function public.norva_mark_active_catalog_title_projection_refreshed(
  uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint
) from public,anon,authenticated,service_role;
grant execute on function public.norva_mark_active_catalog_title_projection_refreshed(
  uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint
) to service_role;

do $assert$
begin
  if not exists (
       select 1 from pg_catalog.pg_attribute attribute
       where attribute.attrelid =
         'public.cloud_source_catalog_generations'::regclass
         and attribute.attname = 'title_projection_refreshed_at'
         and attribute.atttypid = 'timestamptz'::regtype
         and attribute.attnum > 0 and not attribute.attisdropped
         and not attribute.attnotnull and not attribute.atthasdef
     )
     or not exists (
       select 1
       from pg_catalog.pg_attribute attribute
       join pg_catalog.pg_attrdef default_value
         on default_value.adrelid = attribute.attrelid
        and default_value.adnum = attribute.attnum
       where attribute.attrelid =
         'public.cloud_source_catalog_generation_candidate_titles'::regclass
         and attribute.attname = 'post_switch_refreshed'
         and attribute.atttypid = 'boolean'::regtype
         and attribute.attnum > 0 and not attribute.attisdropped
         and attribute.attnotnull and attribute.atthasdef
         and pg_catalog.pg_get_expr(
           default_value.adbin, default_value.adrelid
         ) = 'false'
     )
     or not public.norva_catalog_title_active_payload_indexes_ready()
     or not has_function_privilege(
       'service_role',
       'public.norva_begin_active_catalog_title_projection_refresh(uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'service_role',
       'public.norva_upsert_active_catalog_title_payloads(uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,jsonb)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'service_role',
       'public.norva_upsert_active_catalog_media_items(uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,bigint,jsonb)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'service_role',
       'public.norva_upsert_active_catalog_refresh_categories(uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,text,jsonb)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'service_role',
       'public.norva_upsert_active_catalog_title_variants(uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,bigint,jsonb)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'service_role',
       'public.norva_confirm_active_catalog_title_projection_batch(uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,jsonb)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'service_role',
       'public.norva_upsert_active_catalog_live_materialization(uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,bigint,jsonb,jsonb)',
       'EXECUTE'
     )
      or has_function_privilege(
        'service_role',
        'public.norva_complete_active_catalog_title_refresh_action(uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,text,bigint,bigint)',
        'EXECUTE'
      )
      or not has_function_privilege(
        'service_role',
        'public.norva_prune_active_catalog_refresh_action_batch(uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,bigint,text,bigint,integer)',
        'EXECUTE'
      )
      or not has_function_privilege(
        'service_role',
        'public.norva_checkpoint_active_catalog_title_refresh(uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,bigint,jsonb,boolean,integer)',
        'EXECUTE'
      )
     or not has_function_privilege(
       'service_role',
       'public.norva_reconcile_active_catalog_title_projection_batch(uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,integer)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'service_role',
       'public.norva_mark_active_catalog_title_projection_refreshed(uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint)',
       'EXECUTE'
     )
     or has_function_privilege(
       'authenticated',
       'public.norva_upsert_active_catalog_title_payloads(uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,jsonb)',
       'EXECUTE'
     )
      or has_function_privilege(
        'anon',
        'public.norva_reconcile_active_catalog_title_projection_batch(uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,integer)',
        'EXECUTE'
      )
      or has_function_privilege(
        'authenticated',
        'public.norva_checkpoint_active_catalog_title_refresh(uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,bigint,jsonb,boolean,integer)',
        'EXECUTE'
      )
      or has_function_privilege(
        'authenticated',
        'public.norva_prune_active_catalog_refresh_action_batch(uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,bigint,text,bigint,integer)',
        'EXECUTE'
      )
     or has_function_privilege(
       'service_role',
       'public.norva_lock_active_catalog_refresh_lease(uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint)',
       'EXECUTE'
     )
     or has_function_privilege(
       'service_role',
       'public.norva_active_catalog_refresh_proof_is_current(uuid,uuid,uuid,uuid,uuid)',
       'EXECUTE'
     )
     or has_function_privilege(
       'service_role',
       'public.norva_require_active_catalog_refresh_action(uuid,uuid,text,bigint)',
       'EXECUTE'
     )
     or has_function_privilege(
       'service_role',
       'public.norva_adopt_active_catalog_refresh_epoch(uuid,uuid,bigint,bigint)',
       'EXECUTE'
     ) then
    raise exception 'active catalog title payload writer contract drift'
      using errcode = '55000';
  end if;
end
$assert$;

commit;
