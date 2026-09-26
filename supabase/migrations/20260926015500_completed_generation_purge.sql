-- Restore the complete terminal cleanup contract overwritten by the legacy
-- routine-fence migration: superseded generations, bounded categories/title
-- provenance, and idempotent completion. Retain the current account lock and
-- PT409 semantics; reject any generation still referenced by an active head.
begin;
set local lock_timeout='2s';
set local statement_timeout='30s';

create or replace function public.norva_purge_cancelled_credential_generation_batch(
  p_generation_id uuid,
  p_user_id uuid,
  p_limit integer default 200
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_remaining bigint;
  v_deleted bigint := 0;
  v_count bigint;
  v_budget integer;
  v_has_remaining boolean;
  v_generation_state text;
  v_purge_mode text;
  v_projection public.cloud_source_catalog_generation_candidate_titles%rowtype;
  v_title public.cloud_titles%rowtype;
  v_can_delete_shell boolean;
  v_deleted_title_shells bigint := 0;
begin
  perform public.norva_credential_require_service_role();
  perform public.norva_credential_lock_account(p_user_id);
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception 'purge batch limit is invalid' using errcode = '22023';
  end if;
  if not public.norva_title_gc_indexes_ready() then
    raise exception 'candidate title GC indexes are incomplete or drifted'
      using errcode = '55000',
        detail = 'reason=title_gc_index_drift';
  end if;
  perform set_config('lock_timeout', '2s', true);
  if exists (select 1 from public.cloud_source_catalog_heads
    where active_generation_id=p_generation_id) then
    raise exception 'terminal generation purge CAS failed' using errcode='PT409';
  end if;
  select generation.state, 'abandoned'
  into v_generation_state, v_purge_mode
  from public.cloud_source_catalog_generations generation
  join public.cloud_source_transitions transition
    on transition.id = generation.transition_id
   and transition.user_id = generation.user_id
  where generation.id = p_generation_id and generation.user_id = p_user_id
    and generation.state in ('purging', 'failed')
    and (
      transition.state = 'failed'
      or (
        transition.state = 'cancelled'
        and exists (
          select 1
          from public.cloud_source_credential_transition_actions action
          where action.transition_id = transition.id
            and action.user_id = transition.user_id
            and action.action_kind = 'cancel'
        )
      )
    )
  for update of generation;
  if not found then
    select generation.state, 'superseded'
    into v_generation_state, v_purge_mode
    from public.cloud_source_catalog_generations generation
    join public.cloud_source_transitions transition
      on transition.previous_catalog_generation_id = generation.id
     and transition.user_id = generation.user_id
     and transition.old_source_id = generation.source_id
     and transition.state = 'completed'
    join public.cloud_source_catalog_heads head
      on head.source_id = generation.source_id
     and head.user_id = generation.user_id
    join public.cloud_source_catalog_generations candidate
      on candidate.id = head.active_generation_id
     and candidate.source_id = generation.source_id
     and candidate.user_id = generation.user_id
     and candidate.state = 'active'
    where generation.id = p_generation_id
      and generation.user_id = p_user_id
      and generation.state in ('purging', 'purged')
      and head.active_generation_id <> generation.id
    for update of generation;
  end if;
  if not found then
    raise exception 'terminal generation purge CAS failed' using errcode = 'PT409';
  end if;

  -- The final purge transaction may commit before the worker settles its job.
  -- A reclaimed job must observe the already-failed, already-empty generation
  -- as a successful idempotent replay rather than dead-letter forever.
  if (v_purge_mode = 'abandoned' and v_generation_state = 'failed')
     or (v_purge_mode = 'superseded' and v_generation_state = 'purged') then
    select exists (
      select 1 from public.catalog_series_episode_memberships
        where generation_id = p_generation_id
      union all select 1 from public.catalog_series_inventory_state
        where generation_id = p_generation_id
      union all select 1 from public.cloud_live_variants
        where generation_id = p_generation_id
      union all select 1 from public.cloud_live_logical_channels
        where generation_id = p_generation_id
      union all select 1 from public.cloud_title_variants
        where generation_id = p_generation_id
      union all select 1 from public.cloud_media_items
        where generation_id = p_generation_id
      union all select 1 from public.cloud_source_catalog_generation_categories
        where generation_id = p_generation_id
      union all select 1
        from public.cloud_source_catalog_generation_candidate_titles
        where generation_id = p_generation_id
      union all select 1
        from public.cloud_source_catalog_generation_category_lists
        where generation_id = p_generation_id
      union all select 1
        from public.cloud_source_catalog_generation_inventory_actions
        where generation_id = p_generation_id
      union all select 1
        from public.cloud_source_catalog_generation_episode_copy
        where generation_id = p_generation_id
      limit 1
    ) into v_has_remaining;
    if v_has_remaining then
      raise exception 'terminal generation still owns purgeable rows'
        using errcode = '55000';
    end if;
    return jsonb_build_object(
      'generationId', p_generation_id,
      'deletedRows', 0,
      'deletedTitleShells', 0,
      'remainingRows', 0,
      'complete', true,
      'purgeMode', v_purge_mode,
      'replayed', true
    );
  end if;

  perform set_config('norva.catalog_purge_generation', p_generation_id::text, true);
  v_budget:=p_limit;
  if v_budget > 0 then
    delete from public.catalog_series_episode_memberships row
    where row.ctid in (
      select candidate.ctid
      from public.catalog_series_episode_memberships candidate
      where candidate.generation_id = p_generation_id
      limit v_budget
    );
    get diagnostics v_count = row_count;
    v_deleted := v_deleted + v_count; v_budget:=v_budget-v_count;
  end if;
  if v_budget > 0 then
    delete from public.catalog_series_inventory_state row
    where row.ctid in (
      select candidate.ctid
      from public.catalog_series_inventory_state candidate
      where candidate.generation_id = p_generation_id
      limit v_budget
    );
    get diagnostics v_count = row_count;
    v_deleted := v_deleted + v_count; v_budget:=v_budget-v_count;
  end if;
  if v_budget > 0 then
    delete from public.cloud_live_variants row
    where row.ctid in (
      select candidate.ctid from public.cloud_live_variants candidate
      where candidate.generation_id = p_generation_id limit v_budget
    );
    get diagnostics v_count = row_count;
    v_deleted := v_deleted + v_count; v_budget:=v_budget-v_count;
  end if;
  if v_budget > 0 then
    delete from public.cloud_live_logical_channels row
    where row.ctid in (
      select candidate.ctid from public.cloud_live_logical_channels candidate
      where candidate.generation_id = p_generation_id limit v_budget
    );
    get diagnostics v_count = row_count;
    v_deleted := v_deleted + v_count; v_budget:=v_budget-v_count;
  end if;
  if v_budget > 0 then
    delete from public.cloud_title_variants row
    where row.ctid in (
      select candidate.ctid from public.cloud_title_variants candidate
      where candidate.generation_id = p_generation_id limit v_budget
    );
    get diagnostics v_count = row_count;
    v_deleted := v_deleted + v_count; v_budget:=v_budget-v_count;
  end if;
  if v_budget > 0 then
    delete from public.cloud_media_items row
    where row.ctid in (
      select candidate.ctid from public.cloud_media_items candidate
      where candidate.generation_id = p_generation_id limit v_budget
    );
    get diagnostics v_count = row_count;
    v_deleted := v_deleted + v_count; v_budget:=v_budget-v_count;
  end if;
  -- Category discovery can legitimately contain up to one million rows.  It
  -- consumes the same global budget instead of being deleted wholesale in the
  -- terminal batch.
  if v_budget > 0 then
    delete from public.cloud_source_catalog_generation_categories row
    where row.ctid in (
      select candidate.ctid
      from public.cloud_source_catalog_generation_categories candidate
      where candidate.generation_id = p_generation_id
      order by candidate.category_kind, candidate.category_ordinal
      limit v_budget
      for update skip locked
    );
    get diagnostics v_count = row_count;
    v_deleted := v_deleted + v_count; v_budget:=v_budget-v_count;
  end if;

  -- Consume candidate payload/ownership rows in a bounded loop.  A shell is
  -- deleted only when this exact generation created it, it is byte-identical
  -- to the recorded payload, no newer writer touched it, no other generation
  -- projects it, and none of the six business children references it.
  if v_budget > 0 then
    for v_projection in
      select projection.*
      from public.cloud_source_catalog_generation_candidate_titles projection
      where projection.generation_id = p_generation_id
      order by projection.title_id
      limit v_budget
      for update of projection skip locked
    loop
      v_can_delete_shell := false;
      if v_projection.shell_created then
        select title.* into v_title
        from public.cloud_titles title
        where title.id = v_projection.title_id
          and title.user_id = v_projection.user_id
        for update of title skip locked;
        if not found then
          -- A concurrent owner holds the shell.  Keep provenance for retry and
          -- never advance cleanup past it blindly.
          continue;
        end if;
        v_can_delete_shell :=
          v_title.candidate_shell_token = v_projection.shell_token
          and v_title.identity_source is not distinct from v_projection.identity_source
          and v_title.provider_tmdb_id is not distinct from v_projection.provider_tmdb_id
          and v_title.provider_imdb_id is not distinct from v_projection.provider_imdb_id
          and v_title.match_status is not distinct from v_projection.match_status
          and v_title.title is not distinct from v_projection.title
          and v_title.original_title is not distinct from v_projection.original_title
          and v_title.release_year is not distinct from v_projection.release_year
          and v_title.poster_url is not distinct from v_projection.poster_url
          and v_title.backdrop_url is not distinct from v_projection.backdrop_url
          and v_title.metadata is not distinct from v_projection.metadata
          and not exists (
            select 1
            from public.cloud_source_catalog_generation_candidate_titles other
            where other.title_id = v_projection.title_id
              and other.generation_id <> p_generation_id
          )
          and not exists (
            select 1 from public.cloud_title_variants child
            where child.title_id = v_projection.title_id
          )
          and not exists (
            select 1 from public.cloud_title_file_language_observations child
            where child.title_id = v_projection.title_id
              and child.user_id = v_projection.user_id
          )
          and not exists (
            select 1 from public.catalog_series_episode_memberships child
            where child.parent_title_id = v_projection.title_id
          )
          and not exists (
            select 1 from public.catalog_series_inventory_state child
            where child.parent_title_id = v_projection.title_id
          )
          and not exists (
            select 1 from public.cloud_title_rating_operations child
            where child.title_id = v_projection.title_id
              and child.user_id = v_projection.user_id
          )
          and not exists (
            select 1 from public.cloud_title_ratings child
            where child.title_id = v_projection.title_id
              and child.user_id = v_projection.user_id
          );
      end if;

      if v_can_delete_shell then
        delete from public.cloud_titles title
        where title.id = v_projection.title_id
          and title.user_id = v_projection.user_id;
        get diagnostics v_count = row_count;
        v_deleted_title_shells := v_deleted_title_shells + v_count;
      else
        delete from public.cloud_source_catalog_generation_candidate_titles projection
        where projection.generation_id = p_generation_id
          and projection.title_id = v_projection.title_id;
      end if;
      v_deleted := v_deleted + 1;
      v_budget := v_budget - 1;
      exit when v_budget = 0;
    end loop;
  end if;

  select exists (
    select 1 from public.catalog_series_episode_memberships
      where generation_id = p_generation_id
    union all
    select 1 from public.catalog_series_inventory_state
      where generation_id = p_generation_id
    union all
    select 1 from public.cloud_live_variants
      where generation_id = p_generation_id
    union all
    select 1 from public.cloud_live_logical_channels
      where generation_id = p_generation_id
    union all
    select 1 from public.cloud_title_variants
      where generation_id = p_generation_id
    union all
    select 1 from public.cloud_media_items
      where generation_id = p_generation_id
    union all
    select 1 from public.cloud_source_catalog_generation_categories
      where generation_id = p_generation_id
    union all
    select 1 from public.cloud_source_catalog_generation_candidate_titles
      where generation_id = p_generation_id
    limit 1
  ) into v_has_remaining;
  v_remaining := case when v_has_remaining then 1 else 0 end;
  if not v_has_remaining then
    delete from public.cloud_source_catalog_generation_category_lists where generation_id = p_generation_id;
    delete from public.cloud_source_catalog_generation_inventory_actions where generation_id = p_generation_id;
    delete from public.cloud_source_catalog_generation_episode_copy where generation_id = p_generation_id;
    update public.cloud_source_catalog_generations
    set state = case
          when v_purge_mode = 'superseded' then 'purged'
          else 'failed'
        end,
        revision = revision + 1, updated_at = now()
    where id = p_generation_id;
  end if;
  -- Candidate projection deletion is manifest-observed too.  Keep the exact
  -- transaction-local purge proof until every generation-owned cleanup step
  -- has finished; an exception rolls the local setting back with the statement.
  perform set_config('norva.catalog_purge_generation', '', true);
  return jsonb_build_object(
    'generationId', p_generation_id,
    'deletedRows', v_deleted,
    'deletedTitleShells', v_deleted_title_shells,
    'remainingRows', v_remaining,
    'complete', v_remaining = 0,
    'purgeMode', v_purge_mode,
    'replayed', false
  );
end
$function$;
revoke all on function public.norva_purge_cancelled_credential_generation_batch(uuid,uuid,integer)
  from public,anon,authenticated,service_role;
grant execute on function public.norva_purge_cancelled_credential_generation_batch(uuid,uuid,integer) to service_role;
commit;
