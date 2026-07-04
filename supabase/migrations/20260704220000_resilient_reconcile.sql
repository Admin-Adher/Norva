-- Make the catalog reconcile cron durable under real contention.
--
-- Symptoms observed on the global drain (job 85, every 3 min):
--   * deadlock in canonicalize on cloud_titles_user_id_item_type_identity_key_key —
--     the reconcile ran on the SAME minute as the search-match cron (job 12), which
--     inserts titles into that very unique index. Two writers, one index → deadlock.
--   * statement_timeout (120s) on the 10k media backfill — the per-row
--     cmi_set_sort_cols trigger makes each UPDATE ~7-10 ms/row, and overlapping runs
--     inflated it past the timeout. A timeout on the un-batched canonicalize meant the
--     whole run rolled back → zero progress on 5k+ dup groups.
--
-- Fixes here (no schema change — functions only):
--   1. canonicalize becomes BATCHED (p_limit dup groups/run) and each group merge runs
--      in its own savepoint: a transient deadlock/contention with search-match skips
--      that one group and the run keeps going (idempotent — next tick retries it).
--   2. reconcile takes a session advisory lock so two runs never overlap (killing the
--      lock-wait inflation), and wraps each heavy step so one failure can't lose the
--      others. Smaller default batch (5000) keeps every run well under statement_timeout.

-- The 1-arg canonicalize would become ambiguous once we add the 2nd (defaulted) arg.
drop function if exists norva_canonicalize_titles_for_user(uuid);

create or replace function norva_canonicalize_titles_for_user(p_user_id uuid, p_limit int default null)
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
    limit p_limit                         -- NULL = unbounded (whole-catalogue pass)
  loop
    begin  -- savepoint per group: a deadlock with search-match skips only this group
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
      update cloud_titles c set
        identity_key    = v_key,
        identity_source = 'provider_tmdb',
        variant_count   = (select count(*) from cloud_title_variants where title_id = v_canonical),
        updated_at      = now()
      where c.id = v_canonical;

      v_merged := v_merged + (array_length(g.ids, 1) - 1);
    exception when others then
      -- transient contention (deadlock/serialization) with search-match on the
      -- identity_key unique index; leave this group for the next tick.
      null;
    end;
  end loop;

  return v_merged;
end $$;

-- Reconcile: self-serializing + per-step resilient. Default batch 5000 keeps a run
-- (canonicalize 300 groups + poster refresh + media backfill) comfortably under the
-- 120s statement_timeout even under contention.
create or replace function norva_reconcile_catalog(p_user_id uuid, p_limit int default 5000)
returns jsonb
language plpgsql
as $$
declare
  v_merged   integer := 0;
  v_posters  integer := 0;
  v_touched  integer := 0;
begin
  -- One reconcile at a time. Overlapping runs contend on the same cloud_media_items
  -- tuples and push each UPDATE past statement_timeout. pg_cron gives each run its own
  -- backend, so this session lock auto-releases on run end (even on error); a run that
  -- can't get the lock just skips this tick — no pile-up.
  if not pg_try_advisory_lock(4200042) then
    return jsonb_build_object('skipped', 'locked');
  end if;

  -- Canonicalize a bounded slice of dup groups (self-heals per group via savepoints).
  begin
    v_merged := norva_canonicalize_titles_for_user(p_user_id, 300);
  exception when others then
    v_merged := -1;                       -- sentinel: canonicalize skipped this tick
  end;

  -- Poster refresh (update-by-id on cloud_titles → low deadlock risk; converges to 0).
  begin
    v_posters := norva_refresh_posters_from_catalog(p_user_id, p_limit);
  exception when others then
    v_posters := -1;
  end;

  -- The priority: drain cloud_media_items.dedup_key (touches cloud_media_items only,
  -- so it never deadlocks with search-match; the advisory lock stops self-overlap).
  begin
    v_touched := norva_backfill_media_identity(p_user_id, p_limit);
  exception when others then
    v_touched := -1;
  end;

  perform pg_advisory_unlock(4200042);
  return jsonb_build_object(
    'titles_merged', v_merged,
    'posters_refreshed', v_posters,
    'media_rows_reconciled', v_touched
  );
end $$;
