-- Tighten the curated genre classifier.
--
-- The old substring markers treated ANIMAL PLANET / ANIMAUX as animation and
-- treated any category containing the digits 18 (notably release year 2018) as
-- adult animation. Keep the browser, edge and SQL classifiers aligned.

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

  is_adult := catn ~ '(adulte|adult|mature|ecchi|hentai|seinen|بالغين)'
              or catn ~ '(^| )18( |$)';
  is_kids  := catn ~ '(enfant|kids|kid|jeunesse|junior|disney|pixar|اطفال|طفال)';
  is_anim  := catn ~ '(animation|animacion|animacao|animazione|anime|dessin|cartoon|manga|رسوم|انمي|كرتون)';
  is_anime := catn ~ '(anime|manga|انمي|مانجا)';

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

-- Only rows touched by the two tightened markers can change. Reclassify this
-- bounded subset, then refresh the already-precomputed category facets for the
-- affected accounts and media types.
with affected as materialized (
  select distinct user_id, item_type
  from public.cloud_titles
  where genre_category is not null
    and (
      -- "anim" used to match non-animation words such as animal/animaux.
      (public.norva_norm(genre_category) like '%anim%'
        and public.norva_norm(genre_category) !~ '(animation|animacion|animacao|animazione|anime|dessin|cartoon|manga|رسوم|انمي|كرتون)')
      or
      -- A non-standalone 18 only mattered when the same category was animation.
      (public.norva_norm(genre_category) ~ '(animation|animacion|animacao|animazione|anime|dessin|cartoon|manga|رسوم|انمي|كرتون)'
        and public.norva_norm(genre_category) like '%18%'
        and public.norva_norm(genre_category) !~ '(^| )18( |$)')
    )
), updated as (
  update public.cloud_titles
  set genre_buckets = public.norva_classify_buckets(genre_category, genre_payload)
  where genre_category is not null
    and (
      (public.norva_norm(genre_category) like '%anim%'
        and public.norva_norm(genre_category) !~ '(animation|animacion|animacao|animazione|anime|dessin|cartoon|manga|رسوم|انمي|كرتون)')
      or
      (public.norva_norm(genre_category) ~ '(animation|animacion|animacao|animazione|anime|dessin|cartoon|manga|رسوم|انمي|كرتون)'
        and public.norva_norm(genre_category) like '%18%'
        and public.norva_norm(genre_category) !~ '(^| )18( |$)')
    )
    and genre_buckets is distinct from public.norva_classify_buckets(genre_category, genre_payload)
  returning 1
)
select public.cloud_refresh_facet_summary(a.user_id, a.item_type)
from affected a
where exists (select 1 from updated);
