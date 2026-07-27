-- Durable, privacy-limited Telegram notifications for new Auth users.
--
-- The auth trigger only freezes an allow-listed snapshot in PostgreSQL. It never
-- talks to Telegram synchronously: pg_net merely wakes the Edge worker, while a
-- minutely cron retries anything left behind. A Telegram outage therefore cannot
-- slow down or reject a signup.

create table if not exists public.cloud_signup_telegram_outbox (
  id                    bigint generated always as identity primary key,
  user_id               uuid not null references auth.users(id) on delete cascade,
  state                 text not null default 'pending'
                        check (state in ('pending', 'processing', 'sent', 'dead_letter')),
  user_email             text,
  display_name           text,
  auth_provider          text not null,
  email_confirmed        boolean not null,
  signed_up_at           timestamptz not null,
  attempt_count          integer not null default 0 check (attempt_count >= 0),
  next_attempt_at        timestamptz not null default now(),
  last_attempt_at        timestamptz,
  lease_token            uuid,
  lease_expires_at       timestamptz,
  telegram_message_id    bigint,
  last_http_status       integer,
  last_error             text,
  sent_at                timestamptz,
  dead_lettered_at       timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint cloud_signup_telegram_user_unique unique (user_id),
  constraint cloud_signup_telegram_email_check check (
    user_email is null
    or (
      length(user_email) <= 320
      and user_email ~ '^[^@[:space:]<>]+@[^@[:space:]<>]+$'
    )
  ),
  constraint cloud_signup_telegram_name_check
    check (display_name is null or length(display_name) between 1 and 160),
  constraint cloud_signup_telegram_provider_check
    check (auth_provider ~ '^[a-z0-9_-]{1,50}$'),
  constraint cloud_signup_telegram_error_check
    check (last_error is null or length(last_error) <= 200),
  constraint cloud_signup_telegram_lease_check check (
    (state = 'processing' and lease_token is not null and lease_expires_at is not null)
    or (state <> 'processing' and lease_token is null and lease_expires_at is null)
  ),
  constraint cloud_signup_telegram_terminal_check check (
    (
      state = 'sent'
      and sent_at is not null
      and telegram_message_id is not null
      and dead_lettered_at is null
      and user_email is null
      and display_name is null
    )
    or (
      state = 'dead_letter'
      and sent_at is null
      and telegram_message_id is null
      and dead_lettered_at is not null
    )
    or (
      state in ('pending', 'processing')
      and sent_at is null
      and telegram_message_id is null
      and dead_lettered_at is null
    )
  )
);

create index if not exists cloud_signup_telegram_due_idx
  on public.cloud_signup_telegram_outbox (next_attempt_at, signed_up_at, id)
  where state in ('pending', 'processing');

create index if not exists cloud_signup_telegram_dead_letter_idx
  on public.cloud_signup_telegram_outbox (dead_lettered_at desc)
  where state = 'dead_letter';

alter table public.cloud_signup_telegram_outbox enable row level security;
revoke all on table public.cloud_signup_telegram_outbox from public, anon, authenticated;
grant select, insert, update, delete on table public.cloud_signup_telegram_outbox to service_role;
revoke all on sequence public.cloud_signup_telegram_outbox_id_seq from public, anon, authenticated;
grant usage, select on sequence public.cloud_signup_telegram_outbox_id_seq to service_role;

comment on table public.cloud_signup_telegram_outbox is
  'Service-only signup notification outbox. It freezes only email, display name, auth provider, confirmation state and signup time; successful delivery scrubs email and name.';

create or replace function public.norva_enqueue_signup_telegram()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_email text;
  v_display_name text;
  v_provider text;
  v_outbox_id bigint;
  v_cron_secret text;
begin
  v_email := nullif(lower(btrim(coalesce(new.email, ''))), '');
  if v_email is not null and (
    length(v_email) > 320
    or v_email !~ '^[^@[:space:]<>]+@[^@[:space:]<>]+$'
  ) then
    v_email := null;
  end if;

  v_display_name := nullif(
    btrim(coalesce(
      new.raw_user_meta_data ->> 'display_name',
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name',
      nullif(
        concat_ws(
          ' ',
          nullif(btrim(new.raw_user_meta_data ->> 'first_name'), ''),
          nullif(btrim(new.raw_user_meta_data ->> 'last_name'), '')
        ),
        ''
      ),
      ''
    )),
    ''
  );
  if v_display_name is not null then
    v_display_name := nullif(
      btrim(left(regexp_replace(v_display_name, '[[:cntrl:]]+', ' ', 'g'), 160)),
      ''
    );
  end if;

  v_provider := lower(btrim(coalesce(new.raw_app_meta_data ->> 'provider', 'email')));
  v_provider := left(regexp_replace(v_provider, '[^a-z0-9_-]+', '_', 'g'), 50);
  v_provider := trim(both '_' from v_provider);
  if v_provider = '' then v_provider := 'unknown'; end if;

  -- This is the only part that is required for durability. Its own exception
  -- guard ensures an outbox/schema problem is visible but can never reject Auth.
  begin
    insert into public.cloud_signup_telegram_outbox (
      user_id,
      state,
      user_email,
      display_name,
      auth_provider,
      email_confirmed,
      signed_up_at,
      next_attempt_at
    ) values (
      new.id,
      'pending',
      v_email,
      v_display_name,
      v_provider,
      new.email_confirmed_at is not null,
      coalesce(new.created_at, clock_timestamp()),
      clock_timestamp()
    )
    on conflict (user_id) do nothing
    returning id into v_outbox_id;
  exception when others then
    raise warning 'Norva signup Telegram enqueue failed (SQLSTATE %)', sqlstate;
    return new;
  end;

  -- Best-effort immediate wake. pg_net only enqueues the HTTP request; it does
  -- not wait on Telegram. Failure here leaves the durable row for the cron.
  if v_outbox_id is not null then
    begin
      select s.decrypted_secret
      into v_cron_secret
      from vault.decrypted_secrets s
      where s.name = 'norva_cron_shared_secret'
      limit 1;

      if nullif(v_cron_secret, '') is not null
         and exists (select 1 from pg_namespace where nspname = 'net') then
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
      raise warning 'Norva signup Telegram immediate wake failed (SQLSTATE %)', sqlstate;
    end;
  end if;

  return new;
end
$function$;

revoke all on function public.norva_enqueue_signup_telegram()
  from public, anon, authenticated;

drop trigger if exists norva_signup_telegram_trg on auth.users;
create trigger norva_signup_telegram_trg
  after insert on auth.users
  for each row execute function public.norva_enqueue_signup_telegram();

create or replace function public.claim_signup_telegram_deliveries(
  p_batch integer default 10,
  p_lease_seconds integer default 90,
  p_max_attempts integer default 12
)
returns table (
  id bigint,
  user_id uuid,
  lease_token uuid,
  user_email text,
  display_name text,
  auth_provider text,
  email_confirmed boolean,
  signed_up_at timestamptz,
  attempt_count integer
)
language plpgsql
security definer
set search_path = pg_catalog, public
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
    order by o.signed_up_at, o.id
    limit v_batch
    for update skip locked
  ),
  claimed as (
    update public.cloud_signup_telegram_outbox o
    set state = 'processing',
        lease_token = gen_random_uuid(),
        lease_expires_at = v_now + make_interval(secs => v_lease_seconds),
        attempt_count = o.attempt_count + 1,
        last_attempt_at = v_now,
        updated_at = v_now
    from candidates c
    where o.id = c.id
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
    c.attempt_count
  from claimed c
  order by c.signed_up_at, c.id;
end
$function$;

create or replace function public.complete_signup_telegram_delivery(
  p_id bigint,
  p_lease_token uuid,
  p_message_id bigint,
  p_http_status integer
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_updated integer;
begin
  if p_message_id is null
     or p_http_status is null
     or p_http_status not between 200 and 299 then
    return false;
  end if;

  update public.cloud_signup_telegram_outbox o
  set state = 'sent',
      user_email = null,
      display_name = null,
      lease_token = null,
      lease_expires_at = null,
      telegram_message_id = p_message_id,
      last_http_status = p_http_status,
      last_error = null,
      sent_at = clock_timestamp(),
      dead_lettered_at = null,
      updated_at = clock_timestamp()
  where o.id = p_id
    and o.state = 'processing'
    and o.lease_token = p_lease_token;
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end
$function$;

create or replace function public.fail_signup_telegram_delivery(
  p_id bigint,
  p_lease_token uuid,
  p_http_status integer,
  p_error text,
  p_retryable boolean,
  p_retry_after_seconds integer default null,
  p_max_attempts integer default 12
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_attempt integer;
  v_terminal boolean;
  v_delay_seconds integer;
  v_updated integer;
  v_error text := left(
    regexp_replace(lower(coalesce(nullif(btrim(p_error), ''), 'telegram_delivery_failed')), '[^a-z0-9:_-]+', '_', 'g'),
    200
  );
begin
  select o.attempt_count
  into v_attempt
  from public.cloud_signup_telegram_outbox o
  where o.id = p_id
    and o.state = 'processing'
    and o.lease_token = p_lease_token;

  if v_attempt is null then return 'lease_lost'; end if;

  v_terminal := not coalesce(p_retryable, false)
    or v_attempt >= least(greatest(coalesce(p_max_attempts, 12), 1), 50);
  v_delay_seconds := greatest(
    coalesce(least(greatest(p_retry_after_seconds, 0), 21600), 0),
    least(
      21600,
      ceil(15 * power(2::numeric, greatest(v_attempt - 1, 0)))::integer
    )
  );

  update public.cloud_signup_telegram_outbox o
  set state = case when v_terminal then 'dead_letter' else 'pending' end,
      lease_token = null,
      lease_expires_at = null,
      next_attempt_at = case
        when v_terminal then o.next_attempt_at
        else clock_timestamp() + make_interval(secs => v_delay_seconds)
      end,
      last_http_status = p_http_status,
      last_error = v_error,
      dead_lettered_at = case when v_terminal then clock_timestamp() else null end,
      updated_at = clock_timestamp()
  where o.id = p_id
    and o.state = 'processing'
    and o.lease_token = p_lease_token;
  get diagnostics v_updated = row_count;

  if v_updated <> 1 then return 'lease_lost'; end if;
  return case when v_terminal then 'dead_letter' else 'retry_scheduled' end;
end
$function$;

create or replace function public.defer_signup_telegram_delivery(
  p_id bigint,
  p_lease_token uuid,
  p_retry_after_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_updated integer;
begin
  update public.cloud_signup_telegram_outbox o
  set state = 'pending',
      lease_token = null,
      lease_expires_at = null,
      attempt_count = greatest(o.attempt_count - 1, 0),
      next_attempt_at = clock_timestamp()
        + make_interval(secs => least(greatest(coalesce(p_retry_after_seconds, 60), 1), 21600)),
      last_error = 'telegram_rate_limit_deferred',
      updated_at = clock_timestamp()
  where o.id = p_id
    and o.state = 'processing'
    and o.lease_token = p_lease_token;
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end
$function$;

create or replace function public.requeue_signup_telegram_delivery(p_id bigint)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_updated integer;
begin
  update public.cloud_signup_telegram_outbox o
  set state = 'pending',
      attempt_count = 0,
      next_attempt_at = clock_timestamp(),
      last_attempt_at = null,
      lease_token = null,
      lease_expires_at = null,
      telegram_message_id = null,
      last_http_status = null,
      last_error = null,
      sent_at = null,
      dead_lettered_at = null,
      updated_at = clock_timestamp()
  where o.id = p_id
    and o.state = 'dead_letter';
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end
$function$;

create or replace function public.signup_telegram_delivery_health()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select jsonb_build_object(
    'pending', count(*) filter (where state = 'pending'),
    'processing', count(*) filter (where state = 'processing'),
    'dead_letter', count(*) filter (where state = 'dead_letter'),
    'sent_24h', count(*) filter (where state = 'sent' and sent_at >= now() - interval '24 hours'),
    'oldest_due_at', min(next_attempt_at) filter (where state = 'pending'),
    'last_sent_at', max(sent_at)
  )
  from public.cloud_signup_telegram_outbox
$function$;

create or replace function public.prune_signup_telegram_outbox()
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_deleted integer;
begin
  delete from public.cloud_signup_telegram_outbox o
  where (o.state = 'sent' and o.sent_at < now() - interval '30 days')
     or (o.state = 'dead_letter' and o.dead_lettered_at < now() - interval '30 days');
  get diagnostics v_deleted = row_count;
  return v_deleted;
end
$function$;

revoke all on function public.claim_signup_telegram_deliveries(integer,integer,integer),
  public.complete_signup_telegram_delivery(bigint,uuid,bigint,integer),
  public.fail_signup_telegram_delivery(bigint,uuid,integer,text,boolean,integer,integer),
  public.defer_signup_telegram_delivery(bigint,uuid,integer),
  public.requeue_signup_telegram_delivery(bigint),
  public.signup_telegram_delivery_health(),
  public.prune_signup_telegram_outbox()
  from public, anon, authenticated;

grant execute on function public.claim_signup_telegram_deliveries(integer,integer,integer),
  public.complete_signup_telegram_delivery(bigint,uuid,bigint,integer),
  public.fail_signup_telegram_delivery(bigint,uuid,integer,text,boolean,integer,integer),
  public.defer_signup_telegram_delivery(bigint,uuid,integer),
  public.requeue_signup_telegram_delivery(bigint),
  public.signup_telegram_delivery_health(),
  public.prune_signup_telegram_outbox()
  to service_role;

do $cron_setup$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron')
     and exists (select 1 from pg_namespace where nspname = 'net') then
    perform cron.schedule(
      'norva-signup-telegram-delivery',
      '* * * * *',
      $cron$
        select net.http_post(
          url := 'https://api.norva.tv/functions/v1/norva-signup-notify/cron/drain',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || (
              select decrypted_secret
              from vault.decrypted_secrets
              where name = 'norva_cron_shared_secret'
            )
          ),
          body := '{}'::jsonb,
          timeout_milliseconds := 30000
        )
        where exists (
          select 1
          from public.cloud_signup_telegram_outbox o
          where o.next_attempt_at <= now()
            and (
              o.state = 'pending'
              or (o.state = 'processing' and o.lease_expires_at <= now())
            )
        );
      $cron$
    );
    perform cron.schedule(
      'norva-signup-telegram-prune',
      '35 4 * * *',
      'select public.prune_signup_telegram_outbox();'
    );
  end if;
exception when undefined_table or invalid_schema_name or insufficient_privilege then
  raise notice 'signup Telegram crons unavailable; register the worker externally';
end
$cron_setup$;

notify pgrst, 'reload schema';
