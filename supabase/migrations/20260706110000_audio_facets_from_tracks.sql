-- Audio facets must reflect the USER'S real file, not a global optimistic inheritance.
--
-- Bug: cloud_titles.audio_languages is filled from the global catalog_titles cache by TMDB id
-- (fill_user_audio_for_titles) — so a title inherits "fr" because SOME user on the platform had a
-- French copy, even when THIS user's file has no French track. Result: the French audio filter
-- surfaced ~8,158 titles when only ~2,549 actually have a detected French audio stream.
--
-- Fix: drive audio facets + filtering from cloud_titles.audio_tracks ([{lang,index},…]) — the real
-- per-stream ffprobe probe of the user's own file — exactly like subtitles use subtitle_tracks.
-- Strict + coherent: the menu count equals the grid results, with zero false positives.

-- GIN index so the grid filter (audio_tracks @> [{"lang":"xx"}]) is an index lookup, not a seq scan.
create index if not exists cloud_titles_audio_tracks_gin
  on public.cloud_titles using gin (audio_tracks jsonb_path_ops);

create or replace function public.cloud_refresh_facet_summary(p_user_id uuid, p_item_type text)
returns void
language plpgsql
set search_path to 'public'
as $function$
declare
  v_counts jsonb;
  v_audio text[];
  v_version text[];
  v_audio_counts jsonb;
  v_sub_counts jsonb;
begin
  select coalesce(jsonb_object_agg(bucket, n), '{}'::jsonb) into v_counts
  from (
    select b as bucket, count(*)::bigint as n
    from public.cloud_titles t
         cross join lateral unnest(coalesce(t.genre_buckets, array['autres'])) as b
    where t.user_id = p_user_id and t.item_type = p_item_type and t.variant_count > 0 and b <> 'autres'
    group by b
  ) g;

  -- Audio: real detected streams (audio_tracks[].lang), NOT the inherited audio_languages aggregate.
  select coalesce(jsonb_object_agg(lang, n), '{}'::jsonb), coalesce(array_agg(lang order by lang), '{}')
  into v_audio_counts, v_audio
  from (
    select lower(atr->>'lang') as lang, count(distinct t.id)::bigint as n
    from public.cloud_titles t
         cross join lateral jsonb_array_elements(case when jsonb_typeof(t.audio_tracks) = 'array' then t.audio_tracks else '[]'::jsonb end) as atr
    where t.user_id = p_user_id and t.item_type = p_item_type and t.variant_count > 0
      and lower(atr->>'lang') ~ '^[a-z]{2,3}$'
      and lower(atr->>'lang') not in ('un','und','mul','zxx','mis','nar')
    group by lower(atr->>'lang')
  ) a;

  select coalesce(array_agg(distinct lower(v.val)), '{}') into v_version
  from public.cloud_titles t
       cross join lateral unnest(coalesce(t.version_languages, '{}')) as v(val)
  where t.user_id = p_user_id and t.item_type = p_item_type and t.variant_count > 0 and v.val is not null;

  -- Subtitles: real detected soft-sub streams (subtitle_tracks[].lang).
  select coalesce(jsonb_object_agg(lang, n), '{}'::jsonb) into v_sub_counts
  from (
    select lower(st->>'lang') as lang, count(distinct t.id)::bigint as n
    from public.cloud_titles t
         cross join lateral jsonb_array_elements(case when jsonb_typeof(t.subtitle_tracks) = 'array' then t.subtitle_tracks else '[]'::jsonb end) as st
    where t.user_id = p_user_id and t.item_type = p_item_type and t.variant_count > 0
      and lower(st->>'lang') ~ '^[a-z]{2,3}$'
      and lower(st->>'lang') not in ('un','und','mul','zxx','mis','nar')
    group by lower(st->>'lang')
  ) s;

  insert into public.cloud_catalog_facet_summary (
    user_id, item_type, genre_bucket_counts, audio_langs, version_tags,
    audio_lang_counts, subtitle_lang_counts, refreshed_at
  )
  values (
    p_user_id, p_item_type, v_counts, coalesce(v_audio, '{}'), coalesce(v_version, '{}'),
    coalesce(v_audio_counts, '{}'::jsonb), coalesce(v_sub_counts, '{}'::jsonb), now()
  )
  on conflict (user_id, item_type) do update set
    genre_bucket_counts = excluded.genre_bucket_counts,
    audio_langs = excluded.audio_langs,
    version_tags = excluded.version_tags,
    audio_lang_counts = excluded.audio_lang_counts,
    subtitle_lang_counts = excluded.subtitle_lang_counts,
    refreshed_at = excluded.refreshed_at;
end
$function$;

create or replace function public.cloud_language_facets(p_user_id uuid, p_item_type text)
returns jsonb
language plpgsql
stable
set search_path to 'public'
as $function$
declare
  v_audio_counts jsonb;
  v_sub_counts jsonb;
  v_audio_out jsonb;
  v_sub_out jsonb;
  lang_names jsonb := '{
    "aa":"Afar","ab":"Abkhazian","af":"Afrikaans","ak":"Akan","am":"Amharic","ar":"Arabic","as":"Assamese","ay":"Aymara","az":"Azerbaijani",
    "ba":"Bashkir","be":"Belarusian","bg":"Bulgarian","bh":"Bihari","bi":"Bislama","bn":"Bengali","bo":"Tibetan","br":"Breton","bs":"Bosnian",
    "ca":"Catalan","ce":"Chechen","co":"Corsican","cs":"Czech","cu":"Church Slavic","cv":"Chuvash","cy":"Welsh",
    "da":"Danish","de":"German","dv":"Divehi","dz":"Dzongkha","ee":"Ewe","el":"Greek","en":"English","eo":"Esperanto","es":"Spanish","et":"Estonian","eu":"Basque",
    "fa":"Persian","ff":"Fulah","fi":"Finnish","fj":"Fijian","fo":"Faroese","fr":"French","fy":"Western Frisian",
    "ga":"Irish","gd":"Scottish Gaelic","gl":"Galician","gn":"Guarani","gu":"Gujarati","gv":"Manx",
    "ha":"Hausa","he":"Hebrew","hi":"Hindi","ho":"Hiri Motu","hr":"Croatian","ht":"Haitian Creole","hu":"Hungarian","hy":"Armenian","hz":"Herero",
    "ia":"Interlingua","id":"Indonesian","ie":"Interlingue","ig":"Igbo","ii":"Sichuan Yi","ik":"Inupiaq","io":"Ido","is":"Icelandic","it":"Italian","iu":"Inuktitut",
    "ja":"Japanese","jv":"Javanese","ka":"Georgian","kg":"Kongo","ki":"Kikuyu","kj":"Kuanyama","kk":"Kazakh","kl":"Kalaallisut","km":"Khmer","kn":"Kannada","ko":"Korean","kr":"Kanuri","ks":"Kashmiri","ku":"Kurdish","kv":"Komi","kw":"Cornish","ky":"Kyrgyz",
    "la":"Latin","lb":"Luxembourgish","lg":"Ganda","li":"Limburgish","ln":"Lingala","lo":"Lao","lt":"Lithuanian","lu":"Luba-Katanga","lv":"Latvian",
    "mg":"Malagasy","mh":"Marshallese","mi":"Maori","mk":"Macedonian","ml":"Malayalam","mn":"Mongolian","mr":"Marathi","ms":"Malay","mt":"Maltese","my":"Burmese",
    "na":"Nauru","nb":"Norwegian Bokmal","nd":"North Ndebele","ne":"Nepali","ng":"Ndonga","nl":"Dutch","nn":"Norwegian Nynorsk","no":"Norwegian","nr":"South Ndebele","nv":"Navajo","ny":"Nyanja",
    "oc":"Occitan","oj":"Ojibwa","om":"Oromo","or":"Odia","os":"Ossetian","pa":"Punjabi","pi":"Pali","pl":"Polish","ps":"Pashto","pt":"Portuguese",
    "qu":"Quechua","rm":"Romansh","rn":"Rundi","ro":"Romanian","ru":"Russian","rw":"Kinyarwanda",
    "sa":"Sanskrit","sc":"Sardinian","sd":"Sindhi","se":"Northern Sami","sg":"Sango","si":"Sinhala","sk":"Slovak","sl":"Slovenian","sm":"Samoan","sn":"Shona","so":"Somali","sq":"Albanian","sr":"Serbian","ss":"Swati","st":"Southern Sotho","su":"Sundanese","sv":"Swedish","sw":"Swahili",
    "ta":"Tamil","te":"Telugu","tg":"Tajik","th":"Thai","ti":"Tigrinya","tk":"Turkmen","tl":"Tagalog","tn":"Tswana","to":"Tongan","tr":"Turkish","ts":"Tsonga","tt":"Tatar","tw":"Twi","ty":"Tahitian",
    "ug":"Uyghur","uk":"Ukrainian","ur":"Urdu","uz":"Uzbek","ve":"Venda","vi":"Vietnamese","vo":"Volapuk","wa":"Walloon","wo":"Wolof","xh":"Xhosa","yi":"Yiddish","yo":"Yoruba","za":"Zhuang","zh":"Chinese","zu":"Zulu",
    "iw":"Hebrew","in":"Indonesian","ji":"Yiddish","jw":"Javanese","mo":"Moldavian","sh":"Serbo-Croatian",
    "alb":"Albanian","ara":"Arabic","arm":"Armenian","baq":"Basque","ben":"Bengali","bos":"Bosnian","bul":"Bulgarian","cat":"Catalan","chi":"Chinese","cze":"Czech","dan":"Danish","dut":"Dutch","eng":"English","est":"Estonian","fas":"Persian","fin":"Finnish","fre":"French","ger":"German","gre":"Greek","heb":"Hebrew","hin":"Hindi","hrv":"Croatian","hun":"Hungarian","ice":"Icelandic","ind":"Indonesian","ita":"Italian","jpn":"Japanese","kor":"Korean","mac":"Macedonian","mal":"Malayalam","may":"Malay","nor":"Norwegian","per":"Persian","pol":"Polish","por":"Portuguese","rum":"Romanian","rus":"Russian","slk":"Slovak","spa":"Spanish","srp":"Serbian","swe":"Swedish","tam":"Tamil","tel":"Telugu","tha":"Thai","tur":"Turkish","ukr":"Ukrainian","urd":"Urdu","vie":"Vietnamese"
  }'::jsonb;
begin
  select s.audio_lang_counts, s.subtitle_lang_counts into v_audio_counts, v_sub_counts
  from public.cloud_catalog_facet_summary s
  where s.user_id = p_user_id and s.item_type = p_item_type;

  if not found then
    select coalesce(jsonb_object_agg(lang, n), '{}'::jsonb) into v_audio_counts
    from (
      select lower(atr->>'lang') as lang, count(distinct t.id)::bigint as n
      from public.cloud_titles t
           cross join lateral jsonb_array_elements(case when jsonb_typeof(t.audio_tracks) = 'array' then t.audio_tracks else '[]'::jsonb end) as atr
      where t.user_id = p_user_id and t.item_type = p_item_type and t.variant_count > 0
        and lower(atr->>'lang') ~ '^[a-z]{2,3}$'
        and lower(atr->>'lang') not in ('un','und','mul','zxx','mis','nar')
      group by lower(atr->>'lang')
    ) live_audio;

    select coalesce(jsonb_object_agg(lang, n), '{}'::jsonb) into v_sub_counts
    from (
      select lower(st->>'lang') as lang, count(distinct t.id)::bigint as n
      from public.cloud_titles t
           cross join lateral jsonb_array_elements(case when jsonb_typeof(t.subtitle_tracks) = 'array' then t.subtitle_tracks else '[]'::jsonb end) as st
      where t.user_id = p_user_id and t.item_type = p_item_type and t.variant_count > 0
        and lower(st->>'lang') ~ '^[a-z]{2,3}$'
        and lower(st->>'lang') not in ('un','und','mul','zxx','mis','nar')
      group by lower(st->>'lang')
    ) live_sub;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'value', code,
    'label', coalesce(lang_names->>code, upper(code)) || ' · ' || trim(to_char(n, 'FM999G999G999')),
    'count', n
  ) order by n desc, coalesce(lang_names->>code, code), code), '[]'::jsonb)
  into v_audio_out
  from (
    select key as code, greatest(0, value::text::bigint) as n
    from jsonb_each(coalesce(v_audio_counts, '{}'::jsonb))
    where key ~ '^[a-z]{2,3}$' and key not in ('un','und','mul','zxx','mis','nar') and value::text::bigint > 0
  ) a;

  select coalesce(jsonb_agg(jsonb_build_object(
    'value', code,
    'label', coalesce(lang_names->>code, upper(code)) || ' · ' || trim(to_char(n, 'FM999G999G999')),
    'count', n
  ) order by n desc, coalesce(lang_names->>code, code), code), '[]'::jsonb)
  into v_sub_out
  from (
    select key as code, greatest(0, value::text::bigint) as n
    from jsonb_each(coalesce(v_sub_counts, '{}'::jsonb))
    where key ~ '^[a-z]{2,3}$' and key not in ('un','und','mul','zxx','mis','nar') and value::text::bigint > 0
  ) s;

  return jsonb_build_object('audio', v_audio_out, 'subtitles', v_sub_out);
end
$function$;

revoke all on function public.cloud_language_facets(uuid, text) from public, anon, authenticated;
grant execute on function public.cloud_language_facets(uuid, text) to service_role;

-- Recompute existing summaries with the corrected audio source.
do $function$
begin
  update public.cloud_catalog_facet_summary set refreshed_at = 'epoch';
  perform public.cloud_refresh_all_facet_summaries(1000);
end
$function$;
