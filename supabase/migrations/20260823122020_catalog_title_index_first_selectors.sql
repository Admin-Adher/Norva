begin;
set local lock_timeout = '2s';
set local statement_timeout = '15s';

-- Lightweight owner proof used before full title hydration.  The active-head
-- variants view is already tenant/lifecycle/generation aware.  ROWS 1 is exact
-- and prevents the planner from multiplying a bounded raw page by 1000.
create or replace function public.norva_visible_catalog_title_owner(
  p_title_id uuid,
  p_user_id uuid
) returns table (
  best_variant_id uuid,
  best_generation_id uuid,
  display_generation_id uuid,
  variant_count integer,
  visible_source_ids uuid[]
)
language sql
stable
rows 1
security invoker
set search_path = ''
as $function$
  select
    best_variant.id,
    best_variant.generation_id,
    display_owner.generation_id,
    visible_rollup.variant_count,
    visible_rollup.visible_source_ids
  from lateral (
    select
      count(*)::integer as variant_count,
      array_agg(distinct variant.source_id order by variant.source_id)
        as visible_source_ids
    from public.cloud_catalog_visible_title_variants variant
    where variant.title_id = p_title_id
      and variant.user_id = p_user_id
  ) visible_rollup
  join lateral (
    select variant.id, variant.generation_id
    from public.cloud_catalog_visible_title_variants variant
    where variant.title_id = p_title_id
      and variant.user_id = p_user_id
    order by
      variant.playback_cost_score asc,
      variant.last_observed_ttff_ms asc nulls last,
      variant.created_at desc,
      variant.id asc
    limit 1
  ) best_variant on true
  join lateral (
    -- Display authority is deliberately independent of mutable playback
    -- cost/TTFF.  Source visibility and active-head changes bump the user
    -- visibility epoch; this total order is otherwise stable across pages.
    select variant.generation_id
    from public.cloud_catalog_visible_title_variants variant
    where variant.title_id = p_title_id
      and variant.user_id = p_user_id
    order by variant.source_id, variant.generation_id nulls first, variant.id
    limit 1
  ) display_owner on true
  where visible_rollup.variant_count > 0
$function$;

revoke all on function public.norva_visible_catalog_title_owner(uuid,uuid)
from public, anon, authenticated;
grant execute on function public.norva_visible_catalog_title_owner(uuid,uuid)
to service_role;

-- One raw slice only.  Callers continue with nextCursor until they have their
-- requested visible count or complete=true.  inspectedTitles is hard-bounded;
-- a page containing only stale/invisible branch rows never masquerades as an
-- exhausted result.  The account visibility epoch prevents A/B mixing across
-- RPC continuations.
create or replace function public.norva_select_catalog_title_ordered_page(
  p_user_id uuid,
  p_item_type text,
  p_mode text,
  p_limit integer default 100,
  p_scan_limit integer default 500,
  p_cursor jsonb default null,
  p_expected_visibility_epoch bigint default null
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
  v_epoch bigint;
  v_end_epoch bigint;
  v_cursor_sort_1 timestamptz;
  v_cursor_sort_2 timestamptz;
  v_cursor_title_id uuid;
  v_cursor_branch integer;
  v_cursor_projection_generation_id uuid;
  v_row record;
  v_items jsonb := '[]'::jsonb;
  v_accepted integer := 0;
  v_inspected integer := 0;
  v_stopped_for_limit boolean := false;
  v_complete boolean := false;
  v_next_cursor jsonb := null;
begin
  if v_role <> 'service_role'
     and not (v_role in ('', 'postgres') and session_user = 'postgres') then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_user_id is null or p_item_type not in ('movie','series')
     or p_mode not in ('home_verified','home_recent')
     or p_limit not between 1 and 300
     or p_scan_limit not between p_limit and 1000 then
    raise exception 'invalid catalog ordered-page arguments' using errcode = '22023';
  end if;
  if not public.norva_catalog_title_projection_indexes_ready() then
    raise exception 'catalog title selector indexes are not ready'
      using errcode = '55000';
  end if;

  select coalesce(epoch.visibility_epoch, 1) into v_epoch
  from (select 1) singleton
  left join public.cloud_user_catalog_visibility_epochs epoch
    on epoch.user_id = p_user_id;
  if p_expected_visibility_epoch is not null
     and p_expected_visibility_epoch <> v_epoch then
    raise exception 'catalog visibility epoch changed'
      using errcode = '40001', detail = 'reason=catalog_visibility_changed';
  end if;

  if p_cursor is not null then
    if jsonb_typeof(p_cursor) <> 'object'
       or p_cursor ->> 'mode' is distinct from p_mode
       or p_cursor ->> 'userId' is distinct from p_user_id::text
       or p_cursor ->> 'itemType' is distinct from p_item_type
       or (p_cursor ->> 'visibilityEpoch')::bigint <> v_epoch then
      raise exception 'catalog ordered-page cursor mismatch' using errcode = '22023';
    end if;
    begin
      v_cursor_sort_1 := (p_cursor ->> 'sort1')::timestamptz;
      v_cursor_sort_2 := (p_cursor ->> 'sort2')::timestamptz;
      v_cursor_title_id := (p_cursor ->> 'titleId')::uuid;
      v_cursor_branch := (p_cursor ->> 'branch')::integer;
      v_cursor_projection_generation_id := nullif(
        p_cursor ->> 'projectionGenerationId', ''
      )::uuid;
    exception when others then
      raise exception 'invalid catalog ordered-page cursor' using errcode = '22023';
    end;
    if v_cursor_sort_1 is null or v_cursor_sort_2 is null
       or v_cursor_title_id is null or v_cursor_branch not between 0 and 1
       or (v_cursor_branch = 0 and v_cursor_projection_generation_id is null)
       or (v_cursor_branch = 1 and v_cursor_projection_generation_id is not null) then
      raise exception 'incomplete catalog ordered-page cursor' using errcode = '22023';
    end if;
  end if;

  if p_mode = 'home_verified' then
    for v_row in
      with projection_page as materialized (
        select
          projection.title_id,
          projection.generation_id as projection_generation_id,
          projection.synced_at as sort_1,
          projection.updated_at as sort_2,
          0 as branch
        from public.cloud_source_catalog_heads head
        cross join lateral (
          -- Read only the generation at each active source head.  The
          -- generation-leading index makes a newer million-row BUILDING
          -- candidate irrelevant to this page instead of forcing thousands
          -- of rejected continuations before the active rows are reached.
          select candidate.*
          from public.cloud_source_catalog_generation_candidate_titles candidate
          where candidate.generation_id = head.active_generation_id
            and candidate.item_type = p_item_type
            and candidate.match_status = 'provider_verified'
            and (
              v_cursor_sort_1 is null
              or candidate.synced_at < v_cursor_sort_1
              or (candidate.synced_at = v_cursor_sort_1
                and candidate.updated_at < v_cursor_sort_2)
              or (candidate.synced_at = v_cursor_sort_1
                and candidate.updated_at = v_cursor_sort_2
                and candidate.title_id > v_cursor_title_id)
              or (candidate.synced_at = v_cursor_sort_1
                and candidate.updated_at = v_cursor_sort_2
                and candidate.title_id = v_cursor_title_id
                and 0 > v_cursor_branch)
              or (candidate.synced_at = v_cursor_sort_1
                and candidate.updated_at = v_cursor_sort_2
                and candidate.title_id = v_cursor_title_id
                and v_cursor_branch = 0
                and candidate.generation_id > v_cursor_projection_generation_id)
            )
          order by candidate.synced_at desc, candidate.updated_at desc,
            candidate.title_id
          limit p_scan_limit
        ) projection
        where head.user_id = p_user_id
        order by projection.synced_at desc, projection.updated_at desc,
          projection.title_id, branch, projection.generation_id
        limit p_scan_limit
      ), global_page as materialized (
        select
          title.id as title_id,
          null::uuid as projection_generation_id,
          title.synced_at as sort_1,
          title.updated_at as sort_2,
          1 as branch
        from public.cloud_titles title
        where title.user_id = p_user_id
          and title.item_type = p_item_type
          and title.match_status = 'provider_verified'
          and (
            v_cursor_sort_1 is null
            or title.synced_at < v_cursor_sort_1
            or (title.synced_at = v_cursor_sort_1
              and title.updated_at < v_cursor_sort_2)
            or (title.synced_at = v_cursor_sort_1
              and title.updated_at = v_cursor_sort_2
              and title.id > v_cursor_title_id)
            or (title.synced_at = v_cursor_sort_1
              and title.updated_at = v_cursor_sort_2
              and title.id = v_cursor_title_id
              and 1 > v_cursor_branch)
          )
        order by title.synced_at desc, title.updated_at desc, title.id, branch
        limit p_scan_limit
      ), raw_page as materialized (
        select * from projection_page
        union all
        select * from global_page
        order by sort_1 desc, sort_2 desc, title_id, branch,
          projection_generation_id nulls last
        limit p_scan_limit
      )
      select raw_page.*, owner.best_variant_id, owner.best_generation_id,
        owner.display_generation_id,
        owner.variant_count, owner.visible_source_ids,
        exists (
          select 1
          from public.cloud_source_catalog_generation_candidate_titles shadow
          where shadow.user_id = p_user_id
            and shadow.title_id = raw_page.title_id
            and shadow.generation_id = owner.display_generation_id
        ) as best_is_shadowed
      from raw_page
      left join lateral public.norva_visible_catalog_title_owner(
        raw_page.title_id, p_user_id
      ) owner on true
      order by raw_page.sort_1 desc, raw_page.sort_2 desc,
        raw_page.title_id, raw_page.branch,
        raw_page.projection_generation_id nulls last
    loop
      v_inspected := v_inspected + 1;
      v_cursor_sort_1 := v_row.sort_1;
      v_cursor_sort_2 := v_row.sort_2;
      v_cursor_title_id := v_row.title_id;
      v_cursor_branch := v_row.branch;
      v_cursor_projection_generation_id := v_row.projection_generation_id;
      if coalesce(v_row.variant_count, 0) > 0 and (
        (v_row.branch = 0
          and v_row.projection_generation_id = v_row.display_generation_id)
        or (v_row.branch = 1 and not v_row.best_is_shadowed)
      ) then
        v_items := v_items || jsonb_build_array(jsonb_build_object(
          'id', v_row.title_id,
          'bestVariantId', v_row.best_variant_id,
          'bestGenerationId', v_row.best_generation_id,
          'displayGenerationId', v_row.display_generation_id,
          'variantCount', v_row.variant_count,
          'visibleSourceIds', coalesce(to_jsonb(v_row.visible_source_ids), '[]'::jsonb)
        ));
        v_accepted := v_accepted + 1;
        if v_accepted >= p_limit then
          v_stopped_for_limit := true;
          exit;
        end if;
      end if;
    end loop;
  else
    for v_row in
      with projection_page as materialized (
        select
          projection.title_id,
          projection.generation_id as projection_generation_id,
          projection.catalog_created_at as sort_1,
          projection.synced_at as sort_2,
          0 as branch
        from public.cloud_source_catalog_heads head
        cross join lateral (
          select candidate.*
          from public.cloud_source_catalog_generation_candidate_titles candidate
          where candidate.generation_id = head.active_generation_id
            and candidate.item_type = p_item_type
            and (
              v_cursor_sort_1 is null
              or candidate.catalog_created_at < v_cursor_sort_1
              or (candidate.catalog_created_at = v_cursor_sort_1
                and candidate.synced_at < v_cursor_sort_2)
              or (candidate.catalog_created_at = v_cursor_sort_1
                and candidate.synced_at = v_cursor_sort_2
                and candidate.title_id > v_cursor_title_id)
              or (candidate.catalog_created_at = v_cursor_sort_1
                and candidate.synced_at = v_cursor_sort_2
                and candidate.title_id = v_cursor_title_id
                and 0 > v_cursor_branch)
              or (candidate.catalog_created_at = v_cursor_sort_1
                and candidate.synced_at = v_cursor_sort_2
                and candidate.title_id = v_cursor_title_id
                and v_cursor_branch = 0
                and candidate.generation_id > v_cursor_projection_generation_id)
            )
          order by candidate.catalog_created_at desc,
            candidate.synced_at desc, candidate.title_id
          limit p_scan_limit
        ) projection
        where head.user_id = p_user_id
        order by projection.catalog_created_at desc, projection.synced_at desc,
          projection.title_id, branch, projection.generation_id
        limit p_scan_limit
      ), global_page as materialized (
        select
          title.id as title_id,
          null::uuid as projection_generation_id,
          title.created_at as sort_1,
          title.synced_at as sort_2,
          1 as branch
        from public.cloud_titles title
        where title.user_id = p_user_id
          and title.item_type = p_item_type
          and (
            v_cursor_sort_1 is null
            or title.created_at < v_cursor_sort_1
            or (title.created_at = v_cursor_sort_1
              and title.synced_at < v_cursor_sort_2)
            or (title.created_at = v_cursor_sort_1
              and title.synced_at = v_cursor_sort_2
              and title.id > v_cursor_title_id)
            or (title.created_at = v_cursor_sort_1
              and title.synced_at = v_cursor_sort_2
              and title.id = v_cursor_title_id
              and 1 > v_cursor_branch)
          )
        order by title.created_at desc, title.synced_at desc, title.id, branch
        limit p_scan_limit
      ), raw_page as materialized (
        select * from projection_page
        union all
        select * from global_page
        order by sort_1 desc, sort_2 desc, title_id, branch,
          projection_generation_id nulls last
        limit p_scan_limit
      )
      select raw_page.*, owner.best_variant_id, owner.best_generation_id,
        owner.display_generation_id,
        owner.variant_count, owner.visible_source_ids,
        exists (
          select 1
          from public.cloud_source_catalog_generation_candidate_titles shadow
          where shadow.user_id = p_user_id
            and shadow.title_id = raw_page.title_id
            and shadow.generation_id = owner.display_generation_id
        ) as best_is_shadowed
      from raw_page
      left join lateral public.norva_visible_catalog_title_owner(
        raw_page.title_id, p_user_id
      ) owner on true
      order by raw_page.sort_1 desc, raw_page.sort_2 desc,
        raw_page.title_id, raw_page.branch,
        raw_page.projection_generation_id nulls last
    loop
      v_inspected := v_inspected + 1;
      v_cursor_sort_1 := v_row.sort_1;
      v_cursor_sort_2 := v_row.sort_2;
      v_cursor_title_id := v_row.title_id;
      v_cursor_branch := v_row.branch;
      v_cursor_projection_generation_id := v_row.projection_generation_id;
      if coalesce(v_row.variant_count, 0) > 0 and (
        (v_row.branch = 0
          and v_row.projection_generation_id = v_row.display_generation_id)
        or (v_row.branch = 1 and not v_row.best_is_shadowed)
      ) then
        v_items := v_items || jsonb_build_array(jsonb_build_object(
          'id', v_row.title_id,
          'bestVariantId', v_row.best_variant_id,
          'bestGenerationId', v_row.best_generation_id,
          'displayGenerationId', v_row.display_generation_id,
          'variantCount', v_row.variant_count,
          'visibleSourceIds', coalesce(to_jsonb(v_row.visible_source_ids), '[]'::jsonb)
        ));
        v_accepted := v_accepted + 1;
        if v_accepted >= p_limit then
          v_stopped_for_limit := true;
          exit;
        end if;
      end if;
    end loop;
  end if;

  -- A full raw slice is conservatively nonterminal; one final empty slice proves
  -- exhaustion.  A short slice proves it immediately.
  v_complete := not v_stopped_for_limit and v_inspected < p_scan_limit;
  if v_inspected > 0 and not v_complete then
    v_next_cursor := jsonb_build_object(
      'mode', p_mode,
      'userId', p_user_id,
      'itemType', p_item_type,
      'visibilityEpoch', v_epoch,
      'sort1', v_cursor_sort_1,
      'sort2', v_cursor_sort_2,
      'titleId', v_cursor_title_id,
      'branch', v_cursor_branch,
      'projectionGenerationId', v_cursor_projection_generation_id
    );
  end if;

  select coalesce(epoch.visibility_epoch, 1) into v_end_epoch
  from (select 1) singleton
  left join public.cloud_user_catalog_visibility_epochs epoch
    on epoch.user_id = p_user_id;
  if v_end_epoch <> v_epoch then
    raise exception 'catalog visibility changed during ordered page'
      using errcode = '40001', detail = 'reason=catalog_visibility_changed';
  end if;

  return jsonb_build_object(
    'contract', 'catalog-title-selector-v2',
    'mode', p_mode,
    'visibilityEpoch', v_epoch,
    'items', v_items,
    'returnedTitles', v_accepted,
    'inspectedTitles', v_inspected,
    'scanLimit', p_scan_limit,
    'nextCursor', v_next_cursor,
    'complete', v_complete
  );
end
$function$;

revoke all on function public.norva_select_catalog_title_ordered_page(
  uuid,text,text,integer,integer,jsonb,bigint
) from public, anon, authenticated;
grant execute on function public.norva_select_catalog_title_ordered_page(
  uuid,text,text,integer,integer,jsonb,bigint
) to service_role;

-- Bounded hydration computes the active-head runtime exactly once per title,
-- then chooses either the matching unpromoted projection or the physical row.
-- This replaces an IN(200/500) query against the UNION view, which evaluated
-- both branches and the runtime helper twice per requested title.
create or replace function public.norva_get_visible_catalog_titles_by_ids(
  p_user_id uuid,
  p_title_ids uuid[],
  p_expected_visibility_epoch bigint
) returns jsonb
language plpgsql
stable
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
  v_epoch bigint;
  v_result jsonb;
begin
  if v_role <> 'service_role'
     and not (v_role in ('', 'postgres') and session_user = 'postgres') then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_user_id is null or p_title_ids is null
     or cardinality(p_title_ids) not between 1 and 500
     or array_position(p_title_ids, null) is not null
     or p_expected_visibility_epoch is null then
    raise exception 'invalid catalog title hydration arguments' using errcode = '22023';
  end if;
  select coalesce(epoch.visibility_epoch, 1) into v_epoch
  from (select 1) singleton
  left join public.cloud_user_catalog_visibility_epochs epoch
    on epoch.user_id = p_user_id;
  if v_epoch <> p_expected_visibility_epoch then
    raise exception 'catalog visibility epoch changed'
      using errcode = '40001', detail = 'reason=catalog_visibility_changed';
  end if;

  with requested as materialized (
    select requested_id.title_id, min(requested_id.ordinality)::bigint as ordinal
    from unnest(p_title_ids) with ordinality requested_id(title_id, ordinality)
    group by requested_id.title_id
  ), hydrated as materialized (
    select
      requested.ordinal,
      base_title as title_row,
      title_runtime as runtime_row,
      projection.generation_id as overlay_generation_id,
      projection.item_type as projection_item_type,
      projection.identity_key as projection_identity_key,
      projection.identity_source as projection_identity_source,
      projection.provider_tmdb_id as projection_provider_tmdb_id,
      projection.provider_imdb_id as projection_provider_imdb_id,
      projection.match_status as projection_match_status,
      projection.title as projection_title,
      projection.original_title as projection_original_title,
      projection.release_year as projection_release_year,
      projection.poster_url as projection_poster_url,
      projection.backdrop_url as projection_backdrop_url,
      projection.metadata as projection_metadata,
      projection.catalog_metadata as projection_catalog_metadata,
      projection.synced_at as projection_synced_at,
      projection.catalog_created_at as projection_catalog_created_at,
      projection.updated_at as projection_updated_at,
      projection.genre_category as projection_genre_category,
      projection.genre_payload as projection_genre_payload,
      projection.genre_buckets as projection_genre_buckets,
      projection.rating_num as projection_rating_num,
      projection.year_backfill_attempted_at
        as projection_year_backfill_attempted_at,
      projection.revalidate_attempted_at
        as projection_revalidate_attempted_at,
      projection.search_match_attempted_at
        as projection_search_match_attempted_at
    from requested
    join public.cloud_titles base_title
      on base_title.id = requested.title_id and base_title.user_id = p_user_id
    cross join lateral public.norva_visible_catalog_title_runtime(
      base_title.id, base_title.user_id
    ) title_runtime
    left join public.cloud_source_catalog_generation_candidate_titles projection
      on projection.user_id = base_title.user_id
     and projection.title_id = base_title.id
     and projection.generation_id = title_runtime.display_generation_id
  ), effective as (
    select
      hydrated.ordinal,
      (hydrated.title_row).id,
      (hydrated.title_row).user_id,
      coalesce(hydrated.projection_item_type, (hydrated.title_row).item_type) as item_type,
      coalesce(hydrated.projection_identity_key, (hydrated.title_row).identity_key) as identity_key,
      coalesce(hydrated.projection_identity_source, (hydrated.title_row).identity_source) as identity_source,
      case when hydrated.overlay_generation_id is not null
        then hydrated.projection_provider_tmdb_id
        else (hydrated.title_row).provider_tmdb_id end as provider_tmdb_id,
      case when hydrated.overlay_generation_id is not null
        then hydrated.projection_provider_imdb_id
        else (hydrated.title_row).provider_imdb_id end as provider_imdb_id,
      coalesce(hydrated.projection_match_status, (hydrated.title_row).match_status) as match_status,
      coalesce(hydrated.projection_title, (hydrated.title_row).title) as title,
      case when hydrated.overlay_generation_id is not null
        then hydrated.projection_original_title
        else (hydrated.title_row).original_title end as original_title,
      case when hydrated.overlay_generation_id is not null
        then hydrated.projection_release_year
        else (hydrated.title_row).release_year end as release_year,
      case when hydrated.overlay_generation_id is not null
        then hydrated.projection_poster_url
        else (hydrated.title_row).poster_url end as poster_url,
      case when hydrated.overlay_generation_id is not null
        then hydrated.projection_backdrop_url
        else (hydrated.title_row).backdrop_url end as backdrop_url,
      case when hydrated.overlay_generation_id is not null
        then hydrated.projection_metadata
        else (hydrated.title_row).metadata end as metadata,
      -- Private, generation-scoped full metadata used by Edge to apply the
      -- same flag-dependent overlay without consulting the unversioned global
      -- catalog.  It is emitted only for a P-authoritative row and stripped
      -- before cache/public serialization.
      case when hydrated.overlay_generation_id is not null
        then hydrated.projection_catalog_metadata
        else null::jsonb end as overlay_catalog_metadata,
      (hydrated.runtime_row).best_variant_id as default_variant_id,
      (hydrated.runtime_row).variant_count,
      (hydrated.runtime_row).last_observed_ttff_ms,
      coalesce(hydrated.projection_synced_at, (hydrated.title_row).synced_at) as synced_at,
      coalesce(
        hydrated.projection_catalog_created_at,
        (hydrated.title_row).created_at
      ) as created_at,
      coalesce(hydrated.projection_updated_at, (hydrated.title_row).updated_at) as updated_at,
      (hydrated.runtime_row).version_languages,
      (hydrated.runtime_row).file_audio_languages as audio_languages,
      (hydrated.runtime_row).audio_probed_at,
      null::jsonb as audio_tracks,
      case when hydrated.overlay_generation_id is not null
        then hydrated.projection_genre_category
        else (hydrated.title_row).genre_category end as genre_category,
      case when hydrated.overlay_generation_id is not null
        then hydrated.projection_genre_payload
        else (hydrated.title_row).genre_payload end as genre_payload,
      '[]'::jsonb as subtitle_tracks,
      (hydrated.runtime_row).subtitle_probed_at,
      (hydrated.runtime_row).whisper_attempted_at,
      case when hydrated.overlay_generation_id is not null
        then hydrated.projection_year_backfill_attempted_at
        else (hydrated.title_row).year_backfill_attempted_at
        end as year_backfill_attempted_at,
      case when hydrated.overlay_generation_id is not null
        then hydrated.projection_revalidate_attempted_at
        else (hydrated.title_row).revalidate_attempted_at
        end as revalidate_attempted_at,
      case when hydrated.overlay_generation_id is not null
        then hydrated.projection_search_match_attempted_at
        else (hydrated.title_row).search_match_attempted_at
        end as search_match_attempted_at,
      (hydrated.runtime_row).audio_lang_verified_at,
      case when hydrated.overlay_generation_id is not null
        then hydrated.projection_genre_buckets
        else (hydrated.title_row).genre_buckets end as genre_buckets,
      case when hydrated.overlay_generation_id is not null
        then hydrated.projection_rating_num
        else (hydrated.title_row).rating_num end as rating_num,
      (hydrated.runtime_row).file_audio_languages,
      (hydrated.runtime_row).file_subtitle_languages,
      (hydrated.runtime_row).file_audio_verified_languages,
      (hydrated.runtime_row).visible_source_ids,
      (hydrated.runtime_row).best_generation_id,
      (hydrated.runtime_row).display_generation_id,
      hydrated.overlay_generation_id,
      (hydrated.title_row).updated_at as base_updated_at
    from hydrated
  )
  select jsonb_build_object(
    'contract', 'catalog-title-hydration-v3',
    'visibilityEpoch', v_epoch,
    'items', coalesce(
      jsonb_agg(to_jsonb(effective) - 'ordinal' order by effective.ordinal),
      '[]'::jsonb
    )
  ) into v_result
  from effective;

  if octet_length(v_result::text) > 8388608 then
    raise exception 'catalog title hydration payload exceeds bounded response'
      using errcode = '54000', detail = 'reason=catalog_hydration_payload_too_large';
  end if;

  if public.norva_user_catalog_visibility_epoch(p_user_id) <> v_epoch then
    raise exception 'catalog visibility changed during title hydration'
      using errcode = '40001', detail = 'reason=catalog_visibility_changed';
  end if;
  return v_result;
end
$function$;

revoke all on function public.norva_get_visible_catalog_titles_by_ids(
  uuid,uuid[],bigint
) from public, anon, authenticated;
grant execute on function public.norva_get_visible_catalog_titles_by_ids(
  uuid,uuid[],bigint
) to service_role;

do $assert$
declare
  v_owner_rows real;
  v_runtime_rows real;
begin
  select procedure_state.prorows into v_owner_rows
  from pg_proc procedure_state
  where procedure_state.oid =
    'public.norva_visible_catalog_title_owner(uuid,uuid)'::regprocedure;
  select procedure_state.prorows into v_runtime_rows
  from pg_proc procedure_state
  where procedure_state.oid =
    'public.norva_visible_catalog_title_runtime(uuid,uuid)'::regprocedure;
  if v_owner_rows is distinct from 1::real
     or v_runtime_rows is distinct from 1::real
     or not public.norva_catalog_title_projection_indexes_ready()
     or not has_function_privilege(
       'service_role',
       'public.norva_select_catalog_title_ordered_page(uuid,text,text,integer,integer,jsonb,bigint)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'service_role',
       'public.norva_get_visible_catalog_titles_by_ids(uuid,uuid[],bigint)',
       'EXECUTE'
     )
     or has_function_privilege(
       'authenticated',
       'public.norva_select_catalog_title_ordered_page(uuid,text,text,integer,integer,jsonb,bigint)',
       'EXECUTE'
     )
     or has_function_privilege(
       'anon',
       'public.norva_get_visible_catalog_titles_by_ids(uuid,uuid[],bigint)',
       'EXECUTE'
     ) then
    raise exception 'catalog title selector contract drift' using errcode = '55000';
  end if;
end
$assert$;

commit;
