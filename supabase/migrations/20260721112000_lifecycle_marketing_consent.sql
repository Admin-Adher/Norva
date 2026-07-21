-- Explicit marketing-email consent and safe lifecycle recovery.
--
-- Marketing is opt-in only. New accounts are deliberately created unsubscribed,
-- and the legacy Resend audience trigger is replaced so a signup/backfill can
-- never silently re-subscribe a contact. Transactional billing emails are not
-- governed by this preference.

create table if not exists public.cloud_marketing_email_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  marketing_email_opt_in boolean not null default false,
  opted_in_at timestamptz,
  opted_in_source text,
  unsubscribed_at timestamptz,
  unsubscribed_source text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cloud_marketing_email_preferences_explicit_opt_in check (
    not marketing_email_opt_in
    or (
      opted_in_at is not null
      and nullif(btrim(opted_in_source), '') is not null
      and unsubscribed_at is null
    )
  )
);

comment on table public.cloud_marketing_email_preferences is
  'Explicit user choice for lifecycle/marketing email. Missing rows and false both mean no consent.';

alter table public.cloud_marketing_email_preferences enable row level security;
revoke all on table public.cloud_marketing_email_preferences from public, anon, authenticated;
grant all on table public.cloud_marketing_email_preferences to service_role;

-- Existing users do NOT inherit consent from the legacy Resend audience.
insert into public.cloud_marketing_email_preferences (user_id)
select u.id from auth.users u
on conflict (user_id) do nothing;

create or replace function public.norva_marketing_email_allowed(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select exists (
    select 1
    from public.cloud_marketing_email_preferences p
    where p.user_id = p_user_id
      and p.marketing_email_opt_in is true
      and p.opted_in_at is not null
      and nullif(btrim(p.opted_in_source), '') is not null
      and p.unsubscribed_at is null
      and not exists (
        select 1 from public.admin_internal_accounts a where a.user_id = p_user_id
      )
  );
$function$;

revoke all on function public.norva_marketing_email_allowed(uuid) from public, anon, authenticated;
grant execute on function public.norva_marketing_email_allowed(uuid) to service_role;

-- Resend audience projection outbox. The database remains authoritative: auth and
-- preference transactions only enqueue the desired state, and a service-role Edge
-- worker performs the external HTTP request later. One row per normalized address
-- also lets us unsubscribe an old address after an auth email change or deletion.
create table if not exists public.cloud_resend_audience_outbox (
  email text primary key,
  user_id uuid,
  desired_unsubscribed boolean not null,
  first_name text,
  revision bigint not null default 1,
  attempt_count integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_attempt_at timestamptz,
  last_http_status integer,
  last_result jsonb,
  last_error text,
  synced_revision bigint,
  synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cloud_resend_audience_outbox_normalized_email check (
    email = lower(btrim(email))
    and length(email) between 3 and 320
    and position('@' in email) > 1
  ),
  constraint cloud_resend_audience_outbox_revision_positive check (revision > 0),
  constraint cloud_resend_audience_outbox_attempts_nonnegative check (attempt_count >= 0),
  constraint cloud_resend_audience_outbox_synced_revision_valid check (
    synced_revision is null or synced_revision <= revision
  )
);

comment on table public.cloud_resend_audience_outbox is
  'Durable desired-state outbox for the Resend marketing audience. Service role only.';

create index if not exists cloud_resend_audience_outbox_ready_idx
  on public.cloud_resend_audience_outbox (next_attempt_at, updated_at)
  where synced_revision is distinct from revision;

alter table public.cloud_resend_audience_outbox enable row level security;
revoke all on table public.cloud_resend_audience_outbox from public, anon, authenticated;
grant all on table public.cloud_resend_audience_outbox to service_role;

-- Upsert desired state and advance a monotonic revision. A worker may still hold
-- the old lease; it cannot acknowledge the newer revision, and the new state is
-- claimed after that lease finishes/expires. This serializes external writes per
-- email and prevents an older request from being recorded as the current state.
create or replace function public.norva_enqueue_resend_audience_contact(
  p_email text,
  p_unsubscribed boolean,
  p_first_name text default null,
  p_user_id uuid default null
) returns bigint
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_revision bigint;
begin
  if length(v_email) not between 3 and 320 or position('@' in v_email) <= 1 then
    return null;
  end if;

  insert into public.cloud_resend_audience_outbox (
    email, user_id, desired_unsubscribed, first_name, revision,
    attempt_count, next_attempt_at, created_at, updated_at
  ) values (
    v_email, p_user_id, coalesce(p_unsubscribed, true),
    nullif(left(btrim(coalesce(p_first_name, '')), 160), ''), 1,
    0, clock_timestamp(), clock_timestamp(), clock_timestamp()
  )
  on conflict (email) do update set
    user_id = excluded.user_id,
    desired_unsubscribed = excluded.desired_unsubscribed,
    first_name = excluded.first_name,
    revision = public.cloud_resend_audience_outbox.revision + 1,
    attempt_count = 0,
    next_attempt_at = clock_timestamp(),
    last_http_status = null,
    last_result = null,
    last_error = null,
    updated_at = clock_timestamp()
  returning revision into v_revision;

  return v_revision;
end;
$function$;

revoke all on function public.norva_enqueue_resend_audience_contact(text, boolean, text, uuid)
  from public, anon, authenticated;
grant execute on function public.norva_enqueue_resend_audience_contact(text, boolean, text, uuid)
  to service_role;

-- Preference writes never call the network. Missing/invalid consent and internal
-- accounts are always projected as unsubscribed. Deleting a preference also fails
-- closed and enqueues an unsubscribe while the auth row still exists.
create or replace function public.norva_enqueue_marketing_preference_to_resend()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_user_id uuid := case when tg_op = 'DELETE' then old.user_id else new.user_id end;
  v_email text;
  v_meta jsonb;
  v_effective_opt_in boolean := false;
begin
  select u.email, u.raw_user_meta_data into v_email, v_meta
  from auth.users u where u.id = v_user_id;

  if tg_op <> 'DELETE' then
    v_effective_opt_in :=
      new.marketing_email_opt_in is true
      and new.opted_in_at is not null
      and nullif(btrim(new.opted_in_source), '') is not null
      and new.unsubscribed_at is null
      and not exists (
        select 1 from public.admin_internal_accounts a where a.user_id = v_user_id
      );
  end if;

  perform public.norva_enqueue_resend_audience_contact(
    v_email,
    not v_effective_opt_in,
    coalesce(v_meta->>'full_name', v_meta->>'name'),
    v_user_id
  );
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$function$;

revoke all on function public.norva_enqueue_marketing_preference_to_resend()
  from public, anon, authenticated;

drop trigger if exists norva_sync_marketing_preference_to_resend_trg
  on public.cloud_marketing_email_preferences;
drop trigger if exists norva_enqueue_marketing_preference_to_resend_trg
  on public.cloud_marketing_email_preferences;
create trigger norva_enqueue_marketing_preference_to_resend_trg
  after insert or update of marketing_email_opt_in, opted_in_at, opted_in_source,
    unsubscribed_at, unsubscribed_source
  on public.cloud_marketing_email_preferences
  for each row execute function public.norva_enqueue_marketing_preference_to_resend();

drop trigger if exists norva_enqueue_deleted_marketing_preference_to_resend_trg
  on public.cloud_marketing_email_preferences;
create trigger norva_enqueue_deleted_marketing_preference_to_resend_trg
  after delete on public.cloud_marketing_email_preferences
  for each row execute function public.norva_enqueue_marketing_preference_to_resend();

-- Replace the legacy signup network trigger. A signup creates an explicit FALSE
-- preference; its trigger above enqueues the new address as unsubscribed.
create or replace function public.norva_sync_signup_to_resend()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  -- Account creation must not fail because an operational projection is
  -- temporarily unavailable. Missing preference means no consent, and the
  -- reconciliation backfill will recreate/enqueue it on the next run.
  begin
    insert into public.cloud_marketing_email_preferences (user_id)
    values (new.id)
    on conflict (user_id) do nothing;
  exception when others then
    raise warning 'Norva marketing preference enqueue failed for new user %: %', new.id, sqlerrm;
  end;
  return new;
end;
$function$;

revoke all on function public.norva_sync_signup_to_resend() from public, anon, authenticated;

drop trigger if exists norva_sync_signup_to_resend_trg on auth.users;
create trigger norva_sync_signup_to_resend_trg
  after insert on auth.users
  for each row execute function public.norva_sync_signup_to_resend();

-- Auth address lifecycle is projected independently from the preference row. An
-- old email is always unsubscribed; a new email inherits only the user's current,
-- explicit, non-internal preference. Deletes retain the old address in the outbox
-- long enough for Resend to be updated even after auth/user rows are gone.
create or replace function public.norva_enqueue_auth_email_change_to_resend()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_effective_opt_in boolean := false;
begin
  if tg_op = 'DELETE' then
    perform public.norva_enqueue_resend_audience_contact(
      old.email, true,
      coalesce(old.raw_user_meta_data->>'full_name', old.raw_user_meta_data->>'name'),
      old.id
    );
    return old;
  end if;

  if old.email is distinct from new.email and old.email is not null then
    perform public.norva_enqueue_resend_audience_contact(
      old.email, true,
      coalesce(old.raw_user_meta_data->>'full_name', old.raw_user_meta_data->>'name'),
      old.id
    );
  end if;

  select public.norva_marketing_email_allowed(new.id) into v_effective_opt_in;
  perform public.norva_enqueue_resend_audience_contact(
    new.email, not coalesce(v_effective_opt_in, false),
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'),
    new.id
  );
  return new;
end;
$function$;

revoke all on function public.norva_enqueue_auth_email_change_to_resend()
  from public, anon, authenticated;

drop trigger if exists norva_resend_auth_contact_updated_trg on auth.users;
create trigger norva_resend_auth_contact_updated_trg
  after update of email, raw_user_meta_data on auth.users
  for each row execute function public.norva_enqueue_auth_email_change_to_resend();

drop trigger if exists norva_resend_auth_contact_deleted_trg on auth.users;
create trigger norva_resend_auth_contact_deleted_trg
  after delete on auth.users
  for each row execute function public.norva_enqueue_auth_email_change_to_resend();

-- Concurrent cron workers claim distinct rows. The lease token plus desired-state
-- revision form the CAS used by complete/fail below. Retries use bounded exponential
-- backoff and retain the last HTTP status/result/error for operations visibility.
create or replace function public.claim_resend_audience_outbox(
  p_limit integer default 100,
  p_lease_seconds integer default 120
) returns table(
  email text,
  user_id uuid,
  desired_unsubscribed boolean,
  first_name text,
  revision bigint,
  attempt_count integer,
  lease_token uuid
)
language sql
volatile
security definer
set search_path = pg_catalog, public
as $function$
  with candidates as materialized (
    select o.email
    from public.cloud_resend_audience_outbox o
    where o.synced_revision is distinct from o.revision
      and o.next_attempt_at <= clock_timestamp()
      and (o.lease_expires_at is null or o.lease_expires_at <= clock_timestamp())
    order by o.next_attempt_at, o.updated_at, o.email
    for update skip locked
    limit greatest(1, least(250, coalesce(p_limit, 100)))
  ), claimed as (
    update public.cloud_resend_audience_outbox o
    set lease_token = gen_random_uuid(),
        lease_expires_at = clock_timestamp()
          + make_interval(secs => greatest(30, least(600, coalesce(p_lease_seconds, 120)))),
        last_attempt_at = clock_timestamp(),
        attempt_count = o.attempt_count + 1,
        updated_at = clock_timestamp()
    from candidates c
    where o.email = c.email
    returning o.email, o.user_id, o.desired_unsubscribed, o.first_name,
              o.revision, o.attempt_count, o.lease_token
  )
  select c.email, c.user_id, c.desired_unsubscribed, c.first_name,
         c.revision, c.attempt_count, c.lease_token
  from claimed c;
$function$;

revoke all on function public.claim_resend_audience_outbox(integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_resend_audience_outbox(integer, integer)
  to service_role;

create or replace function public.complete_resend_audience_outbox(
  p_email text,
  p_revision bigint,
  p_lease_token uuid,
  p_http_status integer,
  p_result jsonb default null
) returns boolean
language sql
volatile
security definer
set search_path = pg_catalog, public
as $function$
  with completed as (
    update public.cloud_resend_audience_outbox o
    set synced_revision = p_revision,
        synced_at = clock_timestamp(),
        lease_token = null,
        lease_expires_at = null,
        last_http_status = p_http_status,
        last_result = p_result,
        last_error = null,
        updated_at = clock_timestamp()
    where o.email = lower(btrim(p_email))
      and o.revision = p_revision
      and o.lease_token = p_lease_token
      and p_http_status between 200 and 299
    returning 1
  )
  select exists(select 1 from completed);
$function$;

revoke all on function public.complete_resend_audience_outbox(text, bigint, uuid, integer, jsonb)
  from public, anon, authenticated;
grant execute on function public.complete_resend_audience_outbox(text, bigint, uuid, integer, jsonb)
  to service_role;

create or replace function public.fail_resend_audience_outbox(
  p_email text,
  p_revision bigint,
  p_lease_token uuid,
  p_http_status integer default null,
  p_result jsonb default null,
  p_error text default null
) returns boolean
language sql
volatile
security definer
set search_path = pg_catalog, public
as $function$
  with failed as (
    update public.cloud_resend_audience_outbox o
    set lease_token = null,
        lease_expires_at = null,
        next_attempt_at = clock_timestamp() + make_interval(secs => least(
          21600,
          (30 * power(2::numeric, least(9, greatest(0, o.attempt_count - 1))))::integer
            + mod(abs(hashtext(o.email || ':' || o.revision::text)), 31)
        )),
        last_http_status = p_http_status,
        last_result = p_result,
        last_error = nullif(left(coalesce(p_error, 'unknown Resend error'), 4000), ''),
        updated_at = clock_timestamp()
    where o.email = lower(btrim(p_email))
      and o.revision = p_revision
      and o.lease_token = p_lease_token
    returning 1
  )
  select exists(select 1 from failed);
$function$;

revoke all on function public.fail_resend_audience_outbox(text, bigint, uuid, integer, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.fail_resend_audience_outbox(text, bigint, uuid, integer, jsonb, text)
  to service_role;

-- Backfill is reconciliation, never consent. It makes missing preference rows
-- explicit FALSE and queues every existing address. No network request runs inside
-- the migration transaction, and every non-opted-in user is desired-unsubscribed.
create or replace function public.norva_backfill_resend_audience()
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  n integer := 0;
  u record;
  v_effective_opt_in boolean;
  v_revision bigint;
begin
  insert into public.cloud_marketing_email_preferences (user_id)
  select au.id from auth.users au
  on conflict (user_id) do nothing;

  for u in
    select au.id, au.email, au.raw_user_meta_data
    from auth.users au
    where au.email is not null
  loop
    select public.norva_marketing_email_allowed(u.id) into v_effective_opt_in;
    select public.norva_enqueue_resend_audience_contact(
      u.email,
      not coalesce(v_effective_opt_in, false),
      coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name'),
      u.id
    ) into v_revision;
    if v_revision is not null then n := n + 1; end if;
  end loop;
  return n;
end;
$function$;

revoke all on function public.norva_backfill_resend_audience() from public, anon, authenticated;
grant execute on function public.norva_backfill_resend_audience() to service_role;

-- Re-declare the atomic abandoned-checkout claim with consent as an eligibility
-- condition. The Edge function still rechecks immediately before each send.
create or replace function public.claim_revolut_abandoned_orders(
  p_limit integer default 100
) returns table(
  order_id text,
  user_id uuid,
  plan text,
  period text,
  amount integer,
  currency text,
  claimed_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_claimed_at timestamptz := clock_timestamp();
begin
  if not pg_try_advisory_xact_lock(hashtext('norva:revolut:abandoned-claim')) then
    return;
  end if;

  return query
  with latest as materialized (
    select distinct on (o.user_id)
      o.order_id, o.user_id, o.plan, o.period, o.amount, o.currency, o.created_at,
      o.reminder_claimed_at, o.reminder_sent_at, o.state,
      o.finalized_at, o.superseded_at
    from public.cloud_revolut_orders o
    where o.user_id is not null
      and o.kind in ('trial_setup', 'resubscribe')
    order by o.user_id, o.created_at desc, o.order_id desc
  ), candidates as materialized (
    select l.order_id
    from latest l
    left join public.cloud_entitlement_projection p on p.user_id = l.user_id
    where l.created_at >= v_claimed_at - interval '48 hours'
      and l.created_at <= v_claimed_at - interval '1 hour'
      and upper(coalesce(l.state, 'PENDING')) in ('PENDING', 'PROCESSING')
      and l.finalized_at is null
      and l.superseded_at is null
      and l.reminder_sent_at is null
      and (
        l.reminder_claimed_at is null
        or l.reminder_claimed_at <= v_claimed_at - interval '30 minutes'
      )
      and public.norva_marketing_email_allowed(l.user_id)
      and not exists (
        select 1 from public.admin_internal_accounts a where a.user_id = l.user_id
      )
      and not (
        coalesce(p.status, '') in ('trialing', 'active', 'cancelled_at_period_end')
        and (
          p.status <> 'trialing'
          or coalesce(p.trial_ends_at, '-infinity'::timestamptz) > v_claimed_at
        )
        and (
          p.status not in ('active', 'cancelled_at_period_end')
          or p.current_period_end is null
          or p.current_period_end > v_claimed_at
        )
      )
    order by l.created_at desc
    limit greatest(1, least(100, coalesce(p_limit, 100)))
  ), claimed as (
    update public.cloud_revolut_orders o
    set reminder_claimed_at = v_claimed_at, updated_at = v_claimed_at
    from candidates c
    where o.order_id = c.order_id
      and o.reminder_sent_at is null
      and (
        o.reminder_claimed_at is null
        or o.reminder_claimed_at <= v_claimed_at - interval '30 minutes'
      )
    returning o.order_id, o.user_id, o.plan, o.period, o.amount, o.currency
  )
  select c.order_id, c.user_id, c.plan, c.period, c.amount, c.currency, v_claimed_at
  from claimed c;
end
$function$;

revoke all on function public.claim_revolut_abandoned_orders(integer)
  from public, anon, authenticated;
grant execute on function public.claim_revolut_abandoned_orders(integer)
  to service_role;

-- Queue the current authoritative state immediately. The migration performs no
-- external request; the Edge cron drains these rows only when its Resend config exists.
select public.norva_backfill_resend_audience();
