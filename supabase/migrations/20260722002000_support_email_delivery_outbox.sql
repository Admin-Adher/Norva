-- Durable support-email delivery.
--
-- A support message and its exact outbound Resend request are committed in one
-- transaction. request_id and advisory transaction locks make client retries and
-- concurrent double-submits atomic. The worker uses leased CAS transitions and a
-- 23-hour replay ceiling because Resend idempotency keys expire after 24 hours.

alter table public.cloud_support_messages
  add column if not exists request_id uuid;

create unique index if not exists cloud_support_messages_request_id_uidx
  on public.cloud_support_messages (request_id)
  where request_id is not null;

create table if not exists public.cloud_support_email_outbox (
  delivery_key         text primary key,
  request_id           uuid not null unique,
  message_id           uuid not null references public.cloud_support_messages(id) on delete cascade,
  ticket_id            uuid not null references public.cloud_support_tickets(id) on delete cascade,
  direction            text not null check (direction in ('user_to_support', 'support_to_user')),
  state                text not null default 'ready'
                       check (state in ('ready', 'processing', 'sent', 'dead_letter')),
  recipient_email      text,
  request_from         text not null,
  request_reply_to     text,
  request_subject      text,
  request_html         text,
  request_text         text,
  request_tags         jsonb not null,
  attempt_count        integer not null default 0 check (attempt_count >= 0),
  next_attempt_at      timestamptz not null default now(),
  lease_token          uuid,
  lease_expires_at     timestamptz,
  transport_started_at timestamptz,
  resend_email_id      text,
  resend_response      jsonb not null default '{}'::jsonb,
  last_http_status     integer,
  last_error           text,
  sent_at              timestamptz,
  exhausted_at         timestamptz,
  payload_scrubbed_at  timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (message_id, direction),
  constraint cloud_support_email_delivery_key_check check (
    delivery_key ~ '^norva-support-(user|admin)-[0-9a-f-]{36}$'
  ),
  constraint cloud_support_email_tags_check check (
    jsonb_typeof(request_tags) = 'array'
    and jsonb_array_length(request_tags) between 3 and 5
  ),
  constraint cloud_support_email_payload_check check (
    (state in ('ready', 'processing')
      and recipient_email is not null and request_reply_to is not null
      and request_subject is not null and request_html is not null and request_text is not null)
    or state = 'dead_letter'
    or (state = 'sent'
      and recipient_email is null and request_reply_to is null
      and request_subject is null and request_html is null and request_text is null)
  ),
  constraint cloud_support_email_lease_check check (
    (state = 'processing' and lease_token is not null and lease_expires_at is not null)
    or (state <> 'processing' and lease_token is null and lease_expires_at is null)
  ),
  constraint cloud_support_email_terminal_check check (
    (state = 'sent' and sent_at is not null and exhausted_at is null)
    or (state = 'dead_letter' and sent_at is null and exhausted_at is not null)
    or (state not in ('sent', 'dead_letter') and sent_at is null and exhausted_at is null)
  )
);

create index if not exists cloud_support_email_outbox_due_idx
  on public.cloud_support_email_outbox (next_attempt_at, created_at)
  where state in ('ready', 'processing');
create index if not exists cloud_support_email_outbox_retention_idx
  on public.cloud_support_email_outbox (coalesce(sent_at, exhausted_at, created_at));

alter table public.cloud_support_email_outbox enable row level security;
revoke all on table public.cloud_support_email_outbox from public, anon, authenticated;
grant all on table public.cloud_support_email_outbox to service_role;

comment on table public.cloud_support_email_outbox is
  'Service-only immutable support-email requests with leased delivery, bounded replay, DLQ and automatic payload scrubbing.';

-- Freeze the exact payload only after replacing identifiers allocated by the
-- caller/RPC. This helper is service-only and is invoked inside the same SQL
-- transaction that inserts the support message.
create or replace function public.norva_freeze_support_email(
  p_request_id uuid,
  p_message_id uuid,
  p_ticket_id uuid,
  p_direction text,
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
set search_path = pg_catalog, public
as $function$
declare
  v_recipient text := lower(btrim(coalesce(p_recipient_email, '')));
  v_reply_to text := lower(btrim(coalesce(p_request_reply_to, '')));
  v_ticket_ref text := upper(left(replace(p_ticket_id::text, '-', ''), 8));
  v_prefix text := case when p_direction = 'user_to_support' then 'user' else 'admin' end;
  v_delivery_key text := 'norva-support-' || v_prefix || '-' || p_message_id::text;
  v_subject text;
  v_html text;
  v_text text;
begin
  if p_request_id is null or p_message_id is null or p_ticket_id is null
     or p_direction not in ('user_to_support', 'support_to_user')
     or v_recipient !~ '^[^@[:space:]]+@[^@[:space:]]+$'
     or v_reply_to !~ '^[^@[:space:]]+@[^@[:space:]]+$'
     or nullif(btrim(coalesce(p_request_from, '')), '') is null
     or nullif(btrim(coalesce(p_request_subject, '')), '') is null
     or nullif(btrim(coalesce(p_request_html, '')), '') is null
     or nullif(btrim(coalesce(p_request_text, '')), '') is null
     or length(p_request_subject) > 250
     or length(p_request_html) > 200000
     or length(p_request_text) > 50000
     or jsonb_typeof(p_request_tags) is distinct from 'array'
     or jsonb_array_length(p_request_tags) not between 3 and 5
     or not p_request_tags @> '[{"name":"app","value":"norva"}]'::jsonb
     or not p_request_tags @> '[{"name":"category","value":"transactional"}]'::jsonb
     or not p_request_tags @> jsonb_build_array(jsonb_build_object(
       'name', 'flow',
       'value', case when p_direction = 'user_to_support'
         then 'support_customer_message' else 'support_agent_reply' end
     ))
     or exists (
       select 1 from jsonb_array_elements(p_request_tags) tag
       where jsonb_typeof(tag) <> 'object'
          or coalesce(tag->>'name', '') not in ('app', 'category', 'flow')
          or coalesce(tag->>'value', '') !~ '^[a-z0-9_]{1,50}$'
     ) then
    raise exception 'invalid_support_email_payload';
  end if;

  v_subject := replace(replace(replace(
    p_request_subject, '{{ticket_ref}}', v_ticket_ref),
    '{{ticket_id}}', p_ticket_id::text), '{{message_id}}', p_message_id::text);
  v_html := replace(replace(replace(
    p_request_html, '{{ticket_ref}}', v_ticket_ref),
    '{{ticket_id}}', p_ticket_id::text), '{{message_id}}', p_message_id::text);
  v_text := replace(replace(replace(
    p_request_text, '{{ticket_ref}}', v_ticket_ref),
    '{{ticket_id}}', p_ticket_id::text), '{{message_id}}', p_message_id::text);

  insert into public.cloud_support_email_outbox (
    delivery_key, request_id, message_id, ticket_id, direction,
    recipient_email, request_from, request_reply_to, request_subject,
    request_html, request_text, request_tags, state, next_attempt_at
  ) values (
    v_delivery_key, p_request_id, p_message_id, p_ticket_id, p_direction,
    v_recipient, btrim(p_request_from), v_reply_to, v_subject,
    v_html, v_text, p_request_tags, 'ready', clock_timestamp()
  )
  on conflict (message_id, direction) do nothing;

  return v_delivery_key;
end
$function$;

create or replace function public.norva_create_support_message_with_email(
  p_user_id uuid,
  p_author_email text,
  p_subject text,
  p_body text,
  p_request_id uuid,
  p_ticket_id uuid,
  p_message_id uuid,
  p_recipient_email text,
  p_request_from text,
  p_request_reply_to text,
  p_request_subject text,
  p_request_html text,
  p_request_text text,
  p_request_tags jsonb
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_email text;
  v_existing record;
  v_delivery_state text;
begin
  if p_request_id is null or p_ticket_id is null or p_message_id is null
     or length(btrim(coalesce(p_subject, ''))) not between 3 and 180
     or length(btrim(coalesce(p_body, ''))) not between 5 and 8000 then
    raise exception 'invalid_support_message';
  end if;

  select lower(btrim(u.email)) into v_email
  from auth.users u where u.id = p_user_id;
  if v_email is null or v_email <> lower(btrim(coalesce(p_author_email, ''))) then
    raise exception 'support_identity_mismatch';
  end if;

  -- Serializes both a stable client request id and legacy clients that retry the
  -- exact same create payload without supplying one.
  perform pg_advisory_xact_lock(hashtextextended('support-request:' || p_request_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended(
    'support-create:' || p_user_id::text || ':' || p_subject || ':' || p_body, 0
  ));

  select m.id as message_id, m.ticket_id, t.user_id, m.from_admin
  into v_existing
  from public.cloud_support_messages m
  join public.cloud_support_tickets t on t.id = m.ticket_id
  where m.request_id = p_request_id;
  if found then
    if v_existing.user_id <> p_user_id or v_existing.from_admin then
      raise exception 'support_request_id_conflict';
    end if;
    select o.state into v_delivery_state
    from public.cloud_support_email_outbox o
    where o.message_id = v_existing.message_id and o.direction = 'user_to_support';
    return jsonb_build_object(
      'ticket_id', v_existing.ticket_id,
      'message_id', v_existing.message_id,
      'request_id', p_request_id,
      'deduped', true,
      'delivery_state', coalesce(v_delivery_state, 'unavailable')
    );
  end if;

  select m.id as message_id, m.ticket_id, t.user_id, m.from_admin, m.request_id
  into v_existing
  from public.cloud_support_tickets t
  join public.cloud_support_messages m on m.ticket_id = t.id
  where t.user_id = p_user_id
    and t.subject = p_subject
    and not m.from_admin
    and m.body = p_body
    and m.created_at >= v_now - interval '10 minutes'
    and not exists (
      select 1 from public.cloud_support_messages earlier
      where earlier.ticket_id = t.id
        and (earlier.created_at, earlier.id) < (m.created_at, m.id)
    )
  order by m.created_at desc
  limit 1;
  if found then
    select o.state into v_delivery_state
    from public.cloud_support_email_outbox o
    where o.message_id = v_existing.message_id and o.direction = 'user_to_support';
    return jsonb_build_object(
      'ticket_id', v_existing.ticket_id,
      'message_id', v_existing.message_id,
      'request_id', coalesce(v_existing.request_id, p_request_id),
      'deduped', true,
      'delivery_state', coalesce(v_delivery_state, 'unavailable')
    );
  end if;

  insert into public.cloud_support_tickets (
    id, user_id, subject, status, last_from, last_message_at, created_at, updated_at
  ) values (
    p_ticket_id, p_user_id, p_subject, 'open', 'user', v_now, v_now, v_now
  );
  insert into public.cloud_support_messages (
    id, ticket_id, from_admin, author_email, body, request_id, created_at
  ) values (
    p_message_id, p_ticket_id, false, v_email, p_body, p_request_id, v_now
  );

  perform public.norva_freeze_support_email(
    p_request_id, p_message_id, p_ticket_id, 'user_to_support',
    p_recipient_email, p_request_from, p_request_reply_to,
    p_request_subject, p_request_html, p_request_text, p_request_tags
  );

  return jsonb_build_object(
    'ticket_id', p_ticket_id,
    'message_id', p_message_id,
    'request_id', p_request_id,
    'deduped', false,
    'delivery_state', 'ready'
  );
end
$function$;

create or replace function public.norva_append_support_message_with_email(
  p_actor_user_id uuid,
  p_ticket_id uuid,
  p_from_admin boolean,
  p_author_email text,
  p_body text,
  p_request_id uuid,
  p_message_id uuid,
  p_recipient_email text,
  p_request_from text,
  p_request_reply_to text,
  p_request_subject text,
  p_request_html text,
  p_request_text text,
  p_request_tags jsonb
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_actor_email text;
  v_ticket record;
  v_existing record;
  v_recipient text;
  v_direction text := case when p_from_admin then 'support_to_user' else 'user_to_support' end;
  v_delivery_state text;
begin
  if p_request_id is null or p_ticket_id is null or p_message_id is null
     or length(btrim(coalesce(p_body, ''))) not between 2 and 8000 then
    raise exception 'invalid_support_message';
  end if;

  select lower(btrim(u.email)) into v_actor_email
  from auth.users u
  where u.id = p_actor_user_id
    and (not p_from_admin or coalesce(u.raw_app_meta_data->>'role', '') = 'admin');
  if v_actor_email is null or v_actor_email <> lower(btrim(coalesce(p_author_email, ''))) then
    raise exception 'support_identity_mismatch';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('support-request:' || p_request_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('support-ticket:' || p_ticket_id::text, 0));

  select t.id, t.user_id, t.subject, lower(btrim(u.email)) as owner_email
  into v_ticket
  from public.cloud_support_tickets t
  left join auth.users u on u.id = t.user_id
  where t.id = p_ticket_id
  for update of t;
  if not found then raise exception 'support_ticket_not_found'; end if;
  if not p_from_admin and v_ticket.user_id <> p_actor_user_id then
    raise exception 'support_ticket_not_found';
  end if;
  v_recipient := case when p_from_admin then v_ticket.owner_email else p_recipient_email end;

  select m.id as message_id, m.ticket_id, m.from_admin, t.user_id
  into v_existing
  from public.cloud_support_messages m
  join public.cloud_support_tickets t on t.id = m.ticket_id
  where m.request_id = p_request_id;
  if found then
    if v_existing.ticket_id <> p_ticket_id
       or v_existing.from_admin is distinct from p_from_admin
       or (not p_from_admin and v_existing.user_id <> p_actor_user_id) then
      raise exception 'support_request_id_conflict';
    end if;
    select o.state into v_delivery_state
    from public.cloud_support_email_outbox o
    where o.message_id = v_existing.message_id and o.direction = v_direction;
    return jsonb_build_object(
      'ticket_id', v_existing.ticket_id,
      'message_id', v_existing.message_id,
      'request_id', p_request_id,
      'deduped', true,
      'delivery_state', coalesce(v_delivery_state, 'unavailable')
    );
  end if;

  -- A retry of an already-committed request remains idempotent even if the
  -- account email disappeared in the meantime. Only a genuinely new message
  -- needs a currently deliverable recipient.
  if v_recipient is null then raise exception 'support_recipient_unavailable'; end if;

  select m.id as message_id, m.ticket_id, m.from_admin, m.body, m.created_at, m.request_id
  into v_existing
  from public.cloud_support_messages m
  where m.ticket_id = p_ticket_id
  order by m.created_at desc, m.id desc
  limit 1;
  if found and v_existing.from_admin is not distinct from p_from_admin
     and v_existing.body = p_body
     and v_existing.created_at >= v_now - interval '10 minutes' then
    select o.state into v_delivery_state
    from public.cloud_support_email_outbox o
    where o.message_id = v_existing.message_id and o.direction = v_direction;
    return jsonb_build_object(
      'ticket_id', p_ticket_id,
      'message_id', v_existing.message_id,
      'request_id', coalesce(v_existing.request_id, p_request_id),
      'deduped', true,
      'delivery_state', coalesce(v_delivery_state, 'unavailable')
    );
  end if;

  insert into public.cloud_support_messages (
    id, ticket_id, from_admin, author_email, body, request_id, created_at
  ) values (
    p_message_id, p_ticket_id, p_from_admin, v_actor_email, p_body, p_request_id, v_now
  );
  update public.cloud_support_tickets
  set status = case when p_from_admin then 'pending' else 'open' end,
      last_from = case when p_from_admin then 'admin' else 'user' end,
      last_message_at = v_now,
      updated_at = v_now
  where id = p_ticket_id;

  perform public.norva_freeze_support_email(
    p_request_id, p_message_id, p_ticket_id, v_direction,
    v_recipient, p_request_from, p_request_reply_to,
    p_request_subject, p_request_html, p_request_text, p_request_tags
  );

  return jsonb_build_object(
    'ticket_id', p_ticket_id,
    'message_id', p_message_id,
    'request_id', p_request_id,
    'deduped', false,
    'delivery_state', 'ready'
  );
end
$function$;

create or replace function public.claim_support_email_deliveries(
  p_batch integer default 4,
  p_lease_seconds integer default 90,
  p_max_attempts integer default 12
) returns table (
  delivery_key text,
  request_id uuid,
  lease_token uuid,
  direction text,
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
  update public.cloud_support_email_outbox o
  set state = 'dead_letter',
      last_error = 'idempotency_window_expired_manual_review',
      resend_response = '{}'::jsonb,
      exhausted_at = v_now,
      lease_token = null,
      lease_expires_at = null,
      updated_at = v_now
  where o.state in ('ready', 'processing')
    and o.transport_started_at <= v_now - interval '23 hours';

  return query
  with due as (
    select o.delivery_key
    from public.cloud_support_email_outbox o
    where o.next_attempt_at <= v_now
      and (o.transport_started_at is null
           or o.transport_started_at > v_now - interval '23 hours')
      and (
        (o.state = 'ready'
          and o.attempt_count < greatest(1, least(coalesce(p_max_attempts, 12), 30)))
        or (o.state = 'processing' and o.lease_expires_at <= v_now)
      )
    order by o.next_attempt_at, o.created_at
    limit greatest(1, least(coalesce(p_batch, 4), 20))
    for update skip locked
  ), claimed as (
    update public.cloud_support_email_outbox o
    set state = 'processing',
        lease_token = gen_random_uuid(),
        lease_expires_at = v_now + make_interval(
          secs => greatest(30, least(coalesce(p_lease_seconds, 90), 300))
        ),
        transport_started_at = coalesce(o.transport_started_at, v_now),
        attempt_count = o.attempt_count + 1,
        updated_at = v_now
    from due
    where o.delivery_key = due.delivery_key
    returning o.*
  )
  select c.delivery_key, c.request_id, c.lease_token, c.direction,
         c.recipient_email, c.request_from, c.request_reply_to,
         c.request_subject, c.request_html, c.request_text,
         c.request_tags, c.attempt_count
  from claimed c
  order by c.next_attempt_at, c.created_at;
end
$function$;

create or replace function public.complete_support_email_delivery(
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
     or nullif(btrim(coalesce(p_resend_email_id, '')), '') is null then
    raise exception 'successful Resend status and email id are required';
  end if;
  update public.cloud_support_email_outbox o
  set state = 'sent',
      resend_email_id = left(btrim(p_resend_email_id), 200),
      resend_response = coalesce(p_response, '{}'::jsonb),
      last_http_status = p_http_status,
      last_error = null,
      sent_at = clock_timestamp(),
      lease_token = null,
      lease_expires_at = null,
      recipient_email = null,
      request_reply_to = null,
      request_subject = null,
      request_html = null,
      request_text = null,
      payload_scrubbed_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where o.delivery_key = p_delivery_key
    and o.state = 'processing'
    and o.lease_token = p_lease_token;
  get diagnostics v_changed = row_count;
  return v_changed = 1;
end
$function$;

create or replace function public.fail_support_email_delivery(
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
  v_transport_started_at timestamptz;
  v_delay integer;
  v_window_terminal boolean;
  v_terminal boolean;
  v_changed integer;
begin
  select o.attempt_count, o.transport_started_at
  into v_attempt, v_transport_started_at
  from public.cloud_support_email_outbox o
  where o.delivery_key = p_delivery_key
    and o.state = 'processing'
    and o.lease_token = p_lease_token
  for update;
  if not found then return 'lease_lost'; end if;

  v_delay := greatest(
    coalesce(p_retry_after_seconds, 0),
    least(21600, round(30 * power(2::numeric, greatest(v_attempt - 1, 0)))::integer)
      + floor(random() * 16)::integer
  );
  v_window_terminal := v_transport_started_at is not null
    and v_now + make_interval(secs => v_delay)
      >= v_transport_started_at + interval '23 hours';
  v_terminal := not coalesce(p_retryable, false)
    or v_attempt >= greatest(1, least(coalesce(p_max_attempts, 12), 30))
    or v_window_terminal;

  update public.cloud_support_email_outbox o
  set state = case when v_terminal then 'dead_letter' else 'ready' end,
      resend_response = coalesce(p_response, '{}'::jsonb),
      last_http_status = p_http_status,
      last_error = case when v_window_terminal
        then 'idempotency_window_expired_manual_review'
        else left(coalesce(nullif(p_error, ''), 'delivery_failed'), 1000) end,
      exhausted_at = case when v_terminal then v_now else null end,
      next_attempt_at = case when v_terminal then o.next_attempt_at
        else v_now + make_interval(secs => v_delay) end,
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

create or replace function public.defer_support_email_delivery(
  p_delivery_key text,
  p_lease_token uuid,
  p_retry_after_seconds integer default 60
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_changed integer;
begin
  update public.cloud_support_email_outbox o
  set state = 'ready',
      attempt_count = greatest(0, o.attempt_count - 1),
      transport_started_at = case when o.attempt_count <= 1 then null else o.transport_started_at end,
      next_attempt_at = clock_timestamp() + make_interval(
        secs => greatest(1, least(coalesce(p_retry_after_seconds, 60), 21600))
      ),
      last_http_status = 429,
      last_error = 'resend_team_rate_limited_before_send',
      resend_response = '{"code":"team_rate_limited"}'::jsonb,
      lease_token = null,
      lease_expires_at = null,
      updated_at = clock_timestamp()
  where o.delivery_key = p_delivery_key
    and o.state = 'processing'
    and o.lease_token = p_lease_token;
  get diagnostics v_changed = row_count;
  return v_changed = 1;
end
$function$;

create or replace function public.prune_support_email_outbox()
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_deleted integer;
begin
  -- Keep DLQ payloads briefly for operator remediation, then remove every email
  -- address and free-form support body even if the row remains for aggregate audit.
  update public.cloud_support_email_outbox o
  set recipient_email = null,
      request_reply_to = null,
      request_subject = null,
      request_html = null,
      request_text = null,
      resend_response = '{}'::jsonb,
      payload_scrubbed_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where o.state = 'dead_letter'
    and o.exhausted_at < clock_timestamp() - interval '14 days'
    and o.payload_scrubbed_at is null;

  delete from public.cloud_support_email_outbox o
  where (o.state = 'sent' and o.sent_at < clock_timestamp() - interval '90 days')
     or (o.state = 'dead_letter' and o.exhausted_at < clock_timestamp() - interval '90 days');
  get diagnostics v_deleted = row_count;
  return v_deleted;
end
$function$;

revoke all on function public.norva_freeze_support_email(uuid, uuid, uuid, text, text, text, text, text, text, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.norva_create_support_message_with_email(uuid, text, text, text, uuid, uuid, uuid, text, text, text, text, text, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.norva_append_support_message_with_email(uuid, uuid, boolean, text, text, uuid, uuid, text, text, text, text, text, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.claim_support_email_deliveries(integer, integer, integer)
  from public, anon, authenticated;
revoke all on function public.complete_support_email_delivery(text, uuid, text, integer, jsonb)
  from public, anon, authenticated;
revoke all on function public.fail_support_email_delivery(text, uuid, integer, text, jsonb, boolean, integer, integer)
  from public, anon, authenticated;
revoke all on function public.defer_support_email_delivery(text, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.prune_support_email_outbox()
  from public, anon, authenticated;

grant execute on function public.norva_create_support_message_with_email(uuid, text, text, text, uuid, uuid, uuid, text, text, text, text, text, text, jsonb)
  to service_role;
grant execute on function public.norva_append_support_message_with_email(uuid, uuid, boolean, text, text, uuid, uuid, text, text, text, text, text, text, jsonb)
  to service_role;
grant execute on function public.claim_support_email_deliveries(integer, integer, integer)
  to service_role;
grant execute on function public.complete_support_email_delivery(text, uuid, text, integer, jsonb)
  to service_role;
grant execute on function public.fail_support_email_delivery(text, uuid, integer, text, jsonb, boolean, integer, integer)
  to service_role;
grant execute on function public.defer_support_email_delivery(text, uuid, integer)
  to service_role;
grant execute on function public.prune_support_email_outbox()
  to service_role;

do $cron_setup$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron')
     and exists (select 1 from pg_namespace where nspname = 'net') then
    perform cron.schedule(
      'norva-support-email-delivery',
      '* * * * *',
      $cron$
        select net.http_post(
          url := 'https://api.norva.tv/functions/v1/norva-support/cron/run',
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
          select 1 from public.cloud_support_email_outbox o
          where o.next_attempt_at <= now()
            and (o.state = 'ready'
              or (o.state = 'processing' and o.lease_expires_at <= now()))
        );
      $cron$
    );
    perform cron.schedule(
      'norva-support-email-prune',
      '25 3 * * *',
      'select public.prune_support_email_outbox();'
    );
  end if;
exception when undefined_table or invalid_schema_name or insufficient_privilege then
  raise notice 'support email crons unavailable; register the worker externally';
end
$cron_setup$;

notify pgrst, 'reload schema';
