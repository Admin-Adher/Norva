-- Anti-abuse velocity store.
--
-- This table counts. It does not decide. No threshold, no verdict and no
-- allow/deny lives here, so an attack can be answered by moving configuration
-- rather than by shipping a migration. The risk engine reads these counters as
-- signals among several others, exactly as the brief requires: behaviour, not
-- the shape of an email address.
--
-- Two departures from the existing affiliate_referral_rate_buckets pattern,
-- both deliberate.
--
-- 1. Sliding window, not a fixed one. That table keys on a single bucket_start,
--    which means a burst straddling a boundary passes twice the budget — the
--    exact defect measured on Kong's rate-limiting plugin, where the 31st POST
--    was refused but a burst crossing the minute mark was not. Every event is
--    written at TWO resolutions here: minute buckets serve windows up to an
--    hour (at most 60 rows summed), hour buckets serve everything longer (24
--    rows for a day). Precision is one minute, read cost is bounded.
--
-- 2. Salted hashes. A bare sha256 of an IPv4 address is not pseudonymisation,
--    it is an encoding: 2^32 candidates fall to a GPU in seconds, and the same
--    holds for any email in a breach corpus. The caller salts with a secret
--    held only in the environment, never in the database. Losing the salt makes
--    the history unreadable, which is the point — a copy of this table on its
--    own reveals no one.
--
-- Retention is short and enforced by velocity_prune, called from cron: 48 hours
-- of minute buckets, 30 days of hour buckets. Nothing here needs to outlive the
-- decision it informed.

create schema if not exists abuse_private;

revoke all on schema abuse_private from public, anon, authenticated;

create table if not exists abuse_private.velocity_buckets (
  dimension     text        not null,
  resolution    text        not null,
  subject_hash  text        not null,
  bucket_start  timestamptz not null,
  hits          integer     not null default 1,
  updated_at    timestamptz not null default now(),
  primary key (dimension, resolution, subject_hash, bucket_start),
  -- The list of dimensions is code, not configuration: adding one means
  -- teaching the engine to compute it. Thresholds are what stays tunable.
  -- ip_subnet_48 exists because Norva serves real IPv6 traffic, where a /48 is
  -- the meaningful unit rather than a /24.
  constraint velocity_buckets_dimension check (
    dimension in (
      'ip', 'ip_subnet_24', 'ip_subnet_48', 'asn',
      'email', 'device', 'user_agent'
    )
  ),
  constraint velocity_buckets_resolution check (resolution in ('minute', 'hour')),
  constraint velocity_buckets_hash check (subject_hash ~ '^[0-9a-f]{64}$'),
  constraint velocity_buckets_hits check (hits between 1 and 1000000000)
);

comment on table abuse_private.velocity_buckets is
  'Salted, pseudonymised event counters for anti-abuse velocity. Counts only: '
  'thresholds and decisions live in configuration and in the risk engine.';

-- Pruning walks by resolution and age, never by subject.
create index if not exists velocity_buckets_retention_idx
  on abuse_private.velocity_buckets (resolution, bucket_start);

alter table abuse_private.velocity_buckets enable row level security;

revoke all on table abuse_private.velocity_buckets
  from public, anon, authenticated, service_role;

-- Increment every supplied dimension and return the counts the caller asked
-- for, in one round trip. The signup path cannot afford six of them.
--
-- security definer because the table is revoked from every role including
-- service_role: the only way in is through this function, which constrains what
-- can be written to the dimensions and the hash shape above.
create or replace function abuse_private.velocity_touch(p_entries jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now        timestamptz := now();
  v_minute     timestamptz := date_trunc('minute', v_now);
  v_hour       timestamptz := date_trunc('hour', v_now);
  v_entry      jsonb;
  v_dimension  text;
  v_hash       text;
  v_windows    jsonb;
  v_seconds    integer;
  v_counts     jsonb;
  v_count      bigint;
  v_floor      timestamptz;
  v_out        jsonb := '[]'::jsonb;
begin
  if p_entries is null or jsonb_typeof(p_entries) <> 'array' then
    raise exception 'velocity_touch expects a json array';
  end if;
  -- A bounded fan-out keeps one malformed caller from turning a signup into a
  -- thousand writes.
  if jsonb_array_length(p_entries) > 16 then
    raise exception 'velocity_touch accepts at most 16 entries';
  end if;

  for v_entry in select value from jsonb_array_elements(p_entries) loop
    v_dimension := v_entry->>'dimension';
    v_hash      := v_entry->>'subject_hash';
    v_windows   := coalesce(v_entry->'windows_seconds', '[]'::jsonb);

    if v_dimension is null or v_hash is null then
      raise exception 'velocity_touch entry needs dimension and subject_hash';
    end if;

    -- One statement per resolution. insert .. on conflict .. do update is a
    -- single atomic write, so a hundred simultaneous signups increment a
    -- hundred times: no read-modify-write, no lost update, no advisory lock.
    insert into abuse_private.velocity_buckets as b
      (dimension, resolution, subject_hash, bucket_start, hits, updated_at)
    values (v_dimension, 'minute', v_hash, v_minute, 1, v_now)
    on conflict (dimension, resolution, subject_hash, bucket_start)
    do update set hits = b.hits + 1, updated_at = v_now;

    insert into abuse_private.velocity_buckets as b
      (dimension, resolution, subject_hash, bucket_start, hits, updated_at)
    values (v_dimension, 'hour', v_hash, v_hour, 1, v_now)
    on conflict (dimension, resolution, subject_hash, bucket_start)
    do update set hits = b.hits + 1, updated_at = v_now;

    v_counts := '{}'::jsonb;

    for v_seconds in
      select value::integer
      from jsonb_array_elements_text(v_windows)
      where value ~ '^[0-9]{1,7}$'
    loop
      if v_seconds <= 0 then
        continue;
      end if;

      if v_seconds <= 3600 then
        -- Minute resolution: include the partial current minute, which is why
        -- the floor is truncated rather than subtracted exactly.
        v_floor := date_trunc('minute', v_now - make_interval(secs => v_seconds));
        select coalesce(sum(b.hits), 0)
          into v_count
          from abuse_private.velocity_buckets b
         where b.dimension = v_dimension
           and b.resolution = 'minute'
           and b.subject_hash = v_hash
           and b.bucket_start >= v_floor;
      else
        v_floor := date_trunc('hour', v_now - make_interval(secs => v_seconds));
        select coalesce(sum(b.hits), 0)
          into v_count
          from abuse_private.velocity_buckets b
         where b.dimension = v_dimension
           and b.resolution = 'hour'
           and b.subject_hash = v_hash
           and b.bucket_start >= v_floor;
      end if;

      v_counts := v_counts || jsonb_build_object(v_seconds::text, v_count);
    end loop;

    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'dimension', v_dimension,
      'subject_hash', v_hash,
      'counts', v_counts
    ));
  end loop;

  return v_out;
end;
$$;

-- Retention. Called from cron; returns how many rows went, so a run that
-- deletes nothing for days is visible rather than silent.
create or replace function abuse_private.velocity_prune(
  p_minute_retention interval default interval '48 hours',
  p_hour_retention   interval default interval '30 days'
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer := 0;
  v_batch   integer;
begin
  delete from abuse_private.velocity_buckets
   where resolution = 'minute'
     and bucket_start < now() - p_minute_retention;
  get diagnostics v_batch = row_count;
  v_deleted := v_deleted + v_batch;

  delete from abuse_private.velocity_buckets
   where resolution = 'hour'
     and bucket_start < now() - p_hour_retention;
  get diagnostics v_batch = row_count;
  v_deleted := v_deleted + v_batch;

  return v_deleted;
end;
$$;

revoke all on function abuse_private.velocity_touch(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function abuse_private.velocity_prune(interval, interval)
  from public, anon, authenticated, service_role;

-- Public shims. Browser roles never reach them: the edge functions authenticate
-- the caller, resolve the client identity from the gateway and pass only
-- already-salted hashes, so no raw address or email crosses this boundary.
create or replace function public.abuse_velocity_touch(p_entries jsonb)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select abuse_private.velocity_touch(p_entries);
$$;

create or replace function public.abuse_velocity_prune(
  p_minute_retention interval default interval '48 hours',
  p_hour_retention   interval default interval '30 days'
)
returns integer
language sql
security definer
set search_path = ''
as $$
  select abuse_private.velocity_prune(p_minute_retention, p_hour_retention);
$$;

revoke all on function public.abuse_velocity_touch(jsonb)
  from public, anon, authenticated;
grant execute on function public.abuse_velocity_touch(jsonb) to service_role;

revoke all on function public.abuse_velocity_prune(interval, interval)
  from public, anon, authenticated;
grant execute on function public.abuse_velocity_prune(interval, interval) to service_role;
