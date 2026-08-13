-- Provider-account playback arbitration.
--
-- A single-slot provider account must have one authoritative Norva owner at a
-- time. The opaque SHA-256 account hash contains no URL or credential and is
-- writable only through service-role functions.

alter table public.cloud_playback_sessions
  add column if not exists provider_account_hash text,
  add column if not exists superseded_at timestamptz;

alter table public.cloud_playback_sessions
  drop constraint if exists cloud_playback_sessions_superseded_by_fkey;

-- A replacement only needs a terminal timestamp. Persisting the replacing
-- session UUID would disclose a cross-user identifier through historical broad
-- SELECT grants and is not needed by any player decision.
alter table public.cloud_playback_sessions
  drop column if exists superseded_by;

alter table public.cloud_playback_sessions
  drop constraint if exists cloud_playback_sessions_provider_account_hash_check,
  add constraint cloud_playback_sessions_provider_account_hash_check
    check (provider_account_hash is null or provider_account_hash ~ '^[0-9a-f]{64}$');

-- The new metadata is authored only by service-role Edge functions. Column
-- grants can survive a table-level revoke, so remove mutation privileges too.
revoke insert (provider_account_hash, superseded_at)
  on table public.cloud_playback_sessions from public, anon, authenticated;
revoke update (provider_account_hash, superseded_at)
  on table public.cloud_playback_sessions from public, anon, authenticated;

-- Older migrations granted table-wide SELECT for Realtime compatibility. Move
-- authenticated clients to an explicit projection before the service-only
-- provider identity is used. RLS still limits these rows to their owner.
revoke select on table public.cloud_playback_sessions from public, anon, authenticated;
revoke select (provider_account_hash)
  on table public.cloud_playback_sessions from public, anon, authenticated;
grant select (
  id,
  user_id,
  source_id,
  device_id,
  item_type,
  item_id,
  mode,
  status,
  target_url_hash,
  stream_mime,
  playback_hint,
  error_code,
  error_message,
  expires_at,
  created_at,
  updated_at,
  native_heartbeat_at,
  superseded_at
) on table public.cloud_playback_sessions to authenticated;

create index if not exists cloud_playback_sessions_provider_account_idx
  on public.cloud_playback_sessions (user_id, provider_account_hash, created_at desc)
  where provider_account_hash is not null;

drop index if exists public.cloud_playback_sessions_one_active_provider_account_idx;
create unique index cloud_playback_sessions_one_active_provider_account_idx
  on public.cloud_playback_sessions (provider_account_hash)
  where provider_account_hash is not null and status in ('pending', 'ready');

create table if not exists public.provider_playback_circuits (
  provider_account_hash text primary key
    check (provider_account_hash ~ '^[0-9a-f]{64}$'),
  opened_at timestamptz not null,
  blocked_until timestamptz not null,
  reason_code text not null
    check (reason_code in ('PROVIDER_BUSY')),
  failure_count integer not null default 1
    check (failure_count between 1 and 16),
  updated_at timestamptz not null default now(),
  constraint provider_playback_circuits_window_check
    check (blocked_until > opened_at and blocked_until <= opened_at + interval '15 minutes')
);

alter table public.provider_playback_circuits enable row level security;
revoke all on table public.provider_playback_circuits from public, anon, authenticated;
grant select, insert, update, delete on table public.provider_playback_circuits to service_role;

create or replace function public.claim_cloud_playback_session(
  p_session_id uuid,
  p_user_id uuid,
  p_source_id uuid,
  p_device_id uuid,
  p_item_type text,
  p_item_id text,
  p_mode text,
  p_status text,
  p_target_url_hash text,
  p_provider_account_hash text,
  p_stream_mime text,
  p_playback_hint jsonb,
  p_expires_at timestamptz
)
returns table(new_session_id uuid, superseded_session_ids uuid[])
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_superseded uuid[] := '{}'::uuid[];
begin
  if p_session_id is null or p_user_id is null
     or p_source_id is null
     or p_provider_account_hash is null
     or p_provider_account_hash !~ '^[0-9a-f]{64}$'
     or p_item_type is null or length(p_item_type) = 0
     or p_item_id is null or length(p_item_id) = 0
     or p_mode not in ('direct', 'relay', 'transcode')
     or p_status not in ('pending', 'ready')
     or p_expires_at <= v_now then
    raise exception 'invalid playback session claim' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('provider-session:' || p_provider_account_hash, 0)
  );

  select coalesce(array_agg(id order by created_at), '{}'::uuid[])
    into v_superseded
    from public.cloud_playback_sessions
   where provider_account_hash = p_provider_account_hash
     and status in ('pending', 'ready');

  update public.cloud_playback_sessions
     set status = 'expired',
         expires_at = least(expires_at, v_now),
         superseded_at = v_now,
         updated_at = v_now
   where id = any(v_superseded);

  insert into public.cloud_playback_sessions (
    id, user_id, source_id, device_id, item_type, item_id, mode, status,
    target_url_hash, provider_account_hash, stream_mime, playback_hint, expires_at
  ) values (
    p_session_id, p_user_id, p_source_id, p_device_id, p_item_type, p_item_id,
    p_mode, p_status, p_target_url_hash, p_provider_account_hash, p_stream_mime,
    coalesce(p_playback_hint, '{}'::jsonb), p_expires_at
  );

  return query select p_session_id, v_superseded;
end;
$$;

revoke all on function public.claim_cloud_playback_session(
  uuid, uuid, uuid, uuid, text, text, text, text, text, text, text, jsonb, timestamptz
) from public, anon, authenticated;
grant execute on function public.claim_cloud_playback_session(
  uuid, uuid, uuid, uuid, text, text, text, text, text, text, text, jsonb, timestamptz
) to service_role;

-- Replace the pre-hardening overload explicitly. It is recreated below as a
-- service-only, non-escalating shim so the database migration can safely land
-- before every Edge isolate has picked up the three-argument call.
drop function if exists public.open_provider_playback_circuit(text, text);
drop function if exists public.open_provider_playback_circuit(text, text, boolean);

create function public.open_provider_playback_circuit(
  p_provider_account_hash text,
  p_reason_code text,
  p_escalate boolean
)
returns table(blocked_until timestamptz, failure_count integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_previous public.provider_playback_circuits%rowtype;
  v_failure_count integer;
  v_cooldown_seconds integer;
  v_blocked_until timestamptz;
begin
  if p_provider_account_hash is null
     or p_provider_account_hash !~ '^[0-9a-f]{64}$'
     or p_reason_code <> 'PROVIDER_BUSY'
     or p_escalate is null then
    raise exception 'invalid provider circuit signal' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('provider-circuit:' || p_provider_account_hash, 0)
  );

  select * into v_previous
    from public.provider_playback_circuits
   where provider_account_hash = p_provider_account_hash
   for update;

  if not p_escalate then
    -- Authenticated clients may report their own server-created session as
    -- busy, but cannot turn repeated reports into an unbounded account DoS.
    -- While the fixed window is open, acknowledge it without extending it.
    if found and v_previous.blocked_until > v_now then
      return query select v_previous.blocked_until, v_previous.failure_count;
      return;
    end if;

    if not found or v_previous.blocked_until < v_now - interval '30 minutes' then
      v_failure_count := 1;
    else
      v_failure_count := greatest(1, v_previous.failure_count);
    end if;
    v_blocked_until := v_now + interval '120 seconds';
  else
    -- Only norva-playback can set p_escalate=true, after its own gateway request
    -- has observed HTTP 458. Those independent server observations may back off.
    if not found or v_previous.blocked_until < v_now - interval '30 minutes' then
      v_failure_count := 1;
    else
      v_failure_count := least(16, v_previous.failure_count + 1);
    end if;
    v_cooldown_seconds := least(900, 120 * (2 ^ least(3, v_failure_count - 1))::integer);
    v_blocked_until := v_now + pg_catalog.make_interval(secs => v_cooldown_seconds);
  end if;

  insert into public.provider_playback_circuits (
    provider_account_hash, opened_at, blocked_until, reason_code, failure_count, updated_at
  ) values (
    p_provider_account_hash, v_now, v_blocked_until, p_reason_code, v_failure_count, v_now
  )
  on conflict (provider_account_hash) do update
    set opened_at = excluded.opened_at,
        blocked_until = excluded.blocked_until,
        reason_code = excluded.reason_code,
        failure_count = excluded.failure_count,
        updated_at = excluded.updated_at;

  return query select v_blocked_until, v_failure_count;
end;
$$;

revoke all on function public.open_provider_playback_circuit(text, text, boolean)
  from public, anon, authenticated;
grant execute on function public.open_provider_playback_circuit(text, text, boolean)
  to service_role;

create function public.open_provider_playback_circuit(
  p_provider_account_hash text,
  p_reason_code text
)
returns table(blocked_until timestamptz, failure_count integer)
language sql
security invoker
set search_path = ''
as $$
  select *
    from public.open_provider_playback_circuit(
      p_provider_account_hash,
      p_reason_code,
      false
    );
$$;

revoke all on function public.open_provider_playback_circuit(text, text)
  from public, anon, authenticated;
grant execute on function public.open_provider_playback_circuit(text, text)
  to service_role;
