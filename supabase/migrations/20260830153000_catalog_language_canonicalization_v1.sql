begin;

-- Provider manifests and media containers mix ISO-639-1, ISO-639-2/B,
-- ISO-639-2/T and a few deprecated Java locale codes. Catalogue filters use
-- one modern ISO-639-1 code so Movies and Series never expose duplicate
-- languages such as Hebrew (`he`) and legacy Hebrew (`iw`).
create or replace function public.norva_canonical_language_code(p_value text)
returns text
language sql
immutable
strict
parallel safe
set search_path = pg_catalog
as $function$
  select case raw_code
    when 'alb' then 'sq' when 'sqi' then 'sq'
    when 'ara' then 'ar'
    when 'arm' then 'hy' when 'hye' then 'hy'
    when 'baq' then 'eu' when 'eus' then 'eu'
    when 'ben' then 'bn'
    when 'bos' then 'bs'
    when 'bul' then 'bg'
    when 'bur' then 'my' when 'mya' then 'my'
    when 'cat' then 'ca'
    when 'chi' then 'zh' when 'zho' then 'zh'
    when 'cze' then 'cs' when 'ces' then 'cs'
    when 'dan' then 'da'
    when 'dut' then 'nl' when 'nld' then 'nl'
    when 'eng' then 'en'
    when 'est' then 'et'
    when 'fil' then 'tl'
    when 'fin' then 'fi'
    when 'fre' then 'fr' when 'fra' then 'fr'
    when 'geo' then 'ka' when 'kat' then 'ka'
    when 'ger' then 'de' when 'deu' then 'de'
    when 'gre' then 'el' when 'ell' then 'el'
    when 'heb' then 'he'
    when 'hin' then 'hi'
    when 'hrv' then 'hr'
    when 'hun' then 'hu'
    when 'ice' then 'is' when 'isl' then 'is'
    when 'ind' then 'id'
    when 'ita' then 'it'
    when 'jpn' then 'ja'
    when 'kor' then 'ko'
    when 'lav' then 'lv'
    when 'lit' then 'lt'
    when 'mac' then 'mk' when 'mkd' then 'mk'
    when 'may' then 'ms' when 'msa' then 'ms'
    when 'nob' then 'no' when 'nor' then 'no'
    when 'per' then 'fa' when 'fas' then 'fa'
    when 'pol' then 'pl'
    when 'por' then 'pt'
    when 'rum' then 'ro' when 'ron' then 'ro'
    when 'rus' then 'ru'
    when 'slo' then 'sk' when 'slk' then 'sk'
    when 'slv' then 'sl'
    when 'spa' then 'es'
    when 'srp' then 'sr'
    when 'swe' then 'sv'
    when 'tam' then 'ta'
    when 'tel' then 'te'
    when 'tha' then 'th'
    when 'tur' then 'tr'
    when 'ukr' then 'uk'
    when 'urd' then 'ur'
    when 'vie' then 'vi'
    -- Deprecated ISO/Java locale aliases.
    when 'iw' then 'he'
    when 'in' then 'id'
    when 'ji' then 'yi'
    when 'jw' then 'jv'
    when 'mo' then 'ro'
    when 'sh' then 'sr'
    when 'un' then null
    when 'und' then null
    when 'mis' then null
    when 'mul' then null
    when 'zxx' then null
    when 'nar' then null
    else case when raw_code ~ '^[a-z]{2}$' then raw_code else null end
  end
  from (
    select lower(btrim(split_part(replace(p_value, '_', '-'), '-', 1))) as raw_code
  ) normalized
$function$;

revoke all on function public.norva_canonical_language_code(text)
  from public, anon, authenticated;
grant execute on function public.norva_canonical_language_code(text)
  to service_role;

-- Every trusted JSON track-map write now passes through the same canonical
-- parser before exact file observations and title unions are persisted.
create or replace function public.cloud_file_track_languages(p_tracks jsonb)
returns text[]
language sql
immutable
parallel safe
set search_path = ''
as $function$
  select coalesce(array_agg(language_code order by language_code), '{}'::text[])
  from (
    select distinct public.norva_canonical_language_code(
      coalesce(track->>'lang', track->>'language')
    ) as language_code
    from jsonb_array_elements(
      case when jsonb_typeof(p_tracks) = 'array' then p_tracks else '[]'::jsonb end
    ) as tracks(track)
  ) normalized
  where language_code is not null
$function$;

revoke all on function public.cloud_file_track_languages(jsonb)
  from public, anon, authenticated;
grant execute on function public.cloud_file_track_languages(jsonb)
  to service_role;

-- Repair historical observations once. Keep the exact affected set in a temp
-- table so only their title unions and facet summaries are invalidated.
create temporary table norva_language_canonicalization_affected
on commit drop
as
select normalized.user_id,
       normalized.title_id,
       normalized.variant_id,
       normalized.file_external_id,
       normalized.audio_languages,
       normalized.subtitle_languages
from (
  select observation.user_id,
         observation.title_id,
         observation.variant_id,
         observation.file_external_id,
         observation.audio_languages as old_audio_languages,
         observation.subtitle_languages as old_subtitle_languages,
         coalesce((
           select array_agg(language_code order by language_code)
           from (
             select distinct public.norva_canonical_language_code(raw_code) as language_code
             from unnest(observation.audio_languages) raw_code
           ) audio
           where language_code is not null
         ), '{}'::text[]) as audio_languages,
         coalesce((
           select array_agg(language_code order by language_code)
           from (
             select distinct public.norva_canonical_language_code(raw_code) as language_code
             from unnest(observation.subtitle_languages) raw_code
           ) subtitles
           where language_code is not null
         ), '{}'::text[]) as subtitle_languages
  from public.cloud_title_file_language_observations observation
) normalized
where normalized.old_audio_languages is distinct from normalized.audio_languages
   or normalized.old_subtitle_languages is distinct from normalized.subtitle_languages;

update public.cloud_title_file_language_observations observation
   set audio_languages = affected.audio_languages,
       subtitle_languages = affected.subtitle_languages,
       updated_at = now()
  from norva_language_canonicalization_affected affected
 where observation.user_id = affected.user_id
   and observation.variant_id = affected.variant_id
   and observation.file_external_id = affected.file_external_id;

do $repair$
declare
  affected_title record;
begin
  for affected_title in
    select distinct user_id, title_id
    from norva_language_canonicalization_affected
    order by user_id, title_id
  loop
    perform public.recompute_cloud_title_file_languages(
      affected_title.user_id,
      affected_title.title_id
    );
  end loop;
end
$repair$;

-- A summary can have been refreshed from an old observation even if its title
-- union was already canonical. Force only affected user/type summaries onto
-- the exact canonical fallback until their regular bounded refresh runs.
update public.cloud_catalog_facet_summary summary
   set refreshed_at = 'epoch'::timestamptz
  from (
    select distinct affected.user_id, title.item_type
    from norva_language_canonicalization_affected affected
    join public.cloud_titles title
      on title.user_id = affected.user_id
     and title.id = affected.title_id
  ) changed
 where summary.user_id = changed.user_id
   and summary.item_type = changed.item_type;

notify pgrst, 'reload schema';

do $assert$
begin
  if public.norva_canonical_language_code('por-BR') is distinct from 'pt'
     or public.norva_canonical_language_code('eng') is distinct from 'en'
     or public.norva_canonical_language_code('iw') is distinct from 'he'
     or public.norva_canonical_language_code('in_ID') is distinct from 'id'
     or public.norva_canonical_language_code('und') is not null then
    raise exception 'Canonical language parser assertion failed';
  end if;

  if exists (
    select 1
    from public.cloud_title_file_language_observations observation
    cross join lateral unnest(
      observation.audio_languages || observation.subtitle_languages
    ) language_code
    where public.norva_canonical_language_code(language_code) is distinct from language_code
  ) then
    raise exception 'Legacy or non-canonical exact language observation remains';
  end if;

  if has_function_privilege('anon', 'public.norva_canonical_language_code(text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.norva_canonical_language_code(text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.norva_canonical_language_code(text)', 'EXECUTE') then
    raise exception 'Canonical language parser privileges are invalid';
  end if;
end
$assert$;

commit;
