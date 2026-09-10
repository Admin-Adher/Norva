begin;
set local lock_timeout = '3s';
set local statement_timeout = '20s';

-- Add the 19 real stream tags missed in the all-provider audit. This changes
-- parsing only: it never guesses audio from titles, copies peer languages by
-- TMDB id, or scans/reconciles the complete catalogue during deployment.
-- Reference: https://www.loc.gov/standards/iso639-2/php/code_list.php
-- `scr` is the historical bibliographic code for Croatian.
create or replace function public.norva_canonical_language_code(p_value text)
returns text
language sql
immutable
strict
parallel safe
set search_path = pg_catalog
as $function$
  select case raw_code
    when 'afr' then 'af' when 'aze' then 'az'
    when 'glg' then 'gl' when 'guj' then 'gu'
    when 'kan' then 'kn' when 'kaz' then 'kk'
    when 'khm' then 'km' when 'kir' then 'ky'
    when 'lat' then 'la' when 'mal' then 'ml' when 'mar' then 'mr'
    when 'nep' then 'ne' when 'oci' then 'oc' when 'ori' then 'or'
    when 'pan' then 'pa' when 'scr' then 'hr' when 'tgl' then 'tl'
    when 'yor' then 'yo' when 'zul' then 'zu'
    when 'alb' then 'sq' when 'sqi' then 'sq'
    when 'ara' then 'ar'
    when 'arm' then 'hy' when 'hye' then 'hy'
    when 'baq' then 'eu' when 'eus' then 'eu'
    when 'ben' then 'bn' when 'bos' then 'bs' when 'bul' then 'bg'
    when 'bur' then 'my' when 'mya' then 'my' when 'cat' then 'ca'
    when 'chi' then 'zh' when 'zho' then 'zh'
    when 'cze' then 'cs' when 'ces' then 'cs' when 'dan' then 'da'
    when 'dut' then 'nl' when 'nld' then 'nl'
    when 'eng' then 'en' when 'est' then 'et' when 'fil' then 'tl'
    when 'fin' then 'fi' when 'fre' then 'fr' when 'fra' then 'fr'
    when 'geo' then 'ka' when 'kat' then 'ka'
    when 'ger' then 'de' when 'deu' then 'de'
    when 'gre' then 'el' when 'ell' then 'el'
    when 'heb' then 'he' when 'hin' then 'hi' when 'hrv' then 'hr'
    when 'hun' then 'hu' when 'ice' then 'is' when 'isl' then 'is'
    when 'ind' then 'id' when 'ita' then 'it' when 'jpn' then 'ja'
    when 'kor' then 'ko' when 'lav' then 'lv' when 'lit' then 'lt'
    when 'mac' then 'mk' when 'mkd' then 'mk'
    when 'may' then 'ms' when 'msa' then 'ms'
    when 'nob' then 'no' when 'nor' then 'no'
    when 'per' then 'fa' when 'fas' then 'fa'
    when 'pol' then 'pl' when 'por' then 'pt'
    when 'rum' then 'ro' when 'ron' then 'ro' when 'rus' then 'ru'
    when 'slo' then 'sk' when 'slk' then 'sk' when 'slv' then 'sl'
    when 'spa' then 'es' when 'srp' then 'sr' when 'swe' then 'sv'
    when 'tam' then 'ta' when 'tel' then 'te' when 'tha' then 'th'
    when 'tur' then 'tr' when 'ukr' then 'uk' when 'urd' then 'ur'
    when 'vie' then 'vi'
    when 'iw' then 'he' when 'in' then 'id' when 'ji' then 'yi'
    when 'jw' then 'jv' when 'mo' then 'ro' when 'sh' then 'sr'
    when 'un' then null when 'und' then null when 'mis' then null
    when 'mul' then null when 'zxx' then null when 'nar' then null
    else case when raw_code ~ '^[a-z]{2}$' then raw_code else null end
  end
  from (
    select lower(btrim(split_part(replace(p_value, '_', '-'), '-', 1))) as raw_code
  ) normalized
$function$;

revoke all on function public.norva_canonical_language_code(text)
  from public, anon, authenticated;
grant execute on function public.norva_canonical_language_code(text) to service_role;

commit;
