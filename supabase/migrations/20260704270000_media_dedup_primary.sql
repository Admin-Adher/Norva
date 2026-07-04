-- Precomputed cross-page dedup for the flat Movies/Series grid — the "proper fix" for
-- mid-size accounts (~20-60k items) whose exact-dedup grid read the WHOLE account per load
-- (jeremy 53k: ~31s under an import). Instead of deduping at read time, we mark ONE
-- representative row per (user, item_type, dedup_key) group as is_dedup_primary; the grid
-- then filters is_dedup_primary and becomes a bounded index scan at ANY size, with exact
-- dedup preserved (see 20260704271000 for the grid rewrite).
--
-- Rollout safety: the column defaults TRUE, so before/without a backfill the grid shows
-- every row (no dedup) — never hides content — degrading to the pre-existing big-account
-- behaviour. Correctness "turns on" as norva_recompute_dedup_primary runs.

alter table public.cloud_media_items
  add column if not exists is_dedup_primary boolean not null default true;

-- The sort-column trigger ran regexp + jsonb parsing on EVERY row update (~7-10ms/row).
-- Early-exit when none of its derived-source columns changed, so is_dedup_primary /
-- dedup_key / poster_url-only updates (this feature + the reconcile drain) are cheap.
-- Only the function body changes (no table lock), and the derived columns
-- (added_at, rating_num from metadata; release_year from title) are fully covered.
create or replace function public.cmi_set_sort_cols() returns trigger language plpgsql as $$
declare max_year int := extract(year from now())::int + 1;
begin
  if TG_OP = 'UPDATE'
     and NEW.metadata is not distinct from OLD.metadata
     and NEW.title is not distinct from OLD.title
     and NEW.release_year is not distinct from OLD.release_year then
    return NEW;
  end if;
  NEW.added_at := public.safe_bigint(NEW.metadata->>'added');
  NEW.rating_num := public.safe_numeric(NEW.metadata->>'rating');
  if NEW.release_year is null then
    NEW.release_year := coalesce(
      (regexp_match(coalesce(NEW.title,''), '[(\[]\s*((?:19|20)\d{2})\s*[)\]]'))[1]::int,
      (regexp_match(coalesce(NEW.title,''), '(?:^|\s)((?:19|20)\d{2})\s*$'))[1]::int
    );
    if NEW.release_year is not null and (NEW.release_year < 1900 or NEW.release_year > max_year) then
      NEW.release_year := null;
    end if;
  end if;
  return NEW;
end $$;

-- Recompute is_dedup_primary for groups whose primary assignment is wrong (0 or >1
-- primaries among the non-null dedup_key members). Representative = the richest row
-- (poster, then resolved tmdb, then rating, then external_id) — same tiebreaker the old
-- read-time dedup used. Idempotent + bounded (p_limit groups/call): repeated calls
-- converge and it is a no-op once every group has exactly one primary. NULL-dedup_key rows
-- are each their own film and stay primary (default true).
create or replace function public.norva_recompute_dedup_primary(p_user uuid default null, p_limit int default 20000)
returns integer
language plpgsql
set search_path to 'public'
as $$
declare v_fixed integer;
begin
  with bad as (
    select user_id, item_type, dedup_key
    from cloud_media_items
    where dedup_key is not null and (p_user is null or user_id = p_user)
    group by user_id, item_type, dedup_key
    having count(*) filter (where is_dedup_primary) <> 1
    limit p_limit
  ),
  members as (
    select mi.id,
      (row_number() over (
        partition by mi.user_id, mi.item_type, mi.dedup_key
        order by (mi.poster_url is not null) desc,
                 ((mi.metadata->>'providerTmdbId') is not null) desc,
                 mi.rating_num desc nulls last,
                 mi.external_id
      ) = 1) as should_be_primary
    from cloud_media_items mi
    join bad b on b.user_id = mi.user_id and b.item_type = mi.item_type and b.dedup_key = mi.dedup_key
    where mi.dedup_key is not null
  ),
  fixed as (
    update cloud_media_items mi
      set is_dedup_primary = m.should_be_primary
    from members m
    where mi.id = m.id and mi.is_dedup_primary is distinct from m.should_be_primary
    returning 1
  )
  select count(*) into v_fixed from fixed;
  return coalesce(v_fixed, 0);
end $$;

-- Ongoing maintenance: the reconcile drain already sets dedup_key on a bounded batch here.
-- After it does, recompute is_dedup_primary for exactly the groups it touched (the keys
-- rows moved TO and FROM), in a second statement so it sees the new dedup_key. Bounded by
-- the batch; a newly imported duplicate (default primary=true) is corrected on the next
-- reconcile tick that keys it. NULL limit = unbounded (small/scoped accounts).
create or replace function norva_backfill_media_identity(p_user_id uuid, p_limit int default null)
returns integer
language plpgsql
as $$
declare
  v_touched integer;
begin
  drop table if exists _dp_upd;
  create temp table _dp_upd on commit drop as
  with cand as (
    select mi.id, mi.dedup_key as old_key, ct.identity_key as new_key, ct.provider_tmdb_id, ct.poster_url
    from cloud_media_items mi
    join cloud_title_variants v on v.media_item_id = mi.id
    join cloud_titles ct on ct.id = v.title_id
    where (p_user_id is null or mi.user_id = p_user_id)
      and (
        mi.dedup_key is distinct from ct.identity_key
        or (ct.provider_tmdb_id is not null and (mi.metadata->>'providerTmdbId') is null)
        or (ct.provider_tmdb_id is not null and ct.poster_url is not null and mi.poster_url is distinct from ct.poster_url)
      )
    limit p_limit
  ),
  upd as (
    update cloud_media_items mi set
      dedup_key = c.new_key,
      metadata = case
        when c.provider_tmdb_id is not null and (mi.metadata->>'providerTmdbId') is null
          then jsonb_set(coalesce(mi.metadata, '{}'::jsonb), '{providerTmdbId}', to_jsonb(c.provider_tmdb_id))
        else mi.metadata
      end,
      poster_url = case
        when c.provider_tmdb_id is not null and c.poster_url is not null then c.poster_url
        else mi.poster_url
      end
    from cand c
    where mi.id = c.id
    returning mi.user_id, mi.item_type, c.new_key, c.old_key
  )
  select user_id, item_type, new_key, old_key from upd;

  select count(*) into v_touched from _dp_upd;

  with affected as (
    select distinct user_id, item_type, new_key as dk from _dp_upd where new_key is not null
    union
    select distinct user_id, item_type, old_key as dk from _dp_upd where old_key is not null
  ),
  members as (
    select mi.id,
      (row_number() over (
        partition by mi.user_id, mi.item_type, mi.dedup_key
        order by (mi.poster_url is not null) desc,
                 ((mi.metadata->>'providerTmdbId') is not null) desc,
                 mi.rating_num desc nulls last,
                 mi.external_id
      ) = 1) as should_be_primary
    from cloud_media_items mi
    join affected a on a.user_id = mi.user_id and a.item_type = mi.item_type and a.dk = mi.dedup_key
    where mi.dedup_key is not null
  )
  update cloud_media_items mi
    set is_dedup_primary = m.should_be_primary
  from members m
  where mi.id = m.id and mi.is_dedup_primary is distinct from m.should_be_primary;

  drop table if exists _dp_upd;
  return v_touched;
end $$;

-- Backfill of existing rows is NOT run inline here: on a large live DB the bad-group probe
-- is a whole-table group-by (risking a deploy statement-timeout), and the column default
-- (true) keeps the grid correct-but-undeduped until convergence. The live catalogue was
-- backfilled per-account via norva_recompute_dedup_primary() ahead of the grid cutover; a
-- fresh/large deploy converges through the reconcile drain (norva_backfill_media_identity
-- recomputes each touched group) or an operator running norva_recompute_dedup_primary(null)
-- in a maintenance window until it returns 0.
