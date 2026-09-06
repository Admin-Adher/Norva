begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

-- Provider refresh payloads contain raw titles, not a new TMDB validation.
-- Preserve only validated public editorial metadata for the same identity.
-- Never retain tracks, languages, playback URLs, or another owner's payload.
create or replace function public.norva_preserve_catalog_tmdb_enrichment()
returns trigger language plpgsql security invoker set search_path = ''
as $function$
declare
  prior jsonb;
  prior_metadata jsonb;
  incoming_metadata jsonb;
  merged_metadata jsonb;
  is_projection boolean := tg_table_name = 'cloud_source_catalog_generation_candidate_titles';
begin
  incoming_metadata := case when is_projection then to_jsonb(new)->'catalog_metadata' else new.metadata end;
  if tg_op = 'UPDATE' then
    if new.user_id is distinct from old.user_id or new.item_type is distinct from old.item_type
       or new.identity_key is distinct from old.identity_key then return new; end if;
    prior := to_jsonb(old);
    prior_metadata := case when is_projection then prior->'catalog_metadata' else prior->'metadata' end;
  elsif is_projection then
    -- A replacement generation may reuse the same owner's currently displayed
    -- title, without mutating that active generation or changing identity keys.
    select to_jsonb(payload),payload.catalog_metadata into prior,prior_metadata
    from public.cloud_source_catalog_heads head
    join public.cloud_source_catalog_generation_candidate_titles payload
      on payload.generation_id=head.active_generation_id and payload.user_id=head.user_id
     and payload.title_id=new.title_id
    where head.user_id=new.user_id and payload.item_type=new.item_type
      and payload.identity_key=new.identity_key
      and public.norva_source_catalog_visible_internal(head.source_id,head.user_id)
    order by head.source_id limit 1;
    if prior is null then
      select to_jsonb(title),title.metadata into prior,prior_metadata
      from public.cloud_titles title where title.id=new.title_id and title.user_id=new.user_id
        and title.item_type=new.item_type and title.identity_key=new.identity_key;
    end if;
  end if;
  -- A provider refresh cannot undo an editorial rejection for the same
  -- owner and catalogue identity. A supplied review object explicitly replaces
  -- the prior review; no tracks, URLs or provider credentials are retained.
  if not coalesce(incoming_metadata, '{}'::jsonb) ? 'tmdbSearchReview'
     and jsonb_typeof(prior_metadata #> '{tmdbSearchReview,rejectedTmdbIds}') = 'array' then
    incoming_metadata := coalesce(incoming_metadata, '{}'::jsonb) || jsonb_build_object(
      'tmdbSearchReview', jsonb_build_object('rejectedTmdbIds',
        prior_metadata #> '{tmdbSearchReview,rejectedTmdbIds}'));
    if is_projection then new.catalog_metadata := incoming_metadata;
    else new.metadata := incoming_metadata; end if;
  end if;
  -- An explicit validation (including invalidation) remains authoritative.
  if incoming_metadata ? 'tmdbValidation' then return new; end if;
  -- Verified G rows may have had their public TMDB payload thinned into the
  -- shared cache. The row's verified identity is still required before reuse.
  if not is_projection and prior->>'match_status' in ('provider_verified','matched')
     and prior_metadata #>> '{tmdbValidation,valid}' is null
     and nullif(prior->>'provider_tmdb_id','') is not null then
    select catalog.metadata into prior_metadata from public.catalog_titles catalog
    where catalog.item_type=new.item_type and catalog.provider_tmdb_id=prior->>'provider_tmdb_id'
      and catalog.metadata #>> '{tmdbValidation,valid}'='true';
  end if;
  if prior_metadata #>> '{tmdbValidation,valid}' is distinct from 'true'
     or nullif(prior->>'provider_tmdb_id','') is null
     or prior->>'provider_tmdb_id' ~ '^(tt)?0+$'
     or (nullif(new.provider_tmdb_id,'') is not null
       and new.provider_tmdb_id is distinct from prior->>'provider_tmdb_id') then return new; end if;
  merged_metadata := coalesce(incoming_metadata,'{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
    'tmdb',prior_metadata->'tmdb','i18n',prior_metadata->'i18n',
    'tmdbValidation',prior_metadata->'tmdbValidation','searchMatchedAt',prior_metadata->'searchMatchedAt'
  ));
  new.provider_tmdb_id := prior->>'provider_tmdb_id';
  new.match_status := prior->>'match_status';
  new.title := coalesce(nullif(prior->>'title',''),new.title);
  new.release_year := coalesce((prior->>'release_year')::integer,new.release_year);
  new.poster_url := coalesce(nullif(prior->>'poster_url',''),new.poster_url);
  new.backdrop_url := coalesce(nullif(prior->>'backdrop_url',''),new.backdrop_url);
  if is_projection then
    new.catalog_metadata := merged_metadata;
    new.metadata := '{}'::jsonb;
    new.genre_payload := merged_metadata #> '{tmdb,genres}';
    new.genre_buckets := public.norva_classify_buckets(new.genre_category,new.genre_payload);
    new.rating_num := public.safe_numeric(merged_metadata #>> '{tmdb,vote_average}');
  else
    new.metadata := merged_metadata;
  end if;
  return new;
end
$function$;
revoke all on function public.norva_preserve_catalog_tmdb_enrichment() from public,anon,authenticated;

commit;
