begin;
set local lock_timeout = '2s';
set local statement_timeout = '15s';

create or replace function public.norva_catalog_background_owner_due_rows(
  p_mode text,
  p_snapshot_id uuid,
  p_retry_before timestamptz,
  p_last_attempted_at timestamptz,
  p_last_title_id uuid,
  p_limit integer
) returns table(title_id uuid, attempted_at timestamptz)
language plpgsql
stable
security definer
rows 500
set search_path = ''
as $function$
begin
  if p_mode = 'year_pending' then
    return query
    select owner_row.title_id, owner_row.year_backfill_attempted_at
    from public.cloud_catalog_background_owner_snapshot_rows owner_row
    where owner_row.snapshot_id = p_snapshot_id
      and owner_row.is_present
      and owner_row.release_year is null
      and owner_row.provider_tmdb_id is not null
      and coalesce(
        owner_row.year_backfill_attempted_at, '-infinity'::timestamptz
      ) < p_retry_before
      and (
        p_last_title_id is null
        or row(
          coalesce(owner_row.year_backfill_attempted_at,
            '-infinity'::timestamptz),
          owner_row.title_id
        ) > row(
          coalesce(p_last_attempted_at, '-infinity'::timestamptz),
          p_last_title_id
        )
      )
    order by coalesce(
      owner_row.year_backfill_attempted_at, '-infinity'::timestamptz
    ), owner_row.title_id
    limit p_limit;
  elsif p_mode = 'revalidate_pending' then
    return query
    select owner_row.title_id, owner_row.revalidate_attempted_at
    from public.cloud_catalog_background_owner_snapshot_rows owner_row
    where owner_row.snapshot_id = p_snapshot_id
      and owner_row.is_present
      and owner_row.match_status in ('provider_unverified','weak')
      and owner_row.provider_tmdb_id is not null
      and owner_row.provider_tmdb_id <> '0'
      and coalesce(
        owner_row.revalidate_attempted_at, '-infinity'::timestamptz
      ) < p_retry_before
      and (
        p_last_title_id is null
        or row(
          coalesce(owner_row.revalidate_attempted_at,
            '-infinity'::timestamptz),
          owner_row.title_id
        ) > row(
          coalesce(p_last_attempted_at, '-infinity'::timestamptz),
          p_last_title_id
        )
      )
    order by coalesce(
      owner_row.revalidate_attempted_at, '-infinity'::timestamptz
    ), owner_row.title_id
    limit p_limit;
  elsif p_mode = 'search_pending' then
    return query
    select owner_row.title_id, owner_row.search_match_attempted_at
    from public.cloud_catalog_background_owner_snapshot_rows owner_row
    where owner_row.snapshot_id = p_snapshot_id
      and owner_row.is_present
      and owner_row.match_status = 'unmatched'
      and coalesce(
        owner_row.search_match_attempted_at, '-infinity'::timestamptz
      ) < p_retry_before
      and (
        p_last_title_id is null
        or row(
          coalesce(owner_row.search_match_attempted_at,
            '-infinity'::timestamptz),
          owner_row.title_id
        ) > row(
          coalesce(p_last_attempted_at, '-infinity'::timestamptz),
          p_last_title_id
        )
      )
    order by coalesce(
      owner_row.search_match_attempted_at, '-infinity'::timestamptz
    ), owner_row.title_id
    limit p_limit;
  else
    raise exception 'invalid catalog background owner mode'
      using errcode = '22023';
  end if;
end
$function$;

create or replace function public.norva_select_catalog_title_background_page_v4(
  p_mode text,
  p_limit integer,
  p_retry_before timestamptz,
  p_cursor jsonb,
  p_user_id uuid
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
  v_pointer public.cloud_catalog_background_owner_pointers%rowtype;
  v_snapshot public.cloud_catalog_background_owner_snapshots%rowtype;
  v_epoch bigint;
  v_topology_revision bigint;
  v_snapshot_id uuid;
  v_cursor_epoch bigint;
  v_cursor_retry timestamptz;
  v_last_attempted_at timestamptz;
  v_last_title_id uuid;
  v_row record;
  v_items jsonb := '[]'::jsonb;
  v_item jsonb;
  v_count integer := 0;
  v_truncated boolean := false;
  v_next_cursor jsonb;
begin
  if v_role <> 'service_role'
     and not (v_role in ('', 'postgres') and session_user = 'postgres') then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_mode not in ('year_pending','revalidate_pending','search_pending')
     or p_limit not between 1 and 500
     or p_retry_before is null
     or p_user_id is null then
    raise exception 'invalid catalog background v4 selector arguments'
      using errcode = '22023';
  end if;

  select pointer.* into v_pointer
  from public.cloud_catalog_background_owner_pointers pointer
  where pointer.user_id = p_user_id
  for share;
  if not found then
    raise exception 'catalog background owner pointer is not ready'
      using errcode = '55000';
  end if;
  select epoch.visibility_epoch into v_epoch
  from public.cloud_user_catalog_visibility_epochs epoch
  where epoch.user_id = p_user_id
  for share;
  if not found then
    raise exception 'catalog background owner epoch is not ready'
      using errcode = '55000';
  end if;
  select snapshot.* into v_snapshot
  from public.cloud_catalog_background_owner_snapshots snapshot
  where snapshot.id = v_pointer.active_snapshot_id
    and snapshot.user_id = p_user_id
  for share;
  select topology.revision into v_topology_revision
  from public.cloud_catalog_background_owner_topology_revisions topology
  where topology.user_id = p_user_id;
  if v_snapshot.state <> 'active'
     or v_snapshot.topology_revision <> v_topology_revision then
    raise exception 'catalog background owner snapshot is stale'
      using errcode = '40001';
  end if;

  if p_cursor is not null then
    if jsonb_typeof(p_cursor) <> 'object'
       or (select count(*) from jsonb_object_keys(p_cursor)) <> 7
       or not p_cursor ?& array[
         'mode','userId','snapshotId','visibilityEpoch',
         'retryBefore','lastAttemptedAt','lastId'
       ]
       or p_cursor ->> 'mode' is distinct from p_mode
       or p_cursor ->> 'userId' is distinct from p_user_id::text then
      raise exception 'catalog background v4 cursor mismatch'
        using errcode = '22023';
    end if;
    begin
      v_snapshot_id := (p_cursor ->> 'snapshotId')::uuid;
      v_cursor_epoch := (p_cursor ->> 'visibilityEpoch')::bigint;
      v_cursor_retry := (p_cursor ->> 'retryBefore')::timestamptz;
      v_last_title_id := (p_cursor ->> 'lastId')::uuid;
      v_last_attempted_at := case
        when p_cursor -> 'lastAttemptedAt' = 'null'::jsonb then null
        else (p_cursor ->> 'lastAttemptedAt')::timestamptz
      end;
    exception when others then
      raise exception 'invalid catalog background v4 cursor'
        using errcode = '22023';
    end;
    if v_snapshot_id <> v_snapshot.id
       or v_cursor_epoch <> v_epoch
       or v_cursor_retry is distinct from p_retry_before
       or v_last_title_id is null then
      raise exception 'catalog background v4 cursor is stale'
        using errcode = '40001';
    end if;
  else
    v_snapshot_id := v_snapshot.id;
  end if;

  for v_row in
    select
      due.attempted_at,
      owner_row.*,
      runtime.best_variant_id,
      runtime.best_generation_id,
      runtime.display_generation_id
    from public.norva_catalog_background_owner_due_rows(
      p_mode, v_snapshot.id, p_retry_before,
      v_last_attempted_at, v_last_title_id, p_limit
    ) due
    join public.cloud_catalog_background_owner_snapshot_rows owner_row
      on owner_row.snapshot_id = v_snapshot.id
     and owner_row.title_id = due.title_id
    left join lateral public.norva_visible_catalog_title_owner(
      owner_row.title_id, owner_row.user_id
    ) runtime on true
    order by coalesce(due.attempted_at, '-infinity'::timestamptz),
      due.title_id
  loop
    if v_row.display_generation_id is distinct from v_row.owner_generation_id then
      raise exception 'catalog background owner runtime drift'
        using errcode = '40001';
    end if;
    v_item := jsonb_build_object(
      'id',v_row.title_id,
      'userId',v_row.user_id,
      'itemType',v_row.item_type,
      'providerTmdbId',v_row.provider_tmdb_id,
      'title',v_row.title,
      'originalTitle',v_row.original_title,
      'releaseYear',v_row.release_year,
      'metadata',v_row.catalog_metadata,
      'posterUrl',v_row.poster_url,
      'backdropUrl',v_row.backdrop_url,
      'storageKind',v_row.storage_kind,
      'visibilityEpoch',v_epoch,
      'payloadUpdatedAt',v_row.payload_updated_at,
      'bestGenerationId',v_row.best_generation_id,
      'displayGenerationId',v_row.owner_generation_id,
      'bestVariantId',v_row.best_variant_id
    );
    if octet_length((v_items || jsonb_build_array(v_item))::text) > 2097152 then
      v_truncated := true;
      exit;
    end if;
    v_items := v_items || jsonb_build_array(v_item);
    v_count := v_count + 1;
    v_last_attempted_at := v_row.attempted_at;
    v_last_title_id := v_row.title_id;
  end loop;

  if v_count = p_limit or v_truncated then
    v_next_cursor := jsonb_build_object(
      'mode',p_mode,
      'userId',p_user_id,
      'snapshotId',v_snapshot.id,
      'visibilityEpoch',v_epoch,
      'retryBefore',p_retry_before,
      'lastAttemptedAt',v_last_attempted_at,
      'lastId',v_last_title_id
    );
  end if;
  return jsonb_build_object(
    'contract','catalog-title-background-selector-v4',
    'mode',p_mode,
    'items',v_items,
    'returnedTitles',v_count,
    'complete',v_count < p_limit and not v_truncated,
    'byteCount',octet_length(v_items::text),
    'nextCursor',v_next_cursor
  );
end
$function$;

create or replace function public.norva_claim_catalog_title_background_mode(
  p_mode text,
  p_worker text,
  p_lease_seconds integer,
  p_retry_before timestamptz
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_checkpoint public.cloud_catalog_background_mode_checkpoints%rowtype;
begin
  perform public.norva_credential_require_service_role();
  if p_mode not in ('year_pending','revalidate_pending','search_pending')
     or p_worker is null or btrim(p_worker) = '' or length(p_worker) > 160
     or p_lease_seconds not between 30 and 900
     or p_retry_before is null then
    raise exception 'invalid catalog background mode claim arguments'
      using errcode = '22023';
  end if;
  select checkpoint.* into v_checkpoint
  from public.cloud_catalog_background_mode_checkpoints checkpoint
  where checkpoint.mode = p_mode
  for update;
  if v_checkpoint.state = 'processing'
     and v_checkpoint.lease_until > now()
     and v_checkpoint.lease_owner = p_worker then
    return jsonb_build_object(
      'contract','catalog-title-background-mode-v1',
      'mode',p_mode,
      'worker',p_worker,
      'leaseSequence',v_checkpoint.lease_sequence,
      'checkpointRevision',v_checkpoint.revision,
      'retryBefore',v_checkpoint.retry_before,
      'replayed',true
    );
  end if;
  if v_checkpoint.state = 'processing'
     and v_checkpoint.lease_until > now() then
    raise exception 'catalog background mode is already leased'
      using errcode = '55P03';
  end if;

  update public.cloud_catalog_background_mode_checkpoints checkpoint
  set state = 'processing',
      retry_before = case when checkpoint.state = 'pending'
        then p_retry_before else checkpoint.retry_before end,
      owner_user_id = case when checkpoint.state = 'pending'
        then null else checkpoint.owner_user_id end,
      snapshot_id = case when checkpoint.state = 'pending'
        then null else checkpoint.snapshot_id end,
      user_visibility_epoch = case when checkpoint.state = 'pending'
        then null else checkpoint.user_visibility_epoch end,
      last_attempted_at = case when checkpoint.state = 'pending'
        then null else checkpoint.last_attempted_at end,
      last_title_id = case when checkpoint.state = 'pending'
        then null else checkpoint.last_title_id end,
      inflight_items = case when checkpoint.state = 'pending'
        then '[]'::jsonb else checkpoint.inflight_items end,
      inflight_last_attempted_at = case when checkpoint.state = 'pending'
        then null else checkpoint.inflight_last_attempted_at end,
      inflight_last_title_id = case when checkpoint.state = 'pending'
        then null else checkpoint.inflight_last_title_id end,
      inflight_owner_exhausted = case when checkpoint.state = 'pending'
        then false else checkpoint.inflight_owner_exhausted end,
      inflight_byte_count = case when checkpoint.state = 'pending'
        then 0 else checkpoint.inflight_byte_count end,
      lease_sequence = checkpoint.lease_sequence + 1,
      lease_owner = p_worker,
      lease_until = now() + make_interval(secs => p_lease_seconds),
      revision = checkpoint.revision + 1,
      updated_at = now()
  where checkpoint.mode = p_mode
  returning * into v_checkpoint;
  return jsonb_build_object(
    'contract','catalog-title-background-mode-v1',
    'mode',p_mode,
    'worker',p_worker,
    'leaseSequence',v_checkpoint.lease_sequence,
    'checkpointRevision',v_checkpoint.revision,
    'retryBefore',v_checkpoint.retry_before,
    'replayed',false
  );
end
$function$;

create or replace function public.norva_select_catalog_title_background_claim_page(
  p_mode text,
  p_worker text,
  p_expected_lease_sequence integer,
  p_expected_revision bigint,
  p_limit integer default 200
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_checkpoint public.cloud_catalog_background_mode_checkpoints%rowtype;
  v_pointer public.cloud_catalog_background_owner_pointers%rowtype;
  v_snapshot public.cloud_catalog_background_owner_snapshots%rowtype;
  v_epoch bigint;
  v_topology_revision bigint;
  v_row record;
  v_items jsonb := '[]'::jsonb;
  v_reconciled_items jsonb;
  v_item jsonb;
  v_count integer := 0;
  v_truncated boolean := false;
  v_owner_exhausted boolean := false;
  v_next_user uuid;
  v_restarted boolean := false;
  v_complete boolean := false;
begin
  perform public.norva_credential_require_service_role();
  if p_limit not between 1 and 500 then
    raise exception 'invalid catalog background claim page limit'
      using errcode = '22023';
  end if;
  select checkpoint.* into v_checkpoint
  from public.cloud_catalog_background_mode_checkpoints checkpoint
  where checkpoint.mode = p_mode
  for update;
  if not found
     or v_checkpoint.state <> 'processing'
     or v_checkpoint.lease_owner <> p_worker
     or v_checkpoint.lease_sequence <> p_expected_lease_sequence
     or v_checkpoint.lease_until <= now()
     or v_checkpoint.revision <> p_expected_revision then
    raise exception 'catalog background mode lease CAS failed'
      using errcode = '40001';
  end if;

  if jsonb_array_length(v_checkpoint.inflight_items) > 0 then
    select pointer.* into v_pointer
    from public.cloud_catalog_background_owner_pointers pointer
    where pointer.user_id = v_checkpoint.owner_user_id
    for share;
    if not found then
      raise exception 'catalog background page owner pointer is missing'
        using errcode = '40001';
    end if;
    select epoch.visibility_epoch into v_epoch
    from public.cloud_user_catalog_visibility_epochs epoch
    where epoch.user_id = v_checkpoint.owner_user_id
    for share;
    if not found then
      raise exception 'catalog background page owner epoch is missing'
        using errcode = '40001';
    end if;
    select snapshot.* into v_snapshot
    from public.cloud_catalog_background_owner_snapshots snapshot
    where snapshot.id = v_pointer.active_snapshot_id
      and snapshot.user_id = v_checkpoint.owner_user_id
    for share;
    if not found then
      raise exception 'catalog background page owner snapshot is missing'
        using errcode = '40001';
    end if;
    select topology.revision into v_topology_revision
    from public.cloud_catalog_background_owner_topology_revisions topology
    where topology.user_id = v_checkpoint.owner_user_id;

    if v_pointer.active_snapshot_id <> v_checkpoint.snapshot_id
       or v_epoch <> v_checkpoint.user_visibility_epoch
       or v_snapshot.state <> 'active'
       or v_snapshot.topology_revision <> v_topology_revision then
      update public.cloud_catalog_background_mode_checkpoints checkpoint
      set snapshot_id = v_pointer.active_snapshot_id,
          user_visibility_epoch = v_epoch,
          last_attempted_at = null,last_title_id = null,
          inflight_items = '[]'::jsonb,
          inflight_last_attempted_at = null,inflight_last_title_id = null,
          inflight_owner_exhausted = false,inflight_byte_count = 0,
          revision = checkpoint.revision + 1,updated_at = now()
      where checkpoint.mode = p_mode
      returning * into v_checkpoint;
      return jsonb_build_object(
        'contract','catalog-title-background-mode-v1',
        'mode',p_mode,'items','[]'::jsonb,'returnedTitles',0,
        'complete',false,'restarted',true,'outcomeReconciled',true,
        'skippedStale',(
          v_snapshot.state <> 'active'
          or v_snapshot.topology_revision <> v_topology_revision
        ),
        'checkpointRevision',v_checkpoint.revision,
        'ownerUserId',v_checkpoint.owner_user_id,
        'visibilityEpoch',v_checkpoint.user_visibility_epoch
      );
    end if;

    -- Rebuild every retained item from the authoritative owner snapshot.  A
    -- payload writer may update payload_updated_at without making the title
    -- leave the due set; replaying the old JSON would then make its writer CAS
    -- fail forever.  Pointer, epoch and snapshot locks above pin one coherent
    -- display owner while this new digest is installed.
    v_reconciled_items := '[]'::jsonb;
    for v_row in
      select
        item.ordinality,
        owner_row.*,
        runtime.best_variant_id,
        runtime.best_generation_id,
        runtime.display_generation_id
      from jsonb_array_elements(v_checkpoint.inflight_items)
        with ordinality as item(value, ordinality)
      join public.cloud_catalog_background_owner_snapshot_rows owner_row
        on owner_row.snapshot_id = v_checkpoint.snapshot_id
       and owner_row.title_id = (item.value ->> 'id')::uuid
      left join lateral public.norva_visible_catalog_title_owner(
        owner_row.title_id, owner_row.user_id
      ) runtime on true
      where owner_row.is_present
        and (
          (p_mode = 'year_pending'
            and owner_row.release_year is null
            and owner_row.provider_tmdb_id is not null
            and coalesce(owner_row.year_backfill_attempted_at,
              '-infinity'::timestamptz) < v_checkpoint.retry_before)
          or (p_mode = 'revalidate_pending'
            and owner_row.match_status in ('provider_unverified','weak')
            and owner_row.provider_tmdb_id is not null
            and owner_row.provider_tmdb_id <> '0'
            and coalesce(owner_row.revalidate_attempted_at,
              '-infinity'::timestamptz) < v_checkpoint.retry_before)
          or (p_mode = 'search_pending'
            and owner_row.match_status = 'unmatched'
            and coalesce(owner_row.search_match_attempted_at,
              '-infinity'::timestamptz) < v_checkpoint.retry_before)
        )
      order by item.ordinality
    loop
      if v_row.display_generation_id is distinct from
           v_row.owner_generation_id then
        raise exception 'catalog background replay owner runtime drift'
          using errcode = '40001';
      end if;
      v_item := jsonb_build_object(
        'id',v_row.title_id,'userId',v_row.user_id,
        'itemType',v_row.item_type,
        'providerTmdbId',v_row.provider_tmdb_id,
        'title',v_row.title,'originalTitle',v_row.original_title,
        'releaseYear',v_row.release_year,
        'metadata',v_row.catalog_metadata,
        'posterUrl',v_row.poster_url,'backdropUrl',v_row.backdrop_url,
        'storageKind',v_row.storage_kind,
        'visibilityEpoch',v_checkpoint.user_visibility_epoch,
        'payloadUpdatedAt',v_row.payload_updated_at,
        'bestGenerationId',v_row.best_generation_id,
        'displayGenerationId',v_row.owner_generation_id,
        'bestVariantId',v_row.best_variant_id
      );
      if octet_length((
           v_reconciled_items || jsonb_build_array(v_item)
         )::text) > 2097152 then
        v_truncated := true;
        exit;
      end if;
      v_reconciled_items :=
        v_reconciled_items || jsonb_build_array(v_item);
    end loop;

    if v_truncated then
      -- Keep the committed cursor, discard only the oversized stale page.  A
      -- following call rebuilds it with the normal byte-bounded page loop.
      update public.cloud_catalog_background_mode_checkpoints checkpoint
      set inflight_items = '[]'::jsonb,
          inflight_last_attempted_at = null,
          inflight_last_title_id = null,
          inflight_owner_exhausted = false,
          inflight_byte_count = 0,
          revision = checkpoint.revision + 1,
          updated_at = now()
      where checkpoint.mode = p_mode
      returning * into v_checkpoint;
      return jsonb_build_object(
        'contract','catalog-title-background-mode-v1',
        'mode',p_mode,'items','[]'::jsonb,'returnedTitles',0,
        'complete',false,'restarted',true,'outcomeReconciled',true,
        'checkpointRevision',v_checkpoint.revision,
        'ownerUserId',v_checkpoint.owner_user_id,
        'visibilityEpoch',v_checkpoint.user_visibility_epoch
      );
    end if;
    if jsonb_array_length(v_reconciled_items) = 0 then
      update public.cloud_catalog_background_mode_checkpoints checkpoint
      set last_attempted_at = checkpoint.inflight_last_attempted_at,
          last_title_id = checkpoint.inflight_last_title_id,
          inflight_items = '[]'::jsonb,
          inflight_last_attempted_at = null,inflight_last_title_id = null,
          inflight_owner_exhausted = false,inflight_byte_count = 0,
          revision = checkpoint.revision + 1,updated_at = now()
      where checkpoint.mode = p_mode
      returning * into v_checkpoint;
      return jsonb_build_object(
        'contract','catalog-title-background-mode-v1',
        'mode',p_mode,'items','[]'::jsonb,'returnedTitles',0,
        'complete',false,'restarted',false,'outcomeReconciled',true,
        'checkpointRevision',v_checkpoint.revision,
        'ownerUserId',v_checkpoint.owner_user_id,
        'visibilityEpoch',v_checkpoint.user_visibility_epoch
      );
    end if;
    v_restarted :=
      v_reconciled_items is distinct from v_checkpoint.inflight_items;
    if v_restarted then
      update public.cloud_catalog_background_mode_checkpoints checkpoint
      set inflight_items = v_reconciled_items,
          inflight_byte_count = octet_length(v_reconciled_items::text),
          revision = checkpoint.revision + 1,updated_at = now()
      where checkpoint.mode = p_mode
      returning * into v_checkpoint;
    end if;
    return jsonb_build_object(
      'contract','catalog-title-background-mode-v1',
      'mode',p_mode,'items',v_reconciled_items,
      'returnedTitles',jsonb_array_length(v_reconciled_items),
      'byteCount',v_checkpoint.inflight_byte_count,
      'pageDigest',encode(extensions.digest(v_reconciled_items::text, 'sha256'), 'hex'),
      'complete',false,'ackRequired',true,'replayed',true,
      'outcomeReconciled',v_restarted,
      'checkpointRevision',v_checkpoint.revision,
      'ownerUserId',v_checkpoint.owner_user_id,
      'visibilityEpoch',v_checkpoint.user_visibility_epoch
    );
  end if;

  if v_checkpoint.owner_user_id is null then
    select pointer.* into v_pointer
    from public.cloud_catalog_background_owner_pointers pointer
    order by pointer.user_id
    limit 1
    for share;
    if not found then
      update public.cloud_catalog_background_mode_checkpoints checkpoint
      set state = 'pending', owner_user_id = null, snapshot_id = null,
          user_visibility_epoch = null,
          retry_before = null, last_attempted_at = null, last_title_id = null,
          lease_owner = null, lease_until = null,
          revision = checkpoint.revision + 1,
          completed_cycles = checkpoint.completed_cycles + 1,
          updated_at = now()
      where checkpoint.mode = p_mode
      returning * into v_checkpoint;
      return jsonb_build_object(
        'contract','catalog-title-background-mode-v1',
        'mode',p_mode,'items','[]'::jsonb,'returnedTitles',0,
        'complete',true,'checkpointRevision',v_checkpoint.revision,
        'restarted',false
      );
    end if;
    select epoch.visibility_epoch into v_epoch
    from public.cloud_user_catalog_visibility_epochs epoch
    where epoch.user_id = v_pointer.user_id
    for share;
    select snapshot.* into v_snapshot
    from public.cloud_catalog_background_owner_snapshots snapshot
    where snapshot.id = v_pointer.active_snapshot_id
      and snapshot.user_id = v_pointer.user_id
    for share;
    update public.cloud_catalog_background_mode_checkpoints checkpoint
    set owner_user_id = v_pointer.user_id,
        snapshot_id = v_pointer.active_snapshot_id,
        user_visibility_epoch = v_epoch,
        last_attempted_at = null, last_title_id = null,
        updated_at = now()
    where checkpoint.mode = p_mode
    returning * into v_checkpoint;
  else
    select pointer.* into v_pointer
    from public.cloud_catalog_background_owner_pointers pointer
    where pointer.user_id = v_checkpoint.owner_user_id
    for share;
    if not found or v_pointer.active_snapshot_id <> v_checkpoint.snapshot_id then
      raise exception 'catalog background mode owner pointer changed'
        using errcode = '40001';
    end if;
    select epoch.visibility_epoch into v_epoch
    from public.cloud_user_catalog_visibility_epochs epoch
    where epoch.user_id = v_checkpoint.owner_user_id
    for share;
    select snapshot.* into v_snapshot
    from public.cloud_catalog_background_owner_snapshots snapshot
    where snapshot.id = v_checkpoint.snapshot_id
      and snapshot.user_id = v_checkpoint.owner_user_id
    for share;
    if v_epoch <> v_checkpoint.user_visibility_epoch then
      update public.cloud_catalog_background_mode_checkpoints checkpoint
      set user_visibility_epoch = v_epoch,
          last_attempted_at = null, last_title_id = null,
          revision = checkpoint.revision + 1, updated_at = now()
      where checkpoint.mode = p_mode
      returning * into v_checkpoint;
      return jsonb_build_object(
        'contract','catalog-title-background-mode-v1',
        'mode',p_mode,'items','[]'::jsonb,'returnedTitles',0,
        'complete',false,'checkpointRevision',v_checkpoint.revision,
        'ownerUserId',v_checkpoint.owner_user_id,
        'visibilityEpoch',v_epoch,'restarted',true
      );
    end if;
  end if;

  select topology.revision into v_topology_revision
  from public.cloud_catalog_background_owner_topology_revisions topology
  where topology.user_id = v_checkpoint.owner_user_id;
  if v_snapshot.state <> 'active'
     or v_snapshot.topology_revision <> v_topology_revision then
    -- A topology mutation durably enqueues this user before staling the
    -- pointer.  Global modes must not let a long rebuild for one account jam
    -- every following account; skip only this stale version, never read it.
    select pointer.user_id into v_next_user
    from public.cloud_catalog_background_owner_pointers pointer
    where pointer.user_id > v_checkpoint.owner_user_id
    order by pointer.user_id
    limit 1;
    if v_next_user is null then
      update public.cloud_catalog_background_mode_checkpoints checkpoint
      set state = 'pending',owner_user_id = null,snapshot_id = null,
          user_visibility_epoch = null,retry_before = null,
          last_attempted_at = null,last_title_id = null,
          lease_owner = null,lease_until = null,
          revision = checkpoint.revision + 1,
          completed_cycles = checkpoint.completed_cycles + 1,
          updated_at = now()
      where checkpoint.mode = p_mode
      returning * into v_checkpoint;
      v_complete := true;
    else
      select pointer.* into v_pointer
      from public.cloud_catalog_background_owner_pointers pointer
      where pointer.user_id = v_next_user
      for share;
      select epoch.visibility_epoch into v_epoch
      from public.cloud_user_catalog_visibility_epochs epoch
      where epoch.user_id = v_next_user
      for share;
      update public.cloud_catalog_background_mode_checkpoints checkpoint
      set owner_user_id = v_next_user,
          snapshot_id = v_pointer.active_snapshot_id,
          user_visibility_epoch = v_epoch,
          last_attempted_at = null,last_title_id = null,
          revision = checkpoint.revision + 1,updated_at = now()
      where checkpoint.mode = p_mode
      returning * into v_checkpoint;
    end if;
    return jsonb_build_object(
      'contract','catalog-title-background-mode-v1',
      'mode',p_mode,'items','[]'::jsonb,'returnedTitles',0,
      'complete',v_complete,'checkpointRevision',v_checkpoint.revision,
      'ownerUserId',v_checkpoint.owner_user_id,
      'visibilityEpoch',v_checkpoint.user_visibility_epoch,
      'restarted',false,'skippedStale',true
    );
  end if;

  for v_row in
    select
      due.attempted_at,
      owner_row.*,
      runtime.best_variant_id,
      runtime.best_generation_id,
      runtime.display_generation_id
    from public.norva_catalog_background_owner_due_rows(
      p_mode, v_snapshot.id, v_checkpoint.retry_before,
      v_checkpoint.last_attempted_at, v_checkpoint.last_title_id, p_limit
    ) due
    join public.cloud_catalog_background_owner_snapshot_rows owner_row
      on owner_row.snapshot_id = v_snapshot.id
     and owner_row.title_id = due.title_id
    left join lateral public.norva_visible_catalog_title_owner(
      owner_row.title_id, owner_row.user_id
    ) runtime on true
    order by coalesce(due.attempted_at, '-infinity'::timestamptz),
      due.title_id
  loop
    if v_row.display_generation_id is distinct from v_row.owner_generation_id then
      raise exception 'catalog background mode owner runtime drift'
        using errcode = '40001';
    end if;
    v_item := jsonb_build_object(
      'id',v_row.title_id,'userId',v_row.user_id,
      'itemType',v_row.item_type,'providerTmdbId',v_row.provider_tmdb_id,
      'title',v_row.title,'originalTitle',v_row.original_title,
      'releaseYear',v_row.release_year,'metadata',v_row.catalog_metadata,
      'posterUrl',v_row.poster_url,'backdropUrl',v_row.backdrop_url,
      'storageKind',v_row.storage_kind,
      'visibilityEpoch',v_checkpoint.user_visibility_epoch,
      'payloadUpdatedAt',v_row.payload_updated_at,
      'bestGenerationId',v_row.best_generation_id,
      'displayGenerationId',v_row.owner_generation_id,
      'bestVariantId',v_row.best_variant_id
    );
    if octet_length((v_items || jsonb_build_array(v_item))::text) > 2097152 then
      v_truncated := true;
      exit;
    end if;
    v_items := v_items || jsonb_build_array(v_item);
    v_count := v_count + 1;
    v_checkpoint.last_attempted_at := v_row.attempted_at;
    v_checkpoint.last_title_id := v_row.title_id;
  end loop;

  v_owner_exhausted := not v_truncated and v_count < p_limit;
  if v_count > 0 then
    update public.cloud_catalog_background_mode_checkpoints checkpoint
    set inflight_items = v_items,
        inflight_last_attempted_at = v_checkpoint.last_attempted_at,
        inflight_last_title_id = v_checkpoint.last_title_id,
        inflight_owner_exhausted = v_owner_exhausted,
        inflight_byte_count = octet_length(v_items::text),
        revision = checkpoint.revision + 1,updated_at = now()
    where checkpoint.mode = p_mode
    returning * into v_checkpoint;
    return jsonb_build_object(
      'contract','catalog-title-background-mode-v1',
      'mode',p_mode,'items',v_items,'returnedTitles',v_count,
      'byteCount',v_checkpoint.inflight_byte_count,
      'pageDigest',encode(extensions.digest(v_items::text, 'sha256'), 'hex'),
      'complete',false,'ackRequired',true,'replayed',false,
      'checkpointRevision',v_checkpoint.revision,
      'ownerUserId',v_checkpoint.owner_user_id,
      'visibilityEpoch',v_checkpoint.user_visibility_epoch,
      'restarted',v_restarted
    );
  end if;

  if v_count = p_limit then
    update public.cloud_catalog_background_mode_checkpoints checkpoint
    set last_attempted_at = v_checkpoint.last_attempted_at,
        last_title_id = v_checkpoint.last_title_id,
        revision = checkpoint.revision + 1, updated_at = now()
    where checkpoint.mode = p_mode
    returning * into v_checkpoint;
  else
    select pointer.user_id into v_next_user
    from public.cloud_catalog_background_owner_pointers pointer
    where pointer.user_id > v_checkpoint.owner_user_id
    order by pointer.user_id
    limit 1;
    if v_next_user is null then
      update public.cloud_catalog_background_mode_checkpoints checkpoint
      set state = 'pending', owner_user_id = null, snapshot_id = null,
          user_visibility_epoch = null,
          retry_before = null, last_attempted_at = null, last_title_id = null,
          lease_owner = null, lease_until = null,
          revision = checkpoint.revision + 1,
          completed_cycles = checkpoint.completed_cycles + 1,
          updated_at = now()
      where checkpoint.mode = p_mode
      returning * into v_checkpoint;
      v_complete := true;
    else
      select pointer.* into v_pointer
      from public.cloud_catalog_background_owner_pointers pointer
      where pointer.user_id = v_next_user
      for share;
      select epoch.visibility_epoch into v_epoch
      from public.cloud_user_catalog_visibility_epochs epoch
      where epoch.user_id = v_next_user
      for share;
      update public.cloud_catalog_background_mode_checkpoints checkpoint
      set owner_user_id = v_next_user,
          snapshot_id = v_pointer.active_snapshot_id,
          user_visibility_epoch = v_epoch,
          last_attempted_at = null, last_title_id = null,
          revision = checkpoint.revision + 1, updated_at = now()
      where checkpoint.mode = p_mode
      returning * into v_checkpoint;
    end if;
  end if;

  return jsonb_build_object(
    'contract','catalog-title-background-mode-v1',
    'mode',p_mode,'items',v_items,'returnedTitles',v_count,
    'complete',v_complete,
    'checkpointRevision',v_checkpoint.revision,
    'ownerUserId',v_checkpoint.owner_user_id,
    'visibilityEpoch',v_checkpoint.user_visibility_epoch,
    'restarted',v_restarted
  );
end
$function$;

create or replace function public.norva_ack_catalog_title_background_claim_page(
  p_mode text,
  p_worker text,
  p_expected_lease_sequence integer,
  p_expected_revision bigint,
  p_expected_page_digest text,
  p_processed_title_ids uuid[]
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_checkpoint public.cloud_catalog_background_mode_checkpoints%rowtype;
  v_pointer public.cloud_catalog_background_owner_pointers%rowtype;
  v_snapshot public.cloud_catalog_background_owner_snapshots%rowtype;
  v_remaining_items jsonb;
  v_acknowledged integer;
  v_remaining integer;
  v_next_user uuid;
  v_epoch bigint;
  v_complete boolean := false;
begin
  perform public.norva_credential_require_service_role();
  if p_mode not in ('year_pending','revalidate_pending','search_pending')
     or p_worker is null or btrim(p_worker) = '' or length(p_worker) > 160
     or p_expected_lease_sequence < 1
     or p_expected_revision < 1
     or p_expected_page_digest is null
     or p_expected_page_digest !~ '^[0-9a-f]{64}$'
     or p_processed_title_ids is null
     or cardinality(p_processed_title_ids) not between 1 and 500
     or array_position(p_processed_title_ids, null) is not null
     or cardinality(p_processed_title_ids) <> (
       select count(distinct processed.id)
       from unnest(p_processed_title_ids) processed(id)
     ) then
    raise exception 'invalid catalog background page acknowledgement arguments'
      using errcode = '22023';
  end if;

  select checkpoint.* into v_checkpoint
  from public.cloud_catalog_background_mode_checkpoints checkpoint
  where checkpoint.mode = p_mode
  for update;
  if not found
     or v_checkpoint.state <> 'processing'
     or v_checkpoint.lease_owner <> p_worker
     or v_checkpoint.lease_sequence <> p_expected_lease_sequence
     or v_checkpoint.lease_until <= now()
     or v_checkpoint.revision <> p_expected_revision
     or jsonb_array_length(v_checkpoint.inflight_items) = 0 then
    raise exception 'catalog background page acknowledgement CAS failed'
      using errcode = '40001';
  end if;
  if encode(extensions.digest(v_checkpoint.inflight_items::text, 'sha256'), 'hex')
       <> p_expected_page_digest then
    raise exception 'catalog background page acknowledgement digest mismatch'
      using errcode = '40001';
  end if;

  if exists (
    select 1
    from unnest(p_processed_title_ids) processed(id)
    where not exists (
      select 1
      from jsonb_array_elements(v_checkpoint.inflight_items) item(value)
      where (item.value ->> 'id')::uuid = processed.id
    )
  ) then
    raise exception 'catalog background page acknowledgement mismatch'
      using errcode = '40001';
  end if;

  -- An ACK is an outcome commit, not an Edge attestation.  Every acknowledged
  -- item must already have left this pinned due-set in the authoritative owner
  -- snapshot.  The background writer stamps the corresponding attempted_at in
  -- the same transaction as its payload mutation; a caller that skipped or
  -- only held an outcome in memory therefore cannot advance the durable cursor.
  if exists (
    select 1
    from unnest(p_processed_title_ids) processed(id)
    join public.cloud_catalog_background_owner_snapshot_rows owner_row
      on owner_row.snapshot_id = v_checkpoint.snapshot_id
     and owner_row.title_id = processed.id
    where owner_row.is_present and (
      (p_mode = 'year_pending'
        and owner_row.release_year is null
        and owner_row.provider_tmdb_id is not null
        and coalesce(owner_row.year_backfill_attempted_at,
          '-infinity'::timestamptz) < v_checkpoint.retry_before)
      or (p_mode = 'revalidate_pending'
        and owner_row.match_status in ('provider_unverified','weak')
        and owner_row.provider_tmdb_id is not null
        and owner_row.provider_tmdb_id <> '0'
        and coalesce(owner_row.revalidate_attempted_at,
          '-infinity'::timestamptz) < v_checkpoint.retry_before)
      or (p_mode = 'search_pending'
        and owner_row.match_status = 'unmatched'
        and coalesce(owner_row.search_match_attempted_at,
          '-infinity'::timestamptz) < v_checkpoint.retry_before)
    )
  ) then
    raise exception 'catalog background page outcome is not durable'
      using errcode = '40001',
        detail = 'reason=catalog_background_outcome_not_durable';
  end if;

  select coalesce(
    jsonb_agg(item.value order by item.ordinality)
      filter (where not ((item.value ->> 'id')::uuid = any(
        p_processed_title_ids
      ))),
    '[]'::jsonb
  ) into v_remaining_items
  from jsonb_array_elements(v_checkpoint.inflight_items)
    with ordinality as item(value, ordinality);
  v_acknowledged := cardinality(p_processed_title_ids);
  v_remaining := jsonb_array_length(v_remaining_items);

  select epoch.visibility_epoch into v_epoch
  from public.cloud_user_catalog_visibility_epochs epoch
  where epoch.user_id = v_checkpoint.owner_user_id
  for share;
  if not found then
    raise exception 'catalog background page owner epoch is missing'
      using errcode = '40001';
  end if;
  if v_epoch <> v_checkpoint.user_visibility_epoch then
    update public.cloud_catalog_background_mode_checkpoints checkpoint
    set user_visibility_epoch = v_epoch,
        last_attempted_at = null,
        last_title_id = null,
        inflight_items = '[]'::jsonb,
        inflight_last_attempted_at = null,
        inflight_last_title_id = null,
        inflight_owner_exhausted = false,
        inflight_byte_count = 0,
        revision = checkpoint.revision + 1,
        updated_at = now()
    where checkpoint.mode = p_mode
    returning * into v_checkpoint;
    return jsonb_build_object(
      'contract','catalog-title-background-mode-v1',
      'mode',p_mode,'complete',false,'restarted',true,
      'acknowledgedTitles',v_acknowledged,'remainingTitles',0,
      'checkpointRevision',v_checkpoint.revision,
      'ownerUserId',v_checkpoint.owner_user_id,
      'visibilityEpoch',v_checkpoint.user_visibility_epoch
    );
  end if;

  if v_remaining > 0 then
    update public.cloud_catalog_background_mode_checkpoints checkpoint
    set inflight_items = v_remaining_items,
        inflight_byte_count = octet_length(v_remaining_items::text),
        revision = checkpoint.revision + 1,
        updated_at = now()
    where checkpoint.mode = p_mode
    returning * into v_checkpoint;
    return jsonb_build_object(
      'contract','catalog-title-background-mode-v1',
      'mode',p_mode,'complete',false,'ackRequired',true,
      'acknowledgedTitles',v_acknowledged,
      'remainingTitles',v_remaining,
      'pageDigest',encode(extensions.digest(
        v_remaining_items::text,'sha256'
      ),'hex'),
      'checkpointRevision',v_checkpoint.revision,
      'ownerUserId',v_checkpoint.owner_user_id,
      'visibilityEpoch',v_checkpoint.user_visibility_epoch
    );
  end if;

  if not v_checkpoint.inflight_owner_exhausted then
    update public.cloud_catalog_background_mode_checkpoints checkpoint
    set last_attempted_at = v_checkpoint.inflight_last_attempted_at,
        last_title_id = v_checkpoint.inflight_last_title_id,
        inflight_items = '[]'::jsonb,
        inflight_last_attempted_at = null,
        inflight_last_title_id = null,
        inflight_owner_exhausted = false,
        inflight_byte_count = 0,
        revision = checkpoint.revision + 1,
        updated_at = now()
    where checkpoint.mode = p_mode
    returning * into v_checkpoint;
  else
    select pointer.user_id into v_next_user
    from public.cloud_catalog_background_owner_pointers pointer
    where pointer.user_id > v_checkpoint.owner_user_id
    order by pointer.user_id
    limit 1;
    if v_next_user is null then
      update public.cloud_catalog_background_mode_checkpoints checkpoint
      set state = 'pending',
          owner_user_id = null,
          snapshot_id = null,
          user_visibility_epoch = null,
          retry_before = null,
          last_attempted_at = null,
          last_title_id = null,
          inflight_items = '[]'::jsonb,
          inflight_last_attempted_at = null,
          inflight_last_title_id = null,
          inflight_owner_exhausted = false,
          inflight_byte_count = 0,
          lease_owner = null,
          lease_until = null,
          revision = checkpoint.revision + 1,
          completed_cycles = checkpoint.completed_cycles + 1,
          updated_at = now()
      where checkpoint.mode = p_mode
      returning * into v_checkpoint;
      v_complete := true;
    else
      select pointer.* into v_pointer
      from public.cloud_catalog_background_owner_pointers pointer
      where pointer.user_id = v_next_user
      for share;
      select epoch.visibility_epoch into v_epoch
      from public.cloud_user_catalog_visibility_epochs epoch
      where epoch.user_id = v_next_user
      for share;
      select snapshot.* into v_snapshot
      from public.cloud_catalog_background_owner_snapshots snapshot
      where snapshot.id = v_pointer.active_snapshot_id
        and snapshot.user_id = v_next_user
      for share;
      if not found or v_snapshot.state <> 'active' then
        raise exception 'catalog background next owner snapshot CAS failed'
          using errcode = '40001';
      end if;
      update public.cloud_catalog_background_mode_checkpoints checkpoint
      set owner_user_id = v_next_user,
          snapshot_id = v_pointer.active_snapshot_id,
          user_visibility_epoch = v_epoch,
          last_attempted_at = null,
          last_title_id = null,
          inflight_items = '[]'::jsonb,
          inflight_last_attempted_at = null,
          inflight_last_title_id = null,
          inflight_owner_exhausted = false,
          inflight_byte_count = 0,
          revision = checkpoint.revision + 1,
          updated_at = now()
      where checkpoint.mode = p_mode
      returning * into v_checkpoint;
    end if;
  end if;

  return jsonb_build_object(
    'contract','catalog-title-background-mode-v1',
    'mode',p_mode,
    'complete',v_complete,
    'acknowledgedTitles',v_acknowledged,
    'remainingTitles',0,
    'checkpointRevision',v_checkpoint.revision,
    'ownerUserId',v_checkpoint.owner_user_id,
    'visibilityEpoch',v_checkpoint.user_visibility_epoch
  );
end
$function$;

revoke all on function
  public.norva_catalog_background_owner_due_rows(
    text,uuid,timestamptz,timestamptz,uuid,integer
  ),
  public.norva_select_catalog_title_background_page_v4(
    text,integer,timestamptz,jsonb,uuid
  ),
  public.norva_claim_catalog_title_background_mode(
    text,text,integer,timestamptz
  ),
  public.norva_select_catalog_title_background_claim_page(
    text,text,integer,bigint,integer
  ),
  public.norva_ack_catalog_title_background_claim_page(
    text,text,integer,bigint,text,uuid[]
  )
from public, anon, authenticated, service_role;
grant execute on function
  public.norva_select_catalog_title_background_page_v4(
    text,integer,timestamptz,jsonb,uuid
  ),
  public.norva_claim_catalog_title_background_mode(
    text,text,integer,timestamptz
  ),
  public.norva_select_catalog_title_background_claim_page(
    text,text,integer,bigint,integer
  ),
  public.norva_ack_catalog_title_background_claim_page(
    text,text,integer,bigint,text,uuid[]
  )
to service_role;

do $assert$
begin
  if not has_function_privilege(
       'service_role',
       'public.norva_select_catalog_title_background_page_v4(text,integer,timestamptz,jsonb,uuid)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'service_role',
       'public.norva_claim_catalog_title_background_mode(text,text,integer,timestamptz)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'service_role',
       'public.norva_select_catalog_title_background_claim_page(text,text,integer,bigint,integer)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'service_role',
       'public.norva_ack_catalog_title_background_claim_page(text,text,integer,bigint,text,uuid[])',
       'EXECUTE'
     )
     or has_function_privilege(
       'authenticated',
       'public.norva_select_catalog_title_background_page_v4(text,integer,timestamptz,jsonb,uuid)',
       'EXECUTE'
     )
     or has_function_privilege(
       'service_role',
       'public.norva_catalog_background_owner_due_rows(text,uuid,timestamptz,timestamptz,uuid,integer)',
       'EXECUTE'
     ) then
    raise exception 'catalog background owner selector v4 ACL drift'
      using errcode = '55000';
  end if;
end
$assert$;

commit;
