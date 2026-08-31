-- Repair false "audio probed" negatives created when the bounded relay parser
-- returned no stream map. A movie probe is authoritative only when at least one
-- exact audio stream index exists. Subtitle evidence is retained independently.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '15min';

create temporary table norva_poisoned_movie_audio_cache
on commit drop
as
select
  cache.server_host,
  cache.item_type,
  cache.external_id
from public.catalog_file_tracks cache
where cache.item_type = 'movie'
  and cache.audio_probed_at is not null
  and jsonb_typeof(cache.audio_tracks) = 'array'
  and jsonb_array_length(cache.audio_tracks) = 0;

create unique index norva_poisoned_movie_audio_cache_pk
  on norva_poisoned_movie_audio_cache(server_host, item_type, external_id);

-- Resolve every currently visible tenant variant backed by one of those
-- canonical files before the cache timestamp is cleared. Do not depend on an
-- existing observation row: a previous cache upsert may have succeeded while
-- its fan-out failed, and that exact file must still wake its source lane. The
-- source-local fallback is tenant-specific; only a verified provider identity
-- enables cross-user reuse.
create temporary table norva_poisoned_movie_audio_owners
on commit drop
as
select distinct
  variant.user_id,
  variant.title_id,
  variant.id as variant_id,
  variant.external_id as file_external_id,
  variant.source_id,
  variant.item_type
from public.cloud_title_variants variant
join public.cloud_catalog_visible_sources source
  on source.id = variant.source_id
 and source.user_id = variant.user_id
left join public.catalog_source_provider_identities identity
  on identity.source_id = variant.source_id
 and identity.user_id = variant.user_id
join norva_poisoned_movie_audio_cache poisoned
  on poisoned.server_host = coalesce(
       identity.identity_id::text,
       'source:' || variant.source_id::text
     )
 and poisoned.item_type = variant.item_type
 and poisoned.external_id = variant.external_id
where variant.item_type = 'movie';

create unique index norva_poisoned_movie_audio_owners_pk
  on norva_poisoned_movie_audio_owners(user_id, variant_id, file_external_id);

update public.catalog_file_tracks cache
set audio_probed_at = null,
    audio_whisper_attempted_at = null,
    audio_whisper_retry_at = null,
    audio_whisper_verification = '{}'::jsonb,
    audio_lang_verified_at = null,
    audio_lang_retry_at = null,
    audio_lang_verification = '{}'::jsonb,
    updated_at = clock_timestamp()
from norva_poisoned_movie_audio_cache poisoned
where cache.server_host = poisoned.server_host
  and cache.item_type = poisoned.item_type
  and cache.external_id = poisoned.external_id;

update public.cloud_title_file_language_observations observation
set audio_languages = '{}'::text[],
    audio_observed = false,
    audio_verified_at = null,
    audio_verification = '{}'::jsonb,
    updated_at = clock_timestamp()
from norva_poisoned_movie_audio_owners poisoned
where observation.user_id = poisoned.user_id
  and observation.variant_id = poisoned.variant_id
  and observation.file_external_id = poisoned.file_external_id;

update public.cloud_title_variants variant
set audio_whisper_attempted_at = null,
    audio_whisper_retry_at = null,
    audio_lang_verified_at = null,
    audio_lang_verify_retry_at = null
from norva_poisoned_movie_audio_owners poisoned
where variant.user_id = poisoned.user_id
  and variant.id = poisoned.variant_id;

-- Legacy ordered maps are valid only for a true single-variant movie. Clear
-- those derived markers without touching grouped titles or any subtitle state.
update public.cloud_titles title
set audio_tracks = null,
    audio_languages = '{}'::text[],
    audio_probed_at = null,
    audio_lang_verified_at = null,
    whisper_attempted_at = null
from norva_poisoned_movie_audio_owners poisoned
where title.user_id = poisoned.user_id
  and title.id = poisoned.title_id
  and title.item_type = 'movie'
  and not exists (
    select 1
    from public.cloud_title_variants sibling
    where sibling.user_id = title.user_id
      and sibling.title_id = title.id
      and sibling.id <> poisoned.variant_id
  );

-- Rebuild exact title unions from the still-owned observations after the bad
-- audio side was made pending. Subtitle unions remain untouched by the reset.
do $repair$
declare
  affected record;
begin
  for affected in
    select distinct user_id, title_id
    from norva_poisoned_movie_audio_owners
  loop
    perform public.recompute_cloud_title_file_languages(
      affected.user_id,
      affected.title_id
    );
  end loop;
end
$repair$;

update public.cloud_catalog_facet_summary summary
set refreshed_at = 'epoch'::timestamptz
from (
  select distinct user_id, item_type
  from norva_poisoned_movie_audio_owners
) affected
where summary.user_id = affected.user_id
  and summary.item_type = affected.item_type;

-- Wake the existing dynamic fleet on its movie-probe lane. The fleet already
-- owns bounded four-file batches, concurrency=1, per-user/provider leases and
-- viewer pre-emption. Never rewrite an active claim: its current worker must be
-- allowed to finish under the dispatch lane it actually received.
update public.catalog_enrichment_source_schedule schedule
set next_run_at = least(schedule.next_run_at, clock_timestamp()),
    dispatch_count = schedule.dispatch_count - mod(schedule.dispatch_count, 12),
    cycle_had_work = false,
    updated_at = clock_timestamp()
from (
  select distinct user_id, source_id
  from norva_poisoned_movie_audio_owners
) affected
where schedule.user_id = affected.user_id
  and schedule.source_id = affected.source_id
  and (
    schedule.lease_until is null
    or schedule.lease_until <= clock_timestamp()
  );

-- A previously dry movie-probe lane is memoized for 30 minutes. The underlying
-- candidate set has just changed, so that negative memo is no longer valid.
delete from public.enrichment_exhausted exhausted
using (
  select distinct user_id, source_id
  from norva_poisoned_movie_audio_owners
) affected
where exhausted.k =
  affected.user_id::text || ':' || affected.source_id::text || ':movie:probe';

-- Database boundary: even a future buggy Edge caller cannot stamp an empty
-- movie audio map as observed. Unknown-language tracks remain valid because
-- their ordered map is non-empty even when every lang value is null.
alter table public.catalog_file_tracks
  drop constraint if exists catalog_file_tracks_movie_audio_probe_nonempty_ck;
alter table public.catalog_file_tracks
  add constraint catalog_file_tracks_movie_audio_probe_nonempty_ck
  check (
    item_type <> 'movie'
    or audio_probed_at is null
    or (
      jsonb_typeof(audio_tracks) = 'array'
      and jsonb_array_length(audio_tracks) > 0
    )
  ) not valid;
alter table public.catalog_file_tracks
  validate constraint catalog_file_tracks_movie_audio_probe_nonempty_ck;

-- The automatic bounded backfill already serializes exact-file probes per
-- provider identity. Put MULTI files at the front of each source lane after the
-- reset so the user-visible gaps converge first.
create or replace function public.file_audio_backfill_candidates(
  p_user uuid,
  p_source uuid default null,
  p_item_type text default 'movie',
  p_target text default 'audio',
  p_require_tags text[] default null,
  p_untagged_only boolean default false,
  p_limit integer default 25
) returns table(id uuid, default_variant_id uuid, provider_tmdb_id text)
language sql
stable
security definer
set search_path = ''
as $function$
  select
    title.id,
    variant.id as default_variant_id,
    title.provider_tmdb_id
  from public.cloud_title_variants variant
  join public.cloud_catalog_visible_sources source
    on source.id = variant.source_id
   and source.user_id = variant.user_id
  join public.cloud_titles title
    on title.id = variant.title_id
   and title.user_id = variant.user_id
   and title.item_type = variant.item_type
  left join public.cloud_title_file_language_observations observation
    on observation.user_id = variant.user_id
   and observation.title_id = variant.title_id
   and observation.variant_id = variant.id
   and observation.file_external_id = variant.external_id
  where p_item_type = 'movie'
    and variant.item_type = 'movie'
    and variant.user_id = p_user
    and variant.title_id is not null
    and coalesce(btrim(variant.external_id), '') <> ''
    and (p_source is null or variant.source_id = p_source)
    and (
      case when p_target = 'subtitle'
        then not coalesce(observation.subtitle_observed, false)
        else not coalesce(observation.audio_observed, false)
          or observation.updated_at < now() - interval '180 days'
      end
    )
    and (not coalesce(p_untagged_only, false) or title.version_languages = '{}'::text[])
    and (
      p_require_tags is null
      or coalesce(cardinality(p_require_tags), 0) = 0
      or title.version_languages && p_require_tags
    )
  order by
    case when title.version_languages @> array['multi']::text[] then 0 else 1 end,
    title.release_year desc nulls last,
    title.id,
    variant.id
  limit greatest(1, least(300, coalesce(p_limit, 25)))
$function$;

revoke all on function public.file_audio_backfill_candidates(
  uuid, uuid, text, text, text[], boolean, integer
) from public, anon, authenticated;
grant execute on function public.file_audio_backfill_candidates(
  uuid, uuid, text, text, text[], boolean, integer
) to service_role;

do $verify$
begin
  if exists (
    select 1
    from public.catalog_file_tracks cache
    where cache.item_type = 'movie'
      and cache.audio_probed_at is not null
      and jsonb_typeof(cache.audio_tracks) = 'array'
      and jsonb_array_length(cache.audio_tracks) = 0
  ) then
    raise exception 'Empty movie audio probes remain after repair';
  end if;

  if exists (
    select 1
    from public.cloud_title_file_language_observations observation
    join norva_poisoned_movie_audio_owners poisoned
      on poisoned.user_id = observation.user_id
     and poisoned.variant_id = observation.variant_id
     and poisoned.file_external_id = observation.file_external_id
    where observation.audio_observed
  ) then
    raise exception 'Poisoned tenant audio observations remain after repair';
  end if;
end
$verify$;

commit;
