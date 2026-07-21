-- Durable delivery for the explicit "email me when AI subtitles are ready" opt-in.
--
-- The previous callback sent Resend inline and then updated the subscription row.
-- Overlapping callbacks could send twice, a 2xx without a provider id was treated as
-- success, stale stored addresses were used, and every provider/network failure was
-- terminal. This outbox atomically turns a ready transcript + pending opt-in into one
-- stable delivery. A leased worker freezes the exact multipart request before I/O and
-- uses delivery_key as Resend's Idempotency-Key on every retry.

create table if not exists public.catalog_subtitle_email_deliveries (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid not null unique
                  references public.catalog_generated_subtitle_notifications(id) on delete cascade,
  delivery_key text not null unique,
  user_id uuid not null references auth.users(id) on delete cascade,
  title_label text,
  source_id text,
  series_id text,
  item_type text not null,
  external_id text not null,
  kind text not null,
  lang text not null,
  status text not null default 'pending',
  attempt_count integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_attempt_at timestamptz,
  lease_token uuid,
  lease_expires_at timestamptz,
  recipient_email text,
  request_from text,
  request_reply_to text,
  request_subject text,
  request_html text,
  request_text text,
  request_tags jsonb,
  prepared_at timestamptz,
  idempotency_started_at timestamptz,
  delivery_uncertain boolean not null default false,
  quarantined_at timestamptz,
  bell_created_at timestamptz,
  sent_at timestamptz,
  dead_lettered_at timestamptz,
  last_http_status integer,
  last_error text,
  resend_email_id text,
  resend_response jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint catalog_subtitle_email_delivery_key_check
    check (delivery_key = 'norva-subtitle-ready-' || notification_id::text),
  constraint catalog_subtitle_email_delivery_status_check
    check (status in ('pending', 'processing', 'sent', 'skipped', 'dead_letter', 'cancelled')),
  constraint catalog_subtitle_email_delivery_attempt_check check (attempt_count >= 0),
  constraint catalog_subtitle_email_delivery_lease_check check (
    (status = 'processing' and lease_token is not null and lease_expires_at is not null)
    or
    (status <> 'processing' and lease_token is null and lease_expires_at is null)
  ),
  constraint catalog_subtitle_email_delivery_tags_check check (
    request_tags is null or jsonb_typeof(request_tags) = 'array'
  ),
  constraint catalog_subtitle_email_delivery_uncertain_check check (
    not delivery_uncertain or idempotency_started_at is not null
  ),
  constraint catalog_subtitle_email_delivery_quarantine_check check (
    quarantined_at is null
    or (status = 'dead_letter' and delivery_uncertain and sent_at is null)
  )
);

create index if not exists catalog_subtitle_email_delivery_ready_idx
  on public.catalog_subtitle_email_deliveries (next_attempt_at, created_at)
  where status = 'pending';
create index if not exists catalog_subtitle_email_delivery_lease_idx
  on public.catalog_subtitle_email_deliveries (lease_expires_at)
  where status = 'processing';
create index if not exists catalog_subtitle_email_delivery_dead_idx
  on public.catalog_subtitle_email_deliveries (dead_lettered_at desc)
  where status = 'dead_letter';

alter table public.catalog_subtitle_email_deliveries enable row level security;
revoke all on table public.catalog_subtitle_email_deliveries from public, anon, authenticated;
grant all on table public.catalog_subtitle_email_deliveries to service_role;

-- The legacy opt-in table predated account-deletion foreign keys. Remove only
-- provable Auth orphans, then make future account deletion cascade through both
-- the subscription and its delivery row. Without this invariant, the deletion
-- endpoint's ON DELETE CASCADE guarantee was false for subtitle notifications.
delete from public.catalog_subtitle_email_deliveries d
where not exists (
  select 1 from public.catalog_generated_subtitle_notifications n
  where n.id = d.notification_id and n.user_id = d.user_id
)
or not exists (select 1 from auth.users u where u.id = d.user_id);

delete from public.catalog_generated_subtitle_notifications n
where not exists (select 1 from auth.users u where u.id = n.user_id);

alter table public.catalog_generated_subtitle_notifications
  drop constraint if exists catalog_generated_subtitle_notifications_user_id_fkey;
alter table public.catalog_generated_subtitle_notifications
  add constraint catalog_generated_subtitle_notifications_user_id_fkey
    foreign key (user_id) references auth.users(id) on delete cascade not valid;
alter table public.catalog_generated_subtitle_notifications
  validate constraint catalog_generated_subtitle_notifications_user_id_fkey;

alter table public.catalog_subtitle_email_deliveries
  drop constraint if exists catalog_subtitle_email_deliveries_notification_id_fkey,
  drop constraint if exists catalog_subtitle_email_deliveries_user_id_fkey;
alter table public.catalog_subtitle_email_deliveries
  add constraint catalog_subtitle_email_deliveries_notification_id_fkey
    foreign key (notification_id)
      references public.catalog_generated_subtitle_notifications(id)
      on delete cascade not valid,
  add constraint catalog_subtitle_email_deliveries_user_id_fkey
    foreign key (user_id) references auth.users(id) on delete cascade not valid;
alter table public.catalog_subtitle_email_deliveries
  validate constraint catalog_subtitle_email_deliveries_notification_id_fkey;
alter table public.catalog_subtitle_email_deliveries
  validate constraint catalog_subtitle_email_deliveries_user_id_fkey;

-- Provider bodies are untrusted and can echo a recipient or credential. Keep an
-- allowlisted, bounded diagnostic shape even if an older rolling worker calls the
-- service-only RPC directly.
create or replace function public.norva_redact_subtitle_email_text(p_value text)
returns text
language sql
immutable
strict
set search_path = pg_catalog
as $$
  select left(
    regexp_replace(
      regexp_replace(
        p_value,
        '[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}',
        '[email]',
        'gi'
      ),
      '(re_|whsec_)[A-Za-z0-9_-]{12,}',
      '[credential]',
      'g'
    ),
    500
  )
$$;

create or replace function public.norva_safe_subtitle_email_provider_response(p_value jsonb)
returns jsonb
language sql
immutable
set search_path = pg_catalog, public
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'id', nullif(left(btrim(coalesce(p_value->>'id', '')), 200), ''),
    'name', public.norva_redact_subtitle_email_text(
      nullif(coalesce(p_value->>'name', p_value->>'type', p_value->>'code'), '')
    ),
    'message', public.norva_redact_subtitle_email_text(
      nullif(coalesce(p_value->>'message', p_value->>'error', p_value->>'response'), '')
    ),
    'status_code', case
      when coalesce(p_value->>'status_code', p_value->>'statusCode', '') ~ '^[0-9]{3}$'
        then (coalesce(p_value->>'status_code', p_value->>'statusCode'))::integer
      else null
    end
  ))
$$;

revoke all on function public.norva_redact_subtitle_email_text(text),
  public.norva_safe_subtitle_email_provider_response(jsonb)
  from public, anon, authenticated;

-- The old inline sender used this snapshot. The outbox intentionally resolves the
-- current Auth identity on first delivery, so retaining a duplicate address serves
-- no purpose and can route mail to an address the user has since changed.
update public.catalog_generated_subtitle_notifications
set email = ''
where email <> '';
comment on column public.catalog_generated_subtitle_notifications.email is
  'Legacy NOT NULL field; deliberately blank. Delivery resolves the current Auth email and freezes it only under an outbox lease.';

-- Atomically queue either one late opt-in or every pending subscriber matching a
-- completed exact subtitle cache row. Moving the subscription from pending to queued
-- is the duplicate barrier. The in-app bell event is created in the same transaction,
-- so a callback crash cannot leave email queued but the user uninformed in-app.
create or replace function public.queue_subtitle_ready_email_deliveries(
  p_notification_id uuid default null,
  p_provider_key text default null,
  p_item_type text default null,
  p_external_id text default null,
  p_kind text default null,
  p_lang text default null
)
returns table (
  notification_id uuid,
  delivery_id uuid,
  delivery_status text,
  user_id uuid,
  title_label text,
  source_id text,
  series_id text,
  item_type text,
  external_id text,
  kind text,
  lang text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := clock_timestamp();
begin
  if p_notification_id is null and (
    nullif(btrim(p_provider_key), '') is null
    or nullif(btrim(p_item_type), '') is null
    or nullif(btrim(p_external_id), '') is null
    or nullif(btrim(p_kind), '') is null
    or nullif(btrim(p_lang), '') is null
  ) then
    return;
  end if;

  return query
  with candidates as (
    select n.id, n.user_id, n.title_label, n.source_id, n.series_id,
           n.item_type, n.external_id, n.kind, n.lang
    from public.catalog_generated_subtitle_notifications n
    where n.status = 'pending'
      and (
        (p_notification_id is not null and n.id = p_notification_id)
        or
        (p_notification_id is null
          and n.provider_key = p_provider_key
          and n.item_type = p_item_type
          and n.external_id = p_external_id
          and n.kind = p_kind
          and n.lang = p_lang)
      )
    order by n.created_at, n.id
    for update skip locked
  ), outboxed as (
    insert into public.catalog_subtitle_email_deliveries as d (
      notification_id, delivery_key, user_id, title_label, source_id, series_id,
      item_type, external_id, kind, lang, status, bell_created_at, created_at, updated_at
    )
    select c.id, 'norva-subtitle-ready-' || c.id::text, c.user_id,
           left(c.title_label, 300), c.source_id, c.series_id,
           c.item_type, c.external_id, c.kind, c.lang, 'pending', v_now, v_now, v_now
    from candidates c
    on conflict (notification_id) do update
      set updated_at = d.updated_at
    returning d.notification_id, d.id, d.status, d.sent_at, d.bell_created_at
  ), marked as (
    update public.catalog_generated_subtitle_notifications n
    set status = case
          when o.status = 'sent' then 'sent'
          when o.status in ('skipped', 'cancelled') then 'skipped'
          when o.status = 'dead_letter' then 'failed'
          else 'queued'
        end,
        sent_at = case
          when o.status = 'sent' then coalesce(n.sent_at, o.sent_at, v_now)
          when o.status in ('skipped', 'cancelled', 'dead_letter') then coalesce(n.sent_at, v_now)
          else null
        end
    from candidates c
    join outboxed o on o.notification_id = c.id
    where n.id = c.id and n.status = 'pending'
    returning n.id, o.id as delivery_id, o.status as delivery_status, o.bell_created_at,
              n.user_id, n.title_label, n.source_id, n.series_id,
              n.item_type, n.external_id, n.kind, n.lang
  ), bell as (
    insert into public.cloud_content_events (user_id, source_id, kind, summary, payload)
    select m.user_id,
           case when m.source_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             then m.source_id::uuid else null end,
           'subtitle_ready',
           left('AI subtitles ready — ' || coalesce(nullif(m.title_label, ''), 'your title'), 300),
           jsonb_strip_nulls(jsonb_build_object(
             'itemType', m.item_type,
             'externalId', m.external_id,
             'kind', m.kind,
             'lang', m.lang,
             'watch', case
               when m.source_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                 and m.item_type = 'series'
                 and coalesce(m.series_id, '') ~ '^[A-Za-z0-9._-]+$'
                 then 'series/open:' || m.source_id || ':' || m.series_id || ':'
               when m.source_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                 and m.item_type <> 'series'
                 and m.external_id ~ '^[A-Za-z0-9._-]+$'
                 then 'movies/open:' || m.source_id || ':' || m.external_id || ':'
               else null
             end
           ))
    from marked m
    where m.bell_created_at = v_now
    returning 1
  )
  select m.id, m.delivery_id, m.delivery_status, m.user_id, m.title_label,
         m.source_id, m.series_id, m.item_type, m.external_id, m.kind, m.lang
  from marked m;
end;
$$;

revoke all on function public.queue_subtitle_ready_email_deliveries(uuid, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.queue_subtitle_ready_email_deliveries(uuid, text, text, text, text, text)
  to service_role;

-- Queue delivery inside the same transaction that makes a transcript ready. If
-- queueing fails, the ready transition fails and the gateway retries the callback.
create or replace function public.norva_queue_subtitle_email_from_cache()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.status = 'ready'
     and coalesce(new.segments, 0) > 0
     and (tg_op = 'INSERT' or old.status is distinct from new.status or old.segments is distinct from new.segments) then
    perform * from public.queue_subtitle_ready_email_deliveries(
      null, new.provider_key, new.item_type, new.external_id, new.kind, new.lang
    );
  end if;
  return new;
end;
$$;

revoke all on function public.norva_queue_subtitle_email_from_cache()
  from public, anon, authenticated;

drop trigger if exists norva_queue_subtitle_email_from_cache
  on public.catalog_generated_subtitles;
create trigger norva_queue_subtitle_email_from_cache
after insert or update of status, segments on public.catalog_generated_subtitles
for each row execute function public.norva_queue_subtitle_email_from_cache();

-- Close the late-opt-in race: a subscription inserted after the cache became ready
-- is queued in the same transaction as the opt-in instead of waiting for a callback
-- that already happened.
create or replace function public.norva_queue_subtitle_email_from_opt_in()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.status = 'pending' and exists (
    select 1
    from public.catalog_generated_subtitles s
    where s.provider_key = new.provider_key
      and s.item_type = new.item_type
      and s.external_id = new.external_id
      and s.kind = new.kind
      and s.lang = new.lang
      and s.status = 'ready'
      and coalesce(s.segments, 0) > 0
  ) then
    perform * from public.queue_subtitle_ready_email_deliveries(new.id, null, null, null, null, null);
  end if;
  return new;
end;
$$;

revoke all on function public.norva_queue_subtitle_email_from_opt_in()
  from public, anon, authenticated;

drop trigger if exists norva_queue_subtitle_email_from_opt_in
  on public.catalog_generated_subtitle_notifications;
create trigger norva_queue_subtitle_email_from_opt_in
after insert or update of status on public.catalog_generated_subtitle_notifications
for each row execute function public.norva_queue_subtitle_email_from_opt_in();

-- An explicit opt-out deletes the subscription. Cancel any not-yet-accepted delivery
-- and invalidate its lease before the row disappears.
create or replace function public.norva_cancel_subtitle_email_on_opt_out()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  update public.catalog_subtitle_email_deliveries d
  set status = 'cancelled',
      lease_token = null,
      lease_expires_at = null,
      recipient_email = null,
      request_from = null,
      request_reply_to = null,
      request_subject = null,
      request_html = null,
      request_text = null,
      request_tags = null,
      last_error = 'cancelled by user opt-out',
      updated_at = clock_timestamp()
  where d.notification_id = old.id
    and d.status in ('pending', 'processing');
  return old;
end;
$$;

revoke all on function public.norva_cancel_subtitle_email_on_opt_out()
  from public, anon, authenticated;

drop trigger if exists norva_cancel_subtitle_email_on_opt_out
  on public.catalog_generated_subtitle_notifications;
create trigger norva_cancel_subtitle_email_on_opt_out
before delete on public.catalog_generated_subtitle_notifications
for each row execute function public.norva_cancel_subtitle_email_on_opt_out();

-- A cache-ready callback and a late opt-in can cross between MVCC snapshots. Both
-- triggers cover the normal order; this bounded reconciliation makes the exact
-- crossover durable on the next worker tick without cross-table lock ordering.
create or replace function public.reconcile_subtitle_ready_email_deliveries(
  p_limit integer default 500
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  r record;
  v_applied integer;
  v_total integer := 0;
begin
  if p_limit < 1 or p_limit > 5000 then
    raise exception 'invalid subtitle email reconciliation limit';
  end if;

  for r in
    select n.id
    from public.catalog_generated_subtitle_notifications n
    join public.catalog_generated_subtitles s
      on s.provider_key = n.provider_key
     and s.item_type = n.item_type
     and s.external_id = n.external_id
     and s.kind = n.kind
     and s.lang = n.lang
    where n.status = 'pending'
      and s.status = 'ready'
      and coalesce(s.segments, 0) > 0
    order by n.created_at, n.id
    limit p_limit
  loop
    select count(*)::integer into v_applied
    from public.queue_subtitle_ready_email_deliveries(r.id, null, null, null, null, null);
    v_total := v_total + coalesce(v_applied, 0);
  end loop;
  return v_total;
end;
$$;

revoke all on function public.reconcile_subtitle_ready_email_deliveries(integer)
  from public, anon, authenticated;
grant execute on function public.reconcile_subtitle_ready_email_deliveries(integer)
  to service_role;

create or replace function public.claim_subtitle_email_deliveries(
  p_limit integer default 8,
  p_lease_seconds integer default 120,
  p_max_attempts integer default 12
)
returns table (
  delivery_id uuid,
  notification_id uuid,
  delivery_key text,
  lease_token uuid,
  user_id uuid,
  title_label text,
  source_id text,
  series_id text,
  item_type text,
  external_id text,
  kind text,
  lang text,
  attempt_count integer
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := clock_timestamp();
begin
  if p_limit < 1 or p_limit > 100
     or p_lease_seconds < 30 or p_lease_seconds > 900
     or p_max_attempts < 1 or p_max_attempts > 50 then
    raise exception 'invalid subtitle email claim limits';
  end if;

  perform public.reconcile_subtitle_ready_email_deliveries(least(5000, greatest(100, p_limit * 25)));

  -- Resend retains an idempotency key for 24 hours. An unconfirmed request that
  -- may have reached the provider must never be replayed after that guarantee
  -- expires, otherwise a delayed database acknowledgement could become a
  -- duplicate customer email. Keep a one-hour safety margin and quarantine it.
  with quarantined as (
    update public.catalog_subtitle_email_deliveries d
    set status = 'dead_letter',
        dead_lettered_at = v_now,
        quarantined_at = v_now,
        delivery_uncertain = true,
        lease_token = null,
        lease_expires_at = null,
        recipient_email = null,
        request_from = null,
        request_reply_to = null,
        request_subject = null,
        request_html = null,
        request_text = null,
        request_tags = null,
        title_label = null,
        source_id = null,
        series_id = null,
        last_error = 'idempotency_window_expired_unconfirmed',
        updated_at = v_now
    where d.status in ('pending', 'processing')
      and d.idempotency_started_at <= v_now - interval '23 hours'
      and (d.lease_expires_at is null or d.lease_expires_at <= v_now)
    returning d.notification_id
  )
  update public.catalog_generated_subtitle_notifications n
  set status = 'failed', sent_at = coalesce(n.sent_at, v_now),
      email = '', title_label = null, source_id = null, series_id = null
  from quarantined q
  where n.id = q.notification_id and n.status = 'queued';

  with exhausted as (
    update public.catalog_subtitle_email_deliveries d
    set status = 'dead_letter',
        dead_lettered_at = v_now,
        lease_token = null,
        lease_expires_at = null,
        recipient_email = null,
        request_from = null,
        request_reply_to = null,
        request_subject = null,
        request_html = null,
        request_text = null,
        request_tags = null,
        title_label = null,
        source_id = null,
        series_id = null,
        last_error = coalesce(d.last_error, 'delivery exhausted maximum attempts'),
        updated_at = v_now
    where d.attempt_count >= p_max_attempts
      and not d.delivery_uncertain
      and (d.status = 'pending' or (d.status = 'processing' and d.lease_expires_at <= v_now))
    returning d.notification_id
  )
  update public.catalog_generated_subtitle_notifications n
  set status = 'failed', sent_at = coalesce(n.sent_at, v_now),
      email = '', title_label = null, source_id = null, series_id = null
  from exhausted e
  where n.id = e.notification_id and n.status = 'queued';

  return query
  with candidates as (
    select d.id
    from public.catalog_subtitle_email_deliveries d
    where (d.attempt_count < p_max_attempts or d.delivery_uncertain)
      and (d.idempotency_started_at is null
        or d.idempotency_started_at > v_now - interval '23 hours')
      and (
        (d.status = 'pending' and d.next_attempt_at <= v_now)
        or
        (d.status = 'processing' and d.lease_expires_at <= v_now)
      )
    order by d.next_attempt_at, d.created_at, d.id
    for update skip locked
    limit p_limit
  ), claimed as (
    update public.catalog_subtitle_email_deliveries d
    set status = 'processing',
        lease_token = gen_random_uuid(),
        lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
        attempt_count = d.attempt_count + 1,
        last_attempt_at = v_now,
        updated_at = v_now
    from candidates c
    where d.id = c.id
    returning d.id, d.notification_id, d.delivery_key, d.lease_token,
              d.user_id, d.title_label, d.source_id, d.series_id,
              d.item_type, d.external_id, d.kind, d.lang, d.attempt_count
  )
  select c.id, c.notification_id, c.delivery_key, c.lease_token,
         c.user_id, c.title_label, c.source_id, c.series_id,
         c.item_type, c.external_id, c.kind, c.lang, c.attempt_count
  from claimed c;
end;
$$;

revoke all on function public.claim_subtitle_email_deliveries(integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_subtitle_email_deliveries(integer, integer, integer)
  to service_role;

create or replace function public.prepare_subtitle_email_delivery(
  p_delivery_id uuid,
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
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := clock_timestamp();
begin
  if nullif(lower(btrim(p_recipient_email)), '') is null
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
     or p_request_tags is null
     or jsonb_typeof(p_request_tags) <> 'array'
     or jsonb_array_length(p_request_tags) < 1
     or jsonb_array_length(p_request_tags) > 10
     or exists (
       select 1 from jsonb_array_elements(p_request_tags) tag
       where jsonb_typeof(tag) <> 'object'
          or coalesce(tag->>'name', '') !~ '^[A-Za-z0-9_-]{1,256}$'
          or coalesce(tag->>'value', '') !~ '^[A-Za-z0-9_-]{1,256}$'
     ) then
    return;
  end if;

  update public.catalog_subtitle_email_deliveries d
  set recipient_email = coalesce(d.recipient_email, lower(btrim(p_recipient_email))),
      request_from = coalesce(d.request_from, btrim(p_request_from)),
      request_reply_to = coalesce(d.request_reply_to, lower(btrim(p_request_reply_to))),
      request_subject = coalesce(d.request_subject, p_request_subject),
      request_html = coalesce(d.request_html, p_request_html),
      request_text = coalesce(d.request_text, p_request_text),
      request_tags = coalesce(d.request_tags, p_request_tags),
      prepared_at = coalesce(d.prepared_at, v_now),
      updated_at = v_now
  where d.id = p_delivery_id
    and d.status = 'processing'
    and d.lease_token = p_lease_token
    and d.lease_expires_at > v_now;

  return query
  select d.recipient_email, d.request_from, d.request_reply_to,
         d.request_subject, d.request_html, d.request_text, d.request_tags
  from public.catalog_subtitle_email_deliveries d
  where d.id = p_delivery_id
    and d.status = 'processing'
    and d.lease_token = p_lease_token
    and d.lease_expires_at > v_now
    and d.recipient_email is not null
    and d.request_from is not null
    and d.request_reply_to is not null
    and d.request_subject is not null
    and d.request_html is not null
    and d.request_text is not null
    and d.request_tags is not null;
end;
$$;

revoke all on function public.prepare_subtitle_email_delivery(uuid, uuid, text, text, text, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.prepare_subtitle_email_delivery(uuid, uuid, text, text, text, text, text, text, jsonb)
  to service_role;

-- Start the provider-idempotency clock immediately before external I/O, never
-- when a row is merely claimed or rendered. A crashed worker therefore cannot
-- quarantine a request that it provably never attempted.
create or replace function public.authorize_subtitle_email_delivery(
  p_delivery_id uuid,
  p_lease_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_started_at timestamptz;
begin
  update public.catalog_subtitle_email_deliveries d
  set idempotency_started_at = coalesce(d.idempotency_started_at, clock_timestamp()),
      updated_at = clock_timestamp()
  where d.id = p_delivery_id
    and d.status = 'processing'
    and d.lease_token = p_lease_token
    and d.lease_expires_at > clock_timestamp()
    and d.recipient_email is not null
    and d.request_from is not null
    and d.request_reply_to is not null
    and d.request_subject is not null
    and d.request_html is not null
    and d.request_text is not null
    and d.request_tags is not null
    and (d.idempotency_started_at is null
      or d.idempotency_started_at > clock_timestamp() - interval '23 hours')
  returning d.idempotency_started_at into v_started_at;
  return v_started_at is not null;
end;
$$;

revoke all on function public.authorize_subtitle_email_delivery(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.authorize_subtitle_email_delivery(uuid, uuid)
  to service_role;

create or replace function public.complete_subtitle_email_delivery(
  p_delivery_id uuid,
  p_lease_token uuid,
  p_http_status integer,
  p_resend_email_id text,
  p_response jsonb default null
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_notification_id uuid;
  v_now timestamptz := clock_timestamp();
begin
  if p_http_status not between 200 and 299
     or nullif(btrim(p_resend_email_id), '') is null then
    return false;
  end if;

  update public.catalog_subtitle_email_deliveries d
  set status = 'sent', sent_at = v_now,
      last_http_status = p_http_status,
      resend_email_id = btrim(p_resend_email_id),
      resend_response = public.norva_safe_subtitle_email_provider_response(
        coalesce(p_response, '{}'::jsonb)
      ),
      recipient_email = null,
      request_from = null,
      request_reply_to = null,
      request_subject = null,
      request_html = null,
      request_text = null,
      request_tags = null,
      title_label = null,
      source_id = null,
      series_id = null,
      last_error = null,
      dead_lettered_at = null,
      quarantined_at = null,
      delivery_uncertain = false,
      lease_token = null,
      lease_expires_at = null,
      updated_at = v_now
  where d.id = p_delivery_id
    and d.status = 'processing'
    and d.lease_token = p_lease_token
    and d.lease_expires_at > v_now
    and d.recipient_email is not null
    and d.request_from is not null
    and d.request_reply_to is not null
    and d.request_subject is not null
    and d.request_html is not null
    and d.request_text is not null
    and d.request_tags is not null
  returning d.notification_id into v_notification_id;

  if v_notification_id is null then return false; end if;

  update public.catalog_generated_subtitle_notifications n
  set status = 'sent', sent_at = v_now,
      email = '', title_label = null, source_id = null, series_id = null
  where n.id = v_notification_id and n.status = 'queued';
  return true;
end;
$$;

revoke all on function public.complete_subtitle_email_delivery(uuid, uuid, integer, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.complete_subtitle_email_delivery(uuid, uuid, integer, text, jsonb)
  to service_role;

create or replace function public.fail_subtitle_email_delivery(
  p_delivery_id uuid,
  p_lease_token uuid,
  p_retryable boolean,
  p_http_status integer default null,
  p_response jsonb default null,
  p_error text default null,
  p_retry_after_seconds integer default null,
  p_max_attempts integer default 12,
  p_base_backoff_seconds integer default 60,
  p_max_backoff_seconds integer default 21600,
  p_ambiguous boolean default false
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_notification_id uuid;
  v_attempt integer;
  v_was_uncertain boolean;
  v_terminal boolean;
  v_delay integer;
  v_now timestamptz := clock_timestamp();
begin
  if p_max_attempts < 1 or p_max_attempts > 50
     or p_base_backoff_seconds < 1 or p_base_backoff_seconds > 3600
     or p_max_backoff_seconds < p_base_backoff_seconds or p_max_backoff_seconds > 86400 then
    return 'stale_or_invalid';
  end if;

  select d.notification_id, d.attempt_count, d.delivery_uncertain
  into v_notification_id, v_attempt, v_was_uncertain
  from public.catalog_subtitle_email_deliveries d
  where d.id = p_delivery_id
    and d.status = 'processing'
    and d.lease_token = p_lease_token
    and d.lease_expires_at > v_now
  for update;

  if v_notification_id is null then return 'stale_or_invalid'; end if;

  v_was_uncertain := coalesce(v_was_uncertain, false) or coalesce(p_ambiguous, false);
  v_terminal := not coalesce(p_retryable, false)
    or (not v_was_uncertain and v_attempt >= p_max_attempts);
  v_delay := least(
    p_max_backoff_seconds::numeric,
    greatest(
      coalesce(greatest(p_retry_after_seconds, 0), 0)::numeric,
      floor(p_base_backoff_seconds * power(2::numeric, greatest(v_attempt - 1, 0)))
        + mod(
            abs(hashtextextended(p_delivery_id::text || ':' || v_attempt::text, 0)::numeric),
            greatest(p_base_backoff_seconds, 1)
          )
    )
  )::integer;

  update public.catalog_subtitle_email_deliveries d
  set status = case when v_terminal then 'dead_letter' else 'pending' end,
      next_attempt_at = case when v_terminal then v_now else v_now + make_interval(secs => v_delay) end,
      last_http_status = p_http_status,
      resend_response = public.norva_safe_subtitle_email_provider_response(
        coalesce(p_response, '{}'::jsonb)
      ),
      last_error = public.norva_redact_subtitle_email_text(
        coalesce(nullif(p_error, ''), 'subtitle email delivery failed')
      ),
      dead_lettered_at = case when v_terminal then v_now else null end,
      delivery_uncertain = v_was_uncertain,
      recipient_email = case when v_terminal then null else d.recipient_email end,
      request_from = case when v_terminal then null else d.request_from end,
      request_reply_to = case when v_terminal then null else d.request_reply_to end,
      request_subject = case when v_terminal then null else d.request_subject end,
      request_html = case when v_terminal then null else d.request_html end,
      request_text = case when v_terminal then null else d.request_text end,
      request_tags = case when v_terminal then null else d.request_tags end,
      title_label = case when v_terminal then null else d.title_label end,
      source_id = case when v_terminal then null else d.source_id end,
      series_id = case when v_terminal then null else d.series_id end,
      lease_token = null,
      lease_expires_at = null,
      updated_at = v_now
  where d.id = p_delivery_id
    and d.status = 'processing'
    and d.lease_token = p_lease_token
    and d.lease_expires_at > v_now;

  if v_terminal then
    update public.catalog_generated_subtitle_notifications n
    set status = 'failed', sent_at = coalesce(n.sent_at, v_now),
        email = '', title_label = null, source_id = null, series_id = null
    where n.id = v_notification_id and n.status = 'queued';
    return 'dead_letter';
  end if;
  return 'retry_scheduled';
end;
$$;

revoke all on function public.fail_subtitle_email_delivery(uuid, uuid, boolean, integer, jsonb, text, integer, integer, integer, integer, boolean)
  from public, anon, authenticated;
grant execute on function public.fail_subtitle_email_delivery(uuid, uuid, boolean, integer, jsonb, text, integer, integer, integer, integer, boolean)
  to service_role;

create or replace function public.skip_subtitle_email_delivery(
  p_delivery_id uuid,
  p_lease_token uuid,
  p_reason text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_notification_id uuid;
  v_now timestamptz := clock_timestamp();
begin
  update public.catalog_subtitle_email_deliveries d
  set status = 'skipped', sent_at = v_now,
      last_error = left(coalesce(nullif(p_reason, ''), 'delivery skipped'), 2000),
      recipient_email = null,
      request_from = null,
      request_reply_to = null,
      request_subject = null,
      request_html = null,
      request_text = null,
      request_tags = null,
      title_label = null,
      source_id = null,
      series_id = null,
      lease_token = null,
      lease_expires_at = null,
      updated_at = v_now
  where d.id = p_delivery_id
    and d.status = 'processing'
    and d.lease_token = p_lease_token
    and d.lease_expires_at > v_now
  returning d.notification_id into v_notification_id;

  if v_notification_id is null then return false; end if;
  update public.catalog_generated_subtitle_notifications n
  set status = 'skipped', sent_at = coalesce(n.sent_at, v_now),
      email = '', title_label = null, source_id = null, series_id = null
  where n.id = v_notification_id and n.status = 'queued';
  return true;
end;
$$;

revoke all on function public.skip_subtitle_email_delivery(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.skip_subtitle_email_delivery(uuid, uuid, text)
  to service_role;

-- Reconcile late-ready rows that predate this migration. No external request is
-- performed here; only durable queue rows and bell events are created.
do $$
declare
  r record;
begin
  for r in
    select distinct n.provider_key, n.item_type, n.external_id, n.kind, n.lang
    from public.catalog_generated_subtitle_notifications n
    join public.catalog_generated_subtitles s
      on s.provider_key = n.provider_key
     and s.item_type = n.item_type
     and s.external_id = n.external_id
     and s.kind = n.kind
     and s.lang = n.lang
    where n.status = 'pending' and s.status = 'ready' and coalesce(s.segments, 0) > 0
  loop
    perform * from public.queue_subtitle_ready_email_deliveries(
      null, r.provider_key, r.item_type, r.external_id, r.kind, r.lang
    );
  end loop;
end $$;

-- Two-minute retry worker plus bounded terminal retention. The endpoint verifies
-- norva_cron_shared_secret itself; verify_jwt remains disabled for norva-playback.
do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'cron' and p.proname = 'schedule'
  ) and exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'net' and p.proname = 'http_post'
  ) then
    perform cron.schedule('norva-subtitle-email-delivery', '*/2 * * * *', $job$
      select net.http_post(
        url := 'https://api.norva.tv/functions/v1/norva-playback/subtitle-email-delivery',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || (
            select decrypted_secret from vault.decrypted_secrets
            where name = 'norva_cron_shared_secret' limit 1
          )
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 60000
      );
    $job$);

    perform cron.schedule('norva-subtitle-email-delivery-prune', '45 3 * * *', $job$
      delete from public.catalog_subtitle_email_deliveries
      where status in ('sent', 'skipped', 'dead_letter', 'cancelled')
        and updated_at < now() - interval '30 days';
    $job$);
  end if;
end $$;
