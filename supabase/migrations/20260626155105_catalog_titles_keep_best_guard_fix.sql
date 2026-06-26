-- Fix a three-valued-logic bug in catalog_titles_keep_best(): when metadata has
-- no 'tmdb' key, `jsonb_typeof(metadata->'tmdb')` is SQL NULL, so
-- `new_enriched := (NULL = 'object')` was NULL — and `if not NULL` is treated as
-- false, silently skipping the entire no-downgrade block (an empirical test caught
-- a raw write fully clobbering an enriched row). Coalesce the enrichment flags to
-- false so the guard actually fires. Body stays exception-guarded.

create or replace function public.catalog_titles_keep_best()
returns trigger
language plpgsql
as $$
declare
  new_enriched boolean;
  old_enriched boolean;
  max_year int;
begin
  begin
    max_year := extract(year from now())::int + 1;
    -- Guardrail: a release year outside [1900, current+1] is provider noise.
    if new.release_year is not null and (new.release_year < 1900 or new.release_year > max_year) then
      new.release_year := null;
    end if;

    if tg_op = 'INSERT' then
      return new;  -- first value for this title; accept as-is (post year-clamp)
    end if;

    -- coalesce: absent tmdb -> jsonb_typeof is NULL; treat as NOT enriched (false).
    new_enriched := coalesce(jsonb_typeof(new.metadata -> 'tmdb') = 'object', false);
    old_enriched := coalesce(jsonb_typeof(old.metadata -> 'tmdb') = 'object', false);

    if not new_enriched then
      -- Incoming is provider-raw → never downgrade what is already there.
      if old_enriched then
        new.metadata := old.metadata;                 -- keep the enriched blob
      elsif old.metadata <> '{}'::jsonb then
        new.metadata := old.metadata;                 -- keep established metadata (stability)
      end if;
      -- Keep established display values; only fill a field the row left null.
      new.title          := coalesce(old.title, new.title);
      new.original_title := coalesce(old.original_title, new.original_title);
      new.release_year   := coalesce(old.release_year, new.release_year);
      new.poster_url     := coalesce(old.poster_url, new.poster_url);
      new.backdrop_url   := coalesce(old.backdrop_url, new.backdrop_url);
    end if;
    -- (new_enriched: incoming is TMDB-authoritative — keep new.* as written.)

    -- Never regress the freshness stamps.
    new.updated_at  := greatest(coalesce(new.updated_at, old.updated_at), old.updated_at);
    new.enriched_at := greatest(coalesce(new.enriched_at, old.enriched_at), old.enriched_at);
  exception when others then
    return new;  -- a keep-best hiccup must never break a sync write
  end;
  return new;
end;
$$;