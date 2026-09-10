begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

-- Private catalogue hints. Never update observations, track maps or verification.
create function public.catalog_provider_language_alias(p_token text)
returns text language sql immutable security invoker set search_path = '' as $f$
-- BEGIN GENERATED ALIASES
  select '{"al":"sq","alb":"sq","sq":"sq","sqi":"sq","albanian":"sq","shqip":"sq","ar":"ar","ara":"ar","arabic":"ar","arabe":"ar","العربية":"ar","fr":"fr","fra":"fr","fre":"fr","vf":"fr","vff":"fr","vfq":"fr","french":"fr","francais":"fr","truefrench":"fr","en":"en","eng":"en","english":"en","anglais":"en","de":"de","deu":"de","ger":"de","german":"de","deutsch":"de","allemand":"de","es":"es","spa":"es","spanish":"es","espanol":"es","espagnol":"es","castellano":"es","latino":"es","pt":"pt","por":"pt","portuguese":"pt","portugues":"pt","portugais":"pt","it":"it","ita":"it","italian":"it","italiano":"it","italien":"it","nl":"nl","nld":"nl","dut":"nl","dutch":"nl","nederlands":"nl","neerlandais":"nl","gr":"el","el":"el","ell":"el","gre":"el","greece":"el","greek":"el","grec":"el","ru":"ru","rus":"ru","russian":"ru","russe":"ru","русский":"ru","pl":"pl","pol":"pl","polish":"pl","polski":"pl","polonais":"pl","tr":"tr","tur":"tr","turkish":"tr","turkce":"tr","turc":"tr","hi":"hi","hin":"hi","hindi":"hi","हिन्दी":"hi","हिंदी":"hi","te":"te","tel":"te","telugu":"te","తెలుగు":"te","ta":"ta","tam":"ta","tamil":"ta","தமிழ்":"ta","ml":"ml","mal":"ml","malayalam":"ml","മലയാളം":"ml","kn":"kn","kan":"kn","kannada":"kn","ಕನ್ನಡ":"kn","bn":"bn","ben":"bn","bengali":"bn","bangla":"bn","বাংলা":"bn","mr":"mr","mar":"mr","marathi":"mr","pa":"pa","pan":"pa","punjabi":"pa","ਪੰਜਾਬੀ":"pa","gu":"gu","guj":"gu","gujarati":"gu","ur":"ur","urd":"ur","urdu":"ur","si":"si","sin":"si","sinhala":"si","ne":"ne","nep":"ne","nepali":"ne","odia":"or","oriya":"or","ja":"ja","jpn":"ja","jp":"ja","japanese":"ja","japonais":"ja","日本語":"ja","ko":"ko","kor":"ko","korean":"ko","coreen":"ko","한국어":"ko","zh":"zh","zho":"zh","chi":"zh","chinese":"zh","mandarin":"zh","中文":"zh","yue":"yue","cantonese":"yue","th":"th","tha":"th","thai":"th","vi":"vi","vie":"vi","vietnamese":"vi","id":"id","indonesian":"id","indonesia":"id","ms":"ms","msa":"ms","malay":"ms","melayu":"ms","fil":"fil","filipino":"fil","tagalog":"fil","fa":"fa","fas":"fa","per":"fa","persian":"fa","farsi":"fa","فارسی":"fa","he":"he","heb":"he","hebrew":"he","עברית":"he","kurdish":"ku","sv":"sv","swe":"sv","swedish":"sv","svenska":"sv","se":"sv","da":"da","dan":"da","danish":"da","dansk":"da","dk":"da","no":"no","nor":"no","norwegian":"no","norsk":"no","fi":"fi","fin":"fi","finnish":"fi","suomi":"fi","icelandic":"is","cs":"cs","ces":"cs","cze":"cs","czech":"cs","cz":"cs","sk":"sk","slk":"sk","slo":"sk","slovak":"sk","slovene":"sl","slovenian":"sl","ro":"ro","ron":"ro","rum":"ro","romanian":"ro","romana":"ro","hu":null,"hun":"hu","hungarian":"hu","magyar":"hu","hongrois":"hu","bg":"bg","bul":"bg","bulgarian":"bg","hr":"hr","hrv":"hr","croatian":"hr","sr":"sr","srp":"sr","serbian":"sr","bs":"bs","bos":"bs","bosnian":"bs","ukrainian":"uk","ukr":"uk","ua":"uk","lithuanian":"lt","latvian":"lv","estonian":"et","catalan":"ca","basque":"eu","galician":"gl","armenian":"hy","georgian":"ka","afrikaans":"af","swahili":"sw","zulu":"zu","yoruba":"yo","amharic":"am","so":"so","som":"so","somali":"so","somalia":"so","nordic":"nordic","scandinavian":"nordic","scandinavia":"nordic"}'::jsonb ->> p_token;
-- END GENERATED ALIASES
$f$;

create function public.catalog_provider_language(p_metadata jsonb, p_external_id text, p_raw_title text)
returns text language plpgsql immutable security invoker set search_path = '' as $f$
declare
  category text := left(regexp_replace(coalesce(nullif(p_metadata->>'categoryName',''),p_metadata->>'category_name',''), '[▎▏▍▌│┃┆┊｜•·・]', ' | ', 'g'),1000);
  raw text := left(regexp_replace(coalesce(p_raw_title,''), '[▎▏▍▌│┃┆┊｜•·・]', ' | ', 'g'),2000);
  prefix text; suffix text; without_year text; part text; token text; tokens text[];
  normalized text; code text; tags text[] := '{}'; annotated boolean; idx integer;
  selection text := public.selection_provider_audio_language(p_metadata,p_external_id);
begin
  if selection is not null then return selection; end if;
  prefix := coalesce((regexp_match(raw,'^\s*([A-Z0-9]+(?:[._/+-][A-Z0-9]+){0,4})\s*[-–—|:]\s*'))[1],
    (regexp_match(raw,'^\s*[[(]([[:alnum:]ऀ-ൿ ./+-]{2,40})[\])]\s*'))[1],'');
  without_year := btrim(regexp_replace(raw,'\s*[[(]?(?:19|20)[0-9]{2}[\])]?\s*$',''));
  suffix := coalesce((regexp_match(without_year,'[[(]([[:alnum:]ऀ-ൿ ./+-]{2,40})[\])]\s*$'))[1],
    (regexp_match(without_year,'\s[-–—|]\s*([A-Z]{2,3}|[[:alpha:]ऀ-ൿ]{4,30})\s*$'))[1],
    (regexp_match(without_year,'(?:^|\s)([[:alpha:]ऀ-ൿ]{4,30})\s+(?:dubbed|dub|audio)\s*$','i'))[1],
    (regexp_match(without_year,'\m(?:dubbed|audio)\s+(?:in\s+)?([[:alpha:]ऀ-ൿ]{4,30})\s*$','i'))[1],'');
  if raw ~* '\m(?:vost\w*|subtitles?|subbed)\M' then return null; end if;
  for idx in 1..3 loop
    part := case idx when 1 then prefix when 2 then category else suffix end;
    annotated := idx <> 2;
    normalized := normalize(regexp_replace(normalize(part,NFD),U&'[\0300-\036f]','','g'),NFC);
    tokens := array_remove(regexp_split_to_array(normalized,'[^[:alnum:]ऀ-ൿ]+'),'');
    if part ~* '\m(?:multi|dual|bilingual|multiaudio)\M' then return null; end if;
    if (part ~* '\m(?:sub|subs|subt|subbed|subtitle|subtitles|st|subtitled|vost\w*|sub(?:fr|en|es|ar|de|it|pt|nl|ru|hi))\M'
        or part ~* 'sous[\s-]+titres' or part ~ 'مترجم|ترجمة|زیرنویس|زیرنویس‌دار')
      and part !~* '\m(?:dub|dubbed|dublado|doblado|doublage)\M' then return null; end if;
    foreach token in array tokens loop
      code := public.catalog_provider_language_alias(lower(token));
      if code is not null and (length(token)>3 or cardinality(tokens)=1 or (token=upper(token)
        and (annotated or part ~* ('(?:^|[|:/\[(])\s*' || token || '(?:\s*[-–—|:/\])]|\s*$)'))))
        and not code=any(tags) then tags:=array_append(tags,code); end if;
    end loop;
  end loop;
  return case when cardinality(tags)=1 then tags[1] end;
end
$f$;
revoke all on function public.catalog_provider_language_alias(text), public.catalog_provider_language(jsonb,text,text) from public,anon,authenticated;
grant execute on function public.catalog_provider_language_alias(text), public.catalog_provider_language(jsonb,text,text) to service_role;

-- Sparse, indexed projection: parser runs on import/change, never during facets.
-- RLS + no client grants keep provenance and cross-account data internal.
create table public.cloud_catalog_provider_language_hints (
  variant_id uuid primary key references public.cloud_title_variants(id) on delete cascade,
  user_id uuid not null, title_id uuid not null, source_id uuid not null,
  item_type text not null check (item_type in ('movie','series')),
  language text not null check (language ~ '^([a-z]{2,3}|nordic)$')
);
alter table public.cloud_catalog_provider_language_hints enable row level security;
revoke all on public.cloud_catalog_provider_language_hints from public,anon,authenticated;
grant select,insert,update,delete on public.cloud_catalog_provider_language_hints to service_role;
create index cloud_catalog_provider_language_hints_scope_idx
  on public.cloud_catalog_provider_language_hints(user_id,item_type,language,source_id,title_id,variant_id);
create index cloud_catalog_provider_language_hints_source_idx
  on public.cloud_catalog_provider_language_hints(user_id,source_id,item_type,language,title_id,variant_id);

create function public.cloud_catalog_refresh_provider_language_hint()
returns trigger language plpgsql security invoker set search_path = '' as $f$
declare hint text;
begin
  if TG_OP='UPDATE' and (new.metadata,new.raw_title,new.external_id,new.user_id,new.title_id,new.source_id,new.item_type)
    is not distinct from (old.metadata,old.raw_title,old.external_id,old.user_id,old.title_id,old.source_id,old.item_type)
    then return new; end if;
  hint := case when new.item_type in ('movie','series')
    then public.catalog_provider_language(new.metadata,new.external_id,new.raw_title) end;
  if hint is null then
    delete from public.cloud_catalog_provider_language_hints where variant_id=new.id;
  else
    insert into public.cloud_catalog_provider_language_hints(variant_id,user_id,title_id,source_id,item_type,language)
    values(new.id,new.user_id,new.title_id,new.source_id,new.item_type,hint)
    on conflict(variant_id) do update set user_id=excluded.user_id,title_id=excluded.title_id,
      source_id=excluded.source_id,item_type=excluded.item_type,language=excluded.language
    where (cloud_catalog_provider_language_hints.user_id,cloud_catalog_provider_language_hints.title_id,
      cloud_catalog_provider_language_hints.source_id,cloud_catalog_provider_language_hints.item_type,cloud_catalog_provider_language_hints.language)
      is distinct from (excluded.user_id,excluded.title_id,excluded.source_id,excluded.item_type,excluded.language);
  end if;
  return new;
end
$f$;
revoke all on function public.cloud_catalog_refresh_provider_language_hint() from public,anon,authenticated;
grant execute on function public.cloud_catalog_refresh_provider_language_hint() to service_role;
create trigger cloud_catalog_provider_language_hint_insert after insert on public.cloud_title_variants
  for each row execute function public.cloud_catalog_refresh_provider_language_hint();
create trigger cloud_catalog_provider_language_hint_update after update of metadata,raw_title,external_id,user_id,title_id,source_id,item_type
  on public.cloud_title_variants for each row execute function public.cloud_catalog_refresh_provider_language_hint();

-- Explicit bounded rollout job; row share locks prevent stale backfill racing an
-- import/update/delete. This only writes the derived table, never catalogue files.
create function public.cloud_catalog_backfill_provider_language_hints(p_after uuid, p_limit integer default 2000)
returns jsonb language plpgsql security invoker set search_path = '' as $f$
declare row record; last_id uuid; scanned integer:=0; hint text;
begin
  for row in select variant.id,variant.user_id,variant.title_id,variant.source_id,variant.item_type,
      variant.metadata,variant.external_id,variant.raw_title
    from public.cloud_title_variants variant where p_after is null or variant.id>p_after
    order by variant.id limit greatest(1,least(coalesce(p_limit,2000),5000)) for share of variant
  loop
    last_id:=row.id; scanned:=scanned+1;
    hint:=case when row.item_type in ('movie','series') then public.catalog_provider_language(row.metadata,row.external_id,row.raw_title) end;
    if hint is not null then
      insert into public.cloud_catalog_provider_language_hints(variant_id,user_id,title_id,source_id,item_type,language)
      values(row.id,row.user_id,row.title_id,row.source_id,row.item_type,hint)
      on conflict(variant_id) do nothing;
    end if;
  end loop;
  return jsonb_build_object('after',last_id,'scanned',scanned);
end
$f$;
revoke all on function public.cloud_catalog_backfill_provider_language_hints(uuid,integer) from public,anon,authenticated;
grant execute on function public.cloud_catalog_backfill_provider_language_hints(uuid,integer) to service_role;

-- Both callers below use the SAME per-file effective relation. Actual observed
-- languages win. An inconclusive observation with no language is not proof of
-- silence and leaves the supplier fallback usable. Subtitle matching stays exact
-- and must co-occur on that very variant, never on a sibling file/account.
create function public.cloud_catalog_effective_audio_languages(p_user_id uuid,p_item_type text,p_source_id uuid)
returns table(title_id uuid,variant_id uuid,language text)
language sql stable security invoker set search_path = '' as $f$
  select variant.title_id,variant.id,
    case language.value when 'yue' then 'yue' else public.norva_canonical_language_code(language.value) end
  from public.cloud_title_file_language_observations observation
  join public.cloud_catalog_visible_title_variants variant
    on variant.user_id=observation.user_id and variant.title_id=observation.title_id and variant.id=observation.variant_id
      and variant.external_id=observation.file_external_id
  cross join lateral unnest(observation.audio_languages) language(value)
  where observation.user_id=p_user_id and observation.audio_observed
    and (language.value='yue' or public.norva_canonical_language_code(language.value) is not null)
    and variant.item_type=p_item_type and p_item_type in ('movie','series')
    and (p_source_id is null or variant.source_id=p_source_id)
  union all
  select variant.title_id,variant.id,case hint.language when 'fil' then 'tl' else hint.language end
  from public.cloud_catalog_provider_language_hints hint
  join public.cloud_catalog_visible_title_variants variant
    on variant.id=hint.variant_id and variant.user_id=hint.user_id and variant.title_id=hint.title_id and variant.source_id=hint.source_id
  where hint.user_id=p_user_id and hint.item_type=p_item_type and variant.item_type=p_item_type
    and p_item_type in ('movie','series') and (p_source_id is null or hint.source_id=p_source_id)
    and not exists(select 1 from public.cloud_title_file_language_observations observation
      where observation.user_id=hint.user_id and observation.title_id=hint.title_id and observation.variant_id=hint.variant_id
        and observation.file_external_id=variant.external_id
        and observation.audio_observed and cardinality(observation.audio_languages)>0)
$f$;
revoke all on function public.cloud_catalog_effective_audio_languages(uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.cloud_catalog_effective_audio_languages(uuid,text,uuid) to service_role;

create function public.cloud_catalog_audio_language_counts(p_user_id uuid,p_item_type text,p_source_id uuid)
returns jsonb language sql stable security invoker set search_path = '' as $f$
  select coalesce(jsonb_object_agg(language,count),'{}'::jsonb) from (
    select language,count(distinct title_id) as count
    from public.cloud_catalog_effective_audio_languages(p_user_id,p_item_type,p_source_id)
    group by language
  ) counts
$f$;
revoke all on function public.cloud_catalog_audio_language_counts(uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.cloud_catalog_audio_language_counts(uuid,text,uuid) to service_role;

create function public.cloud_catalog_provider_title_ids_by_source_languages(
  p_user_id uuid,p_item_type text,p_source_id uuid,p_audio_language text default null,p_subtitle_language text default null
) returns table(title_id uuid) language sql stable security invoker set search_path = '' as $f$
  with parameters as (
    select nullif(lower(btrim(p_audio_language)),'') as audio, nullif(lower(btrim(p_subtitle_language)),'') as subtitle
  ), matching as (
    -- The user-facing catalog-* filter unifies hints and observed languages.
    select effective.title_id,effective.variant_id
    from public.cloud_catalog_effective_audio_languages(p_user_id,p_item_type,p_source_id) effective,parameters p
    where p.audio ~ '^(catalog|provider)-' and effective.language=regexp_replace(p.audio,'^(catalog|provider)-','')
    union all
    -- Legacy strict ISO filters/preferences keep their observed-only semantics.
    select variant.title_id,variant.id
    from public.cloud_catalog_visible_title_variants variant,parameters p
    where variant.user_id=p_user_id and variant.item_type=p_item_type and p_item_type in ('movie','series')
      and (p_source_id is null or variant.source_id=p_source_id)
      and (p.audio is null or (p.audio !~ '^(catalog|provider)-' and exists(
        select 1 from public.cloud_title_file_language_observations observation
        where observation.user_id=variant.user_id and observation.title_id=variant.title_id
          and observation.variant_id=variant.id and observation.file_external_id=variant.external_id
          and observation.audio_observed and p.audio=any(observation.audio_languages))))
  )
  select distinct matching.title_id from matching,parameters p
  where p.subtitle is null or exists(
    select 1 from public.cloud_title_file_language_observations observation
    join public.cloud_catalog_visible_title_variants variant
      on variant.user_id=observation.user_id and variant.id=observation.variant_id and variant.external_id=observation.file_external_id
    where observation.user_id=p_user_id and observation.title_id=matching.title_id
      and observation.variant_id=matching.variant_id and observation.subtitle_observed and p.subtitle=any(observation.subtitle_languages))
$f$;
revoke all on function public.cloud_catalog_provider_title_ids_by_source_languages(uuid,text,uuid,text,text) from public,anon,authenticated;
grant execute on function public.cloud_catalog_provider_title_ids_by_source_languages(uuid,text,uuid,text,text) to service_role;

notify pgrst,'reload schema';
commit;
