-- The app reports a lightweight `presence` intent before playback starts. That
-- intent must keep autonomous probes away, but it must not block an explicit
-- foreground language-validation job. At the same time, a later presence tick
-- must never hide a fresh session/raw/gateway activity row in the single-row
-- provider ledger.

create or replace function public.provider_account_touch_by_user(p_user uuid, p_kind text)
returns void
language sql
security definer
set search_path = ''
as $function$
  insert into public.provider_account_activity as activity (
    account_key,
    last_seen_at,
    kind
  )
  select distinct
    lower(source.config_hint->>'serverHost') || '/' || (source.config_hint->>'username'),
    statement_timestamp(),
    left(coalesce(p_kind, ''), 32)
  from public.cloud_sources as source
  where source.user_id = p_user
    and source.deleted_at is null
    and coalesce(source.config_hint->>'serverHost', '') <> ''
    and coalesce(source.config_hint->>'username', '') <> ''
  on conflict (account_key) do update
    set last_seen_at = excluded.last_seen_at,
        kind = excluded.kind
    where excluded.kind is distinct from 'presence'
       or activity.kind = 'presence'
       or activity.last_seen_at <= excluded.last_seen_at - interval '5 minutes';
$function$;

-- Foreground validation ignores only a pure presence intent. Unknown/null kinds
-- remain busy fail-closed, as do every real activity kind while it is fresh.
create or replace function public.provider_account_busy_for_foreground_validation(p_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(
    (select activity.last_seen_at > statement_timestamp() - interval '5 minutes'
            and activity.kind is distinct from 'presence'
     from public.provider_account_activity as activity
     where activity.account_key = p_key),
    false);
$function$;

revoke all on function public.provider_account_touch_by_user(uuid, text)
  from public, anon, authenticated;
revoke all on function public.provider_account_busy_for_foreground_validation(text)
  from public, anon, authenticated;
grant execute on function public.provider_account_touch_by_user(uuid, text)
  to service_role;
grant execute on function public.provider_account_busy_for_foreground_validation(text)
  to service_role;

comment on function public.provider_account_busy_for_foreground_validation(text) is
  'True for fresh non-presence provider activity; presence alone is ignored for an explicit foreground validation.';

-- A short account-wide lease closes the last race between the final foreground
-- idle check and the provider request. Playback claims and language-validation
-- claims use the exact same advisory-lock key, so only one can be admitted.
create table if not exists public.provider_account_language_validation_leases (
  provider_account_hash text primary key
    check (provider_account_hash ~ '^[0-9a-f]{64}$'),
  lease_owner text not null
    check (coalesce(btrim(lease_owner), '') <> '' and length(lease_owner) <= 200),
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

alter table public.provider_account_language_validation_leases enable row level security;
revoke all on table public.provider_account_language_validation_leases
  from public, anon, authenticated;
grant select, insert, update, delete
  on table public.provider_account_language_validation_leases to service_role;

create or replace function public.claim_provider_account_language_validation(
  p_provider_account_hash text,
  p_lease_owner text,
  p_ttl_seconds integer default 900
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_ttl integer := greatest(30, least(900, coalesce(p_ttl_seconds, 900)));
  v_claimed boolean := false;
begin
  if p_provider_account_hash is null
     or p_provider_account_hash !~ '^[0-9a-f]{64}$'
     or coalesce(btrim(p_lease_owner), '') = ''
     or length(p_lease_owner) > 200 then
    return false;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('provider-session:' || p_provider_account_hash, 0)
  );
  v_now := clock_timestamp();

  if exists (
    select 1
    from public.cloud_playback_sessions as session
    where session.provider_account_hash = p_provider_account_hash
      and session.status in ('pending', 'ready')
      and session.expires_at > v_now
  ) then
    return false;
  end if;

  insert into public.provider_account_language_validation_leases as lease (
    provider_account_hash,
    lease_owner,
    expires_at,
    updated_at
  ) values (
    p_provider_account_hash,
    p_lease_owner,
    v_now + pg_catalog.make_interval(secs => v_ttl),
    v_now
  )
  on conflict (provider_account_hash) do update
    set lease_owner = excluded.lease_owner,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
    where lease.expires_at <= v_now
       or lease.lease_owner = excluded.lease_owner
  returning true into v_claimed;

  return coalesce(v_claimed, false);
end;
$function$;

create or replace function public.release_provider_account_language_validation(
  p_provider_account_hash text,
  p_lease_owner text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_count integer := 0;
begin
  if p_provider_account_hash is null
     or p_provider_account_hash !~ '^[0-9a-f]{64}$'
     or coalesce(btrim(p_lease_owner), '') = ''
     or length(p_lease_owner) > 200 then
    return false;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('provider-session:' || p_provider_account_hash, 0)
  );

  delete from public.provider_account_language_validation_leases
  where provider_account_hash = p_provider_account_hash
    and lease_owner = p_lease_owner;
  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$function$;

revoke all on function public.claim_provider_account_language_validation(text, text, integer)
  from public, anon, authenticated;
revoke all on function public.release_provider_account_language_validation(text, text)
  from public, anon, authenticated;
grant execute on function public.claim_provider_account_language_validation(text, text, integer)
  to service_role;
grant execute on function public.release_provider_account_language_validation(text, text)
  to service_role;

-- Keep the established session-claim contract, adding only the account-wide
-- validation lease check under its existing provider-session advisory lock.
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
as $function$
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
  v_now := clock_timestamp();
  if p_expires_at <= v_now then
    raise exception 'invalid playback session claim' using errcode = '22023';
  end if;

  if exists (
    select 1
    from public.provider_account_language_validation_leases as lease
    where lease.provider_account_hash = p_provider_account_hash
      and lease.expires_at > v_now
  ) then
    raise exception 'provider language validation in progress'
      using errcode = '55P03';
  end if;

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
$function$;

revoke all on function public.claim_cloud_playback_session(
  uuid, uuid, uuid, uuid, text, text, text, text, text, text, text, jsonb, timestamptz
) from public, anon, authenticated;
grant execute on function public.claim_cloud_playback_session(
  uuid, uuid, uuid, uuid, text, text, text, text, text, text, text, jsonb, timestamptz
) to service_role;

-- The Edge rollout follows this migration immediately. Make the new RPC visible
-- to PostgREST only after the surrounding migration transaction commits.
notify pgrst, 'reload schema';
