begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

-- Parser-only repair of audited supplier declarations. This migration never
-- rewrites file observations, playback profiles, verification or catalogue rows.
-- The browser/shared parser and the generated aliases remain the source grammar.
create or replace function public.catalog_provider_language_alias(p_token text)
returns text language sql immutable security invoker set search_path = '' as $f$
-- BEGIN GENERATED ALIASES
  select '{"al":"sq","alb":"sq","sq":"sq","sqi":"sq","albanian":"sq","shqip":"sq","ar":"ar","ara":"ar","arabic":"ar","arabe":"ar","العربية":"ar","fr":"fr","fra":"fr","fre":"fr","vf":"fr","vff":"fr","vfq":"fr","french":"fr","francais":"fr","truefrench":"fr","en":"en","eng":"en","english":"en","anglais":"en","de":"de","deu":"de","ger":"de","german":"de","deutsch":"de","allemand":"de","es":"es","spa":"es","spanish":"es","espanol":"es","espagnol":"es","castellano":"es","latino":"es","pt":"pt","por":"pt","portuguese":"pt","portugues":"pt","portugais":"pt","it":"it","ita":"it","italian":"it","italiano":"it","italien":"it","nl":"nl","nld":"nl","dut":"nl","dutch":"nl","nederlands":"nl","neerlandais":"nl","gr":"el","el":"el","ell":"el","gre":"el","greece":"el","greek":"el","grec":"el","ru":"ru","rus":"ru","russian":"ru","russe":"ru","русский":"ru","pl":"pl","pol":"pl","polish":"pl","polski":"pl","polonais":"pl","tr":"tr","tur":"tr","turkish":"tr","turkce":"tr","turc":"tr","hi":"hi","hin":"hi","hindi":"hi","हिन्दी":"hi","हिंदी":"hi","te":"te","tel":"te","telugu":"te","తెలుగు":"te","ta":"ta","tam":"ta","tamil":"ta","தமிழ்":"ta","ml":"ml","mal":"ml","malayalam":"ml","മലയാളം":"ml","kn":"kn","kan":"kn","kannada":"kn","ಕನ್ನಡ":"kn","bn":"bn","ben":"bn","bengali":"bn","bangla":"bn","বাংলা":"bn","mr":"mr","mar":"mr","marathi":"mr","pa":"pa","pan":"pa","punjabi":"pa","ਪੰਜਾਬੀ":"pa","gu":"gu","guj":"gu","gujarati":"gu","ur":"ur","urd":"ur","urdu":"ur","si":"si","sin":"si","sinhala":"si","ne":"ne","nep":"ne","nepali":"ne","odia":"or","oriya":"or","ja":"ja","jpn":"ja","jp":"ja","japanese":"ja","japonais":"ja","日本語":"ja","ko":"ko","kor":"ko","korean":"ko","coreen":"ko","한국어":"ko","zh":"zh","zho":"zh","chi":"zh","chinese":"zh","mandarin":"zh","中文":"zh","yue":"yue","cantonese":"yue","th":"th","tha":"th","thai":"th","vi":"vi","vie":"vi","vietnamese":"vi","id":"id","indonesian":"id","indonesia":"id","ms":"ms","msa":"ms","malay":"ms","melayu":"ms","fil":"fil","filipino":"fil","tagalog":"fil","fa":"fa","fas":"fa","per":"fa","persian":"fa","farsi":"fa","فارسی":"fa","he":"he","heb":"he","hebrew":"he","עברית":"he","ku":"ku","kur":"ku","kurdish":"ku","mt":"mt","mlt":"mt","maltese":"mt","sv":"sv","swe":"sv","swedish":"sv","svenska":"sv","se":"sv","da":"da","dan":"da","danish":"da","dansk":"da","dk":"da","no":"no","nor":"no","norwegian":"no","norsk":"no","fi":"fi","fin":"fi","finnish":"fi","suomi":"fi","icelandic":"is","cs":"cs","ces":"cs","cze":"cs","czech":"cs","cz":"cs","sk":"sk","slk":"sk","slo":"sk","slovak":"sk","slovene":"sl","slovenian":"sl","ro":"ro","ron":"ro","rum":"ro","romanian":"ro","romana":"ro","hu":null,"hun":"hu","hungarian":"hu","magyar":"hu","hongrois":"hu","bg":"bg","bul":"bg","bulgarian":"bg","hr":"hr","hrv":"hr","croatian":"hr","sr":"sr","srp":"sr","serbian":"sr","bs":"bs","bos":"bs","bosnian":"bs","ukrainian":"uk","ukr":"uk","ua":"uk","lithuanian":"lt","latvian":"lv","estonian":"et","catalan":"ca","basque":"eu","galician":"gl","armenian":"hy","georgian":"ka","afrikaans":"af","swahili":"sw","zulu":"zu","yoruba":"yo","amharic":"am","so":"so","som":"so","somali":"so","somalia":"so","nordic":"nordic","scandinavian":"nordic","scandinavia":"nordic"}'::jsonb ->> p_token;
-- END GENERATED ALIASES
$f$;

create or replace function public.catalog_provider_language(p_metadata jsonb, p_external_id text, p_raw_title text)
returns text language plpgsql immutable security invoker set search_path = '' as $f$
declare
  category text := left(regexp_replace(coalesce(nullif(p_metadata->>'categoryName',''),p_metadata->>'category_name',''), '[▎▏▍▌│┃┆┊｜•·・]', ' | ', 'g'),1000);
  raw text := left(regexp_replace(coalesce(p_raw_title,''), '[▎▏▍▌│┃┆┊｜•·・]', ' | ', 'g'),2000);
  prefix_pattern text := '^\s*([A-Z0-9]+(?:[._/+-][A-Z0-9]+){0,4})\s*[-–—|:]\s*';
  prefix_match text[]; prefix text; suffix text; title_text text; without_year text;
  part text; normalized text; token text; lower_token text; tokens text[];
  code text; tags text[] := '{}'; annotated boolean; annotation_only boolean;
  has_sub boolean; has_dub boolean; has_multi boolean; idx integer;
  selection text := public.selection_provider_audio_language(p_metadata,p_external_id);
begin
  -- Keep the existing exact Selection declaration/hash checks ahead of fallback.
  if selection is not null then return selection; end if;
  -- Only complete category labels delimit these codes with a space, not prose.
  category := regexp_replace(category,'^\s*([A-Z]{2,3})\s+(MOVIES|FILMS|SERIES)\s*$','\1 | \2');
  prefix_match := regexp_match(raw,prefix_pattern);
  if prefix_match is null then
    prefix_pattern := '^\s*[[(]([[:alnum:]ऀ-ൿ ./+-]{2,40})[\])]\s*';
    prefix_match := regexp_match(raw,prefix_pattern);
  end if;
  prefix := coalesce(prefix_match[1],'');
  -- Do not read the supplier separator twice: "EN | Dutch" and "SW | Dual"
  -- have a one-word film title after the prefix, not a release annotation.
  title_text := case when prefix_match is null then raw else regexp_replace(raw,prefix_pattern,'') end;
  without_year := btrim(regexp_replace(title_text,'\s*[[(]?(?:19|20)[0-9]{2}[\])]?\s*$',''));
  suffix := coalesce((regexp_match(without_year,'[[(]([[:alnum:]ऀ-ൿ ./+-]{2,40})[\])]\s*$'))[1],
    (regexp_match(without_year,'\s[-–—|]\s*([A-Z]{2,3}|[[:alpha:]ऀ-ൿ]{4,30})\s*$'))[1],
    (regexp_match(without_year,'(?:^|\s)([[:alpha:]ऀ-ൿ]{4,30})\s+(?:dubbed|dub|audio)\s*$','i'))[1],
    (regexp_match(without_year,'\m(?:dubbed|audio)\s+(?:in\s+)?([[:alpha:]ऀ-ൿ]{4,30})\s*$','i'))[1],'');
  if raw ~* '\m(?:vost\w*|subtitles?|subbed)\M' then return null; end if;
  for idx in 1..3 loop
    part := case idx when 1 then prefix when 2 then category else suffix end;
    -- Preserve the published targeted "English Hindi Dubbed" normalization.
    part := public.catalog_provider_dubbed_category(part);
    annotated := idx <> 2;
    normalized := normalize(regexp_replace(normalize(part,NFD),U&'[\0300-\036f]','','g'),NFC);
    tokens := array_remove(regexp_split_to_array(normalized,'[^[:alnum:]ऀ-ൿ]+'),'');
    has_sub := false; has_dub := false; has_multi := false; annotation_only := true;
    foreach token in array tokens loop
      lower_token := lower(token);
      has_sub := has_sub or lower_token ~ '^(sub|subs|subt|subbed|subtitle|subtitles|st|subtitled|vost\w*|sub(fr|en|es|ar|de|it|pt|nl|ru|hi))$';
      has_dub := has_dub or lower_token in ('dub','dubbed','dublado','doblado','doublage');
      has_multi := has_multi or lower_token in ('multi','dual','bilingual','multiaudio');
      -- HU is a deliberately null alias (ambiguous provider bundle), but is
      -- still a recognized annotation token, matching the JavaScript alias map.
      if public.catalog_provider_language_alias(lower_token) is null and lower_token <> 'hu'
        and lower_token !~ '^(sub|subs|subt|subbed|subtitle|subtitles|st|subtitled|vost\w*|sub(fr|en|es|ar|de|it|pt|nl|ru|hi)|dub|dubbed|dublado|doblado|doublage|multi|dual|bilingual|multiaudio|audio|in|4k|8k|sd|hd|fhd|uhd|[0-9]{3,4}p)$'
      then annotation_only := false; end if;
    end loop;
    if (has_sub or part ~* 'sous[\s-]+titres' or part ~ 'مترجم|ترجمة|زیرنویس|زیرنویس‌دار')
      and not has_dub then return null; end if;
    -- Parentheses may contain title prose, e.g. (NE CONVIENT PAS AUX ENFANTS).
    -- They only permit language inference when every token is an annotation.
    if annotated and not annotation_only then continue; end if;
    if has_multi then return null; end if;
    foreach token in array tokens loop
      code := public.catalog_provider_language_alias(lower(token));
      if code is not null and (length(token)>3 or cardinality(tokens)=1 or (token=upper(token)
        and (annotated or part ~* ('(?:^|[|:/\[(])\s*' || token || '(?:\s*[-–—|:/\])]|\s*$)'))))
        and not code=any(tags) then tags:=array_append(tags,code); end if;
    end loop;
  end loop;
  -- A single compatible specific tag refines Nordic, never another language.
  if cardinality(tags)=2 and 'nordic'=any(tags) and tags && array['da','sv','no']::text[] then
    tags := array_remove(tags,'nordic');
  end if;
  return case when cardinality(tags)=1 then tags[1] end;
end
$f$;

revoke all on function public.catalog_provider_language_alias(text), public.catalog_provider_language(jsonb,text,text) from public,anon,authenticated;
grant execute on function public.catalog_provider_language_alias(text), public.catalog_provider_language(jsonb,text,text) to service_role;
commit;
