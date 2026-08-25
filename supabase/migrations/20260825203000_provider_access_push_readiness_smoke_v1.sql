begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

-- A launch smoke must never pretend that a customer's access expired or was
-- restored. It is a distinct, durable push-only event, restricted to the
-- INTERNAL allowlist and one exact rollout revision.
alter table public.cloud_provider_access_notifications
  drop constraint cloud_provider_access_notifications_event_kind_check,
  drop constraint cloud_provider_access_notific_access_cycle_id_event_kind_ch_key;

alter table public.cloud_provider_access_notifications
  add column readiness_rollout_revision bigint,
  add constraint cloud_provider_access_notifications_event_kind_check
    check (event_kind in (
      'expiry_7d','expiry_1d','expiry_today','access_hidden','access_restored',
      'readiness_smoke'
    )),
  add constraint cloud_provider_access_notifications_readiness_smoke_ck
    check (
      (event_kind = 'readiness_smoke' and channel = 'push'
        and readiness_rollout_revision is not null and readiness_rollout_revision > 0)
      or (event_kind <> 'readiness_smoke' and readiness_rollout_revision is null)
    );

create unique index cloud_provider_access_notifications_business_event_uidx
  on public.cloud_provider_access_notifications(access_cycle_id,event_kind,channel)
  where event_kind <> 'readiness_smoke';
create unique index cloud_provider_access_notifications_readiness_smoke_uidx
  on public.cloud_provider_access_notifications(readiness_rollout_revision,user_id)
  where event_kind = 'readiness_smoke';

create table public.cloud_provider_access_notification_smoke_events (
  notification_id uuid primary key
    references public.cloud_provider_access_notifications(id) on delete cascade,
  rollout_revision bigint not null check (rollout_revision > 0),
  stage text not null check (stage in (
    'internal','1_percent','5_percent','20_percent','50_percent','100_percent'
  )),
  readiness_reference text not null
    check (length(btrim(readiness_reference)) between 12 and 1000),
  actor text not null check (length(btrim(actor)) between 3 and 200),
  created_at timestamptz not null default clock_timestamp(),
  unique (rollout_revision, notification_id)
);

alter table public.cloud_provider_access_notification_smoke_events enable row level security;
revoke all on table public.cloud_provider_access_notification_smoke_events
  from public, anon, authenticated, service_role;
grant select on table public.cloud_provider_access_notification_smoke_events
  to service_role;

create or replace function public.norva_provider_access_notification_business_eligible(
  p_user_id uuid,
  p_source_id uuid,
  p_access_cycle_id uuid,
  p_event_kind text
) returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.cloud_source_access_cycles cycle
    join public.cloud_source_provider_access access
      on access.user_id = cycle.user_id and access.source_id = cycle.source_id
    join public.cloud_sources source
      on source.user_id = cycle.user_id and source.id = cycle.source_id
    join public.cloud_source_lifecycle lifecycle
      on lifecycle.user_id = source.user_id and lifecycle.source_id = source.id
    where cycle.user_id = p_user_id
      and cycle.source_id = p_source_id
      and cycle.id = p_access_cycle_id
      and cycle.status = 'active'
      and source.deleted_at is null
      and lifecycle.lifecycle_state = 'active'
      and (
        (p_event_kind <> 'readiness_smoke' and access.provider_access_reminders_enabled)
        or (
          p_event_kind = 'readiness_smoke'
          and exists (
            select 1
            from public.cloud_provider_access_rollout rollout
            join public.cloud_provider_access_rollout_internal_users internal_user
              on internal_user.user_id = p_user_id
            where rollout.singleton and rollout.stage <> 'off'
          )
        )
      )
  );
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
  on conflict (access_cycle_id,event_kind,channel)
    where event_kind <> 'readiness_smoke'
    do nothing;
  get diagnostics v_inserted = row_count;
  return v_inserted;
end
$function$;

create or replace function public.norva_enqueue_provider_access_push_readiness_smoke(
  p_user_id uuid,
  p_expected_rollout_revision bigint,
  p_readiness_reference text,
  p_actor text
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_rollout public.cloud_provider_access_rollout%rowtype;
  v_target record;
  v_notification public.cloud_provider_access_notifications%rowtype;
  v_notification_id uuid := gen_random_uuid();
begin
  perform public.norva_provider_access_notification_flag_required('push');
  if p_user_id is null or p_expected_rollout_revision is null
     or length(btrim(coalesce(p_readiness_reference,''))) not between 12 and 1000
     or length(btrim(coalesce(p_actor,''))) not between 3 and 200 then
    raise exception 'invalid Provider Access push readiness smoke' using errcode = '22023';
  end if;

  select * into strict v_rollout
  from public.cloud_provider_access_rollout
  where singleton
  for update;
  if v_rollout.revision <> p_expected_rollout_revision then
    raise exception 'stale rollout revision'
      using errcode = '40001', detail = 'reason=stale';
  end if;
  if v_rollout.stage = 'off' or not exists (
    select 1 from public.cloud_provider_access_rollout_internal_users internal_user
    where internal_user.user_id = p_user_id
  ) then
    raise exception 'push readiness smoke requires an internal rollout user'
      using errcode = '55000', detail = 'reason=internal_user_required';
  end if;

  select cycle.user_id, cycle.source_id, cycle.id as access_cycle_id
  into v_target
  from public.cloud_source_access_cycles cycle
  join public.cloud_sources source
    on source.user_id = cycle.user_id and source.id = cycle.source_id
  join public.cloud_source_lifecycle lifecycle
    on lifecycle.user_id = cycle.user_id and lifecycle.source_id = cycle.source_id
  where cycle.user_id = p_user_id and cycle.status = 'active'
    and source.deleted_at is null and lifecycle.lifecycle_state = 'active'
  order by cycle.created_at desc, cycle.id desc
  limit 1
  for update of cycle;
  if not found then
    raise exception 'push readiness smoke requires an active internal access cycle'
      using errcode = '55000', detail = 'reason=active_cycle_required';
  end if;

  insert into public.cloud_provider_access_notifications(
    id,user_id,source_id,access_cycle_id,event_kind,channel,state,scheduled_at,
    delivery_key,next_attempt_at,readiness_rollout_revision
  ) values (
    v_notification_id,v_target.user_id,v_target.source_id,v_target.access_cycle_id,
    'readiness_smoke','push','pending',now(),
    'norva-provider-access-' || v_notification_id::text,now(),
    v_rollout.revision
  )
  on conflict (readiness_rollout_revision,user_id)
    where event_kind = 'readiness_smoke'
    do update set updated_at = public.cloud_provider_access_notifications.updated_at
  returning * into v_notification;

  insert into public.cloud_provider_access_notification_smoke_events(
    notification_id,rollout_revision,stage,readiness_reference,actor
  ) values (
    v_notification.id,v_rollout.revision,v_rollout.stage,
    btrim(p_readiness_reference),btrim(p_actor)
  ) on conflict (notification_id) do nothing;

  return jsonb_build_object(
    'notificationId',v_notification.id,
    'deliveryKey',v_notification.delivery_key,
    'state',v_notification.state,
    'rolloutRevision',v_rollout.revision,
    'stage',v_rollout.stage,
    'eventKind','readiness_smoke'
  );
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

  update public.cloud_provider_access_notifications notification
  set state = 'superseded', lease_owner = null, lease_expires_at = null,
      superseded_at = p_now, last_error_code = 'BUSINESS_STATE_SUPERSEDED',
      updated_at = p_now
  where notification.state in ('pending','processing','available')
    and not public.norva_provider_access_notification_business_eligible(
      notification.user_id, notification.source_id,
      notification.access_cycle_id, notification.event_kind
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
    where notification.channel = p_channel and notification.state = 'pending'
      and notification.next_attempt_at <= now()
      and public.norva_provider_access_notification_business_eligible(
        notification.user_id, notification.source_id,
        notification.access_cycle_id, notification.event_kind
      )
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
  v_eligible := public.norva_provider_access_notification_business_eligible(
    v_notification.user_id, v_notification.source_id,
    v_notification.access_cycle_id, v_notification.event_kind
  );

  if p_channel = 'email' and v_eligible and v_current_email is not null
     and lower(btrim(coalesce(p_expected_recipient_email, ''))) <> v_current_email then
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

revoke all on table public.cloud_provider_access_notification_smoke_events
  from public, anon, authenticated, service_role;
grant select on table public.cloud_provider_access_notification_smoke_events
  to service_role;
revoke all on function
  public.norva_provider_access_notification_business_eligible(uuid,uuid,uuid,text),
  public.norva_enqueue_provider_access_push_readiness_smoke(uuid,bigint,text,text)
  from public, anon, authenticated, service_role;
grant execute on function
  public.norva_enqueue_provider_access_push_readiness_smoke(uuid,bigint,text,text)
  to service_role;

comment on table public.cloud_provider_access_notification_smoke_events is
  'Immutable operator evidence for one internal push readiness smoke per rollout revision.';
comment on function public.norva_enqueue_provider_access_push_readiness_smoke(uuid,bigint,text,text) is
  'Service-only, revision-CAS internal FCM readiness enqueue. It never changes access dates, reminders, visibility or credentials.';

commit;
