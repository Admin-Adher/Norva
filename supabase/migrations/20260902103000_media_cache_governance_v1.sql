begin;

-- Cache governance is deliberately demand-driven. Only opaque HMAC work and
-- account fingerprints are retained; catalogue labels, provider URLs,
-- credentials, users and playback tickets never enter these tables.
alter table public.media_cache_objects
  add column retention_class text not null default 'cold',
  add column admission_score integer not null default 0,
  add column admission_confidence integer not null default 0,
  add column admission_reason text not null default 'legacy',
  add column retention_until timestamptz,
  add column last_verified_at timestamptz,
  add column physical_purged_at timestamptz,
  add column purge_reason text;

update public.media_cache_objects
   set retention_until = least(
         expires_at,
         greatest(created_at, coalesce(ready_at, created_at)) + interval '24 hours'
       ),
       last_verified_at = ready_at
 where retention_until is null;

alter table public.media_cache_objects
  alter column retention_until set not null,
  alter column retention_until set default (clock_timestamp() + interval '1 minute'),
  drop constraint media_cache_objects_state_check,
  drop constraint media_cache_objects_ready_check,
  drop constraint media_cache_objects_time_check;

alter table public.media_cache_objects
  add constraint media_cache_objects_state_check check (
    state in ('staging', 'ready', 'quarantined', 'deleting', 'purged')
  ),
  add constraint media_cache_objects_ready_check check (
    (state = 'staging' and ready_at is null and manifest_sha256 is null and root_playlist is null)
    or (
      state in ('ready', 'quarantined', 'deleting', 'purged')
      and ready_at is not null
      and manifest_sha256 is not null
      and root_playlist is not null
      and total_bytes is not null
      and file_count is not null
    )
  ),
  add constraint media_cache_objects_time_check check (
    expires_at > created_at
    and retention_until >= created_at
    and retention_until <= expires_at
    and (quarantined_at is null or state in ('quarantined', 'deleting', 'purged'))
  ),
  add constraint media_cache_objects_governance_check check (
    retention_class in ('cold', 'warm', 'hot')
    and admission_score between 0 and 100
    and admission_confidence between 0 and 100
    and admission_reason in ('legacy', 'repeated', 'popular', 'costly', 'operator')
    and (purge_reason is null or purge_reason in ('eviction', 'orphan', 'corruption', 'legal', 'security'))
    and (
      (state = 'purged' and physical_purged_at is not null and purge_reason is not null)
      or (state <> 'purged' and physical_purged_at is null)
    )
  );

create table public.media_cache_governance_policy (
  singleton boolean primary key default true check (singleton),
  admission_mode text not null default 'off',
  repeated_requests_24h integer not null default 2,
  popular_requests_30d integer not null default 6,
  costly_score_threshold integer not null default 70,
  cold_ttl_seconds integer not null default 604800,
  warm_ttl_seconds integer not null default 1209600,
  hot_ttl_seconds integer not null default 2592000,
  minimum_retention_seconds integer not null default 86400,
  l1_max_bytes bigint not null default 103079215104,
  r2_max_bytes bigint not null default 2199023255552,
  r2_max_objects integer not null default 250000,
  max_files_per_object integer not null default 20000,
  r2_inventory_cursor text,
  r2_inventory_scanned_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  constraint media_cache_governance_policy_values_check check (
    admission_mode in ('off', 'shadow', 'enforced')
    and repeated_requests_24h between 2 and 1000
    and popular_requests_30d between repeated_requests_24h and 1000000
    and costly_score_threshold between 1 and 100
    and cold_ttl_seconds between 300 and 7776000
    and warm_ttl_seconds between cold_ttl_seconds and 7776000
    and hot_ttl_seconds between warm_ttl_seconds and 7776000
    and minimum_retention_seconds between 300 and cold_ttl_seconds
    and l1_max_bytes between 1073741824 and 10995116277760
    and r2_max_bytes between 1073741824 and 1125899906842624
    and r2_max_objects between 1000 and 10000000
    and max_files_per_object between 4 and 20000
    and (r2_inventory_cursor is null or (
      length(r2_inventory_cursor) between 1 and 1024
      and r2_inventory_cursor !~ '[[:cntrl:]]'
    ))
  )
);

insert into public.media_cache_governance_policy (singleton) values (true);

create table public.media_cache_demand_buckets (
  work_fingerprint text not null,
  account_fingerprint text not null,
  bucket_start timestamptz not null,
  demand_count integer not null default 1,
  maximum_cost_score integer not null default 0,
  last_requested_at timestamptz not null default clock_timestamp(),
  primary key (work_fingerprint, bucket_start),
  constraint media_cache_demand_buckets_fingerprint_check check (
    work_fingerprint ~ '^[0-9a-f]{64}$'
    and account_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  constraint media_cache_demand_buckets_values_check check (
    demand_count between 1 and 1000000
    and maximum_cost_score between 0 and 100
    and bucket_start = (
      date_trunc('hour', bucket_start at time zone 'UTC') at time zone 'UTC'
    )
    and last_requested_at >= bucket_start
  )
);

create index media_cache_demand_buckets_expiry_idx
  on public.media_cache_demand_buckets (bucket_start);

create index media_cache_demand_buckets_account_idx
  on public.media_cache_demand_buckets (account_fingerprint, bucket_start desc);

create table public.media_cache_admission_decisions (
  work_fingerprint text primary key,
  account_fingerprint text not null,
  policy_mode text not null,
  recommended boolean not null,
  admitted boolean not null,
  admission_score integer not null,
  confidence integer not null,
  reason text not null,
  ttl_seconds integer not null,
  demand_count_24h integer not null,
  demand_count_30d integer not null,
  maximum_cost_score integer not null,
  decided_at timestamptz not null default clock_timestamp(),
  constraint media_cache_admission_decisions_fingerprint_check check (
    work_fingerprint ~ '^[0-9a-f]{64}$'
    and account_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  constraint media_cache_admission_decisions_values_check check (
    policy_mode in ('off', 'shadow', 'enforced')
    and admission_score between 0 and 100
    and confidence between 0 and 100
    and reason in ('repeated', 'popular', 'costly', 'not-admitted')
    and ttl_seconds between 300 and 7776000
    and demand_count_24h between 1 and 1000000
    and demand_count_30d between demand_count_24h and 100000000
    and maximum_cost_score between 0 and 100
    and (not admitted or (recommended and policy_mode = 'enforced'))
  )
);

alter table public.media_cache_governance_policy enable row level security;
alter table public.media_cache_governance_policy force row level security;
alter table public.media_cache_demand_buckets enable row level security;
alter table public.media_cache_demand_buckets force row level security;
alter table public.media_cache_admission_decisions enable row level security;
alter table public.media_cache_admission_decisions force row level security;

revoke all on table public.media_cache_governance_policy from public, anon, authenticated;
revoke all on table public.media_cache_demand_buckets from public, anon, authenticated;
revoke all on table public.media_cache_admission_decisions from public, anon, authenticated;
grant select, insert, update, delete on table public.media_cache_governance_policy to service_role;
grant select, insert, update, delete on table public.media_cache_demand_buckets to service_role;
grant select, insert, update, delete on table public.media_cache_admission_decisions to service_role;

create function public.norva_record_media_cache_demand(
  p_work_fingerprint text,
  p_account_fingerprint text,
  p_cost_score integer default 0
) returns table (
  policy_mode text,
  recommended boolean,
  admitted boolean,
  admission_score integer,
  confidence integer,
  reason text,
  ttl_seconds integer,
  demand_count_24h integer,
  demand_count_30d integer
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_bucket timestamptz := (
    date_trunc('hour', v_now at time zone 'UTC') at time zone 'UTC'
  );
  v_policy public.media_cache_governance_policy%rowtype;
  v_count_24h integer := 0;
  v_count_30d integer := 0;
  v_cost integer := 0;
  v_score integer := 0;
  v_confidence integer := 0;
  v_recommended boolean := false;
  v_admitted boolean := false;
  v_reason text := 'not-admitted';
  v_ttl integer := 604800;
begin
  if p_work_fingerprint is null or p_work_fingerprint !~ '^[0-9a-f]{64}$'
     or p_account_fingerprint is null or p_account_fingerprint !~ '^[0-9a-f]{64}$'
     or p_cost_score is null or p_cost_score not between 0 and 100 then return; end if;

  select policy.* into v_policy
    from public.media_cache_governance_policy policy
   where policy.singleton;
  if not found then return; end if;

  insert into public.media_cache_demand_buckets (
    work_fingerprint, account_fingerprint, bucket_start,
    demand_count, maximum_cost_score, last_requested_at
  ) values (
    p_work_fingerprint, p_account_fingerprint, v_bucket,
    1, p_cost_score, v_now
  )
  on conflict (work_fingerprint, bucket_start) do update
     set account_fingerprint = excluded.account_fingerprint,
         demand_count = least(1000000, public.media_cache_demand_buckets.demand_count + 1),
         maximum_cost_score = greatest(
           public.media_cache_demand_buckets.maximum_cost_score,
           excluded.maximum_cost_score
         ),
         last_requested_at = excluded.last_requested_at;

  select
    least(1000000, coalesce(sum(bucket.demand_count) filter (
      where bucket.bucket_start >= v_bucket - interval '23 hours'
    ), 0))::integer,
    least(100000000, coalesce(sum(bucket.demand_count), 0))::integer,
    coalesce(max(bucket.maximum_cost_score), 0)::integer
    into v_count_24h, v_count_30d, v_cost
    from public.media_cache_demand_buckets bucket
   where bucket.work_fingerprint = p_work_fingerprint
     and bucket.bucket_start >= v_bucket - interval '30 days';

  v_score := least(100, greatest(0,
    v_count_24h * 15 + least(v_count_30d, 20) * 2 + floor(v_cost / 2.0)::integer
  ));
  v_confidence := least(100, 20 + least(v_count_24h, 10) * 7 + least(v_count_30d, 20));
  v_recommended := v_count_24h >= v_policy.repeated_requests_24h
    or v_count_30d >= v_policy.popular_requests_30d
    or v_cost >= v_policy.costly_score_threshold;
  v_admitted := v_policy.admission_mode = 'enforced' and v_recommended;

  if v_count_30d >= v_policy.popular_requests_30d then
    v_reason := 'popular';
    v_ttl := v_policy.hot_ttl_seconds;
  elsif v_count_24h >= v_policy.repeated_requests_24h then
    v_reason := 'repeated';
    v_ttl := v_policy.warm_ttl_seconds;
  elsif v_cost >= v_policy.costly_score_threshold then
    v_reason := 'costly';
    v_ttl := v_policy.warm_ttl_seconds;
  else
    v_reason := 'not-admitted';
    v_ttl := v_policy.cold_ttl_seconds;
  end if;

  insert into public.media_cache_admission_decisions (
    work_fingerprint, account_fingerprint, policy_mode, recommended, admitted,
    admission_score, confidence, reason, ttl_seconds,
    demand_count_24h, demand_count_30d, maximum_cost_score, decided_at
  ) values (
    p_work_fingerprint, p_account_fingerprint, v_policy.admission_mode,
    v_recommended, v_admitted, v_score, v_confidence, v_reason, v_ttl,
    v_count_24h, v_count_30d, v_cost, v_now
  )
  on conflict (work_fingerprint) do update
     set account_fingerprint = excluded.account_fingerprint,
         policy_mode = excluded.policy_mode,
         recommended = excluded.recommended,
         admitted = excluded.admitted,
         admission_score = excluded.admission_score,
         confidence = excluded.confidence,
         reason = excluded.reason,
         ttl_seconds = excluded.ttl_seconds,
         demand_count_24h = excluded.demand_count_24h,
         demand_count_30d = excluded.demand_count_30d,
         maximum_cost_score = excluded.maximum_cost_score,
         decided_at = excluded.decided_at;

  return query select
    v_policy.admission_mode, v_recommended, v_admitted, v_score,
    v_confidence, v_reason, v_ttl, v_count_24h, v_count_30d;
end
$function$;

create function public.norva_prune_media_cache_demand(
  p_batch integer default 10000
) returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_count integer := 0;
begin
  if p_batch is null or p_batch not between 1 and 100000 then return 0; end if;
  with victims as (
    select bucket.work_fingerprint, bucket.bucket_start
      from public.media_cache_demand_buckets bucket
     where bucket.bucket_start < (
       date_trunc('hour', clock_timestamp() at time zone 'UTC') at time zone 'UTC'
     ) - interval '31 days'
     order by bucket.bucket_start
     limit p_batch
  )
  delete from public.media_cache_demand_buckets bucket
   using victims
   where bucket.work_fingerprint = victims.work_fingerprint
     and bucket.bucket_start = victims.bucket_start;
  get diagnostics v_count = row_count;
  delete from public.media_cache_admission_decisions decision
   where decision.decided_at < clock_timestamp() - interval '90 days'
     and not exists (
       select 1 from public.media_cache_demand_buckets bucket
        where bucket.work_fingerprint = decision.work_fingerprint
     );
  return v_count;
end
$function$;

alter table public.cloud_gateway_sessions
  add column media_cache_admission_mode text,
  add column media_cache_admitted boolean,
  add column media_cache_admission_score integer,
  add column media_cache_admission_confidence integer,
  add column media_cache_admission_reason text,
  add column media_cache_ttl_seconds integer;

alter table public.cloud_gateway_sessions
  add constraint cloud_gateway_sessions_media_cache_admission_check check (
    pg_catalog.num_nonnulls(
      media_cache_admission_mode,
      media_cache_admitted,
      media_cache_admission_score,
      media_cache_admission_confidence,
      media_cache_admission_reason,
      media_cache_ttl_seconds
    ) = 0
    or (
      pg_catalog.num_nonnulls(
        media_cache_admission_mode,
        media_cache_admitted,
        media_cache_admission_score,
        media_cache_admission_confidence,
        media_cache_admission_reason,
        media_cache_ttl_seconds
      ) = 6
      and media_cache_work_fingerprint is not null
      and media_cache_admission_mode in ('off', 'shadow', 'enforced')
      and media_cache_admission_score between 0 and 100
      and media_cache_admission_confidence between 0 and 100
      and media_cache_admission_reason in ('repeated', 'popular', 'costly', 'not-admitted')
      and media_cache_ttl_seconds between 300 and 7776000
      and (not media_cache_admitted or media_cache_admission_mode = 'enforced')
    )
  );

create table public.media_cache_metric_buckets (
  bucket_start timestamptz not null,
  metric text not null,
  layer text not null default 'none',
  market_region text not null default 'global',
  route_slot text not null default 'none',
  route_protocol text not null default 'none',
  outcome text not null default 'none',
  value_sum numeric(30,3) not null default 0,
  sample_count bigint not null default 0,
  maximum_value numeric(30,3) not null default 0,
  latest_score integer,
  latest_confidence integer,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (
    bucket_start, metric, layer, market_region, route_slot, route_protocol, outcome
  ),
  constraint media_cache_metric_buckets_dimension_check check (
    metric in (
      'l1_hit', 'l1_miss', 'l2_hit', 'l2_miss', 'cdn_hit', 'cdn_miss',
      'lookup_ms', 'playlist_ms', 'first_image_ms',
      'ffmpeg_bytes_avoided', 'ffmpeg_seconds_avoided',
      'producer_started', 'viewer_joined',
      'fill_completed', 'fill_preempted', 'fill_expired', 'fill_failed',
      'storage_bytes', 'storage_objects', 'eviction', 'orphan_candidate',
      'purge_completed', 'purge_failed', 'cache_fallback', 'cache_recovery',
      'route_score', 'route_confidence'
    )
    and layer in ('none', 'l1', 'l2', 'cdn', 'gateway', 'provider')
    and market_region ~ '^[a-z0-9-]{2,16}$'
    and route_slot ~ '^(none|direct|slot-[0-9]{1,3})$'
    and route_protocol in ('none', 'direct', 'http', 'socks5')
    and outcome in (
      'none', 'hit', 'miss', 'completed', 'preempted', 'expired', 'failed',
      'recovered', 'quarantined', 'fallback'
    )
    and value_sum >= 0
    and sample_count >= 0
    and maximum_value >= 0
    and (latest_score is null or latest_score between 0 and 100)
    and (latest_confidence is null or latest_confidence between 0 and 100)
    and bucket_start = (
      date_trunc('hour', bucket_start at time zone 'UTC') at time zone 'UTC'
    )
  )
);

create index media_cache_metric_buckets_time_idx
  on public.media_cache_metric_buckets (bucket_start desc, metric);

alter table public.media_cache_metric_buckets enable row level security;
alter table public.media_cache_metric_buckets force row level security;
revoke all on table public.media_cache_metric_buckets from public, anon, authenticated;
grant select, insert, update, delete on table public.media_cache_metric_buckets to service_role;

create function public.norva_record_media_cache_metric(
  p_metric text,
  p_value numeric,
  p_samples integer default 1,
  p_layer text default 'none',
  p_market_region text default 'global',
  p_route_slot text default 'none',
  p_route_protocol text default 'none',
  p_outcome text default 'none',
  p_score integer default null,
  p_confidence integer default null
) returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_bucket timestamptz := (
    date_trunc('hour', clock_timestamp() at time zone 'UTC') at time zone 'UTC'
  );
begin
  if p_metric is null or p_metric not in (
      'l1_hit', 'l1_miss', 'l2_hit', 'l2_miss', 'cdn_hit', 'cdn_miss',
      'lookup_ms', 'playlist_ms', 'first_image_ms',
      'ffmpeg_bytes_avoided', 'ffmpeg_seconds_avoided',
      'producer_started', 'viewer_joined',
      'fill_completed', 'fill_preempted', 'fill_expired', 'fill_failed',
      'storage_bytes', 'storage_objects', 'eviction', 'orphan_candidate',
      'purge_completed', 'purge_failed', 'cache_fallback', 'cache_recovery',
      'route_score', 'route_confidence'
    )
     or p_value is null or p_value < 0 or p_value > 1000000000000000000000000::numeric
     or p_samples is null or p_samples not between 1 and 1000000
     or p_layer is null or p_layer not in ('none', 'l1', 'l2', 'cdn', 'gateway', 'provider')
     or p_market_region is null or p_market_region !~ '^[a-z0-9-]{2,16}$'
     or p_route_slot is null or p_route_slot !~ '^(none|direct|slot-[0-9]{1,3})$'
     or p_route_protocol is null or p_route_protocol not in ('none', 'direct', 'http', 'socks5')
     or p_outcome is null or p_outcome not in (
       'none', 'hit', 'miss', 'completed', 'preempted', 'expired', 'failed',
       'recovered', 'quarantined', 'fallback'
     )
     or (p_score is not null and p_score not between 0 and 100)
     or (p_confidence is not null and p_confidence not between 0 and 100) then
    return false;
  end if;

  insert into public.media_cache_metric_buckets (
    bucket_start, metric, layer, market_region, route_slot, route_protocol,
    outcome, value_sum, sample_count, maximum_value,
    latest_score, latest_confidence, updated_at
  ) values (
    v_bucket, p_metric, p_layer, p_market_region, p_route_slot, p_route_protocol,
    p_outcome, p_value, p_samples, p_value,
    p_score, p_confidence, clock_timestamp()
  )
  on conflict (
    bucket_start, metric, layer, market_region, route_slot, route_protocol, outcome
  ) do update
     set value_sum = case
           when excluded.metric in ('storage_bytes', 'storage_objects') then excluded.value_sum
           else public.media_cache_metric_buckets.value_sum + excluded.value_sum
         end,
         sample_count = case
           when excluded.metric in ('storage_bytes', 'storage_objects') then 1
           else public.media_cache_metric_buckets.sample_count + excluded.sample_count
         end,
         maximum_value = greatest(public.media_cache_metric_buckets.maximum_value, excluded.maximum_value),
         latest_score = coalesce(excluded.latest_score, public.media_cache_metric_buckets.latest_score),
         latest_confidence = coalesce(
           excluded.latest_confidence,
           public.media_cache_metric_buckets.latest_confidence
         ),
         updated_at = excluded.updated_at;
  return true;
end
$function$;

create table public.media_cache_purge_jobs (
  id uuid primary key default gen_random_uuid(),
  object_key text not null,
  reason text not null,
  state text not null default 'queued',
  attempts integer not null default 0,
  available_at timestamptz not null default clock_timestamp(),
  lease_owner_fingerprint text,
  lease_token uuid,
  lease_expires_at timestamptz,
  requested_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  recovery_cleared_at timestamptz,
  last_error_code text,
  constraint media_cache_purge_jobs_object_check check (object_key ~ '^[0-9a-f]{64}$'),
  constraint media_cache_purge_jobs_values_check check (
    reason in ('eviction', 'orphan', 'corruption', 'legal', 'security')
    and state in ('queued', 'leased', 'retry', 'completed', 'failed')
    and attempts between 0 and 100
    and (lease_owner_fingerprint is null or lease_owner_fingerprint ~ '^[0-9a-f]{64}$')
    and (last_error_code is null or last_error_code ~ '^[a-z0-9_-]{1,64}$')
    and (
      (state = 'leased' and pg_catalog.num_nonnulls(
        lease_owner_fingerprint, lease_token, lease_expires_at
      ) = 3)
      or (state <> 'leased' and pg_catalog.num_nonnulls(
        lease_owner_fingerprint, lease_token, lease_expires_at
      ) = 0)
    )
    and ((state = 'completed' and completed_at is not null) or state <> 'completed')
    and (
      recovery_cleared_at is null
      or (reason = 'corruption' and recovery_cleared_at >= requested_at)
    )
  )
);

create unique index media_cache_purge_jobs_active_object_idx
  on public.media_cache_purge_jobs (object_key)
  where state in ('queued', 'leased', 'retry');

create index media_cache_purge_jobs_claim_idx
  on public.media_cache_purge_jobs (state, available_at, requested_at);

create index media_cache_purge_jobs_critical_tombstone_idx
  on public.media_cache_purge_jobs (object_key, reason)
  where reason in ('corruption', 'legal', 'security');

alter table public.media_cache_purge_jobs enable row level security;
alter table public.media_cache_purge_jobs force row level security;
revoke all on table public.media_cache_purge_jobs from public, anon, authenticated;
grant select, insert, update, delete on table public.media_cache_purge_jobs to service_role;

create function public.norva_enqueue_media_cache_purge(
  p_object_key text,
  p_reason text
) returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_object public.media_cache_objects%rowtype;
  v_object_found boolean := false;
  v_existing_job public.media_cache_purge_jobs%rowtype;
  v_existing_job_found boolean := false;
  v_job_id uuid;
  v_effective_reason text;
  v_tombstone_reason text;
begin
  if p_object_key is null or p_object_key !~ '^[0-9a-f]{64}$'
     or p_reason is null
     or p_reason not in ('eviction', 'orphan', 'corruption', 'legal', 'security') then
    return null;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_object_key, 864691128455135232::bigint)
  );
  v_now := clock_timestamp();
  select object.* into v_object
    from public.media_cache_objects object
   where object.object_key = p_object_key
   for update;
  v_object_found := found;

  select job.* into v_existing_job
    from public.media_cache_purge_jobs job
   where job.object_key = p_object_key
     and job.state in ('queued', 'leased', 'retry')
    limit 1
    for update;
  v_existing_job_found := found;

  v_effective_reason := p_reason;
  if v_existing_job_found and
     (case v_existing_job.reason when 'security' then 5 when 'legal' then 4 when 'corruption' then 3 else 1 end)
       > (case v_effective_reason when 'security' then 5 when 'legal' then 4 when 'corruption' then 3 else 1 end) then
    v_effective_reason := v_existing_job.reason;
  end if;

  -- Legal/security removals are permanent tombstones. Corruption remains a
  -- tombstone until the two-phase verified recovery explicitly clears it.
  select job.reason into v_tombstone_reason
    from public.media_cache_purge_jobs job
   where job.object_key = p_object_key
     and job.reason in ('corruption', 'legal', 'security')
     and (
       job.reason in ('legal', 'security')
       or job.recovery_cleared_at is null
     )
   order by case job.reason when 'security' then 0 when 'legal' then 1 else 2 end
   limit 1;
  if found and
     (case v_tombstone_reason when 'security' then 5 when 'legal' then 4 else 3 end)
       > (case v_effective_reason when 'security' then 5 when 'legal' then 4 when 'corruption' then 3 else 1 end) then
    v_effective_reason := v_tombstone_reason;
  end if;
  if v_object_found
     and v_object.purge_reason in ('corruption', 'legal', 'security')
     and (case v_object.purge_reason when 'security' then 5 when 'legal' then 4 else 3 end)
       > (case v_effective_reason when 'security' then 5 when 'legal' then 4 when 'corruption' then 3 else 1 end) then
    v_effective_reason := v_object.purge_reason;
  end if;

  if not v_object_found then
    if v_effective_reason not in ('orphan', 'corruption', 'legal', 'security') then return null; end if;
  elsif v_effective_reason = 'eviction' then
    if not (
         (v_object.state = 'ready' and v_object.purge_reason is null)
         or (
            v_object.state = 'deleting'
           and v_object.purge_reason in ('eviction', 'orphan')
         )
       )
       or v_object.retention_until > v_now
       or exists (
         select 1 from public.media_cache_playback_grants grant_row
          where grant_row.object_key = p_object_key
            and grant_row.revoked_at is null
            and grant_row.hard_expires_at > v_now
       ) then return null; end if;
    update public.media_cache_objects
       set state = 'deleting', purge_reason = v_effective_reason
     where object_key = p_object_key;
  elsif v_effective_reason = 'orphan' then
    -- Inventory reconciliation must never reinterpret an authoritative ready
    -- object as an orphan. It may only retry an orphan already being deleted,
    -- or clean bytes that reappeared after a non-critical physical purge.
    if not (
         (v_object.state = 'deleting' and v_object.purge_reason = 'orphan')
         or (
           v_object.state = 'purged'
           and v_object.purge_reason in ('eviction', 'orphan')
         )
       )
       or v_object.retention_until > v_now
       or exists (
         select 1 from public.media_cache_playback_grants grant_row
          where grant_row.object_key = p_object_key
            and grant_row.revoked_at is null
            and grant_row.hard_expires_at > v_now
       ) then return null; end if;
    update public.media_cache_objects
       set state = 'deleting',
           physical_purged_at = null,
           purge_reason = 'orphan'
     where object_key = p_object_key;
  elsif v_effective_reason = 'corruption' then
    update public.media_cache_objects
       set state = case when state = 'purged' then 'purged' else 'quarantined' end,
           quarantined_at = coalesce(quarantined_at, v_now),
           purge_reason = v_effective_reason
     where object_key = p_object_key;
    update public.media_cache_playback_grants
       set revoked_at = coalesce(revoked_at, v_now)
     where object_key = p_object_key and revoked_at is null;
  else
    update public.media_cache_objects
       set state = case when state = 'purged' then 'purged' else 'deleting' end,
           quarantined_at = coalesce(quarantined_at, v_now),
           purge_reason = v_effective_reason
     where object_key = p_object_key;
    update public.media_cache_playback_grants
       set revoked_at = coalesce(revoked_at, v_now)
     where object_key = p_object_key and revoked_at is null;
    update public.media_cache_bindings
       set state = 'revoked', revoked_at = coalesce(revoked_at, v_now)
     where object_key = p_object_key and state = 'active';
  end if;

  if v_existing_job_found then
    update public.media_cache_purge_jobs job
       set reason = v_effective_reason,
            recovery_cleared_at = null,
            available_at = least(
              job.available_at,
              case when v_effective_reason = 'orphan'
                then v_now + interval '15 minutes'
                else v_now
              end
            )
      where job.id = v_existing_job.id;
    return v_existing_job.id;
  end if;

  insert into public.media_cache_purge_jobs (
    object_key, reason, state, attempts, available_at, requested_at
  ) values (
    p_object_key, v_effective_reason, 'queued', 0,
    case when v_effective_reason = 'orphan'
      then v_now + interval '15 minutes'
      else v_now
    end,
    v_now
  ) returning id into v_job_id;
  return v_job_id;
end
$function$;

create function public.norva_schedule_media_cache_evictions(
  p_batch integer default 25
) returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_policy public.media_cache_governance_policy%rowtype;
  v_total_bytes bigint := 0;
  v_total_objects bigint := 0;
  v_scheduled integer := 0;
  v_reason text;
  v_candidate record;
begin
  if p_batch is null or p_batch not between 1 and 100 then return 0; end if;
  select policy.* into v_policy
    from public.media_cache_governance_policy policy
   where policy.singleton;
  if not found then return 0; end if;

  -- A manifest-last publication can legitimately make an R2 inventory orphan
  -- authoritative between inventory and scheduling. Retire only unleased,
  -- non-critical jobs so they cannot later delete that newly-ready object or
  -- occupy the partial unique index forever.
  update public.media_cache_purge_jobs job
     set state = 'failed',
         available_at = v_now,
         last_error_code = 'authority_changed'
   where job.state in ('queued', 'retry')
     and job.reason in ('eviction', 'orphan')
     and exists (
       select 1
         from public.media_cache_objects object
        where object.object_key = job.object_key
          and object.state = 'ready'
           and object.purge_reason is null
     );

  -- Legal and security tombstones are permanent, and corruption stays fenced
  -- until verified recovery. Once bounded delivery retries are exhausted,
  -- re-arm only the strongest unresolved critical job for an object. The
  -- shared lifecycle advisory lock keeps this transition ordered with
  -- publication, recovery and a newly-enqueued stronger purge.
  for v_candidate in
    select job.id, job.object_key, job.reason
      from public.media_cache_purge_jobs job
     where job.state = 'failed'
       and job.available_at <= v_now
       and job.reason in ('corruption', 'legal', 'security')
       and (job.reason in ('legal', 'security') or job.recovery_cleared_at is null)
       and not exists (
         select 1 from public.media_cache_purge_jobs active_job
          where active_job.object_key = job.object_key
            and active_job.state in ('queued', 'leased', 'retry')
       )
       and job.id = (
         select preferred.id
           from public.media_cache_purge_jobs preferred
          where preferred.object_key = job.object_key
            and preferred.state = 'failed'
            and preferred.reason in ('corruption', 'legal', 'security')
            and (
              preferred.reason in ('legal', 'security')
              or preferred.recovery_cleared_at is null
            )
          order by
            case preferred.reason when 'security' then 3 when 'legal' then 2 else 1 end desc,
            preferred.requested_at desc,
            preferred.id::text desc
          limit 1
       )
       and not exists (
         select 1 from public.media_cache_purge_jobs completed_job
          where completed_job.object_key = job.object_key
            and completed_job.state = 'completed'
            and completed_job.reason in ('corruption', 'legal', 'security')
            and (
              completed_job.reason in ('legal', 'security')
              or completed_job.recovery_cleared_at is null
            )
            and (case completed_job.reason when 'security' then 3 when 'legal' then 2 else 1 end)
              >= (case job.reason when 'security' then 3 when 'legal' then 2 else 1 end)
       )
     order by
       case job.reason when 'security' then 0 when 'legal' then 1 else 2 end,
       job.available_at,
       job.requested_at
     limit p_batch
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(v_candidate.object_key, 864691128455135232::bigint)
    );
    v_now := clock_timestamp();
    update public.media_cache_purge_jobs job
       set state = 'queued',
           attempts = 0,
           available_at = v_now,
           lease_owner_fingerprint = null,
           lease_token = null,
           lease_expires_at = null,
           completed_at = null,
           last_error_code = null
     where job.id = v_candidate.id
       and job.state = 'failed'
       and job.available_at <= v_now
       and (job.reason in ('legal', 'security') or job.recovery_cleared_at is null)
       and not exists (
         select 1 from public.media_cache_purge_jobs active_job
          where active_job.object_key = job.object_key
            and active_job.id <> job.id
            and active_job.state in ('queued', 'leased', 'retry')
       )
       and job.id = (
         select preferred.id
           from public.media_cache_purge_jobs preferred
          where preferred.object_key = job.object_key
            and preferred.state = 'failed'
            and preferred.reason in ('corruption', 'legal', 'security')
            and (
              preferred.reason in ('legal', 'security')
              or preferred.recovery_cleared_at is null
            )
          order by
            case preferred.reason when 'security' then 3 when 'legal' then 2 else 1 end desc,
            preferred.requested_at desc,
            preferred.id::text desc
          limit 1
       )
       and not exists (
         select 1 from public.media_cache_purge_jobs completed_job
          where completed_job.object_key = job.object_key
            and completed_job.state = 'completed'
            and completed_job.reason in ('corruption', 'legal', 'security')
            and (
              completed_job.reason in ('legal', 'security')
              or completed_job.recovery_cleared_at is null
            )
            and (case completed_job.reason when 'security' then 3 when 'legal' then 2 else 1 end)
              >= (case job.reason when 'security' then 3 when 'legal' then 2 else 1 end)
       );
    if found then v_scheduled := v_scheduled + 1; end if;
    exit when v_scheduled >= p_batch;
  end loop;

  select coalesce(sum(object.total_bytes), 0)::bigint, count(*)::bigint
    into v_total_bytes, v_total_objects
    from public.media_cache_objects object
   where object.state in ('ready', 'quarantined', 'deleting');
  perform public.norva_record_media_cache_metric(
    'storage_bytes', v_total_bytes, 1, 'l2', 'global', 'none', 'none', 'none'
  );
  perform public.norva_record_media_cache_metric(
    'storage_objects', v_total_objects, 1, 'l2', 'global', 'none', 'none', 'none'
  );

  if v_scheduled < p_batch then
  for v_candidate in
    select object.object_key, object.total_bytes, object.expires_at,
           object.state, object.purge_reason
      from public.media_cache_objects object
     where object.state in ('ready', 'deleting')
       and object.retention_until <= v_now
       and not exists (
         select 1 from public.media_cache_playback_grants grant_row
          where grant_row.object_key = object.object_key
            and grant_row.revoked_at is null
            and grant_row.hard_expires_at > v_now
       )
       and not exists (
         select 1 from public.media_cache_purge_jobs active_job
          where active_job.object_key = object.object_key
            and active_job.state in ('queued', 'leased', 'retry')
       )
       and (
         (
           object.state = 'ready'
           and object.purge_reason is null
           and (
             object.expires_at <= v_now
             or v_total_bytes > v_policy.r2_max_bytes
             or v_total_objects > v_policy.r2_max_objects
           )
         )
         or (
           object.state = 'deleting'
           and object.purge_reason in ('eviction', 'orphan')
           and exists (
             select 1 from public.media_cache_purge_jobs failed_job
              where failed_job.object_key = object.object_key
                and failed_job.state = 'failed'
                and failed_job.available_at <= v_now
           )
         )
       )
     order by
       case object.state when 'deleting' then 0 else 1 end,
       case object.retention_class when 'cold' then 0 when 'warm' then 1 else 2 end,
       object.popularity_count asc,
       object.last_accessed_at asc nulls first,
       object.expires_at asc
     limit (p_batch - v_scheduled)
  loop
    continue when v_candidate.state = 'ready'
      and v_candidate.expires_at > v_now
      and v_total_bytes <= v_policy.r2_max_bytes
      and v_total_objects <= v_policy.r2_max_objects;
    v_reason := case
      when v_candidate.state = 'deleting' then v_candidate.purge_reason
      else 'eviction'
    end;
    if public.norva_enqueue_media_cache_purge(v_candidate.object_key, v_reason) is not null then
      v_scheduled := v_scheduled + 1;
      v_total_bytes := greatest(0, v_total_bytes - coalesce(v_candidate.total_bytes, 0));
      v_total_objects := greatest(0, v_total_objects - 1);
    end if;
    exit when v_scheduled >= p_batch;
  end loop;
  end if;
  return v_scheduled;
end
$function$;

create function public.norva_claim_media_cache_purge(
  p_lease_owner_fingerprint text,
  p_ttl_seconds integer default 120
) returns table (
  job_id uuid,
  object_key text,
  reason text,
  lease_token uuid,
  attempts integer
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_job public.media_cache_purge_jobs%rowtype;
  v_token uuid := gen_random_uuid();
begin
  if p_lease_owner_fingerprint is null
     or p_lease_owner_fingerprint !~ '^[0-9a-f]{64}$'
     or p_ttl_seconds is null or p_ttl_seconds not between 30 and 300 then return; end if;

  update public.media_cache_purge_jobs job
     set state = 'failed',
         available_at = v_now,
         last_error_code = 'authority_changed'
   where job.state in ('queued', 'retry')
     and job.reason in ('eviction', 'orphan')
     and exists (
       select 1
         from public.media_cache_objects object
        where object.object_key = job.object_key
          and object.state = 'ready'
          and object.purge_reason is null
     );

  update public.media_cache_purge_jobs job
     set state = 'retry',
         available_at = v_now,
         lease_owner_fingerprint = null,
         lease_token = null,
         lease_expires_at = null
   where job.state = 'leased'
     and job.lease_expires_at <= v_now;

  select job.* into v_job
    from public.media_cache_purge_jobs job
   where job.state in ('queued', 'retry')
     and job.available_at <= v_now
     and (
       job.reason in ('corruption', 'legal', 'security')
       or not exists (
         select 1 from public.media_cache_objects object
          where object.object_key = job.object_key
       )
       or exists (
         select 1 from public.media_cache_objects object
          where object.object_key = job.object_key
            and object.state in ('deleting', 'quarantined')
            and object.retention_until <= v_now
            and not exists (
              select 1 from public.media_cache_playback_grants grant_row
               where grant_row.object_key = object.object_key
                 and grant_row.revoked_at is null
                 and grant_row.hard_expires_at > v_now
            )
       )
     )
   order by
     case job.reason when 'security' then 0 when 'legal' then 1 when 'corruption' then 2 else 3 end,
     job.requested_at
   limit 1
   for update skip locked;
  if not found then return; end if;

  update public.media_cache_purge_jobs job
     set state = 'leased',
         attempts = least(100, job.attempts + 1),
         lease_owner_fingerprint = p_lease_owner_fingerprint,
         lease_token = v_token,
         lease_expires_at = v_now + pg_catalog.make_interval(secs => p_ttl_seconds)
   where job.id = v_job.id
  returning job.* into v_job;

  return query select v_job.id, v_job.object_key, v_job.reason, v_token, v_job.attempts;
end
$function$;

create function public.norva_complete_media_cache_purge(
  p_job_id uuid,
  p_lease_owner_fingerprint text,
  p_lease_token uuid,
  p_reason text,
  p_success boolean,
  p_error_code text default null
) returns text
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_job public.media_cache_purge_jobs%rowtype;
  v_object_key text;
  v_next_state text;
  v_delay_seconds integer;
begin
  if p_job_id is null or p_lease_token is null
     or p_lease_owner_fingerprint is null
     or p_lease_owner_fingerprint !~ '^[0-9a-f]{64}$'
     or p_reason is null
     or p_reason not in ('eviction', 'orphan', 'corruption', 'legal', 'security')
     or p_success is null
     or (p_error_code is not null and p_error_code !~ '^[a-z0-9_-]{1,64}$') then
    return 'invalid';
  end if;

  -- Resolve the immutable object key without a row lock, then serialize every
  -- object lifecycle transition on the same advisory lock used by registration,
  -- publication, enqueue and recovery. The leased job is locked only after it,
  -- keeping the lock order consistent and preventing object/job deadlocks.
  select job.object_key into v_object_key
    from public.media_cache_purge_jobs job
   where job.id = p_job_id;
  if not found then return 'expired'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_object_key, 864691128455135232::bigint)
  );
  v_now := clock_timestamp();

  select job.* into v_job
    from public.media_cache_purge_jobs job
   where job.id = p_job_id
     and job.state = 'leased'
     and job.lease_owner_fingerprint = p_lease_owner_fingerprint
     and job.lease_token = p_lease_token
     and job.lease_expires_at > v_now
   for update;
  if not found then return 'expired'; end if;

  if v_job.reason <> p_reason then
    update public.media_cache_purge_jobs
       set state = 'queued', available_at = v_now,
           lease_owner_fingerprint = null, lease_token = null, lease_expires_at = null
     where id = p_job_id;
    return 'superseded';
  end if;

  if p_success then
    update public.media_cache_purge_jobs
       set state = 'completed', completed_at = v_now,
           lease_owner_fingerprint = null, lease_token = null, lease_expires_at = null,
           last_error_code = null
     where id = p_job_id;
    delete from public.media_cache_work_results result
     where result.object_key = v_job.object_key;
    update public.media_cache_playback_grants grant_row
       set revoked_at = coalesce(grant_row.revoked_at, v_now)
     where grant_row.object_key = v_job.object_key and grant_row.revoked_at is null;
    update public.media_cache_objects object
       set state = 'purged',
           physical_purged_at = v_now,
           purge_reason = v_job.reason,
           quarantined_at = case
             when v_job.reason in ('corruption', 'legal', 'security')
               then coalesce(object.quarantined_at, v_now)
             else object.quarantined_at
           end
     where object.object_key = v_job.object_key;
    perform public.norva_record_media_cache_metric(
      'purge_completed', 1, 1, 'l2', 'global', 'none', 'none', 'completed'
    );
    if v_job.reason = 'eviction' then
      perform public.norva_record_media_cache_metric(
        'eviction', 1, 1, 'l2', 'global', 'none', 'none', 'completed'
      );
    end if;
    return 'completed';
  end if;

  v_next_state := case when v_job.attempts >= 12 then 'failed' else 'retry' end;
  v_delay_seconds := least(3600, (15 * power(2, least(v_job.attempts, 8)))::integer);
  update public.media_cache_purge_jobs
     set state = v_next_state,
         available_at = v_now + pg_catalog.make_interval(secs => v_delay_seconds),
         lease_owner_fingerprint = null,
         lease_token = null,
         lease_expires_at = null,
         last_error_code = coalesce(p_error_code, 'unknown')
   where id = p_job_id;
  perform public.norva_record_media_cache_metric(
    'purge_failed', 1, 1, 'l2', 'global', 'none', 'none', 'failed'
  );
  return v_next_state;
end
$function$;

create function public.norva_recover_media_cache_object(
  p_object_key text,
  p_content_sha256 text,
  p_video_profile_sha256 text,
  p_audio_topology_sha256 text,
  p_subtitle_topology_sha256 text,
  p_root_playlist text,
  p_manifest_sha256 text,
  p_total_bytes bigint,
  p_file_count integer,
  p_expires_at timestamptz
) returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_recovered boolean := false;
begin
  if p_object_key is null or p_object_key !~ '^[0-9a-f]{64}$'
     or p_content_sha256 is null or p_content_sha256 !~ '^[0-9a-f]{64}$'
     or p_video_profile_sha256 is null or p_video_profile_sha256 !~ '^[0-9a-f]{64}$'
     or p_audio_topology_sha256 is null or p_audio_topology_sha256 !~ '^[0-9a-f]{64}$'
     or p_subtitle_topology_sha256 is null or p_subtitle_topology_sha256 !~ '^[0-9a-f]{64}$'
     or length(coalesce(p_root_playlist, '')) not between 1 and 1024
     or p_root_playlist !~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$'
     or p_root_playlist ~ '(^|/)\.{1,2}(/|$)'
     or p_root_playlist ~ '//'
     or p_manifest_sha256 is null or p_manifest_sha256 !~ '^[0-9a-f]{64}$'
     or p_total_bytes is null or p_total_bytes <= 0
     or p_file_count is null or p_file_count not between 1 and 20000
     or p_expires_at is null
     or p_expires_at <= v_now + interval '5 minutes'
     or p_expires_at > v_now + interval '90 days' then return false; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_object_key, 864691128455135232::bigint)
  );
  v_now := clock_timestamp();
  if p_expires_at <= v_now + interval '5 minutes' then return false; end if;
  perform 1
    from public.media_cache_purge_jobs job
   where job.object_key = p_object_key
     and job.state in ('queued', 'leased', 'retry')
   for update;
  update public.media_cache_objects object
     set state = 'ready',
         manifest_sha256 = p_manifest_sha256,
         total_bytes = p_total_bytes,
         file_count = p_file_count,
         expires_at = p_expires_at,
         retention_until = least(p_expires_at, v_now + interval '24 hours'),
         quarantined_at = null,
         physical_purged_at = null,
         purge_reason = null,
         last_verified_at = v_now
   where object.object_key = p_object_key
     and object.content_sha256 = p_content_sha256
     and object.video_profile_sha256 = p_video_profile_sha256
     and object.audio_topology_sha256 = p_audio_topology_sha256
     and object.subtitle_topology_sha256 = p_subtitle_topology_sha256
     and object.root_playlist = p_root_playlist
     and object.state in ('quarantined', 'purged')
     and object.purge_reason = 'corruption'
     and not exists (
       select 1 from public.media_cache_purge_jobs critical_job
        where critical_job.object_key = object.object_key
          and critical_job.reason in ('legal', 'security')
     )
     and not exists (
       select 1 from public.media_cache_purge_jobs job
        where job.object_key = object.object_key
          and job.state in ('queued', 'leased', 'retry')
     )
  returning true into v_recovered;
  if coalesce(v_recovered, false) then
    update public.media_cache_purge_jobs job
       set recovery_cleared_at = v_now
     where job.object_key = p_object_key
       and job.reason = 'corruption'
       and job.recovery_cleared_at is null;
  end if;
  return coalesce(v_recovered, false);
end
$function$;

-- The legacy registration function remains private to the database owner.
-- New Edge replicas must prove the Gateway session was admitted before any R2
-- object can become authoritative in PostgreSQL.
revoke execute on function public.norva_commit_media_cache_publication(
  uuid, uuid, uuid, text, text, bigint, text, text, text, bigint,
  text, text, text, text, text, bigint, integer, timestamptz
) from service_role;

create function public.norva_commit_admitted_media_cache_publication(
  p_playback_session_id uuid,
  p_gateway_session_id uuid,
  p_user_id uuid,
  p_object_key text,
  p_content_sha256 text,
  p_file_size_bytes bigint,
  p_video_profile_sha256 text,
  p_audio_topology_sha256 text,
  p_subtitle_topology_sha256 text,
  p_duration_milliseconds bigint,
  p_pipeline_build text,
  p_segmenter_build text,
  p_storage_backend text,
  p_root_playlist text,
  p_manifest_sha256 text,
  p_total_bytes bigint,
  p_file_count integer,
  p_expires_at timestamptz
) returns table (
  binding_id uuid,
  object_key text
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_gateway public.cloud_gateway_sessions%rowtype;
  v_policy public.media_cache_governance_policy%rowtype;
  v_existing_object public.media_cache_objects%rowtype;
  v_row record;
  v_retention_class text;
  v_cancelled_purge_count integer := 0;
begin
  select gateway.* into v_gateway
    from public.cloud_gateway_sessions gateway
   where gateway.playback_session_id = p_playback_session_id
     and gateway.external_session_id = p_gateway_session_id
     and gateway.user_id = p_user_id
     and gateway.status <> 'failed'
   limit 1;
  if not found
     or v_gateway.media_cache_admitted is distinct from true
     or v_gateway.media_cache_admission_mode <> 'enforced'
     or v_gateway.media_cache_ttl_seconds not between 300 and 7776000
     or p_object_key is null or p_object_key !~ '^[0-9a-f]{64}$'
     or p_content_sha256 is null or p_content_sha256 !~ '^[0-9a-f]{64}$'
     or p_video_profile_sha256 is null or p_video_profile_sha256 !~ '^[0-9a-f]{64}$'
     or p_audio_topology_sha256 is null or p_audio_topology_sha256 !~ '^[0-9a-f]{64}$'
     or p_subtitle_topology_sha256 is null or p_subtitle_topology_sha256 !~ '^[0-9a-f]{64}$'
     or p_manifest_sha256 is null or p_manifest_sha256 !~ '^[0-9a-f]{64}$'
     or p_file_size_bytes is null or p_file_size_bytes <= 0
     or p_duration_milliseconds is null or p_duration_milliseconds <= 0
     or p_total_bytes is null or p_total_bytes <= 0
     or p_file_count is null or p_file_count not between 1 and 20000
     or p_storage_backend is null or p_storage_backend <> 'r2'
     or length(btrim(coalesce(p_pipeline_build, ''))) not between 1 and 256
     or length(btrim(coalesce(p_segmenter_build, ''))) not between 1 and 256
     or length(coalesce(p_root_playlist, '')) not between 1 and 1024
     or p_root_playlist !~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$'
     or p_root_playlist ~ '(^|/)\.{1,2}(/|$)'
     or p_root_playlist ~ '//'
     or p_expires_at is null
     or p_expires_at <= v_now + interval '5 minutes'
     or p_expires_at > v_now + pg_catalog.make_interval(
       secs => v_gateway.media_cache_ttl_seconds + 60
     ) then return; end if;

  select policy.* into v_policy
    from public.media_cache_governance_policy policy
   where policy.singleton;
  if not found
     or v_policy.admission_mode <> 'enforced'
     or p_file_count > v_policy.max_files_per_object then return; end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_object_key, 864691128455135232::bigint)
  );
  v_now := clock_timestamp();
  if p_expires_at <= v_now + interval '5 minutes' then return; end if;

  -- Lock the one active job (the partial index enforces uniqueness) after the
  -- object advisory lock. A fresh, unleased capacity/orphan decision may be
  -- preempted by real demand; a leased/retried or critical purge may not.
  perform 1
    from public.media_cache_purge_jobs job
   where job.object_key = p_object_key
     and job.state in ('queued', 'leased', 'retry')
   for update;
  if exists (
    select 1
      from public.media_cache_purge_jobs job
     where job.object_key = p_object_key
       and (
         job.reason in ('legal', 'security')
         or (job.reason = 'corruption' and job.recovery_cleared_at is null)
       )
  ) then return; end if;
  update public.media_cache_purge_jobs job
     set state = 'failed',
         available_at = v_now,
         last_error_code = 'authority_changed'
   where job.object_key = p_object_key
     and job.state = 'queued'
     and job.attempts = 0
     and job.reason in ('eviction', 'orphan');
  get diagnostics v_cancelled_purge_count = row_count;
  if exists (
    select 1
      from public.media_cache_purge_jobs job
     where job.object_key = p_object_key
       and job.state in ('queued', 'leased', 'retry')
  ) then return; end if;

  select object.* into v_existing_object
    from public.media_cache_objects object
   where object.object_key = p_object_key
   for update;
  if found and v_existing_object.purge_reason in ('corruption', 'legal', 'security') then
    return;
  end if;

  -- Cold capacity eviction preserves catalogue bindings. A later byte-exact
  -- manifest-last publication may therefore reactivate that same immutable
  -- identity without a second authorization mapping. Legal, security and
  -- corruption tombstones always require the explicit verified recovery RPC.
  update public.media_cache_objects object
     set state = 'ready',
         root_playlist = p_root_playlist,
         manifest_sha256 = p_manifest_sha256,
         total_bytes = p_total_bytes,
         file_count = p_file_count,
         expires_at = p_expires_at,
         retention_until = least(
           p_expires_at,
           v_now + pg_catalog.make_interval(secs => v_policy.minimum_retention_seconds)
         ),
         quarantined_at = null,
         physical_purged_at = null,
         purge_reason = null,
         last_verified_at = v_now
   where object.object_key = p_object_key
     and (
       object.state = 'purged'
       or (v_cancelled_purge_count = 1 and object.state = 'deleting')
     )
     and object.purge_reason in ('eviction', 'orphan')
     and object.content_sha256 = p_content_sha256
     and object.file_size_bytes = p_file_size_bytes
     and object.video_profile_sha256 = p_video_profile_sha256
     and object.audio_topology_sha256 = p_audio_topology_sha256
     and object.subtitle_topology_sha256 = p_subtitle_topology_sha256
     and object.duration_milliseconds = p_duration_milliseconds
     and object.pipeline_build = btrim(p_pipeline_build)
     and object.segmenter_build = btrim(p_segmenter_build)
     and not exists (
       select 1 from public.media_cache_purge_jobs job
        where job.object_key = object.object_key
          and job.state in ('queued', 'leased', 'retry')
     );
  select committed.* into v_row
    from public.norva_commit_media_cache_publication(
      p_playback_session_id, p_gateway_session_id, p_user_id,
      p_object_key, p_content_sha256, p_file_size_bytes,
      p_video_profile_sha256, p_audio_topology_sha256, p_subtitle_topology_sha256,
      p_duration_milliseconds, p_pipeline_build, p_segmenter_build,
      p_storage_backend, p_root_playlist, p_manifest_sha256,
      p_total_bytes, p_file_count, p_expires_at
    ) committed;
  if not found then
    if v_existing_object.object_key is null then
      delete from public.media_cache_objects object
       where object.object_key = p_object_key;
    else
      update public.media_cache_objects object
         set state = v_existing_object.state,
             root_playlist = v_existing_object.root_playlist,
             manifest_sha256 = v_existing_object.manifest_sha256,
             total_bytes = v_existing_object.total_bytes,
             file_count = v_existing_object.file_count,
             expires_at = v_existing_object.expires_at,
             retention_until = v_existing_object.retention_until,
             quarantined_at = v_existing_object.quarantined_at,
             physical_purged_at = v_existing_object.physical_purged_at,
             purge_reason = v_existing_object.purge_reason,
             last_verified_at = v_existing_object.last_verified_at
       where object.object_key = p_object_key;
    end if;
    return;
  end if;

  v_retention_class := case v_gateway.media_cache_admission_reason
    when 'popular' then 'hot'
    when 'repeated' then 'warm'
    when 'costly' then 'warm'
    else 'cold'
  end;
  update public.media_cache_objects object
     set retention_class = v_retention_class,
         admission_score = v_gateway.media_cache_admission_score,
         admission_confidence = v_gateway.media_cache_admission_confidence,
         admission_reason = v_gateway.media_cache_admission_reason,
         retention_until = least(
           object.expires_at,
           v_now + pg_catalog.make_interval(
              secs => greatest(
                v_policy.minimum_retention_seconds,
                least(v_gateway.media_cache_ttl_seconds, v_policy.hot_ttl_seconds)
              )
           )
         ),
         last_verified_at = v_now
   where object.object_key = p_object_key;

  return query select v_row.binding_id::uuid, v_row.object_key::text;
end
$function$;

create function public.norva_media_cache_observability_summary(
  p_hours integer default 24
) returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select case when p_hours not between 1 and 720 then '{}'::jsonb else jsonb_build_object(
    'protocol', 1,
    'windowHours', p_hours,
    'storage', jsonb_build_object(
      'bytes', coalesce((select sum(object.total_bytes) from public.media_cache_objects object
        where object.state in ('ready', 'quarantined', 'deleting')), 0),
      'objects', (select count(*) from public.media_cache_objects object
        where object.state in ('ready', 'quarantined', 'deleting')),
      'files', coalesce((select sum(object.file_count) from public.media_cache_objects object
        where object.state in ('ready', 'quarantined', 'deleting')), 0)
    ),
    'lifecycle', jsonb_build_object(
      'ready', (select count(*) from public.media_cache_objects object where object.state = 'ready'),
      'quarantined', (select count(*) from public.media_cache_objects object where object.state = 'quarantined'),
      'deleting', (select count(*) from public.media_cache_objects object where object.state = 'deleting'),
      'purged', (select count(*) from public.media_cache_objects object where object.state = 'purged'),
      'orphanJobs', (select count(*) from public.media_cache_purge_jobs job
        where job.reason = 'orphan' and job.state in ('queued', 'leased', 'retry')),
      'evictionJobs', (select count(*) from public.media_cache_purge_jobs job
        where job.reason = 'eviction' and job.state in ('queued', 'leased', 'retry'))
    ),
    'metrics', coalesce((
      select jsonb_object_agg(metric, jsonb_build_object(
        'value', value_sum, 'samples', sample_count, 'maximum', maximum_value
      ))
        from (
          select per_bucket.metric,
                 case
                   when per_bucket.metric in ('storage_bytes', 'storage_objects')
                     then (array_agg(per_bucket.value_sum order by per_bucket.bucket_start desc))[1]
                   else sum(per_bucket.value_sum)
                 end as value_sum,
                 case
                   when per_bucket.metric in ('storage_bytes', 'storage_objects')
                     then (array_agg(per_bucket.sample_count order by per_bucket.bucket_start desc))[1]
                   else sum(per_bucket.sample_count)
                 end as sample_count,
                 max(per_bucket.maximum_value) as maximum_value
            from (
              select bucket.bucket_start, bucket.metric,
                     sum(bucket.value_sum) as value_sum,
                     sum(bucket.sample_count) as sample_count,
                     max(bucket.maximum_value) as maximum_value
                from public.media_cache_metric_buckets bucket
               where bucket.bucket_start >= (
                 date_trunc('hour', clock_timestamp() at time zone 'UTC') at time zone 'UTC'
               )
                 - pg_catalog.make_interval(hours => p_hours)
               group by bucket.bucket_start, bucket.metric
            ) per_bucket
           group by per_bucket.metric
        ) aggregated
    ), '{}'::jsonb)
  ) end
$function$;

revoke all on function public.norva_record_media_cache_demand(text, text, integer)
  from public, anon, authenticated;
revoke all on function public.norva_prune_media_cache_demand(integer)
  from public, anon, authenticated;
revoke all on function public.norva_record_media_cache_metric(
  text, numeric, integer, text, text, text, text, text, integer, integer
) from public, anon, authenticated;
revoke all on function public.norva_enqueue_media_cache_purge(text, text)
  from public, anon, authenticated;
revoke all on function public.norva_schedule_media_cache_evictions(integer)
  from public, anon, authenticated;
revoke all on function public.norva_claim_media_cache_purge(text, integer)
  from public, anon, authenticated;
revoke all on function public.norva_complete_media_cache_purge(uuid, text, uuid, text, boolean, text)
  from public, anon, authenticated;
revoke all on function public.norva_recover_media_cache_object(
  text, text, text, text, text, text, text, bigint, integer, timestamptz
)
  from public, anon, authenticated;
revoke all on function public.norva_commit_admitted_media_cache_publication(
  uuid, uuid, uuid, text, text, bigint, text, text, text, bigint,
  text, text, text, text, text, bigint, integer, timestamptz
) from public, anon, authenticated;
revoke all on function public.norva_media_cache_observability_summary(integer)
  from public, anon, authenticated;

grant execute on function public.norva_record_media_cache_demand(text, text, integer)
  to service_role;
grant execute on function public.norva_prune_media_cache_demand(integer)
  to service_role;
grant execute on function public.norva_record_media_cache_metric(
  text, numeric, integer, text, text, text, text, text, integer, integer
) to service_role;
grant execute on function public.norva_enqueue_media_cache_purge(text, text)
  to service_role;
grant execute on function public.norva_schedule_media_cache_evictions(integer)
  to service_role;
grant execute on function public.norva_claim_media_cache_purge(text, integer)
  to service_role;
grant execute on function public.norva_complete_media_cache_purge(uuid, text, uuid, text, boolean, text)
  to service_role;
grant execute on function public.norva_recover_media_cache_object(
  text, text, text, text, text, text, text, bigint, integer, timestamptz
)
  to service_role;
grant execute on function public.norva_commit_admitted_media_cache_publication(
  uuid, uuid, uuid, text, text, bigint, text, text, text, bigint,
  text, text, text, text, text, bigint, integer, timestamptz
) to service_role;
grant execute on function public.norva_media_cache_observability_summary(integer)
  to service_role;

comment on table public.media_cache_governance_policy is
  'Service-only admission, retention and storage budgets; disabled by default for phased rollout.';
comment on table public.media_cache_demand_buckets is
  'Hourly demand counters keyed only by opaque HMAC work and account fingerprints; no eager catalogue crawl.';
comment on table public.media_cache_metric_buckets is
  'Bounded no-secret cache telemetry without user, provider URL, credential, object or ticket identifiers.';
comment on table public.media_cache_purge_jobs is
  'Crash-safe R2 plus CDN purge queue; physical deletion is leased and completed only after database safety checks.';

notify pgrst, 'reload schema';

commit;
