-- Denormalised genre BUCKET set on cloud_titles, so genre browsing (rails, "See all"
-- grids, the genre picker counts) all read the SAME whole-catalog signal.
--
-- WHY: the Movies/Series genre "See all" grid (listGenreItems) and the rails
-- (listGenreRails) classified an in-memory window of only the newest ~6000 titles
-- by synced_at, then filtered. On large catalogs (100k–334k movies) any bucket whose
-- members sit outside that recency window renders near-empty — e.g. "Adventure" showed
-- ~4 cards while the genre picker (cloud_genre_summary, whole-catalog) counted 350+.
-- Root cause proven in DB: of 204 payload-"Adventure" movies for one account, 181 sit
-- OUTSIDE the 6000 window; 96.5% of that window carries genre_payload = NULL (freshly
-- synced, not yet TMDB-enriched), so in-window rows classify by genre_category alone.
--
-- FIX: store genre_buckets text[] (the curated buckets a title belongs to) computed by
-- a faithful SQL port of the TS classifier `classifyTitleBuckets` (_shared/genre-taxonomy.ts),
-- GIN-indexed, so grid/rails/counts all filter `genre_buckets @> {bucket}` over the WHOLE
-- catalogue via the index — no recency window, exact counts. rating_num is denormalised
-- alongside so the bucket grid's Rating filter is a real SQL predicate too.
--
-- The classifier stays authoritative in TS (also mirrored in the browser for local mode);
-- this SQL port is validated to match it on live data (per-bucket counts equal the
-- existing summary, e.g. Adventure = 351 for the reference account). A drift test
-- (tests/genre-taxonomy-parity) locks representative fixtures.

create extension if not exists unaccent;

-- Mirror of norm() in _shared/genre-taxonomy.ts: strip accents/case/punctuation,
-- keep Arabic letters (U+0600..U+06FF), collapse to single spaces.
create or replace function public.norva_norm(v text)
returns text language sql stable parallel safe as $$
  select coalesce(nullif(trim(regexp_replace(lower(public.unaccent(coalesce(v,''))), E'[^a-z0-9؀-ۿ]+', ' ', 'g')), ''), '');
$$;

-- Faithful SQL port of classifyTitleBuckets(categoryName, tmdbGenres). Multi-membership,
-- returns bucket ids in display order. Exception-safe: any error yields {autres} so it can
-- never break a write from the trigger below.
create or replace function public.norva_classify_buckets(category_name text, genres jsonb)
returns text[] language plpgsql stable parallel safe as $$
declare
  catn text := public.norva_norm(category_name);
  buckets text[] := '{}';
  g text; b text; kw text;
  is_anim boolean; is_adult boolean; is_kids boolean;
  order_ids text[] := array['action','aventure','comedie','drame','scifi','horreur','thriller','romance','familial','animation_kids','animation_adult','kdrama','telerealite','documentaires','arabe','autres'];
  out_ids text[] := '{}';
  oid text;
begin
  -- TMDB genres -> bucket (TMDB_GENRE_TO_BUCKET). genre_payload is a jsonb array of
  -- strings; tolerate {name} objects too, exactly like coerceGenres().
  if genres is not null and jsonb_typeof(genres) = 'array' then
    for g in
      select public.norva_norm(case when jsonb_typeof(e) = 'string' then e #>> '{}' else coalesce(e ->> 'name','') end)
      from jsonb_array_elements(genres) as t(e)
    loop
      b := case g
        when 'action' then 'action' when 'action adventure' then 'action' when 'war' then 'action'
        when 'war politics' then 'action' when 'western' then 'action' when 'guerre' then 'action'
        when 'adventure' then 'aventure' when 'aventure' then 'aventure'
        when 'comedy' then 'comedie' when 'comedie' then 'comedie'
        when 'drama' then 'drame' when 'drame' then 'drame' when 'history' then 'drame'
        when 'histoire' then 'drame' when 'soap' then 'drame'
        when 'science fiction' then 'scifi' when 'sci fi fantasy' then 'scifi'
        when 'fantasy' then 'scifi' when 'fantastique' then 'scifi'
        when 'horror' then 'horreur' when 'horreur' then 'horreur'
        when 'thriller' then 'thriller' when 'crime' then 'thriller'
        when 'mystery' then 'thriller' when 'mystere' then 'thriller'
        when 'romance' then 'romance'
        when 'family' then 'familial' when 'familial' then 'familial' when 'kids' then 'familial'
        when 'music' then 'familial' when 'musique' then 'familial'
        when 'tv movie' then 'familial' when 'telefilm' then 'familial'
        when 'animation' then 'animation_kids'
        when 'reality' then 'telerealite'
        when 'documentary' then 'documentaires' when 'documentaire' then 'documentaires'
        else null end;
      if b is not null then buckets := array_append(buckets, b); end if;
    end loop;
  end if;

  is_adult := catn ~ '(adulte|adult|mature|18|ecchi|hentai|seinen|بالغين)';
  is_kids  := catn ~ '(enfant|kids|kid|jeunesse|junior|disney|pixar|اطفال|طفال)';
  is_anim  := catn ~ '(animation|anime|anim|dessin|cartoon|manga|رسوم|انمي|كرتون)';

  -- Animation refinement: TMDB "Animation" defaults to kids; adult wording moves it.
  if ('animation_kids' = any(buckets)) and is_adult then
    buckets := array_append(array_remove(buckets, 'animation_kids'), 'animation_adult');
  end if;
  if is_anim then
    buckets := array_append(buckets, case when is_adult and not is_kids then 'animation_adult' else 'animation_kids' end);
  end if;
  if catn ~ '(k drama|kdrama|korean|coreen|coreenne|coree|كوري)' then buckets := array_append(buckets, 'kdrama'); end if;
  if catn ~ '(reality|tele realite|telerealite|emission|real tv|الواقع)' then buckets := array_append(buckets, 'telerealite'); end if;
  if catn ~ '(arabe|arabic|arab|algerien|egyptien|syrien|libanais|khaliji|ramadan)'
     or catn ~ '^ar( |$)'
     or category_name ~ E'[؀-ۿ]' then buckets := array_append(buckets, 'arabe'); end if;

  -- Category keyword, FIRST match wins (CATEGORY_GENRE_KEYWORDS order).
  kw := case
    when catn ~ '(horreur|horror|epouvante)' then 'horreur'
    when catn ~ '(thriller|policier|polar|suspense|crime)' then 'thriller'
    when catn ~ '(science fiction|sci fi|scifi|fantastique|fantasy)' then 'scifi'
    when catn ~ '(romance|romantique)' then 'romance'
    when catn ~ '(documentaire|documentary|docu)' then 'documentaires'
    when catn ~ '(comedie|comedy|humour)' then 'comedie'
    when catn ~ '(aventure|adventure)' then 'aventure'
    when catn ~ '(action|guerre)' then 'action'
    when catn ~ '(drame|drama)' then 'drame'
    when catn ~ '(familial|family|famille)' then 'familial'
    else null end;
  if kw is not null then buckets := array_append(buckets, kw); end if;

  if array_length(buckets,1) is null then buckets := array['autres']; end if;

  foreach oid in array order_ids loop
    if oid = any(buckets) then out_ids := array_append(out_ids, oid); end if;
  end loop;
  return out_ids;
exception when others then
  return array['autres'];
end;
$$;

alter table public.cloud_titles
  add column if not exists genre_buckets text[],
  add column if not exists rating_num numeric;

-- Extend the existing genre-sync trigger: also derive genre_buckets (always, from the
-- possibly-preserved genre columns) and rating_num (preserve-unless-present, like the
-- other genre keys). Same BEFORE INSERT OR UPDATE OF metadata wiring, so the every-5-min
-- audio crawl still never re-fires it.
create or replace function public.cloud_titles_sync_genre_cols()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.metadata is not null then
    if new.metadata ? 'categoryName' then
      new.genre_category := new.metadata->>'categoryName';
    end if;
    if (new.metadata #> '{tmdb,genres}') is not null then
      new.genre_payload := new.metadata->'tmdb'->'genres';
    end if;
    if (new.metadata #> '{tmdb,vote_average}') is not null then
      begin
        new.rating_num := nullif(new.metadata #>> '{tmdb,vote_average}', '')::numeric;
      exception when others then null; -- never break a write over a bad rating
      end;
    end if;
  end if;
  -- Recompute the denormalised bucket set from the final genre columns. The classifier
  -- is exception-safe (returns {autres} on any error), so this can never raise.
  new.genre_buckets := public.norva_classify_buckets(new.genre_category, new.genre_payload);
  return new;
end;
$$;

-- Per-bucket BROWSABLE counts (variant_count > 0, matching the grid) straight from the
-- denormalised column. Replaces the summary that classified in the edge and counted
-- variant-less rows, so the genre picker numbers equal what the grid actually shows.
create or replace function public.cloud_genre_bucket_counts(
  p_user_id uuid,
  p_item_type text,
  p_source_id uuid default null
)
returns table(bucket text, n bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select b as bucket, count(*) as n
  from public.cloud_titles t
       cross join lateral unnest(coalesce(t.genre_buckets, array['autres'])) as b
  where t.user_id = p_user_id
    and t.item_type = p_item_type
    and t.variant_count > 0
    and b <> 'autres'
    and (
      p_source_id is null
      or exists (
        select 1 from public.cloud_title_variants v
        where v.title_id = t.id and v.source_id = p_source_id
      )
    )
  group by b
$$;

revoke execute on function public.cloud_genre_bucket_counts(uuid, text, uuid) from public, anon, authenticated;
grant  execute on function public.cloud_genre_bucket_counts(uuid, text, uuid) to service_role;

-- NOTE: the GIN index on genre_buckets and the one-time backfill of existing rows are
-- run OUTSIDE this migration so neither holds a long lock on the ~576k-row table. As
-- applied on prod (2026-07-04):
--   * backfill genre_buckets: UPDATE ... SET genre_buckets =
--       norva_classify_buckets(genre_category, genre_payload) in batches of ~150k
--       (narrow columns only, no metadata detoast) until no NULLs remain;
--   * GIN index: CREATE INDEX CONCURRENTLY cloud_titles_genre_buckets_gin
--       ON cloud_titles USING gin (genre_buckets);
--   * backfill rating_num from the GLOBAL catalog (cloud_titles.metadata.tmdb is thinned
--       out for verified titles, so the rating lives in catalog_titles): UPDATE joins
--       catalog_titles.metadata->'tmdb'->'vote_average' on provider_tmdb_id + item_type.
-- Validation: per-bucket counts from norva_classify_buckets equal the edge summary
-- (Adventure = 351 for the reference account) and the grid now returns the same 351.
-- See docs/audits/MOVIES-SERIES-PAGES-AUDIT.md.
