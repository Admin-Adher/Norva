-- Requeue a bounded slice of unmatched TMDB searches for one source after a
-- matcher-policy upgrade. This is intentionally separate from the normal
-- 90-day retry window: an operator can recover only the affected source without
-- resetting every tenant or bypassing the durable background owner snapshot.

create or replace function public.norva_requeue_catalog_search_for_source(
  p_source_id uuid,
  p_after_title_id uuid default null,
  p_limit integer default 5000,
  p_matcher_version text default 'unspecified'
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_source_user_id uuid;
  v_checkpoint public.cloud_catalog_background_mode_checkpoints%rowtype;
  v_title_ids uuid[] := '{}'::uuid[];
  v_selected integer := 0;
  v_titles_reset integer := 0;
  v_snapshot_rows_reset integer := 0;
  v_snapshot_rows_ready integer := 0;
  v_next_cursor uuid;
begin
  perform public.norva_credential_require_service_role();

  if p_source_id is null then
    raise exception 'source id is required' using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 5000 then
    raise exception 'requeue limit must be between 1 and 5000' using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_matcher_version, '')), '') is null
     or length(p_matcher_version) > 80 then
    raise exception 'matcher version is required' using errcode = '22023';
  end if;

  select source.user_id
    into v_source_user_id
  from public.cloud_sources source
  where source.id = p_source_id
    and source.deleted_at is null;
  if v_source_user_id is null then
    raise exception 'active source not found' using errcode = 'P0002';
  end if;

  -- Serialize with the search worker. A caller retries this short RPC instead of
  -- mutating rows underneath an inflight page and losing the reset to its ack.
  select checkpoint.*
    into v_checkpoint
  from public.cloud_catalog_background_mode_checkpoints checkpoint
  where checkpoint.mode = 'search_pending'
  for update;
  if not found then
    raise exception 'search checkpoint not found' using errcode = 'P0002';
  end if;
  if v_checkpoint.state <> 'pending'
     or coalesce(v_checkpoint.lease_until, '-infinity'::timestamptz) > statement_timestamp()
     or jsonb_array_length(coalesce(v_checkpoint.inflight_items, '[]'::jsonb)) > 0 then
    raise exception 'search worker is active'
      using errcode = 'PT409', detail = 'reason=search_worker_active';
  end if;

  select coalesce(array_agg(candidate.title_id order by candidate.title_id), '{}'::uuid[])
    into v_title_ids
  from (
    select variant.title_id
    from public.cloud_title_variants variant
    join public.cloud_titles title
      on title.id = variant.title_id
     and title.user_id = v_source_user_id
    where variant.source_id = p_source_id
      and variant.user_id = v_source_user_id
      and title.match_status = 'unmatched'
      and (p_after_title_id is null or variant.title_id > p_after_title_id)
    group by variant.title_id
    order by variant.title_id
    limit p_limit
  ) candidate;

  v_selected := cardinality(v_title_ids);
  if v_selected = 0 then
    return jsonb_build_object(
      'contract', 'catalog-search-source-requeue:v1',
      'sourceId', p_source_id,
      'matcherVersion', p_matcher_version,
      'selected', 0,
      'titlesReset', 0,
      'snapshotRowsReset', 0,
      'snapshotRowsReady', 0,
      'nextCursor', p_after_title_id,
      'done', true
    );
  end if;
  v_next_cursor := v_title_ids[v_selected];

  update public.cloud_titles title
     set search_match_attempted_at = null
   where title.user_id = v_source_user_id
     and title.id = any(v_title_ids)
     and title.match_status = 'unmatched'
     and title.search_match_attempted_at is not null;
  get diagnostics v_titles_reset = row_count;

  update public.cloud_catalog_background_owner_snapshot_rows owner_row
     set search_match_attempted_at = null
    from public.cloud_catalog_background_owner_pointers pointer
   where pointer.user_id = v_source_user_id
     and owner_row.snapshot_id = pointer.active_snapshot_id
     and owner_row.user_id = pointer.user_id
     and owner_row.title_id = any(v_title_ids)
     and owner_row.is_present
     and owner_row.match_status = 'unmatched'
     and owner_row.search_match_attempted_at is not null;
  get diagnostics v_snapshot_rows_reset = row_count;

  -- cloud_titles has a synchronization trigger in current production, so the
  -- explicit snapshot update above can legitimately report zero. Count the
  -- resulting due rows as the invariant callers should verify.
  select count(*)::integer
    into v_snapshot_rows_ready
  from public.cloud_catalog_background_owner_pointers pointer
  join public.cloud_catalog_background_owner_snapshot_rows owner_row
    on owner_row.snapshot_id = pointer.active_snapshot_id
   and owner_row.user_id = pointer.user_id
  where pointer.user_id = v_source_user_id
    and owner_row.title_id = any(v_title_ids)
    and owner_row.is_present
    and owner_row.match_status = 'unmatched'
    and owner_row.search_match_attempted_at is null;

  return jsonb_build_object(
    'contract', 'catalog-search-source-requeue:v1',
    'sourceId', p_source_id,
    'matcherVersion', p_matcher_version,
    'selected', v_selected,
    'titlesReset', v_titles_reset,
    'snapshotRowsReset', v_snapshot_rows_reset,
    'snapshotRowsReady', v_snapshot_rows_ready,
    'nextCursor', v_next_cursor,
    'done', v_selected < p_limit
  );
end
$function$;

revoke all on function public.norva_requeue_catalog_search_for_source(
  uuid,uuid,integer,text
) from public, anon, authenticated;
grant execute on function public.norva_requeue_catalog_search_for_source(
  uuid,uuid,integer,text
) to service_role;

comment on function public.norva_requeue_catalog_search_for_source(
  uuid,uuid,integer,text
) is 'Bounded service-role recovery of source-linked unmatched TMDB searches after a matcher policy upgrade.';
