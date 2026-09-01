begin;

create table public.provider_route_policies (
  policy_key text primary key default 'default',
  enabled boolean not null default false,
  shadow_mode boolean not null default true,
  route_ttl_seconds integer not null default 604800,
  minimum_confidence numeric(5,4) not null default 0.6500,
  minimum_relative_gain numeric(5,4) not null default 0.2000,
  sustained_candidate_wins smallint not null default 3,
  consecutive_failure_threshold smallint not null default 3,
  tiny_probe_bytes integer not null default 1048576,
  sustained_probe_bytes integer not null default 16777216,
  top_candidate_count smallint not null default 2,
  benchmark_lease_seconds integer not null default 120,
  measurement_retention_seconds integer not null default 2592000,
  updated_at timestamptz not null default clock_timestamp(),
  constraint provider_route_policies_key_check
    check (policy_key = 'default'),
  constraint provider_route_policies_confidence_check
    check (minimum_confidence between 0 and 1),
  constraint provider_route_policies_gain_check
    check (minimum_relative_gain between 0.05 and 2),
  constraint provider_route_policies_wins_check
    check (sustained_candidate_wins between 2 and 12),
  constraint provider_route_policies_failures_check
    check (consecutive_failure_threshold between 2 and 12),
  constraint provider_route_policies_ttl_check
    check (route_ttl_seconds between 300 and 2592000),
  constraint provider_route_policies_probe_bytes_check
    check (
      tiny_probe_bytes between 262144 and 4194304
      and sustained_probe_bytes between 4194304 and 16777216
      and tiny_probe_bytes < sustained_probe_bytes
    ),
  constraint provider_route_policies_top_check
    check (top_candidate_count between 1 and 4),
  constraint provider_route_policies_lease_check
    check (benchmark_lease_seconds between 15 and 600),
  constraint provider_route_policies_retention_check
    check (measurement_retention_seconds between 86400 and 7776000)
);

insert into public.provider_route_policies (policy_key)
values ('default')
on conflict (policy_key) do nothing;

create table public.provider_route_state (
  scope text not null,
  route_identity text not null,
  host_fingerprint text not null,
  route_slot smallint not null,
  node_transport text not null,
  ffmpeg_slot smallint not null,
  score numeric(7,3) not null default 0,
  confidence numeric(5,4) not null default 0,
  sample_count integer not null default 0,
  consecutive_failures smallint not null default 0,
  candidate_slot smallint,
  candidate_node_transport text,
  candidate_wins smallint not null default 0,
  selected_reason text not null default 'deterministic-fallback',
  selected_at timestamptz not null default clock_timestamp(),
  last_measured_at timestamptz,
  expires_at timestamptz not null,
  version bigint not null default 1,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (scope, route_identity),
  constraint provider_route_state_scope_check
    check (scope in ('account', 'host')),
  constraint provider_route_state_identity_check
    check (
      route_identity ~ '^[0-9a-f]{64}$'
      and host_fingerprint ~ '^[0-9a-f]{64}$'
      and (scope <> 'host' or route_identity = host_fingerprint)
    ),
  constraint provider_route_state_route_check
    check (
      route_slot between 1 and 32
      and ffmpeg_slot = route_slot
      and node_transport in ('http', 'socks5')
    ),
  constraint provider_route_state_score_check
    check (score between 0 and 100 and confidence between 0 and 1),
  constraint provider_route_state_counters_check
    check (
      sample_count >= 0
      and consecutive_failures between 0 and 32767
      and candidate_wins between 0 and 32767
      and version > 0
    ),
  constraint provider_route_state_candidate_check
    check (
      (candidate_slot is null and candidate_node_transport is null and candidate_wins = 0)
      or (
        candidate_slot between 1 and 32
        and candidate_node_transport in ('http', 'socks5')
        and candidate_wins > 0
      )
    ),
  constraint provider_route_state_reason_check
    check (selected_reason in (
      'deterministic-fallback',
      'host-learned',
      'account-sticky',
      'no-current-route',
      'current-expired',
      'repeated-route-degradation',
      'sustained-significant-gain',
      'operator-rollback'
    )),
  constraint provider_route_state_expiry_check
    check (expires_at > selected_at)
);

create index provider_route_state_host_rank_idx
  on public.provider_route_state (host_fingerprint, scope, score desc, confidence desc);

create index provider_route_state_expiry_idx
  on public.provider_route_state (expires_at);

create table public.provider_route_measurements (
  id bigint generated always as identity primary key,
  account_fingerprint text not null,
  host_fingerprint text not null,
  route_slot smallint not null,
  node_transport text not null,
  phase text not null,
  sample_bytes integer not null,
  success boolean not null,
  ttfb_ms integer,
  first_4mib_ms integer,
  first_16mib_ms integer,
  throughput_bytes_per_second bigint,
  variance_ratio numeric(8,5),
  range_seek_ok boolean,
  resets smallint not null default 0,
  timeouts smallint not null default 0,
  proxy_407 smallint not null default 0,
  provider_458 smallint not null default 0,
  http_5xx smallint not null default 0,
  route_score numeric(7,3) not null,
  route_confidence numeric(5,4) not null default 0,
  observed_at timestamptz not null default clock_timestamp(),
  constraint provider_route_measurements_identity_check
    check (
      account_fingerprint ~ '^[0-9a-f]{64}$'
      and host_fingerprint ~ '^[0-9a-f]{64}$'
    ),
  constraint provider_route_measurements_route_check
    check (route_slot between 1 and 32 and node_transport in ('http', 'socks5')),
  constraint provider_route_measurements_phase_check
    check (phase in ('tiny', 'sustained', 'real-playback')),
  constraint provider_route_measurements_sample_check
    check (sample_bytes between 0 and 16777216),
  constraint provider_route_measurements_timings_check
    check (
      (ttfb_ms is null or ttfb_ms between 0 and 300000)
      and (first_4mib_ms is null or first_4mib_ms between 0 and 600000)
      and (first_16mib_ms is null or first_16mib_ms between 0 and 1200000)
      and (throughput_bytes_per_second is null or throughput_bytes_per_second between 0 and 10737418240)
      and (variance_ratio is null or variance_ratio between 0 and 100)
    ),
  constraint provider_route_measurements_failures_check
    check (
      resets between 0 and 32767
      and timeouts between 0 and 32767
      and proxy_407 between 0 and 32767
      and provider_458 between 0 and 32767
      and http_5xx between 0 and 32767
    ),
  constraint provider_route_measurements_score_check
    check (route_score between 0 and 100 and route_confidence between 0 and 1)
);

create index provider_route_measurements_account_recent_idx
  on public.provider_route_measurements (account_fingerprint, observed_at desc);

create index provider_route_measurements_host_rank_idx
  on public.provider_route_measurements (
    host_fingerprint,
    route_slot,
    node_transport,
    observed_at desc
  );

create index provider_route_measurements_retention_idx
  on public.provider_route_measurements (observed_at);

create table public.provider_route_activity (
  account_fingerprint text primary key,
  activity_kind text not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default clock_timestamp(),
  constraint provider_route_activity_identity_check
    check (account_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint provider_route_activity_kind_check
    check (activity_kind in ('viewer', 'gateway'))
);

create index provider_route_activity_expiry_idx
  on public.provider_route_activity (expires_at);

create table public.provider_route_leases (
  account_fingerprint text primary key,
  host_fingerprint text not null,
  lease_token uuid not null unique,
  owner_instance_fingerprint text not null,
  purpose text not null,
  preempt_requested boolean not null default false,
  acquired_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  updated_at timestamptz not null default clock_timestamp(),
  constraint provider_route_leases_identity_check
    check (
      account_fingerprint ~ '^[0-9a-f]{64}$'
      and host_fingerprint ~ '^[0-9a-f]{64}$'
      and owner_instance_fingerprint ~ '^[0-9a-f]{64}$'
    ),
  constraint provider_route_leases_purpose_check
    check (purpose = 'route-benchmark'),
  constraint provider_route_leases_expiry_check
    check (expires_at > acquired_at)
);

create index provider_route_leases_expiry_idx
  on public.provider_route_leases (expires_at);

alter table public.provider_route_policies enable row level security;
alter table public.provider_route_policies force row level security;
alter table public.provider_route_state enable row level security;
alter table public.provider_route_state force row level security;
alter table public.provider_route_measurements enable row level security;
alter table public.provider_route_measurements force row level security;
alter table public.provider_route_activity enable row level security;
alter table public.provider_route_activity force row level security;
alter table public.provider_route_leases enable row level security;
alter table public.provider_route_leases force row level security;

revoke all on table public.provider_route_policies from public, anon, authenticated;
revoke all on table public.provider_route_state from public, anon, authenticated;
revoke all on table public.provider_route_measurements from public, anon, authenticated;
revoke all on table public.provider_route_activity from public, anon, authenticated;
revoke all on table public.provider_route_leases from public, anon, authenticated;
revoke all on sequence public.provider_route_measurements_id_seq from public, anon, authenticated;

grant select, insert, update, delete on table public.provider_route_policies to service_role;
grant select, insert, update, delete on table public.provider_route_state to service_role;
grant select, insert, update, delete on table public.provider_route_measurements to service_role;
grant select, insert, update, delete on table public.provider_route_activity to service_role;
grant select, insert, update, delete on table public.provider_route_leases to service_role;
grant usage, select on sequence public.provider_route_measurements_id_seq to service_role;

create or replace function public.norva_claim_provider_route_lease(
  p_account_fingerprint text,
  p_host_fingerprint text,
  p_owner_instance_fingerprint text,
  p_ttl_seconds integer default 120
) returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_token uuid := gen_random_uuid();
  v_claimed uuid;
begin
  if p_account_fingerprint is null
     or p_host_fingerprint is null
     or p_owner_instance_fingerprint is null
     or p_ttl_seconds is null
     or p_account_fingerprint !~ '^[0-9a-f]{64}$'
     or p_host_fingerprint !~ '^[0-9a-f]{64}$'
     or p_owner_instance_fingerprint !~ '^[0-9a-f]{64}$'
     or p_ttl_seconds not between 15 and 600 then
    return null;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_account_fingerprint, 691752902764108185::bigint)
  );
  if exists (
    select 1
      from public.provider_route_activity
     where account_fingerprint = p_account_fingerprint
       and expires_at > v_now
  ) then
    return null;
  end if;

  insert into public.provider_route_leases (
    account_fingerprint,
    host_fingerprint,
    lease_token,
    owner_instance_fingerprint,
    purpose,
    preempt_requested,
    acquired_at,
    expires_at,
    updated_at
  ) values (
    p_account_fingerprint,
    p_host_fingerprint,
    v_token,
    p_owner_instance_fingerprint,
    'route-benchmark',
    false,
    v_now,
    v_now + make_interval(secs => p_ttl_seconds),
    v_now
  )
  on conflict (account_fingerprint) do update
     set host_fingerprint = excluded.host_fingerprint,
         lease_token = excluded.lease_token,
         owner_instance_fingerprint = excluded.owner_instance_fingerprint,
         purpose = excluded.purpose,
         preempt_requested = false,
         acquired_at = excluded.acquired_at,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at
   where public.provider_route_leases.expires_at <= v_now
  returning lease_token into v_claimed;

  return v_claimed;
end
$function$;

create or replace function public.norva_renew_provider_route_lease(
  p_account_fingerprint text,
  p_lease_token uuid,
  p_ttl_seconds integer default 120
) returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_renewed boolean := false;
begin
  if p_account_fingerprint is null
     or p_account_fingerprint !~ '^[0-9a-f]{64}$'
     or p_lease_token is null
     or p_ttl_seconds is null
     or p_ttl_seconds not between 15 and 600 then
    return false;
  end if;
  update public.provider_route_leases
     set expires_at = v_now + make_interval(secs => p_ttl_seconds),
         updated_at = v_now
   where account_fingerprint = p_account_fingerprint
     and lease_token = p_lease_token
     and expires_at > v_now
     and not preempt_requested
  returning true into v_renewed;
  return coalesce(v_renewed, false);
end
$function$;

create or replace function public.norva_preempt_provider_route_lease(
  p_account_fingerprint text
) returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_preempted boolean := false;
begin
  if p_account_fingerprint is null
     or p_account_fingerprint !~ '^[0-9a-f]{64}$' then return false; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_account_fingerprint, 691752902764108185::bigint)
  );
  insert into public.provider_route_activity (
    account_fingerprint,
    activity_kind,
    expires_at,
    updated_at
  ) values (
    p_account_fingerprint,
    'viewer',
    clock_timestamp() + interval '90 seconds',
    clock_timestamp()
  )
  on conflict (account_fingerprint) do update
     set activity_kind = 'viewer',
         expires_at = greatest(
           public.provider_route_activity.expires_at,
           excluded.expires_at
         ),
         updated_at = excluded.updated_at;
  update public.provider_route_leases
     set preempt_requested = true,
         updated_at = clock_timestamp()
   where account_fingerprint = p_account_fingerprint
     and expires_at > clock_timestamp()
  returning true into v_preempted;
  return coalesce(v_preempted, false);
end
$function$;

create or replace function public.norva_touch_provider_route_activity(
  p_account_fingerprints text[],
  p_activity_kind text default 'viewer',
  p_ttl_seconds integer default 90
) returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_fingerprint text;
  v_fingerprints text[];
  v_now timestamptz := clock_timestamp();
  v_touched integer := 0;
begin
  if p_account_fingerprints is null
     or cardinality(p_account_fingerprints) not between 1 and 64
     or p_activity_kind not in ('viewer', 'gateway')
     or p_ttl_seconds not between 30 and 300
     or exists (
       select 1
         from unnest(p_account_fingerprints) as value
        where value is null or value !~ '^[0-9a-f]{64}$'
     ) then
    return 0;
  end if;

  select array_agg(value order by value)
    into v_fingerprints
    from (select distinct unnest(p_account_fingerprints) as value) unique_values;

  foreach v_fingerprint in array v_fingerprints loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(v_fingerprint, 691752902764108185::bigint)
    );
    insert into public.provider_route_activity (
      account_fingerprint,
      activity_kind,
      expires_at,
      updated_at
    ) values (
      v_fingerprint,
      p_activity_kind,
      v_now + make_interval(secs => p_ttl_seconds),
      v_now
    )
    on conflict (account_fingerprint) do update
       set activity_kind = excluded.activity_kind,
           expires_at = greatest(
             public.provider_route_activity.expires_at,
             excluded.expires_at
           ),
           updated_at = excluded.updated_at;
    update public.provider_route_leases
       set preempt_requested = true,
           updated_at = v_now
     where account_fingerprint = v_fingerprint
       and expires_at > v_now;
    v_touched := v_touched + 1;
  end loop;
  return v_touched;
end
$function$;

create or replace function public.norva_release_provider_route_lease(
  p_account_fingerprint text,
  p_lease_token uuid
) returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_released boolean := false;
begin
  if p_account_fingerprint is null
     or p_account_fingerprint !~ '^[0-9a-f]{64}$'
     or p_lease_token is null then return false; end if;
  delete from public.provider_route_leases
   where account_fingerprint = p_account_fingerprint
     and lease_token = p_lease_token
  returning true into v_released;
  return coalesce(v_released, false);
end
$function$;

revoke all on function public.norva_claim_provider_route_lease(text, text, text, integer)
  from public, anon, authenticated;
revoke all on function public.norva_renew_provider_route_lease(text, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.norva_preempt_provider_route_lease(text)
  from public, anon, authenticated;
revoke all on function public.norva_touch_provider_route_activity(text[], text, integer)
  from public, anon, authenticated;
revoke all on function public.norva_release_provider_route_lease(text, uuid)
  from public, anon, authenticated;

grant execute on function public.norva_claim_provider_route_lease(text, text, text, integer)
  to service_role;
grant execute on function public.norva_renew_provider_route_lease(text, uuid, integer)
  to service_role;
grant execute on function public.norva_preempt_provider_route_lease(text)
  to service_role;
grant execute on function public.norva_touch_provider_route_activity(text[], text, integer)
  to service_role;
grant execute on function public.norva_release_provider_route_lease(text, uuid)
  to service_role;

comment on table public.provider_route_state is
  'Server-only sticky route state keyed exclusively by HMAC fingerprints; never provider labels or Norva users.';
comment on table public.provider_route_measurements is
  'Bounded server-only route telemetry without provider URLs, credentials, proxy endpoints, or user identities.';
comment on table public.provider_route_activity is
  'Short HMAC-only viewer activity fence that prevents a distributed benchmark from opening beside playback.';
comment on table public.provider_route_leases is
  'Distributed benchmark coordination only; real playback retains priority through immediate preemption.';

notify pgrst, 'reload schema';

commit;
