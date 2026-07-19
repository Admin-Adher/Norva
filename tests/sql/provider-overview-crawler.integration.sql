-- Run against a database with migrations through
-- 20260719190000_provider_overview_crawler.sql applied.
--
-- No provider request is made. A real missing-summary candidate is updated
-- inside this transaction, cache/fan-out/non-overwrite semantics are asserted,
-- then every mutation is rolled back.

begin;

create temporary table overview_test_source as
select
  source.id as source_id,
  source.user_id,
  link.identity_id
from public.cloud_sources source
join public.catalog_source_provider_identities link
  on link.source_id = source.id
 and link.user_id = source.user_id
where source.source_type = 'xtream'
  and source.sync_status = 'ready'
  and source.enabled = true
  and source.deleted_at is null
order by source.id
limit 1;

create temporary table overview_test_candidate as
select
  source.source_id,
  source.user_id,
  source.identity_id,
  candidate.*
from overview_test_source source
cross join lateral public.claim_provider_overview_candidates(
  source.user_id,
  source.source_id,
  1
) candidate;

create temporary table overview_test_catalog_before as
select
  catalog.item_type,
  catalog.provider_tmdb_id,
  catalog.metadata
from overview_test_candidate candidate
join public.cloud_titles title
  on title.id = candidate.title_id
 and title.user_id = candidate.user_id
join public.catalog_titles catalog
  on catalog.item_type = title.item_type
 and catalog.provider_tmdb_id = title.provider_tmdb_id;

do $assert$
declare
  target overview_test_candidate%rowtype;
  first_result jsonb;
  retry_result jsonb;
  sentinel text := 'Norva transactional synopsis probe ' || txid_current()::text;
begin
  select * into strict target from overview_test_candidate;

  select public.record_provider_overview_outcome(
    target.user_id,
    target.source_id,
    target.external_id,
    sentinel,
    null,
    null,
    'resolved',
    null,
    '{"test":true}'::jsonb
  ) into first_result;

  if first_result->>'outcome' <> 'resolved' then
    raise exception 'resolved provider synopsis was not accepted';
  end if;
  if coalesce((first_result->>'titles_updated')::integer, 0) < 1 then
    raise exception 'resolved synopsis did not reach its logical title';
  end if;
  if not exists (
    select 1
    from public.catalog_file_tracks cache
    where cache.server_host = target.identity_id::text
      and cache.item_type = 'movie'
      and cache.external_id = target.external_id
      and cache.overview_status = 'resolved'
      and cache.provider_overview = sentinel
  ) then
    raise exception 'canonical exact-file synopsis cache was not written';
  end if;
  if not exists (
    select 1
    from public.cloud_title_variants variant
    where variant.source_id = target.source_id
      and variant.user_id = target.user_id
      and variant.item_type = 'movie'
      and variant.external_id = target.external_id
      and variant.metadata->>'overview' = sentinel
  ) then
    raise exception 'exact owner variant did not receive the synopsis';
  end if;
  if exists (
    select 1
    from overview_test_catalog_before before
    join public.catalog_titles catalog
      on catalog.item_type = before.item_type
     and catalog.provider_tmdb_id = before.provider_tmdb_id
    where not (
      catalog.metadata @> (coalesce(before.metadata, '{}'::jsonb) - 'overview')
    )
  ) then
    raise exception 'provider fallback replaced rich global TMDB metadata';
  end if;
  if exists (
    select 1
    from public.claim_provider_overview_candidates(
      target.user_id,
      target.source_id,
      8
    ) candidate
    where candidate.external_id = target.external_id
  ) then
    raise exception 'resolved logical title remained in the overview queue';
  end if;

  -- A later transient/missing result must never erase a resolved cache entry.
  select public.record_provider_overview_outcome(
    target.user_id,
    target.source_id,
    target.external_id,
    null,
    null,
    null,
    'retry',
    now() + interval '1 hour',
    '{"test":"retry"}'::jsonb
  ) into retry_result;

  if retry_result->>'outcome' <> 'retry' then
    raise exception 'retry outcome was not recorded';
  end if;
  if not exists (
    select 1
    from public.catalog_file_tracks cache
    where cache.server_host = target.identity_id::text
      and cache.item_type = 'movie'
      and cache.external_id = target.external_id
      and cache.overview_status = 'resolved'
      and cache.provider_overview = sentinel
      and cache.overview_retry_at is null
  ) then
    raise exception 'retry outcome overwrote a resolved synopsis';
  end if;
end
$assert$;

rollback;
