-- Canonical keep-best guard for the global title cache (catalog_titles).
--
-- catalog_titles has TWO blanket writers — the dual-write in
-- _shared/vod-title-projection.ts and the cloud_titles_mirror_to_catalog()
-- statement trigger — both doing last-write-wins upserts. Combined with the
-- mirror's self-thinning (it empties cloud_titles.metadata once mirrored), a
-- provider-raw re-write that clobbers an enriched catalog row could lose
-- enrichment that no longer exists anywhere else. This BEFORE trigger makes
-- catalog_titles monotonic: TMDB-enriched metadata/display values are never
-- downgraded to provider-raw or null; nulls are filled but established values
-- are kept when neither side is enriched (no provider-raw flapping between
-- users); release_year is clamped to a sane range. audio_languages is
-- crawl-owned and never touched. The whole body is exception-guarded — it runs
-- inside the sync-triggered write path, so a hiccup must never break a sync.
--
-- Additive + reversible. The read path stays flag-gated
-- (NORVA_CATALOG_READ_SOURCE, default OFF) so this only shapes WRITES to a table
-- nothing reads in prod yet: zero read impact.

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

    new_enriched := jsonb_typeof(new.metadata -> 'tmdb') = 'object';
    old_enriched := jsonb_typeof(old.metadata -> 'tmdb') = 'object';

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

drop trigger if exists catalog_titles_keep_best_trg on public.catalog_titles;
create trigger catalog_titles_keep_best_trg
  before insert or update on public.catalog_titles
  for each row execute function public.catalog_titles_keep_best();