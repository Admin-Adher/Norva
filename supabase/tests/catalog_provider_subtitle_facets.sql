begin;
set local statement_timeout='30s';

-- Behavioral parser cases, including the actual Lion labels. No provider hit.
do $test$
declare fixture record; got text[];
begin
  for fixture in select * from (values
    ('FR - No Way Up (2024) VOSTFR','',array['fr']::text[]),
    ('FR - Murder Mubarak (2024) SubFR','',array['fr']),
    ('FR - Late Night with the Devil (2024) SuBFr','',array['fr']),
    ('EN - Example','VOD - ENGLISH SUB [EN]',array['en']),
    ('EN - Example','SRS - TURKISH SERIES SUB [EN]',array['en']),
    ('AR-SUBS - Example','أفلام أجنبية',array['ar']),
    ('Example [SUB-AR]','',array['ar']),
    ('Example [English subtitles]','',array['en']),
    ('PH - Example','PH - TAGALOG SUB MOVIES',array['tl']),
    ('Example [VOSTFR]','HINDI SUBTITLES',array['fr','hi']),
    ('MULTI - Example','NETFLIX MULTISUB','{}'::text[]),
    ('FR - Example','FR | FILMS','{}'::text[]),
    ('VO - Example','TURKISH','{}'::text[]),
    ('Example','مسلسلات تركيه مترجم','{}'::text[]),
    ('The English Subtitle','FILMS','{}'::text[]),
    ('Example','NO SUBTITLES','{}'::text[]),
    ('Example [MULTI-SUBS]','','{}'::text[]),
    ('Example [SUBS]','','{}'::text[]),
    ('Example [ENGLISH AUDIO]','','{}'::text[])
    ,('Example','SUB ON','{}'::text[])
    ,('Example','SUB IN ENGLISH',array['en'])
    ,('Example [Cantonese subtitles]','',array['yue'])
  ) cases(raw_title,category,expected)
  loop
    got:=public.catalog_provider_subtitle_languages(jsonb_build_object('categoryName',fixture.category),fixture.raw_title);
    if got is distinct from fixture.expected then
      raise exception 'subtitle parser mismatch raw=% category=% expected=% got=%',fixture.raw_title,fixture.category,fixture.expected,got;
    end if;
  end loop;
  got:=public.catalog_provider_subtitle_languages('{"providerLanguageDeclarations":{"schemaVersion":1,"providerType":"xtream","evidence":"provider_declaration","declarations":[{"role":"audio","values":["fra"]},{"role":"original","values":["de"]},{"role":"unspecified","values":["nl"]},{"role":"subtitle","values":["eng","ara","pt-BR"]}]}}','');
  if got is distinct from array['ar','en','pt'] then raise exception 'explicit subtitle roles were not preserved: %',got; end if;
  got:=public.catalog_provider_subtitle_languages('{"providerLanguageDeclarations":{"schemaVersion":1,"providerType":"xtream","evidence":"provider_declaration","declarations":[{"role":"subtitle","values":["MULTI","und","unknown","https://private.invalid","not-a-language"]}]}}','');
  if got <> '{}' then raise exception 'invalid declarations acquired authority: %',got; end if;
  if has_function_privilege('authenticated','public.cloud_catalog_subtitle_language_counts(uuid,text,uuid)','EXECUTE') then
    raise exception 'subtitle facets must remain service-only';
  end if;
end
$test$;
rollback;
