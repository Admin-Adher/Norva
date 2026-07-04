-- Canonicalize cloud_titles identity so there is exactly ONE title row per film.
--
-- Root cause of the Movies/Series duplicates: a film can end up as >1 cloud_titles
-- row sharing the same provider_tmdb_id but under different identity_keys — one keyed
-- `tmdb:<id>` (the provider handed us the id) and one keyed `norm:<normalized title>`
-- (search-match resolved the id later but never re-keyed the identity). Both surface
-- as separate cards, and the flat grid can't group them.
--
-- This function merges every such group into a single canonical `tmdb:<id>` row:
--   1. repoint that group's cloud_title_variants to the canonical title,
--   2. backfill any field the canonical is missing from its siblings,
--   3. delete the redundant rows,
--   4. re-key the canonical to `tmdb:<id>` and recount its variants.
-- The only FK into cloud_titles is cloud_title_variants.title_id (repointed in step 1),
-- so no other table is orphaned. Pass NULL to process every user.

create or replace function norva_canonicalize_titles_for_user(p_user_id uuid)
returns integer
language plpgsql
as $$
declare
  g record;
  v_canonical uuid;
  v_key text;
  v_merged int := 0;
begin
  for g in
    select user_id, item_type, provider_tmdb_id, array_agg(id) as ids
    from cloud_titles
    where provider_tmdb_id is not null
      and (p_user_id is null or user_id = p_user_id)
    group by user_id, item_type, provider_tmdb_id
    having count(*) > 1
  loop
    -- Canonical = the richest row: prefer an already-tmdb identity, then poster,
    -- then a real year, then a verified match, then the oldest (stable) row.
    select id into v_canonical
    from cloud_titles
    where id = any(g.ids)
    order by
      (identity_source = 'provider_tmdb') desc,
      (poster_url is not null) desc,
      (release_year is not null) desc,
      (match_status = 'provider_verified') desc,
      (metadata is not null) desc,
      created_at asc
    limit 1;

    v_key := 'tmdb:' || g.provider_tmdb_id;

    -- 1. Move every sibling's variants onto the canonical title.
    update cloud_title_variants
      set title_id = v_canonical, updated_at = now()
      where title_id = any(g.ids) and title_id <> v_canonical;

    -- 2. Fill any gap on the canonical from its siblings (best available wins).
    --    Audio/subtitle probe columns are intentionally NOT merged here — they are
    --    array/jsonb probe results that the audio/subtitle crons re-derive, and
    --    aggregating text[] columns is both awkward and unnecessary for the dedup.
    update cloud_titles c set
      poster_url      = coalesce(c.poster_url,      agg.poster_url),
      backdrop_url    = coalesce(c.backdrop_url,    agg.backdrop_url),
      release_year    = coalesce(c.release_year,    agg.release_year),
      rating_num      = coalesce(c.rating_num,      agg.rating_num),
      original_title  = coalesce(c.original_title,  agg.original_title),
      genre_category  = coalesce(c.genre_category,  agg.genre_category),
      genre_payload   = coalesce(c.genre_payload,   agg.genre_payload),
      metadata        = coalesce(c.metadata,        agg.metadata),
      match_status    = case when agg.has_verified then 'provider_verified' else c.match_status end,
      updated_at      = now()
    from (
      select
        max(poster_url)     filter (where poster_url   is not null) as poster_url,
        max(backdrop_url)   filter (where backdrop_url is not null) as backdrop_url,
        max(release_year)                                            as release_year,
        max(rating_num)                                              as rating_num,
        max(original_title) filter (where original_title is not null) as original_title,
        max(genre_category) filter (where genre_category is not null) as genre_category,
        (array_agg(genre_payload) filter (where genre_payload is not null))[1]     as genre_payload,
        (array_agg(metadata)      filter (where metadata is not null))[1]          as metadata,
        bool_or(match_status = 'provider_verified')                                as has_verified
      from cloud_titles where id = any(g.ids) and id <> v_canonical
    ) agg
    where c.id = v_canonical;

    -- 3. Drop the redundant rows (variants already repointed).
    delete from cloud_titles where id = any(g.ids) and id <> v_canonical;

    -- 4. Re-key the survivor to the canonical tmdb identity + recount variants.
    --    Done after the delete so the (user_id, identity_key) uniqueness never clashes.
    update cloud_titles c set
      identity_key    = v_key,
      identity_source = 'provider_tmdb',
      variant_count   = (select count(*) from cloud_title_variants where title_id = v_canonical),
      updated_at      = now()
    where c.id = v_canonical;

    v_merged := v_merged + (array_length(g.ids, 1) - 1);
  end loop;

  return v_merged;
end $$;
