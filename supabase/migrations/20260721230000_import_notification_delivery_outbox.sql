-- Durable delivery state for import lifecycle digests.
--
-- The original queue marked rows only after Resend returned. If Resend accepted a
-- message and the subsequent database update failed, the next cron sent the same
-- digest again. This migration turns every settled (user_id, kind) digest into a
-- stable delivery, leases it atomically, and records the provider response before
-- acknowledging the queue. The stable delivery_key is also the Resend
-- Idempotency-Key, so a retry after an ambiguous network/database failure resolves
-- to the original Resend email instead of creating another one.

alter table public.cloud_import_notifications
  drop constraint if exists cloud_import_notifications_status_check;

alter table public.cloud_import_notifications
  add column if not exists delivery_key uuid,
  add column if not exists lease_token uuid,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists attempt_count integer not null default 0,
  add column if not exists next_attempt_at timestamptz not null default now(),
  add column if not exists last_attempt_at timestamptz,
  add column if not exists last_http_status integer,
  add column if not exists last_error text,
  add column if not exists resend_email_id text,
  add column if not exists resend_response jsonb,
  add column if not exists recipient_email text,
  add column if not exists request_from text,
  add column if not exists request_reply_to text,
  add column if not exists request_subject text,
  add column if not exists request_html text,
  add column if not exists request_text text,
  add column if not exists request_tags jsonb,
  add column if not exists prepared_at timestamptz,
  add column if not exists dead_lettered_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

alter table public.cloud_import_notifications
  add constraint cloud_import_notifications_status_check
    check (status in ('pending', 'processing', 'sent', 'skipped', 'dead_letter')),
  add constraint cloud_import_notifications_attempt_count_check
    check (attempt_count >= 0),
  add constraint cloud_import_notifications_lease_check
    check (
      (status = 'processing' and lease_token is not null and lease_expires_at is not null)
      or
      (status <> 'processing' and lease_token is null and lease_expires_at is null)
    ),
  add constraint cloud_import_notifications_request_check check (
    (status in ('sent', 'skipped', 'dead_letter')
      and recipient_email is null and request_from is null and request_reply_to is null
      and request_subject is null and request_html is null and request_text is null
      and request_tags is null)
    or
    (status in ('pending', 'processing') and prepared_at is null
      and recipient_email is null and request_from is null and request_reply_to is null
      and request_subject is null and request_html is null and request_text is null
      and request_tags is null)
    or
    (status in ('pending', 'processing') and prepared_at is not null
      and recipient_email is not null and request_from is not null and request_reply_to is not null
      and request_subject is not null and request_html is not null and request_text is not null
      and jsonb_typeof(request_tags) = 'array'
      and jsonb_array_length(request_tags) between 1 and 5)
    );

drop index if exists public.cloud_import_notifications_pending_idx;
create index if not exists cloud_import_notifications_ready_idx
  on public.cloud_import_notifications (next_attempt_at, created_at)
  where status = 'pending';
create index if not exists cloud_import_notifications_expired_lease_idx
  on public.cloud_import_notifications (lease_expires_at)
  where status = 'processing';
create index if not exists cloud_import_notifications_delivery_idx
  on public.cloud_import_notifications (delivery_key)
  where delivery_key is not null;
create index if not exists cloud_import_notifications_dead_letter_idx
  on public.cloud_import_notifications (dead_lettered_at desc)
  where status = 'dead_letter';

-- Claims complete digest groups, not individual events. The transaction-level
-- advisory lock makes assignment of a new delivery_key deterministic even when
-- two cron invocations overlap. Once assigned, later events never join that
-- delivery: retries therefore keep both the same content set and the same
-- Resend Idempotency-Key.
create or replace function public.claim_import_notification_deliveries(
  p_group_limit integer default 100,
  p_settle_seconds integer default 60,
  p_lease_seconds integer default 180,
  p_max_attempts integer default 8
)
returns table (
  delivery_key uuid,
  lease_token uuid,
  user_id uuid,
  kind text,
  notification_ids uuid[],
  source_ids uuid[],
  attempt_count integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := clock_timestamp();
begin
  if p_group_limit < 1 or p_group_limit > 500
     or p_settle_seconds < 0 or p_settle_seconds > 3600
     or p_lease_seconds < 30 or p_lease_seconds > 3600
     or p_max_attempts < 1 or p_max_attempts > 50 then
    raise exception 'invalid import notification claim limits';
  end if;

  if not pg_try_advisory_xact_lock(hashtext('norva:import-notification-delivery-claim')) then
    return;
  end if;

  -- Pending rows can be exhausted only after an explicit recorded provider
  -- failure. An expired processing lease is always replayable with the same
  -- Idempotency-Key: the previous worker may have disappeared after Resend
  -- accepted the request but before SQL acknowledgement.
  update public.cloud_import_notifications n
  set status = 'dead_letter',
      dead_lettered_at = v_now,
      last_error = coalesce(n.last_error, 'delivery exhausted maximum recorded failures'),
      payload = '{}'::jsonb,
      recipient_email = null,
      request_from = null,
      request_reply_to = null,
      request_subject = null,
      request_html = null,
      request_text = null,
      request_tags = null,
      resend_response = '{}'::jsonb,
      lease_token = null,
      lease_expires_at = null,
      updated_at = v_now
  where n.attempt_count >= p_max_attempts
    and (
      n.status = 'pending'
    );

  -- Snapshot up to p_group_limit new settled digests. The created_at predicate is
  -- repeated on UPDATE so events arriving during this transaction remain for the
  -- next digest instead of mutating an existing delivery.
  with new_groups as (
    select n.user_id, n.kind, min(n.created_at) as first_created_at
    from public.cloud_import_notifications n
    where n.status = 'pending'
      and n.delivery_key is null
      and n.next_attempt_at <= v_now
      and n.created_at < v_now - make_interval(secs => p_settle_seconds)
    group by n.user_id, n.kind
    order by min(n.created_at), n.user_id, n.kind
    limit p_group_limit
  ), keyed_groups as (
    select g.user_id, g.kind, gen_random_uuid() as delivery_key
    from new_groups g
  )
  update public.cloud_import_notifications n
  set delivery_key = g.delivery_key,
      updated_at = v_now
  from keyed_groups g
  where n.user_id = g.user_id
    and n.kind = g.kind
    and n.status = 'pending'
    and n.delivery_key is null
    and n.next_attempt_at <= v_now
    and n.created_at < v_now - make_interval(secs => p_settle_seconds);

  return query
  with candidate_groups as (
    select n.delivery_key, n.user_id, n.kind, min(n.created_at) as first_created_at
    from public.cloud_import_notifications n
    where n.delivery_key is not null
       and (
         (n.status = 'pending' and n.next_attempt_at <= v_now and n.attempt_count < p_max_attempts)
         or
         (n.status = 'processing' and n.lease_expires_at <= v_now)
      )
    group by n.delivery_key, n.user_id, n.kind
    order by min(n.created_at), n.delivery_key
    limit p_group_limit
  ), leased_groups as (
    select g.delivery_key, g.user_id, g.kind, gen_random_uuid() as lease_token
    from candidate_groups g
  ), claimed as (
    update public.cloud_import_notifications n
    set status = 'processing',
        lease_token = g.lease_token,
        lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
        attempt_count = n.attempt_count + 1,
        last_attempt_at = v_now,
        updated_at = v_now
    from leased_groups g
    where n.delivery_key = g.delivery_key
      and n.user_id = g.user_id
      and n.kind = g.kind
      and (
        (n.status = 'pending' and n.next_attempt_at <= v_now and n.attempt_count < p_max_attempts)
        or
        (n.status = 'processing' and n.lease_expires_at <= v_now)
      )
    returning n.id, n.source_id, n.delivery_key, n.lease_token,
              n.user_id, n.kind, n.attempt_count
  )
  select c.delivery_key,
         c.lease_token,
         c.user_id,
         c.kind,
         array_agg(c.id order by c.id),
         array_agg(distinct c.source_id order by c.source_id),
         max(c.attempt_count)
  from claimed c
  group by c.delivery_key, c.lease_token, c.user_id, c.kind;
end;
$$;

revoke all on function public.claim_import_notification_deliveries(integer, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_import_notification_deliveries(integer, integer, integer, integer)
  to service_role;

-- Freeze the exact outbound request before the network call. The email is
-- resolved from auth.users by the worker at first attempt, then every field in
-- the Resend JSON request remains immutable for every retry of this key.
-- This avoids an idempotency conflict if provider counts or the auth email change
-- after an ambiguous accepted response.
create or replace function public.prepare_import_notification_delivery(
  p_delivery_key uuid,
  p_notification_ids uuid[],
  p_lease_token uuid,
  p_recipient_email text,
  p_request_from text,
  p_request_reply_to text,
  p_request_subject text,
  p_request_html text,
  p_request_text text,
  p_request_tags jsonb
)
returns table (
  recipient_email text,
  request_from text,
  request_reply_to text,
  request_subject text,
  request_html text,
  request_text text,
  request_tags jsonb
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_expected integer := coalesce(cardinality(p_notification_ids), 0);
  v_matched integer;
  v_now timestamptz := clock_timestamp();
begin
  if v_expected < 1
     or nullif(lower(btrim(p_recipient_email)), '') is null
     or nullif(btrim(p_request_from), '') is null
     or nullif(lower(btrim(p_request_reply_to)), '') is null
     or nullif(btrim(p_request_subject), '') is null
     or nullif(p_request_html, '') is null
     or nullif(p_request_text, '') is null
     or length(p_recipient_email) > 320
     or length(p_request_from) > 320
     or length(p_request_reply_to) > 320
     or length(p_request_subject) > 500
     or length(p_request_html) > 500000
     or length(p_request_text) > 200000
     or p_recipient_email ~ '[[:cntrl:]]'
     or p_request_from ~ '[[:cntrl:]]'
     or p_request_reply_to ~ '[[:cntrl:]]'
     or p_request_subject ~ '[[:cntrl:]]'
     or jsonb_typeof(p_request_tags) is distinct from 'array'
     or jsonb_array_length(p_request_tags) not between 1 and 5
     or exists (
       select 1 from jsonb_array_elements(p_request_tags) tag
       where jsonb_typeof(tag) <> 'object'
          or coalesce(tag->>'name', '') !~ '^[A-Za-z0-9_-]{1,256}$'
          or coalesce(tag->>'value', '') !~ '^[A-Za-z0-9_-]{1,256}$'
          or tag - 'name' - 'value' <> '{}'::jsonb
     ) then
    return;
  end if;

  perform n.id
  from public.cloud_import_notifications n
  where n.id = any(p_notification_ids)
    and n.delivery_key = p_delivery_key
    and n.status = 'processing'
    and n.lease_token = p_lease_token
  for update;
  get diagnostics v_matched = row_count;

  if v_matched <> v_expected then return; end if;

  update public.cloud_import_notifications n
  set recipient_email = coalesce(n.recipient_email, lower(btrim(p_recipient_email))),
      request_from = coalesce(n.request_from, btrim(p_request_from)),
      request_reply_to = coalesce(n.request_reply_to, lower(btrim(p_request_reply_to))),
      request_subject = coalesce(n.request_subject, p_request_subject),
      request_html = coalesce(n.request_html, p_request_html),
      request_text = coalesce(n.request_text, p_request_text),
      request_tags = coalesce(n.request_tags, p_request_tags),
      prepared_at = coalesce(n.prepared_at, v_now),
      updated_at = v_now
  where n.id = any(p_notification_ids)
    and n.delivery_key = p_delivery_key
    and n.status = 'processing'
    and n.lease_token = p_lease_token;

  return query
  select n.recipient_email, n.request_from, n.request_reply_to,
         n.request_subject, n.request_html, n.request_text, n.request_tags
  from public.cloud_import_notifications n
  where n.id = any(p_notification_ids)
    and n.delivery_key = p_delivery_key
    and n.status = 'processing'
    and n.lease_token = p_lease_token
  limit 1;
end;
$$;

revoke all on function public.prepare_import_notification_delivery(
  uuid, uuid[], uuid, text, text, text, text, text, text, jsonb
)
  from public, anon, authenticated;
grant execute on function public.prepare_import_notification_delivery(
  uuid, uuid[], uuid, text, text, text, text, text, text, jsonb
)
  to service_role;

-- Acknowledge only if every claimed row still belongs to this exact lease. A
-- successful Resend response without its email id is deliberately not accepted.
create or replace function public.complete_import_notification_delivery(
  p_delivery_key uuid,
  p_notification_ids uuid[],
  p_lease_token uuid,
  p_recipient_email text,
  p_http_status integer,
  p_resend_email_id text,
  p_response jsonb default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_expected integer := coalesce(cardinality(p_notification_ids), 0);
  v_matched integer;
  v_now timestamptz := clock_timestamp();
begin
  if v_expected < 1
     or p_http_status not between 200 and 299
     or nullif(btrim(p_resend_email_id), '') is null
     or nullif(lower(btrim(p_recipient_email)), '') is null then
    return false;
  end if;

  perform n.id
  from public.cloud_import_notifications n
  where n.id = any(p_notification_ids)
    and n.delivery_key = p_delivery_key
    and n.status = 'processing'
    and n.lease_token = p_lease_token
    and n.recipient_email = lower(btrim(p_recipient_email))
    and n.request_from is not null
    and n.request_reply_to is not null
    and n.request_subject is not null
    and n.request_html is not null
    and n.request_text is not null
    and n.request_tags is not null
    and n.prepared_at is not null
  for update;
  get diagnostics v_matched = row_count;

  if v_matched <> v_expected then return false; end if;

  update public.cloud_import_notifications n
  set status = 'sent',
      sent_at = v_now,
      payload = '{}'::jsonb,
      recipient_email = null,
      request_from = null,
      request_reply_to = null,
      request_subject = null,
      request_html = null,
      request_text = null,
      request_tags = null,
      last_http_status = p_http_status,
      last_error = null,
      resend_email_id = btrim(p_resend_email_id),
      resend_response = '{}'::jsonb,
      lease_token = null,
      lease_expires_at = null,
      next_attempt_at = v_now,
      dead_lettered_at = null,
      updated_at = v_now
  where n.id = any(p_notification_ids)
    and n.delivery_key = p_delivery_key
    and n.status = 'processing'
    and n.lease_token = p_lease_token
    and n.recipient_email = lower(btrim(p_recipient_email));

  return true;
end;
$$;

revoke all on function public.complete_import_notification_delivery(uuid, uuid[], uuid, text, integer, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.complete_import_notification_delivery(uuid, uuid[], uuid, text, integer, text, jsonb)
  to service_role;

-- Fail a whole leased delivery atomically. Retryable failures use exponential
-- backoff with jitter; permanent failures and exhausted attempts enter a visible
-- dead-letter state instead of being retried forever.
create or replace function public.fail_import_notification_delivery(
  p_delivery_key uuid,
  p_notification_ids uuid[],
  p_lease_token uuid,
  p_retryable boolean,
  p_http_status integer default null,
  p_response jsonb default null,
  p_error text default null,
  p_max_attempts integer default 8,
  p_base_backoff_seconds integer default 120,
  p_max_backoff_seconds integer default 21600
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_expected integer := coalesce(cardinality(p_notification_ids), 0);
  v_matched integer;
  v_attempt integer;
  v_delay integer;
  v_now timestamptz := clock_timestamp();
  v_terminal boolean;
begin
  if v_expected < 1 or p_max_attempts < 1 or p_base_backoff_seconds < 1
     or p_max_backoff_seconds < p_base_backoff_seconds then
    return 'stale_or_invalid';
  end if;

  perform n.id
  from public.cloud_import_notifications n
  where n.id = any(p_notification_ids)
    and n.delivery_key = p_delivery_key
    and n.status = 'processing'
    and n.lease_token = p_lease_token
  for update;
  get diagnostics v_matched = row_count;

  if v_matched <> v_expected then return 'stale_or_invalid'; end if;

  select max(n.attempt_count) into v_attempt
  from public.cloud_import_notifications n
  where n.id = any(p_notification_ids)
    and n.delivery_key = p_delivery_key
    and n.status = 'processing'
    and n.lease_token = p_lease_token;

  v_terminal := not coalesce(p_retryable, false) or v_attempt >= p_max_attempts;
  v_delay := least(
    p_max_backoff_seconds,
    floor(p_base_backoff_seconds * power(2::numeric, greatest(v_attempt - 1, 0)))::integer
      + floor(random() * greatest(p_base_backoff_seconds, 1))::integer
  );

  update public.cloud_import_notifications n
  set status = case when v_terminal then 'dead_letter' else 'pending' end,
      next_attempt_at = case when v_terminal then v_now else v_now + make_interval(secs => v_delay) end,
      last_http_status = p_http_status,
      last_error = left(coalesce(nullif(p_error, ''), 'import notification delivery failed'), 2000),
      resend_response = case when v_terminal then '{}'::jsonb else coalesce(p_response, '{}'::jsonb) end,
      payload = case when v_terminal then '{}'::jsonb else n.payload end,
      recipient_email = case when v_terminal then null else n.recipient_email end,
      request_from = case when v_terminal then null else n.request_from end,
      request_reply_to = case when v_terminal then null else n.request_reply_to end,
      request_subject = case when v_terminal then null else n.request_subject end,
      request_html = case when v_terminal then null else n.request_html end,
      request_text = case when v_terminal then null else n.request_text end,
      request_tags = case when v_terminal then null else n.request_tags end,
      lease_token = null,
      lease_expires_at = null,
      dead_lettered_at = case when v_terminal then v_now else null end,
      updated_at = v_now
  where n.id = any(p_notification_ids)
    and n.delivery_key = p_delivery_key
    and n.status = 'processing'
    and n.lease_token = p_lease_token;

  return case when v_terminal then 'dead_letter' else 'retry_scheduled' end;
end;
$$;

revoke all on function public.fail_import_notification_delivery(uuid, uuid[], uuid, boolean, integer, jsonb, text, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.fail_import_notification_delivery(uuid, uuid[], uuid, boolean, integer, jsonb, text, integer, integer, integer)
  to service_role;

-- Deleted users and unsupported legacy event kinds are intentional terminal
-- skips, not delivery failures. The exact lease CAS prevents an old worker from
-- skipping a delivery already reclaimed by another worker.
create or replace function public.skip_import_notification_delivery(
  p_delivery_key uuid,
  p_notification_ids uuid[],
  p_lease_token uuid,
  p_reason text,
  p_recipient_email text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_expected integer := coalesce(cardinality(p_notification_ids), 0);
  v_matched integer;
  v_now timestamptz := clock_timestamp();
begin
  if v_expected < 1 then return false; end if;

  perform n.id
  from public.cloud_import_notifications n
  where n.id = any(p_notification_ids)
    and n.delivery_key = p_delivery_key
    and n.status = 'processing'
    and n.lease_token = p_lease_token
  for update;
  get diagnostics v_matched = row_count;

  if v_matched <> v_expected then return false; end if;

  update public.cloud_import_notifications n
  set status = 'skipped',
      sent_at = v_now,
      payload = '{}'::jsonb,
      recipient_email = null,
      request_from = null,
      request_reply_to = null,
      request_subject = null,
      request_html = null,
      request_text = null,
      request_tags = null,
      resend_response = '{}'::jsonb,
      last_error = left(coalesce(nullif(p_reason, ''), 'delivery skipped'), 2000),
      lease_token = null,
      lease_expires_at = null,
      updated_at = v_now
  where n.id = any(p_notification_ids)
    and n.delivery_key = p_delivery_key
    and n.status = 'processing'
    and n.lease_token = p_lease_token;

  return true;
end;
$$;

revoke all on function public.skip_import_notification_delivery(uuid, uuid[], uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.skip_import_notification_delivery(uuid, uuid[], uuid, text, text)
  to service_role;

-- Terminal rows are payload-free tombstones for a bounded audit window. Sent and
-- intentional skips stay longer than dead letters; provider/source truth remains
-- in the catalog and delivery telemetry remains in the Resend event ledger.
create or replace function public.prune_import_notification_deliveries()
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_deleted integer;
begin
  delete from public.cloud_import_notifications n
  where (n.status in ('sent', 'skipped')
          and n.sent_at < now() - interval '90 days')
     or (n.status = 'dead_letter'
          and n.dead_lettered_at < now() - interval '30 days');
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.prune_import_notification_deliveries()
  from public, anon, authenticated;
grant execute on function public.prune_import_notification_deliveries()
  to service_role;

-- Keep the idle-cron optimization, but wake for due retries and expired leases as
-- well as never-claimed settled events. Without the processing branch, a worker
-- crash could strand a delivery forever because no future cron would fire.
do $$
declare
  v_job_id bigint;
begin
  select jobid into v_job_id from cron.job where jobname = 'norva-import-notify-digest';
  if v_job_id is not null then
    perform cron.alter_job(v_job_id, command => $cron$
      select net.http_post(
        url := 'https://api.norva.tv/functions/v1/norva-import-notify/cron/digest',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || (
            select decrypted_secret from vault.decrypted_secrets
            where name = 'norva_cron_shared_secret'
          )
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 60000
      )
      where exists (
        select 1
        from public.cloud_import_notifications n
        where (
          n.status = 'pending'
          and n.next_attempt_at <= now()
          and (n.delivery_key is not null or n.created_at < now() - interval '60 seconds')
        ) or (
          n.status = 'processing'
          and n.lease_expires_at <= now()
        )
      );
    $cron$);
  end if;
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    perform cron.schedule(
      'norva-import-notification-prune',
      '35 3 * * *',
      'select public.prune_import_notification_deliveries();'
    );
  end if;
end;
$$;
