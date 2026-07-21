-- Durable, privacy-minimized account-deletion confirmations.
--
-- The exact email request is prepared before auth.users is deleted, but it is
-- not deliverable yet. An AFTER DELETE trigger activates it in the same database
-- transaction as the permanent account deletion. A crash can therefore produce
-- either a harmless expiring `prepared` row or a durable `ready` confirmation,
-- never a false "your account was deleted" email.

create table if not exists public.cloud_account_deletion_email_outbox (
  account_key         text primary key,
  delivery_key        text not null unique,
  state               text not null default 'prepared'
                      check (state in ('prepared', 'ready', 'processing', 'sent', 'dead_letter')),
  recipient_email     text,
  request_from        text not null,
  request_reply_to    text not null,
  request_subject     text not null,
  request_html        text,
  request_text        text,
  request_tags        jsonb not null,
  prepared_at         timestamptz not null default now(),
  prepare_expires_at  timestamptz not null,
  deletion_confirmed_at timestamptz,
  attempt_count       integer not null default 0 check (attempt_count >= 0),
  next_attempt_at     timestamptz not null default now(),
  lease_token         uuid,
  lease_expires_at    timestamptz,
  resend_email_id     text,
  resend_response     jsonb,
  last_http_status    integer,
  last_error          text,
  sent_at             timestamptz,
  exhausted_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint cloud_account_delete_email_account_key_check
    check (account_key ~ '^[0-9a-f]{64}$'),
  constraint cloud_account_delete_email_delivery_key_check
    check (delivery_key ~ '^norva-account-deleted-[0-9a-f]{64}$'),
  constraint cloud_account_delete_email_tags_check check (
    jsonb_typeof(request_tags) = 'array'
    and jsonb_array_length(request_tags) between 1 and 5
  ),
  constraint cloud_account_delete_email_payload_check check (
    (state = 'sent' and recipient_email is null and request_html is null and request_text is null)
    or
    (state <> 'sent' and recipient_email is not null and request_html is not null and request_text is not null)
  ),
  constraint cloud_account_delete_email_lease_check check (
    (state = 'processing' and lease_token is not null and lease_expires_at is not null)
    or
    (state <> 'processing' and lease_token is null and lease_expires_at is null)
  ),
  constraint cloud_account_delete_email_terminal_check check (
    (state = 'sent' and sent_at is not null and exhausted_at is null)
    or (state = 'dead_letter' and sent_at is null and exhausted_at is not null)
    or (state not in ('sent', 'dead_letter') and sent_at is null and exhausted_at is null)
  )
);

create index if not exists cloud_account_deletion_email_due_idx
  on public.cloud_account_deletion_email_outbox (next_attempt_at, created_at)
  where state in ('ready', 'processing');
create index if not exists cloud_account_deletion_email_retention_idx
  on public.cloud_account_deletion_email_outbox (
    coalesce(sent_at, exhausted_at, prepare_expires_at)
  );

alter table public.cloud_account_deletion_email_outbox enable row level security;
revoke all on table public.cloud_account_deletion_email_outbox from public, anon, authenticated;
grant all on table public.cloud_account_deletion_email_outbox to service_role;

comment on table public.cloud_account_deletion_email_outbox is
  'Service-only deletion-confirmation outbox. No auth FK/raw user UUID; recipient and bodies are erased immediately after successful delivery.';

-- Prepare the immutable request while auth.users still exists. The only account
-- correlation retained is a one-way SHA-256 digest of the random UUID.
create or replace function public.prepare_account_deletion_email(
  p_user_id uuid,
  p_recipient_email text,
  p_request_from text,
  p_request_reply_to text,
  p_request_subject text,
  p_request_html text,
  p_request_text text,
  p_request_tags jsonb
) returns text
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $function$
declare
  v_account_key text := encode(digest(p_user_id::text, 'sha256'), 'hex');
  v_delivery_key text := 'norva-account-deleted-' || v_account_key;
  v_email text := lower(btrim(coalesce(p_recipient_email, '')));
  v_result text;
begin
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+$'
     or nullif(btrim(p_request_from), '') is null
     or nullif(btrim(p_request_reply_to), '') is null
     or p_request_reply_to !~* '^[^@[:space:]]+@[^@[:space:]]+$'
     or nullif(btrim(p_request_subject), '') is null
     or nullif(btrim(p_request_html), '') is null
     or nullif(btrim(p_request_text), '') is null
     or jsonb_typeof(p_request_tags) is distinct from 'array'
     or jsonb_array_length(p_request_tags) not between 1 and 5
     or exists (
       select 1 from jsonb_array_elements(p_request_tags) tag
       where jsonb_typeof(tag) <> 'object'
           or coalesce(tag->>'name', '') not in ('app', 'category', 'flow')
          or coalesce(tag->>'value', '') !~ '^[a-z0-9_]{1,50}$'
     ) then
    raise exception 'complete, valid account deletion email request is required';
  end if;

  if not exists (
    select 1 from auth.users u
    where u.id = p_user_id and lower(btrim(u.email)) = v_email
  ) then
    raise exception 'account deletion email identity mismatch';
  end if;

  insert into public.cloud_account_deletion_email_outbox as o (
    account_key, delivery_key, state, recipient_email, request_from,
    request_reply_to, request_subject, request_html, request_text, request_tags,
    prepared_at, prepare_expires_at, next_attempt_at
  ) values (
    v_account_key, v_delivery_key, 'prepared', v_email, btrim(p_request_from),
    lower(btrim(p_request_reply_to)), p_request_subject, p_request_html,
    p_request_text, p_request_tags, clock_timestamp(),
    clock_timestamp() + interval '30 minutes', clock_timestamp()
  ) on conflict (account_key) do update
  set recipient_email = excluded.recipient_email,
      request_from = excluded.request_from,
      request_reply_to = excluded.request_reply_to,
      request_subject = excluded.request_subject,
      request_html = excluded.request_html,
      request_text = excluded.request_text,
      request_tags = excluded.request_tags,
      prepared_at = excluded.prepared_at,
      prepare_expires_at = excluded.prepare_expires_at,
      next_attempt_at = excluded.next_attempt_at,
      last_error = null,
      updated_at = clock_timestamp()
  where o.state = 'prepared'
  returning o.delivery_key into v_result;

  if v_result is null then
    raise exception 'account deletion email already finalized';
  end if;
  return v_result;
end
$function$;

-- A failed account deletion cancels only an unactivated preparation. This is
-- best-effort cleanup; expiry also guarantees that it can never be delivered.
create or replace function public.cancel_prepared_account_deletion_email(
  p_delivery_key text
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_changed integer;
begin
  delete from public.cloud_account_deletion_email_outbox o
  where o.delivery_key = p_delivery_key and o.state = 'prepared';
  get diagnostics v_changed = row_count;
  return v_changed = 1;
end
$function$;

-- Activation is transactionally coupled to the real auth deletion. Any trigger
-- failure is downgraded to a warning so email infrastructure cannot block the
-- user's primary GDPR deletion action.
create or replace function public.norva_activate_account_deletion_email()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $function$
declare
  v_account_key text := encode(digest(old.id::text, 'sha256'), 'hex');
begin
  begin
    update public.cloud_account_deletion_email_outbox o
    set state = 'ready',
        deletion_confirmed_at = clock_timestamp(),
        next_attempt_at = clock_timestamp(),
        updated_at = clock_timestamp()
    where o.account_key = v_account_key
      and o.state = 'prepared'
      and o.prepare_expires_at > clock_timestamp();
  exception when others then
    raise warning 'Norva account deletion email activation failed: %', sqlerrm;
  end;
  return old;
end
$function$;

drop trigger if exists norva_activate_account_deletion_email_trg on auth.users;
create trigger norva_activate_account_deletion_email_trg
  after delete on auth.users
  for each row execute function public.norva_activate_account_deletion_email();

-- Edge-side confirmation closes the last gap if a trigger warning was raised.
-- This RPC is service-only and is called strictly after deleteUser returned
-- success; normal operation is an idempotent read because the trigger won first.
create or replace function public.confirm_account_deletion_email(
  p_delivery_key text,
  p_deleted_user_id uuid
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $function$
declare
  v_account_key text := encode(digest(p_deleted_user_id::text, 'sha256'), 'hex');
begin
  update public.cloud_account_deletion_email_outbox o
  set state = 'ready',
      deletion_confirmed_at = coalesce(o.deletion_confirmed_at, clock_timestamp()),
      next_attempt_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where o.delivery_key = p_delivery_key
    and o.account_key = v_account_key
    and o.state = 'prepared'
    and o.prepare_expires_at > clock_timestamp()
    -- Do not trust caller ordering alone: the fallback may only activate after
    -- the exact auth identity has actually disappeared.
    and not exists (select 1 from auth.users u where u.id = p_deleted_user_id);

  return exists (
    select 1 from public.cloud_account_deletion_email_outbox o
    where o.delivery_key = p_delivery_key
      and o.account_key = v_account_key
      and o.deletion_confirmed_at is not null
      and o.state in ('ready', 'processing', 'sent', 'dead_letter')
  );
end
$function$;

create or replace function public.claim_account_deletion_email_deliveries(
  p_batch integer default 5,
  p_lease_seconds integer default 90,
  p_max_attempts integer default 12
) returns table (
  delivery_key text,
  lease_token uuid,
  recipient_email text,
  request_from text,
  request_reply_to text,
  request_subject text,
  request_html text,
  request_text text,
  request_tags jsonb,
  attempt_count integer
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := clock_timestamp();
begin
  return query
  with due as (
    select o.account_key
    from public.cloud_account_deletion_email_outbox o
    where o.deletion_confirmed_at is not null
      and o.next_attempt_at <= v_now
      and (
        (o.state = 'ready'
          and o.attempt_count < greatest(1, least(coalesce(p_max_attempts, 12), 30)))
        -- A worker can disappear after Resend acceptance but before the SQL CAS.
        -- Expired processing leases are always replayable with the same key;
        -- only a recorded provider failure is allowed to dead-letter a row.
        or (o.state = 'processing' and o.lease_expires_at <= v_now)
      )
    order by o.next_attempt_at, o.created_at
    limit greatest(1, least(coalesce(p_batch, 5), 25))
    for update skip locked
  ), claimed as (
    update public.cloud_account_deletion_email_outbox o
    set state = 'processing',
        lease_token = gen_random_uuid(),
        lease_expires_at = v_now + make_interval(
          secs => greatest(30, least(coalesce(p_lease_seconds, 90), 300))
        ),
        attempt_count = o.attempt_count + 1,
        updated_at = v_now
    from due
    where o.account_key = due.account_key
    returning o.*
  )
  select c.delivery_key, c.lease_token, c.recipient_email, c.request_from,
         c.request_reply_to, c.request_subject, c.request_html, c.request_text,
         c.request_tags, c.attempt_count
  from claimed c
  order by c.next_attempt_at, c.created_at;
end
$function$;

create or replace function public.complete_account_deletion_email_delivery(
  p_delivery_key text,
  p_lease_token uuid,
  p_resend_email_id text,
  p_http_status integer,
  p_response jsonb default '{}'::jsonb
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_changed integer;
begin
  if p_http_status not between 200 and 299
     or nullif(btrim(p_resend_email_id), '') is null then
    raise exception 'successful Resend status and email id are required';
  end if;

  update public.cloud_account_deletion_email_outbox o
  set state = 'sent',
      resend_email_id = btrim(p_resend_email_id),
      resend_response = coalesce(p_response, '{}'::jsonb),
      last_http_status = p_http_status,
      last_error = null,
      sent_at = clock_timestamp(),
      lease_token = null,
      lease_expires_at = null,
      -- Immediate data minimization after provider acceptance.
      recipient_email = null,
      request_html = null,
      request_text = null,
      updated_at = clock_timestamp()
  where o.delivery_key = p_delivery_key
    and o.state = 'processing'
    and o.lease_token = p_lease_token;
  get diagnostics v_changed = row_count;
  return v_changed = 1;
end
$function$;

create or replace function public.fail_account_deletion_email_delivery(
  p_delivery_key text,
  p_lease_token uuid,
  p_http_status integer,
  p_error text,
  p_response jsonb default '{}'::jsonb,
  p_retryable boolean default true,
  p_retry_after_seconds integer default null,
  p_max_attempts integer default 12
) returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_attempt integer;
  v_terminal boolean;
  v_delay_seconds integer;
  v_changed integer;
begin
  select o.attempt_count into v_attempt
  from public.cloud_account_deletion_email_outbox o
  where o.delivery_key = p_delivery_key
    and o.state = 'processing'
    and o.lease_token = p_lease_token
  for update;
  if not found then return 'lease_lost'; end if;

  v_terminal := not coalesce(p_retryable, false)
    or v_attempt >= greatest(1, least(coalesce(p_max_attempts, 12), 30));
  v_delay_seconds := greatest(
    coalesce(p_retry_after_seconds, 0),
    least(21600, round(30 * power(2::numeric, greatest(v_attempt - 1, 0)))::integer)
      + floor(random() * 16)::integer
  );

  update public.cloud_account_deletion_email_outbox o
  set state = case when v_terminal then 'dead_letter' else 'ready' end,
      resend_response = coalesce(p_response, '{}'::jsonb),
      last_http_status = p_http_status,
      last_error = left(coalesce(nullif(p_error, ''), 'delivery_failed'), 1000),
      exhausted_at = case when v_terminal then v_now else null end,
      next_attempt_at = case when v_terminal then o.next_attempt_at
                             else v_now + make_interval(secs => v_delay_seconds) end,
      lease_token = null,
      lease_expires_at = null,
      updated_at = v_now
  where o.delivery_key = p_delivery_key
    and o.state = 'processing'
    and o.lease_token = p_lease_token;
  get diagnostics v_changed = row_count;
  if v_changed <> 1 then return 'lease_lost'; end if;
  return case when v_terminal then 'dead_letter' else 'retry_scheduled' end;
end
$function$;

create or replace function public.prune_account_deletion_email_outbox()
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_deleted integer;
begin
  delete from public.cloud_account_deletion_email_outbox o
  where (o.state = 'prepared' and o.prepare_expires_at < now())
     or (o.state = 'sent' and o.sent_at < now() - interval '30 days')
     or (o.state = 'dead_letter' and o.exhausted_at < now() - interval '30 days');
  get diagnostics v_deleted = row_count;
  return v_deleted;
end
$function$;

revoke all on function public.prepare_account_deletion_email(uuid, text, text, text, text, text, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.cancel_prepared_account_deletion_email(text)
  from public, anon, authenticated;
revoke all on function public.norva_activate_account_deletion_email()
  from public, anon, authenticated;
revoke all on function public.confirm_account_deletion_email(text, uuid)
  from public, anon, authenticated;
revoke all on function public.claim_account_deletion_email_deliveries(integer, integer, integer)
  from public, anon, authenticated;
revoke all on function public.complete_account_deletion_email_delivery(text, uuid, text, integer, jsonb)
  from public, anon, authenticated;
revoke all on function public.fail_account_deletion_email_delivery(text, uuid, integer, text, jsonb, boolean, integer, integer)
  from public, anon, authenticated;
revoke all on function public.prune_account_deletion_email_outbox()
  from public, anon, authenticated;

grant execute on function public.prepare_account_deletion_email(uuid, text, text, text, text, text, text, jsonb)
  to service_role;
grant execute on function public.cancel_prepared_account_deletion_email(text)
  to service_role;
grant execute on function public.confirm_account_deletion_email(text, uuid)
  to service_role;
grant execute on function public.claim_account_deletion_email_deliveries(integer, integer, integer)
  to service_role;
grant execute on function public.complete_account_deletion_email_delivery(text, uuid, text, integer, jsonb)
  to service_role;
grant execute on function public.fail_account_deletion_email_delivery(text, uuid, integer, text, jsonb, boolean, integer, integer)
  to service_role;
grant execute on function public.prune_account_deletion_email_outbox()
  to service_role;

-- Dedicated retry worker. The WHERE clause keeps the minutely cron idle when no
-- deletion confirmation is due. In environments without pg_cron/pg_net, the
-- runbook documents registering the same endpoint externally.
do $cron_setup$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron')
     and exists (select 1 from pg_namespace where nspname = 'net') then
    perform cron.schedule(
      'norva-account-deletion-email',
      '* * * * *',
      $cron$
        select net.http_post(
          url := 'https://api.norva.tv/functions/v1/norva-account-delete/cron/run',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || (
              select decrypted_secret from vault.decrypted_secrets
              where name = 'norva_cron_shared_secret'
            )
          ),
          body := '{}'::jsonb,
          timeout_milliseconds := 30000
        )
        where exists (
          select 1 from public.cloud_account_deletion_email_outbox o
          where o.deletion_confirmed_at is not null
            and o.next_attempt_at <= now()
            and (
              o.state = 'ready'
              or (o.state = 'processing' and o.lease_expires_at <= now())
            )
        );
      $cron$
    );
    perform cron.schedule(
      'norva-account-deletion-email-prune',
      '55 3 * * *',
      'select public.prune_account_deletion_email_outbox();'
    );
  end if;
exception when undefined_table or invalid_schema_name or insufficient_privilege then
  raise notice 'account deletion email crons unavailable; register the worker externally';
end
$cron_setup$;

notify pgrst, 'reload schema';
