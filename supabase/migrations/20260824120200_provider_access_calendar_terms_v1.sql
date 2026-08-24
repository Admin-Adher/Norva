-- Forward-only calendar semantics for Provider Access terms. Earlier installs
-- accepted term_value/unit as metadata while requiring clients to calculate an
-- expires_on date. This migration makes PostgreSQL authoritative and prevents a
-- client from submitting both a semantic term and a competing explicit end date.

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
    p_user_id, p_source_id, p_cycle_id,
    case
      when v_cycle.expires_on is not null and v_expires_on > v_cycle.expires_on
        then 'provider_access_cycle_extended'
      else 'provider_access_cycle_updated'
    end,
    'provider-access-update:' || p_idempotency_key,
    jsonb_build_object('requestFingerprint', p_request_fingerprint), p_actor
  );
  return public.norva_get_provider_access(p_user_id, p_source_id) || jsonb_build_object('replayed', false);
end
$function$;

comment on function public.norva_create_provider_access_cycle(uuid,uuid,date,date,integer,text,boolean,text,text,text)
  is 'Creates a cycle and resolves semantic day/week/month/year duration with PostgreSQL calendar arithmetic.';
comment on function public.norva_update_provider_access_cycle(uuid,uuid,uuid,bigint,date,date,integer,text,boolean,text,text,text)
  is 'CAS update of an active cycle with server-authoritative calendar duration resolution.';
