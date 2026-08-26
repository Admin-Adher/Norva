begin;
set local lock_timeout = '2s';
set local statement_timeout = '15s';

alter table public.cloud_catalog_facet_summary
  add column if not exists genre_rail_refreshed_at timestamptz;

-- Restore the facet refresh contract exactly. Rail materialisation has a
-- separate bounded worker below, so a slow language-facet scan can neither
-- starve nor roll back the Home/Movies/Series read model.
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
begin
  select coalesce(jsonb_object_agg(bucket, n), '{}'::jsonb)
    into v_counts
  from (
    select bucket, count(*)::bigint as n
    from public.cloud_catalog_visible_titles title
    cross join lateral unnest(
      coalesce(title.genre_buckets, array['autres'])
    ) bucket
    where title.user_id = p_user_id
      and title.item_type = p_item_type
      and bucket <> 'autres'
    group by bucket
  ) genre_counts;

  select
    coalesce(jsonb_object_agg(language_code, n), '{}'::jsonb),
    coalesce(array_agg(language_code order by language_code), '{}'::text[])
    into v_audio_counts, v_audio
  from (
    select language_code, count(distinct title.id)::bigint as n
    from public.cloud_catalog_visible_titles title
    cross join lateral unnest(title.file_audio_languages) language_code
    where title.user_id = p_user_id
      and title.item_type = p_item_type
      and language_code ~ '^[a-z]{2,3}$'
      and language_code not in ('un', 'und', 'mul', 'zxx', 'mis', 'nar')
    group by language_code
  ) audio_counts;

  select coalesce(array_agg(distinct lower(version_language)), '{}'::text[])
    into v_version
  from public.cloud_catalog_visible_titles title
  cross join lateral unnest(
    coalesce(title.version_languages, '{}'::text[])
  ) version_language
  where title.user_id = p_user_id
    and title.item_type = p_item_type
    and version_language is not null;

  select coalesce(jsonb_object_agg(language_code, n), '{}'::jsonb)
    into v_sub_counts
  from (
    select language_code, count(distinct title.id)::bigint as n
    from public.cloud_catalog_visible_titles title
    cross join lateral unnest(title.file_subtitle_languages) language_code
    where title.user_id = p_user_id
      and title.item_type = p_item_type
      and language_code ~ '^[a-z]{2,3}$'
      and language_code not in ('un', 'und', 'mul', 'zxx', 'mis', 'nar')
    group by language_code
  ) subtitle_counts;

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
    coalesce(v_counts, '{}'::jsonb),
    coalesce(v_audio, '{}'::text[]),
    coalesce(v_version, '{}'::text[]),
    coalesce(v_audio_counts, '{}'::jsonb),
    coalesce(v_sub_counts, '{}'::jsonb),
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

create or replace function public.cloud_refresh_genre_rail_candidates(
  p_user_id uuid,
  p_item_type text
) returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_candidates jsonb;
  v_start_epoch bigint;
  v_end_epoch bigint;
begin
  if p_user_id is null or p_item_type not in ('movie', 'series') then
    raise exception 'invalid genre rail refresh arguments' using errcode = '22023';
  end if;

  select coalesce(epoch.visibility_epoch, 1)
    into v_start_epoch
  from (select 1) singleton
  left join public.cloud_user_catalog_visibility_epochs epoch
    on epoch.user_id = p_user_id;

  with visible_titles as materialized (
    select distinct on (variant.title_id)
      variant.title_id as id,
      coalesce(projection.genre_buckets, title.genre_buckets) as genre_buckets,
      coalesce(projection.catalog_created_at, title.created_at) as created_at,
      coalesce(projection.poster_url, title.poster_url) as poster_url
    from public.cloud_catalog_visible_title_variants variant
    join public.cloud_titles title
      on title.id = variant.title_id
     and title.user_id = variant.user_id
    left join public.cloud_source_catalog_generation_candidate_titles projection
      on projection.generation_id = variant.generation_id
     and projection.title_id = variant.title_id
     and projection.user_id = variant.user_id
    where variant.user_id = p_user_id
      and variant.item_type = p_item_type
    order by
      variant.title_id,
      projection.updated_at desc nulls last,
      title.updated_at desc
  ), ranked_candidates as (
    select
      candidate.id,
      candidate.genre_buckets,
      candidate.created_at,
      bucket,
      row_number() over (
        partition by bucket
        order by candidate.created_at desc, candidate.id
      ) as bucket_rank
    from visible_titles candidate
    cross join lateral unnest(candidate.genre_buckets) bucket
    where candidate.poster_url is not null
      and bucket <> 'autres'
  ), bounded_candidates as (
    select bucket, jsonb_agg(
      jsonb_build_object(
        'id', id,
        'genreBuckets', genre_buckets,
        'createdAt', created_at
      ) order by created_at desc, id
    ) as items
    from ranked_candidates
    where bucket_rank <= 150
    group by bucket
  )
  select coalesce(jsonb_object_agg(bucket, items), '{}'::jsonb)
    into v_candidates
  from bounded_candidates;

  select coalesce(epoch.visibility_epoch, 1)
    into v_end_epoch
  from (select 1) singleton
  left join public.cloud_user_catalog_visibility_epochs epoch
    on epoch.user_id = p_user_id;
  if v_end_epoch <> v_start_epoch then
    raise exception 'catalog visibility changed during genre rail refresh'
      using errcode = '40001', detail = 'reason=catalog_visibility_changed';
  end if;

  insert into public.cloud_catalog_facet_summary (
    user_id,
    item_type,
    genre_rail_candidates,
    genre_rail_visibility_epoch,
    genre_rail_refreshed_at,
    refreshed_at
  ) values (
    p_user_id,
    p_item_type,
    coalesce(v_candidates, '{}'::jsonb),
    v_start_epoch,
    now(),
    '1970-01-01 00:00:00+00'::timestamptz
  )
  on conflict (user_id, item_type) do update set
    genre_rail_candidates = excluded.genre_rail_candidates,
    genre_rail_visibility_epoch = excluded.genre_rail_visibility_epoch,
    genre_rail_refreshed_at = excluded.genre_rail_refreshed_at;
end
$function$;

create or replace function public.cloud_refresh_all_genre_rail_candidates(
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
    select summary.user_id, summary.item_type
    from public.cloud_catalog_facet_summary summary
    left join public.cloud_user_catalog_visibility_epochs epoch
      on epoch.user_id = summary.user_id
    where summary.genre_rail_visibility_epoch is distinct from
          coalesce(epoch.visibility_epoch, 1)
       or summary.genre_rail_refreshed_at is null
       or summary.genre_rail_refreshed_at < now() - interval '30 minutes'
    order by summary.genre_rail_refreshed_at nulls first,
             summary.user_id,
             summary.item_type
    limit greatest(1, least(1000, coalesce(p_limit, 100)))
  loop
    perform public.cloud_refresh_genre_rail_candidates(
      candidate.user_id,
      candidate.item_type
    );
    refreshed := refreshed + 1;
  end loop;
  return refreshed;
end
$function$;

-- The Edge RPC reports the rail-specific freshness marker, never the unrelated
-- language-facet timestamp.
create or replace function public.norva_get_genre_rail_candidates(
  p_user_id uuid,
  p_item_type text,
  p_expected_visibility_epoch bigint
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_role text := coalesce(
    nullif(auth.jwt() ->> 'role', ''),
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('role', true), 'none'),
    ''
  );
  v_current_epoch bigint;
  v_candidates jsonb;
  v_materialized_epoch bigint;
  v_refreshed_at timestamptz;
begin
  if v_role <> 'service_role'
     and not (v_role in ('', 'postgres') and session_user = 'postgres') then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_user_id is null or p_item_type not in ('movie', 'series')
     or p_expected_visibility_epoch is null then
    raise exception 'invalid genre rail candidate arguments' using errcode = '22023';
  end if;

  select coalesce(epoch.visibility_epoch, 1)
    into v_current_epoch
  from (select 1) singleton
  left join public.cloud_user_catalog_visibility_epochs epoch
    on epoch.user_id = p_user_id;
  if v_current_epoch <> p_expected_visibility_epoch then
    raise exception 'catalog visibility epoch changed'
      using errcode = '40001', detail = 'reason=catalog_visibility_changed';
  end if;

  select summary.genre_rail_candidates,
         summary.genre_rail_visibility_epoch,
         summary.genre_rail_refreshed_at
    into v_candidates, v_materialized_epoch, v_refreshed_at
  from public.cloud_catalog_facet_summary summary
  where summary.user_id = p_user_id
    and summary.item_type = p_item_type;

  if not found or v_materialized_epoch is distinct from v_current_epoch then
    raise exception 'genre rail read model is not ready'
      using errcode = '55000', detail = 'reason=genre_rail_read_model_stale_or_missing';
  end if;

  return jsonb_build_object(
    'contract', 'catalog-genre-rail-candidates-v1',
    'visibilityEpoch', v_current_epoch,
    'refreshedAt', v_refreshed_at,
    'candidates', coalesce(v_candidates, '{}'::jsonb)
  );
end
$function$;

revoke all on function public.cloud_refresh_facet_summary(uuid, text)
  from public, anon, authenticated;
revoke all on function public.cloud_refresh_genre_rail_candidates(uuid, text)
  from public, anon, authenticated;
revoke all on function public.cloud_refresh_all_genre_rail_candidates(integer)
  from public, anon, authenticated;
revoke all on function public.norva_get_genre_rail_candidates(uuid, text, bigint)
  from public, anon, authenticated;
grant execute on function public.cloud_refresh_facet_summary(uuid, text)
  to service_role;
grant execute on function public.cloud_refresh_genre_rail_candidates(uuid, text)
  to service_role;
grant execute on function public.cloud_refresh_all_genre_rail_candidates(integer)
  to service_role;
grant execute on function public.norva_get_genre_rail_candidates(uuid, text, bigint)
  to service_role;

select cron.schedule(
  'norva-genre-rail-candidate-refresh',
  '5-59/15 * * * *',
  $cron$
    set statement_timeout='120s';
    select public.cloud_refresh_all_genre_rail_candidates(100);
  $cron$
);

commit;
