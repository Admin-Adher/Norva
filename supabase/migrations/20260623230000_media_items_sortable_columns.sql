-- Server-side sort support for the browse grid.
--
-- The grid paginates cloud_media_items, but its sortable fields lived only in the
-- metadata JSONB (added, rating) or in another table (year, in cloud_titles), so
-- the server could only ORDER BY title and the client sorted just the loaded
-- window — "Newest" never spanned the whole catalogue. These columns make the
-- sort fields first-class + indexed so listMediaItems can ORDER BY + paginate
-- them globally.
--
-- Self-maintaining: a BEFORE INSERT/UPDATE trigger refreshes added_at/rating from
-- metadata and parses a year from the title on every write (cloud_media_items is
-- wiped + re-inserted each sync); refreshVodTitleProjection then fills the
-- remaining release_year from the TMDB-matched cloud_titles row.

create or replace function public.safe_bigint(t text) returns bigint language sql immutable as $$
  select case when t ~ '^\s*-?\d+\s*$' then trim(t)::bigint else null end $$;

create or replace function public.safe_numeric(t text) returns numeric language sql immutable as $$
  select case when t ~ '^\s*-?\d+(\.\d+)?\s*$' then trim(t)::numeric else null end $$;

alter table public.cloud_media_items
  add column if not exists added_at bigint,
  add column if not exists rating_num numeric,
  add column if not exists release_year int;

create or replace function public.cmi_set_sort_cols() returns trigger language plpgsql as $$
begin
  NEW.added_at := public.safe_bigint(NEW.metadata->>'added');
  NEW.rating_num := public.safe_numeric(NEW.metadata->>'rating');
  -- Title-parse year on write; the cloud_titles-resolved year is filled
  -- afterwards by refreshVodTitleProjection (explicit, non-null, so it sticks).
  if NEW.release_year is null then
    NEW.release_year := coalesce(
      (regexp_match(coalesce(NEW.title,''), '[(\[]\s*((?:19|20)\d{2})\s*[)\]]'))[1]::int,
      (regexp_match(coalesce(NEW.title,''), '(?:^|\s)((?:19|20)\d{2})\s*$'))[1]::int
    );
  end if;
  return NEW;
end $$;

drop trigger if exists trg_cmi_sort_cols on public.cloud_media_items;
create trigger trg_cmi_sort_cols before insert or update on public.cloud_media_items
  for each row execute function public.cmi_set_sort_cols();

-- One-time backfill for existing rows.
update cloud_media_items set
  added_at = public.safe_bigint(metadata->>'added'),
  rating_num = public.safe_numeric(metadata->>'rating'),
  release_year = coalesce(
    (regexp_match(coalesce(title,''), '[(\[]\s*((?:19|20)\d{2})\s*[)\]]'))[1]::int,
    (regexp_match(coalesce(title,''), '(?:^|\s)((?:19|20)\d{2})\s*$'))[1]::int
  )
where item_type in ('movie','series');

update cloud_media_items m set release_year = t.release_year
from cloud_titles t
where t.user_id = m.user_id and t.item_type = m.item_type
  and t.provider_tmdb_id = m.metadata->>'providerTmdbId'
  and t.release_year is not null and m.release_year is null and m.item_type in ('movie','series');

create index if not exists idx_cmi_sort_added  on public.cloud_media_items (user_id, item_type, added_at    desc nulls last, external_id);
create index if not exists idx_cmi_sort_rating on public.cloud_media_items (user_id, item_type, rating_num  desc nulls last, external_id);
create index if not exists idx_cmi_sort_year   on public.cloud_media_items (user_id, item_type, release_year desc nulls last, external_id);
create index if not exists idx_cmi_sort_title  on public.cloud_media_items (user_id, item_type, title, external_id);

-- Called at the end of refreshVodTitleProjection (per user+source): push the
-- TMDB-matched release_year from cloud_titles onto the grid rows. The TMDB year
-- is authoritative, so it overrides a (possibly wrong) title-parsed year.
create or replace function public.propagate_media_item_years(p_user uuid, p_source uuid)
returns void language sql as $$
  update cloud_media_items m set release_year = t.release_year
  from cloud_titles t
  where m.user_id = p_user and m.source_id = p_source and m.item_type in ('movie','series')
    and t.user_id = m.user_id and t.item_type = m.item_type
    and t.provider_tmdb_id = m.metadata->>'providerTmdbId'
    and t.release_year is not null
    and m.release_year is distinct from t.release_year;
$$;
