-- One-time hygiene: collapse duplicate cloud_titles onto a single canonical row
-- per (user, item_type, provider_tmdb_id).
--
-- Cause: identity_key used the *validation-gated* tmdb id, so a film's localized
-- and quality variants ("Le Roi lion" / "El rey leon" / "the dark knight rises
-- p 2") whose en-US title-confidence check didn't pass fell back to a norm: title
-- instead of collapsing onto tmdb:<id> — even though provider_tmdb_id was stored
-- on every row. The projection now binds identity to the provider id directly
-- (vod-title-projection.ts: cleanId rejects the "0" sentinel; identity uses
-- providerIds), so future syncs stay canonical. This migration repairs existing
-- rows. Idempotent: once deduped there are no >1 groups, so it is a no-op.
--
-- Safe ordering: re-point variants BEFORE deleting dup titles
-- (cloud_title_variants.title_id → cloud_titles.id is ON DELETE CASCADE).

create temp table _grp on commit drop as
select id, user_id, item_type, provider_tmdb_id, identity_key, match_status, release_year, poster_url, backdrop_url,
  row_number() over (partition by user_id, item_type, provider_tmdb_id
    order by (identity_key = 'tmdb:' || provider_tmdb_id) desc,
             (match_status = 'provider_verified') desc,
             (release_year is not null) desc,
             (poster_url is not null) desc,
             id asc) as rn,
  count(*) over (partition by user_id, item_type, provider_tmdb_id) as grp_size
from cloud_titles
where provider_tmdb_id is not null and provider_tmdb_id not in ('0', '');

create temp table _map on commit drop as
select d.id as dup_id, c.id as canon_id
from _grp d
join _grp c using (user_id, item_type, provider_tmdb_id)
where d.grp_size > 1 and d.rn > 1 and c.rn = 1;

-- Fill canonical gaps from the best value across the group.
update cloud_titles t set
  release_year = coalesce(t.release_year, g.best_year),
  poster_url   = coalesce(t.poster_url, g.best_poster),
  backdrop_url = coalesce(t.backdrop_url, g.best_backdrop)
from (
  select user_id, item_type, provider_tmdb_id,
    max(release_year) as best_year,
    (array_agg(poster_url) filter (where poster_url is not null))[1] as best_poster,
    (array_agg(backdrop_url) filter (where backdrop_url is not null))[1] as best_backdrop
  from _grp where grp_size > 1
  group by user_id, item_type, provider_tmdb_id
) g
where t.user_id = g.user_id and t.item_type = g.item_type and t.provider_tmdb_id = g.provider_tmdb_id
  and t.id in (select canon_id from _map);

-- Promote a canonical that wasn't already the tmdb:<id> identity.
update cloud_titles t set identity_key = 'tmdb:' || t.provider_tmdb_id, identity_source = 'provider_tmdb'
where t.id in (select distinct canon_id from _map) and t.identity_key <> 'tmdb:' || t.provider_tmdb_id;

-- Re-point variants, then drop the now-empty duplicate titles.
update cloud_title_variants v set title_id = m.canon_id from _map m where v.title_id = m.dup_id;
delete from cloud_titles where id in (select dup_id from _map);

-- Recompute variant_count / default_variant_id on the survivors.
update cloud_titles t set
  variant_count = vc.cnt,
  default_variant_id = coalesce(t.default_variant_id, vc.any_variant)
from (
  select title_id, count(*) as cnt, (array_agg(id order by id))[1] as any_variant
  from cloud_title_variants group by title_id
) vc
where vc.title_id = t.id and t.id in (select distinct canon_id from _map);
