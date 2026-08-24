-- Phases 11-14: durable Provider Access notification outbox.
-- Scheduling is cycle-scoped; network delivery is channel-scoped and remains
-- disabled until its dedicated flag is enabled. No recipient, provider URL,
-- username, password or token is persisted in this table.

insert into public.admin_feature_flags (key, enabled, description, updated_at, updated_by)
values
  ('provider_access_email_v1_enabled', false, 'Provider Access transactional email delivery', now(), 'migration:provider_access_notifications_v1'),
  ('provider_access_push_v1_enabled', false, 'Provider Access FCM delivery', now(), 'migration:provider_access_notifications_v1'),
  ('provider_access_in_app_v1_enabled', false, 'Provider Access in-app notification visibility', now(), 'migration:provider_access_notifications_v1')
on conflict (key) do update
set enabled = false,
    description = excluded.description,
    updated_at = excluded.updated_at,
    updated_by = excluded.updated_by;

create table public.cloud_provider_access_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  source_id uuid not null,
  access_cycle_id uuid not null,
  event_kind text not null check (event_kind in (
    'expiry_7d','expiry_1d','expiry_today','access_hidden','access_restored'
  )),
  channel text not null check (channel in ('email','push','in_app')),
  state text not null default 'pending' check (state in (
    'pending','processing','available','delivered','dismissed','superseded','dead_letter'
  )),
  scheduled_at timestamptz not null,
  delivery_key text not null unique check (
    delivery_key ~ '^norva-provider-access-[0-9a-f-]{36}$'
  ),
  lease_owner text check (
    lease_owner is null or (btrim(lease_owner) <> '' and length(lease_owner) <= 200)
  ),
  lease_sequence bigint not null default 0 check (lease_sequence >= 0),
  lease_expires_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count between 0 and 20),
  next_attempt_at timestamptz not null,
  transport_started_at timestamptz,
  last_attempt_at timestamptz,
  last_error_code text check (
    last_error_code is null or last_error_code ~ '^[A-Z][A-Z0-9_]{1,119}$'
  ),
  completion_code text check (
    completion_code is null or completion_code in (
      'RESEND_ACCEPTED','FCM_ACCEPTED','NO_REGISTERED_TOKEN','IN_APP_DISMISSED'
    )
  ),
  provider_message_id text check (
    provider_message_id is null or (
      btrim(provider_message_id) <> '' and length(provider_message_id) <= 240
    )
  ),
  delivered_at timestamptz,
  dismissed_at timestamptz,
  superseded_at timestamptz,
  dead_lettered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (access_cycle_id, event_kind, channel),
  constraint cloud_provider_access_notifications_source_owner_fk
    foreign key (user_id, source_id)
    references public.cloud_sources(user_id, id)
    on update cascade on delete cascade,
  constraint cloud_provider_access_notifications_cycle_owner_fk
    foreign key (user_id, access_cycle_id)
    references public.cloud_source_access_cycles(user_id, id)
    on update cascade on delete cascade,
  constraint cloud_provider_access_notifications_state_channel_ck check (
    (channel = 'in_app' and state in ('available','dismissed','superseded'))
    or (channel in ('email','push') and state in (
      'pending','processing','delivered','superseded','dead_letter'
    ))
  ),
  constraint cloud_provider_access_notifications_lease_ck check (
    (state = 'processing' and lease_owner is not null and lease_expires_at is not null)
    or (state <> 'processing' and lease_owner is null and lease_expires_at is null)
  ),
  constraint cloud_provider_access_notifications_terminal_ck check (
    (state = 'delivered' and delivered_at is not null and completion_code is not null
      and dismissed_at is null and superseded_at is null and dead_lettered_at is null)
    or (state = 'dismissed' and dismissed_at is not null
      and completion_code = 'IN_APP_DISMISSED' and delivered_at is null
      and superseded_at is null and dead_lettered_at is null)
    or (state = 'superseded' and superseded_at is not null
      and delivered_at is null and dismissed_at is null and dead_lettered_at is null)
    or (state = 'dead_letter' and dead_lettered_at is not null
      and delivered_at is null and dismissed_at is null and superseded_at is null)
    or (state in ('pending','processing','available')
      and delivered_at is null and dismissed_at is null
      and superseded_at is null and dead_lettered_at is null
      and completion_code is null)
  )
);

create index cloud_provider_access_notifications_due_idx
  on public.cloud_provider_access_notifications (channel, next_attempt_at, created_at, id)
  where state = 'pending';
create index cloud_provider_access_notifications_lease_idx
  on public.cloud_provider_access_notifications (lease_expires_at, id)
  where state = 'processing';
create index cloud_provider_access_notifications_user_in_app_idx
  on public.cloud_provider_access_notifications (user_id, scheduled_at desc, id desc)
  where channel = 'in_app' and state = 'available';
create index cloud_provider_access_notifications_cycle_state_idx
  on public.cloud_provider_access_notifications (access_cycle_id, state, channel);

alter table public.cloud_provider_access_notifications enable row level security;
revoke all on table public.cloud_provider_access_notifications
  from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.cloud_provider_access_notifications
  to service_role;

comment on table public.cloud_provider_access_notifications is
  'Cycle-scoped Provider Access outbox. Contains only stable Norva identifiers, event kind and delivery state; recipients and provider credentials are never stored here.';

create or replace function public.norva_provider_access_notification_flag_required(
  p_channel text default null
) returns void
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_channel_key text;
begin
  perform public.norva_provider_access_service_role_required();
  if not coalesce(public.feature_flag('provider_access_notifications_v1_enabled'), false) then
    raise exception 'Provider Access notifications disabled'
      using errcode = '55000', detail = 'reason=feature_disabled';
  end if;
  if p_channel is null then return; end if;
  v_channel_key := case p_channel
    when 'email' then 'provider_access_email_v1_enabled'
    when 'push' then 'provider_access_push_v1_enabled'
    when 'in_app' then 'provider_access_in_app_v1_enabled'
    else null
  end;
  if v_channel_key is null or not coalesce(public.feature_flag(v_channel_key), false) then
    raise exception 'Provider Access notification channel disabled'
      using errcode = '55000', detail = 'reason=channel_disabled';
  end if;
end
$function$;

create or replace function public.norva_enqueue_provider_access_notification_set(
  p_user_id uuid,
  p_source_id uuid,
  p_access_cycle_id uuid,
  p_event_kind text,
  p_scheduled_at timestamptz
) returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_inserted integer := 0;
begin
  if p_user_id is null or p_source_id is null or p_access_cycle_id is null
     or p_event_kind not in ('expiry_7d','expiry_1d','expiry_today','access_hidden','access_restored')
     or p_scheduled_at is null then
    raise exception 'invalid Provider Access notification event' using errcode = '22023';
  end if;

  insert into public.cloud_provider_access_notifications (
    id, user_id, source_id, access_cycle_id, event_kind, channel, state,
    scheduled_at, delivery_key, next_attempt_at
  )
  select generated.id, p_user_id, p_source_id, p_access_cycle_id, p_event_kind,
    generated.channel,
    case when generated.channel = 'in_app' then 'available' else 'pending' end,
    p_scheduled_at,
    'norva-provider-access-' || generated.id::text,
    p_scheduled_at
  from (
    select gen_random_uuid() as id, channel
    from unnest(array['email','push','in_app']::text[]) as channels(channel)
  ) generated
  on conflict (access_cycle_id, event_kind, channel) do nothing;
  get diagnostics v_inserted = row_count;
  return v_inserted;
end
$function$;

create or replace function public.norva_schedule_provider_access_notifications(
  p_now timestamptz default now(),
  p_limit integer default 500
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_event record;
  v_events integer := 0;
  v_rows integer := 0;
begin
  perform public.norva_provider_access_notification_flag_required(null);
  if p_now is null or p_limit is null or p_limit < 1 or p_limit > 2000 then
    raise exception 'invalid Provider Access notification scheduling bound' using errcode = '22023';
  end if;

  -- Revoke every non-terminal notification whose cycle or source is no longer
  -- eligible before creating new work. A processing lease is never authority.
  update public.cloud_provider_access_notifications notification
  set state = 'superseded', lease_owner = null, lease_expires_at = null,
      superseded_at = p_now, last_error_code = 'BUSINESS_STATE_SUPERSEDED',
      updated_at = p_now
  where notification.state in ('pending','processing','available')
    and not exists (
      select 1
      from public.cloud_source_access_cycles cycle
      join public.cloud_source_provider_access access
        on access.user_id = cycle.user_id and access.source_id = cycle.source_id
      join public.cloud_sources source
        on source.user_id = cycle.user_id and source.id = cycle.source_id
      join public.cloud_source_lifecycle lifecycle
        on lifecycle.user_id = source.user_id and lifecycle.source_id = source.id
      where cycle.user_id = notification.user_id
        and cycle.id = notification.access_cycle_id
        and cycle.status = 'active'
        and access.provider_access_reminders_enabled
        and source.deleted_at is null
        and lifecycle.lifecycle_state = 'active'
    );

  for v_event in
    select cycle.user_id, cycle.source_id, cycle.id as access_cycle_id,
      reminder.event_kind,
      (reminder.target_date + time '09:00') at time zone 'UTC' as scheduled_at
    from public.cloud_source_access_cycles cycle
    join public.cloud_source_provider_access access
      on access.user_id = cycle.user_id and access.source_id = cycle.source_id
    join public.cloud_sources source
      on source.user_id = cycle.user_id and source.id = cycle.source_id
    join public.cloud_source_lifecycle lifecycle
      on lifecycle.user_id = source.user_id and lifecycle.source_id = source.id
    cross join lateral (
      values
        ('expiry_7d'::text, cycle.expires_on - 7),
        ('expiry_1d'::text, cycle.expires_on - 1),
        ('expiry_today'::text, cycle.expires_on)
    ) reminder(event_kind, target_date)
    where cycle.status = 'active'
      and cycle.expires_on is not null
      and access.provider_access_reminders_enabled
      and source.deleted_at is null
      and lifecycle.lifecycle_state = 'active'
      and reminder.target_date = (p_now at time zone 'UTC')::date
    order by cycle.id, reminder.event_kind
    limit p_limit
  loop
    v_events := v_events + 1;
    v_rows := v_rows + public.norva_enqueue_provider_access_notification_set(
      v_event.user_id, v_event.source_id, v_event.access_cycle_id,
      v_event.event_kind, v_event.scheduled_at
    );
  end loop;
  return jsonb_build_object('events', v_events, 'rowsInserted', v_rows, 'limit', p_limit);
end
$function$;

create or replace function public.norva_provider_access_event_notification_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_cycle public.cloud_source_access_cycles%rowtype;
begin
  if new.event_kind not in ('provider_access_hidden','provider_access_restored')
     or new.access_cycle_id is null
     or not coalesce(public.feature_flag('provider_access_notifications_v1_enabled'), false) then
    return new;
  end if;
  select cycle.* into v_cycle
  from public.cloud_source_access_cycles cycle
  join public.cloud_source_provider_access access
    on access.user_id = cycle.user_id and access.source_id = cycle.source_id
  where cycle.user_id = new.user_id and cycle.id = new.access_cycle_id
    and cycle.status = 'active' and access.provider_access_reminders_enabled;
  if not found then return new; end if;
  perform public.norva_enqueue_provider_access_notification_set(
    new.user_id, new.source_id, new.access_cycle_id,
    case new.event_kind
      when 'provider_access_hidden' then 'access_hidden'
      else 'access_restored'
    end,
    new.occurred_at
  );
  return new;
end
$function$;

create trigger cloud_source_lifecycle_events_provider_access_notify
after insert on public.cloud_source_lifecycle_events
for each row execute function public.norva_provider_access_event_notification_trigger();

create or replace function public.norva_supersede_provider_access_notifications_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid;
  v_source_id uuid;
  v_cycle_id uuid;
  v_supersede boolean := false;
begin
  if tg_table_name = 'cloud_source_access_cycles' then
    v_user_id := new.user_id; v_source_id := new.source_id; v_cycle_id := new.id;
    v_supersede := new.status <> 'active';
  elsif tg_table_name = 'cloud_source_provider_access' then
    v_user_id := new.user_id; v_source_id := new.source_id;
    v_supersede := not new.provider_access_reminders_enabled;
  elsif tg_table_name = 'cloud_sources' then
    v_user_id := new.user_id; v_source_id := new.id;
    v_supersede := new.deleted_at is not null;
  elsif tg_table_name = 'cloud_source_lifecycle' then
    v_user_id := new.user_id; v_source_id := new.source_id;
    v_supersede := new.lifecycle_state <> 'active';
  end if;
  if v_supersede then
    update public.cloud_provider_access_notifications notification
    set state = 'superseded', lease_owner = null, lease_expires_at = null,
        superseded_at = clock_timestamp(), last_error_code = 'BUSINESS_STATE_SUPERSEDED',
        updated_at = clock_timestamp()
    where notification.user_id = v_user_id
      and notification.source_id = v_source_id
      and (v_cycle_id is null or notification.access_cycle_id = v_cycle_id)
      and notification.state in ('pending','processing','available');
  end if;
  return new;
end
$function$;

create trigger cloud_source_access_cycles_supersede_notifications
after update of status on public.cloud_source_access_cycles
for each row when (old.status is distinct from new.status)
execute function public.norva_supersede_provider_access_notifications_trigger();

create trigger cloud_source_provider_access_supersede_notifications
after update of provider_access_reminders_enabled on public.cloud_source_provider_access
for each row when (old.provider_access_reminders_enabled is distinct from new.provider_access_reminders_enabled)
execute function public.norva_supersede_provider_access_notifications_trigger();

create trigger cloud_sources_supersede_provider_access_notifications
after update of deleted_at on public.cloud_sources
for each row when (old.deleted_at is distinct from new.deleted_at)
execute function public.norva_supersede_provider_access_notifications_trigger();

create trigger cloud_source_lifecycle_supersede_provider_access_notifications
after update of lifecycle_state on public.cloud_source_lifecycle
for each row when (old.lifecycle_state is distinct from new.lifecycle_state)
execute function public.norva_supersede_provider_access_notifications_trigger();

create or replace function public.norva_claim_provider_access_notifications(
  p_channel text,
  p_worker text,
  p_limit integer default 4,
  p_lease_seconds integer default 90,
  p_max_attempts integer default 12
) returns table (
  notification_id uuid,
  delivery_key text,
  lease_sequence bigint,
  user_id uuid,
  source_id uuid,
  access_cycle_id uuid,
  event_kind text,
  source_name text,
  expires_on date,
  attempt_count integer
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform public.norva_provider_access_notification_flag_required(p_channel);
  if p_channel not in ('email','push')
     or p_worker is null or btrim(p_worker) = '' or length(p_worker) > 200
     or p_limit is null or p_limit < 1 or p_limit > 20
     or p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 300
     or p_max_attempts is null or p_max_attempts < 1 or p_max_attempts > 20 then
    raise exception 'invalid Provider Access notification claim' using errcode = '22023';
  end if;

  update public.cloud_provider_access_notifications notification
  set state = 'dead_letter', lease_owner = null, lease_expires_at = null,
      dead_lettered_at = now(), last_error_code = 'IDEMPOTENCY_WINDOW_EXPIRED',
      updated_at = now()
  where notification.channel = p_channel
    and notification.state in ('pending','processing')
    and notification.transport_started_at is not null
    and notification.transport_started_at <= now() - interval '23 hours';

  update public.cloud_provider_access_notifications notification
  set state = 'pending', lease_owner = null, lease_expires_at = null,
      next_attempt_at = now(), last_error_code = 'LEASE_EXPIRED', updated_at = now()
  where notification.channel = p_channel and notification.state = 'processing'
    and notification.lease_expires_at <= now()
    and notification.attempt_count < p_max_attempts;

  update public.cloud_provider_access_notifications notification
  set state = 'dead_letter', lease_owner = null, lease_expires_at = null,
      dead_lettered_at = now(), last_error_code = 'MAX_ATTEMPTS_EXCEEDED', updated_at = now()
  where notification.channel = p_channel and notification.state in ('pending','processing')
    and notification.attempt_count >= p_max_attempts;

  return query
  with candidates as materialized (
    select notification.id
    from public.cloud_provider_access_notifications notification
    join public.cloud_source_access_cycles cycle
      on cycle.user_id = notification.user_id and cycle.id = notification.access_cycle_id
    join public.cloud_source_provider_access access
      on access.user_id = notification.user_id and access.source_id = notification.source_id
    join public.cloud_sources source
      on source.user_id = notification.user_id and source.id = notification.source_id
    join public.cloud_source_lifecycle lifecycle
      on lifecycle.user_id = source.user_id and lifecycle.source_id = source.id
    where notification.channel = p_channel and notification.state = 'pending'
      and notification.next_attempt_at <= now()
      and cycle.status = 'active' and access.provider_access_reminders_enabled
      and source.deleted_at is null and lifecycle.lifecycle_state = 'active'
    order by notification.next_attempt_at, notification.created_at, notification.id
    for update of notification skip locked
    limit p_limit
  ), claimed as (
    update public.cloud_provider_access_notifications notification
    set state = 'processing', lease_owner = p_worker,
        lease_sequence = notification.lease_sequence + 1,
        lease_expires_at = now() + make_interval(secs => p_lease_seconds),
        attempt_count = notification.attempt_count + 1,
        last_attempt_at = now(), last_error_code = null, updated_at = now()
    from candidates
    where notification.id = candidates.id
    returning notification.*
  )
  select claimed.id, claimed.delivery_key, claimed.lease_sequence,
    claimed.user_id, claimed.source_id, claimed.access_cycle_id,
    claimed.event_kind, left(coalesce(source.display_name, 'TV service'), 120),
    cycle.expires_on, claimed.attempt_count
  from claimed
  join public.cloud_sources source
    on source.user_id = claimed.user_id and source.id = claimed.source_id
  join public.cloud_source_access_cycles cycle
    on cycle.user_id = claimed.user_id and cycle.id = claimed.access_cycle_id
  order by claimed.next_attempt_at, claimed.created_at, claimed.id;
end
$function$;

create or replace function public.norva_authorize_provider_access_notification(
  p_notification_id uuid,
  p_channel text,
  p_worker text,
  p_expected_lease_sequence bigint,
  p_expected_recipient_email text default null
) returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_notification public.cloud_provider_access_notifications%rowtype;
  v_current_email text;
  v_eligible boolean;
begin
  perform public.norva_provider_access_notification_flag_required(p_channel);
  select notification.* into v_notification
  from public.cloud_provider_access_notifications notification
  where notification.id = p_notification_id
    and notification.channel = p_channel
    and notification.state = 'processing'
    and notification.lease_owner = p_worker
    and notification.lease_sequence = p_expected_lease_sequence
    and notification.lease_expires_at > now()
  for update;
  if not found then return false; end if;

  select lower(btrim(users.email)) into v_current_email
  from auth.users users where users.id = v_notification.user_id;
  select exists (
    select 1
    from public.cloud_source_access_cycles cycle
    join public.cloud_source_provider_access access
      on access.user_id = cycle.user_id and access.source_id = cycle.source_id
    join public.cloud_sources source
      on source.user_id = cycle.user_id and source.id = cycle.source_id
    join public.cloud_source_lifecycle lifecycle
      on lifecycle.user_id = source.user_id and lifecycle.source_id = source.id
    where cycle.user_id = v_notification.user_id
      and cycle.id = v_notification.access_cycle_id
      and cycle.status = 'active' and access.provider_access_reminders_enabled
      and source.deleted_at is null and lifecycle.lifecycle_state = 'active'
  ) into v_eligible;

  if p_channel = 'email' and v_eligible and v_current_email is not null
     and lower(btrim(coalesce(p_expected_recipient_email, ''))) <> v_current_email then
    -- Auth email changed between lookup and the final CAS. Requeue without
    -- starting the Resend idempotency window; the next claim resolves the new
    -- current address.
    update public.cloud_provider_access_notifications notification
    set state = 'pending', lease_owner = null, lease_expires_at = null,
        next_attempt_at = now(), last_error_code = 'RECIPIENT_CHANGED',
        updated_at = now()
    where notification.id = v_notification.id
      and notification.state = 'processing'
      and notification.lease_sequence = p_expected_lease_sequence;
    return false;
  end if;

  if not v_eligible or (p_channel = 'email' and v_current_email is null)
     or (p_channel = 'push' and p_expected_recipient_email is not null) then
    update public.cloud_provider_access_notifications notification
    set state = 'superseded', lease_owner = null, lease_expires_at = null,
        superseded_at = now(), last_error_code = 'FINAL_AUTHORIZATION_REJECTED',
        updated_at = now()
    where notification.id = v_notification.id
      and notification.state = 'processing'
      and notification.lease_sequence = p_expected_lease_sequence;
    return false;
  end if;

  update public.cloud_provider_access_notifications notification
  set transport_started_at = coalesce(notification.transport_started_at, now()),
      updated_at = now()
  where notification.id = v_notification.id
    and notification.state = 'processing'
    and notification.lease_owner = p_worker
    and notification.lease_sequence = p_expected_lease_sequence;
  return found;
end
$function$;

create or replace function public.norva_complete_provider_access_notification(
  p_notification_id uuid,
  p_channel text,
  p_worker text,
  p_expected_lease_sequence bigint,
  p_completion_code text,
  p_provider_message_id text default null
) returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform public.norva_provider_access_notification_flag_required(p_channel);
  if (p_channel = 'email' and p_completion_code <> 'RESEND_ACCEPTED')
     or (p_channel = 'push' and p_completion_code not in ('FCM_ACCEPTED','NO_REGISTERED_TOKEN'))
     or (p_completion_code in ('RESEND_ACCEPTED','FCM_ACCEPTED')
       and nullif(btrim(coalesce(p_provider_message_id, '')), '') is null)
     or length(coalesce(p_provider_message_id, '')) > 240 then
    raise exception 'invalid Provider Access notification completion' using errcode = '22023';
  end if;
  update public.cloud_provider_access_notifications notification
  set state = 'delivered', lease_owner = null, lease_expires_at = null,
      completion_code = p_completion_code,
      provider_message_id = nullif(left(btrim(coalesce(p_provider_message_id, '')), 240), ''),
      delivered_at = now(), last_error_code = null, updated_at = now()
  where notification.id = p_notification_id and notification.channel = p_channel
    and notification.state = 'processing' and notification.lease_owner = p_worker
    and notification.lease_sequence = p_expected_lease_sequence
    and notification.transport_started_at is not null;
  return found;
end
$function$;

create or replace function public.norva_fail_provider_access_notification(
  p_notification_id uuid,
  p_channel text,
  p_worker text,
  p_expected_lease_sequence bigint,
  p_error_code text,
  p_retryable boolean,
  p_retry_after_seconds integer default null,
  p_max_attempts integer default 12
) returns text
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_notification public.cloud_provider_access_notifications%rowtype;
  v_terminal boolean;
  v_delay integer;
begin
  perform public.norva_provider_access_notification_flag_required(p_channel);
  if p_error_code is null or p_error_code !~ '^[A-Z][A-Z0-9_]{1,119}$'
     or p_retryable is null
     or p_retry_after_seconds is not null and (p_retry_after_seconds < 0 or p_retry_after_seconds > 21600)
     or p_max_attempts is null or p_max_attempts < 1 or p_max_attempts > 20 then
    raise exception 'invalid Provider Access notification failure' using errcode = '22023';
  end if;
  select notification.* into v_notification
  from public.cloud_provider_access_notifications notification
  where notification.id = p_notification_id and notification.channel = p_channel
    and notification.state = 'processing' and notification.lease_owner = p_worker
    and notification.lease_sequence = p_expected_lease_sequence
  for update;
  if not found then return 'stale'; end if;
  v_terminal := not p_retryable
    or v_notification.attempt_count >= p_max_attempts
    or (v_notification.transport_started_at is not null
      and v_notification.transport_started_at <= now() - interval '23 hours');
  v_delay := coalesce(p_retry_after_seconds,
    least(21600, greatest(30, (power(2, least(v_notification.attempt_count, 10)) * 15)::integer)));
  update public.cloud_provider_access_notifications notification
  set state = case when v_terminal then 'dead_letter' else 'pending' end,
      lease_owner = null, lease_expires_at = null,
      next_attempt_at = case when v_terminal then notification.next_attempt_at
        else now() + make_interval(secs => v_delay) end,
      last_error_code = p_error_code,
      dead_lettered_at = case when v_terminal then now() else null end,
      updated_at = now()
  where notification.id = v_notification.id
    and notification.state = 'processing'
    and notification.lease_sequence = p_expected_lease_sequence;
  return case when v_terminal then 'dead_letter' else 'retry_scheduled' end;
end
$function$;

create or replace function public.norva_list_provider_access_in_app_notifications(
  p_limit integer default 20
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if not coalesce(public.feature_flag('provider_access_notifications_v1_enabled'), false)
     or not coalesce(public.feature_flag('provider_access_in_app_v1_enabled'), false) then
    return '[]'::jsonb;
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 50 then
    raise exception 'invalid in-app notification limit' using errcode = '22023';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'notificationId', notification.id,
      'sourceId', notification.source_id,
      'kind', notification.event_kind,
      'sourceName', left(coalesce(source.display_name, 'TV service'), 120),
      'expiresOn', cycle.expires_on,
      'scheduledAt', notification.scheduled_at
    ) order by notification.scheduled_at desc, notification.id desc)
    from (
      select candidate.*
      from public.cloud_provider_access_notifications candidate
      where candidate.user_id = v_user_id and candidate.channel = 'in_app'
        and candidate.state = 'available' and candidate.scheduled_at <= now()
      order by candidate.scheduled_at desc, candidate.id desc
      limit p_limit
    ) notification
    join public.cloud_sources source
      on source.user_id = notification.user_id and source.id = notification.source_id
    join public.cloud_source_access_cycles cycle
      on cycle.user_id = notification.user_id and cycle.id = notification.access_cycle_id
  ), '[]'::jsonb);
end
$function$;

create or replace function public.norva_dismiss_provider_access_in_app_notification(
  p_notification_id uuid
) returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if not coalesce(public.feature_flag('provider_access_notifications_v1_enabled'), false)
     or not coalesce(public.feature_flag('provider_access_in_app_v1_enabled'), false) then
    return false;
  end if;
  update public.cloud_provider_access_notifications notification
  set state = 'dismissed', completion_code = 'IN_APP_DISMISSED',
      dismissed_at = now(), updated_at = now()
  where notification.id = p_notification_id and notification.user_id = v_user_id
    and notification.channel = 'in_app' and notification.state = 'available';
  return found;
end
$function$;

create or replace function public.norva_provider_access_notification_health()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select jsonb_build_object(
    'pending', count(*) filter (where state = 'pending'),
    'processing', count(*) filter (where state = 'processing'),
    'available', count(*) filter (where state = 'available'),
    'delivered', count(*) filter (where state = 'delivered'),
    'superseded', count(*) filter (where state = 'superseded'),
    'deadLetter', count(*) filter (where state = 'dead_letter'),
    'expiredLeases', count(*) filter (where state = 'processing' and lease_expires_at <= now()),
    'oldestDueAt', min(next_attempt_at) filter (where state = 'pending')
  )
  from public.cloud_provider_access_notifications
$function$;

revoke all on function public.norva_provider_access_notification_flag_required(text) from public, anon, authenticated, service_role;
revoke all on function public.norva_enqueue_provider_access_notification_set(uuid,uuid,uuid,text,timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.norva_schedule_provider_access_notifications(timestamptz,integer) from public, anon, authenticated;
revoke all on function public.norva_claim_provider_access_notifications(text,text,integer,integer,integer) from public, anon, authenticated;
revoke all on function public.norva_authorize_provider_access_notification(uuid,text,text,bigint,text) from public, anon, authenticated;
revoke all on function public.norva_complete_provider_access_notification(uuid,text,text,bigint,text,text) from public, anon, authenticated;
revoke all on function public.norva_fail_provider_access_notification(uuid,text,text,bigint,text,boolean,integer,integer) from public, anon, authenticated;
revoke all on function public.norva_provider_access_notification_health() from public, anon, authenticated;
revoke all on function public.norva_list_provider_access_in_app_notifications(integer) from public, anon;
revoke all on function public.norva_dismiss_provider_access_in_app_notification(uuid) from public, anon;

grant execute on function public.norva_schedule_provider_access_notifications(timestamptz,integer) to service_role;
grant execute on function public.norva_claim_provider_access_notifications(text,text,integer,integer,integer) to service_role;
grant execute on function public.norva_authorize_provider_access_notification(uuid,text,text,bigint,text) to service_role;
grant execute on function public.norva_complete_provider_access_notification(uuid,text,text,bigint,text,text) to service_role;
grant execute on function public.norva_fail_provider_access_notification(uuid,text,text,bigint,text,boolean,integer,integer) to service_role;
grant execute on function public.norva_provider_access_notification_health() to service_role;
grant execute on function public.norva_list_provider_access_in_app_notifications(integer) to authenticated;
grant execute on function public.norva_dismiss_provider_access_in_app_notification(uuid) to authenticated;

comment on function public.norva_claim_provider_access_notifications(text,text,integer,integer,integer)
  is 'Claims due email or push rows with SKIP LOCKED. The lease permits work; the final authorization CAS permits network I/O.';
comment on function public.norva_authorize_provider_access_notification(uuid,text,text,bigint,text)
  is 'Final pre-I/O CAS over flag, cycle, opt-in, source lifecycle, lease sequence and current Auth email.';
