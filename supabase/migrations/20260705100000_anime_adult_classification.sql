-- Genre taxonomy (2026-07-05): route anime → Adult Animation.
--
-- Japanese animation (anime/manga) was falling into "Kids Animation" alongside Western
-- cartoons, leaving the "Adult Animation" rail permanently empty despite hundreds of anime
-- titles (verified live: reference account had 802 in animation_kids, 0 in animation_adult).
-- Product intent: anime is a distinct audience from Disney/Pixar/cartoons and belongs in the
-- Adult Animation rail. This is the SQL port of the same change made to the TS classifier
-- (_shared/genre-taxonomy.ts) and its browser mirror (public/js/utils/GenreTaxonomy.js).
--
-- New signal: is_anime — the anime/manga wording ("anime"; "animé/animée/animés" all
-- normalise to contain "anime"; "manga") — WITHOUT the general Western animation words that
-- only share the "anim…" stem (animation, animación→animacion, animação→animacao, animazione,
-- cartoon, dessin). An explicit kids marker still wins, so kids anime stays in Kids Animation.
--
-- Body reproduced verbatim from 20260704160000 with only the anime lines added, so the SQL
-- stays a faithful port of classifyTitleBuckets. The drift test (tests/genre-taxonomy-parity)
-- and a live parity check (below, in the PR) lock the two together.
create or replace function public.norva_classify_buckets(category_name text, genres jsonb)
returns text[] language plpgsql stable parallel safe as $$
declare
  catn text := public.norva_norm(category_name);
  buckets text[] := '{}';
  g text; b text; kw text;
  is_anim boolean; is_anime boolean; is_adult boolean; is_kids boolean;
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
  is_anime := catn ~ '(anime|manga|انمي|مانجا)';

  -- Animation refinement: TMDB "Animation" defaults to kids; anime OR adult wording moves it
  -- to the adult bucket, unless it's flagged kids (which always wins).
  if ('animation_kids' = any(buckets)) and (is_anime or is_adult) and not is_kids then
    buckets := array_append(array_remove(buckets, 'animation_kids'), 'animation_adult');
  end if;
  if is_anim then
    buckets := array_append(buckets, case when (is_anime or is_adult) and not is_kids then 'animation_adult' else 'animation_kids' end);
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

-- The GIN-indexed genre_buckets on existing cloud_titles rows are backfilled OUTSIDE this
-- migration (as applied on prod, 2026-07-05) so no long lock is held: only rows whose category
-- carries an anime/manga marker can change bucket, so the re-classification is scoped to them:
--   UPDATE public.cloud_titles
--     SET genre_buckets = public.norva_classify_buckets(genre_category, genre_payload)
--   WHERE public.norva_norm(genre_category) ~ '(anime|manga|انمي|مانجا)'
--     AND genre_buckets IS DISTINCT FROM public.norva_classify_buckets(genre_category, genre_payload);
-- Then cloud_refresh_facet_summary() is re-run for the affected (user, item_type) combos so the
-- Categories picker reflects the new Adult Animation counts immediately.
