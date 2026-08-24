begin;
set local lock_timeout = '2s';
set local statement_timeout = '15s';

-- Background selectors read the same deterministic display owner as catalogue
-- hydration. A generation projection remains authoritative after its global
-- mirror completes; cloud_titles is only the legacy fallback.
create or replace function public.norva_select_catalog_title_background_page(
  p_mode text,
  p_limit integer default 200,
  p_scan_limit integer default 500,
  p_retry_before timestamptz default null,
  p_cursor jsonb default null,
  p_user_id uuid default null
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
  v_cursor_id uuid;
  v_row record;
  v_items jsonb := '[]'::jsonb;
  v_returned integer := 0;
  v_inspected integer := 0;
  v_stopped_for_limit boolean := false;
  v_complete boolean;
  v_next_cursor jsonb := null;
begin
  if v_role <> 'service_role'
     and not (v_role in ('', 'postgres') and session_user = 'postgres') then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_mode not in ('year_pending','revalidate_pending','search_pending')
     or p_limit not between 1 and 500
     or p_scan_limit not between p_limit and 1000
     or p_retry_before is null then
    raise exception 'invalid catalog background selector arguments'
      using errcode = '22023';
  end if;
  if not public.norva_catalog_title_projection_indexes_ready() then
    raise exception 'catalog title selector indexes are not ready'
      using errcode = '55000';
  end if;
  if p_cursor is not null then
    if jsonb_typeof(p_cursor) <> 'object'
       or p_cursor ->> 'mode' is distinct from p_mode
       or coalesce(p_cursor ->> 'userId', '')
          is distinct from coalesce(p_user_id::text, '') then
      raise exception 'catalog background cursor mismatch' using errcode = '22023';
    end if;
    begin
      v_cursor_id := (p_cursor ->> 'lastId')::uuid;
    exception when others then
      raise exception 'invalid catalog background cursor' using errcode = '22023';
    end;
    if v_cursor_id is null then
      raise exception 'incomplete catalog background cursor' using errcode = '22023';
    end if;
  end if;

  for v_row in
    with base_ids as materialized (
      select title.id
      from public.cloud_titles title
      where (v_cursor_id is null or title.id > v_cursor_id)
        and (p_user_id is null or title.user_id = p_user_id)
        and case p_mode
          when 'year_pending' then
            title.release_year is null
            and title.provider_tmdb_id is not null
            and (title.year_backfill_attempted_at is null
              or title.year_backfill_attempted_at < p_retry_before)
          when 'revalidate_pending' then
            title.match_status in ('provider_unverified','weak')
            and title.provider_tmdb_id is not null
            and title.provider_tmdb_id <> '0'
            and (title.revalidate_attempted_at is null
              or title.revalidate_attempted_at < p_retry_before)
          when 'search_pending' then
            title.match_status = 'unmatched'
            and (title.search_match_attempted_at is null
              or title.search_match_attempted_at < p_retry_before)
          else false
        end
      order by title.id
      limit p_scan_limit
    ), projection_ids as materialized (
      select projection.title_id as id
      from public.cloud_source_catalog_generation_candidate_titles projection
      join public.cloud_source_catalog_heads head
        on head.source_id = projection.source_id
       and head.user_id = projection.user_id
       and head.active_generation_id = projection.generation_id
      where (v_cursor_id is null or projection.title_id > v_cursor_id)
        and (p_user_id is null or projection.user_id = p_user_id)
        and case p_mode
          when 'year_pending' then
            projection.release_year is null
            and projection.provider_tmdb_id is not null
            and (projection.year_backfill_attempted_at is null
              or projection.year_backfill_attempted_at < p_retry_before)
          when 'revalidate_pending' then
            projection.match_status in ('provider_unverified','weak')
            and projection.provider_tmdb_id is not null
            and projection.provider_tmdb_id <> '0'
            and (projection.revalidate_attempted_at is null
              or projection.revalidate_attempted_at < p_retry_before)
          when 'search_pending' then
            projection.match_status = 'unmatched'
            and (projection.search_match_attempted_at is null
              or projection.search_match_attempted_at < p_retry_before)
          else false
        end
      order by projection.title_id
      limit p_scan_limit
    ), candidate_ids as materialized (
      select id from base_ids
      union
      select id from projection_ids
      order by id
      limit p_scan_limit
    )
    select
      candidate.id,
      title.user_id,
      owner.best_variant_id,
      owner.best_generation_id,
      owner.display_generation_id,
      owner.variant_count,
      coalesce(epoch.visibility_epoch, 1) as visibility_epoch,
      case
        when projection.title_id is not null then 'projection'
        when projection.title_id is null then 'global'
        else null
      end as storage_kind,
      case when projection.title_id is not null
        then projection.item_type else title.item_type end as item_type,
      case when projection.title_id is not null
        then projection.provider_tmdb_id else title.provider_tmdb_id end
        as provider_tmdb_id,
      case when projection.title_id is not null
        then projection.title else title.title end as title,
      case when projection.title_id is not null
        then projection.original_title else title.original_title end
        as original_title,
      case when projection.title_id is not null
        then projection.release_year else title.release_year end as release_year,
      case when projection.title_id is not null
        then projection.catalog_metadata else title.metadata end as catalog_metadata,
      case when projection.title_id is not null
        then projection.poster_url else title.poster_url end as poster_url,
      case when projection.title_id is not null
        then projection.backdrop_url else title.backdrop_url end as backdrop_url,
      case when projection.title_id is not null
        then projection.updated_at else title.updated_at end as payload_updated_at,
      case p_mode
        when 'year_pending' then
          (case when projection.title_id is not null
            then projection.release_year else title.release_year end) is null
          and (case when projection.title_id is not null
            then projection.provider_tmdb_id else title.provider_tmdb_id end)
              is not null
          and ((case when projection.title_id is not null
              then projection.year_backfill_attempted_at
              else title.year_backfill_attempted_at end) is null
            or (case when projection.title_id is not null
              then projection.year_backfill_attempted_at
              else title.year_backfill_attempted_at end) < p_retry_before)
        when 'revalidate_pending' then
          (case when projection.title_id is not null
            then projection.match_status else title.match_status end)
              in ('provider_unverified','weak')
          and (case when projection.title_id is not null
            then projection.provider_tmdb_id else title.provider_tmdb_id end)
              is not null
          and (case when projection.title_id is not null
            then projection.provider_tmdb_id else title.provider_tmdb_id end) <> '0'
          and ((case when projection.title_id is not null
              then projection.revalidate_attempted_at
              else title.revalidate_attempted_at end) is null
            or (case when projection.title_id is not null
              then projection.revalidate_attempted_at
              else title.revalidate_attempted_at end) < p_retry_before)
        when 'search_pending' then
          (case when projection.title_id is not null
            then projection.match_status else title.match_status end) = 'unmatched'
          and ((case when projection.title_id is not null
              then projection.search_match_attempted_at
              else title.search_match_attempted_at end) is null
            or (case when projection.title_id is not null
              then projection.search_match_attempted_at
              else title.search_match_attempted_at end) < p_retry_before)
        else false
      end as effective_matches
    from candidate_ids candidate
    join public.cloud_titles title on title.id = candidate.id
    left join lateral public.norva_visible_catalog_title_owner(
      title.id, title.user_id
    ) owner on true
    left join public.cloud_source_catalog_generation_candidate_titles projection
      on projection.user_id = title.user_id
     and projection.title_id = title.id
     and projection.generation_id = owner.display_generation_id
    left join public.cloud_user_catalog_visibility_epochs epoch
      on epoch.user_id = title.user_id
    order by candidate.id
  loop
    v_inspected := v_inspected + 1;
    v_cursor_id := v_row.id;
    if coalesce(v_row.variant_count, 0) > 0
       and v_row.storage_kind is not null
       and v_row.effective_matches then
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'id', v_row.id,
        'userId', v_row.user_id,
        'itemType', v_row.item_type,
        'providerTmdbId', v_row.provider_tmdb_id,
        'title', v_row.title,
        'originalTitle', v_row.original_title,
        'releaseYear', v_row.release_year,
        'metadata', v_row.catalog_metadata,
        'posterUrl', v_row.poster_url,
        'backdropUrl', v_row.backdrop_url,
        'storageKind', v_row.storage_kind,
        'visibilityEpoch', v_row.visibility_epoch,
        'payloadUpdatedAt', v_row.payload_updated_at,
        'bestGenerationId', v_row.best_generation_id,
        'displayGenerationId', v_row.display_generation_id,
        'bestVariantId', v_row.best_variant_id
      ));
      v_returned := v_returned + 1;
      if v_returned >= p_limit then
        v_stopped_for_limit := true;
        exit;
      end if;
    end if;
  end loop;

  v_complete := not v_stopped_for_limit and v_inspected < p_scan_limit;
  if v_inspected > 0 and not v_complete then
    v_next_cursor := jsonb_build_object(
      'mode', p_mode, 'userId', p_user_id, 'lastId', v_cursor_id
    );
  end if;
  return jsonb_build_object(
    'contract', 'catalog-title-background-selector-v3',
    'mode', p_mode,
    'items', v_items,
    'returnedTitles', v_returned,
    'inspectedTitles', v_inspected,
    'scanLimit', p_scan_limit,
    'complete', v_complete,
    'nextCursor', v_next_cursor
  );
end
$function$;

revoke all on function public.norva_select_catalog_title_background_page(
  text,integer,integer,timestamptz,jsonb,uuid
) from public, anon, authenticated, service_role;
grant execute on function public.norva_select_catalog_title_background_page(
  text,integer,integer,timestamptz,jsonb,uuid
) to service_role;

-- The writer locks the visibility epoch before exactly one payload store.
drop function if exists public.norva_apply_catalog_title_background_result(
  text,uuid,uuid,bigint,timestamptz,uuid,jsonb
);
create or replace function public.norva_apply_catalog_title_background_result(
  p_mode text,
  p_user_id uuid,
  p_title_id uuid,
  p_storage_kind text,
  p_expected_visibility_epoch bigint,
  p_expected_payload_updated_at timestamptz,
  p_expected_display_generation_id uuid,
  p_result jsonb
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
  v_title public.cloud_titles%rowtype;
  v_projection public.cloud_source_catalog_generation_candidate_titles%rowtype;
  v_generation public.cloud_source_catalog_generations%rowtype;
  v_display_generation_id uuid;
  v_best_generation_id uuid;
  v_matched boolean := false;
  v_release_year integer;
  v_metadata jsonb;
  v_title_text text;
  v_original_title text;
  v_provider_tmdb_id text;
  v_poster_url text;
  v_backdrop_url text;
  v_applied_at timestamptz := clock_timestamp();
  v_visible_changed boolean := false;
begin
  if v_role <> 'service_role'
     and not (v_role in ('', 'postgres') and session_user = 'postgres') then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_mode not in ('year_pending','revalidate_pending','search_pending')
     or p_storage_kind not in ('global','projection')
     or p_user_id is null or p_title_id is null
     or p_expected_visibility_epoch is null
     or p_expected_payload_updated_at is null
     or (p_storage_kind = 'projection'
       and p_expected_display_generation_id is null)
     or p_result is null or jsonb_typeof(p_result) <> 'object'
     or octet_length(p_result::text) > 262144 then
    raise exception 'invalid catalog background result arguments'
      using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_result) supplied(key)
    where supplied.key not in (
      'matched','releaseYear','providerTmdbId','title','originalTitle',
      'posterUrl','backdropUrl','metadata'
    )
  ) then
    raise exception 'catalog background result contains unsupported fields'
      using errcode = '22023';
  end if;

  -- Shared lock order for every durable projection writer/publisher/swap:
  -- generation -> user visibility epoch -> projection -> catalog_titles.
  -- Candidate projection AFTER STATEMENT guards also lock this generation row,
  -- so taking it first avoids gen<->epoch and gen<->projection deadlocks.
  if p_expected_display_generation_id is not null then
    select generation.* into v_generation
    from public.cloud_source_catalog_generations generation
    where generation.id = p_expected_display_generation_id
      and generation.user_id = p_user_id
      and generation.state = 'active'
    for update;
    if not found then
      raise exception 'catalog background generation CAS failed'
        using errcode = '40001', detail = 'reason=catalog_generation_changed';
    end if;
  end if;

  insert into public.cloud_user_catalog_visibility_epochs(
    user_id, visibility_epoch, updated_at
  ) values (p_user_id, 1, now())
  on conflict (user_id) do nothing;
  select epoch.visibility_epoch into v_epoch
  from public.cloud_user_catalog_visibility_epochs epoch
  where epoch.user_id = p_user_id
  for update;
  if v_epoch <> p_expected_visibility_epoch then
    raise exception 'catalog background visibility CAS failed'
      using errcode = '40001', detail = 'reason=catalog_visibility_changed';
  end if;

  if p_storage_kind = 'projection' then
    select projection.* into v_projection
    from public.cloud_source_catalog_generation_candidate_titles projection
    where projection.generation_id = p_expected_display_generation_id
      and projection.title_id = p_title_id
      and projection.user_id = p_user_id
    for update of projection;
    if not found
       or v_projection.updated_at is distinct from p_expected_payload_updated_at then
      raise exception 'catalog background projection CAS failed'
        using errcode = '40001', detail = 'reason=catalog_payload_changed';
    end if;
  else
    select title.* into v_title
    from public.cloud_titles title
    where title.id = p_title_id and title.user_id = p_user_id
    for update;
    if not found or v_title.updated_at is distinct from p_expected_payload_updated_at then
      raise exception 'catalog background title CAS failed'
        using errcode = '40001', detail = 'reason=catalog_payload_changed';
    end if;
  end if;

  select owner.best_generation_id, owner.display_generation_id
    into v_best_generation_id, v_display_generation_id
  from public.norva_visible_catalog_title_owner(p_title_id, p_user_id) owner;
  if not found
     or v_display_generation_id is distinct from p_expected_display_generation_id
     or (p_storage_kind = 'projection' and v_projection.generation_id
          is distinct from v_display_generation_id)
     or (p_storage_kind = 'global' and exists (
       select 1
       from public.cloud_source_catalog_generation_candidate_titles projection
       where projection.user_id = p_user_id
         and projection.title_id = p_title_id
         and projection.generation_id = v_display_generation_id
     )) then
    raise exception 'catalog background display generation CAS failed'
      using errcode = '40001', detail = 'reason=catalog_generation_changed';
  end if;

  if p_mode = 'year_pending' then
    if p_result ?| array[
         'matched','providerTmdbId','title','originalTitle',
         'posterUrl','backdropUrl','metadata'
       ] then
      raise exception 'invalid year background result' using errcode = '22023';
    end if;
    if p_result ? 'releaseYear' and p_result -> 'releaseYear' <> 'null'::jsonb then
      begin
        v_release_year := (p_result ->> 'releaseYear')::integer;
      exception when others then
        raise exception 'invalid release year' using errcode = '22023';
      end;
      if v_release_year not between 1900 and 2100 then
        raise exception 'invalid release year' using errcode = '22023';
      end if;
    end if;
    if p_storage_kind = 'projection' then
      v_visible_changed := v_release_year is not null
        and v_release_year is distinct from v_projection.release_year;
      update public.cloud_source_catalog_generation_candidate_titles projection
      set release_year = coalesce(v_release_year, projection.release_year),
          year_backfill_attempted_at = v_applied_at,
          updated_at = case when v_visible_changed
            then v_applied_at else projection.updated_at end
      where projection.generation_id = v_projection.generation_id
        and projection.title_id = p_title_id;
    else
      v_visible_changed := v_release_year is not null
        and v_release_year is distinct from v_title.release_year;
      update public.cloud_titles title
      set release_year = coalesce(v_release_year, title.release_year),
          year_backfill_attempted_at = v_applied_at,
          updated_at = case when v_visible_changed
            then v_applied_at else title.updated_at end
      where title.id = p_title_id and title.user_id = p_user_id;
    end if;
  else
    if jsonb_typeof(p_result -> 'matched') <> 'boolean' then
      raise exception 'matched boolean is required' using errcode = '22023';
    end if;
    v_matched := (p_result ->> 'matched')::boolean;
    if v_matched then
      v_title_text := nullif(btrim(p_result ->> 'title'), '');
      v_original_title := nullif(btrim(p_result ->> 'originalTitle'), '');
      v_provider_tmdb_id := nullif(btrim(p_result ->> 'providerTmdbId'), '');
      v_poster_url := nullif(btrim(p_result ->> 'posterUrl'), '');
      v_backdrop_url := nullif(btrim(p_result ->> 'backdropUrl'), '');
      v_metadata := p_result -> 'metadata';
      if v_title_text is null or length(v_title_text) > 1000
         or (v_original_title is not null and length(v_original_title) > 1000)
         or (v_poster_url is not null and length(v_poster_url) > 4096)
         or (v_backdrop_url is not null and length(v_backdrop_url) > 4096)
         or v_metadata is null or jsonb_typeof(v_metadata) <> 'object' then
        raise exception 'invalid matched catalog background payload'
          using errcode = '22023';
      end if;
      if p_result ? 'releaseYear' and p_result -> 'releaseYear' <> 'null'::jsonb then
        begin
          v_release_year := (p_result ->> 'releaseYear')::integer;
        exception when others then
          raise exception 'invalid release year' using errcode = '22023';
        end;
        if v_release_year not between 1900 and 2100 then
          raise exception 'invalid release year' using errcode = '22023';
        end if;
      end if;
      if p_mode = 'search_pending'
         and (v_provider_tmdb_id is null or length(v_provider_tmdb_id) > 64) then
        raise exception 'search match provider id is required' using errcode = '22023';
      end if;
      if p_mode = 'revalidate_pending'
         and v_provider_tmdb_id is not null
         and v_provider_tmdb_id is distinct from coalesce(
           v_projection.provider_tmdb_id, v_title.provider_tmdb_id
         ) then
        raise exception 'revalidation cannot replace provider id' using errcode = '22023';
      end if;
    end if;

    if p_storage_kind = 'projection' then
      v_visible_changed := v_matched and (
        v_projection.match_status is distinct from 'provider_verified'
        or (p_mode = 'search_pending' and v_projection.provider_tmdb_id
          is distinct from v_provider_tmdb_id)
        or v_projection.title is distinct from v_title_text
        or (v_original_title is not null and v_projection.original_title
          is distinct from v_original_title)
        or (v_release_year is not null and v_projection.release_year
          is distinct from v_release_year)
        or (v_poster_url is not null and v_projection.poster_url
          is distinct from v_poster_url)
        or (v_backdrop_url is not null and v_projection.backdrop_url
          is distinct from v_backdrop_url)
        or v_projection.catalog_metadata is distinct from v_metadata
      );
      update public.cloud_source_catalog_generation_candidate_titles projection
      set provider_tmdb_id = case when v_matched and p_mode = 'search_pending'
            then v_provider_tmdb_id else projection.provider_tmdb_id end,
          match_status = case when v_matched
            then 'provider_verified' else projection.match_status end,
          title = case when v_matched then v_title_text else projection.title end,
          original_title = case when v_matched
            then coalesce(v_original_title, projection.original_title)
            else projection.original_title end,
          release_year = case when v_matched
            then coalesce(v_release_year, projection.release_year)
            else projection.release_year end,
          poster_url = case when v_matched
            then coalesce(v_poster_url, projection.poster_url)
            else projection.poster_url end,
          backdrop_url = case when v_matched
            then coalesce(v_backdrop_url, projection.backdrop_url)
            else projection.backdrop_url end,
          catalog_metadata = case when v_matched
            then v_metadata else projection.catalog_metadata end,
          metadata = case when not v_matched then projection.metadata
            when coalesce(case when p_mode = 'search_pending'
                then v_provider_tmdb_id else projection.provider_tmdb_id end, '') <> ''
              and coalesce(case when p_mode = 'search_pending'
                then v_provider_tmdb_id else projection.provider_tmdb_id end, '')
                  !~ '^(tt)?0+$'
              and v_metadata <> '{}'::jsonb then '{}'::jsonb
            else v_metadata end,
          genre_category = case when v_matched and v_metadata ? 'categoryName'
            then v_metadata ->> 'categoryName' else projection.genre_category end,
          genre_payload = case when v_matched
              and v_metadata #> '{tmdb,genres}' is not null
            then v_metadata #> '{tmdb,genres}' else projection.genre_payload end,
          genre_buckets = case when v_matched then
            public.norva_classify_buckets(
              case when v_metadata ? 'categoryName'
                then v_metadata ->> 'categoryName' else projection.genre_category end,
              case when v_metadata #> '{tmdb,genres}' is not null
                then v_metadata #> '{tmdb,genres}' else projection.genre_payload end
            ) else projection.genre_buckets end,
          rating_num = case when v_matched
            then coalesce(public.safe_numeric(
              v_metadata #>> '{tmdb,vote_average}'
            ), projection.rating_num) else projection.rating_num end,
          revalidate_attempted_at = case when p_mode = 'revalidate_pending'
            then v_applied_at else projection.revalidate_attempted_at end,
          search_match_attempted_at = case when p_mode = 'search_pending'
            then v_applied_at else projection.search_match_attempted_at end,
          updated_at = case when v_visible_changed
            then v_applied_at else projection.updated_at end
      where projection.generation_id = v_projection.generation_id
        and projection.title_id = p_title_id;
    else
      v_visible_changed := v_matched and (
        v_title.match_status is distinct from 'provider_verified'
        or (p_mode = 'search_pending' and v_title.provider_tmdb_id
          is distinct from v_provider_tmdb_id)
        or v_title.title is distinct from v_title_text
        or (v_original_title is not null and v_title.original_title
          is distinct from v_original_title)
        or (v_release_year is not null and v_title.release_year
          is distinct from v_release_year)
        or (v_poster_url is not null and v_title.poster_url
          is distinct from v_poster_url)
        or (v_backdrop_url is not null and v_title.backdrop_url
          is distinct from v_backdrop_url)
        or v_title.metadata is distinct from v_metadata
      );
      update public.cloud_titles title
      set provider_tmdb_id = case when v_matched and p_mode = 'search_pending'
            then v_provider_tmdb_id else title.provider_tmdb_id end,
          match_status = case when v_matched
            then 'provider_verified' else title.match_status end,
          title = case when v_matched then v_title_text else title.title end,
          original_title = case when v_matched
            then coalesce(v_original_title, title.original_title)
            else title.original_title end,
          release_year = case when v_matched
            then coalesce(v_release_year, title.release_year)
            else title.release_year end,
          poster_url = case when v_matched
            then coalesce(v_poster_url, title.poster_url)
            else title.poster_url end,
          backdrop_url = case when v_matched
            then coalesce(v_backdrop_url, title.backdrop_url)
            else title.backdrop_url end,
          metadata = case when v_matched then v_metadata else title.metadata end,
          revalidate_attempted_at = case when p_mode = 'revalidate_pending'
            then v_applied_at else title.revalidate_attempted_at end,
          search_match_attempted_at = case when p_mode = 'search_pending'
            then v_applied_at else title.search_match_attempted_at end,
          updated_at = case when v_visible_changed
            then v_applied_at else title.updated_at end
      where title.id = p_title_id and title.user_id = p_user_id;
    end if;
  end if;

  if p_storage_kind = 'projection'
     and exists (
       select 1
       from public.cloud_source_catalog_generation_title_promotions promotion
       where promotion.generation_id = v_projection.generation_id
         and promotion.user_id = p_user_id
         and promotion.phase = 'complete'
     ) and (
       v_visible_changed or (p_mode = 'year_pending' and v_release_year is not null)
     ) then
    insert into public.catalog_titles (
      item_type, provider_tmdb_id, title, original_title, release_year,
      poster_url, backdrop_url, metadata, enriched_at, updated_at
    )
    select projection.item_type, projection.provider_tmdb_id,
      projection.title, projection.original_title, projection.release_year,
      projection.poster_url, projection.backdrop_url,
      projection.catalog_metadata, v_applied_at, v_applied_at
    from public.cloud_source_catalog_generation_candidate_titles projection
    where projection.generation_id = v_projection.generation_id
      and projection.title_id = p_title_id
      and projection.provider_tmdb_id is not null
      and projection.provider_tmdb_id <> ''
      and projection.provider_tmdb_id !~ '^(tt)?0+$'
      and projection.catalog_metadata <> '{}'::jsonb
    on conflict (item_type, provider_tmdb_id) do update set
      title = excluded.title,
      original_title = excluded.original_title,
      release_year = excluded.release_year,
      poster_url = excluded.poster_url,
      backdrop_url = excluded.backdrop_url,
      metadata = excluded.metadata,
      updated_at = excluded.updated_at;
  end if;

  if v_visible_changed then
    v_epoch := public.norva_bump_user_catalog_visibility_epoch(p_user_id);
    delete from public.cloud_catalog_facet_summary where user_id = p_user_id;
  end if;
  return jsonb_build_object(
    'contract', 'catalog-title-background-writer-v3',
    'mode', p_mode,
    'titleId', p_title_id,
    'storageKind', p_storage_kind,
    'visibilityEpoch', v_epoch,
    'bestGenerationId', v_best_generation_id,
    'displayGenerationId', v_display_generation_id,
    'applied', true,
    'visibleChanged', v_visible_changed,
    'matched', coalesce(v_matched, v_release_year is not null),
    'appliedAt', v_applied_at
  );
end
$function$;

revoke all on function public.norva_apply_catalog_title_background_result(
  text,uuid,uuid,text,bigint,timestamptz,uuid,jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.norva_apply_catalog_title_background_result(
  text,uuid,uuid,text,bigint,timestamptz,uuid,jsonb
) to service_role;

do $assert$
begin
  if not has_function_privilege(
       'service_role',
       'public.norva_select_catalog_title_background_page(text,integer,integer,timestamptz,jsonb,uuid)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'service_role',
       'public.norva_apply_catalog_title_background_result(text,uuid,uuid,text,bigint,timestamptz,uuid,jsonb)',
       'EXECUTE'
     )
     or has_function_privilege(
       'authenticated',
       'public.norva_apply_catalog_title_background_result(text,uuid,uuid,text,bigint,timestamptz,uuid,jsonb)',
       'EXECUTE'
     )
     or has_function_privilege(
       'anon',
       'public.norva_select_catalog_title_background_page(text,integer,integer,timestamptz,jsonb,uuid)',
       'EXECUTE'
     )
     or to_regprocedure(
       'public.norva_apply_catalog_title_background_result(text,uuid,uuid,bigint,timestamptz,uuid,jsonb)'
     ) is not null then
    raise exception 'catalog background selector/writer ACL drift'
      using errcode = '55000';
  end if;
end
$assert$;

commit;
