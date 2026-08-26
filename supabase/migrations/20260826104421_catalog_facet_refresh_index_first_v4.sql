begin;
set local lock_timeout = '2s';
set local statement_timeout = '15s';

-- The previous worker read cloud_catalog_visible_titles four times. That view
-- hydrates the complete per-title runtime projection and is intentionally
-- optimized for bounded UI selectors, not whole-catalogue aggregation. Build
-- the same facet contract directly from the already lifecycle/generation-
-- filtered variant set, and materialize that set once per refresh.
create or replace function public.cloud_refresh_facet_summary(
  p_user_id uuid,
  p_item_type text
) returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_counts jsonb;
  v_audio text[];
  v_version text[];
  v_audio_counts jsonb;
  v_sub_counts jsonb;
  v_start_epoch bigint;
  v_end_epoch bigint;
begin
  if p_user_id is null or p_item_type not in ('movie', 'series') then
    raise exception 'invalid facet refresh arguments' using errcode = '22023';
  end if;

  select coalesce(epoch.visibility_epoch, 1)
    into v_start_epoch
  from (select 1) singleton
  left join public.cloud_user_catalog_visibility_epochs epoch
    on epoch.user_id = p_user_id;

  with visible_variants as materialized (
    select
      variant.id,
      variant.title_id,
      variant.user_id,
      variant.generation_id,
      variant.language
    from public.cloud_catalog_visible_title_variants variant
    where variant.user_id = p_user_id
      and variant.item_type = p_item_type
  ), visible_titles as materialized (
    select distinct on (variant.title_id)
      variant.title_id,
      coalesce(projection.genre_buckets, title.genre_buckets) as genre_buckets
    from visible_variants variant
    join public.cloud_titles title
      on title.id = variant.title_id
     and title.user_id = variant.user_id
    left join public.cloud_source_catalog_generation_candidate_titles projection
      on projection.generation_id = variant.generation_id
     and projection.title_id = variant.title_id
     and projection.user_id = variant.user_id
    order by
      variant.title_id,
      projection.updated_at desc nulls last,
      title.updated_at desc
  ), exact_file_languages as materialized (
    select variant.title_id, 'audio'::text as facet, lower(language_code) as language_code
    from visible_variants variant
    join public.cloud_title_file_language_observations observation
      on observation.user_id = variant.user_id
     and observation.title_id = variant.title_id
     and observation.variant_id = variant.id
     and observation.audio_observed
    cross join lateral unnest(observation.audio_languages) language_code

    union all

    select variant.title_id, 'subtitle'::text, lower(language_code)
    from visible_variants variant
    join public.cloud_title_file_language_observations observation
      on observation.user_id = variant.user_id
     and observation.title_id = variant.title_id
     and observation.variant_id = variant.id
     and observation.subtitle_observed
    cross join lateral unnest(observation.subtitle_languages) language_code
  ), normalized_file_languages as materialized (
    select title_id, facet, language_code
    from exact_file_languages
    where language_code ~ '^[a-z]{2,3}$'
      and language_code not in ('un', 'und', 'mul', 'zxx', 'mis', 'nar')
  )
  select
    coalesce((
      select jsonb_object_agg(bucket, n)
      from (
        select bucket, count(*)::bigint as n
        from visible_titles title
        cross join lateral unnest(
          coalesce(title.genre_buckets, array['autres'])
        ) bucket
        where bucket <> 'autres'
        group by bucket
      ) genre_counts
    ), '{}'::jsonb),
    coalesce((
      select array_agg(language_code order by language_code)
      from (
        select distinct language_code
        from normalized_file_languages
        where facet = 'audio'
      ) audio_languages
    ), '{}'::text[]),
    coalesce((
      select array_agg(language_code order by language_code)
      from (
        select distinct lower(btrim(language)) as language_code
        from visible_variants
        where nullif(btrim(language), '') is not null
      ) version_languages
    ), '{}'::text[]),
    coalesce((
      select jsonb_object_agg(language_code, n)
      from (
        select language_code, count(distinct title_id)::bigint as n
        from normalized_file_languages
        where facet = 'audio'
        group by language_code
      ) audio_counts
    ), '{}'::jsonb),
    coalesce((
      select jsonb_object_agg(language_code, n)
      from (
        select language_code, count(distinct title_id)::bigint as n
        from normalized_file_languages
        where facet = 'subtitle'
        group by language_code
      ) subtitle_counts
    ), '{}'::jsonb)
  into v_counts, v_audio, v_version, v_audio_counts, v_sub_counts;

  select coalesce(epoch.visibility_epoch, 1)
    into v_end_epoch
  from (select 1) singleton
  left join public.cloud_user_catalog_visibility_epochs epoch
    on epoch.user_id = p_user_id;

  if v_end_epoch <> v_start_epoch then
    raise exception 'catalog visibility changed during facet refresh'
      using errcode = '40001', detail = 'reason=catalog_visibility_changed';
  end if;

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

-- Prefer the tiny summary table for existing rows. Only discover missing rows
-- through the index-first visible variant projection, never through the
-- hydrated visible-title runtime view.
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
    with stale as (
      select summary.user_id, summary.item_type, summary.refreshed_at
      from public.cloud_catalog_facet_summary summary
      where summary.refreshed_at < now() - interval '30 minutes'
    ), missing as (
      select variant.user_id, variant.item_type, null::timestamptz as refreshed_at
      from public.cloud_catalog_visible_title_variants variant
      where variant.item_type in ('movie', 'series')
        and not exists (
          select 1
          from public.cloud_catalog_facet_summary summary
          where summary.user_id = variant.user_id
            and summary.item_type = variant.item_type
        )
      group by variant.user_id, variant.item_type
    )
    select pending.user_id, pending.item_type
    from (
      select * from stale
      union all
      select * from missing
    ) pending
    order by pending.refreshed_at nulls first,
             pending.user_id,
             pending.item_type
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

-- Recreate the named schedule only after the replacement functions exist.
-- The bounded worker remains independent from Provider Access network jobs.
select cron.schedule(
  'norva-facet-summary-refresh',
  '7-59/15 * * * *',
  $cron$set statement_timeout='120s'; select public.cloud_refresh_all_facet_summaries(50);$cron$
);

commit;
