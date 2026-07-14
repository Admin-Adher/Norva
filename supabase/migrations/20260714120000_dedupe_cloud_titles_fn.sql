-- =============================================================================
-- dedupe_cloud_titles_by_tmdb() — make the June 2026 one-shot dedupe reusable.
-- =============================================================================
-- The one-time hygiene migration 20260623220000 collapsed duplicate cloud_titles
-- onto a single canonical row per (user, item_type, provider_tmdb_id). But it ran
-- ONCE. Since then, norva-source-sync's cronSearchMatch keeps stamping a
-- provider_tmdb_id on formerly-unmatched rows (match_status unmatched -> the row
-- gets a tmdb id) WITHOUT re-keying identity_key — so a localized copy that finally
-- matched ("Lilo i Stitch" / "Lilo y Stitch", TMDB 552524) still carries its
-- norm:<slug> key and never collapses onto the canonical tmdb:552524 row. Result:
-- the same film shows as several title cards / fragments the "24 versions" count,
-- and search/rails (which group by identity_key server-side) list it twice.
--
-- This wraps the SAME proven merge logic in a function that can run periodically
-- and be scoped to one user (p_user), plus a final "lone row promote" step the
-- one-shot migration lacked: a provider_verified row whose tmdb id is UNIQUE for
-- its (user, item_type) — so it has no sibling to merge with — but is still keyed
-- norm:/imdb: is re-keyed to tmdb:<id>, so the NEXT localized variant that matches
-- collapses onto it instead of forking. Idempotent: on a clean catalog it is a
-- no-op. Mirrors 20260623220000 line-for-line for the merge; keep them in sync.
--
-- Service-role only: it can rewrite ANY user's titles when p_user is null, so it is
-- SECURITY DEFINER with EXECUTE revoked from public and granted only to the roles
-- the edge runtime uses.

create or replace function public.dedupe_cloud_titles_by_tmdb(p_user uuid default null)
returns table(merged_titles integer, promoted_titles integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_merged   integer := 0;
  v_promoted integer := 0;
begin
  -- Re-entrant within a single transaction (the migration's own SELECT, tests, …).
  drop table if exists _dct_grp;
  drop table if exists _dct_map;

  -- Every row carrying the SAME non-sentinel provider_tmdb_id, ranked so the best
  -- row (already tmdb-keyed > provider_verified > has year > has poster > lowest id)
  -- becomes the canonical (rn = 1). Optionally scoped to one user.
  create temp table _dct_grp on commit drop as
  select id, user_id, item_type, provider_tmdb_id, identity_key, match_status,
         release_year, poster_url, backdrop_url,
    row_number() over (partition by user_id, item_type, provider_tmdb_id
      order by (identity_key = 'tmdb:' || provider_tmdb_id) desc,
               (match_status = 'provider_verified') desc,
               (release_year is not null) desc,
               (poster_url is not null) desc,
               id asc) as rn,
    count(*) over (partition by user_id, item_type, provider_tmdb_id) as grp_size
  from cloud_titles
  where provider_tmdb_id is not null and provider_tmdb_id not in ('0', '')
    and (p_user is null or user_id = p_user);

  create temp table _dct_map on commit drop as
  select d.id as dup_id, c.id as canon_id
  from _dct_grp d
  join _dct_grp c using (user_id, item_type, provider_tmdb_id)
  where d.grp_size > 1 and d.rn > 1 and c.rn = 1;

  -- Fill canonical gaps from the best value across the group before dropping dups.
  update cloud_titles t set
    release_year = coalesce(t.release_year, g.best_year),
    poster_url   = coalesce(t.poster_url, g.best_poster),
    backdrop_url = coalesce(t.backdrop_url, g.best_backdrop)
  from (
    select user_id, item_type, provider_tmdb_id,
      max(release_year) as best_year,
      (array_agg(poster_url)   filter (where poster_url   is not null))[1] as best_poster,
      (array_agg(backdrop_url) filter (where backdrop_url is not null))[1] as best_backdrop
    from _dct_grp where grp_size > 1
    group by user_id, item_type, provider_tmdb_id
  ) g
  where t.user_id = g.user_id and t.item_type = g.item_type and t.provider_tmdb_id = g.provider_tmdb_id
    and t.id in (select canon_id from _dct_map);

  -- Promote each canonical to the tmdb:<id> identity (unique-key safe: any row that
  -- already held tmdb:<id> would have been chosen as the canonical, so this only
  -- runs when the slot is free).
  update cloud_titles t set identity_key = 'tmdb:' || t.provider_tmdb_id, identity_source = 'provider_tmdb'
  where t.id in (select distinct canon_id from _dct_map) and t.identity_key <> 'tmdb:' || t.provider_tmdb_id;

  -- Re-point variants (title_id FK is ON DELETE CASCADE, so move BEFORE deleting),
  -- then drop the now-empty duplicate titles. The AFTER trigger on
  -- cloud_title_variants recomputes both rollups as rows move; the explicit recompute
  -- below is belt-and-suspenders.
  update cloud_title_variants v set title_id = m.canon_id from _dct_map m where v.title_id = m.dup_id;
  delete from cloud_titles where id in (select dup_id from _dct_map);
  get diagnostics v_merged = row_count;

  update cloud_titles t set
    variant_count = vc.cnt,
    default_variant_id = coalesce(t.default_variant_id, vc.any_variant)
  from (
    select title_id, count(*) as cnt, (array_agg(id order by id))[1] as any_variant
    from cloud_title_variants group by title_id
  ) vc
  where vc.title_id = t.id and t.id in (select distinct canon_id from _dct_map);

  -- LONE ROW PROMOTE — a matched row whose tmdb id is unique for its (user, type)
  -- (grp_size = 1, so never in _dct_map) but still keyed norm:/imdb:. Re-key it so the
  -- next localized variant that matches this tmdb collapses onto it. The NOT EXISTS
  -- guard keeps it bullet-proof against any stray pre-existing tmdb:<id> row.
  update cloud_titles t
     set identity_key = 'tmdb:' || t.provider_tmdb_id, identity_source = 'provider_tmdb'
  from _dct_grp g
  where g.id = t.id
    and g.grp_size = 1
    and t.provider_tmdb_id is not null and t.provider_tmdb_id not in ('0', '')
    and t.identity_key <> 'tmdb:' || t.provider_tmdb_id
    and t.match_status in ('provider_verified', 'matched', 'manual')
    and not exists (
      select 1 from cloud_titles x
      where x.user_id = t.user_id and x.item_type = t.item_type
        and x.identity_key = 'tmdb:' || t.provider_tmdb_id and x.id <> t.id
    );
  get diagnostics v_promoted = row_count;

  merged_titles   := coalesce(v_merged, 0);
  promoted_titles := coalesce(v_promoted, 0);
  return next;
end;
$$;

revoke all on function public.dedupe_cloud_titles_by_tmdb(uuid) from public;
grant execute on function public.dedupe_cloud_titles_by_tmdb(uuid) to service_role;

-- One-time global repair: collapse everything that fragmented since 2026-06-23.
select public.dedupe_cloud_titles_by_tmdb();

-- Make the new function visible to PostgREST immediately, so norva-source-sync's
-- db.rpc('dedupe_cloud_titles_by_tmdb', …) resolves without a rest-container restart.
notify pgrst, 'reload schema';
