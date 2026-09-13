-- Exact declared-language/category forms confirmed by the residual audit.
-- No country aliases, observations, constraints or catalogue rows are changed.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

create or replace function public.catalog_provider_language(p_metadata jsonb, p_external_id text, p_raw_title text)
returns text language plpgsql immutable security invoker set search_path = '' as $f$
declare
  category text := left(regexp_replace(coalesce(nullif(p_metadata->>'categoryName',''),p_metadata->>'category_name',''), '[▎▏▍▌│┃┆┊｜•·・]', ' | ', 'g'),1000);
  raw text := left(regexp_replace(coalesce(p_raw_title,''), '[▎▏▍▌│┃┆┊｜•·・]', ' | ', 'g'),2000);
  prefix_pattern text := '^\s*([A-Z0-9]+(?:[._/+-][A-Z0-9]+){0,4})(?:\s*[-–—]\s+|\s+[-–—]\s*|\s*[|:]\s*)';
  prefix_match text[]; provider_prefix boolean; prefix text; suffix text; title_text text; without_year text;
  part text; normalized text; token text; lower_token text; tokens text[];
  code text; tags text[] := '{}'; annotated boolean; annotation_only boolean;
  has_sub boolean; has_dub boolean; has_multi boolean; idx integer;
  selection text := public.selection_provider_audio_language(p_metadata,p_external_id);
  nl_hindi_category boolean; en_nl_ufc_category boolean;
  region_hint boolean := false; audio_blocked boolean := false;
begin
  -- Existing exact Selection declarations keep their priority and hash guards.
  if selection is not null then return selection; end if;
  category := regexp_replace(category,'^\s*([A-Z]{2,3})\s+(MOVIES|FILMS|SERIES)\s*$','\1 | \2');
  -- Full labels only. Never turn arbitrary category prose/countries into audio.
-- BEGIN GENERATED AUDITED CATEGORY LABELS
  category := coalesce('{"FR I BOX OFFICE & ULTRA 4K":"FR | BOX OFFICE & ULTRA 4K","أفلام فرنسية":"FRENCH MOVIES","Séries ARABES":"ARABIC SERIES","مسلسلات عربية | SERIES ARABES":"ARABIC SERIES","افلام عربية | FILMS ARABES":"ARABIC MOVIES","أفلام عربية قديمة | ANCIENS FILMS ARABES":"ARABIC MOVIES","مسلسلات تركية مدبلجة عربي | Turkish Series Arabic Dub":"ARABIC DUB"}'::jsonb ->> btrim(regexp_replace(category,'\s+',' ','g')),category);
-- END GENERATED AUDITED CATEGORY LABELS
  if category ~* '^\s*EX-YU\s*[|:]?\s*$' then category := 'EXYU'; end if;
  nl_hindi_category := category ~* '^\s*NL\s*\|\s*HINDI\s*$';
  prefix_match := regexp_match(raw,prefix_pattern);
  if prefix_match is null then
    prefix_pattern := '^\s*([A-Z0-9]+(?:[._/+-][A-Z0-9]+){1,4})[ \t]{2,}';
    prefix_match := regexp_match(raw,prefix_pattern);
  end if;
  provider_prefix := prefix_match is not null;
  if prefix_match is null then
    prefix_pattern := '^\s*[[(]([[:alnum:]ऀ-ൿ ./+-]{2,40})[\])]\s*';
    prefix_match := regexp_match(raw,prefix_pattern);
  end if;
  prefix := coalesce(prefix_match[1],'');
  -- Only the audited bare EN prefix in this exact market category suppresses NL.
  -- [EN], other prefixes/categories and conflicting suffixes retain their guards.
  en_nl_ufc_category := provider_prefix and prefix='EN' and category ~* '^\s*NL\s*\|\s*UFC\s*$';
  title_text := case when prefix_match is null then raw else regexp_replace(raw,prefix_pattern,'') end;
  without_year := btrim(regexp_replace(title_text,'\s*[[(]?(?:19|20)[0-9]{2}[\])]?\s*$',''));
  without_year := regexp_replace(without_year,'([\])])(?:\s+(?:4K|8K|SD|HD|FHD|UHD|[0-9]{3,4}p))+\s*$','\1','i');
  suffix := coalesce((regexp_match(without_year,'[[(]([[:alnum:]ऀ-ൿ ./+-]{2,40})[\])]\s*$'))[1],
    (regexp_match(without_year,'\s[-–—|]\s*([A-Z]{2,3}|[[:alpha:]ऀ-ൿ]{4,30})\s*$'))[1],
    (regexp_match(without_year,'(?:^|\s)([[:alpha:]ऀ-ൿ]{4,30})\s+(?:dubbed|dub|audio)\s*$','i'))[1],
    (regexp_match(without_year,'\m(?:dubbed|audio)\s+(?:in\s+)?([[:alpha:]ऀ-ൿ]{4,30})\s*$','i'))[1],'');
  audio_blocked := raw ~* '\m(?:vost\w*|subtitles?|subbed)\M';
  for idx in 1..3 loop
    part := case idx
      when 1 then case when nl_hindi_category and provider_prefix and prefix='NL' then '' else prefix end
      when 2 then case when nl_hindi_category then 'HINDI' when en_nl_ufc_category then 'UFC' else category end
      else suffix end;
    part := public.catalog_provider_dubbed_category(part);
    annotated := idx <> 2;
    if annotated then
      part := regexp_replace(part,'^([[:alpha:]ऀ-ൿ]{4,30})(?:[- ]language)?\s+version$','\1','i');
      part := regexp_replace(part,'^true\s+fr$','FR','i');
      part := regexp_replace(part,'^nl-be$','NL','i');
      part := regexp_replace(part,'^EX-YU$','EXYU','i');
      part := regexp_replace(part,'^([[:alpha:]ऀ-ൿ]{2,30})\s+blu-ray$','\1','i');
    end if;
    normalized := normalize(regexp_replace(normalize(part,NFD),U&'[\0300-\036f]','','g'),NFC);
    tokens := array_remove(regexp_split_to_array(normalized,'[^[:alnum:]ऀ-ൿ]+'),'');
    has_sub := false; has_dub := false; has_multi := false; annotation_only := true;
    foreach token in array tokens loop
      lower_token := lower(token);
      has_sub := has_sub or lower_token ~ '^(sub|subs|subt|subbed|subtitle|subtitles|st|subtitled|vost\w*|sub(fr|en|es|ar|de|it|pt|nl|ru|hi))$';
      has_dub := has_dub or lower_token in ('dub','dubbed','dublado','doblado','doublage');
      has_multi := has_multi or lower_token in ('multi','dual','bilingual','multiaudio');
      if public.catalog_provider_language_alias(lower_token) is null and lower_token not in ('hu','exyu')
        and not (idx=1 and provider_prefix and lower_token ~ '^(af|vp|eg|ye|s|shr|as|sbus|sham|ma|alg|kh|doc|d|tn|xmas|pod|sh|anm|hara|li|ly|dz|ptv|do|ch|chr|irq|isl|bdy|kid|kids|hdr|dv|jo|jor|cam|dsc|pse|sus|geo|kd)$')
        and lower_token !~ '^(sub|subs|subt|subbed|subtitle|subtitles|st|subtitled|vost\w*|sub(fr|en|es|ar|de|it|pt|nl|ru|hi)|dub|dubbed|dublado|doblado|doublage|multi|dual|bilingual|multiaudio|audio|in|4k|8k|sd|hd|fhd|uhd|[0-9]{3,4}p)$'
      then annotation_only := false; end if;
    end loop;
    if (has_sub or part ~* 'sous[\s-]+titres' or part ~ 'مترجم|ترجمة|زیرنویس|زیرنویس‌دار')
      and not has_dub then audio_blocked := true; end if;
    if annotated and not annotation_only then continue; end if;
    if has_multi then audio_blocked := true; end if;
    foreach token in array tokens loop
      region_hint := region_hint or (lower(token)='exyu' and (annotated
        or part ~* '(?:^|[|:/\[(])\s*exyu(?:\s*[-–—|:/\])]|\s*$)'
        or part ~* '^\s*EXYU(?:\s+(?:MOVIES|FILMS|SERIES|SUBS?|SUBTITLES?|MULTI|4K|8K|SD|HD|FHD|UHD))*\s*$'));
      code := public.catalog_provider_language_alias(lower(token));
      if code is not null and (length(token)>3 or cardinality(tokens)=1 or (token=upper(token)
        and (annotated or part ~* ('(?:^|[|:/\[(])\s*' || token || '(?:\s*[-–—|:/\])]|\s*$)'))))
        and not code=any(tags) then tags:=array_append(tags,code); end if;
    end loop;
  end loop;
  if cardinality(tags)=2 and 'nordic'=any(tags) and tags && array['da','sv','no']::text[] then
    tags := array_remove(tags,'nordic');
  end if;
  return case when not audio_blocked and cardinality(tags)=1 then tags[1]
    when region_hint then 'exyu' end;
end
$f$;

-- CREATE OR REPLACE preserves the existing invoker function and its ACL.
commit;
