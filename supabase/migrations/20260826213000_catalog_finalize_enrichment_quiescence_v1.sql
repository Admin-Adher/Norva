begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- A source finalizer owns an account-wide catalogue write window.  The durable
-- lease is still per source, but every competing enrichment lane is fenced by
-- user_id while at least one non-expired finalizer lease exists.
create index if not exists cloud_source_finalize_leases_user_until_idx
  on public.cloud_source_finalize_leases(user_id, lease_until desc);

-- The visibility epoch row is the transaction mutex shared by finalization and
-- enrichment writers.  Taking it before the lease CAS closes the gap between
-- "no lease observed" and the first finalizer write.
create or replace function public.norva_claim_source_finalize_lease(
  p_source_id uuid,
  p_user_id uuid,
  p_lease_token uuid,
  p_ttl_seconds integer default 240
) returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_claimed boolean := false;
  v_until timestamptz;
begin
  if p_source_id is null
     or p_user_id is null
     or p_lease_token is null
     or p_ttl_seconds not between 30 and 900 then
    return false;
  end if;

  insert into public.cloud_user_catalog_visibility_epochs(
    user_id, visibility_epoch, updated_at
  ) values (p_user_id, 1, statement_timestamp())
  on conflict (user_id) do nothing;

  perform 1
  from public.cloud_user_catalog_visibility_epochs epoch
  where epoch.user_id = p_user_id
  for update;

  -- Existing dynamic enrichment work must drain before finalization begins.
  -- The dynamic claimant takes the same epoch mutex before creating this lease,
  -- so either the enrichment claim wins completely or the finalizer does.
  if exists (
    select 1
    from public.catalog_enrichment_dispatch_leases lease
    where lease.lease_key = 'user:' || p_user_id::text
      and lease.expires_at > statement_timestamp()
  ) then
    return false;
  end if;

  v_until := statement_timestamp() + make_interval(secs => p_ttl_seconds);
  insert into public.cloud_source_finalize_leases as lease(
    source_id, user_id, lease_token, lease_until, updated_at
  )
  select
    p_source_id, p_user_id, p_lease_token, v_until, statement_timestamp()
  where exists (
    select 1
    from public.cloud_sources source
    where source.id = p_source_id
      and source.user_id = p_user_id
      and source.deleted_at is null
      and source.enabled
  )
  on conflict (source_id) do update set
    user_id = excluded.user_id,
    lease_token = excluded.lease_token,
    lease_until = excluded.lease_until,
    updated_at = excluded.updated_at
  where lease.lease_until <= statement_timestamp()
  returning true into v_claimed;

  return coalesce(v_claimed, false);
end
$function$;

create or replace function public.norva_renew_source_finalize_lease(
  p_source_id uuid,
  p_user_id uuid,
  p_lease_token uuid,
  p_ttl_seconds integer default 240
) returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_claimed boolean := false;
begin
  if p_source_id is null
     or p_user_id is null
     or p_lease_token is null
     or p_ttl_seconds not between 30 and 900 then
    return false;
  end if;

  perform 1
  from public.cloud_user_catalog_visibility_epochs epoch
  where epoch.user_id = p_user_id
  for update;
  if not found then
    return false;
  end if;

  -- Never resurrect an expired lease.  A successor must use the full claim
  -- path again and re-prove that older enrichment work has drained.
  update public.cloud_source_finalize_leases lease
  set lease_until = statement_timestamp() + make_interval(secs => p_ttl_seconds),
      updated_at = statement_timestamp()
  where lease.source_id = p_source_id
    and lease.user_id = p_user_id
    and lease.lease_token = p_lease_token
    and lease.lease_until > statement_timestamp()
  returning true into v_claimed;

  return coalesce(v_claimed, false);
end
$function$;

revoke all on function public.norva_claim_source_finalize_lease(
  uuid,uuid,uuid,integer
) from public, anon, authenticated;
revoke all on function public.norva_renew_source_finalize_lease(
  uuid,uuid,uuid,integer
) from public, anon, authenticated;
grant execute on function public.norva_claim_source_finalize_lease(
  uuid,uuid,uuid,integer
) to service_role;
grant execute on function public.norva_renew_source_finalize_lease(
  uuid,uuid,uuid,integer
) to service_role;

-- Legacy catalogue enrichment is still scheduled directly from pg_cron.  Walk
-- users in deterministic order and take the same epoch mutex before selecting
-- any of their rows.  The second lease check is deliberately under that lock.
create or replace function public.cloud_enrich_titles_from_catalog(
  p_limit integer default 5000
) returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_limit integer := greatest(1, least(5000, coalesce(p_limit, 5000)));
  v_total integer := 0;
  v_updated integer := 0;
  v_user_id uuid;
begin
  for v_user_id in
    select distinct title.user_id
    from public.cloud_titles title
    join public.catalog_titles catalog
      on catalog.item_type = title.item_type
     and catalog.provider_tmdb_id = title.provider_tmdb_id
    where title.match_status = 'provider_unverified'
      and title.metadata -> 'tmdbValidation' is null
      and catalog.metadata #>> '{tmdbValidation,valid}' = 'true'
      and nullif(catalog.title, '') is not null
      and not exists (
        select 1
        from public.cloud_source_finalize_leases lease
        where lease.user_id = title.user_id
          and lease.lease_until > statement_timestamp()
      )
    order by title.user_id
  loop
    exit when v_total >= v_limit;

    insert into public.cloud_user_catalog_visibility_epochs(
      user_id, visibility_epoch, updated_at
    ) values (v_user_id, 1, statement_timestamp())
    on conflict (user_id) do nothing;
    perform 1
    from public.cloud_user_catalog_visibility_epochs epoch
    where epoch.user_id = v_user_id
    for update;

    if exists (
      select 1
      from public.cloud_source_finalize_leases lease
      where lease.user_id = v_user_id
        and lease.lease_until > statement_timestamp()
    ) then
      continue;
    end if;

    with batch as (
      select
        title.id,
        catalog.title as catalog_title,
        catalog.poster_url as catalog_poster_url,
        catalog.backdrop_url as catalog_backdrop_url,
        catalog.metadata as catalog_metadata
      from public.cloud_titles title
      join public.catalog_titles catalog
        on catalog.item_type = title.item_type
       and catalog.provider_tmdb_id = title.provider_tmdb_id
      where title.user_id = v_user_id
        and title.match_status = 'provider_unverified'
        and title.metadata -> 'tmdbValidation' is null
        and catalog.metadata #>> '{tmdbValidation,valid}' = 'true'
        and nullif(catalog.title, '') is not null
      order by title.id
      limit v_limit - v_total
      for update of title skip locked
    )
    update public.cloud_titles title
    set title = batch.catalog_title,
        poster_url = coalesce(nullif(title.poster_url, ''), batch.catalog_poster_url),
        backdrop_url = coalesce(
          nullif(title.backdrop_url, ''), batch.catalog_backdrop_url
        ),
        match_status = 'provider_verified',
        metadata = title.metadata || jsonb_strip_nulls(jsonb_build_object(
          'tmdb', batch.catalog_metadata -> 'tmdb',
          'i18n', batch.catalog_metadata -> 'i18n',
          'tmdbValidation', batch.catalog_metadata -> 'tmdbValidation'
        ))
    from batch
    where title.id = batch.id;

    get diagnostics v_updated = row_count;
    v_total := v_total + v_updated;
  end loop;

  return v_total;
end
$function$;

revoke all on function public.cloud_enrich_titles_from_catalog(integer)
  from public, anon, authenticated;
grant execute on function public.cloud_enrich_titles_from_catalog(integer)
  to service_role;

-- Owner-snapshot selectors skip only the account being finalized.  An empty
-- due set makes the durable global checkpoint advance to the next owner; no
-- provider call and no payload write is attempted for the fenced account.
create or replace function public.norva_catalog_background_owner_due_rows(
  p_mode text,
  p_snapshot_id uuid,
  p_retry_before timestamptz,
  p_last_attempted_at timestamptz,
  p_last_title_id uuid,
  p_limit integer
) returns table(title_id uuid, attempted_at timestamptz)
language plpgsql
stable
security definer
rows 500
set search_path = ''
as $function$
begin
  if p_mode = 'year_pending' then
    return query
    select owner_row.title_id, owner_row.year_backfill_attempted_at
    from public.cloud_catalog_background_owner_snapshot_rows owner_row
    where owner_row.snapshot_id = p_snapshot_id
      and owner_row.is_present
      and owner_row.release_year is null
      and owner_row.provider_tmdb_id is not null
      and coalesce(
        owner_row.year_backfill_attempted_at, '-infinity'::timestamptz
      ) < p_retry_before
      and not exists (
        select 1
        from public.cloud_source_finalize_leases lease
        where lease.user_id = owner_row.user_id
          and lease.lease_until > statement_timestamp()
      )
      and (
        p_last_title_id is null
        or row(
          coalesce(owner_row.year_backfill_attempted_at,
            '-infinity'::timestamptz),
          owner_row.title_id
        ) > row(
          coalesce(p_last_attempted_at, '-infinity'::timestamptz),
          p_last_title_id
        )
      )
    order by coalesce(
      owner_row.year_backfill_attempted_at, '-infinity'::timestamptz
    ), owner_row.title_id
    limit p_limit;
  elsif p_mode = 'revalidate_pending' then
    return query
    select owner_row.title_id, owner_row.revalidate_attempted_at
    from public.cloud_catalog_background_owner_snapshot_rows owner_row
    where owner_row.snapshot_id = p_snapshot_id
      and owner_row.is_present
      and owner_row.match_status in ('provider_unverified','weak')
      and owner_row.provider_tmdb_id is not null
      and owner_row.provider_tmdb_id <> '0'
      and coalesce(
        owner_row.revalidate_attempted_at, '-infinity'::timestamptz
      ) < p_retry_before
      and not exists (
        select 1
        from public.cloud_source_finalize_leases lease
        where lease.user_id = owner_row.user_id
          and lease.lease_until > statement_timestamp()
      )
      and (
        p_last_title_id is null
        or row(
          coalesce(owner_row.revalidate_attempted_at,
            '-infinity'::timestamptz),
          owner_row.title_id
        ) > row(
          coalesce(p_last_attempted_at, '-infinity'::timestamptz),
          p_last_title_id
        )
      )
    order by coalesce(
      owner_row.revalidate_attempted_at, '-infinity'::timestamptz
    ), owner_row.title_id
    limit p_limit;
  elsif p_mode = 'search_pending' then
    return query
    select owner_row.title_id, owner_row.search_match_attempted_at
    from public.cloud_catalog_background_owner_snapshot_rows owner_row
    where owner_row.snapshot_id = p_snapshot_id
      and owner_row.is_present
      and owner_row.match_status = 'unmatched'
      and coalesce(
        owner_row.search_match_attempted_at, '-infinity'::timestamptz
      ) < p_retry_before
      and not exists (
        select 1
        from public.cloud_source_finalize_leases lease
        where lease.user_id = owner_row.user_id
          and lease.lease_until > statement_timestamp()
      )
      and (
        p_last_title_id is null
        or row(
          coalesce(owner_row.search_match_attempted_at,
            '-infinity'::timestamptz),
          owner_row.title_id
        ) > row(
          coalesce(p_last_attempted_at, '-infinity'::timestamptz),
          p_last_title_id
        )
      )
    order by coalesce(
      owner_row.search_match_attempted_at, '-infinity'::timestamptz
    ), owner_row.title_id
    limit p_limit;
  else
    raise exception 'invalid catalog background owner mode'
      using errcode = '22023';
  end if;
end
$function$;

revoke all on function public.norva_catalog_background_owner_due_rows(
  text,uuid,timestamptz,timestamptz,uuid,integer
) from public, anon, authenticated, service_role;
grant execute on function public.norva_catalog_background_owner_due_rows(
  text,uuid,timestamptz,timestamptz,uuid,integer
) to service_role;

-- If a finalizer starts after a background page was selected, invalidate that
-- page and its lease before handing the mode to the next worker.  No outcome
-- was committed, so restarting from the durable owner snapshot is lossless.
create or replace function public.norva_claim_catalog_title_background_mode(
  p_mode text,
  p_worker text,
  p_lease_seconds integer,
  p_retry_before timestamptz
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_checkpoint public.cloud_catalog_background_mode_checkpoints%rowtype;
begin
  perform public.norva_credential_require_service_role();
  if p_mode not in ('year_pending','revalidate_pending','search_pending')
     or p_worker is null or btrim(p_worker) = '' or length(p_worker) > 160
     or p_lease_seconds not between 30 and 900
     or p_retry_before is null then
    raise exception 'invalid catalog background mode claim arguments'
      using errcode = '22023';
  end if;

  select checkpoint.* into v_checkpoint
  from public.cloud_catalog_background_mode_checkpoints checkpoint
  where checkpoint.mode = p_mode
  for update;

  if v_checkpoint.owner_user_id is not null
     and exists (
       select 1
       from public.cloud_source_finalize_leases lease
       where lease.user_id = v_checkpoint.owner_user_id
         and lease.lease_until > statement_timestamp()
     ) then
    update public.cloud_catalog_background_mode_checkpoints checkpoint
    set state = 'pending',
        retry_before = null,
        owner_user_id = null,
        snapshot_id = null,
        user_visibility_epoch = null,
        last_attempted_at = null,
        last_title_id = null,
        inflight_items = '[]'::jsonb,
        inflight_last_attempted_at = null,
        inflight_last_title_id = null,
        inflight_owner_exhausted = false,
        inflight_byte_count = 0,
        lease_owner = null,
        lease_until = null,
        revision = checkpoint.revision + 1,
        updated_at = statement_timestamp()
    where checkpoint.mode = p_mode
    returning * into v_checkpoint;
  end if;

  if v_checkpoint.state = 'processing'
     and v_checkpoint.lease_until > now()
     and v_checkpoint.lease_owner = p_worker then
    return jsonb_build_object(
      'contract','catalog-title-background-mode-v1',
      'mode',p_mode,
      'worker',p_worker,
      'leaseSequence',v_checkpoint.lease_sequence,
      'checkpointRevision',v_checkpoint.revision,
      'retryBefore',v_checkpoint.retry_before,
      'replayed',true
    );
  end if;
  if v_checkpoint.state = 'processing'
     and v_checkpoint.lease_until > now() then
    raise exception 'catalog background mode is already leased'
      using errcode = '55P03';
  end if;

  update public.cloud_catalog_background_mode_checkpoints checkpoint
  set state = 'processing',
      retry_before = case when checkpoint.state = 'pending'
        then p_retry_before else checkpoint.retry_before end,
      owner_user_id = case when checkpoint.state = 'pending'
        then null else checkpoint.owner_user_id end,
      snapshot_id = case when checkpoint.state = 'pending'
        then null else checkpoint.snapshot_id end,
      user_visibility_epoch = case when checkpoint.state = 'pending'
        then null else checkpoint.user_visibility_epoch end,
      last_attempted_at = case when checkpoint.state = 'pending'
        then null else checkpoint.last_attempted_at end,
      last_title_id = case when checkpoint.state = 'pending'
        then null else checkpoint.last_title_id end,
      inflight_items = case when checkpoint.state = 'pending'
        then '[]'::jsonb else checkpoint.inflight_items end,
      inflight_last_attempted_at = case when checkpoint.state = 'pending'
        then null else checkpoint.inflight_last_attempted_at end,
      inflight_last_title_id = case when checkpoint.state = 'pending'
        then null else checkpoint.inflight_last_title_id end,
      inflight_owner_exhausted = case when checkpoint.state = 'pending'
        then false else checkpoint.inflight_owner_exhausted end,
      inflight_byte_count = case when checkpoint.state = 'pending'
        then 0 else checkpoint.inflight_byte_count end,
      lease_sequence = checkpoint.lease_sequence + 1,
      lease_owner = p_worker,
      lease_until = now() + make_interval(secs => p_lease_seconds),
      revision = checkpoint.revision + 1,
      updated_at = now()
  where checkpoint.mode = p_mode
  returning * into v_checkpoint;

  return jsonb_build_object(
    'contract','catalog-title-background-mode-v1',
    'mode',p_mode,
    'worker',p_worker,
    'leaseSequence',v_checkpoint.lease_sequence,
    'checkpointRevision',v_checkpoint.revision,
    'retryBefore',v_checkpoint.retry_before,
    'replayed',false
  );
end
$function$;

revoke all on function public.norva_claim_catalog_title_background_mode(
  text,text,integer,timestamptz
) from public, anon, authenticated, service_role;
grant execute on function public.norva_claim_catalog_title_background_mode(
  text,text,integer,timestamptz
) to service_role;

-- Keep the proven v3 payload writer intact behind a transaction-level fence.
-- The wrapper takes generation -> epoch in the same order as the core writer,
-- then checks the durable finalizer lease while the epoch mutex is held.
alter function public.norva_apply_catalog_title_background_result(
  text,uuid,uuid,text,bigint,timestamptz,uuid,jsonb
) rename to norva_apply_catalog_title_background_result_core_v3;

revoke all on function public.norva_apply_catalog_title_background_result_core_v3(
  text,uuid,uuid,text,bigint,timestamptz,uuid,jsonb
) from public, anon, authenticated, service_role;

create or replace function public.norva_apply_catalog_title_background_result(
  p_mode text,
  p_user_id uuid,
  p_title_id uuid,
  p_storage_kind text,
  p_expected_visibility_epoch bigint,
  p_expected_payload_updated_at timestamptz,
  p_expected_display_generation_id uuid,
  p_result jsonb
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_result jsonb;
  v_result_epoch bigint;
  v_movie_summary public.cloud_catalog_facet_summary%rowtype;
  v_series_summary public.cloud_catalog_facet_summary%rowtype;
  v_movie_summary_found boolean := false;
  v_series_summary_found boolean := false;
begin
  perform public.norva_credential_require_service_role();

  -- Preserve the core writer's validation/error contract for malformed calls.
  if p_user_id is null or p_expected_visibility_epoch is null then
    return public.norva_apply_catalog_title_background_result_core_v3(
      p_mode,
      p_user_id,
      p_title_id,
      p_storage_kind,
      p_expected_visibility_epoch,
      p_expected_payload_updated_at,
      p_expected_display_generation_id,
      p_result
    );
  end if;

  if p_expected_display_generation_id is not null then
    perform 1
    from public.cloud_source_catalog_generations generation
    where generation.id = p_expected_display_generation_id
      and generation.user_id = p_user_id
      and generation.state = 'active'
    for update;
  end if;

  insert into public.cloud_user_catalog_visibility_epochs(
    user_id, visibility_epoch, updated_at
  ) values (p_user_id, 1, statement_timestamp())
  on conflict (user_id) do nothing;
  perform 1
  from public.cloud_user_catalog_visibility_epochs epoch
  where epoch.user_id = p_user_id
  for update;

  if exists (
    select 1
    from public.cloud_source_finalize_leases lease
    where lease.user_id = p_user_id
      and lease.lease_until > statement_timestamp()
  ) then
    raise exception 'catalog background write deferred during source finalization'
      using errcode = '40001', detail = 'reason=catalog_finalize_active';
  end if;

  -- Background metadata changes must not punch a hole in the tiny catalogue
  -- read models.  The proven v3 writer invalidates the rows conservatively;
  -- retain their last complete payload in this transaction, then advance only
  -- the rail visibility marker to the writer's new epoch.  Title membership is
  -- unchanged by this RPC, so old candidate ids remain safe and hydration still
  -- rechecks the current visibility epoch before returning any card.
  select summary.* into v_movie_summary
  from public.cloud_catalog_facet_summary summary
  where summary.user_id = p_user_id and summary.item_type = 'movie';
  v_movie_summary_found := found;

  select summary.* into v_series_summary
  from public.cloud_catalog_facet_summary summary
  where summary.user_id = p_user_id and summary.item_type = 'series';
  v_series_summary_found := found;

  v_result := public.norva_apply_catalog_title_background_result_core_v3(
    p_mode,
    p_user_id,
    p_title_id,
    p_storage_kind,
    p_expected_visibility_epoch,
    p_expected_payload_updated_at,
    p_expected_display_generation_id,
    p_result
  );

  if coalesce((v_result ->> 'visibleChanged')::boolean, false) then
    v_result_epoch := (v_result ->> 'visibilityEpoch')::bigint;

    if v_movie_summary_found then
      v_movie_summary.genre_rail_visibility_epoch := v_result_epoch;
      insert into public.cloud_catalog_facet_summary
      select (v_movie_summary).*
      on conflict (user_id, item_type) do nothing;
    end if;

    if v_series_summary_found then
      v_series_summary.genre_rail_visibility_epoch := v_result_epoch;
      insert into public.cloud_catalog_facet_summary
      select (v_series_summary).*
      on conflict (user_id, item_type) do nothing;
    end if;
  end if;

  return v_result;
end
$function$;

revoke all on function public.norva_apply_catalog_title_background_result(
  text,uuid,uuid,text,bigint,timestamptz,uuid,jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.norva_apply_catalog_title_background_result(
  text,uuid,uuid,text,bigint,timestamptz,uuid,jsonb
) to service_role;

-- Dynamic enrichment claims use the same user epoch mutex as finalizer claims.
-- This makes "dispatch lease or finalize lease" a real either/or transaction,
-- rather than two independent observations that can both win.
create or replace function public.claim_catalog_enrichment_sources(
  p_limit integer default 2,
  p_lease_seconds integer default 240
) returns table(
  source_id uuid,
  user_id uuid,
  claim_token uuid,
  failure_count integer,
  dispatch_count integer
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
#variable_conflict use_column
declare
  candidate record;
  claimed_users uuid[] := '{}'::uuid[];
  claimed_identities text[] := '{}'::text[];
  batch_limit integer := greatest(1, least(8, coalesce(p_limit, 2)));
  lease_seconds integer :=
    greatest(60, least(1800, coalesce(p_lease_seconds, 1200)));
  claimed_count integer := 0;
  token uuid;
  user_lease_claimed boolean;
  identity_lease_claimed boolean;
  user_lease_key text;
  provider_lease_key text;
begin
  delete from public.catalog_enrichment_dispatch_leases lease
  where lease.expires_at < clock_timestamp() - interval '1 day';

  insert into public.catalog_enrichment_source_schedule as schedule (
    source_id,
    user_id,
    next_run_at,
    updated_at
  )
  select
    source.id,
    source.user_id,
    clock_timestamp(),
    clock_timestamp()
  from public.cloud_sources source
  where source.sync_status = 'ready'
    and source.enabled = true
    and source.deleted_at is null
    and source.source_type in (
      'xtream', 'm3u', 'jellyfin', 'plex', 'local', 'custom'
    )
    and not exists (
      select 1
      from public.cloud_source_finalize_leases finalize
      where finalize.user_id = source.user_id
        and finalize.lease_until > statement_timestamp()
    )
    and exists (
      select 1
      from public.cloud_title_variants variant
      where variant.source_id = source.id
        and variant.user_id = source.user_id
        and variant.item_type in ('movie', 'series')
    )
  on conflict on constraint catalog_enrichment_source_schedule_pkey do update
  set user_id = excluded.user_id,
      updated_at = case
        when schedule.user_id is distinct from excluded.user_id
          then excluded.updated_at
        else schedule.updated_at
      end
  where schedule.user_id is distinct from excluded.user_id;

  for candidate in
    select
      schedule.source_id,
      schedule.user_id,
      schedule.consecutive_failures,
      schedule.dispatch_count,
      coalesce(
        'identity:' || verified_identity.identity_id::text,
        'source:' || source.id::text
      ) as identity_key
    from public.catalog_enrichment_source_schedule schedule
    join public.cloud_sources source
      on source.id = schedule.source_id
     and source.user_id = schedule.user_id
    left join public.catalog_source_provider_identities verified_identity
      on verified_identity.source_id = source.id
     and verified_identity.user_id = source.user_id
    where source.sync_status = 'ready'
      and source.enabled = true
      and source.deleted_at is null
      and not exists (
        select 1
        from public.cloud_source_finalize_leases finalize
        where finalize.user_id = source.user_id
          and finalize.lease_until > statement_timestamp()
      )
      and exists (
        select 1
        from public.cloud_title_variants eligible_variant
        where eligible_variant.source_id = source.id
          and eligible_variant.user_id = source.user_id
          and eligible_variant.item_type in ('movie', 'series')
      )
      and schedule.next_run_at <= clock_timestamp()
      and (
        schedule.lease_until is null
        or schedule.lease_until <= clock_timestamp()
      )
    order by schedule.next_run_at, schedule.source_id
    for update of schedule skip locked
  loop
    if candidate.user_id = any(claimed_users)
       or candidate.identity_key = any(claimed_identities) then
      continue;
    end if;

    insert into public.cloud_user_catalog_visibility_epochs(
      user_id, visibility_epoch, updated_at
    ) values (candidate.user_id, 1, statement_timestamp())
    on conflict (user_id) do nothing;
    perform 1
    from public.cloud_user_catalog_visibility_epochs epoch
    where epoch.user_id = candidate.user_id
    for update;

    -- Recheck under the mutex: the candidate query is only an optimization,
    -- while this predicate is the actual authorization fence.
    if exists (
      select 1
      from public.cloud_source_finalize_leases finalize
      where finalize.user_id = candidate.user_id
        and finalize.lease_until > statement_timestamp()
    ) then
      claimed_users := array_append(claimed_users, candidate.user_id);
      continue;
    end if;

    token := gen_random_uuid();
    user_lease_key := 'user:' || candidate.user_id::text;
    provider_lease_key := 'provider:' || candidate.identity_key;
    user_lease_claimed := false;
    identity_lease_claimed := false;

    insert into public.catalog_enrichment_dispatch_leases as lease (
      lease_key, claim_token, expires_at, updated_at
    ) values (
      user_lease_key,
      token,
      clock_timestamp() + make_interval(secs => lease_seconds),
      clock_timestamp()
    )
    on conflict (lease_key) do update
    set claim_token = excluded.claim_token,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
    where lease.expires_at <= clock_timestamp()
    returning true into user_lease_claimed;
    if not coalesce(user_lease_claimed, false) then
      claimed_users := array_append(claimed_users, candidate.user_id);
      continue;
    end if;

    insert into public.catalog_enrichment_dispatch_leases as lease (
      lease_key, claim_token, expires_at, updated_at
    ) values (
      provider_lease_key,
      token,
      clock_timestamp() + make_interval(secs => lease_seconds),
      clock_timestamp()
    )
    on conflict (lease_key) do update
    set claim_token = excluded.claim_token,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
    where lease.expires_at <= clock_timestamp()
    returning true into identity_lease_claimed;
    if not coalesce(identity_lease_claimed, false) then
      delete from public.catalog_enrichment_dispatch_leases lease
      where lease.lease_key = user_lease_key
        and lease.claim_token = token;
      claimed_identities := array_append(
        claimed_identities, candidate.identity_key
      );
      continue;
    end if;

    update public.catalog_enrichment_source_schedule schedule
    set lease_until = clock_timestamp() + make_interval(secs => lease_seconds),
        claim_token = token,
        last_claimed_at = clock_timestamp(),
        updated_at = clock_timestamp()
    where schedule.source_id = candidate.source_id;

    source_id := candidate.source_id;
    user_id := candidate.user_id;
    claim_token := token;
    failure_count := greatest(
      0, coalesce(candidate.consecutive_failures, 0)
    );
    dispatch_count := greatest(0, coalesce(candidate.dispatch_count, 0));
    return next;

    claimed_users := array_append(claimed_users, candidate.user_id);
    claimed_identities := array_append(
      claimed_identities, candidate.identity_key
    );
    claimed_count := claimed_count + 1;
    exit when claimed_count >= batch_limit;
  end loop;
end
$function$;

revoke all on function public.claim_catalog_enrichment_sources(
  integer,integer
) from public, anon, authenticated;
grant execute on function public.claim_catalog_enrichment_sources(
  integer,integer
) to service_role;

-- Keep the all-source facet path permanently on its tiny read model.  The
-- previous refresh omitted the fallback bucket, forcing every Movies/Series
-- load to run a whole-catalogue count for "Other" even when the summary was
-- fresh.  It also refreshed at the exact same 30-minute boundary used by the
-- reader; sub-second cron skew therefore opened a recurrent ~15-minute live-
-- aggregation window.  Refresh ahead of expiry, retain a bounded reader grace
-- period, and materialize every bucket including "autres".
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
    select variant.title_id, 'audio'::text as facet,
           lower(language_code) as language_code
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
      where summary.refreshed_at < now() - interval '20 minutes'
    ), missing as (
      select variant.user_id, variant.item_type,
             null::timestamptz as refreshed_at
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

create or replace function public.cloud_exact_language_counts(
  p_user_id uuid,
  p_item_type text
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_audio_counts jsonb;
  v_sub_counts jsonb;
begin
  select summary.audio_lang_counts, summary.subtitle_lang_counts
    into v_audio_counts, v_sub_counts
  from public.cloud_catalog_facet_summary summary
  where summary.user_id = p_user_id
    and summary.item_type = p_item_type
    and summary.refreshed_at >= now() - interval '60 minutes';

  if not found then
    select coalesce(jsonb_object_agg(language_code, n), '{}'::jsonb)
      into v_audio_counts
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
  end if;

  return jsonb_build_object(
    'audio', coalesce(v_audio_counts, '{}'::jsonb),
    'subtitles', coalesce(v_sub_counts, '{}'::jsonb)
  );
end
$function$;

revoke all on function public.cloud_refresh_facet_summary(uuid,text)
  from public, anon, authenticated;
revoke all on function public.cloud_refresh_all_facet_summaries(integer)
  from public, anon, authenticated;
revoke all on function public.cloud_exact_language_counts(uuid,text)
  from public, anon, authenticated;
grant execute on function public.cloud_refresh_facet_summary(uuid,text)
  to service_role;
grant execute on function public.cloud_refresh_all_facet_summaries(integer)
  to service_role;
grant execute on function public.cloud_exact_language_counts(uuid,text)
  to service_role;

comment on index public.cloud_source_finalize_leases_user_until_idx is
  'Account-wide lookup used to quiesce enrichment while a source finalizer owns the catalogue write window.';
comment on function public.norva_apply_catalog_title_background_result(
  text,uuid,uuid,text,bigint,timestamptz,uuid,jsonb
) is
  'Finalizer-aware wrapper for the proven v3 background payload writer; rejects stale work with SQLSTATE 40001.';

do $assert$
begin
  if to_regprocedure(
       'public.norva_apply_catalog_title_background_result_core_v3(text,uuid,uuid,text,bigint,timestamptz,uuid,jsonb)'
     ) is null
     or to_regclass(
       'public.cloud_source_finalize_leases_user_until_idx'
     ) is null
     or not has_function_privilege(
       'service_role',
       'public.norva_apply_catalog_title_background_result(text,uuid,uuid,text,bigint,timestamptz,uuid,jsonb)',
       'EXECUTE'
     )
     or has_function_privilege(
       'service_role',
       'public.norva_apply_catalog_title_background_result_core_v3(text,uuid,uuid,text,bigint,timestamptz,uuid,jsonb)',
       'EXECUTE'
     )
     or has_function_privilege(
       'authenticated',
       'public.claim_catalog_enrichment_sources(integer,integer)',
       'EXECUTE'
     ) then
    raise exception 'catalog finalize/enrichment quiescence contract drift'
      using errcode = '55000';
  end if;
end
$assert$;

commit;
