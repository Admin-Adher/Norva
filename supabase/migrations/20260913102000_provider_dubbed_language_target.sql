begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

-- Display/filter hints only. No track map, language observation, certificate,
-- job, provider identity or title metadata is rewritten by this migration.
create function public.catalog_provider_dubbed_category(p_value text)
returns text language plpgsql immutable security invoker set search_path = '' as $f$
declare
  pattern text := '(^|[|:])\s*([[:alpha:]ऀ-ൿ]{4,30})\s+([[:alpha:]ऀ-ൿ]{4,30})\s+(dubbed|dub)\s*$';
  parts text[];
  original_language text;
  dubbed_language text;
begin
  parts := regexp_match(p_value,pattern,'i');
  if parts is null then return p_value; end if;
  original_language := public.catalog_provider_language_alias(lower(normalize(
    regexp_replace(normalize(parts[2],NFD),U&'[\0300-\036f]','','g'),NFC)));
  dubbed_language := public.catalog_provider_language_alias(lower(normalize(
    regexp_replace(normalize(parts[3],NFD),U&'[\0300-\036f]','','g'),NFC)));
  if original_language is null or dubbed_language is null
    or original_language='nordic' or dubbed_language='nordic' then return p_value; end if;
  return regexp_replace(p_value,pattern,'\1 \3 \4','i');
end
$f$;
revoke all on function public.catalog_provider_dubbed_category(text) from public,anon,authenticated;
grant execute on function public.catalog_provider_dubbed_category(text) to service_role;

-- Retain the installed parser, its ACL, Selection rules, subtitle/list/conflict
-- guards and all aliases. Normalize only the already bounded annotations.
do $patch$
declare definition text; anchor text := '    annotated := idx <> 2;';
begin
  definition := pg_get_functiondef('public.catalog_provider_language(jsonb,text,text)'::regprocedure);
  if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1
    or position('catalog_provider_dubbed_category' in definition)>0 then
    raise exception 'Provider language parser drifted';
  end if;
  execute replace(definition,anchor,'    part := public.catalog_provider_dubbed_category(part);'||E'\n'||anchor);
end
$patch$;
commit;
