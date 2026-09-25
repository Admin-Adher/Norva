begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

-- An expired provider remains absent from BOTH owner snapshots until a
-- separate successful access check makes the source visible again. Credential
-- rotation must not require a visible entry for a source deliberately hidden
-- by Provider Access. Missing maps for an ordinary visible source still fail.
create or replace function public.norva_catalog_background_owner_source_map_matches(
  p_snapshot_id uuid, p_user_id uuid, p_source_id uuid, p_generation_id uuid
) returns boolean
language sql stable security definer set search_path = ''
as $function$
  select exists (
    select 1
    from public.cloud_catalog_background_owner_snapshots snapshot
    join public.cloud_sources source on source.user_id = snapshot.user_id
    join public.cloud_source_lifecycle lifecycle
      on lifecycle.source_id = source.id and lifecycle.user_id = source.user_id
    join public.cloud_source_catalog_generations generation
      on generation.source_id = source.id and generation.user_id = source.user_id
    join public.cloud_source_provider_access access
      on access.source_id = source.id and access.user_id = source.user_id
    where snapshot.id = p_snapshot_id and snapshot.user_id = p_user_id
      and source.id = p_source_id and generation.id = p_generation_id
      and source.enabled and source.deleted_at is null
      and lifecycle.lifecycle_state = 'active'
      and lifecycle.catalog_visibility = 'visible'
      and (
        (public.norva_source_catalog_visible_internal(source.id, source.user_id)
          and exists (
            select 1 from public.cloud_catalog_background_owner_snapshot_sources map
            where map.snapshot_id = snapshot.id and map.user_id = source.user_id
              and map.source_id = source.id and map.generation_id = generation.id
          ))
        or (not public.norva_source_catalog_visible_internal(source.id, source.user_id)
          and (access.provider_access_status in ('expired_confirmed','access_unavailable_confirmed')
            or (access.provider_access_status = 'restoring'
              and access.provider_access_hidden_at is not null
              and (access.provider_access_restored_at is null
                or access.provider_access_restored_at < access.provider_access_hidden_at)))
          and not exists (
            select 1 from public.cloud_catalog_background_owner_snapshot_sources map
            where map.snapshot_id = snapshot.id and map.source_id = source.id
          ))
      )
  )
$function$;

revoke all on function public.norva_catalog_background_owner_source_map_matches(uuid,uuid,uuid,uuid)
  from public, anon, authenticated;
grant execute on function public.norva_catalog_background_owner_source_map_matches(uuid,uuid,uuid,uuid)
  to service_role;


create or replace function public.norva_begin_catalog_background_owner_snapshot(
  p_user_id uuid,
  p_transition_id uuid,
  p_snapshot_kind text,
  p_base_snapshot_id uuid,
  p_replace_source_id uuid,
  p_replace_generation_id uuid,
  p_expected_visibility_epoch bigint
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_transition public.cloud_source_transitions%rowtype;
  v_generation public.cloud_source_catalog_generations%rowtype;
  v_base public.cloud_catalog_background_owner_snapshots%rowtype;
  v_pointer public.cloud_catalog_background_owner_pointers%rowtype;
  v_snapshot public.cloud_catalog_background_owner_snapshots%rowtype;
  v_has_pointer boolean := false;
  v_has_existing_snapshot boolean := false;
  v_epoch bigint;
  v_topology_revision bigint;
  v_source_count integer;
begin
  perform public.norva_credential_lock_account(p_user_id);
  perform public.norva_credential_require_service_role();
  if p_user_id is null
     or p_snapshot_kind not in ('baseline','candidate')
     or p_expected_visibility_epoch is null
     or p_expected_visibility_epoch < 1
     or (
       p_snapshot_kind = 'baseline'
       and (p_base_snapshot_id is not null
         or p_replace_source_id is not null
         or p_replace_generation_id is not null)
     )
     or (
       p_snapshot_kind = 'candidate'
       and (p_transition_id is null
         or p_base_snapshot_id is null
         or p_replace_source_id is null
         or p_replace_generation_id is null)
     ) then
    raise exception 'invalid catalog background snapshot arguments'
      using errcode = '22023';
  end if;
  perform 1
  from auth.users account
  where account.id = p_user_id
  for key share;
  if not found then
    raise exception 'catalog background snapshot account CAS failed'
      using errcode = 'PT409';
  end if;
  if p_transition_id is not null then
    select transition.* into v_transition
    from public.cloud_source_transitions transition
    where transition.id = p_transition_id
      and transition.user_id = p_user_id
    for update;
    if not found
       or v_transition.identity_decision <> 'same_catalog'
       or v_transition.state not in ('importing','ready_to_switch') then
      raise exception 'catalog background snapshot transition CAS failed'
        using errcode = 'PT409';
    end if;
    select generation.* into v_generation
    from public.cloud_source_catalog_generations generation
    where generation.id = p_replace_generation_id
      and generation.source_id = p_replace_source_id
      and generation.user_id = p_user_id
      and generation.transition_id = p_transition_id
    for share;
  end if;

  -- Every owner workflow uses the same order after any transition/generation
  -- fence: mode checkpoints -> pointer -> visibility epoch -> current snapshot
  -- -> target snapshot.  Payload/membership statement triggers take the epoch
  -- before their relevance scan, so this short epoch fence also closes the
  -- race where a pre-snapshot mutation could otherwise commit after the new
  -- source map had already been copied.
  perform 1
  from public.cloud_catalog_background_mode_checkpoints checkpoint
  where checkpoint.owner_user_id = p_user_id
  order by checkpoint.mode
  for update;
  select pointer.* into v_pointer
  from public.cloud_catalog_background_owner_pointers pointer
  where pointer.user_id = p_user_id
  for update;
  v_has_pointer := found;

  insert into public.cloud_user_catalog_visibility_epochs(
    user_id, visibility_epoch, updated_at
  ) values (p_user_id, 1, now())
  on conflict (user_id) do nothing;
  select epoch.visibility_epoch into v_epoch
  from public.cloud_user_catalog_visibility_epochs epoch
  where epoch.user_id = p_user_id
  for update;
  if v_epoch <> p_expected_visibility_epoch then
    raise exception 'catalog background snapshot visibility CAS failed'
      using errcode = 'PT409';
  end if;

  insert into public.cloud_catalog_background_owner_topology_revisions(
    user_id,revision,updated_at
  ) values (p_user_id,0,now())
  on conflict (user_id) do nothing;
  select topology.revision into v_topology_revision
  from public.cloud_catalog_background_owner_topology_revisions topology
  where topology.user_id = p_user_id
  for update;

  if v_has_pointer then
    select snapshot.* into v_base
    from public.cloud_catalog_background_owner_snapshots snapshot
    where snapshot.id = v_pointer.active_snapshot_id
      and snapshot.user_id = p_user_id
    for update;
  end if;
  select snapshot.* into v_snapshot
  from public.cloud_catalog_background_owner_snapshots snapshot
  where snapshot.transition_id is not distinct from p_transition_id
    and snapshot.snapshot_kind = p_snapshot_kind
    and snapshot.user_id = p_user_id
    and snapshot.state in ('building','ready','active')
  order by case snapshot.state
    when 'building' then 0 when 'ready' then 1 else 2 end,
    snapshot.created_at desc, snapshot.id
  limit 1
  for update;
  v_has_existing_snapshot := found;
  if v_has_existing_snapshot then
    if v_snapshot.base_snapshot_id is distinct from p_base_snapshot_id
       or v_snapshot.replace_source_id is distinct from p_replace_source_id
       or v_snapshot.replace_generation_id
          is distinct from p_replace_generation_id then
      raise exception 'catalog background snapshot replay mismatch'
        using errcode = '22023';
    end if;
    return jsonb_build_object(
      'contract','catalog-background-owner-build-v1',
      'snapshotId',v_snapshot.id,
      'snapshotKind',v_snapshot.snapshot_kind,
      'state',v_snapshot.state,
      'revision',v_snapshot.revision,
      'visibilityEpoch',v_epoch,
      'topologyRevision',v_snapshot.topology_revision,
      'replayed',true
    );
  end if;

  if p_snapshot_kind = 'candidate' then
    if not v_has_pointer
       or v_pointer.active_snapshot_id is distinct from p_base_snapshot_id
       or v_base.state <> 'active'
       or v_generation.state <> 'ready'
       or v_transition.old_source_id <> p_replace_source_id
       or v_transition.candidate_catalog_generation_id
          <> p_replace_generation_id then
      raise exception 'catalog background candidate snapshot CAS failed'
        using errcode = 'PT409';
    end if;
  end if;

  insert into public.cloud_catalog_background_owner_snapshots (
    user_id, transition_id, base_snapshot_id, snapshot_kind,
    replace_source_id, replace_generation_id,
    build_visibility_epoch, applied_visibility_epoch, topology_revision
  ) values (
    p_user_id, p_transition_id, p_base_snapshot_id, p_snapshot_kind,
    p_replace_source_id, p_replace_generation_id, v_epoch, v_epoch,
    v_topology_revision
  ) returning * into v_snapshot;

  insert into public.cloud_catalog_background_owner_snapshot_sources (
    snapshot_id, user_id, source_id, generation_id
  )
  select
    v_snapshot.id,
    p_user_id,
    head.source_id,
    case when head.source_id = p_replace_source_id
      then p_replace_generation_id
      else head.active_generation_id
    end
  from public.cloud_source_catalog_heads head
  where head.user_id = p_user_id
    and public.norva_source_catalog_visible_internal(head.source_id, p_user_id);
  get diagnostics v_source_count = row_count;

  -- Hidden expired sources have no map in either version. The sealed
  -- generation/transition fences above still certify the credentials.
  if p_snapshot_kind = 'candidate' and not
     public.norva_catalog_background_owner_source_map_matches(
       v_snapshot.id,p_user_id,p_replace_source_id,p_replace_generation_id
     ) then
    raise exception 'catalog background snapshot has no exact visible source map'
      using errcode = '55000';
  end if;

  return jsonb_build_object(
    'contract','catalog-background-owner-build-v1',
    'snapshotId',v_snapshot.id,
    'snapshotKind',v_snapshot.snapshot_kind,
    'state',v_snapshot.state,
    'revision',v_snapshot.revision,
    'visibilityEpoch',v_epoch,
    'topologyRevision',v_topology_revision,
    'sourceCount',v_source_count,
    'replayed',false
  );
end
$function$;

create or replace function public.norva_catalog_background_owner_snapshot_ready(
  p_transition_id uuid,
  p_user_id uuid,
  p_candidate_generation_id uuid,
  p_previous_generation_id uuid
) returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.cloud_source_transitions transition
    join public.cloud_catalog_background_owner_pointers pointer
      on pointer.user_id = transition.user_id
    join public.cloud_catalog_background_owner_snapshots baseline
      on baseline.id = pointer.active_snapshot_id
     and baseline.user_id = pointer.user_id
     and baseline.state = 'active'
    join public.cloud_catalog_background_owner_snapshots candidate
      on candidate.transition_id = transition.id
     and candidate.user_id = transition.user_id
     and candidate.snapshot_kind = 'candidate'
     and candidate.state = 'ready'
     and candidate.base_snapshot_id = baseline.id
     and candidate.replace_source_id = transition.old_source_id
     and candidate.replace_generation_id = transition.candidate_catalog_generation_id
    join public.cloud_catalog_background_owner_topology_revisions topology
      on topology.user_id = transition.user_id
     and topology.revision = baseline.topology_revision
     and topology.revision = candidate.topology_revision
    where transition.id = p_transition_id
      and transition.user_id = p_user_id
      and transition.identity_decision = 'same_catalog'
      and transition.candidate_catalog_generation_id = p_candidate_generation_id
      and transition.previous_catalog_generation_id = p_previous_generation_id
      and public.norva_catalog_background_owner_source_map_matches(
        baseline.id,p_user_id,transition.old_source_id,p_previous_generation_id
      )
      and public.norva_catalog_background_owner_source_map_matches(
        candidate.id,p_user_id,transition.old_source_id,p_candidate_generation_id
      )
  )
$function$;

create or replace function public.norva_catalog_background_owner_head_changed()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_transition public.cloud_source_transitions%rowtype;
  v_pointer public.cloud_catalog_background_owner_pointers%rowtype;
  v_current public.cloud_catalog_background_owner_snapshots%rowtype;
  v_target public.cloud_catalog_background_owner_snapshots%rowtype;
  v_epoch bigint;
  v_topology_revision bigint;
  v_direction text;
begin
  if new.active_generation_id is not distinct from old.active_generation_id then
    return null;
  end if;
  -- Credential forward cutover: transition state is set to committing before
  -- the head update.  Compensation reverses the same immutable generation pair.
  select transition.* into v_transition
  from public.cloud_source_transitions transition
  where transition.user_id = new.user_id
    and transition.old_source_id = new.source_id
    and transition.transition_kind = 'credential'
    and transition.state = 'committing'
    and transition.previous_catalog_generation_id = old.active_generation_id
    and transition.candidate_catalog_generation_id = new.active_generation_id
  for share;
  if found then
    v_direction := 'forward';
  else
    select transition.* into v_transition
    from public.cloud_source_transitions transition
    where transition.user_id = new.user_id
      and transition.old_source_id = new.source_id
      and transition.transition_kind = 'credential'
      and transition.state = 'committing'
      and transition.candidate_catalog_generation_id = old.active_generation_id
      and transition.previous_catalog_generation_id = new.active_generation_id
    for share;
    if found then v_direction := 'compensation'; end if;
  end if;
  if v_direction is null then
    -- Non-credential head changes are topology changes.  The BEFORE guard has
    -- already advanced the durable topology revision and staled every version;
    -- no owner pointer may be silently rewritten from this AFTER trigger.
    return null;
  end if;
  if v_direction = 'forward' and exists (
    select 1
    from public.cloud_source_transitions concurrent_transition
    where concurrent_transition.user_id = new.user_id
      and concurrent_transition.transition_kind = 'credential'
      and concurrent_transition.state = 'committing'
      and concurrent_transition.id <> v_transition.id
  ) then
    raise exception 'concurrent user catalog cutover is not allowed'
      using errcode = 'PT409';
  end if;

  perform 1
  from public.cloud_catalog_background_mode_checkpoints checkpoint
  where checkpoint.owner_user_id = new.user_id
  order by checkpoint.mode
  for update;
  select pointer.* into v_pointer
  from public.cloud_catalog_background_owner_pointers pointer
  where pointer.user_id = new.user_id
  for update;
  if not found then
    raise exception 'catalog background owner baseline is missing'
      using errcode = '55000';
  end if;

  -- Common owner order: checkpoints -> pointer -> visibility epoch -> current
  -- snapshot -> target snapshot.  Payload/membership sync takes this epoch
  -- before its relevance scan, making head cutover atomic with owner patches.
  select epoch.visibility_epoch into v_epoch
  from public.cloud_user_catalog_visibility_epochs epoch
  where epoch.user_id = new.user_id
  for update;
  if not found then
    raise exception 'catalog background owner visibility epoch is missing'
      using errcode = 'PT409';
  end if;
  select topology.revision into v_topology_revision
  from public.cloud_catalog_background_owner_topology_revisions topology
  where topology.user_id = new.user_id
  for update;

  select snapshot.* into v_current
  from public.cloud_catalog_background_owner_snapshots snapshot
  where snapshot.id = v_pointer.active_snapshot_id
    and snapshot.user_id = new.user_id
  for update;

  if v_direction = 'forward' then
    select snapshot.* into v_target
    from public.cloud_catalog_background_owner_snapshots snapshot
    where snapshot.transition_id = v_transition.id
      and snapshot.user_id = new.user_id
      and snapshot.snapshot_kind = 'candidate'
      and snapshot.replace_source_id = new.source_id
      and snapshot.replace_generation_id = new.active_generation_id
    for update;
  else
    select snapshot.* into v_target
    from public.cloud_catalog_background_owner_snapshots snapshot
    where snapshot.id = v_current.base_snapshot_id
      and snapshot.user_id = new.user_id
    for update;
  end if;

  if v_direction = 'forward' then
    if v_current.state <> 'active'
       or v_current.topology_revision <> v_topology_revision
       or v_target.state <> 'ready'
       or v_target.base_snapshot_id <> v_current.id
       or v_target.topology_revision <> v_topology_revision
       or not public.norva_catalog_background_owner_source_map_matches(
         v_current.id,new.user_id,new.source_id,old.active_generation_id
       )
       or not public.norva_catalog_background_owner_source_map_matches(
         v_target.id,new.user_id,new.source_id,new.active_generation_id
       ) then
      raise exception 'catalog background owner forward cutover CAS failed'
        using errcode = 'PT409';
    end if;
  else
    if v_current.state <> 'active'
       or v_current.transition_id <> v_transition.id
       or v_current.replace_generation_id <> old.active_generation_id
       or v_current.base_snapshot_id is null
       or v_current.topology_revision <> v_topology_revision then
      raise exception 'catalog background owner compensation source CAS failed'
        using errcode = 'PT409';
    end if;
    if v_target.state <> 'retained'
       or v_target.topology_revision <> v_topology_revision
       or not public.norva_catalog_background_owner_source_map_matches(
         v_target.id,new.user_id,new.source_id,new.active_generation_id
       ) then
      raise exception 'catalog background owner compensation target CAS failed'
        using errcode = 'PT409';
    end if;
  end if;

  update public.cloud_catalog_background_owner_snapshots snapshot
  set state = 'retained', retained_at = now(),
      revision = snapshot.revision + 1, updated_at = now()
  where snapshot.id = v_current.id;
  update public.cloud_catalog_background_owner_snapshots snapshot
  set state = 'active', activated_at = coalesce(snapshot.activated_at, now()),
      retained_at = case when v_direction = 'compensation'
        then snapshot.retained_at else null end,
      revision = snapshot.revision + 1, updated_at = now()
  where snapshot.id = v_target.id;
  update public.cloud_catalog_background_owner_pointers pointer
  set active_snapshot_id = v_target.id,
      revision = pointer.revision + 1, updated_at = now()
  where pointer.user_id = new.user_id;

  -- Invalidate any leased global walk.  Its next CAS observes the revision or
  -- user epoch change and restarts from the new immutable snapshot.
  update public.cloud_catalog_background_mode_checkpoints checkpoint
  set owner_user_id = null, snapshot_id = null,
      user_visibility_epoch = null,
      last_attempted_at = null, last_title_id = null,
      inflight_items = '[]'::jsonb,
      inflight_last_attempted_at = null,inflight_last_title_id = null,
      inflight_owner_exhausted = false,inflight_byte_count = 0,
      revision = checkpoint.revision + 1, updated_at = now()
  where checkpoint.owner_user_id = new.user_id;

  return null;
end
$function$;

notify pgrst, 'reload schema';
commit;
