begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

-- An editorial title is global; a playable file and its soundtracks are not.
-- Index only public TMDB names/translations, never a provider's raw title,
-- URL, account, preference or audio language. Keep accents/scripts intact.
create or replace function public.norva_public_title_key(p_title text)
returns text language sql immutable parallel safe security invoker set search_path = ''
as $function$
  select btrim(regexp_replace(lower(coalesce(p_title,'')), '[^[:alnum:]]+', ' ', 'g'));
$function$;

create or replace function public.norva_public_title_aliases(p_metadata jsonb)
returns text[] language sql immutable parallel safe security invoker set search_path = ''
as $function$
  select coalesce(array_agg(distinct public.norva_public_title_key(name)),array[]::text[])
  from (
    select value as name from jsonb_array_elements_text(jsonb_build_array(
      p_metadata #>> '{tmdb,title}',p_metadata #>> '{tmdb,name}',
      p_metadata #>> '{tmdb,original_title}',p_metadata #>> '{tmdb,original_name}'))
    union all
    select locale.value->>'title' from jsonb_each(case
      when jsonb_typeof(p_metadata->'i18n')='object' then p_metadata->'i18n' else '{}'::jsonb end) locale
    where locale.key ~ '^[a-z]{2}(-[A-Za-z]{2})?$'
  ) names where length(name) between 2 and 512;
$function$;

-- Read-only, service-only and bounded. This does not discover a provider file
-- identity or write a match. The caller still validates each title and commits
-- through its existing generation/payload/visibility CAS.
create or replace function public.norva_public_catalog_title_candidates(p_queries jsonb)
returns table(query_index integer,provider_tmdb_id text,metadata jsonb)
language plpgsql stable security invoker set search_path = ''
set statement_timeout = '5s'
as $function$
begin
  -- The internal credential guard itself is not executable by service_role.
  -- Preserve its exact role check inline instead of widening its ACL or
  -- elevating this public-cache-only reader to SECURITY DEFINER.
  if coalesce(nullif(auth.jwt()->>'role',''),
      nullif(current_setting('request.jwt.claim.role',true),''),
      nullif(current_setting('role',true),'none'),'') is distinct from 'service_role' then
    raise exception 'service_role required' using errcode='42501';
  end if;
  if p_queries is null or jsonb_typeof(p_queries) <> 'array' then
    raise exception 'A bounded public title batch is required' using errcode='22023';
  end if;
  if jsonb_array_length(p_queries) not between 1 and 50
    or octet_length(p_queries::text)>65536
    or exists(select 1 from jsonb_array_elements(p_queries) q where
      jsonb_typeof(q)<>'object' or coalesce(q->>'itemType','') not in('movie','series')
      or coalesce(length(q->>'title'),0) not between 2 and 512
      or (q->>'year' is not null and (q->>'year') !~ '^(19|20|21)[0-9]{2}$')
      or (q->>'posterPath' is not null and (q->>'posterPath') !~ '^/[A-Za-z0-9._-]+\.(jpg|jpeg|png|webp)$')) then
    raise exception 'Invalid public title lookup' using errcode='22023';
  end if;
  return query
  with requests as materialized (
    select (ordinality-1)::integer as query_index,q->>'itemType' as item_type,
      public.norva_public_title_key(q->>'title') as title_key,
      (q->>'year')::integer as release_year,q->>'posterPath' as poster_path
    from jsonb_array_elements(p_queries) with ordinality entries(q,ordinality)
  )
  select r.query_index,choice.provider_tmdb_id,jsonb_strip_nulls(jsonb_build_object(
    'tmdb',choice.metadata->'tmdb','i18n',choice.metadata->'i18n',
    'tmdbValidation',choice.metadata->'tmdbValidation'))
  from requests r
  cross join lateral (
    -- Two candidates suffice to veto ambiguity, without materializing every
    -- homonym or returning a truncated set as if it were unambiguous.
    select candidate.*,count(*) over() as candidate_count from (
      select c.provider_tmdb_id,c.metadata
      from public.catalog_titles c
      where c.item_type=r.item_type
        and c.metadata #>> '{tmdbValidation,valid}'='true'
        and c.provider_tmdb_id ~ '^[1-9][0-9]*$'
        and c.metadata #>> '{tmdb,id}'=c.provider_tmdb_id
        and public.norva_public_title_aliases(c.metadata) @> array[r.title_key]
        and length(r.title_key)>=2
        and (r.release_year is null or c.release_year is null or abs(c.release_year-r.release_year)<=1)
        and ((r.release_year is not null and c.release_year is not null and abs(c.release_year-r.release_year)<=1)
          or (r.poster_path is not null and c.metadata #>> '{tmdb,poster_path}'=r.poster_path))
      limit 2
    ) candidate
  ) choice
  where choice.candidate_count=1;
end;
$function$;

revoke all on function public.norva_public_title_key(text),public.norva_public_title_aliases(jsonb),
  public.norva_public_catalog_title_candidates(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.norva_public_title_key(text),public.norva_public_title_aliases(jsonb),
  public.norva_public_catalog_title_candidates(jsonb) to service_role;
comment on function public.norva_public_catalog_title_candidates(jsonb) is
  'Bounded unique public TMDB title/translation reuse with year or artwork corroboration; never file or audio evidence.';

-- A failed validation belongs to one provider filename, not to the global
-- TMDB entity. A blob containing a `tmdb` object alone is not validation and
-- must not erase another account's validated public cache or translations.
create or replace function public.catalog_titles_keep_best()
returns trigger language plpgsql security invoker set search_path=''
as $function$
declare new_enriched boolean; old_enriched boolean; old_valid boolean; new_valid boolean;
begin
  if new.release_year is not null and (new.release_year<1900 or new.release_year>extract(year from now())::integer+1) then
    new.release_year:=null;
  end if;
  if tg_op='INSERT' then return new; end if;
  new_enriched:=coalesce(jsonb_typeof(new.metadata->'tmdb')='object',false);
  old_enriched:=coalesce(jsonb_typeof(old.metadata->'tmdb')='object',false);
  old_valid:=coalesce(old.metadata #>> '{tmdbValidation,valid}'='true'
    and old.metadata #>> '{tmdb,id}'=old.provider_tmdb_id,false);
  new_valid:=coalesce(new.metadata #>> '{tmdbValidation,valid}'='true'
    and new.metadata #>> '{tmdb,id}'=new.provider_tmdb_id,false);
  if not new_enriched or (old_valid and not new_valid) then
    if old_enriched or old.metadata<>'{}'::jsonb then new.metadata:=old.metadata; end if;
    new.title:=coalesce(old.title,new.title);
    new.original_title:=coalesce(old.original_title,new.original_title);
    new.release_year:=coalesce(old.release_year,new.release_year);
    new.poster_url:=coalesce(old.poster_url,new.poster_url);
    new.backdrop_url:=coalesce(old.backdrop_url,new.backdrop_url);
  elsif old_valid and new_valid and new.metadata is distinct from old.metadata
      and jsonb_typeof(old.metadata->'i18n')='object' then
    new.metadata:=jsonb_set(new.metadata,'{i18n}',(old.metadata->'i18n') ||
      case when jsonb_typeof(new.metadata->'i18n')='object' then new.metadata->'i18n' else '{}'::jsonb end);
  end if;
  new.updated_at:=greatest(coalesce(new.updated_at,old.updated_at),old.updated_at);
  new.enriched_at:=greatest(coalesce(new.enriched_at,old.enriched_at),old.enriched_at);
  return new;
end;
$function$;
revoke all on function public.catalog_titles_keep_best() from public,anon,authenticated;
commit;
