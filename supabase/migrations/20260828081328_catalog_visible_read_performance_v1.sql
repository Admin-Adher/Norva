begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

-- The lifecycle projection is deliberately a security-barrier view.  Joining
-- that projection from every media row made PostgreSQL re-evaluate the
-- Provider Access eligibility predicate hundreds of thousands of times.  The
-- source set is tiny, so snapshot it once per RPC and then keep the exact
-- active-generation fence while reading the physical media table.
create or replace function public.search_media_items(
  p_user uuid,
  p_item_type text,
  p_q text,
  p_limit integer default 24,
  p_dedup boolean default false
) returns setof public.cloud_media_items
language sql
stable
security definer
set search_path = pg_catalog, public, extensions
as $function$
  with visible_sources as materialized (
    select source.id
    from public.cloud_catalog_visible_sources source
    where source.user_id = p_user
  ),
  matched as (
    select
      item,
      coalesce(item.dedup_key, item.id::text) as dedup_group,
      (item.title ilike '%' || p_q || '%') as substring_hit,
      extensions.similarity(item.title, p_q) as match_similarity
    from public.cloud_media_items item
    join visible_sources visible_source
      on visible_source.id = item.source_id
    left join public.cloud_source_catalog_heads head
      on head.source_id = item.source_id
     and head.user_id = item.user_id
    where item.user_id = p_user
      and item.item_type = p_item_type
      and (
        item.generation_id is null
        or head.active_generation_id = item.generation_id
      )
      and (
        item.title ilike '%' || p_q || '%'
        or item.title operator(extensions.%) p_q
      )
  ),
  representatives as (
    select distinct on (dedup_group)
      item,
      max(substring_hit::integer) over (
        partition by dedup_group
      ) as group_substring_hit,
      max(match_similarity) over (
        partition by dedup_group
      ) as group_similarity
    from matched
    where p_dedup
    order by
      dedup_group,
      ((item).poster_url is not null) desc,
      (((item).metadata ->> 'providerTmdbId') is not null) desc,
      (item).rating_num desc nulls last,
      (item).external_id
  ),
  raw_matches as (
    select
      item,
      substring_hit::integer as group_substring_hit,
      match_similarity as group_similarity
    from matched
    where not p_dedup
  ),
  result_rows as (
    select * from representatives
    union all
    select * from raw_matches
  )
  select (item).*
  from result_rows
  order by
    group_substring_hit desc,
    group_similarity desc,
    (item).title
  limit greatest(1, least(p_limit, 50));
$function$;

revoke all on function public.search_media_items(
  uuid, text, text, integer, boolean
) from public, anon, authenticated, service_role;
grant execute on function public.search_media_items(
  uuid, text, text, integer, boolean
) to service_role;

create or replace function public.norva_visible_catalog_exceeds(
  p_user_id uuid,
  p_item_type text,
  p_threshold integer
) returns boolean
language sql
stable
set search_path = ''
as $function$
  with visible_sources as materialized (
    select source.id
    from public.cloud_catalog_visible_sources source
    where source.user_id = p_user_id
  )
  select exists (
    select 1
    from public.cloud_media_items media
    join visible_sources visible_source
      on visible_source.id = media.source_id
    left join public.cloud_source_catalog_heads head
      on head.source_id = media.source_id
     and head.user_id = media.user_id
    where media.user_id = p_user_id
      and (p_item_type is null or media.item_type = p_item_type)
      and (
        media.generation_id is null
        or head.active_generation_id = media.generation_id
      )
    limit 1
    offset least(greatest(coalesce(p_threshold, 0), 0), 60000)
  );
$function$;

revoke all on function public.norva_visible_catalog_exceeds(
  uuid, text, integer
) from public, anon, authenticated, service_role;
grant execute on function public.norva_visible_catalog_exceeds(
  uuid, text, integer
) to service_role;

create or replace function public.list_media_items_deduped(
  p_user uuid,
  p_item_type text default null,
  p_source uuid default null,
  p_category text default null,
  p_search text default null,
  p_year_min integer default null,
  p_year_max integer default null,
  p_min_rating numeric default null,
  p_added_after_epoch bigint default null,
  p_sort text default 'default',
  p_limit integer default 60,
  p_offset integer default 0
) returns jsonb
language plpgsql
stable
set search_path = pg_catalog, public, extensions
as $function$
declare
  v_big boolean;
  v_order text;
  v_representative_order text;
  v_result jsonb;
begin
  v_order := case p_sort
    when 'added' then 'media.added_at desc nulls last, media.external_id'
    when 'rating' then 'media.rating_num desc nulls last, media.external_id'
    when 'year' then 'media.release_year desc nulls last, media.external_id'
    when 'year-asc' then 'media.release_year asc nulls last, media.external_id'
    else 'media.title asc, media.external_id'
  end;

  v_representative_order := case p_sort
    when 'added' then 'representative.added_at desc nulls last, representative.external_id'
    when 'rating' then 'representative.rating_num desc nulls last, representative.external_id'
    when 'year' then 'representative.release_year desc nulls last, representative.external_id'
    when 'year-asc' then 'representative.release_year asc nulls last, representative.external_id'
    else 'representative.title asc, representative.external_id'
  end;

  -- Default grid: materialize the small visible-source set once, then elect the
  -- richest representative from the same visible active generations.  Hidden
  -- global primaries still cannot suppress their visible siblings.
  if p_source is null and p_category is null then
    -- Series catalogues commonly contain several provider rows per logical
    -- title.  Probing the representative subquery for each title-ordered row
    -- made the first page scan the same dedup groups repeatedly.  Elect the
    -- representative once from narrow keys, page those keys, then fetch only
    -- the selected full rows.  Movies retain the index-first path below: on a
    -- production-sized clone it reaches page one in a few milliseconds.
    if p_item_type = 'series' then
      execute format($query$
        with visible_source_ids as materialized (
          select array_agg(source.id)::uuid[] as ids
          from public.cloud_catalog_visible_sources source
          where source.user_id = $1
        ),
        eligible as materialized (
          select
            media.id,
            coalesce(media.dedup_key, media.id::text) as _dedup_group,
            media.title,
            media.external_id,
            media.added_at,
            media.rating_num,
            media.release_year,
            (media.poster_url is not null) as _has_poster,
            ((media.metadata ->> 'providerTmdbId') is not null) as _has_tmdb
          from public.cloud_media_items media
          cross join visible_source_ids
          left join public.cloud_source_catalog_heads head
            on head.source_id = media.source_id
           and head.user_id = media.user_id
          where media.user_id = $1
            and media.item_type = $2
            and media.source_id = any(visible_source_ids.ids)
            and (
              media.generation_id is null
              or head.active_generation_id = media.generation_id
            )
            and ($3::text is null or media.title ilike '%%' || $3 || '%%')
            and (
              $4::integer is null
              or (media.release_year >= $4 and media.release_year <= $5)
            )
            and ($6::numeric is null or media.rating_num >= $6)
            and ($7::bigint is null or media.added_at >= $7)
        ),
        representatives as (
          select distinct on (_dedup_group)
            id,
            title,
            external_id,
            added_at,
            rating_num,
            release_year
          from eligible
          order by
            _dedup_group,
            _has_poster desc,
            _has_tmdb desc,
            rating_num desc nulls last,
            external_id,
            id
        ),
        page_ids as (
          select
            representative.id,
            row_number() over (order by %s) as __rn
          from representatives representative
          order by %s
          limit greatest($8, 0)
          offset greatest($9, 0)
        ),
        page as (
          select media.*, page_ids.__rn
          from page_ids
          join public.cloud_media_items media using (id)
        )
        select jsonb_build_object(
          'items', coalesce(
            (
              select jsonb_agg(
                to_jsonb(page) - '__rn'
                order by page.__rn
              )
              from page
            ),
            '[]'::jsonb
          ),
          'films', (select count(*) from page),
          'total', null
        )
      $query$, v_representative_order, v_representative_order)
      into v_result
      using
        p_user,
        p_item_type,
        p_search,
        p_year_min,
        p_year_max,
        p_min_rating,
        p_added_after_epoch,
        p_limit,
        p_offset;
      return v_result;
    end if;

    execute format($query$
      with visible_sources as materialized (
        select source.id
        from public.cloud_catalog_visible_sources source
        where source.user_id = $1
      ),
      page as (
        select ordered_item.*, row_number() over () as __rn
        from (
          select media.*
          from public.cloud_media_items media
          join visible_sources visible_source
            on visible_source.id = media.source_id
          left join public.cloud_source_catalog_heads head
            on head.source_id = media.source_id
           and head.user_id = media.user_id
          where media.user_id = $1
            and ($2::text is null or media.item_type = $2)
            and (
              media.generation_id is null
              or head.active_generation_id = media.generation_id
            )
            and (
              media.dedup_key is null
              or media.id = (
                select representative.id
                from public.cloud_media_items representative
                join visible_sources representative_source
                  on representative_source.id = representative.source_id
                left join public.cloud_source_catalog_heads representative_head
                  on representative_head.source_id = representative.source_id
                 and representative_head.user_id = representative.user_id
                where representative.user_id = media.user_id
                  and representative.item_type = media.item_type
                  and representative.dedup_key = media.dedup_key
                  and (
                    representative.generation_id is null
                    or representative_head.active_generation_id = representative.generation_id
                  )
                order by
                  (representative.poster_url is not null) desc,
                  ((representative.metadata ->> 'providerTmdbId') is not null) desc,
                  representative.rating_num desc nulls last,
                  representative.external_id,
                  representative.id
                limit 1
              )
            )
            and ($3::text is null or media.title ilike '%%' || $3 || '%%')
            and (
              $4::integer is null
              or (media.release_year >= $4 and media.release_year <= $5)
            )
            and ($6::numeric is null or media.rating_num >= $6)
            and ($7::bigint is null or media.added_at >= $7)
          order by %s
          limit greatest($8, 0)
          offset greatest($9, 0)
        ) ordered_item
      )
      select jsonb_build_object(
        'items', coalesce(
          (
            select jsonb_agg(
              to_jsonb(page) - '__rn'
              order by page.__rn
            )
            from page
          ),
          '[]'::jsonb
        ),
        'films', (select count(*) from page),
        'total', null
      )
    $query$, v_order)
    into v_result
    using
      p_user,
      p_item_type,
      p_search,
      p_year_min,
      p_year_max,
      p_min_rating,
      p_added_after_epoch,
      p_limit,
      p_offset;
    return v_result;
  end if;

  v_big := public.norva_visible_catalog_exceeds(
    p_user,
    p_item_type,
    60000
  );
  if v_big then
    execute format($query$
      with visible_sources as materialized (
        select source.id
        from public.cloud_catalog_visible_sources source
        where source.user_id = $1
      ),
      page as (
        select ordered_item.*, row_number() over () as __rn
        from (
          select media.*
          from public.cloud_media_items media
          join visible_sources visible_source
            on visible_source.id = media.source_id
          left join public.cloud_source_catalog_heads head
            on head.source_id = media.source_id
           and head.user_id = media.user_id
          where media.user_id = $1
            and ($2::text is null or media.item_type = $2)
            and ($3::uuid is null or media.source_id = $3)
            and ($4::text is null or media.parent_external_id = $4)
            and (
              media.generation_id is null
              or head.active_generation_id = media.generation_id
            )
            and ($5::text is null or media.title ilike '%%' || $5 || '%%')
            and (
              $6::integer is null
              or (media.release_year >= $6 and media.release_year <= $7)
            )
            and ($8::numeric is null or media.rating_num >= $8)
            and ($9::bigint is null or media.added_at >= $9)
          order by %s
          limit greatest($10, 0)
          offset greatest($11, 0)
        ) ordered_item
      )
      select jsonb_build_object(
        'items', coalesce(
          (
            select jsonb_agg(
              to_jsonb(page) - '__rn'
              order by page.__rn
            )
            from page
          ),
          '[]'::jsonb
        ),
        'films', (select count(*) from page),
        'total', null
      )
    $query$, v_order)
    into v_result
    using
      p_user,
      p_item_type,
      p_source,
      p_category,
      p_search,
      p_year_min,
      p_year_max,
      p_min_rating,
      p_added_after_epoch,
      p_limit,
      p_offset;
    return v_result;
  end if;

  -- Normal filtered accounts retain exact cross-page deduplication.  The
  -- physical rows still flow through the same visible-source and generation
  -- predicates, but those predicates are no longer evaluated per media row.
  with visible_sources as materialized (
    select source.id
    from public.cloud_catalog_visible_sources source
    where source.user_id = p_user
  ),
  filtered as materialized (
    select
      media.*,
      coalesce(media.dedup_key, media.id::text) as _dedup_group
    from public.cloud_media_items media
    join visible_sources visible_source
      on visible_source.id = media.source_id
    left join public.cloud_source_catalog_heads head
      on head.source_id = media.source_id
     and head.user_id = media.user_id
    where media.user_id = p_user
      and (p_item_type is null or media.item_type = p_item_type)
      and (p_source is null or media.source_id = p_source)
      and (p_category is null or media.parent_external_id = p_category)
      and (
        media.generation_id is null
        or head.active_generation_id = media.generation_id
      )
      and (p_search is null or media.title ilike '%' || p_search || '%')
      and (
        p_year_min is null
        or (
          media.release_year >= p_year_min
          and media.release_year <= p_year_max
        )
      )
      and (p_min_rating is null or media.rating_num >= p_min_rating)
      and (
        p_added_after_epoch is null
        or media.added_at >= p_added_after_epoch
      )
  ),
  representatives as (
    select distinct on (_dedup_group)
      _dedup_group,
      added_at,
      rating_num,
      release_year,
      lower(title) as _title,
      external_id
    from filtered
    order by
      _dedup_group,
      (poster_url is not null) desc,
      ((metadata ->> 'providerTmdbId') is not null) desc,
      rating_num desc nulls last,
      external_id
  ),
  ordered as (
    select
      _dedup_group,
      row_number() over (
        order by
          case when p_sort = 'added' then added_at end desc nulls last,
          case when p_sort = 'rating' then rating_num end desc nulls last,
          case when p_sort = 'year' then release_year end desc nulls last,
          case when p_sort = 'year-asc' then release_year end asc nulls last,
          case
            when p_sort is null or p_sort in ('name', 'default', '')
              then _title
          end asc nulls last,
          external_id
      ) as _row_number
    from representatives
  ),
  page_films as (
    select _dedup_group, _row_number
    from ordered
    order by _row_number
    offset greatest(p_offset, 0)
    limit greatest(p_limit, 0)
  )
  select jsonb_build_object(
    'items', coalesce(
      (
        select jsonb_agg(
          to_jsonb(filtered) - '_dedup_group'
          order by page_films._row_number, filtered.external_id
        )
        from page_films
        join filtered using (_dedup_group)
      ),
      '[]'::jsonb
    ),
    'films', (select count(*) from page_films),
    'total', (select count(*) from representatives)
  )
  into v_result;

  return v_result;
end
$function$;

revoke all on function public.list_media_items_deduped(
  uuid, text, uuid, text, text, integer, integer, numeric, bigint, text,
  integer, integer
) from public, anon, authenticated, service_role;
grant execute on function public.list_media_items_deduped(
  uuid, text, uuid, text, text, integer, integer, numeric, bigint, text,
  integer, integer
) to service_role;

comment on function public.search_media_items(uuid,text,text,integer,boolean) is
  'Service-only fuzzy catalogue search; snapshots visible sources once and preserves the active-generation fence.';
comment on function public.norva_visible_catalog_exceeds(uuid,text,integer) is
  'Bounded service-only visible-row probe; snapshots visible sources once and preserves the active-generation fence.';
comment on function public.list_media_items_deduped(uuid,text,uuid,text,text,integer,integer,numeric,bigint,text,integer,integer) is
  'Service-only paginated media grid; snapshots visible sources once while preserving active-generation visibility and visible-sibling deduplication.';

notify pgrst, 'reload schema';
commit;
