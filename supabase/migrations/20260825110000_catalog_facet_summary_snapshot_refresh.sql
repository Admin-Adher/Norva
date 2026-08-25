-- Refresh global catalogue facets from the durable active owner snapshot.
--
-- The previous implementation expanded cloud_catalog_visible_titles and ran
-- norva_visible_catalog_title_runtime once per logical title.  On large
-- catalogues that is an N+1 visibility calculation and the pg_cron job reaches
-- its 300 second timeout.  The active owner snapshot already contains the
-- exact visible title/source generation set, so aggregate that set directly.

begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

create or replace function public.cloud_refresh_facet_summary(
  p_user_id uuid,
  p_item_type text
) returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_counts jsonb := '{}'::jsonb;
  v_audio text[] := '{}'::text[];
  v_version text[] := '{}'::text[];
  v_audio_counts jsonb := '{}'::jsonb;
  v_sub_counts jsonb := '{}'::jsonb;
begin
  if p_user_id is null or p_item_type not in ('movie', 'series') then
    raise exception 'Invalid catalogue facet summary scope'
      using errcode = '22023';
  end if;

  with active_titles as materialized (
    select
      owner_row.title_id,
      coalesce(
        case when owner_row.storage_kind = 'projection'
          then projection.genre_buckets
          else title.genre_buckets
        end,
        array['autres']::text[]
      ) as genre_buckets
    from public.cloud_catalog_background_owner_pointers pointer
    join public.cloud_catalog_background_owner_snapshot_rows owner_row
      on owner_row.snapshot_id = pointer.active_snapshot_id
     and owner_row.user_id = pointer.user_id
     and owner_row.is_present
    join public.cloud_titles title
      on title.user_id = owner_row.user_id
     and title.id = owner_row.title_id
    left join public.cloud_source_catalog_generation_candidate_titles projection
      on owner_row.storage_kind = 'projection'
     and projection.user_id = owner_row.user_id
     and projection.generation_id = owner_row.owner_generation_id
     and projection.title_id = owner_row.title_id
    where pointer.user_id = p_user_id
      and owner_row.item_type = p_item_type
  ),
  active_variants as materialized (
    select variant.id, variant.title_id, variant.language
    from public.cloud_catalog_background_owner_pointers pointer
    join public.cloud_catalog_background_owner_snapshot_sources owner_source
      on owner_source.snapshot_id = pointer.active_snapshot_id
     and owner_source.user_id = pointer.user_id
    join public.cloud_title_variants variant
      on variant.user_id = owner_source.user_id
     and variant.source_id = owner_source.source_id
     and variant.generation_id = owner_source.generation_id
    join active_titles title on title.title_id = variant.title_id
    where pointer.user_id = p_user_id
  ),
  genre_counts as (
    select bucket, count(*)::bigint as n
    from active_titles title
    cross join lateral unnest(title.genre_buckets) bucket
    where bucket <> 'autres'
    group by bucket
  ),
  audio_counts as (
    select lower(language_code) as language_code,
      count(distinct variant.title_id)::bigint as n
    from active_variants variant
    join public.cloud_title_file_language_observations observation
      on observation.user_id = p_user_id
     and observation.variant_id = variant.id
     and observation.title_id = variant.title_id
     and observation.audio_observed
    cross join lateral unnest(observation.audio_languages) language_code
    where lower(language_code) ~ '^[a-z]{2,3}$'
      and lower(language_code) not in ('un', 'und', 'mul', 'zxx', 'mis', 'nar')
    group by lower(language_code)
  ),
  subtitle_counts as (
    select lower(language_code) as language_code,
      count(distinct variant.title_id)::bigint as n
    from active_variants variant
    join public.cloud_title_file_language_observations observation
      on observation.user_id = p_user_id
     and observation.variant_id = variant.id
     and observation.title_id = variant.title_id
     and observation.subtitle_observed
    cross join lateral unnest(observation.subtitle_languages) language_code
    where lower(language_code) ~ '^[a-z]{2,3}$'
      and lower(language_code) not in ('un', 'und', 'mul', 'zxx', 'mis', 'nar')
    group by lower(language_code)
  ),
  version_tags as (
    select distinct lower(btrim(variant.language)) as tag
    from active_variants variant
    where nullif(btrim(variant.language), '') is not null
  )
  select
    coalesce((select jsonb_object_agg(bucket, n) from genre_counts), '{}'::jsonb),
    coalesce((select array_agg(language_code order by language_code)
      from audio_counts), '{}'::text[]),
    coalesce((select array_agg(tag order by tag) from version_tags), '{}'::text[]),
    coalesce((select jsonb_object_agg(language_code, n)
      from audio_counts), '{}'::jsonb),
    coalesce((select jsonb_object_agg(language_code, n)
      from subtitle_counts), '{}'::jsonb)
  into v_counts, v_audio, v_version, v_audio_counts, v_sub_counts;

  insert into public.cloud_catalog_facet_summary (
    user_id,
    item_type,
    genre_bucket_counts,
    audio_langs,
    version_tags,
    audio_lang_counts,
    subtitle_lang_counts,
    refreshed_at
  ) values (
    p_user_id,
    p_item_type,
    v_counts,
    v_audio,
    v_version,
    v_audio_counts,
    v_sub_counts,
    now()
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

create or replace function public.cloud_refresh_all_facet_summaries(
  p_limit integer default 100
) returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  candidate record;
  refreshed integer := 0;
begin
  for candidate in
    select distinct owner_row.user_id, owner_row.item_type,
      summary.refreshed_at
    from public.cloud_catalog_background_owner_pointers pointer
    join public.cloud_catalog_background_owner_snapshot_rows owner_row
      on owner_row.snapshot_id = pointer.active_snapshot_id
     and owner_row.user_id = pointer.user_id
     and owner_row.is_present
    left join public.cloud_catalog_facet_summary summary
      on summary.user_id = owner_row.user_id
     and summary.item_type = owner_row.item_type
    where summary.user_id is null
       or summary.refreshed_at < now() - interval '30 minutes'
    order by summary.refreshed_at nulls first,
      owner_row.user_id,
      owner_row.item_type
    limit greatest(1, least(1000, coalesce(p_limit, 100)))
  loop
    perform public.cloud_refresh_facet_summary(
      candidate.user_id,
      candidate.item_type
    );
    refreshed := refreshed + 1;
  end loop;
  return refreshed;
end
$function$;

revoke all on function public.cloud_refresh_facet_summary(uuid, text)
  from public, anon, authenticated;
revoke all on function public.cloud_refresh_all_facet_summaries(integer)
  from public, anon, authenticated;
grant execute on function public.cloud_refresh_facet_summary(uuid, text)
  to service_role;
grant execute on function public.cloud_refresh_all_facet_summaries(integer)
  to service_role;

do $assert$
declare
  v_single text := pg_get_functiondef(
    'public.cloud_refresh_facet_summary(uuid,text)'::regprocedure
  );
  v_all text := pg_get_functiondef(
    'public.cloud_refresh_all_facet_summaries(integer)'::regprocedure
  );
begin
  if position('cloud_catalog_background_owner_pointers' in v_single) = 0
     or position('cloud_catalog_background_owner_snapshot_rows' in v_single) = 0
     or position('cloud_catalog_background_owner_snapshot_sources' in v_single) = 0
     or position('cloud_catalog_visible_titles' in v_single) > 0 then
    raise exception 'catalog facet summary refresh is not snapshot-set based'
      using errcode = '55000';
  end if;
  if position('cloud_catalog_background_owner_snapshot_rows' in v_all) = 0
     or position('cloud_catalog_visible_titles' in v_all) > 0 then
    raise exception 'catalog facet summary selector is not snapshot-set based'
      using errcode = '55000';
  end if;
end
$assert$;

-- Keep the existing cadence and identity.  The corrected implementation is
-- set-based and completes before the next dashboard/alert observation window.
select cron.schedule(
  'norva-facet-summary-refresh',
  '7-59/15 * * * *',
  $cron$ set statement_timeout='300s'; select public.cloud_refresh_all_facet_summaries(200); $cron$
);

commit;
