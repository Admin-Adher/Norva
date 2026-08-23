begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

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
      using errcode = '40001';
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
        using errcode = '40001';
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
      using errcode = '40001';
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
        using errcode = '40001';
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

  -- An empty baseline is an exact representation for a user with no visible
  -- source.  Keeping an active zero-row version lets global walkers advance to
  -- the next user instead of repeatedly failing on a stale pointer.  A
  -- credential candidate must still contain its substituted generation.
  if p_snapshot_kind = 'candidate' and (
       v_source_count = 0 or not exists (
         select 1
         from public.cloud_catalog_background_owner_snapshot_sources source_map
         where source_map.snapshot_id = v_snapshot.id
           and source_map.source_id = p_replace_source_id
           and source_map.generation_id = p_replace_generation_id
       )
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

create or replace function public.norva_build_catalog_background_owner_snapshot_slice(
  p_snapshot_id uuid,
  p_user_id uuid,
  p_expected_revision bigint,
  p_expected_visibility_epoch bigint,
  p_limit integer default 2000
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_snapshot public.cloud_catalog_background_owner_snapshots%rowtype;
  v_epoch bigint;
  v_topology_revision bigint;
  v_page_count integer := 0;
  v_next_cursor uuid;
  v_complete boolean := false;
  v_exact_count bigint;
  v_title_ids uuid[];
  v_title_id uuid;
  v_scan_count integer := 0;
begin
  perform public.norva_credential_require_service_role();
  if p_snapshot_id is null or p_user_id is null
     or p_expected_revision is null
     or p_expected_visibility_epoch is null
     or p_limit not between 100 and 5000 then
    raise exception 'invalid catalog background build slice arguments'
      using errcode = '22023';
  end if;
  select snapshot.* into v_snapshot
  from public.cloud_catalog_background_owner_snapshots snapshot
  where snapshot.id = p_snapshot_id and snapshot.user_id = p_user_id;
  if not found then
    raise exception 'catalog background snapshot not found' using errcode = 'P0002';
  end if;
  if v_snapshot.state = 'ready' then
    return jsonb_build_object(
      'contract','catalog-background-owner-build-v1',
      'snapshotId',v_snapshot.id,
      'state','ready',
      'revision',v_snapshot.revision,
      'visibilityEpoch',v_snapshot.build_visibility_epoch,
      'topologyRevision',v_snapshot.topology_revision,
      'appliedThroughEpoch',v_snapshot.applied_visibility_epoch,
      'processedTitles',0,
      'processedTitlesTotal',v_snapshot.row_count,
      'complete',true,
      'replayed',true
    );
  end if;
  if v_snapshot.state <> 'building'
     or v_snapshot.revision <> p_expected_revision then
    raise exception 'catalog background build revision CAS failed'
      using errcode = '40001';
  end if;

  select epoch.visibility_epoch,topology.revision
    into v_epoch,v_topology_revision
  from public.cloud_user_catalog_visibility_epochs epoch
  join public.cloud_catalog_background_owner_topology_revisions topology
    on topology.user_id = epoch.user_id
  where epoch.user_id = p_user_id;
  if v_snapshot.build_visibility_epoch
       is distinct from p_expected_visibility_epoch
     or v_snapshot.topology_revision is distinct from v_topology_revision then
    raise exception 'catalog background build topology CAS failed'
      using errcode = '40001';
  end if;

  -- First collect the immutable variant keyset without locking the parent
  -- snapshot.  The workflow never activates a version in the same transaction
  -- as a non-empty build page, so this slice does not take the user epoch.
  select coalesce(array_agg(page.title_id order by page.title_id),'{}'::uuid[])
    into v_title_ids
  from (
    select distinct variant.title_id
    from public.cloud_catalog_background_owner_snapshot_sources source_map
    join public.cloud_title_variants variant
      on variant.user_id = source_map.user_id
     and variant.source_id = source_map.source_id
     and variant.generation_id = source_map.generation_id
    where source_map.snapshot_id = v_snapshot.id
      and (v_snapshot.build_cursor is null
        or variant.title_id > v_snapshot.build_cursor)
    order by variant.title_id
    limit p_limit
  ) page;
  v_scan_count := cardinality(v_title_ids);
  select scanned.title_id into v_next_cursor
  from unnest(v_title_ids) scanned(title_id)
  order by scanned.title_id desc
  limit 1;

  -- Lock every surviving cloud_titles parent before taking the per-title
  -- advisory key.  A concurrent DELETE either waits here and later cascades
  -- the owner row, or commits first and disappears from this page.  This
  -- removes the child-FK/title-delete cycle without a privileged delete path.
  select coalesce(array_agg(locked.title_id order by locked.title_id),'{}'::uuid[])
    into v_title_ids
  from (
    select title.id as title_id
    from public.cloud_titles title
    where title.user_id = p_user_id
      and title.id = any(v_title_ids)
    order by title.id
    for key share of title
  ) locked;

  -- Payload/membership sync uses the same title advisory.  Take keys in
  -- ascending order before locking the snapshot parent; the revision recheck
  -- below rejects a competing builder with zero mutation.
  foreach v_title_id in array v_title_ids loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'catalog-background-owner-title:' || p_user_id::text || ':' ||
        v_title_id::text,0
      )
    );
  end loop;

  select snapshot.* into v_snapshot
  from public.cloud_catalog_background_owner_snapshots snapshot
  where snapshot.id = p_snapshot_id and snapshot.user_id = p_user_id
  for no key update;
  if not found or v_snapshot.state <> 'building'
     or v_snapshot.revision <> p_expected_revision
     or v_snapshot.build_visibility_epoch
          is distinct from p_expected_visibility_epoch
     or v_snapshot.topology_revision is distinct from v_topology_revision then
    raise exception 'catalog background build post-lock CAS failed'
      using errcode = '40001';
  end if;

  with candidate_ids as materialized (
    select scanned.title_id
    from unnest(v_title_ids) scanned(title_id)
    order by scanned.title_id
  ), owner_rows as materialized (
    select distinct on (variant.title_id)
      variant.title_id,
      variant.source_id,
      variant.generation_id
    from candidate_ids candidate
    join public.cloud_title_variants variant
      on variant.user_id = p_user_id
     and variant.title_id = candidate.title_id
    join public.cloud_catalog_background_owner_snapshot_sources source_map
      on source_map.snapshot_id = v_snapshot.id
     and source_map.source_id = variant.source_id
     and source_map.generation_id = variant.generation_id
    order by variant.title_id, variant.source_id,
      variant.generation_id, variant.id
  ), effective_rows as materialized (
    select
      owner.title_id,
      owner.source_id,
      owner.generation_id,
      projection.title_id is not null as has_projection,
      coalesce(projection.item_type, title.item_type) as item_type,
      case when projection.title_id is not null
        then projection.provider_tmdb_id else title.provider_tmdb_id end
        as provider_tmdb_id,
      coalesce(projection.match_status, title.match_status) as match_status,
      coalesce(projection.title, title.title) as title,
      case when projection.title_id is not null
        then projection.original_title else title.original_title end
        as original_title,
      case when projection.title_id is not null
        then projection.release_year else title.release_year end as release_year,
      case when projection.title_id is not null
        then projection.poster_url else title.poster_url end as poster_url,
      case when projection.title_id is not null
        then projection.backdrop_url else title.backdrop_url end as backdrop_url,
      case when projection.title_id is not null
        then projection.catalog_metadata else title.metadata end as catalog_metadata,
      case when projection.title_id is not null
        then projection.updated_at else title.updated_at end as payload_updated_at,
      case when projection.title_id is not null
        then projection.year_backfill_attempted_at
        else title.year_backfill_attempted_at end as year_attempted_at,
      case when projection.title_id is not null
        then projection.revalidate_attempted_at
        else title.revalidate_attempted_at end as revalidate_attempted_at,
      case when projection.title_id is not null
        then projection.search_match_attempted_at
        else title.search_match_attempted_at end as search_attempted_at
    from owner_rows owner
    join public.cloud_titles title
      on title.id = owner.title_id and title.user_id = p_user_id
    left join public.cloud_source_catalog_generation_candidate_titles projection
      on projection.user_id = p_user_id
     and projection.title_id = owner.title_id
     and projection.generation_id = owner.generation_id
  ), upserted as (
    insert into public.cloud_catalog_background_owner_snapshot_rows (
      snapshot_id, user_id, title_id, is_present,
      owner_source_id, owner_generation_id, storage_kind,
      item_type, provider_tmdb_id, match_status,
      title, original_title, release_year, poster_url, backdrop_url,
      catalog_metadata, payload_updated_at,
      year_backfill_attempted_at, revalidate_attempted_at,
      search_match_attempted_at, updated_at
    )
    select
      v_snapshot.id, p_user_id, effective.title_id, true,
      effective.source_id, effective.generation_id,
      case when effective.has_projection then 'projection' else 'global' end,
      effective.item_type, effective.provider_tmdb_id, effective.match_status,
      effective.title, effective.original_title, effective.release_year,
      effective.poster_url, effective.backdrop_url,
      effective.catalog_metadata, effective.payload_updated_at,
      effective.year_attempted_at, effective.revalidate_attempted_at,
      effective.search_attempted_at, now()
    from effective_rows effective
    -- Mutation triggers are authoritative for an existing key (including an
    -- absence tombstone).  Insert-only build pages therefore cannot overwrite
    -- a newer concurrent payload or resurrect a title removed mid-build.
    on conflict (snapshot_id, title_id) do nothing
    returning title_id
  )
  select count(*)::integer
    into v_page_count
  from candidate_ids candidate;

  if v_snapshot.snapshot_kind = 'candidate'
     and exists (
       select 1
       from public.cloud_catalog_background_owner_snapshot_rows owner_row
       where owner_row.snapshot_id = v_snapshot.id
          and owner_row.owner_source_id = v_snapshot.replace_source_id
          and owner_row.owner_generation_id = v_snapshot.replace_generation_id
          and owner_row.is_present
         and owner_row.storage_kind <> 'projection'
         and (v_snapshot.build_cursor is null
           or owner_row.title_id > v_snapshot.build_cursor)
         and (v_next_cursor is null or owner_row.title_id <= v_next_cursor)
     ) then
    raise exception 'candidate display owner has no generation payload'
      using errcode = '23503';
  end if;

  if v_scan_count < p_limit then
    select count(*) into v_exact_count
    from public.cloud_catalog_background_owner_snapshot_rows owner_row
    where owner_row.snapshot_id = v_snapshot.id
      and owner_row.is_present;
    update public.cloud_catalog_background_owner_snapshots snapshot
    set state = 'ready', build_cursor = coalesce(v_next_cursor, snapshot.build_cursor),
        row_count = v_exact_count, revision = snapshot.revision + 1,
        completed_at = now(), updated_at = now()
    where snapshot.id = v_snapshot.id
    returning * into v_snapshot;
    v_complete := true;
  else
    update public.cloud_catalog_background_owner_snapshots snapshot
    set build_cursor = v_next_cursor,
        row_count = snapshot.row_count + v_page_count,
        revision = snapshot.revision + 1,
        updated_at = now()
    where snapshot.id = v_snapshot.id
    returning * into v_snapshot;
  end if;

  return jsonb_build_object(
    'contract','catalog-background-owner-build-v1',
    'snapshotId',v_snapshot.id,
    'state',v_snapshot.state,
    'revision',v_snapshot.revision,
    'visibilityEpoch',v_snapshot.build_visibility_epoch,
    'topologyRevision',v_snapshot.topology_revision,
    'appliedThroughEpoch',v_snapshot.applied_visibility_epoch,
    'titleCursor',v_snapshot.build_cursor,
    'processedTitles',v_page_count,
    'processedTitlesTotal',v_snapshot.row_count,
    'complete',v_complete,
    'replayed',false
  );
end
$function$;

create or replace function public.norva_activate_catalog_background_owner_baseline(
  p_snapshot_id uuid,
  p_user_id uuid,
  p_expected_revision bigint,
  p_expected_visibility_epoch bigint
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_snapshot public.cloud_catalog_background_owner_snapshots%rowtype;
  v_pointer public.cloud_catalog_background_owner_pointers%rowtype;
  v_old_snapshot public.cloud_catalog_background_owner_snapshots%rowtype;
  v_has_pointer boolean := false;
  v_epoch bigint;
  v_topology_revision bigint;
begin
  perform public.norva_credential_require_service_role();
  perform 1
  from auth.users account
  where account.id = p_user_id
  for key share;
  if not found then
    raise exception 'catalog background activation account CAS failed'
      using errcode = '40001';
  end if;
  perform 1
  from public.cloud_catalog_background_mode_checkpoints checkpoint
  where checkpoint.owner_user_id = p_user_id
  order by checkpoint.mode
  for update;
  -- Pointer -> visibility epoch -> current snapshot -> target snapshot is the
  -- common order used by sync, selectors and cutover.  The epoch is the short
  -- creation/cutover fence; never lock a version before it.
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
  select topology.revision into v_topology_revision
  from public.cloud_catalog_background_owner_topology_revisions topology
  where topology.user_id = p_user_id
  for update;

  if v_has_pointer and v_pointer.active_snapshot_id <> p_snapshot_id then
    select old_snapshot.* into v_old_snapshot
    from public.cloud_catalog_background_owner_snapshots old_snapshot
    where old_snapshot.id = v_pointer.active_snapshot_id
      and old_snapshot.user_id = p_user_id
    for update;
  end if;
  select snapshot.* into v_snapshot
  from public.cloud_catalog_background_owner_snapshots snapshot
  where snapshot.id = p_snapshot_id and snapshot.user_id = p_user_id
  for update;
  if not found then
    raise exception 'catalog background baseline not found' using errcode = 'P0002';
  end if;
  if v_snapshot.state = 'active' then
    if v_has_pointer and v_pointer.active_snapshot_id = v_snapshot.id then
      return jsonb_build_object(
        'contract','catalog-background-owner-build-v1',
        'snapshotId',v_snapshot.id,
        'state','active',
        'revision',v_snapshot.revision,
        'visibilityEpoch',v_snapshot.build_visibility_epoch,
        'topologyRevision',v_snapshot.topology_revision,
        'appliedThroughEpoch',v_snapshot.applied_visibility_epoch,
        'replayed',true
      );
    end if;
  end if;
  if v_snapshot.snapshot_kind <> 'baseline'
     or v_snapshot.state <> 'ready'
     or v_snapshot.revision <> p_expected_revision
     or v_snapshot.build_visibility_epoch <> p_expected_visibility_epoch
     or v_snapshot.topology_revision <> v_topology_revision
     or (v_has_pointer
       and v_pointer.active_snapshot_id <> v_snapshot.id
       and v_old_snapshot.state <> 'stale')
     or exists (
       select head.source_id, head.active_generation_id
       from public.cloud_source_catalog_heads head
       where head.user_id = p_user_id
         and public.norva_source_catalog_visible_internal(head.source_id, p_user_id)
       except
       select source_map.source_id, source_map.generation_id
       from public.cloud_catalog_background_owner_snapshot_sources source_map
       where source_map.snapshot_id = v_snapshot.id
     )
     or exists (
       select source_map.source_id, source_map.generation_id
       from public.cloud_catalog_background_owner_snapshot_sources source_map
       where source_map.snapshot_id = v_snapshot.id
       except
       select head.source_id, head.active_generation_id
       from public.cloud_source_catalog_heads head
       where head.user_id = p_user_id
         and public.norva_source_catalog_visible_internal(head.source_id, p_user_id)
     ) then
    raise exception 'catalog background baseline activation CAS failed'
      using errcode = '40001';
  end if;

  if v_has_pointer and v_pointer.active_snapshot_id <> v_snapshot.id then
    update public.cloud_catalog_background_owner_snapshots old_snapshot
    set state = 'purging', purge_after = now(),
        revision = old_snapshot.revision + 1, updated_at = now()
    where old_snapshot.id = v_pointer.active_snapshot_id;
    update public.cloud_catalog_background_mode_checkpoints checkpoint
    set owner_user_id = null, snapshot_id = null,
        user_visibility_epoch = null,
        last_attempted_at = null, last_title_id = null,
        inflight_items = '[]'::jsonb,
        inflight_last_attempted_at = null,inflight_last_title_id = null,
        inflight_owner_exhausted = false,inflight_byte_count = 0,
        revision = checkpoint.revision + 1, updated_at = now()
    where checkpoint.owner_user_id = p_user_id;
  end if;

  v_epoch := public.norva_bump_user_catalog_visibility_epoch(p_user_id);
  update public.cloud_catalog_background_owner_snapshots snapshot
  set state = 'active', activated_at = now(),
      applied_visibility_epoch = v_epoch,
      revision = snapshot.revision + 1, updated_at = now()
  where snapshot.id = v_snapshot.id
  returning * into v_snapshot;
  insert into public.cloud_catalog_background_owner_pointers (
    user_id, active_snapshot_id, revision, updated_at
  ) values (p_user_id, v_snapshot.id, 0, now())
  on conflict (user_id) do update set
    active_snapshot_id = excluded.active_snapshot_id,
    revision = public.cloud_catalog_background_owner_pointers.revision + 1,
    updated_at = now();

  return jsonb_build_object(
    'contract','catalog-background-owner-build-v1',
    'snapshotId',v_snapshot.id,
    'state','active',
    'revision',v_snapshot.revision,
    'visibilityEpoch',v_epoch,
    'topologyRevision',v_snapshot.topology_revision,
    'replayed',false
  );
end
$function$;

revoke all on function
  public.norva_begin_catalog_background_owner_snapshot(
    uuid,uuid,text,uuid,uuid,uuid,bigint
  ),
  public.norva_build_catalog_background_owner_snapshot_slice(
    uuid,uuid,bigint,bigint,integer
  ),
  public.norva_activate_catalog_background_owner_baseline(
    uuid,uuid,bigint,bigint
  )
from public, anon, authenticated, service_role;

grant execute on function
  public.norva_begin_catalog_background_owner_snapshot(
    uuid,uuid,text,uuid,uuid,uuid,bigint
  ),
  public.norva_build_catalog_background_owner_snapshot_slice(
    uuid,uuid,bigint,bigint,integer
  ),
  public.norva_activate_catalog_background_owner_baseline(
    uuid,uuid,bigint,bigint
  )
to service_role;

do $assert$
begin
  if not has_function_privilege(
       'service_role',
       'public.norva_begin_catalog_background_owner_snapshot(uuid,uuid,text,uuid,uuid,uuid,bigint)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'service_role',
       'public.norva_build_catalog_background_owner_snapshot_slice(uuid,uuid,bigint,bigint,integer)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'service_role',
       'public.norva_activate_catalog_background_owner_baseline(uuid,uuid,bigint,bigint)',
       'EXECUTE'
     )
     or has_function_privilege(
       'authenticated',
       'public.norva_build_catalog_background_owner_snapshot_slice(uuid,uuid,bigint,bigint,integer)',
       'EXECUTE'
     ) then
    raise exception 'catalog background owner builder ACL drift'
      using errcode = '55000';
  end if;
end
$assert$;

commit;
