begin;
set local lock_timeout = '2s';
set local statement_timeout = '5min';

create or replace function public.norva_provider_account_delete_batch_fenced(
  p_user_id uuid
) returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_context jsonb;
begin
  begin
    v_context := current_setting(
      'norva.provider_account_delete_batch',true
    )::jsonb;
  exception when others then
    return false;
  end;
  return p_user_id is not null
    and (v_context ->> 'userId')::uuid = p_user_id
    and exists (
      select 1
      from public.cloud_provider_account_delete_preparations preparation
      where preparation.user_id = p_user_id
        and preparation.state = 'processing'
        and preparation.lease_owner = v_context ->> 'worker'
        and preparation.lease_sequence =
          (v_context ->> 'leaseSequence')::integer
        and preparation.lease_until > now()
    );
end
$function$;

create or replace function public.norva_provider_account_delete_fenced(
  p_user_id uuid
) returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select p_user_id is not null and (
    position(
      '|' || p_user_id::text || '|'
      in coalesce(current_setting(
        'norva.provider_transition_deleted_users',true
      ),'')
    ) > 0
    or public.norva_provider_account_delete_batch_fenced(p_user_id)
  )
$function$;

create or replace function public.norva_provider_account_delete_write_guard()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid;
  v_source_id uuid;
  v_variant_id uuid;
  v_old jsonb := case when tg_op = 'INSERT' then '{}'::jsonb else to_jsonb(old) end;
  v_new jsonb := case when tg_op = 'DELETE' then '{}'::jsonb else to_jsonb(new) end;
  v_preparing boolean := false;
begin
  v_user_id := case when tg_op = 'INSERT'
    then (v_new ->> 'user_id')::uuid
    else (v_old ->> 'user_id')::uuid
  end;
  v_source_id := coalesce(
    nullif(v_new ->> 'source_id','')::uuid,
    nullif(v_old ->> 'source_id','')::uuid
  );
  v_variant_id := coalesce(
    nullif(v_new ->> 'variant_id','')::uuid,
    nullif(v_old ->> 'variant_id','')::uuid
  );
  if v_user_id is null and v_source_id is not null then
    select source.user_id into v_user_id
    from public.cloud_sources source
    where source.id = v_source_id;
  end if;
  if v_user_id is null and v_variant_id is not null then
    select variant.user_id into v_user_id
    from public.cloud_title_variants variant
    where variant.id = v_variant_id;
  end if;
  if v_user_id is null or public.norva_provider_account_delete_fenced(v_user_id) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  -- A row-level trigger executes after PostgreSQL has identified/locked the
  -- target tuple.  Never wait from that tuple on auth.users: NOWAIT turns the
  -- inverse account->child cleanup order into a retry instead of a deadlock.
  -- Once acquired, KEY SHARE is held to transaction end, so a preparation
  -- cannot publish deletion_pending between this check and a later auth FK.
  begin
    perform 1
    from auth.users account
    where account.id = v_user_id
    for key share nowait;
    if not found then
      raise exception 'provider account is unavailable'
        using errcode = 'P0002';
    end if;
  exception when lock_not_available then
    raise exception 'provider account deletion fence is busy'
      using errcode = '40001',
        detail = 'reason=provider_account_fence_busy';
  end;
  select exists (
    select 1
    from public.cloud_provider_account_delete_preparations preparation
    where preparation.user_id = v_user_id
      and preparation.state in ('pending','processing','ready')
  ) or exists (
    select 1
    from public.cloud_sources source
    where source.id = v_source_id and source.user_id = v_user_id
      and source.provider_deletion_pending
  ) into v_preparing;
  if v_preparing then
    -- A claim is selection, not a failure of the entire fleet batch.  Returning
    -- NULL makes the row ineligible while allowing claims for other accounts.
    if tg_op = 'UPDATE'
       and tg_table_name in (
         'cloud_source_credential_transition_jobs',
         'cloud_catalog_background_owner_build_jobs'
       )
       and v_old ->> 'state' = 'pending'
       and v_new ->> 'state' = 'processing' then
      return null;
    end if;
    -- Workers that already held a lease may only relinquish it.  They cannot
    -- keep processing or publish payload after deletion_pending is durable.
    if tg_op = 'UPDATE'
       and tg_table_name in (
         'cloud_source_credential_transition_jobs',
         'cloud_catalog_background_owner_build_jobs'
       )
       and v_old ->> 'state' = 'processing'
       and v_new ->> 'state' in ('pending','completed','dead') then
      return new;
    end if;
    if tg_table_name = 'cloud_source_direct_fallback_leases'
       and tg_op = 'DELETE' then
      return old;
    end if;
    if tg_table_name = 'cloud_provider_call_permits'
       and tg_op = 'UPDATE'
       and v_old ->> 'state' = 'active'
       and v_new ->> 'state' in ('released','expired') then
      return new;
    end if;
    if tg_table_name = 'cloud_provider_call_permits'
       and tg_op = 'DELETE'
       and v_old ->> 'state' in ('released','expired') then
      return old;
    end if;
    if tg_table_name = 'cloud_playback_sessions'
       and (
         tg_op = 'DELETE'
         or (tg_op = 'UPDATE' and v_new ->> 'status' in ('failed','expired'))
       ) then
      return case when tg_op = 'DELETE' then old else new end;
    end if;
    if tg_table_name = 'cloud_gateway_sessions'
       and (
         tg_op = 'DELETE'
         or (tg_op = 'UPDATE' and v_new ->> 'status' in ('failed','ended','expired'))
       ) then
      return case when tg_op = 'DELETE' then old else new end;
    end if;
    if tg_table_name = 'cloud_relay_tokens'
       and (tg_op = 'DELETE' or (
         tg_op = 'UPDATE' and v_new ->> 'revoked_at' is not null
       )) then
      return case when tg_op = 'DELETE' then old else new end;
    end if;
    raise exception 'provider account deletion preparation fences catalog writes'
      using errcode = '40001',
        detail = 'reason=provider_account_delete_preparing';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end
$function$;

create or replace function public.norva_get_provider_call_fence_snapshot(
  p_user_id uuid,
  p_source_id uuid
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_source public.cloud_sources%rowtype;
  v_account_epoch bigint := 0;
begin
  perform public.norva_credential_require_service_role();
  perform public.norva_credential_lock_account(p_user_id);
  select coalesce(preparation.deletion_epoch,0)
    into v_account_epoch
  from public.cloud_provider_account_delete_preparations preparation
  where preparation.user_id = p_user_id;
  if found then
    raise exception 'provider account deletion is pending'
      using errcode = '40001',detail = 'reason=account_deletion_pending';
  end if;
  select source.* into v_source
  from public.cloud_sources source
  where source.id = p_source_id and source.user_id = p_user_id
    and source.deleted_at is null
  for share;
  if not found then
    raise exception 'provider source is unavailable' using errcode = 'P0002';
  end if;
  if v_source.provider_deletion_pending then
    raise exception 'provider source deletion is pending'
      using errcode = '40001',detail = 'reason=source_deletion_pending';
  end if;
  return jsonb_build_object(
    'contract','provider-call-permit-v1','userId',p_user_id,
    'sourceId',p_source_id,'accountDeletionEpoch',v_account_epoch,
    'sourceDeletionEpoch',v_source.provider_deletion_epoch,
    'deletionPending',false
  );
end
$function$;

create or replace function public.norva_acquire_provider_call_permit(
  p_user_id uuid,
  p_source_id uuid,
  p_expected_account_deletion_epoch bigint,
  p_expected_source_deletion_epoch bigint,
  p_owner text,
  p_http_timeout_ms integer,
  p_max_response_bytes integer,
  p_permit_ttl_seconds integer,
  p_authorization_kind text,
  p_operation_kind text,
  p_operation_id_hash text default null,
  p_transition_id uuid default null,
  p_job_id uuid default null,
  p_worker text default null,
  p_expected_job_lease_sequence integer default null,
  p_direct_fallback_lease_token uuid default null,
  p_playback_session_id uuid default null
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_source public.cloud_sources%rowtype;
  v_transition public.cloud_source_transitions%rowtype;
  v_job public.cloud_source_credential_transition_jobs%rowtype;
  v_fallback public.cloud_source_direct_fallback_leases%rowtype;
  v_playback public.cloud_playback_sessions%rowtype;
  v_account_epoch bigint := 0;
  v_until timestamptz;
  v_permit public.cloud_provider_call_permits%rowtype;
begin
  perform public.norva_credential_require_service_role();
  if p_user_id is null or p_source_id is null
     or p_expected_account_deletion_epoch is null
     or p_expected_source_deletion_epoch is null
     or p_expected_account_deletion_epoch < 0
     or p_expected_source_deletion_epoch < 0
     or p_owner is null or btrim(p_owner) = '' or length(p_owner) > 160
     or p_http_timeout_ms is null or p_http_timeout_ms not between 1000 and 120000
     or p_max_response_bytes is null
     or p_max_response_bytes not between 1024 and 33554432
     or p_permit_ttl_seconds is null or p_permit_ttl_seconds not between 15 and 300
     or ((p_http_timeout_ms + 999) / 1000) + 10 >= p_permit_ttl_seconds
     or p_authorization_kind not in (
       'credential_job','direct_fallback','playback'
     ) or p_operation_kind not in (
       'account_info','catalog_page','metadata_spool',
       'playback_stream','direct_fallback'
     ) or (p_operation_kind = 'metadata_spool' and (
       p_operation_id_hash is null
       or p_operation_id_hash !~ '^[0-9a-f]{64}$'
     )) or (p_operation_id_hash is not null
       and p_operation_id_hash !~ '^[0-9a-f]{64}$') then
    raise exception 'provider call permit arguments are invalid'
      using errcode = '22023';
  end if;

  perform public.norva_credential_lock_account(p_user_id);
  select coalesce(preparation.deletion_epoch,0)
    into v_account_epoch
  from public.cloud_provider_account_delete_preparations preparation
  where preparation.user_id = p_user_id
  for share;
  if found or v_account_epoch <> p_expected_account_deletion_epoch then
    raise exception 'provider account deletion fence changed'
      using errcode = '40001',detail = 'reason=account_deletion_pending';
  end if;

  v_until := clock_timestamp() + make_interval(secs => p_permit_ttl_seconds);
  if p_authorization_kind = 'credential_job' then
    if p_transition_id is null or p_job_id is null or p_worker is null
       or btrim(p_worker) = '' or p_expected_job_lease_sequence is null
       or p_direct_fallback_lease_token is not null
       or p_playback_session_id is not null then
      raise exception 'credential job permit authority is incomplete'
        using errcode = '22023';
    end if;
    select transition.* into v_transition
    from public.cloud_source_transitions transition
    where transition.id = p_transition_id and transition.user_id = p_user_id
    for share;
    select job.* into v_job
    from public.cloud_source_credential_transition_jobs job
    where job.id = p_job_id and job.user_id = p_user_id
      and job.transition_id = p_transition_id and job.source_id = p_source_id
    for share;
    if v_transition.id is null or v_job.id is null
       or v_transition.state not in (
         'validating','staging','importing','ready_to_switch',
         'post_swap_verifying','compensating'
       )
       or v_job.state <> 'processing'
       or v_job.lease_owner is distinct from p_worker
       or v_job.lease_sequence <> p_expected_job_lease_sequence
       or v_job.lease_until <= v_until then
      raise exception 'provider call job lease CAS failed'
        using errcode = '40001',detail = 'reason=job_lease_stale';
    end if;
  elsif p_authorization_kind = 'direct_fallback' then
    if p_direct_fallback_lease_token is null or p_transition_id is not null
       or p_job_id is not null or p_worker is not null
       or p_expected_job_lease_sequence is not null
       or p_playback_session_id is not null then
      raise exception 'direct fallback permit authority is incomplete'
        using errcode = '22023';
    end if;
    select lease.* into v_fallback
    from public.cloud_source_direct_fallback_leases lease
    where lease.lease_token = p_direct_fallback_lease_token
      and lease.user_id = p_user_id and lease.source_id = p_source_id
    for share;
    if v_fallback.lease_token is null or v_fallback.lease_until <= v_until then
      raise exception 'direct fallback lease CAS failed'
        using errcode = '40001',detail = 'reason=fallback_lease_stale';
    end if;
  else
    if p_playback_session_id is null or p_transition_id is not null
       or p_job_id is not null or p_worker is not null
       or p_expected_job_lease_sequence is not null
       or p_direct_fallback_lease_token is not null then
      raise exception 'playback permit authority is incomplete'
        using errcode = '22023';
    end if;
  end if;

  select source.* into v_source
  from public.cloud_sources source
  where source.id = p_source_id and source.user_id = p_user_id
    and source.deleted_at is null
  for share;
  if not found or v_source.provider_deletion_pending
     or v_source.provider_deletion_epoch <> p_expected_source_deletion_epoch then
    raise exception 'provider source deletion fence changed'
      using errcode = '40001',detail = 'reason=source_deletion_pending';
  end if;
  if p_authorization_kind = 'playback' then
    select playback.* into v_playback
    from public.cloud_playback_sessions playback
    where playback.id = p_playback_session_id
      and playback.user_id = p_user_id and playback.source_id = p_source_id
    for share;
    if v_playback.id is null or v_playback.status not in ('pending','ready')
       or v_playback.expires_at <= v_until then
      raise exception 'playback session permit CAS failed'
        using errcode = '40001',detail = 'reason=playback_session_stale';
    end if;
  end if;

  insert into public.cloud_provider_call_permits(
    user_id,source_id,transition_id,job_id,direct_fallback_lease_token,
    playback_session_id,permit_owner,authorization_kind,
    expected_account_deletion_epoch,expected_source_deletion_epoch,
    expected_job_lease_sequence,max_http_timeout_ms,max_response_bytes,
    operation_kind,operation_id_hash,safety_margin_seconds,permit_until
  ) values (
    p_user_id,p_source_id,p_transition_id,p_job_id,
    p_direct_fallback_lease_token,p_playback_session_id,btrim(p_owner),
    p_authorization_kind,p_expected_account_deletion_epoch,
    p_expected_source_deletion_epoch,p_expected_job_lease_sequence,
    p_http_timeout_ms,p_max_response_bytes,p_operation_kind,
    p_operation_id_hash,10,v_until
  ) returning * into v_permit;
  return jsonb_build_object(
    'contract','provider-call-permit-v1','permitted',true,
    'permitId',v_permit.id,'permitToken',v_permit.permit_token,
    'userId',p_user_id,'sourceId',p_source_id,
    'authorizationKind',p_authorization_kind,
    'accountDeletionEpoch',p_expected_account_deletion_epoch,
    'sourceDeletionEpoch',p_expected_source_deletion_epoch,
    'permitUntil',v_permit.permit_until,
    'maxHttpTimeoutMs',p_http_timeout_ms,
    'maxResponseBytes',p_max_response_bytes,'safetyMarginSeconds',10
  );
end
$function$;

create or replace function public.norva_revalidate_provider_call_permit(
  p_permit_token uuid,
  p_owner text
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_identity record;
  v_permit public.cloud_provider_call_permits%rowtype;
  v_valid boolean := true;
  v_reason text := null;
  v_required_until timestamptz;
begin
  perform public.norva_credential_require_service_role();
  select permit.user_id,permit.source_id into v_identity
  from public.cloud_provider_call_permits permit
  where permit.permit_token = p_permit_token;
  if not found then
    raise exception 'provider call permit is unavailable' using errcode = 'P0002';
  end if;
  perform public.norva_credential_lock_account(v_identity.user_id);
  select permit.* into v_permit
  from public.cloud_provider_call_permits permit
  where permit.permit_token = p_permit_token
  for update;
  if not found or v_permit.permit_owner is distinct from btrim(p_owner) then
    raise exception 'provider call permit ownership CAS failed'
      using errcode = '40001';
  end if;
  v_required_until := clock_timestamp()
    + make_interval(secs => v_permit.safety_margin_seconds)
    + make_interval(secs => ((v_permit.max_http_timeout_ms + 999) / 1000));
  if v_permit.state <> 'active' or v_permit.permit_until <= v_required_until then
    v_valid := false; v_reason := 'permit_expired';
  elsif exists (
    select 1 from public.cloud_provider_account_delete_preparations preparation
    where preparation.user_id = v_permit.user_id
  ) then
    v_valid := false; v_reason := 'account_deletion_pending';
  elsif not exists (
    select 1 from public.cloud_sources source
    where source.id = v_permit.source_id and source.user_id = v_permit.user_id
      and source.deleted_at is null and not source.provider_deletion_pending
      and source.provider_deletion_epoch = v_permit.expected_source_deletion_epoch
  ) then
    v_valid := false; v_reason := 'source_deletion_pending';
  elsif v_permit.authorization_kind = 'credential_job' and not exists (
    select 1
    from public.cloud_source_credential_transition_jobs job
    join public.cloud_source_transitions transition
      on transition.id = job.transition_id and transition.user_id = job.user_id
    where job.id = v_permit.job_id and job.user_id = v_permit.user_id
      and job.source_id = v_permit.source_id
      and job.state = 'processing'
      and job.lease_sequence = v_permit.expected_job_lease_sequence
      and job.lease_until > v_required_until
      and transition.id = v_permit.transition_id
      and transition.state in (
        'validating','staging','importing','ready_to_switch',
        'post_swap_verifying','compensating'
      )
  ) then
    v_valid := false; v_reason := 'job_lease_stale';
  elsif v_permit.authorization_kind = 'direct_fallback' and not exists (
    select 1 from public.cloud_source_direct_fallback_leases lease
    where lease.lease_token = v_permit.direct_fallback_lease_token
      and lease.user_id = v_permit.user_id and lease.source_id = v_permit.source_id
      and lease.lease_until > v_required_until
  ) then
    v_valid := false; v_reason := 'fallback_lease_stale';
  elsif v_permit.authorization_kind = 'playback' and not exists (
    select 1 from public.cloud_playback_sessions playback
    where playback.id = v_permit.playback_session_id
      and playback.user_id = v_permit.user_id
      and playback.source_id = v_permit.source_id
      and playback.status in ('pending','ready')
      and playback.expires_at > v_required_until
  ) then
    v_valid := false; v_reason := 'playback_session_stale';
  end if;
  if not v_valid then
    update public.cloud_provider_call_permits permit
    set state = case when permit.permit_until <= clock_timestamp()
          then 'expired' else 'released' end,
        released_at = clock_timestamp(),updated_at = clock_timestamp()
    where permit.id = v_permit.id;
  else
    update public.cloud_provider_call_permits permit
    set updated_at = clock_timestamp() where permit.id = v_permit.id;
  end if;
  return jsonb_build_object(
    'contract','provider-call-permit-v1','permitId',v_permit.id,
    'permitted',v_valid,'reason',v_reason,
    'permitUntil',v_permit.permit_until,
    'maxHttpTimeoutMs',v_permit.max_http_timeout_ms,
    'maxResponseBytes',v_permit.max_response_bytes
  );
end
$function$;

create or replace function public.norva_renew_provider_call_permit(
  p_permit_token uuid,
  p_owner text,
  p_expected_permit_until timestamptz,
  p_permit_ttl_seconds integer
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_identity record;
  v_permit public.cloud_provider_call_permits%rowtype;
  v_new_until timestamptz;
begin
  perform public.norva_credential_require_service_role();
  if p_expected_permit_until is null or p_permit_ttl_seconds is null
     or p_permit_ttl_seconds not between 15 and 300 then
    raise exception 'provider call permit renewal arguments are invalid'
      using errcode = '22023';
  end if;
  select permit.user_id into v_identity
  from public.cloud_provider_call_permits permit
  where permit.permit_token = p_permit_token;
  if not found then
    raise exception 'provider call permit is unavailable' using errcode = 'P0002';
  end if;
  perform public.norva_credential_lock_account(v_identity.user_id);
  select permit.* into v_permit
  from public.cloud_provider_call_permits permit
  where permit.permit_token = p_permit_token for update;
  if not found or v_permit.state <> 'active'
     or v_permit.permit_owner is distinct from btrim(p_owner)
     or v_permit.permit_until is distinct from p_expected_permit_until
     or v_permit.permit_until <= clock_timestamp()
     or v_permit.operation_kind not in ('metadata_spool','playback_stream')
     or exists (
       select 1 from public.cloud_provider_account_delete_preparations preparation
       where preparation.user_id = v_permit.user_id
     ) or not exists (
       select 1 from public.cloud_sources source
       where source.id = v_permit.source_id and source.user_id = v_permit.user_id
         and source.deleted_at is null and not source.provider_deletion_pending
         and source.provider_deletion_epoch = v_permit.expected_source_deletion_epoch
     ) then
    raise exception 'provider call permit renewal CAS failed'
      using errcode = '40001';
  end if;
  v_new_until := clock_timestamp() + make_interval(secs => p_permit_ttl_seconds);
  if v_new_until <= clock_timestamp()
       + make_interval(secs => v_permit.safety_margin_seconds)
       + make_interval(secs => ((v_permit.max_http_timeout_ms + 999) / 1000))
     or (v_permit.authorization_kind = 'credential_job' and not exists (
       select 1 from public.cloud_source_credential_transition_jobs job
       join public.cloud_source_transitions transition
         on transition.id = job.transition_id and transition.user_id = job.user_id
       where job.id = v_permit.job_id and job.user_id = v_permit.user_id
         and job.state = 'processing'
         and job.lease_sequence = v_permit.expected_job_lease_sequence
         and job.lease_until > v_new_until
         and transition.id = v_permit.transition_id
         and transition.state in (
           'validating','staging','importing','ready_to_switch',
           'post_swap_verifying','compensating'
         )
     )) or (v_permit.authorization_kind = 'direct_fallback' and not exists (
       select 1 from public.cloud_source_direct_fallback_leases lease
       where lease.lease_token = v_permit.direct_fallback_lease_token
         and lease.user_id = v_permit.user_id
         and lease.lease_until > v_new_until
     )) or (v_permit.authorization_kind = 'playback' and not exists (
       select 1 from public.cloud_playback_sessions playback
       where playback.id = v_permit.playback_session_id
         and playback.user_id = v_permit.user_id
         and playback.status in ('pending','ready')
         and playback.expires_at > v_new_until
     )) then
    raise exception 'provider call permit renewal authority is stale'
      using errcode = '40001';
  end if;
  update public.cloud_provider_call_permits permit
  set permit_until = v_new_until,updated_at = clock_timestamp()
  where permit.id = v_permit.id;
  return jsonb_build_object(
    'contract','provider-call-permit-v1','permitId',v_permit.id,
    'renewed',true,'permitUntil',v_new_until,
    'maxHttpTimeoutMs',v_permit.max_http_timeout_ms,
    'maxResponseBytes',v_permit.max_response_bytes
  );
end
$function$;

create or replace function public.norva_release_provider_call_permit(
  p_permit_token uuid,
  p_owner text
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_identity record;
  v_permit public.cloud_provider_call_permits%rowtype;
begin
  perform public.norva_credential_require_service_role();
  select permit.user_id into v_identity
  from public.cloud_provider_call_permits permit
  where permit.permit_token = p_permit_token;
  if not found then
    return jsonb_build_object(
      'contract','provider-call-permit-v1','released',true,'replayed',true
    );
  end if;
  perform public.norva_credential_lock_account(v_identity.user_id);
  select permit.* into v_permit
  from public.cloud_provider_call_permits permit
  where permit.permit_token = p_permit_token for update;
  if not found then
    return jsonb_build_object(
      'contract','provider-call-permit-v1','released',true,'replayed',true
    );
  end if;
  if v_permit.permit_owner is distinct from btrim(p_owner) then
    raise exception 'provider call permit ownership CAS failed'
      using errcode = '40001';
  end if;
  if v_permit.state = 'active' then
    update public.cloud_provider_call_permits permit
    set state = 'released',released_at = clock_timestamp(),
        updated_at = clock_timestamp()
    where permit.id = v_permit.id;
  end if;
  delete from public.cloud_provider_call_permits permit
  where permit.id = v_permit.id and permit.state in ('released','expired');
  return jsonb_build_object(
    'contract','provider-call-permit-v1','permitId',v_permit.id,
    'released',true,'replayed',v_permit.state <> 'active'
  );
end
$function$;

-- Preserve the rolling signature while making deletion_pending an explicit
-- secret-read fence.  A ciphertext decrypted before deletion still cannot be
-- used legally: provider I/O additionally requires a freshly revalidated
-- permit from the contract above.
create or replace function public.norva_read_credential_transition_secret(
  p_transition_id uuid,
  p_user_id uuid,
  p_purpose text
) returns text
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_secret_row public.cloud_source_transition_secrets%rowtype;
  v_secret text;
begin
  perform public.norva_credential_require_service_role();
  perform public.norva_credential_lock_account(p_user_id);
  if exists (
    select 1 from public.cloud_provider_account_delete_preparations preparation
    where preparation.user_id = p_user_id
  ) then
    raise exception 'credential secret blocked by account deletion'
      using errcode = '40001',detail = 'reason=account_deletion_pending';
  end if;
  select secret.* into v_secret_row
  from public.cloud_source_transition_secrets secret
  join public.cloud_sources source
    on source.id = secret.source_id and source.user_id = secret.user_id
  where secret.transition_id = p_transition_id and secret.user_id = p_user_id
    and not source.provider_deletion_pending
    and source.deleted_at is null;
  if not found then
    raise exception 'credential transition secret unavailable'
      using errcode = 'P0002';
  end if;
  if p_purpose = 'candidate' then
    v_secret := v_secret_row.candidate_config_ciphertext;
  elsif p_purpose = 'previous' then
    v_secret := v_secret_row.previous_config_ciphertext;
  else
    raise exception 'invalid credential secret purpose' using errcode = '22023';
  end if;
  if v_secret is null then
    raise exception 'credential transition secret unavailable'
      using errcode = 'P0002';
  end if;
  return v_secret;
end
$function$;

create or replace function public.norva_claim_provider_transport_stop_action(
  p_user_id uuid,
  p_worker text,
  p_lease_seconds integer default 120
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_preparation public.cloud_provider_account_delete_preparations%rowtype;
  v_action public.cloud_provider_transport_stop_actions%rowtype;
  v_failures integer;
begin
  perform public.norva_credential_require_service_role();
  if nullif(btrim(p_worker),'') is null or length(btrim(p_worker)) > 160
     or p_lease_seconds is null or p_lease_seconds not between 30 and 300 then
    raise exception 'provider transport stop claim arguments are invalid'
      using errcode = '22023';
  end if;
  perform public.norva_credential_lock_account(p_user_id);
  select preparation.* into v_preparation
  from public.cloud_provider_account_delete_preparations preparation
  where preparation.user_id = p_user_id for share;
  if not found or v_preparation.state in ('ready','dead') then
    raise exception 'provider transport stop preparation is unavailable'
      using errcode = '40001';
  end if;
  select action.* into v_action
  from public.cloud_provider_transport_stop_actions action
  where action.user_id = p_user_id for update;
  if not found or v_action.deletion_epoch <> v_preparation.deletion_epoch then
    raise exception 'provider transport stop action is stale'
      using errcode = '40001';
  end if;
  if v_action.state = 'completed' then
    return jsonb_build_object(
      'contract','provider-transport-stop-v1','userId',p_user_id,
      'state','completed','completed',true,'revision',v_action.revision
    );
  end if;
  if v_action.state = 'dead'
     or (v_action.state = 'processing' and v_action.lease_until > now())
     or v_action.available_at > now() then
    raise exception 'provider transport stop action is not claimable'
      using errcode = '40001';
  end if;
  v_failures := v_action.failure_attempt_count
    + case when v_action.state = 'processing' then 1 else 0 end;
  if v_failures >= v_action.max_attempts then
    update public.cloud_provider_transport_stop_actions action
    set state = 'dead',lease_owner = null,lease_until = null,
        failure_attempt_count = v_failures,last_error_code = 'lease_expired',
        revision = action.revision + 1,updated_at = now()
    where action.user_id = p_user_id returning * into v_action;
    return jsonb_build_object(
      'contract','provider-transport-stop-v1','userId',p_user_id,
      'state','dead','dead',true,'revision',v_action.revision
    );
  end if;
  update public.cloud_provider_transport_stop_actions action
  set state = 'processing',lease_sequence = action.lease_sequence + 1,
      lease_owner = btrim(p_worker),
      lease_until = now() + make_interval(secs => p_lease_seconds),
      failure_attempt_count = v_failures,
      last_error_code = case when v_action.state = 'processing'
        then 'lease_expired' else null end,
      revision = action.revision + 1,updated_at = now()
  where action.user_id = p_user_id returning * into v_action;
  return jsonb_build_object(
    'contract','provider-transport-stop-v1','userId',p_user_id,
    'state','processing','deletionEpoch',v_action.deletion_epoch,
    'revision',v_action.revision,'leaseSequence',v_action.lease_sequence,
    'leaseUntil',v_action.lease_until,'completed',false
  );
end
$function$;

create or replace function public.norva_settle_provider_transport_stop_action(
  p_user_id uuid,
  p_worker text,
  p_expected_lease_sequence integer,
  p_expected_revision bigint,
  p_outcome text,
  p_transport_stop_receipt_hash text default null,
  p_error_code text default null,
  p_retry_after_seconds integer default 10
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_preparation public.cloud_provider_account_delete_preparations%rowtype;
  v_action public.cloud_provider_transport_stop_actions%rowtype;
  v_outcome text := lower(coalesce(p_outcome,''));
  v_failures integer;
  v_state text;
begin
  perform public.norva_credential_require_service_role();
  if v_outcome not in ('completed','retry','dead')
     or p_retry_after_seconds not between 0 and 300
     or (v_outcome = 'completed' and (
       p_transport_stop_receipt_hash is null
       or p_transport_stop_receipt_hash !~ '^[0-9a-f]{64}$'
     )) or (v_outcome <> 'completed' and (
       p_error_code is null or p_error_code !~ '^[a-z0-9_]{1,80}$'
     )) then
    raise exception 'provider transport stop settle arguments are invalid'
      using errcode = '22023';
  end if;
  perform public.norva_credential_lock_account(p_user_id);
  select preparation.* into v_preparation
  from public.cloud_provider_account_delete_preparations preparation
  where preparation.user_id = p_user_id for share;
  select action.* into v_action
  from public.cloud_provider_transport_stop_actions action
  where action.user_id = p_user_id for update;
  if v_preparation.user_id is null or v_action.user_id is null
     or v_action.deletion_epoch <> v_preparation.deletion_epoch
     or v_action.state <> 'processing'
     or v_action.lease_owner is distinct from btrim(p_worker)
     or v_action.lease_sequence <> p_expected_lease_sequence
     or v_action.revision <> p_expected_revision
     or v_action.lease_until <= now() then
    raise exception 'provider transport stop settle lease CAS failed'
      using errcode = '40001';
  end if;
  if v_outcome = 'completed' and exists (
    select 1
    from public.cloud_provider_call_permits permit
    where permit.user_id = p_user_id and permit.state = 'active'
      and permit.permit_until > clock_timestamp()
    union all
    select 1
    from public.cloud_source_direct_fallback_leases lease
    where lease.user_id = p_user_id and lease.lease_until > clock_timestamp()
    union all
    select 1
    from public.cloud_playback_sessions playback
    where playback.user_id = p_user_id
      and playback.status in ('pending','ready')
      and playback.expires_at > clock_timestamp()
    union all
    select 1
    from public.cloud_gateway_sessions gateway
    where gateway.user_id = p_user_id
      and gateway.status in ('pending','starting','ready')
      and gateway.expires_at > clock_timestamp()
    limit 1
  ) then
    raise exception 'provider transport stop proof still has active capability'
      using errcode = '40001',detail = 'reason=provider_transport_active';
  end if;
  v_failures := v_action.failure_attempt_count
    + case when v_outcome in ('retry','dead') then 1 else 0 end;
  v_state := case
    when v_outcome = 'completed' then 'completed'
    when v_outcome = 'dead' or v_failures >= v_action.max_attempts then 'dead'
    else 'pending'
  end;
  update public.cloud_provider_transport_stop_actions action
  set state = v_state,lease_owner = null,lease_until = null,
      failure_attempt_count = v_failures,
      available_at = case when v_state = 'pending'
        then now() + make_interval(secs => p_retry_after_seconds)
        else action.available_at end,
      completed_at = case when v_state = 'completed' then now() else null end,
      transport_stop_receipt_hash = case when v_state = 'completed'
        then p_transport_stop_receipt_hash else null end,
      last_error_code = case when v_state = 'completed' then null
        else p_error_code end,
      revision = action.revision + 1,updated_at = now()
  where action.user_id = p_user_id returning * into v_action;
  return jsonb_build_object(
    'contract','provider-transport-stop-v1','userId',p_user_id,
    'state',v_action.state,'revision',v_action.revision,
    'failureAttemptCount',v_action.failure_attempt_count,
    'completed',v_action.state = 'completed'
  );
end
$function$;

create or replace function public.norva_provider_account_delete_rows_bounded(
  p_relation regclass,
  p_column name,
  p_value uuid,
  p_limit integer
) returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_deleted integer := 0;
  v_context jsonb;
  v_preparation public.cloud_provider_account_delete_preparations%rowtype;
  v_key_columns name[];
  v_key_candidate text;
  v_key_cursor text;
  v_key_order text;
  v_key_json text;
  v_cursor jsonb := '{}'::jsonb;
  v_next_cursor jsonb := '{}'::jsonb;
  v_index_ready boolean := false;
begin
  if p_relation is null or p_column is null or p_value is null
     or p_limit is null or p_limit < 1 or p_limit > 5000 then
    raise exception 'bounded account-delete arguments are invalid'
      using errcode = '22023';
  end if;

  begin
    v_context := current_setting(
      'norva.provider_account_delete_batch',true
    )::jsonb;
  exception when others then
    v_context := null;
  end;
  if v_context is null
     or nullif(v_context->>'userId','')::uuid is distinct from
       (select preparation.user_id
        from public.cloud_provider_account_delete_preparations preparation
        where preparation.user_id = nullif(v_context->>'userId','')::uuid)
     or nullif(v_context->>'userId','')::uuid is distinct from p_value
       and p_column = 'user_id'::name then
    raise exception 'bounded account-delete context is unavailable'
      using errcode = '40001';
  end if;

  select preparation.* into v_preparation
  from public.cloud_provider_account_delete_preparations preparation
  where preparation.user_id = (v_context->>'userId')::uuid
  for update;
  if not found or v_preparation.state <> 'processing'
     or v_preparation.lease_owner is distinct from v_context->>'worker'
     or v_preparation.lease_sequence is distinct from
       nullif(v_context->>'leaseSequence','')::integer
     or v_preparation.lease_until <= now() then
    raise exception 'bounded account-delete lease context is stale'
      using errcode = '40001';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_attribute attribute
    where attribute.attrelid = p_relation
      and attribute.attname = p_column
      and attribute.atttypid = 'uuid'::pg_catalog.regtype
      and attribute.attnum > 0 and not attribute.attisdropped
  ) then
    raise exception 'bounded account-delete filter is not a UUID column'
      using errcode = '22023';
  end if;

  select coalesce(
    pg_catalog.array_agg(attribute.attname::name order by key_column.ordinality)
      filter (where attribute.attname is not null
        and attribute.attname <> p_column),
    '{}'::name[]
  ) into v_key_columns
  from pg_catalog.pg_index primary_index
  left join lateral pg_catalog.unnest(primary_index.indkey)
    with ordinality key_column(attnum,ordinality) on true
  left join pg_catalog.pg_attribute attribute
    on attribute.attrelid = p_relation
   and attribute.attnum = key_column.attnum
  where primary_index.indrelid = p_relation
    and primary_index.indisprimary;
  if v_key_columns is null then
    raise exception 'bounded account-delete relation has no primary key'
      using errcode = '55000';
  end if;

  select exists (
    select 1
    from pg_catalog.pg_index index_state
    join pg_catalog.pg_class index_class
      on index_class.oid = index_state.indexrelid
    join pg_catalog.pg_am access_method
      on access_method.oid = index_class.relam
    where index_state.indrelid = p_relation
      and access_method.amname = 'btree'
      and index_state.indisvalid and index_state.indisready
      and index_state.indexprs is null and index_state.indpred is null
      and (
        select pg_catalog.array_agg(attribute.attname::text order by key_column.ordinality)
        from pg_catalog.unnest(index_state.indkey)
          with ordinality key_column(attnum,ordinality)
        join pg_catalog.pg_attribute attribute
          on attribute.attrelid = index_state.indrelid
         and attribute.attnum = key_column.attnum
      )[1:1 + pg_catalog.cardinality(v_key_columns)]
        = array[p_column::text]
          || v_key_columns::text[]
  ) into v_index_ready;
  if not v_index_ready then
    raise exception 'bounded account-delete keyset index is unavailable'
      using errcode = '55000',
            detail = 'relation=' || p_relation::text
              || ',filter=' || p_column::text;
  end if;

  if v_preparation.delete_relation = p_relation::text
     and v_preparation.delete_filter_column = p_column
     and v_preparation.delete_filter_value = p_value then
    v_cursor := v_preparation.delete_cursor;
  end if;

  if pg_catalog.cardinality(v_key_columns) = 0 then
    execute pg_catalog.format(
      'with doomed as materialized ('
        'select candidate.ctid from %s candidate '
        'where candidate.%I = $1 limit $2 for update), '
      'deleted as ('
        'delete from %s target using doomed '
        'where target.ctid = doomed.ctid returning 1) '
      'select count(*)::integer from deleted',
      p_relation,p_column,p_relation
    ) into v_deleted using p_value,p_limit;
    v_next_cursor := '{}'::jsonb;
  else
    select
      pg_catalog.string_agg(
        pg_catalog.format('candidate.%I',key_column),','
        order by ordinal_position
      ),
      pg_catalog.string_agg(
        pg_catalog.format('cursor_row.%I',key_column),','
        order by ordinal_position
      ),
      pg_catalog.string_agg(
        pg_catalog.format('locked.%I',key_column),','
        order by ordinal_position
      ),
      pg_catalog.string_agg(
        pg_catalog.format('%L,candidate.%I',key_column,key_column),','
        order by ordinal_position
      )
    into v_key_candidate,v_key_cursor,v_key_order,v_key_json
    from pg_catalog.unnest(v_key_columns)
      with ordinality key_state(key_column,ordinal_position);

    execute pg_catalog.format(
      'with cursor_value as materialized ('
        'select cursor_row.* from pg_catalog.jsonb_populate_record('
          'null::%s,$3) cursor_row), '
      'locked as materialized ('
        'select candidate.ctid,%s,'
          'pg_catalog.jsonb_build_object(%s) as key_cursor '
        'from %s candidate cross join cursor_value cursor_row '
        'where candidate.%I = $1 '
          'and ($3 = ''{}''::jsonb or (%s) > (%s)) '
        'order by %s limit $2 for update of candidate), '
      'numbered as ('
        'select locked.*,pg_catalog.row_number() over ('
          'order by %s) as ordinal_position from locked), '
      'deleted as ('
        'delete from %s target using numbered '
        'where target.ctid = numbered.ctid '
        'returning numbered.key_cursor,numbered.ordinal_position) '
      'select count(*)::integer,'
        'coalesce((pg_catalog.array_agg(key_cursor '
          'order by ordinal_position desc))[1],$3) '
      'from deleted',
      p_relation,v_key_candidate,v_key_json,p_relation,p_column,
      v_key_candidate,v_key_cursor,v_key_candidate,
      v_key_order,p_relation
    ) into v_deleted,v_next_cursor using p_value,p_limit,v_cursor;
  end if;

  update public.cloud_provider_account_delete_preparations preparation
  set delete_relation = p_relation::text,
      delete_filter_column = p_column,
      delete_filter_value = p_value,
      delete_cursor = v_next_cursor,
      updated_at = now()
  where preparation.user_id = v_preparation.user_id;
  return v_deleted;
end
$function$;

create or replace function public.norva_provider_account_delete_proof_ready(
  p_user_id uuid
) returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select p_user_id is not null
    and not exists (select 1 from public.cloud_catalog_background_owner_build_jobs where user_id = p_user_id)
    and not exists (select 1 from public.cloud_catalog_background_owner_snapshots where user_id = p_user_id)
    and not exists (select 1 from public.cloud_catalog_background_owner_pointers where user_id = p_user_id)
    and not exists (select 1 from public.catalog_enrichment_source_schedule where user_id = p_user_id)
    and not exists (select 1 from public.catalog_source_provider_identities where user_id = p_user_id)
    and not exists (select 1 from public.cloud_source_catalog_heads where user_id = p_user_id)
    and not exists (select 1 from public.cloud_media_items where user_id = p_user_id)
    and not exists (select 1 from public.cloud_title_variants where user_id = p_user_id)
    and not exists (select 1 from public.cloud_live_logical_channels where user_id = p_user_id)
    and not exists (select 1 from public.cloud_live_variants where user_id = p_user_id)
    and not exists (select 1 from public.catalog_series_episode_memberships where user_id = p_user_id)
    and not exists (select 1 from public.catalog_series_inventory_state where user_id = p_user_id)
    and not exists (select 1 from public.cloud_title_file_language_observations where user_id = p_user_id)
    and not exists (select 1 from public.cloud_title_overrides where user_id = p_user_id)
    and not exists (select 1 from public.cloud_title_rating_operations where user_id = p_user_id)
    and not exists (select 1 from public.cloud_title_ratings where user_id = p_user_id)
    and not exists (select 1 from public.cloud_favorites where user_id = p_user_id)
    and not exists (select 1 from public.cloud_titles where user_id = p_user_id)
    and not exists (select 1 from public.cloud_source_catalog_title_refresh_actions where user_id = p_user_id)
    and not exists (select 1 from public.cloud_source_catalog_title_refresh_checkpoints where user_id = p_user_id)
    and not exists (select 1 from public.cloud_source_catalog_manifest_seal_progress where user_id = p_user_id)
    and not exists (select 1 from public.cloud_source_catalog_generation_candidate_titles where user_id = p_user_id)
    and not exists (select 1 from public.cloud_source_catalog_generation_title_promotions where user_id = p_user_id)
    and not exists (select 1 from public.cloud_source_catalog_generation_inventory_actions where user_id = p_user_id)
    and not exists (select 1 from public.cloud_source_catalog_generation_episode_copy where user_id = p_user_id)
    and not exists (select 1 from public.cloud_source_catalog_generation_category_lists where user_id = p_user_id)
    and not exists (select 1 from public.cloud_source_catalog_generation_categories where user_id = p_user_id)
    and not exists (select 1 from public.cloud_source_credential_transition_jobs where user_id = p_user_id)
    and not exists (select 1 from public.cloud_source_catalog_generations where user_id = p_user_id)
    and not exists (select 1 from public.cloud_source_transition_secrets where user_id = p_user_id)
    and not exists (select 1 from public.cloud_source_credential_transition_actions where user_id = p_user_id)
    and not exists (select 1 from public.cloud_source_identity_assessments where user_id = p_user_id)
    and not exists (select 1 from public.cloud_source_lifecycle_events where user_id = p_user_id)
    and not exists (select 1 from public.cloud_source_transitions where user_id = p_user_id)
    and not exists (select 1 from public.cloud_source_provider_access where user_id = p_user_id)
    and not exists (select 1 from public.cloud_source_access_cycles where user_id = p_user_id)
    and not exists (select 1 from public.cloud_source_lifecycle where user_id = p_user_id)
    and not exists (select 1 from public.cloud_sources where user_id = p_user_id)
    and not exists (select 1 from public.cloud_provider_call_permits where user_id = p_user_id)
    and not exists (select 1 from public.cloud_source_direct_fallback_leases where user_id = p_user_id)
    and not exists (select 1 from public.cloud_gateway_sessions where user_id = p_user_id)
    and not exists (select 1 from public.cloud_relay_tokens where user_id = p_user_id)
    and not exists (select 1 from public.cloud_playback_events where user_id = p_user_id)
    and not exists (select 1 from public.cloud_playback_sessions where user_id = p_user_id)
    and not exists (select 1 from public.cloud_watch_history where user_id = p_user_id)
    and exists (
      select 1 from public.cloud_provider_transport_stop_actions action
      where action.user_id = p_user_id and action.state = 'completed'
        and action.completed_at is not null
        and action.transport_stop_receipt_hash ~ '^[0-9a-f]{64}$'
    )
$function$;

create or replace function public.norva_begin_provider_account_deletion_prepare(
  p_user_id uuid
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_preparation public.cloud_provider_account_delete_preparations%rowtype;
begin
  perform public.norva_credential_require_service_role();
  perform 1 from auth.users account where account.id = p_user_id for update;
  if not found then
    raise exception 'provider account deletion user is unavailable'
      using errcode = 'P0002';
  end if;
  select preparation.* into v_preparation
  from public.cloud_provider_account_delete_preparations preparation
  where preparation.user_id = p_user_id
  for update;
  if not found then
    insert into public.cloud_provider_account_delete_preparations(
      user_id,state,phase,deletion_epoch
    ) values (p_user_id,'pending','drain',1)
    returning * into v_preparation;
  elsif v_preparation.state = 'dead' then
    raise exception 'provider account deletion preparation is terminally dead'
      using errcode = '55000';
  end if;
  insert into public.cloud_provider_transport_stop_actions(
    user_id,deletion_epoch
  ) values (p_user_id,v_preparation.deletion_epoch)
  on conflict (user_id) do nothing;

  return jsonb_build_object(
    'contract','provider-account-delete-prepare-v1',
    'userId',v_preparation.user_id,'state',v_preparation.state,
    'phase',v_preparation.phase,'revision',v_preparation.revision,
    'deletionEpoch',v_preparation.deletion_epoch,
    'deletedRows',v_preparation.deleted_rows,
    'mutatedRows',v_preparation.mutated_rows,
    'failureAttemptCount',v_preparation.failure_attempt_count,
    'ready',v_preparation.state = 'ready'
  );
end
$function$;

create or replace function public.norva_claim_provider_account_deletion_prepare(
  p_user_id uuid,
  p_worker text,
  p_lease_seconds integer default 120
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_preparation public.cloud_provider_account_delete_preparations%rowtype;
begin
  perform public.norva_credential_require_service_role();
  if nullif(btrim(p_worker),'') is null or length(btrim(p_worker)) > 160
     or p_lease_seconds is null or p_lease_seconds not between 30 and 300 then
    raise exception 'provider account deletion claim arguments are invalid'
      using errcode = '22023';
  end if;
  perform 1 from auth.users account where account.id = p_user_id for key share;
  if not found then raise exception 'provider account deletion user is unavailable' using errcode = 'P0002'; end if;
  select preparation.* into v_preparation
  from public.cloud_provider_account_delete_preparations preparation
  where preparation.user_id = p_user_id
  for update;
  if not found then
    raise exception 'provider account deletion preparation was not begun'
      using errcode = '55000';
  end if;
  if v_preparation.state = 'ready' then
    return jsonb_build_object(
      'contract','provider-account-delete-prepare-v1',
      'userId',p_user_id,'state','ready','ready',true,
      'revision',v_preparation.revision,
      'deletionEpoch',v_preparation.deletion_epoch,
      'deletedRows',v_preparation.deleted_rows,
      'mutatedRows',v_preparation.mutated_rows
    );
  end if;
  if v_preparation.state = 'dead'
     or (v_preparation.state = 'processing' and v_preparation.lease_until > now())
     or v_preparation.available_at > now() then
    raise exception 'provider account deletion preparation is not claimable'
      using errcode = '40001';
  end if;
  if v_preparation.state = 'processing' then
    v_preparation.failure_attempt_count :=
      v_preparation.failure_attempt_count + 1;
  end if;
  if v_preparation.failure_attempt_count >= v_preparation.max_attempts then
    update public.cloud_provider_account_delete_preparations preparation
    set state = 'dead',lease_owner = null,lease_until = null,
        failure_attempt_count = v_preparation.failure_attempt_count,
        last_error_code = 'lease_expired',revision = revision + 1,
        updated_at = now()
    where preparation.user_id = p_user_id
    returning * into v_preparation;
    return jsonb_build_object(
      'contract','provider-account-delete-prepare-v1',
      'userId',p_user_id,'state','dead','dead',true,
      'phase',v_preparation.phase,'revision',v_preparation.revision,
      'deletionEpoch',v_preparation.deletion_epoch,
      'failureAttemptCount',v_preparation.failure_attempt_count,
      'lastErrorCode','lease_expired','ready',false
    );
  end if;
  update public.cloud_provider_account_delete_preparations preparation
  set state = 'processing',lease_sequence = lease_sequence + 1,
      lease_owner = btrim(p_worker),
      lease_until = now() + make_interval(secs => p_lease_seconds),
      failure_attempt_count = v_preparation.failure_attempt_count,
      last_error_code = case when v_preparation.state = 'processing'
        then 'lease_expired' else null end,
      revision = revision + 1,updated_at = now()
  where preparation.user_id = p_user_id
  returning * into v_preparation;
  return jsonb_build_object(
    'contract','provider-account-delete-prepare-v1',
    'userId',p_user_id,'state',v_preparation.state,
    'phase',v_preparation.phase,'revision',v_preparation.revision,
    'deletionEpoch',v_preparation.deletion_epoch,
    'leaseSequence',v_preparation.lease_sequence,
    'leaseUntil',v_preparation.lease_until,
    'deletedRows',v_preparation.deleted_rows,
    'mutatedRows',v_preparation.mutated_rows,
    'failureAttemptCount',v_preparation.failure_attempt_count,
    'ready',false
  );
end
$function$;

create or replace function public.norva_run_provider_account_deletion_prepare_batch(
  p_user_id uuid,
  p_worker text,
  p_expected_lease_sequence integer,
  p_expected_revision bigint,
  p_limit integer default 1000
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_preparation public.cloud_provider_account_delete_preparations%rowtype;
  v_generation_id uuid;
  v_source_id uuid;
  v_budget integer := p_limit;
  v_deleted integer := 0;
  v_mutated integer := 0;
  v_count integer := 0;
  v_loops integer := 0;
  v_owner_fence text;
  v_waiting boolean := false;
begin
  perform public.norva_credential_require_service_role();
  if nullif(btrim(p_worker),'') is null or p_limit is null
     or p_limit not between 1 and 5000 then
    raise exception 'provider account deletion batch arguments are invalid'
      using errcode = '22023';
  end if;
  perform 1 from auth.users account where account.id = p_user_id for key share;
  if not found then raise exception 'provider account deletion user is unavailable' using errcode = 'P0002'; end if;
  select preparation.* into v_preparation
  from public.cloud_provider_account_delete_preparations preparation
  where preparation.user_id = p_user_id
  for update;
  if not found or v_preparation.state <> 'processing'
     or v_preparation.lease_owner is distinct from btrim(p_worker)
     or v_preparation.lease_sequence <> p_expected_lease_sequence
     or v_preparation.revision <> p_expected_revision
     or v_preparation.lease_until <= now() then
    raise exception 'provider account deletion batch lease CAS failed'
      using errcode = '40001';
  end if;
  perform set_config(
    'norva.provider_account_delete_batch',
    jsonb_build_object(
      'userId',p_user_id,'worker',btrim(p_worker),
      'leaseSequence',p_expected_lease_sequence
    )::text,true
  );
  v_owner_fence := coalesce(current_setting(
    'norva.catalog_background_owner_deleted_users',true
  ),'|');
  perform set_config(
    'norva.catalog_background_owner_deleted_users',
    v_owner_fence || p_user_id::text || '|',true
  );

  while v_budget > 0 and v_preparation.phase <> 'ready' and v_loops < 32 loop
    v_loops := v_loops + 1;
    if v_preparation.phase = 'drain' then
      with expired as (
        select permit.id
        from public.cloud_provider_call_permits permit
        where permit.user_id = p_user_id and permit.state = 'active'
          and permit.permit_until <= clock_timestamp()
        order by permit.permit_until,permit.id
        for update skip locked
        limit v_budget
      )
      update public.cloud_provider_call_permits permit
      set state = 'expired',released_at = clock_timestamp(),
          updated_at = clock_timestamp()
      from expired where permit.id = expired.id;
      get diagnostics v_count = row_count;
      v_mutated := v_mutated + v_count; v_budget := v_budget - v_count;
      if exists (
        select 1
        from public.cloud_source_credential_transition_jobs job
        where job.user_id = p_user_id and job.state = 'processing'
          and job.lease_until > now()
        union all
        select 1
        from public.cloud_catalog_background_owner_build_jobs job
        where job.user_id = p_user_id and job.state = 'processing'
          and job.lease_until > now()
        union all
        select 1
        from public.cloud_source_direct_fallback_leases lease
        where lease.user_id = p_user_id
          and lease.lease_until > clock_timestamp()
        union all
        select 1
        from public.cloud_provider_call_permits permit
        where permit.user_id = p_user_id and permit.state = 'active'
          and permit.permit_until > clock_timestamp()
        union all
        select 1
        from public.cloud_playback_sessions playback
        where playback.user_id = p_user_id
          and playback.status in ('pending','ready')
          and playback.expires_at > clock_timestamp()
        union all
        select 1
        from public.cloud_gateway_sessions gateway
        where gateway.user_id = p_user_id
          and gateway.status in ('pending','starting','ready')
          and gateway.expires_at > clock_timestamp()
        limit 1
      ) then
        v_waiting := true;
        exit;
      end if;
      if not exists (
        select 1
        from public.cloud_provider_transport_stop_actions action
        where action.user_id = p_user_id
          and action.deletion_epoch = v_preparation.deletion_epoch
          and action.state = 'completed'
          and action.completed_at is not null
          and action.transport_stop_receipt_hash ~ '^[0-9a-f]{64}$'
      ) then
        v_waiting := true;
        exit;
      end if;
      v_preparation.phase := 'sources_pending';

    elsif v_preparation.phase = 'sources_pending' then
      with candidates as (
        select source.id
        from public.cloud_sources source
        where source.user_id = p_user_id
          and not source.provider_deletion_pending
        order by source.id
        for update skip locked
        limit v_budget
      )
      update public.cloud_sources source
      set provider_deletion_pending = true,
          provider_deletion_epoch = source.provider_deletion_epoch + 1
      from candidates where source.id = candidates.id;
      get diagnostics v_count = row_count;
      v_mutated := v_mutated + v_count; v_budget := v_budget - v_count;
      if not exists (
        select 1 from public.cloud_sources source
        where source.user_id = p_user_id
          and not source.provider_deletion_pending
      ) then
        v_preparation.phase := 'playback';
      else
        exit;
      end if;

    elsif v_preparation.phase = 'playback' then
      v_count := public.norva_provider_account_delete_rows_bounded(
        'public.cloud_provider_call_permits','user_id',p_user_id,v_budget
      ); v_deleted := v_deleted + v_count; v_mutated := v_mutated + v_count;
      v_budget := v_budget - v_count;
      if v_budget > 0 then v_count := public.norva_provider_account_delete_rows_bounded(
        'public.cloud_gateway_sessions','user_id',p_user_id,v_budget
      ); v_deleted := v_deleted + v_count; v_mutated := v_mutated + v_count;
      v_budget := v_budget - v_count; end if;
      if v_budget > 0 then v_count := public.norva_provider_account_delete_rows_bounded(
        'public.cloud_relay_tokens','user_id',p_user_id,v_budget
      ); v_deleted := v_deleted + v_count; v_mutated := v_mutated + v_count;
      v_budget := v_budget - v_count; end if;
      if v_budget > 0 then
        with playback_candidates as materialized (
          select event.id
          from public.cloud_playback_events event
          where event.user_id = p_user_id
          order by event.id limit v_budget
        ), locked_paywall as materialized (
          select child.id
          from playback_candidates candidate
          join lateral (
            select paywall.id
            from public.paywall_funnel_events paywall
            where paywall.playback_event_id = candidate.id
            order by paywall.id limit v_budget for update of paywall
          ) child on true
          order by candidate.id,child.id limit v_budget
        )
        update public.paywall_funnel_events paywall
        set playback_event_id = null
        from locked_paywall locked
        where paywall.id = locked.id;
        get diagnostics v_count = row_count;
        v_mutated := v_mutated + v_count; v_budget := v_budget - v_count;
      end if;
      if v_budget > 0 then
        with locked_events as materialized (
          select event.ctid
          from public.cloud_playback_events event
          where event.user_id = p_user_id
            and not exists (
              select 1 from public.paywall_funnel_events paywall
              where paywall.playback_event_id = event.id
            )
          order by event.id limit v_budget for update of event
        ), deleted as (
          delete from public.cloud_playback_events event
          using locked_events locked where event.ctid = locked.ctid
          returning 1
        ) select count(*)::integer into v_count from deleted;
        v_deleted := v_deleted + v_count; v_mutated := v_mutated + v_count;
        v_budget := v_budget - v_count;
      end if;
      if v_budget > 0 then
        with locked_playback as materialized (
          select playback.ctid
          from public.cloud_playback_sessions playback
          where playback.user_id = p_user_id
            and not exists (
              select 1 from public.cloud_provider_call_permits permit
              where permit.playback_session_id = playback.id
            )
            and not exists (
              select 1 from public.cloud_gateway_sessions gateway
              where gateway.playback_session_id = playback.id
            )
            and not exists (
              select 1 from public.cloud_relay_tokens relay
              where relay.playback_session_id = playback.id
            )
            and not exists (
              select 1 from public.cloud_playback_events event
              where event.playback_session_id = playback.id
            )
          order by playback.id limit v_budget for update of playback
        ), deleted as (
          delete from public.cloud_playback_sessions playback
          using locked_playback locked where playback.ctid = locked.ctid
          returning 1
        ) select count(*)::integer into v_count from deleted;
        v_deleted := v_deleted + v_count; v_mutated := v_mutated + v_count;
        v_budget := v_budget - v_count;
      end if;
      if v_budget > 0 then v_count := public.norva_provider_account_delete_rows_bounded(
        'public.cloud_source_direct_fallback_leases','user_id',p_user_id,v_budget
      ); v_deleted := v_deleted + v_count; v_mutated := v_mutated + v_count;
      v_budget := v_budget - v_count; end if;
      if not exists (select 1 from public.cloud_provider_call_permits where user_id = p_user_id)
         and not exists (select 1 from public.cloud_gateway_sessions where user_id = p_user_id)
         and not exists (select 1 from public.cloud_relay_tokens where user_id = p_user_id)
         and not exists (select 1 from public.cloud_playback_events where user_id = p_user_id)
         and not exists (select 1 from public.cloud_playback_sessions where user_id = p_user_id)
         and not exists (select 1 from public.cloud_source_direct_fallback_leases where user_id = p_user_id) then
        v_preparation.phase := 'owner';
      else
        exit;
      end if;

    elsif v_preparation.phase = 'owner' then
      perform 1 from public.cloud_catalog_background_mode_checkpoints checkpoint
      where checkpoint.owner_user_id = p_user_id
      order by checkpoint.mode for update;
      update public.cloud_catalog_background_mode_checkpoints checkpoint
      set state = 'pending',owner_user_id = null,snapshot_id = null,
          user_visibility_epoch = null,retry_before = null,
          last_attempted_at = null,last_title_id = null,
          inflight_items = '[]'::jsonb,
          inflight_last_attempted_at = null,inflight_last_title_id = null,
          inflight_owner_exhausted = false,inflight_byte_count = 0,
          lease_owner = null,lease_until = null,
          revision = checkpoint.revision + 1,updated_at = now()
      where checkpoint.owner_user_id = p_user_id;
      v_count := public.norva_provider_account_delete_rows_bounded(
        'public.cloud_catalog_background_owner_pointers',
        'user_id',p_user_id,v_budget
      ); v_deleted := v_deleted + v_count; v_mutated := v_mutated + v_count;
      v_budget := v_budget - v_count;
      if v_budget <= 0 then exit; end if;
      v_count := public.norva_provider_account_delete_rows_bounded(
        'public.cloud_catalog_background_owner_build_jobs',
        'user_id',p_user_id,v_budget
      ); v_deleted := v_deleted + v_count; v_budget := v_budget - v_count;
      if v_budget > 0 then
        v_count := public.norva_provider_account_delete_rows_bounded(
          'public.cloud_catalog_background_owner_snapshot_rows',
          'user_id',p_user_id,v_budget
        ); v_deleted := v_deleted + v_count; v_budget := v_budget - v_count;
      end if;
      if v_budget > 0 then
        v_count := public.norva_provider_account_delete_rows_bounded(
          'public.cloud_catalog_background_owner_snapshot_sources',
          'user_id',p_user_id,v_budget
        ); v_deleted := v_deleted + v_count; v_budget := v_budget - v_count;
      end if;
      if v_budget > 0 then
        delete from public.cloud_catalog_background_owner_snapshots snapshot
        where snapshot.ctid in (
          select candidate.ctid
          from public.cloud_catalog_background_owner_snapshots candidate
          where candidate.user_id = p_user_id
            and candidate.snapshot_kind = 'candidate'
          order by candidate.id limit v_budget
        );
        get diagnostics v_count = row_count;
        v_deleted := v_deleted + v_count; v_budget := v_budget - v_count;
      end if;
      if v_budget > 0 then
        delete from public.cloud_catalog_background_owner_snapshots snapshot
        where snapshot.ctid in (
          select candidate.ctid
          from public.cloud_catalog_background_owner_snapshots candidate
          where candidate.user_id = p_user_id
            and candidate.snapshot_kind = 'baseline'
          order by candidate.id limit v_budget
        );
        get diagnostics v_count = row_count;
        v_deleted := v_deleted + v_count; v_budget := v_budget - v_count;
      end if;
      if v_budget > 0 then
        v_count := public.norva_provider_account_delete_rows_bounded(
          'public.cloud_catalog_background_owner_sync_fences',
          'user_id',p_user_id,v_budget
        ); v_deleted := v_deleted + v_count; v_budget := v_budget - v_count;
      end if;
      if v_budget > 0 then
        v_count := public.norva_provider_account_delete_rows_bounded(
          'public.cloud_catalog_background_owner_topology_revisions',
          'user_id',p_user_id,v_budget
        ); v_deleted := v_deleted + v_count; v_budget := v_budget - v_count;
      end if;
      if not exists (select 1 from public.cloud_catalog_background_owner_build_jobs where user_id = p_user_id)
         and not exists (select 1 from public.cloud_catalog_background_owner_snapshots where user_id = p_user_id) then
        v_preparation.phase := 'heads';
      else
        exit;
      end if;

    elsif v_preparation.phase = 'heads' then
      v_count := public.norva_provider_account_delete_rows_bounded(
        'public.cloud_source_catalog_heads','user_id',p_user_id,v_budget
      ); v_deleted := v_deleted + v_count; v_budget := v_budget - v_count;
      if not exists (select 1 from public.cloud_source_catalog_heads where user_id = p_user_id) then
        v_preparation.phase := 'payload'; v_preparation.generation_cursor := null;
      else exit; end if;

    elsif v_preparation.phase = 'payload' then
      select generation.id into v_generation_id
      from public.cloud_source_catalog_generations generation
      where generation.user_id = p_user_id
        and (v_preparation.generation_cursor is null
          or generation.id > v_preparation.generation_cursor)
      order by generation.id limit 1 for update;
      if not found then
        v_preparation.phase := 'generation_control';
        v_preparation.generation_cursor := null;
        continue;
      end if;
      update public.cloud_source_catalog_generations generation
      set state = 'purging',manifest_sealing = false,
          revision = generation.revision + 1,updated_at = now()
      where generation.id = v_generation_id;
      perform set_config('norva.catalog_purge_generation',v_generation_id::text,true);
      v_count := public.norva_provider_account_delete_rows_bounded(
        'public.catalog_series_episode_memberships','generation_id',v_generation_id,v_budget
      ); v_deleted := v_deleted + v_count; v_budget := v_budget - v_count;
      if v_budget > 0 then v_count := public.norva_provider_account_delete_rows_bounded(
        'public.catalog_series_inventory_state','generation_id',v_generation_id,v_budget
      ); v_deleted := v_deleted + v_count; v_budget := v_budget - v_count; end if;
      if v_budget > 0 then v_count := public.norva_provider_account_delete_rows_bounded(
        'public.cloud_live_variants','generation_id',v_generation_id,v_budget
      ); v_deleted := v_deleted + v_count; v_budget := v_budget - v_count; end if;
      if v_budget > 0 then v_count := public.norva_provider_account_delete_rows_bounded(
        'public.cloud_live_logical_channels','generation_id',v_generation_id,v_budget
      ); v_deleted := v_deleted + v_count; v_budget := v_budget - v_count; end if;
      -- A variant is the parent of potentially unbounded probe, validation and
      -- file-language histories.  Drain those rows under their own keyset
      -- indexes before counting a parent delete against the batch budget; a
      -- LIMIT on the parent alone would otherwise hide an N-row FK cascade.
      if v_budget > 0 then
        with variant_candidates as materialized (
          select variant.id
          from public.cloud_title_variants variant
          where variant.generation_id = v_generation_id
          order by variant.id limit v_budget
        ), locked_children as materialized (
          select child.ctid
          from variant_candidates candidate
          join lateral (
            select probe.ctid,probe.provider_identity_id,probe.episode_id
            from public.catalog_episode_probe_state probe
            where probe.variant_id = candidate.id
            order by probe.provider_identity_id,probe.episode_id
            limit v_budget for update of probe
          ) child on true
          order by candidate.id,child.provider_identity_id,child.episode_id
          limit v_budget
        ), deleted as (
          delete from public.catalog_episode_probe_state probe
          using locked_children child where probe.ctid = child.ctid
          returning 1
        ) select count(*)::integer into v_count from deleted;
        v_deleted := v_deleted + v_count; v_budget := v_budget - v_count;
      end if;
      if v_budget > 0 then
        with variant_candidates as materialized (
          select variant.id
          from public.cloud_title_variants variant
          where variant.generation_id = v_generation_id
          order by variant.id limit v_budget
        ), locked_children as materialized (
          select child.ctid
          from variant_candidates candidate
          join lateral (
            select job.ctid,job.id
            from public.catalog_file_audio_validation_jobs job
            where job.variant_id = candidate.id
            order by job.id limit v_budget for update of job
          ) child on true
          order by candidate.id,child.id limit v_budget
        ), deleted as (
          delete from public.catalog_file_audio_validation_jobs job
          using locked_children child where job.ctid = child.ctid
          returning 1
        ) select count(*)::integer into v_count from deleted;
        v_deleted := v_deleted + v_count; v_budget := v_budget - v_count;
      end if;
      if v_budget > 0 then
        with variant_candidates as materialized (
          select variant.id
          from public.cloud_title_variants variant
          where variant.generation_id = v_generation_id
          order by variant.id limit v_budget
        ), locked_children as materialized (
          select child.ctid
          from variant_candidates candidate
          join lateral (
            select observation.ctid,observation.user_id,
              observation.file_external_id
            from public.cloud_title_file_language_observations observation
            where observation.variant_id = candidate.id
            order by observation.user_id,observation.file_external_id
            limit v_budget for update of observation
          ) child on true
          order by candidate.id,child.user_id,child.file_external_id
          limit v_budget
        ), deleted as (
          delete from public.cloud_title_file_language_observations observation
          using locked_children child where observation.ctid = child.ctid
          returning 1
        ) select count(*)::integer into v_count from deleted;
        v_deleted := v_deleted + v_count; v_budget := v_budget - v_count;
      end if;
      if v_budget > 0 then
        with locked_variants as materialized (
          select variant.ctid
          from public.cloud_title_variants variant
          where variant.generation_id = v_generation_id
            and not exists (
              select 1 from public.catalog_episode_probe_state probe
              where probe.variant_id = variant.id
            )
            and not exists (
              select 1 from public.catalog_file_audio_validation_jobs job
              where job.variant_id = variant.id
            )
            and not exists (
              select 1
              from public.cloud_title_file_language_observations observation
              where observation.variant_id = variant.id
            )
            and not exists (
              select 1 from public.catalog_series_episode_memberships episode
              where episode.parent_variant_id = variant.id
            )
            and not exists (
              select 1 from public.catalog_series_inventory_state inventory
              where inventory.parent_variant_id = variant.id
            )
          order by variant.id limit v_budget for update of variant
        ), deleted as (
          delete from public.cloud_title_variants variant
          using locked_variants locked where variant.ctid = locked.ctid
          returning 1
        ) select count(*)::integer into v_count from deleted;
        v_deleted := v_deleted + v_count; v_budget := v_budget - v_count;
      end if;
      if v_budget > 0 then v_count := public.norva_provider_account_delete_rows_bounded(
        'public.cloud_media_items','generation_id',v_generation_id,v_budget
      ); v_deleted := v_deleted + v_count; v_budget := v_budget - v_count; end if;
      if not exists (select 1 from public.catalog_series_episode_memberships where generation_id = v_generation_id)
         and not exists (select 1 from public.catalog_series_inventory_state where generation_id = v_generation_id)
         and not exists (select 1 from public.cloud_live_variants where generation_id = v_generation_id)
         and not exists (select 1 from public.cloud_live_logical_channels where generation_id = v_generation_id)
         and not exists (select 1 from public.cloud_title_variants where generation_id = v_generation_id)
         and not exists (select 1 from public.cloud_media_items where generation_id = v_generation_id) then
        v_preparation.generation_cursor := v_generation_id;
      else exit; end if;

    elsif v_preparation.phase = 'generation_control' then
      v_count := public.norva_provider_account_delete_rows_bounded(
        'public.cloud_source_catalog_title_refresh_actions','user_id',p_user_id,v_budget
      ); v_deleted := v_deleted + v_count; v_budget := v_budget - v_count;
      if v_budget > 0 then v_count := public.norva_provider_account_delete_rows_bounded(
        'public.cloud_source_catalog_title_refresh_checkpoints','user_id',p_user_id,v_budget
      ); v_deleted := v_deleted + v_count; v_budget := v_budget - v_count; end if;
      if v_budget > 0 then v_count := public.norva_provider_account_delete_rows_bounded(
        'public.cloud_source_credential_transition_jobs','user_id',p_user_id,v_budget
      ); v_deleted := v_deleted + v_count; v_budget := v_budget - v_count; end if;
      if v_budget > 0 then v_count := public.norva_provider_account_delete_rows_bounded(
        'public.cloud_source_catalog_manifest_seal_progress','user_id',p_user_id,v_budget
      ); v_deleted := v_deleted + v_count; v_budget := v_budget - v_count; end if;
      if v_budget > 0 then v_count := public.norva_provider_account_delete_rows_bounded(
        'public.cloud_source_catalog_generation_candidate_titles','user_id',p_user_id,v_budget
      ); v_deleted := v_deleted + v_count; v_budget := v_budget - v_count; end if;
      if v_budget > 0 then v_count := public.norva_provider_account_delete_rows_bounded(
        'public.cloud_source_catalog_generation_title_promotions','user_id',p_user_id,v_budget
      ); v_deleted := v_deleted + v_count; v_budget := v_budget - v_count; end if;
      if v_budget > 0 then v_count := public.norva_provider_account_delete_rows_bounded(
        'public.cloud_source_catalog_generation_inventory_actions','user_id',p_user_id,v_budget
      ); v_deleted := v_deleted + v_count; v_budget := v_budget - v_count; end if;
      if v_budget > 0 then v_count := public.norva_provider_account_delete_rows_bounded(
        'public.cloud_source_catalog_generation_episode_copy','user_id',p_user_id,v_budget
      ); v_deleted := v_deleted + v_count; v_budget := v_budget - v_count; end if;
      if v_budget > 0 then v_count := public.norva_provider_account_delete_rows_bounded(
        'public.cloud_source_catalog_generation_category_lists','user_id',p_user_id,v_budget
      ); v_deleted := v_deleted + v_count; v_budget := v_budget - v_count; end if;
      if v_budget > 0 then v_count := public.norva_provider_account_delete_rows_bounded(
        'public.cloud_source_catalog_generation_categories','user_id',p_user_id,v_budget
      ); v_deleted := v_deleted + v_count; v_budget := v_budget - v_count; end if;
      if not exists (select 1 from public.cloud_source_catalog_title_refresh_actions where user_id = p_user_id)
         and not exists (select 1 from public.cloud_source_catalog_title_refresh_checkpoints where user_id = p_user_id)
         and not exists (select 1 from public.cloud_source_credential_transition_jobs where user_id = p_user_id)
         and not exists (select 1 from public.cloud_source_catalog_manifest_seal_progress where user_id = p_user_id)
         and not exists (select 1 from public.cloud_source_catalog_generation_candidate_titles where user_id = p_user_id)
         and not exists (select 1 from public.cloud_source_catalog_generation_title_promotions where user_id = p_user_id)
         and not exists (select 1 from public.cloud_source_catalog_generation_inventory_actions where user_id = p_user_id)
         and not exists (select 1 from public.cloud_source_catalog_generation_episode_copy where user_id = p_user_id)
         and not exists (select 1 from public.cloud_source_catalog_generation_category_lists where user_id = p_user_id)
         and not exists (select 1 from public.cloud_source_catalog_generation_categories where user_id = p_user_id) then
        v_preparation.phase := 'generations';
      else exit; end if;

    elsif v_preparation.phase = 'generations' then
      update public.cloud_source_transitions transition
      set candidate_catalog_generation_id = null,
          previous_catalog_generation_id = null,
          reversal_of_transition_id = null
      where transition.ctid in (
        select candidate.ctid from public.cloud_source_transitions candidate
        where candidate.user_id = p_user_id and (
          candidate.candidate_catalog_generation_id is not null
          or candidate.previous_catalog_generation_id is not null
          or candidate.reversal_of_transition_id is not null
        ) order by candidate.id limit v_budget
      );
      get diagnostics v_count = row_count;
      v_mutated := v_mutated + v_count; v_budget := v_budget - v_count;
      if v_budget > 0 and not exists (
        select 1 from public.cloud_source_transitions transition
        where transition.user_id = p_user_id and (
          transition.candidate_catalog_generation_id is not null
          or transition.previous_catalog_generation_id is not null
          or transition.reversal_of_transition_id is not null
        )
      ) then
        v_count := public.norva_provider_account_delete_rows_bounded(
          'public.cloud_source_catalog_generations','user_id',p_user_id,v_budget
        ); v_deleted := v_deleted + v_count; v_budget := v_budget - v_count;
      end if;
      if not exists (select 1 from public.cloud_source_catalog_generations where user_id = p_user_id) then
        v_preparation.phase := 'titles';
      else exit; end if;

    elsif v_preparation.phase = 'titles' then
      v_count := public.norva_provider_account_delete_rows_bounded(
        'public.cloud_title_file_language_observations','user_id',p_user_id,v_budget
      ); v_deleted := v_deleted + v_count; v_mutated := v_mutated + v_count;
      v_budget := v_budget - v_count;
      if v_budget > 0 then v_count := public.norva_provider_account_delete_rows_bounded(
        'public.cloud_title_overrides','user_id',p_user_id,v_budget
      ); v_deleted := v_deleted + v_count; v_mutated := v_mutated + v_count;
      v_budget := v_budget - v_count; end if;
      if v_budget > 0 then v_count := public.norva_provider_account_delete_rows_bounded(
        'public.cloud_title_rating_operations','user_id',p_user_id,v_budget
      ); v_deleted := v_deleted + v_count; v_mutated := v_mutated + v_count;
      v_budget := v_budget - v_count; end if;
      if v_budget > 0 then v_count := public.norva_provider_account_delete_rows_bounded(
        'public.cloud_title_ratings','user_id',p_user_id,v_budget
      ); v_deleted := v_deleted + v_count; v_mutated := v_mutated + v_count;
      v_budget := v_budget - v_count; end if;
      if v_budget > 0 then v_count := public.norva_provider_account_delete_rows_bounded(
        'public.cloud_favorites','user_id',p_user_id,v_budget
      ); v_deleted := v_deleted + v_count; v_mutated := v_mutated + v_count;
      v_budget := v_budget - v_count; end if;
      if v_budget > 0 then v_count := public.norva_provider_account_delete_rows_bounded(
        'public.cloud_titles','user_id',p_user_id,v_budget
      ); v_deleted := v_deleted + v_count; v_mutated := v_mutated + v_count;
      v_budget := v_budget - v_count; end if;
      if not exists (select 1 from public.cloud_title_file_language_observations where user_id = p_user_id)
         and not exists (select 1 from public.cloud_title_overrides where user_id = p_user_id)
         and not exists (select 1 from public.cloud_title_rating_operations where user_id = p_user_id)
         and not exists (select 1 from public.cloud_title_ratings where user_id = p_user_id)
         and not exists (select 1 from public.cloud_favorites where user_id = p_user_id)
         and not exists (select 1 from public.cloud_titles where user_id = p_user_id) then
        v_preparation.phase := 'transition_control';
      else exit; end if;

    elsif v_preparation.phase = 'transition_control' then
      v_count := public.norva_provider_account_delete_rows_bounded(
        'public.cloud_source_transition_secrets','user_id',p_user_id,v_budget
      ); v_deleted := v_deleted + v_count; v_budget := v_budget - v_count;
      if v_budget > 0 then v_count := public.norva_provider_account_delete_rows_bounded(
        'public.cloud_source_credential_transition_actions','user_id',p_user_id,v_budget
      ); v_deleted := v_deleted + v_count; v_budget := v_budget - v_count; end if;
      if v_budget > 0 then v_count := public.norva_provider_account_delete_rows_bounded(
        'public.cloud_source_identity_assessments','user_id',p_user_id,v_budget
      ); v_deleted := v_deleted + v_count; v_budget := v_budget - v_count; end if;
      if v_budget > 0 then v_count := public.norva_provider_account_delete_rows_bounded(
        'public.cloud_source_lifecycle_events','user_id',p_user_id,v_budget
      ); v_deleted := v_deleted + v_count; v_budget := v_budget - v_count; end if;
      if not exists (select 1 from public.cloud_source_transition_secrets where user_id = p_user_id)
         and not exists (select 1 from public.cloud_source_credential_transition_actions where user_id = p_user_id)
         and not exists (select 1 from public.cloud_source_identity_assessments where user_id = p_user_id)
         and not exists (select 1 from public.cloud_source_lifecycle_events where user_id = p_user_id) then
        v_preparation.phase := 'transitions';
      else exit; end if;

    elsif v_preparation.phase = 'transitions' then
      v_count := public.norva_provider_account_delete_rows_bounded(
        'public.cloud_source_transitions','user_id',p_user_id,v_budget
      ); v_deleted := v_deleted + v_count; v_budget := v_budget - v_count;
      if not exists (select 1 from public.cloud_source_transitions where user_id = p_user_id) then
        v_preparation.phase := 'source_control';
      else exit; end if;

    elsif v_preparation.phase = 'source_control' then
      v_count := public.norva_provider_account_delete_rows_bounded(
        'public.cloud_playback_events','user_id',p_user_id,v_budget
      ); v_deleted := v_deleted + v_count; v_budget := v_budget - v_count;
      if v_budget > 0 then v_count := public.norva_provider_account_delete_rows_bounded(
        'public.cloud_watch_history','user_id',p_user_id,v_budget
      ); v_deleted := v_deleted + v_count; v_budget := v_budget - v_count; end if;
      if v_budget > 0 then v_count := public.norva_provider_account_delete_rows_bounded(
        'public.catalog_enrichment_source_schedule','user_id',p_user_id,v_budget
      ); v_deleted := v_deleted + v_count; v_budget := v_budget - v_count; end if;
      if v_budget > 0 then v_count := public.norva_provider_account_delete_rows_bounded(
        'public.catalog_source_provider_identities','user_id',p_user_id,v_budget
      ); v_deleted := v_deleted + v_count; v_budget := v_budget - v_count; end if;
      if v_budget > 0 then v_count := public.norva_provider_account_delete_rows_bounded(
        'public.cloud_source_provider_access','user_id',p_user_id,v_budget
      ); v_deleted := v_deleted + v_count; v_budget := v_budget - v_count; end if;
      if v_budget > 0 then v_count := public.norva_provider_account_delete_rows_bounded(
        'public.cloud_source_access_cycles','user_id',p_user_id,v_budget
      ); v_deleted := v_deleted + v_count; v_budget := v_budget - v_count; end if;
      if v_budget > 0 then v_count := public.norva_provider_account_delete_rows_bounded(
        'public.cloud_source_lifecycle','user_id',p_user_id,v_budget
      ); v_deleted := v_deleted + v_count; v_budget := v_budget - v_count; end if;
      if v_budget > 0
         and not exists (select 1 from public.cloud_playback_events where user_id = p_user_id)
         and not exists (select 1 from public.cloud_watch_history where user_id = p_user_id)
         and not exists (select 1 from public.catalog_enrichment_source_schedule where user_id = p_user_id)
         and not exists (select 1 from public.catalog_source_provider_identities where user_id = p_user_id)
         and not exists (select 1 from public.cloud_source_provider_access where user_id = p_user_id)
         and not exists (select 1 from public.cloud_source_access_cycles where user_id = p_user_id)
         and not exists (select 1 from public.cloud_source_lifecycle where user_id = p_user_id) then
        select source.id into v_source_id
        from public.cloud_sources source
        where source.user_id = p_user_id
        order by source.id limit 1 for update;
        if found then
          v_count := public.norva_provider_account_delete_rows_bounded(
            'public.catalog_file_audio_validation_jobs','source_id',v_source_id,v_budget
          ); v_deleted := v_deleted + v_count; v_budget := v_budget - v_count;
          if v_budget > 0 then v_count := public.norva_provider_account_delete_rows_bounded(
            'public.catalog_provider_inventory_backoff','source_id',v_source_id,v_budget
          ); v_deleted := v_deleted + v_count; v_budget := v_budget - v_count; end if;
          if v_budget > 0
             and not exists (select 1 from public.catalog_file_audio_validation_jobs where source_id = v_source_id)
             and not exists (select 1 from public.catalog_provider_inventory_backoff where source_id = v_source_id) then
            v_count := public.norva_provider_account_delete_rows_bounded(
              'public.cloud_sources','user_id',p_user_id,1
            );
            v_deleted := v_deleted + v_count; v_budget := v_budget - v_count;
          end if;
        end if;
      end if;
      if not exists (select 1 from public.cloud_playback_events where user_id = p_user_id)
         and not exists (select 1 from public.cloud_watch_history where user_id = p_user_id)
         and not exists (select 1 from public.catalog_enrichment_source_schedule where user_id = p_user_id)
         and not exists (select 1 from public.catalog_source_provider_identities where user_id = p_user_id)
         and not exists (select 1 from public.cloud_source_provider_access where user_id = p_user_id)
         and not exists (select 1 from public.cloud_source_access_cycles where user_id = p_user_id)
         and not exists (select 1 from public.cloud_source_lifecycle where user_id = p_user_id)
         and not exists (select 1 from public.cloud_sources where user_id = p_user_id) then
        v_preparation.phase := 'verify';
      else exit; end if;

    elsif v_preparation.phase = 'verify' then
      if not public.norva_provider_account_delete_proof_ready(p_user_id) then
        raise exception 'provider account deletion proof is incomplete'
          using errcode = '40001';
      end if;
      v_preparation.phase := 'ready';
      v_preparation.state := 'ready';
      exit;
    end if;
  end loop;
  perform set_config('norva.catalog_purge_generation','',true);
  update public.cloud_provider_account_delete_preparations preparation
  set state = v_preparation.state,phase = v_preparation.phase,
      generation_cursor = v_preparation.generation_cursor,
      deleted_rows = preparation.deleted_rows + v_deleted,
      mutated_rows = preparation.mutated_rows + v_deleted + v_mutated,
      lease_owner = case when v_preparation.state = 'ready' then null else preparation.lease_owner end,
      lease_until = case when v_preparation.state = 'ready' then null else preparation.lease_until end,
      ready_at = case when v_preparation.state = 'ready' then now() else null end,
      delete_relation = case when v_preparation.state = 'ready'
        then null else preparation.delete_relation end,
      delete_filter_column = case when v_preparation.state = 'ready'
        then null else preparation.delete_filter_column end,
      delete_filter_value = case when v_preparation.state = 'ready'
        then null else preparation.delete_filter_value end,
      delete_cursor = case when v_preparation.state = 'ready'
        then '{}'::jsonb else preparation.delete_cursor end,
      revision = preparation.revision + 1,updated_at = now()
  where preparation.user_id = p_user_id
  returning * into v_preparation;
  return jsonb_build_object(
    'contract','provider-account-delete-prepare-v1',
    'userId',p_user_id,'state',v_preparation.state,
    'phase',v_preparation.phase,'revision',v_preparation.revision,
    'deletionEpoch',v_preparation.deletion_epoch,
    'leaseSequence',v_preparation.lease_sequence,
    'leaseUntil',v_preparation.lease_until,
    'deletedRows',v_preparation.deleted_rows,
    'batchDeletedRows',v_deleted,
    'mutatedRows',v_preparation.mutated_rows,
    'batchMutatedRows',v_deleted + v_mutated,
    'waitingForDrain',v_waiting,
    'failureAttemptCount',v_preparation.failure_attempt_count,
    'ready',v_preparation.state = 'ready'
  );
end
$function$;

create or replace function public.norva_checkpoint_provider_account_deletion_prepare(
  p_user_id uuid,
  p_worker text,
  p_expected_lease_sequence integer,
  p_expected_revision bigint,
  p_retry_after_seconds integer default 0
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_preparation public.cloud_provider_account_delete_preparations%rowtype;
begin
  perform public.norva_credential_require_service_role();
  if p_retry_after_seconds is null or p_retry_after_seconds not between 0 and 300 then
    raise exception 'provider account deletion checkpoint delay is invalid' using errcode = '22023';
  end if;
  perform 1 from auth.users account where account.id = p_user_id for key share;
  if not found then raise exception 'provider account deletion user is unavailable' using errcode = 'P0002'; end if;
  select preparation.* into v_preparation
  from public.cloud_provider_account_delete_preparations preparation
  where preparation.user_id = p_user_id for update;
  if not found or v_preparation.state <> 'processing'
     or v_preparation.lease_owner is distinct from btrim(p_worker)
     or v_preparation.lease_sequence <> p_expected_lease_sequence
     or v_preparation.revision <> p_expected_revision
     or v_preparation.lease_until <= now() then
    raise exception 'provider account deletion checkpoint lease CAS failed' using errcode = '40001';
  end if;
  update public.cloud_provider_account_delete_preparations preparation
  set state = 'pending',lease_owner = null,lease_until = null,
      available_at = now() + make_interval(secs => p_retry_after_seconds),
      revision = revision + 1,updated_at = now()
  where preparation.user_id = p_user_id returning * into v_preparation;
  return jsonb_build_object(
    'contract','provider-account-delete-prepare-v1','userId',p_user_id,
    'state','pending','phase',v_preparation.phase,
    'revision',v_preparation.revision,'deletedRows',v_preparation.deleted_rows,
    'retryAfterSeconds',p_retry_after_seconds
  );
end
$function$;

create or replace function public.norva_settle_provider_account_deletion_prepare_failure(
  p_user_id uuid,
  p_worker text,
  p_expected_lease_sequence integer,
  p_expected_revision bigint,
  p_error_code text,
  p_retryable boolean,
  p_retry_after_seconds integer default 30
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_preparation public.cloud_provider_account_delete_preparations%rowtype;
  v_failure_count integer;
  v_dead boolean;
begin
  perform public.norva_credential_require_service_role();
  if p_error_code is null or p_error_code !~ '^[a-z0-9_]{1,80}$'
     or p_retryable is null or p_retry_after_seconds not between 0 and 300 then
    raise exception 'provider account deletion settle arguments are invalid' using errcode = '22023';
  end if;
  perform 1 from auth.users account where account.id = p_user_id for key share;
  if not found then raise exception 'provider account deletion user is unavailable' using errcode = 'P0002'; end if;
  select preparation.* into v_preparation
  from public.cloud_provider_account_delete_preparations preparation
  where preparation.user_id = p_user_id for update;
  if not found or v_preparation.state <> 'processing'
     or v_preparation.lease_owner is distinct from btrim(p_worker)
     or v_preparation.lease_sequence <> p_expected_lease_sequence
     or v_preparation.revision <> p_expected_revision
     or v_preparation.lease_until <= now() then
    raise exception 'provider account deletion settle lease CAS failed' using errcode = '40001';
  end if;
  v_failure_count := v_preparation.failure_attempt_count + 1;
  v_dead := not p_retryable or v_failure_count >= v_preparation.max_attempts;
  update public.cloud_provider_account_delete_preparations preparation
  set state = case when v_dead then 'dead' else 'pending' end,
      lease_owner = null,lease_until = null,
      available_at = case when v_dead then preparation.available_at
        else now() + make_interval(secs => p_retry_after_seconds) end,
      failure_attempt_count = v_failure_count,last_error_code = p_error_code,
      revision = revision + 1,updated_at = now()
  where preparation.user_id = p_user_id returning * into v_preparation;
  return jsonb_build_object(
    'contract','provider-account-delete-prepare-v1','userId',p_user_id,
    'state',v_preparation.state,'phase',v_preparation.phase,
    'revision',v_preparation.revision,
    'failureAttemptCount',v_preparation.failure_attempt_count,
    'lastErrorCode',v_preparation.last_error_code,'dead',v_dead
  );
end
$function$;

-- This trigger performs a constant-size terminal check for the provider
-- transition subgraph only.  Account-wide auth cascades are outside this
-- proof and remain an explicit deployment/retention gate.
create or replace function public.norva_provider_transition_account_delete_guard()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_preparation public.cloud_provider_account_delete_preparations%rowtype;
  v_delete_fence text;
  v_owner_fence text;
begin
  select preparation.* into v_preparation
  from public.cloud_provider_account_delete_preparations preparation
  where preparation.user_id = old.id
  for update;
  -- This contract is intentionally deployment-gated with the matching
  -- account-delete adapter.  A legacy direct auth delete cannot safely emulate
  -- the bounded drain (or stop provider transports), so absence of durable
  -- preparation is a fail-closed state rather than a synchronous fallback.
  if not found then
    raise exception 'provider account deletion preparation was not begun'
      using errcode = '55000',
        detail = 'reason=provider_account_delete_not_prepared';
  end if;
  if v_preparation.state <> 'ready'
     or v_preparation.phase <> 'ready'
     or not public.norva_provider_account_delete_proof_ready(old.id) then
    raise exception 'provider account deletion preparation is incomplete'
      using errcode = '55000',
        detail = 'reason=provider_account_delete_not_prepared';
  end if;
  v_delete_fence := coalesce(current_setting(
    'norva.provider_transition_deleted_users',true
  ),'|');
  v_owner_fence := coalesce(current_setting(
    'norva.catalog_background_owner_deleted_users',true
  ),'|');
  perform set_config(
    'norva.provider_transition_deleted_users',
    v_delete_fence || old.id::text || '|',true
  );
  perform set_config(
    'norva.catalog_background_owner_deleted_users',
    v_owner_fence || old.id::text || '|',true
  );
  return old;
end
$function$;

-- Direct hard source deletion is never allowed to race a retained transition
-- or generation.  Account deletion owns the terminal fence above; ordinary
-- source reaping skips these rows until the dedicated purge has removed them.
create or replace function public.norva_provider_transition_source_delete_guard()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  if public.norva_provider_account_delete_fenced(old.user_id) then return old; end if;
  raise exception 'provider source physical deletion requires bounded preparation'
    using errcode = '55000',
      detail = 'reason=provider_source_delete_requires_prepare';
end
$function$;
-- Preserve the existing bounded 5k reaper, but never claim a source that the
-- Phase-3 proof graph deliberately retains.  One poison source cannot block
-- subsequent sources and no FK exception is used as scheduler control flow.
create or replace procedure public.reap_deleted_sources()
language plpgsql
set search_path to 'public'
as $procedure$
declare
  sid uuid;
  n integer;
  budget integer := 5000;
begin
  -- Transaction-scoped ownership is mandatory: any statement error, timeout,
  -- or caller rollback releases the singleton automatically.  A session lock
  -- here would poison the reaper indefinitely after an exceptional exit.
  if not pg_try_advisory_xact_lock(hashtext('reap_deleted_sources')) then
    return;
  end if;
  if exists (
    select 1 from public.cloud_sources
    where sync_status = 'syncing' and deleted_at is null
  ) then
    return;
  end if;
  for sid in
    select source.id
    from public.cloud_sources source
    where source.deleted_at is not null
      and not source.provider_deletion_pending
      and not exists (
        select 1 from public.cloud_source_transitions transition
        where transition.old_source_id = source.id
           or transition.candidate_source_id = source.id
      )
      and not exists (
        select 1 from public.cloud_source_catalog_generations generation
        where generation.source_id = source.id
      )
      and not exists (
        select 1 from public.cloud_provider_call_permits permit
        where permit.source_id = source.id and permit.state = 'active'
          and permit.permit_until > clock_timestamp()
      )
      and not exists (
        select 1 from public.cloud_source_direct_fallback_leases lease
        where lease.source_id = source.id
          and lease.lease_until > clock_timestamp()
      )
      and not exists (
        select 1 from public.cloud_playback_sessions playback
        where playback.source_id = source.id
          and playback.status in ('pending','ready')
          and playback.expires_at > clock_timestamp()
      )
      and not exists (
        select 1 from public.cloud_gateway_sessions gateway
        join public.cloud_playback_sessions playback
          on playback.id = gateway.playback_session_id
        where playback.source_id = source.id
          and gateway.status in ('pending','starting','ready')
          and gateway.expires_at > clock_timestamp()
      )
    order by source.deleted_at,source.id
    limit budget
    for update of source skip locked
  loop
    delete from public.cloud_provider_call_permits
    where id in (
      select permit.id from public.cloud_provider_call_permits permit
      where permit.source_id = sid
        and (permit.state <> 'active'
          or permit.permit_until <= clock_timestamp())
      order by permit.id limit budget for update
    );
    get diagnostics n = row_count; budget := budget - n; if budget <= 0 then exit; end if;
    delete from public.cloud_source_direct_fallback_leases lease
    where lease.affinity_hash in (
      select candidate.affinity_hash
      from public.cloud_source_direct_fallback_leases candidate
      where candidate.source_id = sid
      order by candidate.affinity_hash limit budget for update of candidate
    );
    get diagnostics n = row_count; budget := budget - n; if budget <= 0 then exit; end if;
    delete from public.cloud_gateway_sessions gateway
    where gateway.id in (
      select candidate.id
      from public.cloud_gateway_sessions candidate
      join public.cloud_playback_sessions playback
        on playback.id = candidate.playback_session_id
      where playback.source_id = sid
      order by candidate.id limit budget for update of candidate
    );
    get diagnostics n = row_count; budget := budget - n; if budget <= 0 then exit; end if;
    delete from public.cloud_relay_tokens relay
    where relay.id in (
      select candidate.id
      from public.cloud_relay_tokens candidate
      join public.cloud_playback_sessions playback
        on playback.id = candidate.playback_session_id
      where playback.source_id = sid
      order by candidate.id limit budget for update of candidate
    );
    get diagnostics n = row_count; budget := budget - n; if budget <= 0 then exit; end if;
    with locked_events as materialized (
      select event.id
      from public.cloud_playback_events event
      join public.cloud_playback_sessions playback
        on playback.id = event.playback_session_id
      where playback.source_id = sid
      order by event.id limit budget for update of event
    ), detached as (
      update public.cloud_playback_events event
      set playback_session_id = null
      from locked_events locked
      where event.id = locked.id
      returning 1
    )
    select count(*)::integer into n from detached;
    budget := budget - n; if budget <= 0 then exit; end if;
    delete from public.cloud_playback_sessions playback
    where playback.id in (
      select candidate.id from public.cloud_playback_sessions candidate
      where candidate.source_id = sid
        and not exists (
          select 1 from public.cloud_provider_call_permits permit
          where permit.playback_session_id = candidate.id
        )
        and not exists (
          select 1 from public.cloud_gateway_sessions gateway
          where gateway.playback_session_id = candidate.id
        )
        and not exists (
          select 1 from public.cloud_relay_tokens relay
          where relay.playback_session_id = candidate.id
        )
        and not exists (
          select 1 from public.cloud_playback_events event
          where event.playback_session_id = candidate.id
        )
      order by candidate.id limit budget for update of candidate
    );
    get diagnostics n = row_count; budget := budget - n; if budget <= 0 then exit; end if;
    delete from public.catalog_series_episode_memberships
    where ctid in (
      select episode.ctid
      from public.catalog_series_episode_memberships episode
      where episode.source_id = sid
      order by episode.parent_series_id,episode.episode_id
      limit budget for update
    );
    get diagnostics n = row_count; budget := budget - n; if budget <= 0 then exit; end if;
    delete from public.catalog_series_inventory_state
    where ctid in (
      select inventory.ctid
      from public.catalog_series_inventory_state inventory
      where inventory.source_id = sid
      order by inventory.parent_series_id limit budget for update
    );
    get diagnostics n = row_count; budget := budget - n; if budget <= 0 then exit; end if;
    delete from public.catalog_file_audio_validation_jobs
    where id in (
      select job.id from public.catalog_file_audio_validation_jobs job
      where job.source_id = sid order by job.id limit budget for update
    );
    get diagnostics n = row_count; budget := budget - n; if budget <= 0 then exit; end if;
    with variant_candidates as materialized (
      select variant.id from public.cloud_title_variants variant
      where variant.source_id = sid order by variant.id limit budget
    ), locked_children as materialized (
      select child.ctid
      from variant_candidates candidate
      join lateral (
        select probe.ctid,probe.provider_identity_id,probe.episode_id
        from public.catalog_episode_probe_state probe
        where probe.variant_id = candidate.id
        order by probe.provider_identity_id,probe.episode_id
        limit budget for update of probe
      ) child on true
      order by candidate.id,child.provider_identity_id,child.episode_id
      limit budget
    )
    delete from public.catalog_episode_probe_state probe
    using locked_children child where probe.ctid = child.ctid;
    get diagnostics n = row_count; budget := budget - n; if budget <= 0 then exit; end if;
    with variant_candidates as materialized (
      select variant.id from public.cloud_title_variants variant
      where variant.source_id = sid order by variant.id limit budget
    ), locked_children as materialized (
      select child.ctid
      from variant_candidates candidate
      join lateral (
        select observation.ctid,observation.user_id,
          observation.file_external_id
        from public.cloud_title_file_language_observations observation
        where observation.variant_id = candidate.id
        order by observation.user_id,observation.file_external_id
        limit budget for update of observation
      ) child on true
      order by candidate.id,child.user_id,child.file_external_id
      limit budget
    )
    delete from public.cloud_title_file_language_observations observation
    using locked_children child where observation.ctid = child.ctid;
    get diagnostics n = row_count; budget := budget - n; if budget <= 0 then exit; end if;
    delete from public.cloud_title_variants variant
    where variant.ctid in (
      select candidate.ctid from public.cloud_title_variants candidate
      where candidate.source_id = sid
        and not exists (
          select 1 from public.catalog_episode_probe_state probe
          where probe.variant_id = candidate.id
        )
        and not exists (
          select 1 from public.catalog_file_audio_validation_jobs job
          where job.variant_id = candidate.id
        )
        and not exists (
          select 1
          from public.cloud_title_file_language_observations observation
          where observation.variant_id = candidate.id
        )
        and not exists (
          select 1 from public.catalog_series_episode_memberships episode
          where episode.parent_variant_id = candidate.id
        )
        and not exists (
          select 1 from public.catalog_series_inventory_state inventory
          where inventory.parent_variant_id = candidate.id
        )
      order by candidate.id limit budget for update of candidate
    );
    get diagnostics n = row_count; budget := budget - n; if budget <= 0 then exit; end if;
    delete from public.cloud_live_variants
    where id in (
      select variant.id from public.cloud_live_variants variant
      where variant.source_id = sid order by variant.id limit budget for update
    );
    get diagnostics n = row_count; budget := budget - n; if budget <= 0 then exit; end if;
    delete from public.cloud_live_logical_channels
    where id in (
      select channel.id from public.cloud_live_logical_channels channel
      where channel.source_id = sid order by channel.id limit budget for update
    );
    get diagnostics n = row_count; budget := budget - n; if budget <= 0 then exit; end if;
    delete from public.cloud_media_items
    where id in (
      select item.id from public.cloud_media_items item
      where item.source_id = sid order by item.id limit budget for update
    );
    get diagnostics n = row_count; budget := budget - n; if budget <= 0 then exit; end if;
    if not exists (select 1 from public.cloud_media_items where source_id = sid)
       and not exists (select 1 from public.cloud_title_variants where source_id = sid)
       and not exists (select 1 from public.cloud_live_variants where source_id = sid)
       and not exists (select 1 from public.cloud_live_logical_channels where source_id = sid) then
      delete from public.cloud_title_overrides
      where id in (
        select override_state.id from public.cloud_title_overrides override_state
        where override_state.source_id = sid order by override_state.id
        limit budget for update
      );
      get diagnostics n = row_count; budget := budget - n;
      if budget <= 0 then exit; end if;
      delete from public.cloud_favorites
      where id in (
        select favorite.id from public.cloud_favorites favorite
        where favorite.source_id = sid order by favorite.id
        limit budget for update
      );
      get diagnostics n = row_count; budget := budget - n;
      if budget <= 0 then exit; end if;
      if not exists (select 1 from public.cloud_title_overrides where source_id = sid)
         and not exists (select 1 from public.cloud_favorites where source_id = sid)
         and not exists (select 1 from public.cloud_provider_call_permits where source_id = sid)
         and not exists (select 1 from public.cloud_source_direct_fallback_leases where source_id = sid)
         and not exists (select 1 from public.cloud_playback_sessions where source_id = sid)
         and not exists (
           select 1 from public.cloud_gateway_sessions gateway
           join public.cloud_playback_sessions playback
             on playback.id = gateway.playback_session_id
           where playback.source_id = sid
         ) then
        -- Physical deletion is intentionally deferred to the bounded account
        -- or future source-delete protocol.  Mark the fully drained tombstone
        -- once; this prevents FK cascades from hiding unbounded work here.
        update public.cloud_sources source
        set provider_deletion_pending = true,
            provider_deletion_epoch = source.provider_deletion_epoch + 1
        where source.id = sid and not source.provider_deletion_pending;
        get diagnostics n = row_count; budget := budget - n;
        if budget <= 0 then exit; end if;
      end if;
    end if;
  end loop;
end
$procedure$;

-- Account deletion owns the outermost lock in every service RPC that can
-- mutate credential/catalog state for one user.  Earlier migrations define a
-- broad set of worker/staging entrypoints; rewrite those definitions in one
-- audited pass so none can hold a job/generation/catalog row and only then
-- reach an auth FK.  Four functions are deliberately excluded because they
-- execute from row triggers after topology/catalog tuples are already locked;
-- deletion_pending guards make those paths no-op instead of reaching auth.
do $account_first$
declare
  v_rpc record;
  v_definition text;
  v_rewritten text;
begin
  for v_rpc in
    select procedure_state.oid,
      procedure_state.oid::regprocedure as identity
    from pg_catalog.pg_proc procedure_state
    join pg_catalog.pg_namespace namespace_state
      on namespace_state.oid = procedure_state.pronamespace
    join pg_catalog.pg_language language_state
      on language_state.oid = procedure_state.prolang
    where namespace_state.nspname = 'public'
      and procedure_state.proname like 'norva_%'
      and procedure_state.provolatile = 'v'
      and procedure_state.prosecdef
      and language_state.lanname = 'plpgsql'
      and pg_catalog.pg_get_function_identity_arguments(procedure_state.oid)
        ~ '(^|, )p_user_id uuid'
      and procedure_state.prosrc ~
        'cloud_(source_|media_items|title_variants|live_variants|live_logical_channels|titles|catalog_background_owner)'
      and procedure_state.proname not in (
        'norva_mark_catalog_background_owner_stale',
        'norva_mark_catalog_background_owner_sync',
        'norva_sync_catalog_background_owner_title',
        'norva_ensure_source_catalog_head'
      )
    order by procedure_state.oid
  loop
    select pg_catalog.replace(
      pg_catalog.pg_get_functiondef(v_rpc.oid),chr(13),''
    )
      into v_definition;
    if position(
      'norva_credential_lock_account(p_user_id)' in v_definition
    ) > 0 then
      continue;
    end if;
    v_rewritten := pg_catalog.regexp_replace(
      v_definition,
      E'\\nbegin\\n',
      E'\nbegin\n  perform public.norva_credential_lock_account(p_user_id);\n',
      'i'
    );
    if v_rewritten = v_definition then
      raise exception 'account-first rewrite has no top-level begin marker: %',
        v_rpc.identity using errcode = '55000';
    end if;
    execute v_rewritten;
  end loop;
end
$account_first$;

commit;
