-- Premium signup Telegram attribution.
--
-- Deployment order is deliberately database-first:
--   * the original nine claim columns keep their names, types and order, so the
--     already-deployed worker can ignore the additional JSON properties;
--   * no attribution value is copied into the durable outbox. The claim joins
--     cloud_signup_attribution only when a delivery lease is acquired;
--   * a first delivery waits for complete auth-return attribution. Its fallback
--     is scheduled on the last minutely drain tick between +60 and +120 seconds,
--     so the enrichment window remains bounded at 120 seconds without requiring
--     a per-signup cron. The timeout produces one partial notification, not a
--     later enrichment follow-up;
--   * Telegram delivery remains at-least-once at the transport boundary because
--     Telegram does not support an idempotency key. PostgreSQL still owns one
--     outbox event per user, SKIP LOCKED claims, leases and CAS acknowledgements.

-- The outbox is service-only even when public is exposed through PostgREST.
alter table public.cloud_signup_telegram_outbox enable row level security;
revoke all on table public.cloud_signup_telegram_outbox
  from public, anon, authenticated;

-- Apply the bounded enrichment window before the existing Auth trigger freezes
-- a new outbox event. A complete row that predates the outbox (defensive race
-- handling) is immediately eligible.
create or replace function public.norva_schedule_signup_telegram_enrichment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_signed_up_at timestamptz;
  v_complete boolean := false;
begin
  select exists (
    select 1
    from public.cloud_signup_attribution a
    where a.user_id = new.user_id
      and a.capture_stage = 'auth_return'
      and a.attribution_integrity = 'client_handoff'
      and a.location_source = 'cloudflare_edge'
      and a.signup_platform in ('web', 'mobile_android')
      and a.signup_surface in ('account', 'subscription', 'tv_pairing')
      and a.signup_method in ('email_password', 'email_magic_link', 'google')
      and (
        a.country_code is not null
        or (
          a.region_name is not null
          and (
            a.fine_location_expires_at is null
            or a.fine_location_expires_at > v_now
          )
        )
      )
  )
  into v_complete;

  -- The delivery cron runs once per minute. Scheduling on the minute boundary
  -- immediately preceding +120 s gives every signup a 60-120 s observation
  -- window and prevents an additional cron interval from stretching it to 180 s.
  v_signed_up_at := least(coalesce(new.signed_up_at, v_now), v_now);
  new.next_attempt_at := case
    when v_complete then v_now
    else greatest(
      v_signed_up_at + interval '60 seconds',
      date_trunc('minute', v_signed_up_at + interval '120 seconds')
    )
  end;
  return new;
exception when others then
  -- Telegram observability must never reject an Auth signup. Even if the
  -- attribution table is temporarily unavailable, keep a bounded fallback.
  v_now := clock_timestamp();
  v_signed_up_at := least(coalesce(new.signed_up_at, v_now), v_now);
  new.next_attempt_at := greatest(
    v_signed_up_at + interval '60 seconds',
    date_trunc('minute', v_signed_up_at + interval '120 seconds')
  );
  return new;
end;
$function$;

revoke all on function public.norva_schedule_signup_telegram_enrichment()
  from public, anon, authenticated;

drop trigger if exists norva_schedule_signup_telegram_enrichment_before_insert
  on public.cloud_signup_telegram_outbox;
create trigger norva_schedule_signup_telegram_enrichment_before_insert
before insert on public.cloud_signup_telegram_outbox
for each row execute function public.norva_schedule_signup_telegram_enrichment();

-- Rows enqueued between the original notification migration and this migration
-- receive the same rule only if no delivery attempt has started. Retry and rate
-- limit schedules are intentionally never shortened.
update public.cloud_signup_telegram_outbox o
set next_attempt_at = case
      when exists (
        select 1
        from public.cloud_signup_attribution a
        where a.user_id = o.user_id
          and a.capture_stage = 'auth_return'
          and a.attribution_integrity = 'client_handoff'
          and a.location_source = 'cloudflare_edge'
          and a.signup_platform in ('web', 'mobile_android')
          and a.signup_surface in ('account', 'subscription', 'tv_pairing')
          and a.signup_method in ('email_password', 'email_magic_link', 'google')
          and (
            a.country_code is not null
            or (
              a.region_name is not null
              and (
                a.fine_location_expires_at is null
                or a.fine_location_expires_at > clock_timestamp()
              )
            )
          )
      ) then least(o.next_attempt_at, clock_timestamp())
      when greatest(
        least(o.signed_up_at, o.created_at) + interval '60 seconds',
        date_trunc(
          'minute',
          least(o.signed_up_at, o.created_at) + interval '120 seconds'
        )
      ) > clock_timestamp()
        then greatest(
          least(o.signed_up_at, o.created_at) + interval '60 seconds',
          date_trunc(
            'minute',
            least(o.signed_up_at, o.created_at) + interval '120 seconds'
          )
        )
      else least(o.next_attempt_at, clock_timestamp())
    end,
    updated_at = clock_timestamp()
where o.state = 'pending'
  and o.last_attempt_at is null;

-- Supabase can confirm an address between Auth insertion and Telegram delivery.
-- Keep the frozen boolean fresh only while the event is still pending; the claim
-- also refreshes it atomically immediately before rendering.
create or replace function public.norva_refresh_signup_telegram_confirmation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  begin
    update public.cloud_signup_telegram_outbox o
    set email_confirmed = new.email_confirmed_at is not null,
        updated_at = clock_timestamp()
    where o.user_id = new.id
      and o.state = 'pending';
  exception when others then
    -- Notification freshness must never make an Auth update fail.
    raise warning 'Norva signup Telegram confirmation refresh failed (SQLSTATE %)', sqlstate;
  end;
  return new;
end;
$function$;

revoke all on function public.norva_refresh_signup_telegram_confirmation()
  from public, anon, authenticated;

drop trigger if exists norva_refresh_signup_telegram_confirmation_after_update
  on auth.users;
create trigger norva_refresh_signup_telegram_confirmation_after_update
after update of email_confirmed_at on auth.users
for each row
when (old.email_confirmed_at is distinct from new.email_confirmed_at)
execute function public.norva_refresh_signup_telegram_confirmation();

-- Complete attribution advances the first delivery from its timeout to now and
-- asynchronously wakes the worker. A failed wake is harmless: the minutely cron
-- observes the durable due row. last_attempt_at prevents enrichment from
-- bypassing Telegram retry or rate-limit backoff after a first send attempt.
create or replace function public.norva_wake_signup_telegram_on_attribution()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_outbox_id bigint;
  v_cron_secret text;
begin
  if new.capture_stage <> 'auth_return'
     or new.attribution_integrity <> 'client_handoff'
     or new.location_source <> 'cloudflare_edge'
     or new.signup_platform not in ('web', 'mobile_android')
     or new.signup_surface not in ('account', 'subscription', 'tv_pairing')
     or new.signup_method not in ('email_password', 'email_magic_link', 'google')
     or (
       new.country_code is null
       and (
         new.region_name is null
         or (
           new.fine_location_expires_at is not null
           and new.fine_location_expires_at <= v_now
         )
       )
     ) then
    return new;
  end if;

  begin
    update public.cloud_signup_telegram_outbox o
    set next_attempt_at = v_now,
        updated_at = v_now
    where o.user_id = new.user_id
      and o.state = 'pending'
      and o.last_attempt_at is null
      and o.next_attempt_at > v_now
    returning o.id into v_outbox_id;
  exception when others then
    raise warning 'Norva signup Telegram attribution scheduling failed (SQLSTATE %)', sqlstate;
    return new;
  end;

  if v_outbox_id is null then
    return new;
  end if;

  begin
    select s.decrypted_secret
    into v_cron_secret
    from vault.decrypted_secrets s
    where s.name = 'norva_cron_shared_secret'
    limit 1;

    if nullif(v_cron_secret, '') is not null
       and exists (
         select 1
         from pg_catalog.pg_namespace n
         where n.nspname = 'net'
       ) then
      perform net.http_post(
        url := 'https://api.norva.tv/functions/v1/norva-signup-notify/cron/drain',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || v_cron_secret
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 5000
      );
    end if;
  exception when others then
    raise warning 'Norva signup Telegram attribution wake failed (SQLSTATE %)', sqlstate;
  end;

  return new;
end;
$function$;

revoke all on function public.norva_wake_signup_telegram_on_attribution()
  from public, anon, authenticated;

drop trigger if exists norva_wake_signup_telegram_on_attribution_after_write
  on public.cloud_signup_attribution;
create trigger norva_wake_signup_telegram_on_attribution_after_write
after insert or update on public.cloud_signup_attribution
for each row execute function public.norva_wake_signup_telegram_on_attribution();

-- PostgreSQL cannot CREATE OR REPLACE a function when its OUT row type changes.
-- Dropping and recreating this RPC is transactional: deployed callers see
-- either the old or the new function, never an absent intermediate state.
drop function if exists public.claim_signup_telegram_deliveries(
  integer, integer, integer
);

create function public.claim_signup_telegram_deliveries(
  p_batch integer default 10,
  p_lease_seconds integer default 90,
  p_max_attempts integer default 12
)
returns table (
  -- Keep these nine legacy columns in exactly this order for a DB-first rollout.
  id bigint,
  user_id uuid,
  lease_token uuid,
  user_email text,
  display_name text,
  auth_provider text,
  email_confirmed boolean,
  signed_up_at timestamptz,
  attempt_count integer,
  -- Premium fields are read from attribution at claim time, never the outbox.
  signup_platform text,
  signup_surface text,
  signup_method text,
  country_code text,
  region_name text,
  capture_stage text
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_batch integer := least(greatest(coalesce(p_batch, 10), 1), 50);
  v_lease_seconds integer := least(greatest(coalesce(p_lease_seconds, 90), 30), 600);
  v_max_attempts integer := least(greatest(coalesce(p_max_attempts, 12), 1), 50);
begin
  update public.cloud_signup_telegram_outbox o
  set state = 'dead_letter',
      lease_token = null,
      lease_expires_at = null,
      dead_lettered_at = v_now,
      last_error = coalesce(o.last_error, 'max_attempts_exhausted'),
      updated_at = v_now
  where o.state in ('pending', 'processing')
    and o.attempt_count >= v_max_attempts
    and (
      o.state = 'pending'
      or o.lease_expires_at <= v_now
    );

  return query
  with candidates as (
    select o.id
    from public.cloud_signup_telegram_outbox o
    where o.next_attempt_at <= v_now
      and o.attempt_count < v_max_attempts
      and (
        o.state = 'pending'
        or (o.state = 'processing' and o.lease_expires_at <= v_now)
      )
      and (
        least(o.signed_up_at, o.created_at) + interval '60 seconds' <= v_now
        or exists (
          select 1
          from public.cloud_signup_attribution a
          where a.user_id = o.user_id
            and a.capture_stage = 'auth_return'
            and a.attribution_integrity = 'client_handoff'
            and a.location_source = 'cloudflare_edge'
            and a.signup_platform in ('web', 'mobile_android')
            and a.signup_surface in ('account', 'subscription', 'tv_pairing')
            and a.signup_method in ('email_password', 'email_magic_link', 'google')
            and (
              a.country_code is not null
              or (
                a.region_name is not null
                and (
                  a.fine_location_expires_at is null
                  or a.fine_location_expires_at > v_now
                )
              )
            )
        )
      )
    order by o.signed_up_at, o.id
    limit v_batch
    for update of o skip locked
  ),
  claimed as (
    update public.cloud_signup_telegram_outbox o
    set state = 'processing',
        lease_token = gen_random_uuid(),
        lease_expires_at = v_now + make_interval(secs => v_lease_seconds),
        attempt_count = o.attempt_count + 1,
        email_confirmed = u.email_confirmed_at is not null,
        last_attempt_at = v_now,
        updated_at = v_now
    from candidates c, auth.users u
    where o.id = c.id
      and u.id = o.user_id
    returning o.*
  )
  select
    c.id,
    c.user_id,
    c.lease_token,
    c.user_email,
    c.display_name,
    c.auth_provider,
    c.email_confirmed,
    c.signed_up_at,
    c.attempt_count,
    nullif(a.signup_platform, 'unknown') as signup_platform,
    nullif(a.signup_surface, 'unknown') as signup_surface,
    nullif(a.signup_method, 'unknown') as signup_method,
    a.country_code,
    case
      when a.fine_location_expires_at is not null
       and a.fine_location_expires_at <= v_now then null
      else a.region_name
    end as region_name,
    case
      when a.capture_stage = 'auth_return'
       and a.attribution_integrity = 'client_handoff'
       and a.location_source = 'cloudflare_edge'
       and a.signup_platform in ('web', 'mobile_android')
       and a.signup_surface in ('account', 'subscription', 'tv_pairing')
       and a.signup_method in ('email_password', 'email_magic_link', 'google')
       and (
         a.country_code is not null
         or (
           a.region_name is not null
           and (
             a.fine_location_expires_at is null
             or a.fine_location_expires_at > v_now
           )
         )
       )
        then 'auth_return'::text
      else 'partial'::text
    end as capture_stage
  from claimed c
  left join public.cloud_signup_attribution a
    on a.user_id = c.user_id
  order by c.signed_up_at, c.id;
end;
$function$;

revoke all on function public.claim_signup_telegram_deliveries(
  integer, integer, integer
) from public, anon, authenticated;
grant execute on function public.claim_signup_telegram_deliveries(
  integer, integer, integer
) to service_role;

comment on function public.claim_signup_telegram_deliveries(integer, integer, integer) is
  'Claims one signup event per user with SKIP LOCKED/CAS delivery state. Joins privacy-bounded attribution at claim time; complete auth-return wakes immediately, otherwise first render is partial after at most 120 seconds.';

notify pgrst, 'reload schema';
