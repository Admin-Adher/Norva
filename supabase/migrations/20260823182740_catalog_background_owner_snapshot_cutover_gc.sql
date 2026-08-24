begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

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
    join public.cloud_catalog_background_owner_snapshot_sources base_source
      on base_source.snapshot_id = baseline.id
     and base_source.source_id = transition.old_source_id
     and base_source.generation_id = transition.previous_catalog_generation_id
    join public.cloud_catalog_background_owner_snapshot_sources next_source
      on next_source.snapshot_id = candidate.id
     and next_source.source_id = transition.old_source_id
     and next_source.generation_id = transition.candidate_catalog_generation_id
    join public.cloud_catalog_background_owner_topology_revisions topology
      on topology.user_id = transition.user_id
     and topology.revision = baseline.topology_revision
     and topology.revision = candidate.topology_revision
    where transition.id = p_transition_id
      and transition.user_id = p_user_id
      and transition.identity_decision = 'same_catalog'
      and transition.candidate_catalog_generation_id = p_candidate_generation_id
      and transition.previous_catalog_generation_id = p_previous_generation_id
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
      using errcode = '40001';
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
      using errcode = '40001';
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
       or not exists (
         select 1
         from public.cloud_catalog_background_owner_snapshot_sources source_map
         where source_map.snapshot_id = v_current.id
           and source_map.source_id = new.source_id
           and source_map.generation_id = old.active_generation_id
       )
       or not exists (
         select 1
         from public.cloud_catalog_background_owner_snapshot_sources source_map
         where source_map.snapshot_id = v_target.id
           and source_map.source_id = new.source_id
           and source_map.generation_id = new.active_generation_id
       ) then
      raise exception 'catalog background owner forward cutover CAS failed'
        using errcode = '40001';
    end if;
  else
    if v_current.state <> 'active'
       or v_current.transition_id <> v_transition.id
       or v_current.replace_generation_id <> old.active_generation_id
       or v_current.base_snapshot_id is null
       or v_current.topology_revision <> v_topology_revision then
      raise exception 'catalog background owner compensation source CAS failed'
        using errcode = '40001';
    end if;
    if v_target.state <> 'retained'
       or v_target.topology_revision <> v_topology_revision
       or not exists (
         select 1
         from public.cloud_catalog_background_owner_snapshot_sources source_map
         where source_map.snapshot_id = v_target.id
           and source_map.source_id = new.source_id
           and source_map.generation_id = new.active_generation_id
       ) then
      raise exception 'catalog background owner compensation target CAS failed'
        using errcode = '40001';
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

drop trigger if exists trg_cloud_source_catalog_heads_zz_background_owner
  on public.cloud_source_catalog_heads;
create trigger trg_cloud_source_catalog_heads_zz_background_owner
after update of active_generation_id on public.cloud_source_catalog_heads
for each row
when (old.active_generation_id is distinct from new.active_generation_id)
execute function public.norva_catalog_background_owner_head_changed();

create or replace function public.norva_catalog_background_owner_transition_terminal()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_detached_base_snapshot_id uuid;
begin
  if new.state not in ('completed','failed','cancelled')
     or old.state = new.state then
    return null;
  end if;
  select snapshot.base_snapshot_id into v_detached_base_snapshot_id
  from public.cloud_catalog_background_owner_snapshots snapshot
  where snapshot.transition_id = new.id
    and snapshot.user_id = new.user_id
    and snapshot.snapshot_kind = 'candidate'
    and snapshot.state = 'active'
  for update;

  -- Once the transition is terminal the active candidate no longer needs its
  -- rollback reference.  Non-active versions can be collected in bounded
  -- pages without holding the terminal transaction on a million-row DELETE.
  update public.cloud_catalog_background_owner_snapshots snapshot
  set base_snapshot_id = null, updated_at = now()
  where snapshot.transition_id = new.id
    and snapshot.user_id = new.user_id
    and snapshot.state = 'active'
    and snapshot.snapshot_kind = 'candidate';

  update public.cloud_catalog_background_owner_snapshots snapshot
  set state = 'purging', purge_after = now(),
      revision = snapshot.revision + 1, updated_at = now()
  where snapshot.id = v_detached_base_snapshot_id
    and snapshot.user_id = new.user_id
    and snapshot.state = 'retained'
    and not exists (
      select 1
      from public.cloud_catalog_background_owner_pointers pointer
      where pointer.user_id = snapshot.user_id
        and pointer.active_snapshot_id = snapshot.id
    );

  update public.cloud_catalog_background_owner_snapshots snapshot
  set state = 'purging', purge_after = now(),
      revision = snapshot.revision + 1, updated_at = now()
  where snapshot.transition_id = new.id
    and snapshot.user_id = new.user_id
    and snapshot.state <> 'active'
    and not exists (
      select 1
      from public.cloud_catalog_background_owner_pointers pointer
      where pointer.user_id = snapshot.user_id
        and pointer.active_snapshot_id = snapshot.id
    );
  return null;
end
$function$;

drop trigger if exists trg_cloud_source_transitions_owner_snapshot_terminal
  on public.cloud_source_transitions;
create trigger trg_cloud_source_transitions_owner_snapshot_terminal
after update of state on public.cloud_source_transitions
for each row
when (old.state is distinct from new.state)
execute function public.norva_catalog_background_owner_transition_terminal();

create or replace function public.norva_purge_catalog_background_owner_snapshot_batch(
  p_user_id uuid,
  p_limit integer default 2000
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_snapshot public.cloud_catalog_background_owner_snapshots%rowtype;
  v_deleted integer := 0;
  v_remaining boolean;
begin
  perform public.norva_credential_require_service_role();
  if p_user_id is null or p_limit not between 1 and 5000 then
    raise exception 'invalid catalog background owner purge arguments'
      using errcode = '22023';
  end if;

  select snapshot.* into v_snapshot
  from public.cloud_catalog_background_owner_snapshots snapshot
  where snapshot.user_id = p_user_id
    and snapshot.state in ('stale','purging')
    and coalesce(snapshot.purge_after, '-infinity'::timestamptz) <= now()
    and not exists (
      select 1 from public.cloud_catalog_background_owner_pointers pointer
      where pointer.user_id = snapshot.user_id
        and pointer.active_snapshot_id = snapshot.id
    )
    and not exists (
      select 1 from public.cloud_catalog_background_owner_snapshots child
      where child.base_snapshot_id = snapshot.id
        and child.state in ('building','ready','active','retained')
    )
  order by snapshot.purge_after, snapshot.id
  limit 1
  for update skip locked;
  if not found then
    return jsonb_build_object(
      'contract','catalog-background-owner-gc-v1',
      'snapshotId',null,
      'deletedRows',0,
      'complete',true,
      'replayed',true
    );
  end if;

  delete from public.cloud_catalog_background_owner_snapshot_rows owner_row
  where owner_row.ctid in (
    select candidate.ctid
    from public.cloud_catalog_background_owner_snapshot_rows candidate
    where candidate.snapshot_id = v_snapshot.id
    order by candidate.title_id
    limit p_limit
    for update skip locked
  );
  get diagnostics v_deleted = row_count;
  select exists (
    select 1
    from public.cloud_catalog_background_owner_snapshot_rows owner_row
    where owner_row.snapshot_id = v_snapshot.id
  ) into v_remaining;
  if not v_remaining then
    delete from public.cloud_catalog_background_owner_snapshot_sources source_map
    where source_map.snapshot_id = v_snapshot.id;
    delete from public.cloud_catalog_background_owner_snapshots snapshot
    where snapshot.id = v_snapshot.id;
  end if;

  return jsonb_build_object(
    'contract','catalog-background-owner-gc-v1',
    'snapshotId',v_snapshot.id,
    'deletedRows',v_deleted,
    'complete',not v_remaining,
    'replayed',false
  );
end
$function$;

revoke all on function
  public.norva_catalog_background_owner_snapshot_ready(uuid,uuid,uuid,uuid),
  public.norva_catalog_background_owner_head_changed(),
  public.norva_catalog_background_owner_transition_terminal(),
  public.norva_purge_catalog_background_owner_snapshot_batch(uuid,integer)
from public, anon, authenticated, service_role;
grant execute on function
  public.norva_purge_catalog_background_owner_snapshot_batch(uuid,integer)
to service_role;

do $assert$
begin
  if not has_function_privilege(
       'service_role',
       'public.norva_purge_catalog_background_owner_snapshot_batch(uuid,integer)',
       'EXECUTE'
     )
     or has_function_privilege(
       'authenticated',
       'public.norva_purge_catalog_background_owner_snapshot_batch(uuid,integer)',
       'EXECUTE'
     )
     or has_function_privilege(
       'service_role',
       'public.norva_catalog_background_owner_snapshot_ready(uuid,uuid,uuid,uuid)',
       'EXECUTE'
     )
     or not exists (
       select 1 from pg_trigger trigger_state
       where trigger_state.tgname =
         'trg_cloud_source_catalog_heads_zz_background_owner'
         and not trigger_state.tgisinternal
     )
     or not exists (
       select 1 from pg_trigger trigger_state
       where trigger_state.tgname =
         'trg_cloud_source_transitions_owner_snapshot_terminal'
         and not trigger_state.tgisinternal
     ) then
    raise exception 'catalog background owner cutover/GC contract drift'
      using errcode = '55000';
  end if;
end
$assert$;

commit;
