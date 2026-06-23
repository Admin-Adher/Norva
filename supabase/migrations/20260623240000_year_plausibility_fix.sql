-- Plausibility cap on parsed release years + fix the "0" TMDB-sentinel join.
--
-- Two bugs combined to show impossible future years on the grid:
--  1. A number in a title ("Demon Lord 2099", "Börü 2039") was parsed as the
--     release year — a trailing 4-digit number is often part of the title.
--  2. The year propagation/backfill joined cloud_titles on provider_tmdb_id,
--     which for the "0" no-match sentinel matched every other "0" title and
--     cross-contaminated years (e.g. "Demon Lord 2099" inherited "Dallas" 1978).
--
-- Fix: reject implausible parsed years (< 1900 or > current_year + 1) at every
-- layer, and exclude the "0"/"" sentinel from the TMDB join. TMDB stays
-- authoritative; title-parse is only a capped last resort.

create or replace function public.cmi_set_sort_cols() returns trigger language plpgsql as $$
declare max_year int := extract(year from now())::int + 1;
begin
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

create or replace function public.propagate_media_item_years(p_user uuid, p_source uuid)
returns void language sql as $$
  update cloud_media_items m set release_year = t.release_year
  from cloud_titles t
  where m.user_id = p_user and m.source_id = p_source and m.item_type in ('movie','series')
    and t.user_id = m.user_id and t.item_type = m.item_type
    and t.provider_tmdb_id = m.metadata->>'providerTmdbId'
    and t.provider_tmdb_id not in ('0','')
    and t.release_year is not null
    and m.release_year is distinct from t.release_year;
$$;

-- Repair existing data.
update cloud_titles set release_year = null
where release_year is not null and (release_year < 1900 or release_year > extract(year from now())::int + 1);

update cloud_media_items m set release_year = sub.year
from (
  select m2.id,
    coalesce(
      t.release_year,
      case when p.py between 1900 and (extract(year from now())::int + 1) then p.py end,
      case when p.ty between 1900 and (extract(year from now())::int + 1) then p.ty end
    ) as year
  from cloud_media_items m2
  left join lateral (
    select (regexp_match(m2.title, '[(\[]\s*((?:19|20)\d{2})\s*[)\]]'))[1]::int as py,
           (regexp_match(m2.title, '(?:^|\s)((?:19|20)\d{2})\s*$'))[1]::int as ty
  ) p on true
  left join cloud_titles t on t.user_id = m2.user_id and t.item_type = m2.item_type
    and t.provider_tmdb_id = m2.metadata->>'providerTmdbId'
    and t.provider_tmdb_id not in ('0','')
    and t.release_year is not null
  where m2.item_type in ('movie','series')
) sub
where m.id = sub.id and m.item_type in ('movie','series') and m.release_year is distinct from sub.year;
