-- Provisional -> verified provider identity lifecycle.
--
-- A source with fewer than 32 stable movie/series ids cannot safely join a
-- canonical provider identity. Keep that source operational with a strictly
-- source-local candidate and promote it atomically once enough evidence exists.
-- The candidate table is never consulted for cross-account fanout, cache keys,
-- provider leases or global serialization.

begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

create table if not exists public.catalog_source_provider_identity_candidates (
  source_id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  provider_key text not null,
  display_name text,
  resolution_state text not null default 'provisional',
  evidence_count integer not null default 0,
  required_evidence integer not null default 32,
  sample_kind text not null default 'xtream-streamid-md5-bottom256',
  first_seen_at timestamptz not null default clock_timestamp(),
  last_attempt_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint catalog_source_provider_identity_candidates_source_owner_fk
    foreign key (user_id, source_id)
    references public.cloud_sources(user_id, id)
    on delete cascade,
  constraint catalog_source_provider_identity_candidates_owner_unique
    unique (source_id, user_id),
  constraint catalog_source_provider_identity_candidates_key_check
    check (coalesce(btrim(provider_key), '') <> '' and length(provider_key) <= 500),
  constraint catalog_source_provider_identity_candidates_name_check
    check (display_name is null or length(display_name) <= 200),
  constraint catalog_source_provider_identity_candidates_state_check
    check (resolution_state = 'provisional'),
  constraint catalog_source_provider_identity_candidates_evidence_check
    check (
      required_evidence = 32
      and evidence_count >= 0
      and evidence_count < required_evidence
    )
);

comment on table public.catalog_source_provider_identity_candidates is
  'Server-only source-local provider candidates. Rows below 32 signals are not trusted for cross-account fanout, shared caches, provider leases or global locks.';

create index if not exists catalog_source_provider_identity_candidates_owner_idx
  on public.catalog_source_provider_identity_candidates (user_id, source_id);
create index if not exists catalog_source_provider_identity_candidates_updated_idx
  on public.catalog_source_provider_identity_candidates (updated_at desc, source_id);

alter table public.catalog_source_provider_identity_candidates enable row level security;
revoke all on table public.catalog_source_provider_identity_candidates
  from public, anon, authenticated;
grant select, insert, update, delete
  on table public.catalog_source_provider_identity_candidates to service_role;

drop trigger if exists trg_aaa_provider_account_delete_write_guard
  on public.catalog_source_provider_identity_candidates;
create trigger trg_aaa_provider_account_delete_write_guard
before insert or update or delete on public.catalog_source_provider_identity_candidates
for each row execute function public.norva_provider_account_delete_write_guard();

-- Preserve the historical signature used by the sync engine, but make the
-- source link and candidate replacement one PostgreSQL transaction.
create or replace function public.norva_resolve_provider_identity(
  p_source_id uuid,
  p_provider_key text,
  p_display_name text,
  p_status text default 'active'
) returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid;
  v_source_name text;
  v_provider_key text;
  v_display_name text;
  v_status text;
  v_sample text[];
  v_size integer := 0;
  v_identity uuid;
  v_best_id uuid;
  v_best_jac numeric := 0;
  v_min_sample constant integer := 32;
  v_threshold constant numeric := 0.5;
  v_inter integer;
  v_union integer;
  v_jac numeric;
  rec record;
begin
  if p_source_id is null or coalesce(btrim(p_provider_key), '') = '' then
    raise exception 'invalid provider identity input' using errcode = '22023';
  end if;

  v_provider_key := left(btrim(p_provider_key), 500);
  v_status := case when p_status in ('active', 'deleted') then p_status else 'active' end;

  select source.user_id, source.display_name::text
    into v_user_id, v_source_name
  from public.cloud_sources source
  where source.id = p_source_id
    and source.source_type = 'xtream'
    and source.deleted_at is null
  for share;

  if not found then
    raise exception 'provider source unavailable' using errcode = 'P0002';
  end if;

  v_display_name := left(
    coalesce(nullif(btrim(p_display_name), ''), nullif(btrim(v_source_name), ''), v_provider_key),
    200
  );

  -- A previously verified source remains verified if a transient catalogue
  -- shrink leaves fewer than 32 ids. It is already inside the trust boundary.
  select link.identity_id
    into v_identity
  from public.catalog_source_provider_identities link
  where link.source_id = p_source_id
    and link.user_id = v_user_id
  for share;

  if v_identity is not null then
    insert into public.catalog_provider_identities as alias (
      provider_key, display_name, status, identity_id, last_seen, updated_at
    ) values (
      v_provider_key, v_display_name, v_status, v_identity,
      clock_timestamp(), clock_timestamp()
    )
    on conflict (provider_key) do update
      set display_name = excluded.display_name,
          status = excluded.status,
          identity_id = excluded.identity_id,
          last_seen = excluded.last_seen,
          updated_at = excluded.updated_at;

    update public.catalog_source_provider_identities link
       set provider_key = v_provider_key,
           updated_at = clock_timestamp()
     where link.source_id = p_source_id
       and link.user_id = v_user_id;
    update public.provider_identities identity
       set last_seen = clock_timestamp(), updated_at = clock_timestamp()
     where identity.id = v_identity;
    delete from public.catalog_source_provider_identity_candidates candidate
     where candidate.source_id = p_source_id
       and candidate.user_id = v_user_id;
    return v_identity;
  end if;

  select array_agg(sample.external_id order by sample.external_id)
    into v_sample
  from (
    select distinct_item.external_id
    from (
      select distinct item.external_id
      from public.cloud_media_items item
      where item.source_id = p_source_id
        and item.user_id = v_user_id
        and item.item_type in ('movie', 'series')
        and item.available = true
        and coalesce(btrim(item.external_id), '') <> ''
    ) distinct_item
    order by md5(distinct_item.external_id)
    limit 256
  ) sample;
  v_size := coalesce(cardinality(v_sample), 0);

  -- Keep the server-derived fingerprint registry current. An existing canonical
  -- link on the alias is deliberately not copied into the source trust table
  -- until this source itself reaches the evidence threshold.
  insert into public.catalog_provider_identities as alias (
    provider_key, display_name, status, last_seen, updated_at
  ) values (
    v_provider_key, v_display_name, v_status,
    clock_timestamp(), clock_timestamp()
  )
  on conflict (provider_key) do update
    set display_name = excluded.display_name,
        status = excluded.status,
        last_seen = excluded.last_seen,
        updated_at = excluded.updated_at;

  if v_size < v_min_sample then
    insert into public.catalog_source_provider_identity_candidates as candidate (
      source_id, user_id, provider_key, display_name, resolution_state,
      evidence_count, required_evidence, sample_kind,
      first_seen_at, last_attempt_at, updated_at
    ) values (
      p_source_id, v_user_id, v_provider_key, v_display_name, 'provisional',
      v_size, v_min_sample, 'xtream-streamid-md5-bottom256',
      clock_timestamp(), clock_timestamp(), clock_timestamp()
    )
    on conflict (source_id) do update
      set user_id = excluded.user_id,
          provider_key = excluded.provider_key,
          display_name = excluded.display_name,
          resolution_state = 'provisional',
          evidence_count = excluded.evidence_count,
          required_evidence = excluded.required_evidence,
          sample_kind = excluded.sample_kind,
          last_attempt_at = excluded.last_attempt_at,
          updated_at = excluded.updated_at;
    return null;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('norva_provider_identity_resolve')
  );

  -- Recheck after serialization in case another sync promoted this source.
  select link.identity_id
    into v_identity
  from public.catalog_source_provider_identities link
  where link.source_id = p_source_id
    and link.user_id = v_user_id
  for share;

  if v_identity is null then
    select alias.identity_id
      into v_identity
    from public.catalog_provider_identities alias
    where alias.provider_key = v_provider_key;
  end if;

  if v_identity is null then
    for rec in
      select identity.id, identity.stream_sample
      from public.provider_identities identity
      where identity.status = 'active'
        and identity.stream_sample && v_sample
    loop
      select
        cardinality(array(
          select value from pg_catalog.unnest(rec.stream_sample) value
          intersect
          select value from pg_catalog.unnest(v_sample) value
        )),
        cardinality(array(
          select value from pg_catalog.unnest(rec.stream_sample) value
          union
          select value from pg_catalog.unnest(v_sample) value
        ))
        into v_inter, v_union;
      v_jac := case when v_union > 0 then v_inter::numeric / v_union else 0 end;
      if v_jac > v_best_jac then
        v_best_jac := v_jac;
        v_best_id := rec.id;
      end if;
    end loop;

    if v_best_id is not null and v_best_jac >= v_threshold then
      v_identity := v_best_id;
      update public.provider_identities identity
         set last_seen = clock_timestamp(),
             updated_at = clock_timestamp(),
             display_name = coalesce(identity.display_name, v_display_name)
       where identity.id = v_identity;
    else
      insert into public.provider_identities (
        display_name, status, stream_sample, sample_kind,
        first_seen, last_seen, created_at, updated_at
      ) values (
        v_display_name, v_status, v_sample,
        'xtream-streamid-md5-bottom256',
        clock_timestamp(), clock_timestamp(), clock_timestamp(), clock_timestamp()
      ) returning id into v_identity;
    end if;
  else
    update public.provider_identities identity
       set last_seen = clock_timestamp(), updated_at = clock_timestamp()
     where identity.id = v_identity;
  end if;

  update public.catalog_provider_identities alias
     set identity_id = v_identity,
         updated_at = clock_timestamp()
   where alias.provider_key = v_provider_key;

  insert into public.catalog_source_provider_identities as link (
    source_id, user_id, identity_id, provider_key, verified_at, updated_at
  ) values (
    p_source_id, v_user_id, v_identity, v_provider_key,
    clock_timestamp(), clock_timestamp()
  )
  on conflict (source_id) do update
    set user_id = excluded.user_id,
        identity_id = excluded.identity_id,
        provider_key = excluded.provider_key,
        verified_at = excluded.verified_at,
        updated_at = excluded.updated_at;

  delete from public.catalog_source_provider_identity_candidates candidate
   where candidate.source_id = p_source_id
     and candidate.user_id = v_user_id;

  return v_identity;
end
$function$;

revoke all on function public.norva_resolve_provider_identity(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.norva_resolve_provider_identity(uuid, text, text, text)
  to service_role;

-- Source-local synopsis candidate claim. The cache key cannot collide with a
-- canonical provider UUID and cannot fan out to another source or account.
create or replace function public.claim_source_provider_overview_candidates(
  p_user_id uuid,
  p_source_id uuid,
  p_limit integer default 4
) returns table(
  external_id text,
  media_item_id uuid,
  title_id uuid,
  raw_title text,
  cached_overview text,
  cached_status text
)
language sql
stable
security definer
set search_path = ''
as $function$
  with source_scope as materialized (
    select
      source.id as source_id,
      source.user_id,
      'source:' || source.id::text as cache_key
    from public.cloud_sources source
    where source.id = p_source_id
      and source.user_id = p_user_id
      and source.source_type = 'xtream'
      and source.sync_status = 'ready'
      and source.enabled = true
      and source.deleted_at is null
      and not exists (
        select 1
        from public.catalog_source_provider_identities verified
        where verified.source_id = source.id
          and verified.user_id = source.user_id
      )
  ),
  eligible as materialized (
    select
      variant.external_id,
      variant.media_item_id,
      variant.title_id,
      variant.raw_title,
      media.added_at,
      cache.provider_overview as cached_overview,
      cache.overview_status as cached_status,
      row_number() over (
        partition by variant.title_id
        order by
          (cache.overview_status = 'resolved') desc,
          coalesce(media.added_at, 0) desc,
          variant.external_id
      ) as title_rank
    from source_scope scope
    join public.cloud_title_variants variant
      on variant.source_id = scope.source_id
     and variant.user_id = scope.user_id
     and variant.item_type = 'movie'
    join public.cloud_titles title
      on title.id = variant.title_id
     and title.user_id = scope.user_id
     and title.item_type = 'movie'
     and title.variant_count > 0
    join public.cloud_media_items media
      on media.id = variant.media_item_id
     and media.source_id = scope.source_id
     and media.user_id = scope.user_id
     and media.item_type = 'movie'
     and media.available = true
    left join public.catalog_file_tracks cache
      on cache.server_host = scope.cache_key
     and cache.item_type = 'movie'
     and cache.external_id = variant.external_id
    where coalesce(btrim(variant.external_id), '') <> ''
      and nullif(btrim(coalesce(
        title.metadata #>> '{i18n,fr,overview}',
        title.metadata #>> '{tmdb,overview}',
        title.metadata ->> 'overview',
        ''
      )), '') is null
      and not exists (
        select 1
        from public.cloud_title_variants summary_variant
        where summary_variant.user_id = title.user_id
          and summary_variant.title_id = title.id
          and summary_variant.id = title.default_variant_id
          and nullif(btrim(coalesce(
            summary_variant.metadata ->> 'overview',
            summary_variant.metadata ->> 'plot',
            summary_variant.metadata ->> 'description',
            ''
          )), '') is not null
      )
      and not exists (
        select 1
        from public.catalog_titles catalog
        where catalog.item_type = 'movie'
          and catalog.provider_tmdb_id = title.provider_tmdb_id
          and catalog.metadata #>> '{tmdbValidation,valid}' = 'true'
          and nullif(btrim(coalesce(
            catalog.metadata #>> '{i18n,fr,overview}',
            catalog.metadata #>> '{tmdb,overview}',
            catalog.metadata ->> 'overview',
            catalog.metadata #>> '{i18n,en,overview}',
            ''
          )), '') is not null
      )
      and (
        cache.external_id is null
        or (
          cache.overview_status = 'resolved'
          and nullif(btrim(cache.provider_overview), '') is not null
        )
        or (
          cache.overview_status in ('missing', 'retry')
          and coalesce(cache.overview_retry_at, '-infinity'::timestamptz)
            <= clock_timestamp()
        )
        or cache.overview_status is null
      )
  )
  select
    eligible.external_id,
    eligible.media_item_id,
    eligible.title_id,
    eligible.raw_title,
    eligible.cached_overview,
    eligible.cached_status
  from eligible
  where eligible.title_rank = 1
  order by
    (eligible.cached_status = 'resolved') desc,
    coalesce(eligible.added_at, 0) desc,
    eligible.title_id
  limit greatest(1, least(8, coalesce(p_limit, 4)))
$function$;

revoke all on function public.claim_source_provider_overview_candidates(uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.claim_source_provider_overview_candidates(uuid, uuid, integer)
  to service_role;

-- Record a provisional provider synopsis only inside the source/account that
-- fetched it. No canonical provider cache or global catalog title is written.
create or replace function public.record_source_provider_overview_outcome(
  p_user_id uuid,
  p_source_id uuid,
  p_external_id text,
  p_provider_overview text,
  p_provider_tmdb_id text,
  p_provider_imdb_id text,
  p_outcome text,
  p_retry_at timestamptz default null,
  p_provenance jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_cache_key text;
  v_overview text;
  v_tmdb_id text;
  v_imdb_id text;
  v_outcome text;
  v_media_updated integer := 0;
  v_variants_updated integer := 0;
  v_titles_updated integer := 0;
begin
  if p_user_id is null
     or p_source_id is null
     or coalesce(btrim(p_external_id), '') = '' then
    raise exception 'invalid source overview identity' using errcode = '22023';
  end if;

  select 'source:' || source.id::text
    into v_cache_key
  from public.cloud_sources source
  where source.id = p_source_id
    and source.user_id = p_user_id
    and source.source_type = 'xtream'
    and source.deleted_at is null
    and not exists (
      select 1
      from public.catalog_source_provider_identities verified
      where verified.source_id = source.id
        and verified.user_id = source.user_id
    );

  if v_cache_key is null then
    raise exception 'source is not eligible for provisional overview recording'
      using errcode = '55000';
  end if;

  v_overview := nullif(btrim(left(coalesce(p_provider_overview, ''), 4000)), '');
  if v_overview ~* '^(?:n/?a|none|null|undefined|no (?:description|overview|plot)(?: available)?|no summary available yet\.?)$' then
    v_overview := null;
  end if;
  v_tmdb_id := nullif(regexp_replace(coalesce(p_provider_tmdb_id, ''), '[^0-9]', '', 'g'), '');
  if v_tmdb_id ~ '^0+$' then v_tmdb_id := null; end if;
  v_imdb_id := lower(nullif(btrim(coalesce(p_provider_imdb_id, '')), ''));
  if v_imdb_id !~ '^tt[0-9]+$' then v_imdb_id := null; end if;
  v_outcome := case
    when p_outcome = 'resolved' and v_overview is not null then 'resolved'
    when p_outcome = 'retry' then 'retry'
    else 'missing'
  end;

  insert into public.catalog_file_tracks as cache (
    server_host, item_type, external_id,
    provider_tmdb_id, provider_imdb_id, ids_resolved_at,
    provider_overview, overview_status, overview_attempted_at,
    overview_retry_at, overview_provenance, updated_at
  ) values (
    v_cache_key, 'movie', btrim(p_external_id),
    v_tmdb_id, v_imdb_id, clock_timestamp(),
    v_overview, v_outcome, clock_timestamp(),
    case when v_outcome = 'resolved' then null else p_retry_at end,
    coalesce(p_provenance, '{}'::jsonb)
      || jsonb_build_object('scope', 'source-local'),
    clock_timestamp()
  )
  on conflict (server_host, item_type, external_id) do update
    set provider_tmdb_id = coalesce(excluded.provider_tmdb_id, cache.provider_tmdb_id),
        provider_imdb_id = coalesce(excluded.provider_imdb_id, cache.provider_imdb_id),
        ids_resolved_at = clock_timestamp(),
        provider_overview = case
          when excluded.overview_status = 'resolved' then excluded.provider_overview
          else cache.provider_overview
        end,
        overview_status = case
          when cache.overview_status = 'resolved' and excluded.overview_status <> 'resolved'
            then cache.overview_status
          else excluded.overview_status
        end,
        overview_attempted_at = clock_timestamp(),
        overview_retry_at = case
          when cache.overview_status = 'resolved' or excluded.overview_status = 'resolved'
            then null
          else excluded.overview_retry_at
        end,
        overview_provenance = case
          when cache.overview_status = 'resolved' and excluded.overview_status <> 'resolved'
            then cache.overview_provenance
          else excluded.overview_provenance
        end,
        updated_at = clock_timestamp();

  if v_outcome <> 'resolved' then
    return jsonb_build_object(
      'scope', 'source-local',
      'cached', true,
      'outcome', v_outcome,
      'media_items_updated', 0,
      'variants_updated', 0,
      'titles_updated', 0
    );
  end if;

  update public.cloud_media_items media
     set metadata = coalesce(media.metadata, '{}'::jsonb)
       || jsonb_build_object('overview', v_overview)
       || case
            when v_tmdb_id is not null and coalesce(media.metadata ->> 'providerTmdbId', '') = ''
              then jsonb_build_object('providerTmdbId', v_tmdb_id)
            else '{}'::jsonb
          end
       || case
            when v_imdb_id is not null and coalesce(media.metadata ->> 'providerImdbId', '') = ''
              then jsonb_build_object('providerImdbId', v_imdb_id)
            else '{}'::jsonb
          end,
         updated_at = clock_timestamp()
   where media.source_id = p_source_id
     and media.user_id = p_user_id
     and media.item_type = 'movie'
     and media.external_id = btrim(p_external_id)
     and media.available = true
     and nullif(btrim(coalesce(
       media.metadata ->> 'overview',
       media.metadata ->> 'plot',
       media.metadata ->> 'description',
       ''
     )), '') is null;
  get diagnostics v_media_updated = row_count;

  update public.cloud_title_variants variant
     set metadata = coalesce(variant.metadata, '{}'::jsonb)
       || jsonb_build_object('overview', v_overview)
       || case
            when v_tmdb_id is not null and coalesce(variant.metadata ->> 'providerTmdbId', '') = ''
              then jsonb_build_object('providerTmdbId', v_tmdb_id)
            else '{}'::jsonb
          end
       || case
            when v_imdb_id is not null and coalesce(variant.metadata ->> 'providerImdbId', '') = ''
              then jsonb_build_object('providerImdbId', v_imdb_id)
            else '{}'::jsonb
          end,
         updated_at = clock_timestamp()
   where variant.source_id = p_source_id
     and variant.user_id = p_user_id
     and variant.item_type = 'movie'
     and variant.external_id = btrim(p_external_id)
     and nullif(btrim(coalesce(
       variant.metadata ->> 'overview',
       variant.metadata ->> 'plot',
       variant.metadata ->> 'description',
       ''
     )), '') is null;
  get diagnostics v_variants_updated = row_count;

  -- Avoid the cloud_titles -> catalog_titles mirror path for canonical TMDB
  -- titles. Their source-local variant now carries the fallback instead.
  with affected_titles as materialized (
    select distinct variant.title_id
    from public.cloud_title_variants variant
    where variant.source_id = p_source_id
      and variant.user_id = p_user_id
      and variant.item_type = 'movie'
      and variant.external_id = btrim(p_external_id)
      and variant.title_id is not null
  )
  update public.cloud_titles title
     set metadata = coalesce(title.metadata, '{}'::jsonb)
       || jsonb_build_object('overview', v_overview),
         updated_at = clock_timestamp()
    from affected_titles affected
   where title.id = affected.title_id
     and title.user_id = p_user_id
     and title.item_type = 'movie'
     and (
       title.provider_tmdb_id is null
       or title.provider_tmdb_id = ''
       or title.provider_tmdb_id ~ '^(tt)?0+$'
     )
     and nullif(btrim(coalesce(
       title.metadata #>> '{i18n,fr,overview}',
       title.metadata #>> '{tmdb,overview}',
       title.metadata ->> 'overview',
       ''
     )), '') is null;
  get diagnostics v_titles_updated = row_count;

  return jsonb_build_object(
    'scope', 'source-local',
    'cached', true,
    'outcome', v_outcome,
    'media_items_updated', v_media_updated,
    'variants_updated', v_variants_updated,
    'titles_updated', greatest(v_titles_updated, v_variants_updated)
  );
end
$function$;

revoke all on function public.record_source_provider_overview_outcome(
  uuid, uuid, text, text, text, text, text, timestamptz, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.record_source_provider_overview_outcome(
  uuid, uuid, text, text, text, text, text, timestamptz, jsonb
) to service_role;

-- Generation-fenced wrapper matching callActiveCatalogGenerationRpc.
create or replace function public.record_source_provider_overview_outcome(
  p_user_id uuid,
  p_source_id uuid,
  p_external_id text,
  p_provider_overview text,
  p_provider_tmdb_id text,
  p_provider_imdb_id text,
  p_outcome text,
  p_retry_at timestamptz,
  p_provenance jsonb,
  p_generation_id uuid,
  p_head_revision bigint,
  p_config_revision bigint,
  p_source_visibility_epoch bigint,
  p_user_visibility_epoch bigint
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_result jsonb;
begin
  perform public.norva_set_catalog_delete_proof(
    p_source_id, p_user_id, p_generation_id,
    p_head_revision, p_config_revision,
    p_source_visibility_epoch, p_user_visibility_epoch
  );
  perform set_config('norva.legacy_catalog_source_id', p_source_id::text, true);
  perform set_config('norva.legacy_catalog_user_id', p_user_id::text, true);
  perform set_config('norva.legacy_catalog_generation_id', p_generation_id::text, true);
  perform set_config('norva.legacy_catalog_writer_fenced', 'on', true);
  v_result := public.record_source_provider_overview_outcome(
    p_user_id, p_source_id, p_external_id, p_provider_overview,
    p_provider_tmdb_id, p_provider_imdb_id, p_outcome,
    p_retry_at, p_provenance
  );
  perform set_config('norva.legacy_catalog_writer_fenced', 'off', true);
  return v_result;
end
$function$;

revoke all on function public.record_source_provider_overview_outcome(
  uuid, uuid, text, text, text, text, text, timestamptz, jsonb,
  uuid, bigint, bigint, bigint, bigint
) from public, anon, authenticated, service_role;
grant execute on function public.record_source_provider_overview_outcome(
  uuid, uuid, text, text, text, text, text, timestamptz, jsonb,
  uuid, bigint, bigint, bigint, bigint
) to service_role;

-- Add provisional progress to the verified-source admin contract without
-- exposing provider keys, samples or raw resolver errors.
create or replace function public.admin_identities_v3()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_base jsonb;
  v_unresolved jsonb;
  v_recent jsonb;
  v_provisional_count bigint;
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  v_base := public.admin_identities_v2();

  select coalesce(
    jsonb_agg(
      item.value || case when candidate.source_id is null then '{}'::jsonb else
        jsonb_build_object(
          'resolution_state', 'provisional',
          'evidence_count', candidate.evidence_count,
          'required_evidence', candidate.required_evidence,
          'resolution_last_attempt_at', candidate.last_attempt_at
        ) end
      order by item.ordinality
    ),
    '[]'::jsonb
  ) into v_unresolved
  from jsonb_array_elements(coalesce(v_base -> 'unresolved_sources', '[]'::jsonb))
    with ordinality as item(value, ordinality)
  left join public.catalog_source_provider_identity_candidates candidate
    on candidate.source_id = nullif(item.value ->> 'source_id', '')::uuid;

  select coalesce(
    jsonb_agg(
      item.value || case when candidate.source_id is null then '{}'::jsonb else
        jsonb_build_object(
          'resolution_state', 'provisional',
          'evidence_count', candidate.evidence_count,
          'required_evidence', candidate.required_evidence,
          'resolution_last_attempt_at', candidate.last_attempt_at
        ) end
      order by item.ordinality
    ),
    '[]'::jsonb
  ) into v_recent
  from jsonb_array_elements(coalesce(v_base -> 'recent_sources', '[]'::jsonb))
    with ordinality as item(value, ordinality)
  left join public.catalog_source_provider_identity_candidates candidate
    on candidate.source_id = nullif(item.value ->> 'source_id', '')::uuid;

  select count(*)
    into v_provisional_count
  from public.catalog_source_provider_identity_candidates candidate
  join public.cloud_sources source
    on source.id = candidate.source_id
   and source.user_id = candidate.user_id
  where source.deleted_at is null;

  return v_base
    || jsonb_build_object(
      'schema_version', 3,
      'unresolved_sources', v_unresolved,
      'recent_sources', v_recent,
      'summary', coalesce(v_base -> 'summary', '{}'::jsonb)
        || jsonb_build_object('provisional_source_count', v_provisional_count)
    );
end
$function$;

revoke all on function public.admin_identities_v3()
  from public, anon, authenticated;
grant execute on function public.admin_identities_v3()
  to authenticated;

comment on function public.admin_identities_v3() is
  'Admin-only identity graph with source-local provisional evidence progress. Provider keys and raw resolver details are omitted.';

notify pgrst, 'reload schema';
commit;
