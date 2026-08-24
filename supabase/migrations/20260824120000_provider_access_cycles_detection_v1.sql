-- Phase 6-8: durable Provider Access cycles, conservative Xtream detection and
-- atomic hide/restore policy.  This migration is additive and all public
-- behaviour remains behind the existing Provider Access flags.

alter table public.cloud_source_provider_access
  add column if not exists revision bigint not null default 1,
  add column if not exists provider_access_detection_version integer,
  add column if not exists provider_access_last_detection_code text,
  add column if not exists provider_access_last_contradiction_count integer not null default 0;

alter table public.cloud_source_provider_access
  add constraint cloud_source_provider_access_revision_ck
    check (revision > 0),
  add constraint cloud_source_provider_access_detection_version_ck
    check (provider_access_detection_version is null or provider_access_detection_version > 0),
  add constraint cloud_source_provider_access_detection_code_ck
    check (
      provider_access_last_detection_code is null
      or (
        btrim(provider_access_last_detection_code) <> ''
        and length(provider_access_last_detection_code) <= 120
        and provider_access_last_detection_code = upper(provider_access_last_detection_code)
      )
    ),
  add constraint cloud_source_provider_access_contradiction_count_ck
    check (provider_access_last_contradiction_count between 0 and 32),
  add constraint cloud_source_provider_access_restore_time_ck
    check (
      provider_access_restored_at is null
      or provider_access_hidden_at is null
      or provider_access_restored_at >= provider_access_hidden_at
    );

alter table public.cloud_source_access_cycles
  add column if not exists revision bigint not null default 1,
  add column if not exists idempotency_key text,
  add column if not exists request_fingerprint text,
  add column if not exists updated_at timestamptz not null default now();

update public.cloud_source_access_cycles
set idempotency_key = 'migration:' || id::text,
    request_fingerprint = encode(sha256(convert_to('migration:' || id::text, 'UTF8')), 'hex')
where idempotency_key is null or request_fingerprint is null;

alter table public.cloud_source_access_cycles
  alter column idempotency_key set not null,
  alter column request_fingerprint set not null,
  add constraint cloud_source_access_cycles_revision_ck check (revision > 0),
  add constraint cloud_source_access_cycles_idempotency_key_ck check (
    btrim(idempotency_key) <> '' and length(idempotency_key) <= 200
  ),
  add constraint cloud_source_access_cycles_request_fingerprint_ck check (
    request_fingerprint ~ '^[0-9a-f]{64}$'
  );

create unique index cloud_source_access_cycles_idempotency_uidx
  on public.cloud_source_access_cycles (user_id, idempotency_key);

create or replace function public.norva_provider_access_service_role_required()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_role text := coalesce(
    nullif(auth.jwt() ->> 'role', ''),
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('role', true), 'none'),
    ''
  );
begin
  if v_role is distinct from 'service_role' then
    raise exception 'service_role required' using errcode = '42501';
  end if;
end
$function$;

create or replace function public.norva_provider_access_capability_required(p_key text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  perform public.norva_provider_access_service_role_required();
  if p_key not in ('provider_access_v1_enabled', 'provider_access_auto_detection_v1_enabled')
     or not coalesce(public.feature_flag(p_key), false) then
    raise exception 'provider access feature disabled'
      using errcode = '55000', detail = 'reason=feature_disabled';
  end if;
end
$function$;

create or replace function public.norva_get_provider_access(
  p_user_id uuid,
  p_source_id uuid
) returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select case
    when p_user_id is null or p_source_id is null then null
    else (
      select jsonb_build_object(
        'sourceId', access.source_id,
        'revision', access.revision,
        'status', access.provider_access_status,
        'startedOn', access.provider_access_started_on,
        'expiresOn', access.provider_access_expires_on,
        'expirySource', access.provider_access_expiry_source,
        'manualOverride', access.provider_access_manual_override,
        'remindersEnabled', access.provider_access_reminders_enabled,
        'lastCheckedAt', access.provider_access_last_checked_at,
        'lastConfirmedActiveAt', access.provider_access_last_confirmed_active_at,
        'lastDetectedAt', access.provider_access_last_detected_at,
        'hiddenAt', access.provider_access_hidden_at,
        'restoredAt', access.provider_access_restored_at,
        'detectionVersion', access.provider_access_detection_version,
        'lastDetectionCode', access.provider_access_last_detection_code,
        'lastContradictionCount', access.provider_access_last_contradiction_count,
        'activeCycle', (
          select jsonb_build_object(
            'cycleId', cycle.id,
            'revision', cycle.revision,
            'startedOn', cycle.started_on,
            'expiresOn', cycle.expires_on,
            'termValue', cycle.term_value,
            'termUnit', cycle.term_unit,
            'origin', cycle.origin,
            'status', cycle.status,
            'createdAt', cycle.created_at,
            'updatedAt', cycle.updated_at
          )
          from public.cloud_source_access_cycles cycle
          where cycle.user_id = access.user_id
            and cycle.source_id = access.source_id
            and cycle.status = 'active'
        ),
        'cycles', coalesce((
          select jsonb_agg(jsonb_build_object(
            'cycleId', cycle.id,
            'revision', cycle.revision,
            'startedOn', cycle.started_on,
            'expiresOn', cycle.expires_on,
            'termValue', cycle.term_value,
            'termUnit', cycle.term_unit,
            'origin', cycle.origin,
            'status', cycle.status,
            'createdAt', cycle.created_at,
            'updatedAt', cycle.updated_at
          ) order by cycle.created_at desc, cycle.id desc)
          from (
            select history.*
            from public.cloud_source_access_cycles history
            where history.user_id = access.user_id
              and history.source_id = access.source_id
            order by history.created_at desc, history.id desc
            limit 100
          ) cycle
        ), '[]'::jsonb)
      )
      from public.cloud_source_provider_access access
      join public.cloud_sources source
        on source.id = access.source_id and source.user_id = access.user_id
      where access.user_id = p_user_id
        and access.source_id = p_source_id
        and source.deleted_at is null
    )
  end
$function$;

create or replace function public.norva_provider_access_status_for_dates(
  p_expires_on date,
  p_today date default current_date
) returns text
language sql
immutable
set search_path = ''
as $function$
  select case
    when p_expires_on is null then 'unknown'
    when p_expires_on < p_today then 'expected_expired'
    when p_expires_on <= p_today + 7 then 'expiring'
    else 'active'
  end
$function$;

create or replace function public.norva_create_provider_access_cycle(
  p_user_id uuid,
  p_source_id uuid,
  p_started_on date,
  p_expires_on date,
  p_term_value integer,
  p_term_unit text,
  p_reminders_enabled boolean,
  p_idempotency_key text,
  p_request_fingerprint text,
  p_actor text
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_access public.cloud_source_provider_access%rowtype;
  v_existing public.cloud_source_access_cycles%rowtype;
  v_cycle_id uuid;
  v_status text;
  v_started_on date;
  v_expires_on date;
begin
  perform public.norva_provider_access_capability_required('provider_access_v1_enabled');
  if p_user_id is null or p_source_id is null
     or p_idempotency_key is null or btrim(p_idempotency_key) = '' or length(p_idempotency_key) > 200
     or p_request_fingerprint is null or p_request_fingerprint !~ '^[0-9a-f]{64}$'
     or p_actor is null or btrim(p_actor) = '' or length(p_actor) > 200
     or (p_started_on is not null and p_expires_on is not null and p_expires_on < p_started_on)
     or ((p_term_value is null) <> (p_term_unit is null))
     or (p_expires_on is not null and p_term_value is not null)
     or (p_term_value is not null and (p_term_value <= 0 or p_term_unit not in ('day','week','month','year'))) then
    raise exception 'invalid provider access cycle request' using errcode = '22023';
  end if;

  v_started_on := case when p_term_value is null then p_started_on else coalesce(p_started_on, current_date) end;
  v_expires_on := case p_term_unit
    when 'day' then (v_started_on + make_interval(days => p_term_value))::date
    when 'week' then (v_started_on + make_interval(days => p_term_value * 7))::date
    when 'month' then (v_started_on + make_interval(months => p_term_value))::date
    when 'year' then (v_started_on + make_interval(years => p_term_value))::date
    else p_expires_on
  end;

  perform 1 from public.cloud_sources source
  join public.cloud_source_lifecycle lifecycle
    on lifecycle.source_id = source.id and lifecycle.user_id = source.user_id
  where source.id = p_source_id and source.user_id = p_user_id
    and source.deleted_at is null and lifecycle.lifecycle_state = 'active'
  for update of source;
  if not found then raise exception 'source not found' using errcode = 'P0002'; end if;

  select cycle.* into v_existing
  from public.cloud_source_access_cycles cycle
  where cycle.user_id = p_user_id and cycle.idempotency_key = p_idempotency_key;
  if found then
    if v_existing.source_id is distinct from p_source_id
       or v_existing.request_fingerprint is distinct from p_request_fingerprint then
      raise exception 'provider access idempotency key reused'
        using errcode = '22023', detail = 'reason=idempotency_key_reused';
    end if;
    return public.norva_get_provider_access(p_user_id, p_source_id) || jsonb_build_object('replayed', true);
  end if;

  select access.* into strict v_access
  from public.cloud_source_provider_access access
  where access.user_id = p_user_id and access.source_id = p_source_id
  for update;

  update public.cloud_source_access_cycles cycle
  set status = 'superseded', superseded_at = now(), revision = cycle.revision + 1, updated_at = now()
  where cycle.user_id = p_user_id and cycle.source_id = p_source_id and cycle.status = 'active';

  insert into public.cloud_source_access_cycles (
    user_id, source_id, started_on, expires_on, term_value, term_unit,
    origin, status, idempotency_key, request_fingerprint
  ) values (
    p_user_id, p_source_id, v_started_on, v_expires_on, p_term_value, p_term_unit,
    'user_entered', 'active', p_idempotency_key, p_request_fingerprint
  ) returning id into v_cycle_id;

  v_status := public.norva_provider_access_status_for_dates(v_expires_on, current_date);
  update public.cloud_source_provider_access access
  set provider_access_status = case
        when access.provider_access_hidden_at is not null then 'restoring'
        else v_status
      end,
      provider_access_started_on = v_started_on,
      provider_access_expires_on = v_expires_on,
      provider_access_expiry_source = case when v_expires_on is null then null else 'user_entered' end,
      provider_access_manual_override = true,
      provider_access_reminders_enabled = coalesce(p_reminders_enabled, false),
      revision = access.revision + 1,
      updated_at = now()
  where access.user_id = p_user_id and access.source_id = p_source_id;

  insert into public.cloud_source_lifecycle_events (
    user_id, source_id, access_cycle_id, event_kind, idempotency_key, payload, actor
  ) values (
    p_user_id, p_source_id, v_cycle_id, 'provider_access_cycle_started',
    'provider-access-cycle:' || p_idempotency_key,
    jsonb_build_object('requestFingerprint', p_request_fingerprint), p_actor
  );

  return public.norva_get_provider_access(p_user_id, p_source_id)
    || jsonb_build_object('replayed', false);
end
$function$;

create or replace function public.norva_update_provider_access_cycle(
  p_user_id uuid,
  p_source_id uuid,
  p_cycle_id uuid,
  p_expected_revision bigint,
  p_started_on date,
  p_expires_on date,
  p_term_value integer,
  p_term_unit text,
  p_reminders_enabled boolean,
  p_idempotency_key text,
  p_request_fingerprint text,
  p_actor text
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_access public.cloud_source_provider_access%rowtype;
  v_cycle public.cloud_source_access_cycles%rowtype;
  v_event public.cloud_source_lifecycle_events%rowtype;
  v_status text;
  v_started_on date;
  v_expires_on date;
begin
  perform public.norva_provider_access_capability_required('provider_access_v1_enabled');
  if p_user_id is null or p_source_id is null or p_cycle_id is null or p_expected_revision is null
     or p_idempotency_key is null or btrim(p_idempotency_key) = '' or length(p_idempotency_key) > 200
     or p_request_fingerprint is null or p_request_fingerprint !~ '^[0-9a-f]{64}$'
     or p_actor is null or btrim(p_actor) = '' or length(p_actor) > 200
     or (p_started_on is not null and p_expires_on is not null and p_expires_on < p_started_on)
     or ((p_term_value is null) <> (p_term_unit is null))
     or (p_expires_on is not null and p_term_value is not null)
     or (p_term_value is not null and (p_term_value <= 0 or p_term_unit not in ('day','week','month','year'))) then
    raise exception 'invalid provider access update request' using errcode = '22023';
  end if;

  v_started_on := case when p_term_value is null then p_started_on else coalesce(p_started_on, current_date) end;
  v_expires_on := case p_term_unit
    when 'day' then (v_started_on + make_interval(days => p_term_value))::date
    when 'week' then (v_started_on + make_interval(days => p_term_value * 7))::date
    when 'month' then (v_started_on + make_interval(months => p_term_value))::date
    when 'year' then (v_started_on + make_interval(years => p_term_value))::date
    else p_expires_on
  end;

  select event.* into v_event from public.cloud_source_lifecycle_events event
  where event.user_id = p_user_id and event.idempotency_key = 'provider-access-update:' || p_idempotency_key;
  if found then
    if v_event.source_id is distinct from p_source_id
       or v_event.access_cycle_id is distinct from p_cycle_id
       or v_event.payload ->> 'requestFingerprint' is distinct from p_request_fingerprint then
      raise exception 'provider access idempotency key reused'
        using errcode = '22023', detail = 'reason=idempotency_key_reused';
    end if;
    return public.norva_get_provider_access(p_user_id, p_source_id) || jsonb_build_object('replayed', true);
  end if;

  select access.* into strict v_access
  from public.cloud_source_provider_access access
  where access.user_id = p_user_id and access.source_id = p_source_id
  for update;
  if v_access.revision is distinct from p_expected_revision then
    raise exception 'provider access revision CAS failed' using errcode = '40001';
  end if;
  select cycle.* into v_cycle
  from public.cloud_source_access_cycles cycle
  where cycle.id = p_cycle_id and cycle.user_id = p_user_id
    and cycle.source_id = p_source_id and cycle.status = 'active'
  for update;
  if not found then raise exception 'active access cycle not found' using errcode = 'P0002'; end if;

  update public.cloud_source_access_cycles cycle
  set started_on = v_started_on, expires_on = v_expires_on,
      term_value = p_term_value, term_unit = p_term_unit,
      revision = cycle.revision + 1, updated_at = now()
  where cycle.id = p_cycle_id and cycle.revision = v_cycle.revision;
  if not found then raise exception 'provider cycle revision CAS failed' using errcode = '40001'; end if;

  v_status := public.norva_provider_access_status_for_dates(v_expires_on, current_date);
  update public.cloud_source_provider_access access
  set provider_access_status = case
        when access.provider_access_hidden_at is not null then 'restoring'
        else v_status
      end,
      provider_access_started_on = v_started_on,
      provider_access_expires_on = v_expires_on,
      provider_access_expiry_source = case when v_expires_on is null then null else 'user_entered' end,
      provider_access_manual_override = true,
      provider_access_reminders_enabled = coalesce(p_reminders_enabled, false),
      revision = access.revision + 1,
      updated_at = now()
  where access.user_id = p_user_id and access.source_id = p_source_id
    and access.revision = p_expected_revision;
  if not found then raise exception 'provider access revision CAS failed' using errcode = '40001'; end if;

  insert into public.cloud_source_lifecycle_events (
    user_id, source_id, access_cycle_id, event_kind, idempotency_key, payload, actor
  ) values (
    p_user_id, p_source_id, p_cycle_id, 'provider_access_cycle_updated',
    'provider-access-update:' || p_idempotency_key,
    jsonb_build_object('requestFingerprint', p_request_fingerprint), p_actor
  );
  return public.norva_get_provider_access(p_user_id, p_source_id) || jsonb_build_object('replayed', false);
end
$function$;

create or replace function public.norva_end_provider_access_cycle(
  p_user_id uuid,
  p_source_id uuid,
  p_cycle_id uuid,
  p_expected_revision bigint,
  p_idempotency_key text,
  p_request_fingerprint text,
  p_actor text
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_access public.cloud_source_provider_access%rowtype;
  v_event public.cloud_source_lifecycle_events%rowtype;
begin
  perform public.norva_provider_access_capability_required('provider_access_v1_enabled');
  if p_user_id is null or p_source_id is null or p_cycle_id is null or p_expected_revision is null
     or p_idempotency_key is null or btrim(p_idempotency_key) = '' or length(p_idempotency_key) > 200
     or p_request_fingerprint is null or p_request_fingerprint !~ '^[0-9a-f]{64}$'
     or p_actor is null or btrim(p_actor) = '' or length(p_actor) > 200 then
    raise exception 'invalid provider access end request' using errcode = '22023';
  end if;
  select event.* into v_event from public.cloud_source_lifecycle_events event
  where event.user_id = p_user_id and event.idempotency_key = 'provider-access-end:' || p_idempotency_key;
  if found then
    if v_event.source_id is distinct from p_source_id
       or v_event.access_cycle_id is distinct from p_cycle_id
       or v_event.payload ->> 'requestFingerprint' is distinct from p_request_fingerprint then
      raise exception 'provider access idempotency key reused' using errcode = '22023';
    end if;
    return public.norva_get_provider_access(p_user_id, p_source_id) || jsonb_build_object('replayed', true);
  end if;
  select access.* into strict v_access from public.cloud_source_provider_access access
  where access.user_id = p_user_id and access.source_id = p_source_id for update;
  if v_access.revision is distinct from p_expected_revision then
    raise exception 'provider access revision CAS failed' using errcode = '40001';
  end if;
  update public.cloud_source_access_cycles cycle
  set status = 'ended', superseded_at = now(), revision = cycle.revision + 1, updated_at = now()
  where cycle.id = p_cycle_id and cycle.user_id = p_user_id
    and cycle.source_id = p_source_id and cycle.status = 'active';
  if not found then raise exception 'active access cycle not found' using errcode = 'P0002'; end if;
  update public.cloud_source_provider_access access
  set provider_access_started_on = null, provider_access_expires_on = null,
      provider_access_expiry_source = null, provider_access_manual_override = false,
      provider_access_reminders_enabled = false,
      provider_access_status = case when access.provider_access_hidden_at is null then 'unknown' else access.provider_access_status end,
      revision = access.revision + 1, updated_at = now()
  where access.user_id = p_user_id and access.source_id = p_source_id
    and access.revision = p_expected_revision;
  if not found then raise exception 'provider access revision CAS failed' using errcode = '40001'; end if;
  insert into public.cloud_source_lifecycle_events (
    user_id, source_id, access_cycle_id, event_kind, idempotency_key, payload, actor
  ) values (
    p_user_id, p_source_id, p_cycle_id, 'provider_access_cycle_ended',
    'provider-access-end:' || p_idempotency_key,
    jsonb_build_object('requestFingerprint', p_request_fingerprint), p_actor
  );
  return public.norva_get_provider_access(p_user_id, p_source_id) || jsonb_build_object('replayed', false);
end
$function$;

create or replace function public.norva_apply_provider_access_detection(
  p_user_id uuid,
  p_source_id uuid,
  p_expected_revision bigint,
  p_detection jsonb,
  p_checked_at timestamptz,
  p_idempotency_key text,
  p_actor text
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_access public.cloud_source_provider_access%rowtype;
  v_event public.cloud_source_lifecycle_events%rowtype;
  v_status text := p_detection ->> 'status';
  v_reason text := p_detection ->> 'reasonCode';
  v_expires_on date;
  v_hide_eligible boolean := coalesce((p_detection ->> 'hideEligible')::boolean, false);
  v_restore boolean := coalesce((p_detection ->> 'restorationConfirmed')::boolean, false);
  v_version integer := (p_detection ->> 'detectionVersion')::integer;
  v_contradiction_count integer := coalesce(jsonb_array_length(coalesce(p_detection -> 'contradictions', '[]'::jsonb)), 0);
  v_cycle_id uuid;
  v_existing_cycle public.cloud_source_access_cycles%rowtype;
  v_new_status text;
  v_new_hidden_at timestamptz;
  v_new_restored_at timestamptz;
begin
  perform public.norva_provider_access_capability_required('provider_access_v1_enabled');
  perform public.norva_provider_access_capability_required('provider_access_auto_detection_v1_enabled');
  begin
    v_expires_on := nullif(p_detection ->> 'expiresOn', '')::date;
  exception when others then
    raise exception 'invalid provider access detection' using errcode = '22023';
  end;
  if p_user_id is null or p_source_id is null or p_expected_revision is null
     or p_checked_at is null or p_checked_at > now() + interval '5 minutes'
     or p_idempotency_key is null or btrim(p_idempotency_key) = '' or length(p_idempotency_key) > 200
     or p_actor is null or btrim(p_actor) = '' or length(p_actor) > 200
     or jsonb_typeof(p_detection) <> 'object'
     or v_status not in ('unknown','active','expiring','expected_expired','expired_confirmed','access_unavailable_confirmed','check_failed_temporary')
     or v_reason is null or v_reason !~ '^[A-Z][A-Z0-9_]{1,119}$'
     or v_version <> 1 or v_contradiction_count > 32
     or (v_hide_eligible and v_status not in ('expired_confirmed','access_unavailable_confirmed'))
     or (v_status in ('expired_confirmed','access_unavailable_confirmed') and not v_hide_eligible)
     or (v_restore and v_status not in ('active','expiring')) then
    raise exception 'invalid provider access detection' using errcode = '22023';
  end if;

  select event.* into v_event from public.cloud_source_lifecycle_events event
  where event.user_id = p_user_id and event.idempotency_key = 'provider-access-detection:' || p_idempotency_key;
  if found then
    if v_event.source_id is distinct from p_source_id
       or v_event.payload ->> 'reasonCode' is distinct from v_reason then
      raise exception 'provider access idempotency key reused' using errcode = '22023';
    end if;
    return public.norva_get_provider_access(p_user_id, p_source_id) || jsonb_build_object('replayed', true);
  end if;

  select access.* into strict v_access from public.cloud_source_provider_access access
  where access.user_id = p_user_id and access.source_id = p_source_id for update;
  if v_access.revision is distinct from p_expected_revision then
    raise exception 'provider access revision CAS failed' using errcode = '40001';
  end if;

  v_new_status := v_status;
  v_new_hidden_at := v_access.provider_access_hidden_at;
  v_new_restored_at := v_access.provider_access_restored_at;
  if v_hide_eligible then
    v_new_hidden_at := coalesce(v_access.provider_access_hidden_at, p_checked_at);
    v_new_restored_at := null;
  elsif v_access.provider_access_hidden_at is not null then
    if v_restore then
      v_new_hidden_at := null;
      v_new_restored_at := p_checked_at;
    else
      -- A timeout, contradiction, unknown response or user-entered date is not
      -- a restoration proof. Keep the prior hidden authority unchanged.
      v_new_status := case
        when v_access.provider_access_status in ('expired_confirmed','access_unavailable_confirmed','restoring')
          then v_access.provider_access_status
        else 'restoring'
      end;
    end if;
  end if;

  if v_expires_on is not null and v_status in ('active','expiring','expired_confirmed') then
    select cycle.* into v_existing_cycle
    from public.cloud_source_access_cycles cycle
    where cycle.user_id = p_user_id and cycle.source_id = p_source_id and cycle.status = 'active'
    for update;
    if not found or v_existing_cycle.expires_on is distinct from v_expires_on
       or v_existing_cycle.origin is distinct from 'provider_reported' then
      update public.cloud_source_access_cycles cycle
      set status = 'superseded', superseded_at = now(), revision = cycle.revision + 1, updated_at = now()
      where cycle.user_id = p_user_id and cycle.source_id = p_source_id and cycle.status = 'active';
      insert into public.cloud_source_access_cycles (
        user_id, source_id, expires_on, origin, status, idempotency_key, request_fingerprint
      ) values (
        p_user_id, p_source_id, v_expires_on, 'provider_reported', 'active',
        'detection:' || p_idempotency_key,
        encode(sha256(convert_to(p_detection::text, 'UTF8')), 'hex')
      ) returning id into v_cycle_id;
    else
      v_cycle_id := v_existing_cycle.id;
    end if;
  else
    select cycle.id into v_cycle_id from public.cloud_source_access_cycles cycle
    where cycle.user_id = p_user_id and cycle.source_id = p_source_id and cycle.status = 'active';
  end if;

  update public.cloud_source_provider_access access
  set provider_access_status = v_new_status,
      provider_access_expires_on = coalesce(v_expires_on, access.provider_access_expires_on),
      provider_access_expiry_source = case when v_expires_on is null then access.provider_access_expiry_source else 'provider_reported' end,
      provider_access_manual_override = case when v_expires_on is null then access.provider_access_manual_override else false end,
      provider_access_last_checked_at = p_checked_at,
      provider_access_last_detected_at = p_checked_at,
      provider_access_last_confirmed_active_at = case when v_restore then p_checked_at else access.provider_access_last_confirmed_active_at end,
      provider_access_hidden_at = v_new_hidden_at,
      provider_access_restored_at = v_new_restored_at,
      provider_access_detection_version = v_version,
      provider_access_last_detection_code = v_reason,
      provider_access_last_contradiction_count = v_contradiction_count,
      revision = access.revision + 1,
      updated_at = now()
  where access.user_id = p_user_id and access.source_id = p_source_id
    and access.revision = p_expected_revision;
  if not found then raise exception 'provider access revision CAS failed' using errcode = '40001'; end if;

  insert into public.cloud_source_lifecycle_events (
    user_id, source_id, access_cycle_id, event_kind, idempotency_key, payload, actor
  ) values (
    p_user_id, p_source_id, v_cycle_id,
    case
      when v_hide_eligible then 'provider_access_hidden'
      when v_restore and v_access.provider_access_hidden_at is not null then 'provider_access_restored'
      else 'provider_access_checked'
    end,
    'provider-access-detection:' || p_idempotency_key,
    jsonb_build_object(
      'reasonCode', v_reason,
      'status', v_status,
      'contradictionCount', v_contradiction_count,
      'hideEligible', v_hide_eligible
    ), p_actor
  );
  return public.norva_get_provider_access(p_user_id, p_source_id) || jsonb_build_object('replayed', false);
end
$function$;

revoke all on function public.norva_provider_access_service_role_required() from public, anon, authenticated, service_role;
revoke all on function public.norva_provider_access_capability_required(text) from public, anon, authenticated, service_role;
revoke all on function public.norva_get_provider_access(uuid, uuid) from public, anon, authenticated;
revoke all on function public.norva_provider_access_status_for_dates(date, date) from public, anon, authenticated;
revoke all on function public.norva_create_provider_access_cycle(uuid,uuid,date,date,integer,text,boolean,text,text,text) from public, anon, authenticated;
revoke all on function public.norva_update_provider_access_cycle(uuid,uuid,uuid,bigint,date,date,integer,text,boolean,text,text,text) from public, anon, authenticated;
revoke all on function public.norva_end_provider_access_cycle(uuid,uuid,uuid,bigint,text,text,text) from public, anon, authenticated;
revoke all on function public.norva_apply_provider_access_detection(uuid,uuid,bigint,jsonb,timestamptz,text,text) from public, anon, authenticated;

grant execute on function public.norva_get_provider_access(uuid, uuid) to service_role;
grant execute on function public.norva_create_provider_access_cycle(uuid,uuid,date,date,integer,text,boolean,text,text,text) to service_role;
grant execute on function public.norva_update_provider_access_cycle(uuid,uuid,uuid,bigint,date,date,integer,text,boolean,text,text,text) to service_role;
grant execute on function public.norva_end_provider_access_cycle(uuid,uuid,uuid,bigint,text,text,text) to service_role;
grant execute on function public.norva_apply_provider_access_detection(uuid,uuid,bigint,jsonb,timestamptz,text,text) to service_role;

comment on function public.norva_apply_provider_access_detection(uuid,uuid,bigint,jsonb,timestamptz,text,text)
  is 'Phase 7/8 conservative detection CAS: contradictions and temporary failures never hide or restore a catalogue.';
