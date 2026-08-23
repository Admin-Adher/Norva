begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

create or replace function public.norva_catalog_background_owner_baseline_current(
  p_user_id uuid
) returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select p_user_id is not null and exists (
    select 1
    from public.cloud_catalog_background_owner_pointers pointer
    join public.cloud_catalog_background_owner_snapshots snapshot
      on snapshot.id = pointer.active_snapshot_id
     and snapshot.user_id = pointer.user_id
     and snapshot.state = 'active'
    join public.cloud_catalog_background_owner_topology_revisions topology
      on topology.user_id = pointer.user_id
     and topology.revision = snapshot.topology_revision
    where pointer.user_id = p_user_id
      and not exists (
        select head.source_id,head.active_generation_id
        from public.cloud_source_catalog_heads head
        where head.user_id = p_user_id
          and public.norva_source_catalog_visible_internal(
            head.source_id,p_user_id
          )
        except
        select source_map.source_id,source_map.generation_id
        from public.cloud_catalog_background_owner_snapshot_sources source_map
        where source_map.snapshot_id = snapshot.id
      )
      and not exists (
        select source_map.source_id,source_map.generation_id
        from public.cloud_catalog_background_owner_snapshot_sources source_map
        where source_map.snapshot_id = snapshot.id
        except
        select head.source_id,head.active_generation_id
        from public.cloud_source_catalog_heads head
        where head.user_id = p_user_id
          and public.norva_source_catalog_visible_internal(
            head.source_id,p_user_id
          )
      )
  );
$function$;

create or replace function public.norva_catalog_background_owner_candidate_current(
  p_transition_id uuid,
  p_user_id uuid
) returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.cloud_source_transitions transition
    join public.cloud_catalog_background_owner_build_jobs job
      on job.transition_id = transition.id
     and job.user_id = transition.user_id
     and job.job_kind = 'candidate'
     and job.state = 'completed'
    join public.cloud_catalog_background_owner_snapshots snapshot
      on snapshot.id = job.snapshot_id
     and snapshot.transition_id = transition.id
     and snapshot.user_id = transition.user_id
     and snapshot.snapshot_kind = 'candidate'
     and snapshot.state = 'ready'
    where transition.id = p_transition_id
      and transition.user_id = p_user_id
      and public.norva_catalog_background_owner_snapshot_ready(
        transition.id,transition.user_id,
        transition.candidate_catalog_generation_id,
        transition.previous_catalog_generation_id
      )
  );
$function$;

-- Once the workflow schema exists, topology invalidation durably queues the
-- replacement before it locks walkers/snapshots.  The shared order is job ->
-- checkpoint -> snapshot; a slice already holding the job can therefore
-- finish or fail before the topology transaction continues, never deadlock.
create or replace function public.norva_mark_catalog_background_owner_stale(
  p_user_id uuid
) returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_has_pointer boolean := false;
begin
  if p_user_id is null then
    raise exception 'catalog background stale user is required'
      using errcode = '22004';
  end if;
  if position(
    '|' || p_user_id::text || '|'
    in coalesce(current_setting(
      'norva.catalog_background_owner_deleted_users',true
    ),'')
  ) > 0 then
    return;
  end if;
  -- This function is reached from BEFORE ROW topology triggers after the
  -- source/lifecycle/head tuple may already be locked.  It must not insert a
  -- job or a topology/epoch parent row here: those FK checks would wait on
  -- auth.users while account deletion owns auth.users and waits on that tuple.
  -- The stale active snapshot is itself the durable rebuild marker; discovery
  -- materializes it into a job later under the account-first order.
  perform 1
  from public.cloud_catalog_background_mode_checkpoints checkpoint
  where checkpoint.owner_user_id = p_user_id
  order by checkpoint.mode
  for update nowait;
  perform 1
  from public.cloud_catalog_background_owner_pointers pointer
  where pointer.user_id = p_user_id
  for update;
  v_has_pointer := found;
  perform 1
  from public.cloud_user_catalog_visibility_epochs epoch
  where epoch.user_id = p_user_id
  for update;
  -- Revalidate after the checkpoint/pointer/epoch waits.  A candidate
  -- finalizer that won those locks may have committed READY_TO_SWITCH after
  -- the topology DML statement began; allowing that older statement to stale
  -- the proof afterwards would strand a ready transition on a stale version.
  if exists (
    select 1
    from public.cloud_source_transitions transition
    where transition.user_id = p_user_id
      and transition.transition_kind = 'credential'
      and transition.state in ('ready_to_switch','committing')
  ) then
    raise exception 'user catalog topology is fenced during credential cutover'
      using errcode = '40001';
  end if;
  update public.cloud_catalog_background_owner_topology_revisions topology
  set revision = topology.revision + 1,updated_at = now()
  where topology.user_id = p_user_id;
  if v_has_pointer and not found then
    raise exception 'catalog background topology revision is missing'
      using errcode = '40001';
  end if;
  update public.cloud_catalog_background_mode_checkpoints checkpoint
  set owner_user_id = null,snapshot_id = null,user_visibility_epoch = null,
      last_attempted_at = null,last_title_id = null,
      inflight_items = '[]'::jsonb,
      inflight_last_attempted_at = null,inflight_last_title_id = null,
      inflight_owner_exhausted = false,inflight_byte_count = 0,
      revision = checkpoint.revision + 1,updated_at = now()
  where checkpoint.owner_user_id = p_user_id;
  update public.cloud_catalog_background_owner_snapshots snapshot
  set state = 'stale',stale_at = coalesce(snapshot.stale_at,now()),
      revision = snapshot.revision + 1,updated_at = now()
  where snapshot.user_id = p_user_id
    and snapshot.state in ('building','ready','active','retained');
end
$function$;

create or replace function public.norva_discover_catalog_background_owner_jobs(
  p_limit integer default 100
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_cursor public.cloud_catalog_background_owner_discovery_cursors%rowtype;
  v_keys uuid[];
  v_scanned integer;
  v_baseline_enqueued integer := 0;
  v_new_baseline_enqueued integer := 0;
  v_candidate_enqueued integer := 0;
  v_gc_enqueued integer := 0;
begin
  perform public.norva_credential_require_service_role();
  if p_limit is null or p_limit not between 1 and 500 then
    raise exception 'catalog background discovery limit is invalid'
      using errcode = '22023';
  end if;

  -- Stale active versions are the per-user durable rebuild outbox.  Read the
  -- bounded keyset optimistically, lock accounts in UUID order, then insert
  -- jobs.  This avoids both the global discovery-cursor latency and the
  -- topology-row -> auth.users cleanup inversion.
  select coalesce(array_agg(page.user_id order by page.user_id),'{}'::uuid[])
    into v_keys
  from (
    select pointer.user_id
    from public.cloud_catalog_background_owner_pointers pointer
    join public.cloud_catalog_background_owner_snapshots snapshot
      on snapshot.id = pointer.active_snapshot_id
     and snapshot.user_id = pointer.user_id
    where snapshot.state = 'stale'
    order by pointer.user_id
    limit p_limit
  ) page;
  perform 1
  from auth.users account
  where account.id = any(v_keys)
  order by account.id
  for key share;
  insert into public.cloud_catalog_background_owner_build_jobs (
    user_id,job_kind,state,available_at
  )
  select account.id,'baseline','pending',now()
  from auth.users account
  where account.id = any(v_keys)
  on conflict (user_id,job_kind)
    where state in ('pending','processing')
      and job_kind in ('baseline','gc') do nothing;
  get diagnostics v_baseline_enqueued = row_count;

  select cursor.* into v_cursor
  from public.cloud_catalog_background_owner_discovery_cursors cursor
  where cursor.discovery_kind = 'baseline'
  for update;
  select coalesce(array_agg(page.user_id order by page.user_id),'{}'::uuid[])
    into v_keys
  from (
    select population.user_id
    from (
      select source.user_id
      from public.cloud_sources source
      where (v_cursor.last_key is null or source.user_id > v_cursor.last_key)
        and exists (
          select 1 from public.cloud_source_catalog_heads head
          where head.source_id = source.id and head.user_id = source.user_id
        )
      union
      select pointer.user_id
      from public.cloud_catalog_background_owner_pointers pointer
      where v_cursor.last_key is null or pointer.user_id > v_cursor.last_key
    ) population
    group by population.user_id
    order by population.user_id
    limit p_limit
  ) page;
  v_scanned := cardinality(v_keys);
  insert into public.cloud_user_catalog_visibility_epochs(
    user_id,visibility_epoch,updated_at
  )
  select candidate.user_id,1,now()
  from unnest(v_keys) candidate(user_id)
  on conflict (user_id) do nothing;
  insert into public.cloud_catalog_background_owner_topology_revisions(
    user_id,revision,updated_at
  )
  select candidate.user_id,0,now()
  from unnest(v_keys) candidate(user_id)
  on conflict (user_id) do nothing;
  insert into public.cloud_catalog_background_owner_build_jobs (
    user_id,job_kind,state,expected_visibility_epoch,
    expected_topology_revision,available_at
  )
  select candidate.user_id,'baseline','pending',epoch.visibility_epoch,
         coalesce(topology.revision,0),now()
  from unnest(v_keys) candidate(user_id)
  join public.cloud_user_catalog_visibility_epochs epoch
    on epoch.user_id = candidate.user_id
  left join public.cloud_catalog_background_owner_topology_revisions topology
    on topology.user_id = candidate.user_id
  where not public.norva_catalog_background_owner_baseline_current(
    candidate.user_id
  )
  on conflict (user_id,job_kind)
    where state in ('pending','processing')
      and job_kind in ('baseline','gc') do nothing;
  get diagnostics v_new_baseline_enqueued = row_count;
  v_baseline_enqueued :=
    v_baseline_enqueued + v_new_baseline_enqueued;
  update public.cloud_catalog_background_owner_discovery_cursors cursor
  set last_key = case when v_scanned < p_limit then null
        else v_keys[v_scanned] end,
      revision = cursor.revision + 1,updated_at = now()
  where cursor.discovery_kind = 'baseline';

  select cursor.* into v_cursor
  from public.cloud_catalog_background_owner_discovery_cursors cursor
  where cursor.discovery_kind = 'candidate'
  for update;
  select coalesce(array_agg(page.id order by page.id),'{}'::uuid[])
    into v_keys
  from (
    select transition.id
    from public.cloud_source_transitions transition
    join public.cloud_source_catalog_generations generation
      on generation.id = transition.candidate_catalog_generation_id
     and generation.transition_id = transition.id
     and generation.user_id = transition.user_id
    where (v_cursor.last_key is null or transition.id > v_cursor.last_key)
      and transition.transition_kind = 'credential'
      and transition.state = 'importing'
      and transition.identity_decision = 'same_catalog'
      and generation.state = 'ready'
      and generation.gateway_complete_at is not null
      and generation.manifest_checksum is not null
    order by transition.id
    limit p_limit
  ) page;
  v_scanned := cardinality(v_keys);
  insert into public.cloud_catalog_background_owner_build_jobs (
    user_id,job_kind,transition_id,base_snapshot_id,
    replace_source_id,replace_generation_id,state,
    expected_visibility_epoch,expected_topology_revision,available_at
  )
  select transition.user_id,'candidate',transition.id,
         pointer.active_snapshot_id,transition.old_source_id,
         transition.candidate_catalog_generation_id,'pending',
         epoch.visibility_epoch,topology.revision,now()
  from unnest(v_keys) candidate(id)
  join public.cloud_source_transitions transition on transition.id = candidate.id
  join public.cloud_catalog_background_owner_pointers pointer
    on pointer.user_id = transition.user_id
  join public.cloud_user_catalog_visibility_epochs epoch
    on epoch.user_id = transition.user_id
  join public.cloud_catalog_background_owner_topology_revisions topology
    on topology.user_id = transition.user_id
  where public.norva_catalog_background_owner_baseline_current(
          transition.user_id
        )
    and not public.norva_catalog_background_owner_candidate_current(
      transition.id,transition.user_id
    )
  on conflict (transition_id,job_kind)
    where state in ('pending','processing') and job_kind = 'candidate'
    do nothing;
  get diagnostics v_candidate_enqueued = row_count;
  update public.cloud_catalog_background_owner_discovery_cursors cursor
  set last_key = case when v_scanned < p_limit then null
        else v_keys[v_scanned] end,
      revision = cursor.revision + 1,updated_at = now()
  where cursor.discovery_kind = 'candidate';

  select cursor.* into v_cursor
  from public.cloud_catalog_background_owner_discovery_cursors cursor
  where cursor.discovery_kind = 'gc'
  for update;
  select coalesce(array_agg(page.id order by page.id),'{}'::uuid[])
    into v_keys
  from (
    select snapshot.id
    from public.cloud_catalog_background_owner_snapshots snapshot
    where (v_cursor.last_key is null or snapshot.id > v_cursor.last_key)
      and snapshot.state in ('stale','purging')
      and coalesce(snapshot.purge_after,'-infinity'::timestamptz) <= now()
    order by snapshot.id
    limit p_limit
  ) page;
  v_scanned := cardinality(v_keys);
  insert into public.cloud_catalog_background_owner_build_jobs (
    user_id,job_kind,state,available_at
  )
  select distinct snapshot.user_id,'gc','pending',now()
  from unnest(v_keys) candidate(id)
  join public.cloud_catalog_background_owner_snapshots snapshot
    on snapshot.id = candidate.id
  on conflict (user_id,job_kind)
    where state in ('pending','processing')
      and job_kind in ('baseline','gc') do nothing;
  get diagnostics v_gc_enqueued = row_count;
  update public.cloud_catalog_background_owner_discovery_cursors cursor
  set last_key = case when v_scanned < p_limit then null
        else v_keys[v_scanned] end,
      revision = cursor.revision + 1,updated_at = now()
  where cursor.discovery_kind = 'gc';

  return jsonb_build_object(
    'contract','catalog-background-owner-workflow-v1',
    'baselineEnqueued',v_baseline_enqueued,
    'candidateEnqueued',v_candidate_enqueued,
    'gcEnqueued',v_gc_enqueued,
    'pageLimit',p_limit
  );
end
$function$;

create or replace function public.norva_claim_catalog_background_owner_build_jobs(
  p_worker text,
  p_limit integer default 10,
  p_lease_seconds integer default 120
) returns table (
  job_id uuid,
  user_id uuid,
  job_kind text,
  transition_id uuid,
  snapshot_id uuid,
  base_snapshot_id uuid,
  replace_source_id uuid,
  replace_generation_id uuid,
  lease_sequence integer,
  checkpoint_revision bigint,
  expected_snapshot_revision bigint,
  expected_visibility_epoch bigint,
  expected_topology_revision bigint,
  failure_attempt_count integer,
  lease_until timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform public.norva_credential_require_service_role();
  if nullif(btrim(p_worker),'') is null or length(p_worker) > 160
     or p_worker ~ '[[:cntrl:]]'
     or p_limit is null or p_limit not between 1 and 50
     or p_lease_seconds is null or p_lease_seconds not between 30 and 600 then
    raise exception 'catalog background owner claim arguments are invalid'
      using errcode = '22023';
  end if;

  perform public.norva_discover_catalog_background_owner_jobs(
    least(500,greatest(50,p_limit * 5))
  );

  update public.cloud_catalog_background_owner_build_jobs job
  set state = 'dead',lease_owner = null,lease_until = null,
      last_error_code = 'lease_expired',dead_at = now(),updated_at = now()
  where job.state = 'processing' and job.lease_until <= now()
    and job.failure_attempt_count >= job.max_attempts;

  update public.cloud_catalog_background_owner_build_jobs job
  set state = 'dead',lease_owner = null,lease_until = null,
      last_error_code = 'transition_cancelled',dead_at = now(),updated_at = now()
  from public.cloud_source_transitions transition
  where job.job_kind = 'candidate'
    and job.transition_id = transition.id
    and job.user_id = transition.user_id
    and job.state in ('pending','processing')
    and transition.state in ('completed','failed','cancelled');

  return query
  with candidates as (
    select job.id
    from public.cloud_catalog_background_owner_build_jobs job
    where (
      job.state = 'pending' and job.available_at <= now()
    ) or (
      job.state = 'processing' and job.lease_until <= now()
      and job.failure_attempt_count < job.max_attempts
    )
    order by job.available_at,job.created_at,job.id
    for update skip locked
    limit p_limit
  ), claimed as (
    update public.cloud_catalog_background_owner_build_jobs job
    set state = 'processing',
        failure_attempt_count = job.failure_attempt_count +
          case when job.state = 'processing' then 1 else 0 end,
        lease_sequence = job.lease_sequence + 1,
        lease_owner = btrim(p_worker),
        lease_until = now() + make_interval(secs => p_lease_seconds),
        last_error_code = case when job.state = 'processing'
          then 'lease_expired' else job.last_error_code end,
        updated_at = now()
    from candidates
    where job.id = candidates.id
    returning job.*
  )
  select claimed.id,claimed.user_id,claimed.job_kind,
         claimed.transition_id,claimed.snapshot_id,claimed.base_snapshot_id,
         claimed.replace_source_id,claimed.replace_generation_id,
         claimed.lease_sequence,claimed.checkpoint_revision,
         claimed.expected_snapshot_revision,
         claimed.expected_visibility_epoch,
         claimed.expected_topology_revision,
         claimed.failure_attempt_count,claimed.lease_until
  from claimed;
end
$function$;

create or replace function public.norva_checkpoint_catalog_background_owner_build_job(
  p_job_id uuid,
  p_worker text,
  p_expected_lease_sequence integer,
  p_expected_checkpoint_revision bigint,
  p_retry_after_seconds integer default 0
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_job public.cloud_catalog_background_owner_build_jobs%rowtype;
begin
  perform public.norva_credential_require_service_role();
  if p_retry_after_seconds is null or p_retry_after_seconds not between 0 and 300
     or nullif(btrim(p_worker),'') is null then
    raise exception 'catalog background owner checkpoint arguments are invalid'
      using errcode = '22023';
  end if;
  select job.* into v_job
  from public.cloud_catalog_background_owner_build_jobs job
  where job.id = p_job_id
  for update;
  if not found or v_job.state <> 'processing'
     or v_job.lease_owner is distinct from btrim(p_worker)
     or v_job.lease_sequence <> p_expected_lease_sequence
     or v_job.checkpoint_revision <> p_expected_checkpoint_revision
     or v_job.lease_until <= now() then
    raise exception 'catalog background owner checkpoint lease CAS failed'
      using errcode = '40001';
  end if;
  update public.cloud_catalog_background_owner_build_jobs job
  set state = 'pending',lease_owner = null,lease_until = null,
      available_at = now() + make_interval(secs => p_retry_after_seconds),
      checkpoint_revision = job.checkpoint_revision + 1,
      last_error_code = null,updated_at = now()
  where job.id = p_job_id
  returning * into v_job;
  return jsonb_build_object(
    'contract','catalog-background-owner-workflow-v1',
    'jobId',v_job.id,'state','pending',
    'checkpointRevision',v_job.checkpoint_revision,
    'failureAttemptCount',v_job.failure_attempt_count,
    'retryAfterSeconds',p_retry_after_seconds
  );
end
$function$;

-- Rolling bridge for Edge versions that still ask to mark the credential
-- transition ready immediately after the SAME decision.  Missing owner work is
-- a durable defer, not a terminal worker fault: enqueue the exact baseline or
-- candidate continuation and return the still-IMPORTING transition.  The last
-- candidate slice below commits its job proof and READY_TO_SWITCH atomically.
create or replace function public.norva_mark_credential_transition_ready(
  p_transition_id uuid,
  p_user_id uuid,
  p_readiness_check_id uuid,
  p_expected_transition_revision bigint
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_transition public.cloud_source_transitions%rowtype;
  v_generation public.cloud_source_catalog_generations%rowtype;
  v_owner_job public.cloud_catalog_background_owner_build_jobs%rowtype;
  v_pointer public.cloud_catalog_background_owner_pointers%rowtype;
  v_base_snapshot public.cloud_catalog_background_owner_snapshots%rowtype;
  v_candidate_snapshot public.cloud_catalog_background_owner_snapshots%rowtype;
  v_epoch bigint;
  v_topology_revision bigint;
begin
  perform public.norva_credential_require_service_role();
  perform public.norva_credential_require_enabled();
  if p_readiness_check_id is null then
    raise exception 'readiness proof is required' using errcode = '22004';
  end if;
  -- Account cleanup owns the auth row before cascading into transitions and
  -- workflow jobs.  Take the compatible parent lock first so a direct legacy
  -- readiness call cannot invert transition/job -> auth against that cascade.
  perform 1
  from auth.users account
  where account.id = p_user_id
  for key share;
  if not found then
    raise exception 'credential account no longer exists'
      using errcode = '40001';
  end if;
  select transition.* into v_transition
  from public.cloud_source_transitions transition
  where transition.id = p_transition_id and transition.user_id = p_user_id
  for update;
  if not found then
    raise exception 'credential transition not found' using errcode = 'P0002';
  end if;
  if v_transition.state <> 'importing'
     or v_transition.identity_decision <> 'same_catalog'
     or v_transition.revision <> p_expected_transition_revision then
    raise exception 'credential readiness CAS failed or identity is not SAME_CATALOG'
      using errcode = '40001';
  end if;
  if not exists (
    select 1 from public.cloud_source_identity_assessments assessment
    where assessment.transition_id = p_transition_id
      and assessment.user_id = p_user_id
      and assessment.final_decision = 'same_catalog'
      and assessment.decided_at is not null
  ) then
    raise exception 'final SAME_CATALOG assessment is required'
      using errcode = '55000';
  end if;
  select generation.* into v_generation
  from public.cloud_source_catalog_generations generation
  where generation.id = v_transition.candidate_catalog_generation_id
    and generation.transition_id = p_transition_id
    and generation.user_id = p_user_id;
  if not found or v_generation.state <> 'ready'
     or v_generation.gateway_complete_at is null
     or v_generation.manifest_checksum is null then
    raise exception 'complete sealed candidate generation is required'
      using errcode = '55000';
  end if;

  select job.* into v_owner_job
  from public.cloud_catalog_background_owner_build_jobs job
  where job.transition_id = p_transition_id
    and job.user_id = p_user_id
    and job.job_kind = 'candidate'
    and job.state = 'completed'
  order by job.completed_at desc nulls last,job.id
  limit 1
  for update;
  if not found or not public.norva_catalog_background_owner_candidate_current(
       p_transition_id,p_user_id
     ) then
    if public.norva_catalog_background_owner_baseline_current(p_user_id) then
      select pointer.* into v_pointer
      from public.cloud_catalog_background_owner_pointers pointer
      where pointer.user_id = p_user_id;
      select epoch.visibility_epoch,topology.revision
        into v_epoch,v_topology_revision
      from public.cloud_user_catalog_visibility_epochs epoch
      join public.cloud_catalog_background_owner_topology_revisions topology
        on topology.user_id = epoch.user_id
      where epoch.user_id = p_user_id;
      insert into public.cloud_catalog_background_owner_build_jobs (
        user_id,job_kind,transition_id,base_snapshot_id,
        replace_source_id,replace_generation_id,state,
        expected_visibility_epoch,expected_topology_revision,available_at
      ) values (
        p_user_id,'candidate',p_transition_id,v_pointer.active_snapshot_id,
        v_transition.old_source_id,
        v_transition.candidate_catalog_generation_id,'pending',
        v_epoch,v_topology_revision,now()
      ) on conflict (transition_id,job_kind)
        where state in ('pending','processing') and job_kind = 'candidate'
        do nothing;
    else
      insert into public.cloud_catalog_background_owner_build_jobs (
        user_id,job_kind,state,available_at
      ) values (p_user_id,'baseline','pending',now())
      on conflict (user_id,job_kind)
        where state in ('pending','processing')
          and job_kind in ('baseline','gc') do nothing;
    end if;
    return public.norva_credential_transition_result(
      p_transition_id,p_user_id
    ) || jsonb_build_object(
      'ownerSnapshotDeferred',true,
      'ownerWorkflowContract','catalog-background-owner-workflow-v1'
    );
  end if;

  perform 1
  from public.cloud_catalog_background_mode_checkpoints checkpoint
  where checkpoint.owner_user_id = p_user_id
  order by checkpoint.mode
  for update;
  select pointer.* into v_pointer
  from public.cloud_catalog_background_owner_pointers pointer
  where pointer.user_id = p_user_id
  for update;
  select epoch.visibility_epoch into v_epoch
  from public.cloud_user_catalog_visibility_epochs epoch
  where epoch.user_id = p_user_id
  for update;
  select topology.revision into v_topology_revision
  from public.cloud_catalog_background_owner_topology_revisions topology
  where topology.user_id = p_user_id
  for update;
  select snapshot.* into v_base_snapshot
  from public.cloud_catalog_background_owner_snapshots snapshot
  where snapshot.id = v_pointer.active_snapshot_id
    and snapshot.user_id = p_user_id
  for update;
  select snapshot.* into v_candidate_snapshot
  from public.cloud_catalog_background_owner_snapshots snapshot
  where snapshot.id = v_owner_job.snapshot_id
    and snapshot.transition_id = p_transition_id
    and snapshot.user_id = p_user_id
    and snapshot.snapshot_kind = 'candidate'
  for update;
  if v_pointer.active_snapshot_id is null
     or v_epoch is null
     or v_topology_revision is null
     or v_owner_job.snapshot_id is null
     or v_owner_job.base_snapshot_id <> v_base_snapshot.id
     or v_owner_job.replace_source_id <> v_transition.old_source_id
     or v_owner_job.replace_generation_id <>
          v_transition.candidate_catalog_generation_id
     or v_base_snapshot.state <> 'active'
     or v_candidate_snapshot.state <> 'ready'
     or v_candidate_snapshot.base_snapshot_id <> v_base_snapshot.id
     or v_candidate_snapshot.topology_revision <> v_topology_revision
     or v_base_snapshot.topology_revision <> v_topology_revision
     or not public.norva_catalog_background_owner_snapshot_ready(
       p_transition_id,p_user_id,
       v_transition.candidate_catalog_generation_id,
       v_transition.previous_catalog_generation_id
     ) then
    raise exception 'credential readiness owner snapshot CAS failed'
      using errcode = '40001';
  end if;

  update public.cloud_source_transitions
  set state = 'ready_to_switch',
      -- The legacy UUID remains an input-shape/idempotency compatibility
      -- token only.  Persist the DB-certified owner snapshot so every later
      -- swap/replay can name and audit the exact readiness proof.
      readiness_check_id = v_owner_job.snapshot_id,
      readiness_passed_at = now()
  where id = p_transition_id;
  insert into public.cloud_source_lifecycle_events (
    user_id,source_id,transition_id,event_kind,idempotency_key,payload,actor
  ) values (
    p_user_id,v_transition.old_source_id,p_transition_id,
    'credential_transition_ready',
    'credential-transition:' || p_transition_id::text || ':ready',
    jsonb_build_object('ownerSnapshotId',v_owner_job.snapshot_id),'service_role'
  ) on conflict (user_id,idempotency_key) do nothing;
  return public.norva_credential_transition_result(p_transition_id,p_user_id);
end
$function$;

create or replace function public.norva_run_catalog_background_owner_build_job_slice(
  p_job_id uuid,
  p_worker text,
  p_expected_lease_sequence integer,
  p_expected_checkpoint_revision bigint,
  p_limit integer default 2000
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_identity record;
  v_job public.cloud_catalog_background_owner_build_jobs%rowtype;
  v_transition public.cloud_source_transitions%rowtype;
  v_snapshot public.cloud_catalog_background_owner_snapshots%rowtype;
  v_pointer public.cloud_catalog_background_owner_pointers%rowtype;
  v_epoch bigint;
  v_topology_revision bigint;
  v_result jsonb;
  v_transition_result jsonb;
  v_complete boolean := false;
  v_has_transition boolean := false;
  v_built_page boolean := false;
begin
  perform public.norva_credential_require_service_role();
  if p_job_id is null or nullif(btrim(p_worker),'') is null
     or p_limit is null or p_limit not between 100 and 5000 then
    raise exception 'catalog background owner slice arguments are invalid'
      using errcode = '22023';
  end if;

  select job.job_kind,job.transition_id,job.user_id
    into v_identity
  from public.cloud_catalog_background_owner_build_jobs job
  where job.id = p_job_id;
  if not found then
    raise exception 'catalog background owner job not found'
      using errcode = 'P0002';
  end if;
  -- Account deletion locks auth.users before cascading to jobs/snapshots.  Take
  -- the matching KEY SHARE before transition/job locks so a first slice can
  -- never hold a job while waiting on the account FK.
  perform 1
  from auth.users account
  where account.id = v_identity.user_id
  for key share;
  if not found then
    raise exception 'catalog background owner job account CAS failed'
      using errcode = '40001';
  end if;
  -- Candidate work follows the transition -> job order used by every
  -- credential terminal path.  Baseline/GC jobs have no transition lock.
  if v_identity.job_kind = 'candidate' then
    select transition.* into v_transition
    from public.cloud_source_transitions transition
    where transition.id = v_identity.transition_id
      and transition.user_id = v_identity.user_id
    for update;
    v_has_transition := found;
  end if;
  select job.* into v_job
  from public.cloud_catalog_background_owner_build_jobs job
  where job.id = p_job_id
  for update;
  if v_job.state <> 'processing'
     or v_job.lease_owner is distinct from btrim(p_worker)
     or v_job.lease_sequence <> p_expected_lease_sequence
     or v_job.checkpoint_revision <> p_expected_checkpoint_revision
     or v_job.lease_until <= now() then
    raise exception 'catalog background owner slice lease CAS failed'
      using errcode = '40001';
  end if;

  if v_job.job_kind = 'gc' then
    v_result := public.norva_purge_catalog_background_owner_snapshot_batch(
      v_job.user_id,p_limit
    );
    v_complete := coalesce((v_result ->> 'complete')::boolean,false);
    update public.cloud_catalog_background_owner_build_jobs job
    set state = case when v_complete then 'completed' else 'processing' end,
        checkpoint_revision = job.checkpoint_revision + 1,
        lease_owner = case when v_complete then null else job.lease_owner end,
        lease_until = case when v_complete then null else job.lease_until end,
        completed_at = case when v_complete then now() else null end,
        last_error_code = null,updated_at = now()
    where job.id = v_job.id
    returning * into v_job;
    return jsonb_build_object(
      'contract','catalog-background-owner-workflow-v1',
      'jobId',v_job.id,'jobKind',v_job.job_kind,
      'state',v_job.state,'checkpointRevision',v_job.checkpoint_revision,
      'leaseRetained',not v_complete,'complete',v_complete,
      'result',v_result
    );
  end if;

  insert into public.cloud_user_catalog_visibility_epochs(
    user_id,visibility_epoch,updated_at
  ) values (v_job.user_id,1,now()) on conflict (user_id) do nothing;
  insert into public.cloud_catalog_background_owner_topology_revisions(
    user_id,revision,updated_at
  ) values (v_job.user_id,0,now()) on conflict (user_id) do nothing;
  select epoch.visibility_epoch,topology.revision
    into v_epoch,v_topology_revision
  from public.cloud_user_catalog_visibility_epochs epoch
  join public.cloud_catalog_background_owner_topology_revisions topology
    on topology.user_id = epoch.user_id
  where epoch.user_id = v_job.user_id;

  if v_job.job_kind = 'candidate' then
    if not v_has_transition or v_transition.state <> 'importing'
       or v_transition.identity_decision <> 'same_catalog'
       or v_transition.old_source_id <> v_job.replace_source_id
       or v_transition.candidate_catalog_generation_id
          <> v_job.replace_generation_id
       or not exists (
         select 1 from public.cloud_source_catalog_generations generation
         where generation.id = v_job.replace_generation_id
           and generation.source_id = v_job.replace_source_id
           and generation.user_id = v_job.user_id
           and generation.transition_id = v_job.transition_id
           and generation.state = 'ready'
           and generation.gateway_complete_at is not null
           and generation.manifest_checksum is not null
       ) then
      raise exception 'catalog background candidate job transition CAS failed'
        using errcode = '40001';
    end if;
  end if;

  if v_job.snapshot_id is not null then
    select snapshot.* into v_snapshot
    from public.cloud_catalog_background_owner_snapshots snapshot
    where snapshot.id = v_job.snapshot_id
      and snapshot.user_id = v_job.user_id;
    if not found or v_snapshot.state in ('stale','purging') then
      update public.cloud_catalog_background_owner_build_jobs job
      set snapshot_id = null,expected_snapshot_revision = null,
          expected_visibility_epoch = v_epoch,
          expected_topology_revision = v_topology_revision,
          checkpoint_revision = job.checkpoint_revision + 1,
          last_error_code = 'snapshot_stale',updated_at = now()
      where job.id = v_job.id
      returning * into v_job;
      return jsonb_build_object(
        'contract','catalog-background-owner-workflow-v1',
        'jobId',v_job.id,'jobKind',v_job.job_kind,
        'state','processing','checkpointRevision',v_job.checkpoint_revision,
        'leaseRetained',true,'complete',false,'reset',true,
        'visibilityEpoch',v_epoch,'topologyRevision',v_topology_revision
      );
    end if;
    if v_job.expected_snapshot_revision is distinct from v_snapshot.revision then
      raise exception 'catalog background owner snapshot revision drift'
        using errcode = '40001';
    end if;
  end if;

  if v_job.snapshot_id is null then
    if v_job.job_kind = 'candidate' then
      select pointer.* into v_pointer
      from public.cloud_catalog_background_owner_pointers pointer
      where pointer.user_id = v_job.user_id;
      if not found
         or not public.norva_catalog_background_owner_baseline_current(
           v_job.user_id
         ) then
        raise exception 'catalog background candidate baseline is not current'
          using errcode = '40001';
      end if;
      v_result := public.norva_begin_catalog_background_owner_snapshot(
        v_job.user_id,v_job.transition_id,'candidate',
        v_pointer.active_snapshot_id,v_job.replace_source_id,
        v_job.replace_generation_id,v_epoch
      );
      v_job.base_snapshot_id := v_pointer.active_snapshot_id;
    else
      v_result := public.norva_begin_catalog_background_owner_snapshot(
        v_job.user_id,null,'baseline',null,null,null,v_epoch
      );
    end if;
    update public.cloud_catalog_background_owner_build_jobs job
    set snapshot_id = (v_result ->> 'snapshotId')::uuid,
        base_snapshot_id = case when job.job_kind = 'candidate'
          then v_job.base_snapshot_id else null end,
        expected_snapshot_revision = (v_result ->> 'revision')::bigint,
        expected_visibility_epoch = (v_result ->> 'visibilityEpoch')::bigint,
        expected_topology_revision = (v_result ->> 'topologyRevision')::bigint,
        checkpoint_revision = job.checkpoint_revision + 1,
        last_error_code = null,updated_at = now()
    where job.id = v_job.id
    returning * into v_job;
    return jsonb_build_object(
      'contract','catalog-background-owner-workflow-v1',
      'jobId',v_job.id,'jobKind',v_job.job_kind,
      'state','processing','checkpointRevision',v_job.checkpoint_revision,
      'snapshotId',v_job.snapshot_id,
      'snapshotRevision',v_job.expected_snapshot_revision,
      'visibilityEpoch',v_job.expected_visibility_epoch,
      'topologyRevision',v_job.expected_topology_revision,
      'leaseRetained',true,'complete',false,'result',v_result
    );
  end if;

  if v_snapshot.state = 'building' then
    v_result := public.norva_build_catalog_background_owner_snapshot_slice(
      v_snapshot.id,v_job.user_id,v_snapshot.revision,
      v_snapshot.build_visibility_epoch,p_limit
    );
    v_snapshot.revision := (v_result ->> 'revision')::bigint;
    v_snapshot.state := v_result ->> 'state';
    v_built_page := true;
  else
    v_result := jsonb_build_object(
      'snapshotId',v_snapshot.id,'state',v_snapshot.state,
      'revision',v_snapshot.revision,'replayed',true
    );
  end if;

  -- A non-empty build page owns title KEY SHARE/advisory locks.  Activation
  -- takes the user epoch, while a payload writer reaches that epoch before its
  -- title advisory.  Publish only on the next RPC transaction, when replaying
  -- the already-ready snapshot holds no title lock.
  if v_snapshot.state = 'ready'
     and v_job.job_kind = 'baseline'
     and not v_built_page then
    v_result := public.norva_activate_catalog_background_owner_baseline(
      v_snapshot.id,v_job.user_id,v_snapshot.revision,
      v_snapshot.build_visibility_epoch
    );
    v_snapshot.state := 'active';
    v_snapshot.revision := (v_result ->> 'revision')::bigint;
    v_epoch := (v_result ->> 'visibilityEpoch')::bigint;
  end if;
  if v_snapshot.state = 'ready'
     and v_job.job_kind = 'candidate'
     and not v_built_page then
    -- Final candidate certification is a separate transaction from the last
    -- build page.  Pin the exact account/transition/job already held above,
    -- then checkpoint -> pointer -> epoch -> topology -> candidate snapshot.
    -- A concurrent topology mutation either wins and stales this version, or
    -- waits and is rejected by norva_mark_catalog_background_owner_stale after
    -- READY_TO_SWITCH commits; it can never make a READY proof stale later.
    perform 1
    from public.cloud_catalog_background_mode_checkpoints checkpoint
    where checkpoint.owner_user_id = v_job.user_id
    order by checkpoint.mode
    for update;
    select pointer.* into v_pointer
    from public.cloud_catalog_background_owner_pointers pointer
    where pointer.user_id = v_job.user_id
    for update;
    select epoch.visibility_epoch into v_epoch
    from public.cloud_user_catalog_visibility_epochs epoch
    where epoch.user_id = v_job.user_id
    for update;
    select topology.revision into v_topology_revision
    from public.cloud_catalog_background_owner_topology_revisions topology
    where topology.user_id = v_job.user_id
    for update;
    select snapshot.* into v_snapshot
    from public.cloud_catalog_background_owner_snapshots snapshot
    where snapshot.id = v_job.snapshot_id
      and snapshot.user_id = v_job.user_id
    for update;
    if not found
       or v_pointer.active_snapshot_id is distinct from v_job.base_snapshot_id
       or v_snapshot.state <> 'ready'
       or v_snapshot.revision <> v_job.expected_snapshot_revision
       or v_snapshot.base_snapshot_id <> v_pointer.active_snapshot_id
       or v_snapshot.topology_revision <> v_topology_revision
       or not public.norva_catalog_background_owner_snapshot_ready(
         v_job.transition_id,v_job.user_id,
         v_job.replace_generation_id,
         v_transition.previous_catalog_generation_id
       ) then
      raise exception 'catalog background candidate finalization CAS failed'
        using errcode = '40001';
    end if;
  end if;
  v_complete := (
      v_job.job_kind = 'candidate'
      and v_snapshot.state = 'ready'
      and not v_built_page
    )
    or (v_job.job_kind = 'baseline' and v_snapshot.state = 'active');

  update public.cloud_catalog_background_owner_build_jobs job
  set state = case when v_complete then 'completed' else 'processing' end,
      expected_snapshot_revision = v_snapshot.revision,
      expected_visibility_epoch = v_epoch,
      expected_topology_revision = v_topology_revision,
      checkpoint_revision = job.checkpoint_revision + 1,
      lease_owner = case when v_complete then null else job.lease_owner end,
      lease_until = case when v_complete then null else job.lease_until end,
      completed_at = case when v_complete then now() else null end,
      last_error_code = null,updated_at = now()
  where job.id = v_job.id
  returning * into v_job;
  if v_complete and v_job.job_kind = 'candidate' then
    v_transition_result := public.norva_mark_credential_transition_ready(
      v_job.transition_id,v_job.user_id,v_job.snapshot_id,
      v_transition.revision
    );
    if v_transition_result ->> 'state' <> 'READY_TO_SWITCH' then
      raise exception 'catalog background candidate readiness continuation failed'
        using errcode = '55000';
    end if;
  end if;
  return jsonb_build_object(
    'contract','catalog-background-owner-workflow-v1',
    'jobId',v_job.id,'jobKind',v_job.job_kind,
    'state',v_job.state,'checkpointRevision',v_job.checkpoint_revision,
    'snapshotId',v_job.snapshot_id,
    'snapshotRevision',v_job.expected_snapshot_revision,
    'visibilityEpoch',v_job.expected_visibility_epoch,
    'topologyRevision',v_job.expected_topology_revision,
    'leaseRetained',not v_complete,'complete',v_complete,'result',v_result,
    'activationPending',(
      v_job.job_kind = 'baseline'
      and v_snapshot.state = 'ready'
      and v_built_page
    ),
    'finalizationPending',(
      v_job.job_kind = 'candidate'
      and v_snapshot.state = 'ready'
      and v_built_page
    ),
    'transitionResult',v_transition_result
  );
end
$function$;

create or replace function public.norva_catalog_background_owner_transition_guard()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  if new.transition_kind <> 'credential' then
    return new;
  end if;
  if tg_op = 'INSERT' then return new; end if;
  if new.state in ('ready_to_switch','committing')
     and old.state is distinct from new.state
     and not public.norva_catalog_background_owner_candidate_current(
       new.id,new.user_id
     ) then
    raise exception 'catalog background owner candidate is not ready'
      using errcode = '55000',
        detail = 'reason=catalog_background_owner_candidate_missing';
  end if;
  return new;
end
$function$;

create or replace function public.norva_catalog_background_owner_job_terminal()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  if new.transition_kind = 'credential'
     and new.state in ('completed','failed','cancelled')
     and old.state is distinct from new.state then
    update public.cloud_catalog_background_owner_build_jobs job
    set state = 'dead',lease_owner = null,lease_until = null,
        last_error_code = 'transition_cancelled',dead_at = now(),
        updated_at = now()
    where job.transition_id = new.id and job.user_id = new.user_id
      and job.job_kind = 'candidate'
      and job.state in ('pending','processing');
  end if;
  return null;
end
$function$;

drop trigger if exists trg_cloud_source_transitions_owner_workflow_insert_guard
  on public.cloud_source_transitions;

drop trigger if exists trg_cloud_source_transitions_owner_workflow_state_guard
  on public.cloud_source_transitions;
create trigger trg_cloud_source_transitions_owner_workflow_state_guard
before update of state on public.cloud_source_transitions
for each row when (old.state is distinct from new.state)
execute function public.norva_catalog_background_owner_transition_guard();

drop trigger if exists trg_cloud_source_transitions_zzz_owner_workflow_terminal
  on public.cloud_source_transitions;
create trigger trg_cloud_source_transitions_zzz_owner_workflow_terminal
after update of state on public.cloud_source_transitions
for each row when (old.state is distinct from new.state)
execute function public.norva_catalog_background_owner_job_terminal();

revoke all on function
  public.norva_catalog_background_owner_baseline_current(uuid),
  public.norva_catalog_background_owner_candidate_current(uuid,uuid),
  public.norva_catalog_background_owner_transition_guard(),
  public.norva_catalog_background_owner_job_terminal(),
  public.norva_mark_credential_transition_ready(uuid,uuid,uuid,bigint),
  public.norva_discover_catalog_background_owner_jobs(integer),
  public.norva_claim_catalog_background_owner_build_jobs(text,integer,integer),
  public.norva_checkpoint_catalog_background_owner_build_job(
    uuid,text,integer,bigint,integer
  ),
  public.norva_run_catalog_background_owner_build_job_slice(
    uuid,text,integer,bigint,integer
  )
from public,anon,authenticated,service_role;

grant execute on function
  public.norva_mark_credential_transition_ready(uuid,uuid,uuid,bigint),
  public.norva_discover_catalog_background_owner_jobs(integer),
  public.norva_claim_catalog_background_owner_build_jobs(text,integer,integer),
  public.norva_checkpoint_catalog_background_owner_build_job(
    uuid,text,integer,bigint,integer
  ),
  public.norva_run_catalog_background_owner_build_job_slice(
    uuid,text,integer,bigint,integer
  )
to service_role;

do $assert$
begin
  if not has_function_privilege(
       'service_role',
       'public.norva_claim_catalog_background_owner_build_jobs(text,integer,integer)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'service_role',
       'public.norva_mark_credential_transition_ready(uuid,uuid,uuid,bigint)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'service_role',
       'public.norva_run_catalog_background_owner_build_job_slice(uuid,text,integer,bigint,integer)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'service_role',
       'public.norva_checkpoint_catalog_background_owner_build_job(uuid,text,integer,bigint,integer)',
       'EXECUTE'
     )
     or has_function_privilege(
       'authenticated',
       'public.norva_discover_catalog_background_owner_jobs(integer)',
       'EXECUTE'
     )
     or has_function_privilege(
       'service_role',
       'public.norva_catalog_background_owner_baseline_current(uuid)',
       'EXECUTE'
     )
     or not exists (
       select 1 from pg_catalog.pg_trigger trigger_state
       where trigger_state.tgrelid = 'public.cloud_source_transitions'::regclass
         and trigger_state.tgname =
           'trg_cloud_source_transitions_owner_workflow_state_guard'
         and trigger_state.tgenabled = 'O'
         and not trigger_state.tgisinternal
     ) then
    raise exception 'catalog background owner workflow contract drift'
      using errcode = '55000';
  end if;
end
$assert$;

commit;
