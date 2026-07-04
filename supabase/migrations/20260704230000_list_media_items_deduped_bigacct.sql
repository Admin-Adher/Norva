-- Fix: Movies/Series grid times out for mega-accounts (350k+ items).
--
-- list_media_items_deduped materialises the WHOLE account's items, sorts them for a
-- `distinct on (dedup_key)`, and counts the distinct set twice. For a ~383k-item
-- account that is a 19s external-merge disk sort (measured) — well past the statement
-- timeout — and it removes almost nothing, because dedup_key is only backfilled on a
-- fraction of rows (each NULL dedup_key row is its own film). The cross-page dedup is
-- simply not worth a full-account sort at that scale.
--
-- So: keep the exact cross-page dedup for normal accounts, but for large accounts serve
-- an index-driven page instead (the pre-dedup behaviour: ~324ms via idx_cmi_sort_*). The
-- client still groups duplicates within the pages it has loaded, so the grid degrades
-- gracefully rather than failing to load. `total` becomes the raw filtered count (a
-- ~1% over-count from the un-collapsed duplicates, acceptable for the result tally).

create or replace function list_media_items_deduped(
  p_user uuid,
  p_item_type text default null,
  p_source uuid default null,
  p_category text default null,
  p_search text default null,
  p_year_min int default null,
  p_year_max int default null,
  p_min_rating numeric default null,
  p_added_after_epoch bigint default null,
  p_sort text default 'default',
  p_limit int default 60,
  p_offset int default 0
) returns jsonb
language plpgsql
stable
as $$
declare
  v_big boolean;
  v_order text;
  v_result jsonb;
begin
  -- Cheap (index-only) size probe for this type — decides the strategy.
  select count(*) > 60000 into v_big
  from cloud_media_items
  where user_id = p_user
    and (p_item_type is null or item_type = p_item_type);

  if v_big then
    -- Large account: index-driven page (no full-account sort). Order maps to the
    -- matching (user_id, item_type, <col>) index so the page is a bounded index scan.
    v_order := case p_sort
      when 'added'    then 'added_at desc nulls last, external_id'
      when 'rating'   then 'rating_num desc nulls last, external_id'
      when 'year'     then 'release_year desc nulls last, external_id'
      when 'year-asc' then 'release_year asc nulls last, external_id'
      else 'title asc, external_id'
    end;
    execute format($q$
      with page as (
        select p.*, row_number() over () as __rn
        from (
          select mi.*
          from cloud_media_items mi
          where mi.user_id = $1
            and ($2::text is null or mi.item_type = $2)
            and ($3::uuid is null or mi.source_id = $3)
            and ($4::text is null or mi.parent_external_id = $4)
            and ($5::text is null or mi.title ilike '%%' || $5 || '%%')
            and ($6::int  is null or (mi.release_year >= $6 and mi.release_year <= $7))
            and ($8::numeric is null or mi.rating_num >= $8)
            and ($9::bigint is null or mi.added_at >= $9)
          order by %s
          limit greatest($10, 0) offset greatest($11, 0)
        ) p
      )
      select jsonb_build_object(
        'items', coalesce((select jsonb_agg((to_jsonb(page) - '__rn') order by __rn) from page), '[]'::jsonb),
        'films', (select count(*) from page),
        'total', (select count(*) from cloud_media_items mi
                  where mi.user_id = $1
                    and ($2::text is null or mi.item_type = $2)
                    and ($3::uuid is null or mi.source_id = $3)
                    and ($4::text is null or mi.parent_external_id = $4)
                    and ($5::text is null or mi.title ilike '%%' || $5 || '%%')
                    and ($6::int  is null or (mi.release_year >= $6 and mi.release_year <= $7))
                    and ($8::numeric is null or mi.rating_num >= $8)
                    and ($9::bigint is null or mi.added_at >= $9))
      )
    $q$, v_order)
    into v_result
    using p_user, p_item_type, p_source, p_category, p_search,
          p_year_min, p_year_max, p_min_rating, p_added_after_epoch, p_limit, p_offset;
    return v_result;
  end if;

  -- Normal account: exact cross-page dedup (the original behaviour).
  with filtered as (
    select mi.*, coalesce(mi.dedup_key, mi.id::text) as _dk
    from cloud_media_items mi
    where mi.user_id = p_user
      and (p_item_type is null or mi.item_type = p_item_type)
      and (p_source   is null or mi.source_id = p_source)
      and (p_category is null or mi.parent_external_id = p_category)
      and (p_search   is null or mi.title ilike '%' || p_search || '%')
      and (p_year_min is null or (mi.release_year >= p_year_min and mi.release_year <= p_year_max))
      and (p_min_rating is null or mi.rating_num >= p_min_rating)
      and (p_added_after_epoch is null or mi.added_at >= p_added_after_epoch)
  ),
  reps as (
    select distinct on (_dk)
      _dk, added_at, rating_num, release_year, lower(title) as _title, external_id
    from filtered
    order by _dk,
      (poster_url is not null) desc,
      ((metadata->>'providerTmdbId') is not null) desc,
      rating_num desc nulls last,
      external_id
  ),
  ordered as (
    select _dk,
      row_number() over (order by
        case when p_sort = 'added'    then added_at     end desc nulls last,
        case when p_sort = 'rating'   then rating_num   end desc nulls last,
        case when p_sort = 'year'     then release_year end desc nulls last,
        case when p_sort = 'year-asc' then release_year end asc  nulls last,
        case when (p_sort is null or p_sort in ('name','default','')) then _title end asc nulls last,
        external_id
      ) as _rn
    from reps
  ),
  page_films as (
    select _dk, _rn from ordered order by _rn offset greatest(p_offset, 0) limit greatest(p_limit, 0)
  )
  select jsonb_build_object(
    'items', coalesce((
      select jsonb_agg((to_jsonb(f) - '_dk') order by pf._rn, f.external_id)
      from page_films pf
      join filtered f on f._dk = pf._dk
    ), '[]'::jsonb),
    'films', (select count(*) from page_films),
    'total', (select count(*) from reps)
  ) into v_result;
  return v_result;
end $$;
