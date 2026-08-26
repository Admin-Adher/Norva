begin;
set local lock_timeout = '2s';
set local statement_timeout = '15s';

-- Genre rails used to fan one page request out into fifteen concurrent reads of
-- cloud_catalog_visible_titles.  Large accounts then exhausted the 8 second
-- authenticated statement budget and also starved unrelated Home reads.  Keep
-- the exact visible-title contract, but materialise a bounded rail candidate
-- read model alongside the existing facet summary during the background refresh.
alter table public.cloud_catalog_facet_summary
  add column if not exists genre_rail_candidates jsonb not null default '{}'::jsonb,
  add column if not exists genre_rail_visibility_epoch bigint;

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
  v_rail_candidates jsonb;
  v_start_epoch bigint;
  v_end_epoch bigint;
begin
  if p_user_id is null or p_item_type not in ('movie', 'series') then
    raise exception 'invalid facet summary arguments' using errcode = '22023';
  end if;

  select coalesce(epoch.visibility_epoch, 1)
    into v_start_epoch
  from (select 1) singleton
  left join public.cloud_user_catalog_visibility_epochs epoch
    on epoch.user_id = p_user_id;

  -- The previous summary function independently evaluated the expensive visible
  -- title projection four times (genre, audio, version, subtitles). Materialise
  -- its narrow columns once, then derive every facet and the new rail pool from
  -- that one generation-consistent set. PostgreSQL may rescan the small spool,
  -- but it never re-runs the active-head/runtime projection per aggregate.
  with visible as materialized (
    select
      title.id,
      title.genre_buckets,
      title.file_audio_languages,
      title.file_subtitle_languages,
      title.version_languages,
      title.created_at,
      title.poster_url
    from public.cloud_catalog_visible_titles title
    where title.user_id = p_user_id
      and title.item_type = p_item_type
      and title.variant_count > 0
  ), genre_counts as (
    select bucket, count(*)::bigint as n
    from visible title
    cross join lateral unnest(coalesce(title.genre_buckets, array['autres'])) bucket
    where bucket <> 'autres'
    group by bucket
  ), audio_counts as (
    select language_code, count(distinct title.id)::bigint as n
    from visible title
    cross join lateral unnest(title.file_audio_languages) language_code
    where language_code ~ '^[a-z]{2,3}$'
      and language_code not in ('un', 'und', 'mul', 'zxx', 'mis', 'nar')
    group by language_code
  ), subtitle_counts as (
    select language_code, count(distinct title.id)::bigint as n
    from visible title
    cross join lateral unnest(title.file_subtitle_languages) language_code
    where language_code ~ '^[a-z]{2,3}$'
      and language_code not in ('un', 'und', 'mul', 'zxx', 'mis', 'nar')
    group by language_code
  ), version_values as (
    select distinct lower(version_language) as language_code
    from visible title
    cross join lateral unnest(coalesce(title.version_languages, '{}'::text[])) version_language
    where version_language is not null
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
    from visible candidate
    cross join lateral unnest(candidate.genre_buckets) bucket
    where candidate.poster_url is not null
      and bucket <> 'autres'
  ), bounded_candidates as (
    -- 150 = maximum public rail limit (50) times the existing x3 de-dup
    -- buffer. Each bucket is complete over the visible catalogue; this is not
    -- a recent-title sample.
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
  select
    coalesce((select jsonb_object_agg(bucket, n) from genre_counts), '{}'::jsonb),
    coalesce((select array_agg(language_code order by language_code) from audio_counts), '{}'::text[]),
    coalesce((select array_agg(language_code order by language_code) from version_values), '{}'::text[]),
    coalesce((select jsonb_object_agg(language_code, n) from audio_counts), '{}'::jsonb),
    coalesce((select jsonb_object_agg(language_code, n) from subtitle_counts), '{}'::jsonb),
    coalesce((select jsonb_object_agg(bucket, items) from bounded_candidates), '{}'::jsonb)
  into v_counts, v_audio, v_version, v_audio_counts, v_sub_counts, v_rail_candidates;

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
    genre_rail_candidates,
    genre_rail_visibility_epoch,
    refreshed_at
  ) values (
    p_user_id,
    p_item_type,
    coalesce(v_counts, '{}'::jsonb),
    coalesce(v_audio, '{}'::text[]),
    coalesce(v_version, '{}'::text[]),
    coalesce(v_audio_counts, '{}'::jsonb),
    coalesce(v_sub_counts, '{}'::jsonb),
    coalesce(v_rail_candidates, '{}'::jsonb),
    v_start_epoch,
    now()
  )
  on conflict (user_id, item_type) do update set
    genre_bucket_counts = excluded.genre_bucket_counts,
    audio_langs = excluded.audio_langs,
    version_tags = excluded.version_tags,
    audio_lang_counts = excluded.audio_lang_counts,
    subtitle_lang_counts = excluded.subtitle_lang_counts,
    genre_rail_candidates = excluded.genre_rail_candidates,
    genre_rail_visibility_epoch = excluded.genre_rail_visibility_epoch,
    refreshed_at = excluded.refreshed_at;
end
$function$;

revoke all on function public.cloud_refresh_facet_summary(uuid, text)
  from public, anon, authenticated;
grant execute on function public.cloud_refresh_facet_summary(uuid, text)
  to service_role;

-- One small, generation-fenced RPC replaces fifteen concurrent PostgREST scans.
-- A missing/stale read model is explicit and fail-closed; callers may keep their
-- already-painted SWR cache but must not fall back to an unbounded live fan-out.
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
         summary.refreshed_at
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

revoke all on function public.norva_get_genre_rail_candidates(uuid, text, bigint)
  from public, anon, authenticated;
grant execute on function public.norva_get_genre_rail_candidates(uuid, text, bigint)
  to service_role;

commit;
