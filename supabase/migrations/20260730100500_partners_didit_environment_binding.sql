-- Bind every hosted Didit session and signed webhook to the exact non-secret
-- provider contract that created it. Sandbox decisions remain observable but
-- are never authoritative for a shareable Partners account.

alter table affiliate_private.affiliate_kyc_sessions
  add column provider_environment text not null
    default 'legacy_unbound',
  add column provider_config_fingerprint text not null
    default repeat('0', 64);

alter table affiliate_private.affiliate_kyc_sessions
  add constraint affiliate_kyc_sessions_provider_environment
    check (
      provider_environment in ('legacy_unbound', 'sandbox', 'live')
    ),
  add constraint affiliate_kyc_sessions_provider_config_fingerprint
    check (
      provider_config_fingerprint ~ '^[0-9a-f]{64}$'
      and (
        (
          provider_environment = 'legacy_unbound'
          and provider_config_fingerprint = repeat('0', 64)
        )
        or (
          provider_environment in ('sandbox', 'live')
          and provider_config_fingerprint <> repeat('0', 64)
        )
      )
    );

alter table affiliate_private.affiliate_kyc_webhook_events
  add column provider_environment text not null
    default 'legacy_unbound',
  add column provider_config_fingerprint text not null
    default repeat('0', 64);

alter table affiliate_private.affiliate_kyc_webhook_events
  add constraint affiliate_kyc_webhook_events_provider_environment
    check (
      provider_environment in ('legacy_unbound', 'sandbox', 'live')
    ),
  add constraint affiliate_kyc_webhook_events_provider_config_fingerprint
    check (
      provider_config_fingerprint ~ '^[0-9a-f]{64}$'
      and (
        (
          provider_environment = 'legacy_unbound'
          and provider_config_fingerprint = repeat('0', 64)
        )
        or (
          provider_environment in ('sandbox', 'live')
          and provider_config_fingerprint <> repeat('0', 64)
        )
      )
    );

alter table affiliate_private.affiliate_kyc_webhook_events
  drop constraint affiliate_kyc_webhook_events_outcome,
  add constraint affiliate_kyc_webhook_events_outcome
    check (
      processing_outcome in (
        'pending',
        'verified',
        'failed',
        'expired',
        'ignored_stale',
        'ignored_superseded',
        'ignored_terminal',
        'observed_sandbox',
        'quarantined'
      )
    );

alter table affiliate_private.affiliate_kyc_webhook_events
  drop constraint affiliate_kyc_webhook_events_reason,
  add constraint affiliate_kyc_webhook_events_reason
    check (
      decision_reason is null
      or decision_reason in (
        'provider_pending',
        'provider_declined',
        'provider_expired',
        'identity_checks_failed',
        'age_policy_failed',
        'country_policy_failed',
        'capacity_attestation_missing',
        'stale_event',
        'superseded_session',
        'terminal_session',
        'sandbox_non_authoritative',
        'provider_environment_mismatch',
        'provider_config_mismatch',
        'legacy_provider_binding'
      )
    );

-- Pre-binding hosted sessions cannot ever receive an exact environment and
-- configuration match. Terminalize every legacy pending row immediately so it
-- cannot block self-service KYC forever through a NULL expiry. The account
-- downgrade below separately returns any formerly active, legacy-verified
-- account to pending_verification without trusting this session.
insert into affiliate_private.affiliate_events (
  aggregate_type,
  aggregate_key,
  action,
  actor_type,
  actor_pseudonym,
  justification,
  before_state,
  after_state
)
select
  'kyc',
  session.id::text,
  'legacy_kyc_pending_session_expired',
  'system',
  account.user_pseudonym,
  'Pre-binding pending Didit session was expired because its environment and configuration cannot be proven.',
  jsonb_build_object(
    'status', session.status,
    'environment', session.provider_environment,
    'expires_at', session.expires_at
  ),
  jsonb_build_object(
    'status', 'expired',
    'environment', 'legacy_unbound',
    'reason', 'legacy_provider_binding',
    'activated', false
  )
from affiliate_private.affiliate_kyc_sessions session
join affiliate_private.affiliate_accounts account
  on account.id = session.account_id
where session.status = 'pending'
  and session.provider_environment = 'legacy_unbound';

update affiliate_private.affiliate_kyc_sessions session
set
  status = 'expired',
  provider_status = 'expired',
  expires_at = coalesce(
    session.expires_at,
    greatest(now(), session.created_at + interval '1 second')
  ),
  updated_at = now()
where session.status = 'pending'
  and session.provider_environment = 'legacy_unbound';

-- A row created before this migration has no trustworthy evidence of which
-- Didit environment and workflow-node contract produced it. Revoke any public
-- link first, then fail closed the account evidence without deleting history.
update affiliate_private.affiliate_links link
set
  status = 'revoked',
  revoked_at = coalesce(link.revoked_at, now())
where link.status = 'active'
  and exists (
    select 1
    from affiliate_private.affiliate_accounts account
    where account.id = link.account_id
      and account.verification_provider = 'didit'
      and account.verification_status = 'verified'
  );

insert into affiliate_private.affiliate_events (
  aggregate_type,
  aggregate_key,
  action,
  actor_type,
  actor_pseudonym,
  justification,
  before_state,
  after_state
)
select
  'account',
  account.id::text,
  'legacy_kyc_binding_quarantined',
  'system',
  account.user_pseudonym,
  'Pre-binding Didit evidence was quarantined because its environment and configuration cannot be proven.',
  jsonb_build_object(
    'status', account.status,
    'verification_status', account.verification_status
  ),
  jsonb_build_object(
    'status',
      case
        when account.status = 'active' then 'pending_verification'
        else account.status
      end,
    'verification_status', 'expired',
    'reason', 'legacy_provider_binding'
  )
from affiliate_private.affiliate_accounts account
where account.verification_provider = 'didit'
  and account.verification_status = 'verified';

update affiliate_private.affiliate_accounts account
set
  status = case
    when account.status = 'active' then 'held'
    else account.status
  end,
  verification_status = 'expired',
  verification_provider = case
    when account.user_id is null then null
    else 'didit'
  end,
  verification_reference = null,
  age_verified = false,
  capacity_verified = false,
  updated_at = now()
where account.verification_provider = 'didit'
  and account.verification_status = 'verified';

-- The transition guard intentionally forbids active -> pending_verification.
-- Cross the existing safe states in one migration transaction, and only for
-- accounts whose immutable audit before-state proves they were active.
update affiliate_private.affiliate_accounts account
set
  status = 'pending_verification',
  updated_at = now()
where account.status = 'held'
  and account.verification_provider = 'didit'
  and account.verification_status = 'expired'
  and exists (
    select 1
    from affiliate_private.affiliate_events event
    where event.aggregate_type = 'account'
      and event.aggregate_key = account.id::text
      and event.action = 'legacy_kyc_binding_quarantined'
      and event.before_state ->> 'status' = 'active'
  );

alter table affiliate_private.affiliate_kyc_sessions
  alter column provider_environment drop default,
  alter column provider_config_fingerprint drop default;
alter table affiliate_private.affiliate_kyc_webhook_events
  alter column provider_environment drop default,
  alter column provider_config_fingerprint drop default;

create or replace function affiliate_private.bind_kyc_session_environment()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_environment text := nullif(
    current_setting('norva.didit.environment', true),
    ''
  );
  v_fingerprint text := nullif(
    current_setting('norva.didit.config_fingerprint', true),
    ''
  );
begin
  if v_environment not in ('sandbox', 'live')
    or v_fingerprint is null
    or v_fingerprint !~ '^[0-9a-f]{64}$'
    or v_fingerprint = repeat('0', 64)
  then
    raise exception 'Didit environment binding is required'
      using errcode = '22023';
  end if;
  if new.provider_environment is not null
    and new.provider_environment is distinct from v_environment
  then
    raise exception 'Didit session environment binding conflict'
      using errcode = 'P0003';
  end if;
  if new.provider_config_fingerprint is not null
    and new.provider_config_fingerprint is distinct from v_fingerprint
  then
    raise exception 'Didit session configuration binding conflict'
      using errcode = 'P0003';
  end if;

  new.provider_environment := v_environment;
  new.provider_config_fingerprint := v_fingerprint;
  return new;
end;
$$;

-- Keep every field from the latest cumulative Admin analytics projection, but
-- replace its two KYC counters with the authoritative live-decision subset.
-- Renaming the prior implementation avoids copying hundreds of unrelated
-- Finance/Risk fields and therefore cannot silently regress their schema.
alter function affiliate_private.admin_partners_analytics(integer)
  rename to admin_partners_analytics_pre_didit_binding;
revoke all on function
  affiliate_private.admin_partners_analytics_pre_didit_binding(integer)
  from public, anon, authenticated, service_role;

create function affiliate_private.admin_partners_analytics(
  p_days integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_snapshot jsonb;
  v_daily jsonb;
  v_window_start timestamptz;
  v_window_end timestamptz;
  v_verified bigint;
begin
  v_snapshot :=
    affiliate_private.admin_partners_analytics_pre_didit_binding(p_days);

  if v_snapshot #>> '{daily_status,status}' = 'available' then
    select coalesce(
      jsonb_agg(
        jsonb_set(
          entry.value,
          '{kyc_verified}',
          to_jsonb((
            select count(*)::bigint
            from affiliate_private.affiliate_kyc_sessions session
            where session.status = 'verified'
              and session.provider = 'didit'
              and session.provider_environment = 'live'
              and session.provider_config_fingerprint
                ~ '^[0-9a-f]{64}$'
              and session.provider_config_fingerprint
                <> repeat('0', 64)
              and session.verified_at >= (
                (entry.value ->> 'date')::date::timestamp
                  at time zone 'UTC'
              )
              and session.verified_at < (
                (entry.value ->> 'date')::date::timestamp
                  at time zone 'UTC'
              ) + interval '1 day'
              and exists (
                select 1
                from affiliate_private.affiliate_kyc_webhook_events event
                where event.session_id = session.id
                  and event.processing_outcome = 'verified'
                  and event.provider_environment = 'live'
                  and event.provider_config_fingerprint =
                    session.provider_config_fingerprint
                  and event.provider_event_at = session.verified_at
              )
          )),
          false
        )
        order by entry.ordinality
      ),
      '[]'::jsonb
    )
    into v_daily
    from jsonb_array_elements(v_snapshot -> 'daily')
      with ordinality as entry(value, ordinality);
    v_snapshot := jsonb_set(v_snapshot, '{daily}', v_daily, false);
  end if;

  if v_snapshot #>> '{activation,status}' = 'available' then
    v_window_start := (v_snapshot #>> '{window,start}')::timestamptz;
    v_window_end :=
      (v_snapshot #>> '{window,end_exclusive}')::timestamptz;
    select count(*)::bigint
    into v_verified
    from affiliate_private.affiliate_kyc_sessions session
    where session.status = 'verified'
      and session.provider = 'didit'
      and session.provider_environment = 'live'
      and session.provider_config_fingerprint ~ '^[0-9a-f]{64}$'
      and session.provider_config_fingerprint <> repeat('0', 64)
      and session.verified_at >= v_window_start
      and session.verified_at < v_window_end
      and exists (
        select 1
        from affiliate_private.affiliate_kyc_webhook_events event
        where event.session_id = session.id
          and event.processing_outcome = 'verified'
          and event.provider_environment = 'live'
          and event.provider_config_fingerprint =
            session.provider_config_fingerprint
          and event.provider_event_at = session.verified_at
      );
    v_snapshot := jsonb_set(
      v_snapshot,
      '{activation,kyc_verified_sessions,value}',
      to_jsonb(v_verified),
      false
    );
  end if;

  return v_snapshot;
end;
$$;

revoke all on function
  affiliate_private.admin_partners_analytics(integer)
  from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.admin_partners_analytics(integer)
  to authenticated;

drop trigger if exists affiliate_kyc_sessions_00_bind_environment
  on affiliate_private.affiliate_kyc_sessions;
create trigger affiliate_kyc_sessions_00_bind_environment
before insert
on affiliate_private.affiliate_kyc_sessions
for each row
execute function affiliate_private.bind_kyc_session_environment();

create or replace function affiliate_private.guard_kyc_session_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'KYC sessions are retained'
      using errcode = '55000';
  elsif tg_op = 'UPDATE' then
    if new.id is distinct from old.id
      or new.account_id is distinct from old.account_id
      or new.provider is distinct from old.provider
      or new.provider_session_hash is distinct from old.provider_session_hash
      or new.provider_workflow_hash is distinct from old.provider_workflow_hash
      or new.provider_workflow_version
        is distinct from old.provider_workflow_version
      or new.provider_environment is distinct from old.provider_environment
      or new.provider_config_fingerprint
        is distinct from old.provider_config_fingerprint
      or new.consent_version is distinct from old.consent_version
      or new.created_at is distinct from old.created_at
    then
      raise exception 'KYC session identity is immutable'
        using errcode = '55000';
    end if;

    if old.status <> new.status
      and not (
        old.status = 'pending'
        and new.status in (
          'verified',
          'failed',
          'expired',
          'superseded'
        )
      )
    then
      raise exception 'invalid KYC session transition'
        using errcode = '55000';
    end if;

    if old.status <> 'pending'
      and (
        new.status is distinct from old.status
        or new.verified_at is distinct from old.verified_at
        or new.age_over_minimum is distinct from old.age_over_minimum
        or new.country_policy_match is distinct from old.country_policy_match
        or new.identity_checks_approved
          is distinct from old.identity_checks_approved
        or new.capacity_attested is distinct from old.capacity_attested
      )
    then
      raise exception 'terminal KYC decision is immutable'
        using errcode = '55000';
    end if;
  elsif new.status <> 'pending' then
    raise exception 'new KYC sessions must start pending'
      using errcode = '23514';
  elsif new.provider_environment not in ('sandbox', 'live')
    or new.provider_config_fingerprint !~ '^[0-9a-f]{64}$'
    or new.provider_config_fingerprint = repeat('0', 64)
  then
    raise exception 'new KYC sessions require an authoritative binding'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create or replace function
affiliate_private.bind_kyc_webhook_event_environment()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_environment text;
  v_fingerprint text;
begin
  select
    session.provider_environment,
    session.provider_config_fingerprint
  into v_environment, v_fingerprint
  from affiliate_private.affiliate_kyc_sessions session
  where session.id = new.session_id;
  if not found then
    raise exception 'Didit session is unavailable'
      using errcode = 'P0006';
  end if;

  if new.provider_environment is null then
    new.provider_environment := v_environment;
  end if;
  if new.provider_config_fingerprint is null then
    new.provider_config_fingerprint := v_fingerprint;
  end if;
  if new.provider_environment not in ('sandbox', 'live')
    or new.provider_config_fingerprint !~ '^[0-9a-f]{64}$'
    or new.provider_config_fingerprint = repeat('0', 64)
  then
    raise exception 'Didit webhook environment binding is required'
      using errcode = '22023';
  end if;
  if new.processing_outcome <> 'quarantined'
    and (
      new.provider_environment is distinct from v_environment
      or new.provider_config_fingerprint is distinct from v_fingerprint
    )
  then
    raise exception 'Didit webhook binding conflict'
      using errcode = 'P0003';
  end if;

  return new;
end;
$$;

drop trigger if exists affiliate_kyc_webhook_events_00_bind_environment
  on affiliate_private.affiliate_kyc_webhook_events;
create trigger affiliate_kyc_webhook_events_00_bind_environment
before insert
on affiliate_private.affiliate_kyc_webhook_events
for each row
execute function affiliate_private.bind_kyc_webhook_event_environment();

create or replace function affiliate_private.partners_service_kyc_session_record(
  p_user_id uuid,
  p_idempotency_key text,
  p_provider_session_id text,
  p_provider_workflow_id text,
  p_provider_workflow_version integer,
  p_provider_status text,
  p_expires_at timestamptz,
  p_reservation_key text,
  p_provider_environment text,
  p_provider_config_fingerprint text,
  p_provider_session_ttl_seconds integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_environment text := lower(btrim(
    coalesce(p_provider_environment, '')
  ));
  v_fingerprint text := lower(btrim(
    coalesce(p_provider_config_fingerprint, '')
  ));
  v_session_hash text;
  v_session affiliate_private.affiliate_kyc_sessions%rowtype;
  v_effective_expires_at timestamptz;
  v_response jsonb;
begin
  if v_environment not in ('sandbox', 'live')
    or v_fingerprint !~ '^[0-9a-f]{64}$'
    or v_fingerprint = repeat('0', 64)
    or p_provider_session_ttl_seconds is null
    or p_provider_session_ttl_seconds not between 3600 and 2419200
  then
    raise exception 'invalid Didit environment binding'
      using errcode = '22023';
  end if;

  perform set_config('norva.didit.environment', v_environment, true);
  perform set_config(
    'norva.didit.config_fingerprint',
    v_fingerprint,
    true
  );

  select least(
    coalesce(
      p_expires_at,
      reservation.created_at
        + make_interval(secs => p_provider_session_ttl_seconds)
    ),
    reservation.created_at
      + make_interval(secs => p_provider_session_ttl_seconds)
  )
  into v_effective_expires_at
  from affiliate_private.affiliate_kyc_session_reservations reservation
  join affiliate_private.affiliate_accounts account
    on account.id = reservation.account_id
  where reservation.reservation_key = p_reservation_key
    and account.user_id = p_user_id;
  if v_effective_expires_at is null then
    raise exception 'Didit reservation is unavailable'
      using errcode = 'P0006';
  end if;

  v_response :=
    affiliate_private.partners_service_kyc_session_record(
      p_user_id,
      p_idempotency_key,
      p_provider_session_id,
      p_provider_workflow_id,
      p_provider_workflow_version,
      p_provider_status,
      v_effective_expires_at,
      p_reservation_key
    );

  v_session_hash := encode(
    extensions.digest(
      'norva:didit:session:v1:' || p_provider_session_id,
      'sha256'
    ),
    'hex'
  );
  select session.*
  into v_session
  from affiliate_private.affiliate_kyc_sessions session
  where session.provider_session_hash = v_session_hash;
  if not found
    or v_session.provider_environment is distinct from v_environment
    or v_session.provider_config_fingerprint is distinct from v_fingerprint
  then
    raise exception 'provider session environment binding conflict'
      using errcode = 'P0003';
  end if;

  return v_response;
end;
$$;

create or replace function affiliate_private.partners_service_kyc_webhook_apply(
  p_provider_event_id text,
  p_provider_session_id text,
  p_provider_workflow_id text,
  p_provider_workflow_version integer,
  p_provider_status text,
  p_event_created_at timestamptz,
  p_document_age integer,
  p_document_country_iso3 text,
  p_id_check_approved boolean,
  p_liveness_approved boolean,
  p_face_match_approved boolean,
  p_payload_hash text,
  p_provider_environment text,
  p_provider_config_fingerprint text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_provider_status text := lower(
    replace(btrim(coalesce(p_provider_status, '')), ' ', '_')
  );
  v_environment text := lower(btrim(
    coalesce(p_provider_environment, '')
  ));
  v_fingerprint text := lower(btrim(
    coalesce(p_provider_config_fingerprint, '')
  ));
  v_iso3 text := nullif(upper(btrim(
    coalesce(p_document_country_iso3, '')
  )), '');
  v_payload_hash text := lower(btrim(coalesce(p_payload_hash, '')));
  v_event_hash text;
  v_session_hash text;
  v_workflow_hash text;
  v_reason text;
  v_outcome text;
  v_response jsonb;
  v_existing_event affiliate_private.affiliate_kyc_webhook_events%rowtype;
  v_session affiliate_private.affiliate_kyc_sessions%rowtype;
  v_account affiliate_private.affiliate_accounts%rowtype;
begin
  if p_provider_event_id is null
    or length(p_provider_event_id) not between 8 and 255
    or p_provider_event_id ~ '[[:space:][:cntrl:]]'
    or p_provider_session_id is null
    or length(p_provider_session_id) not between 8 and 255
    or p_provider_session_id ~ '[[:space:][:cntrl:]]'
    or p_provider_workflow_id is null
    or length(p_provider_workflow_id) not between 3 and 255
    or p_provider_workflow_id ~ '[[:space:][:cntrl:]]'
    or p_provider_workflow_version is null
    or p_provider_workflow_version < 1
    or not affiliate_private.partners_valid_didit_status(v_provider_status)
    or p_event_created_at is null
    or p_event_created_at > now() + interval '5 minutes'
    or v_payload_hash !~ '^[0-9a-f]{64}$'
    or v_environment not in ('sandbox', 'live')
    or v_fingerprint !~ '^[0-9a-f]{64}$'
    or v_fingerprint = repeat('0', 64)
  then
    raise exception 'invalid Didit webhook envelope'
      using errcode = '22023';
  end if;

  if v_provider_status = 'approved' then
    if p_id_check_approved is null
      or p_liveness_approved is null
      or p_face_match_approved is null
    then
      raise exception 'approved Didit result lacks required checks'
        using errcode = '22023';
    end if;
    if p_id_check_approved
      and (
        p_document_age is null
        or p_document_age not between 0 and 120
        or v_iso3 is null
        or v_iso3 !~ '^[A-Z]{3}$'
      )
    then
      raise exception 'approved identity result lacks policy evidence'
        using errcode = '22023';
    end if;
  end if;

  v_event_hash := encode(
    extensions.digest(
      'norva:didit:event:v1:' || p_provider_event_id,
      'sha256'
    ),
    'hex'
  );
  v_session_hash := encode(
    extensions.digest(
      'norva:didit:session:v1:' || p_provider_session_id,
      'sha256'
    ),
    'hex'
  );
  v_workflow_hash := encode(
    extensions.digest(
      'norva:didit:workflow:v1:' || p_provider_workflow_id,
      'sha256'
    ),
    'hex'
  );

  perform pg_advisory_xact_lock(
    hashtextextended('norva:partners:didit:' || v_session_hash, 0)
  );

  select event.*
  into v_existing_event
  from affiliate_private.affiliate_kyc_webhook_events event
  where event.provider_event_hash = v_event_hash;
  if found then
    if v_existing_event.payload_hash <> v_payload_hash
      or v_existing_event.provider_status <> v_provider_status
    then
      raise exception 'Didit event replay payload conflict'
        using errcode = 'P0003';
    end if;
    if v_existing_event.provider_environment is not distinct from v_environment
      and v_existing_event.provider_config_fingerprint
        is not distinct from v_fingerprint
    then
      return v_existing_event.response
        || jsonb_build_object('replayed', true);
    end if;

    select session.*
    into v_session
    from affiliate_private.affiliate_kyc_sessions session
    where session.id = v_existing_event.session_id;
    select account.*
    into v_account
    from affiliate_private.affiliate_accounts account
    where account.id = v_session.account_id;

    v_reason := case
      when v_existing_event.provider_environment = 'legacy_unbound'
        then 'legacy_provider_binding'
      when v_existing_event.provider_environment <> v_environment
        then 'provider_environment_mismatch'
      else 'provider_config_mismatch'
    end;
    v_response := jsonb_build_object(
      'schema_version', 1,
      'action', 'kyc_result_quarantined',
      'replayed', false,
      'environment', v_environment,
      'reason', v_reason
    );
    insert into affiliate_private.affiliate_events (
      aggregate_type,
      aggregate_key,
      action,
      actor_type,
      actor_pseudonym,
      justification,
      after_state
    )
    values (
      'kyc',
      v_event_hash,
      'kyc_webhook_binding_conflict',
      'service',
      v_account.user_pseudonym,
      'A signed Didit event replay did not match its immutable environment binding.',
      jsonb_build_object(
        'outcome', 'quarantined',
        'environment', v_environment,
        'reason', v_reason
      )
    )
    on conflict do nothing;
    return v_response;
  end if;

  select session.*
  into v_session
  from affiliate_private.affiliate_kyc_sessions session
  where session.provider_session_hash = v_session_hash
  for update;
  if not found then
    raise exception 'Didit session is unavailable'
      using errcode = 'P0006';
  end if;

  select account.*
  into v_account
  from affiliate_private.affiliate_accounts account
  where account.id = v_session.account_id
  for update;
  if not found then
    raise exception 'Partners account is unavailable'
      using errcode = 'P0002';
  end if;

  v_reason := case
    when v_session.provider_environment = 'legacy_unbound'
      then 'legacy_provider_binding'
    when v_session.provider_environment <> v_environment
      then 'provider_environment_mismatch'
    when v_session.provider_workflow_hash <> v_workflow_hash
      or v_session.provider_workflow_version <> p_provider_workflow_version
      then 'provider_config_mismatch'
    when v_session.provider_config_fingerprint <> v_fingerprint
      then 'provider_config_mismatch'
    when v_environment = 'sandbox'
      then 'sandbox_non_authoritative'
    else null
  end;

  if v_reason is not null then
    v_outcome := case
      when v_reason = 'sandbox_non_authoritative'
        then 'observed_sandbox'
      else 'quarantined'
    end;
    v_response := jsonb_build_object(
      'schema_version', 1,
      'action', case
        when v_outcome = 'observed_sandbox'
          then 'kyc_result_observed'
        else 'kyc_result_quarantined'
      end,
      'replayed', false,
      'environment', v_environment,
      'reason', v_reason
    );

    if v_session.status = 'pending'
      and v_outcome = 'observed_sandbox'
    then
      update affiliate_private.affiliate_kyc_sessions
      set
        status = 'superseded',
        provider_status = v_provider_status,
        last_event_created_at = p_event_created_at,
        updated_at = now()
      where id = v_session.id
      returning * into v_session;
    elsif v_session.status = 'pending'
      and v_outcome = 'quarantined'
    then
      update affiliate_private.affiliate_kyc_sessions
      set
        expires_at = least(
          coalesce(expires_at, now() + interval '15 minutes'),
          now() + interval '15 minutes'
        ),
        updated_at = now()
      where id = v_session.id
      returning * into v_session;
    end if;

    insert into affiliate_private.affiliate_kyc_webhook_events (
      provider_event_hash,
      session_id,
      provider_status,
      provider_event_at,
      payload_hash,
      processing_outcome,
      decision_reason,
      response,
      provider_environment,
      provider_config_fingerprint
    )
    values (
      v_event_hash,
      v_session.id,
      v_provider_status,
      p_event_created_at,
      v_payload_hash,
      v_outcome,
      v_reason,
      v_response,
      v_environment,
      v_fingerprint
    );

    insert into affiliate_private.affiliate_events (
      aggregate_type,
      aggregate_key,
      action,
      actor_type,
      actor_pseudonym,
      justification,
      after_state
    )
    values (
      'kyc',
      v_account.id::text,
      case
        when v_outcome = 'observed_sandbox'
          then 'kyc_sandbox_result_observed'
        else 'kyc_webhook_quarantined'
      end,
      'service',
      v_account.user_pseudonym,
      case
        when v_outcome = 'observed_sandbox'
          then 'Signed sandbox KYC result was retained as non-authoritative test evidence.'
        else 'Signed KYC result was quarantined because its immutable provider binding did not match.'
      end,
      jsonb_build_object(
        'status', v_session.status,
        'outcome', v_outcome,
        'environment', v_environment,
        'reason', v_reason,
        'recovery_expires_at', case
          when v_outcome = 'quarantined' then v_session.expires_at
          else null
        end,
        'activated', false
      )
    );
    return v_response;
  end if;

  -- Provider event time, rather than delivery time, decides whether an exact
  -- live decision was made inside the bounded hosted-session contract.
  if v_session.status = 'pending'
    and v_session.expires_at is not null
    and p_event_created_at >= v_session.expires_at
  then
    update affiliate_private.affiliate_kyc_sessions
    set
      status = 'expired',
      provider_status = 'expired',
      updated_at = now()
    where id = v_session.id
    returning * into v_session;

    insert into affiliate_private.affiliate_events (
      aggregate_type,
      aggregate_key,
      action,
      actor_type,
      actor_pseudonym,
      justification,
      after_state
    )
    values (
      'kyc',
      v_session.id::text,
      'kyc_session_local_expired',
      'service',
      v_account.user_pseudonym,
      'The signed Didit decision was created after the bounded local session deadline.',
      jsonb_build_object(
        'status', 'expired',
        'expires_at', v_session.expires_at,
        'provider_event_at', p_event_created_at,
        'activated', false
      )
    );
  end if;

  -- The original reducer remains the single policy-decision implementation.
  -- It is reachable here only after an exact live environment binding match.
  return affiliate_private.partners_service_kyc_webhook_apply(
    p_provider_event_id,
    p_provider_session_id,
    p_provider_workflow_id,
    p_provider_workflow_version,
    p_provider_status,
    p_event_created_at,
    p_document_age,
    p_document_country_iso3,
    p_id_check_approved,
    p_liveness_approved,
    p_face_match_approved,
    p_payload_hash
  );
end;
$$;

create index affiliate_kyc_sessions_pending_expiry_idx
  on affiliate_private.affiliate_kyc_sessions (expires_at, id)
  where status = 'pending' and expires_at is not null;

create or replace function
affiliate_private.partners_service_kyc_binding_recover(
  p_limit integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_expired bigint;
begin
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'invalid KYC recovery batch'
      using errcode = '22023';
  end if;

  with candidates as (
    select session.id
    from affiliate_private.affiliate_kyc_sessions session
    where session.status = 'pending'
      and session.expires_at is not null
      and session.expires_at <= now()
    order by session.expires_at, session.id
    limit p_limit
    for update skip locked
  ),
  expired as (
    update affiliate_private.affiliate_kyc_sessions session
    set
      status = 'expired',
      provider_status = 'expired',
      updated_at = now()
    from candidates candidate
    where session.id = candidate.id
      and session.status = 'pending'
    returning session.id, session.account_id, session.expires_at
  ),
  audited as (
    insert into affiliate_private.affiliate_events (
      aggregate_type,
      aggregate_key,
      action,
      actor_type,
      actor_pseudonym,
      justification,
      after_state
    )
    select
      'kyc',
      expired.id::text,
      'kyc_session_recovery_expired',
      'service',
      account.user_pseudonym,
      'Bounded KYC recovery expired a pending hosted session after its local deadline.',
      jsonb_build_object(
        'status', 'expired',
        'expires_at', expired.expires_at
      )
    from expired
    join affiliate_private.affiliate_accounts account
      on account.id = expired.account_id
    returning 1
  )
  select count(*)::bigint
  into v_expired
  from audited;

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'kyc_binding_recovery_completed',
    'expired', coalesce(v_expired, 0)
  );
end;
$$;

create or replace function public.partners_service_kyc_session_record(
  p_user_id uuid,
  p_idempotency_key text,
  p_provider_session_id text,
  p_provider_workflow_id text,
  p_provider_workflow_version integer,
  p_provider_status text,
  p_expires_at timestamptz,
  p_reservation_key text,
  p_provider_environment text,
  p_provider_config_fingerprint text,
  p_provider_session_ttl_seconds integer
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.partners_service_kyc_session_record(
    p_user_id,
    p_idempotency_key,
    p_provider_session_id,
    p_provider_workflow_id,
    p_provider_workflow_version,
    p_provider_status,
    p_expires_at,
    p_reservation_key,
    p_provider_environment,
    p_provider_config_fingerprint,
    p_provider_session_ttl_seconds
  );
$$;

create or replace function public.partners_service_kyc_webhook_apply(
  p_provider_event_id text,
  p_provider_session_id text,
  p_provider_workflow_id text,
  p_provider_workflow_version integer,
  p_provider_status text,
  p_event_created_at timestamptz,
  p_document_age integer,
  p_document_country_iso3 text,
  p_id_check_approved boolean,
  p_liveness_approved boolean,
  p_face_match_approved boolean,
  p_payload_hash text,
  p_provider_environment text,
  p_provider_config_fingerprint text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.partners_service_kyc_webhook_apply(
    p_provider_event_id,
    p_provider_session_id,
    p_provider_workflow_id,
    p_provider_workflow_version,
    p_provider_status,
    p_event_created_at,
    p_document_age,
    p_document_country_iso3,
    p_id_check_approved,
    p_liveness_approved,
    p_face_match_approved,
    p_payload_hash,
    p_provider_environment,
    p_provider_config_fingerprint
  );
$$;

create or replace function public.partners_service_kyc_binding_recover(
  p_limit integer
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.partners_service_kyc_binding_recover(p_limit);
$$;

revoke all on function affiliate_private.bind_kyc_session_environment()
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.bind_kyc_webhook_event_environment()
  from public, anon, authenticated, service_role;

-- The pre-binding overloads remain owner-only so the new checked overload can
-- reuse the original reducers without leaving a service-role bypass.
revoke all on function
  affiliate_private.partners_service_kyc_session_record(
    uuid, text, text, text, integer, text, timestamptz, text
  )
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.partners_service_kyc_webhook_apply(
    text, text, text, integer, text, timestamptz, integer, text,
    boolean, boolean, boolean, text
  )
  from public, anon, authenticated, service_role;
revoke all on function public.partners_service_kyc_session_record(
  uuid, text, text, text, integer, text, timestamptz, text
) from public, anon, authenticated, service_role;
revoke all on function public.partners_service_kyc_webhook_apply(
  text, text, text, integer, text, timestamptz, integer, text,
  boolean, boolean, boolean, text
) from public, anon, authenticated, service_role;

revoke all on function
  affiliate_private.partners_service_kyc_session_record(
    uuid, text, text, text, integer, text, timestamptz, text, text, text,
    integer
  )
  from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.partners_service_kyc_session_record(
    uuid, text, text, text, integer, text, timestamptz, text, text, text,
    integer
  )
  to service_role;
revoke all on function
  affiliate_private.partners_service_kyc_webhook_apply(
    text, text, text, integer, text, timestamptz, integer, text,
    boolean, boolean, boolean, text, text, text
  )
  from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.partners_service_kyc_webhook_apply(
    text, text, text, integer, text, timestamptz, integer, text,
    boolean, boolean, boolean, text, text, text
  )
  to service_role;

revoke all on function public.partners_service_kyc_session_record(
  uuid, text, text, text, integer, text, timestamptz, text, text, text,
  integer
) from public, anon, authenticated, service_role;
grant execute on function public.partners_service_kyc_session_record(
  uuid, text, text, text, integer, text, timestamptz, text, text, text,
  integer
) to service_role;
revoke all on function public.partners_service_kyc_webhook_apply(
  text, text, text, integer, text, timestamptz, integer, text,
  boolean, boolean, boolean, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.partners_service_kyc_webhook_apply(
  text, text, text, integer, text, timestamptz, integer, text,
  boolean, boolean, boolean, text, text, text
) to service_role;
revoke all on function
  affiliate_private.partners_service_kyc_binding_recover(integer)
  from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.partners_service_kyc_binding_recover(integer)
  to service_role;
revoke all on function public.partners_service_kyc_binding_recover(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.partners_service_kyc_binding_recover(integer)
  to service_role;

-- Quarantines are not merely retained in the append-only webhook log: surface
-- recent binding conflicts through the existing Admin/ops snapshot as a
-- critical alert. Expected sandbox observations remain auditable without
-- creating a production alarm.
create index
  affiliate_kyc_webhook_events_binding_quarantine_recent_idx
  on affiliate_private.affiliate_kyc_webhook_events (created_at desc)
  where processing_outcome = 'quarantined';
create index affiliate_events_kyc_binding_quarantine_recent_idx
  on affiliate_private.affiliate_events (created_at desc)
  where aggregate_type = 'kyc'
    and action = 'kyc_webhook_binding_conflict';
create unique index affiliate_events_kyc_binding_quarantine_once_idx
  on affiliate_private.affiliate_events (aggregate_key)
  where aggregate_type = 'kyc'
    and action = 'kyc_webhook_binding_conflict';
create index affiliate_events_legacy_kyc_quarantine_recent_idx
  on affiliate_private.affiliate_events (created_at desc)
  where aggregate_type = 'account'
    and action = 'legacy_kyc_binding_quarantined';

-- Preserve the complete cumulative projection delivered by the preceding
-- migrations and extend it with the Didit binding quarantine signal.
create or replace function affiliate_private.partners_ops_alert_snapshot()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_workers jsonb;
  v_alerts jsonb;
  v_kyc_used bigint;
begin
  with expected(worker_name) as (
    values
      ('commission'::text),
      ('correction'::text),
      ('maturation'::text),
      ('reconciliation'::text),
      ('payout'::text),
      ('revenuecat_transfer'::text)
  )
  select jsonb_agg(
    jsonb_build_object(
      'worker', e.worker_name,
      'status', case
        when h.worker_name is null then 'not_configured'
        when h.last_seen_at < now() - interval '15 minutes' then 'stale'
        else h.status
      end,
      'last_seen_at', h.last_seen_at
    )
    order by e.worker_name
  )
  into v_workers
  from expected e
  left join affiliate_private.affiliate_worker_heartbeats h
    on h.worker_name = e.worker_name;

  select count(*)
  into v_kyc_used
  from affiliate_private.affiliate_kyc_sessions
  where created_at >= now() - interval '30 days';

  with alerts as (
    select
      'commission_dead_letter'::text as code,
      'critical'::text as severity,
      count(*)::bigint as count
    from affiliate_private.affiliate_commission_jobs
    where status = 'dead_letter'
    having count(*) > 0
    union all
    select
      'chargeback_reversal_dead_letter',
      'critical',
      count(*)::bigint
    from affiliate_private.affiliate_revolut_dispute_won_jobs
    where status = 'dead_letter'
    having count(*) > 0
    union all
    select
      'chargeback_reversal_conflict',
      'critical',
      count(*)::bigint
    from affiliate_private.affiliate_revolut_dispute_won_conflicts
    having count(*) > 0
    union all
    select
      'maturation_dead_letter',
      'critical',
      count(*)::bigint
    from affiliate_private.affiliate_maturation_jobs
    where status = 'dead_letter'
    having count(*) > 0
    union all
    select
      'financial_fact_conflict',
      'critical',
      count(*)::bigint
    from affiliate_private.affiliate_financial_fact_conflicts
    having count(*) > 0
    union all
    select
      'financial_transfer_quarantined_recent',
      'warning',
      count(*)::bigint
    from affiliate_private.affiliate_financial_facts
    where event_type = 'transfer'
      and facts_status = 'quarantined'
      and created_at >= now() - interval '24 hours'
    having count(*) > 0
    union all
    select
      'revenuecat_transfer_dead_letter',
      'critical',
      count(*)::bigint
    from (
      select 1
      from public.cloud_revenuecat_transfer_events
      where status = 'dead_letter'
      limit 1000000
    ) bounded
    having count(*) > 0
    union all
    select
      'revenuecat_transfer_partial_aged',
      'warning',
      count(*)::bigint
    from (
      select 1
      from public.cloud_revenuecat_transfer_events
      where status = 'partial'
        and first_seen_at < now() - interval '15 minutes'
      limit 1000000
    ) bounded
    having count(*) > 0
    union all
    select
      'revenuecat_transfer_quarantined_aged',
      'warning',
      count(*)::bigint
    from (
      select 1
      from public.cloud_revenuecat_transfer_events
      where status = 'quarantined'
        and first_seen_at < now() - interval '15 minutes'
      limit 1000000
    ) bounded
    having count(*) > 0
    union all
    select
      'revenuecat_transfer_partner_dead_letter',
      'critical',
      count(*)::bigint
    from (
      select 1
      from public.cloud_revenuecat_transfer_events
      where status = 'applied'
        and partner_status = 'dead_letter'
      limit 1000000
    ) bounded
    having count(*) > 0
    union all
    select
      'shadow_reconciliation_mismatch',
      'critical',
      r.mismatch_count
    from affiliate_private.affiliate_shadow_reconciliation_runs r
    where r.id = (
      select latest.id
      from affiliate_private.affiliate_shadow_reconciliation_runs latest
      order by latest.created_at desc
      limit 1
    )
      and r.status = 'mismatch'
    union all
    select
      'kyc_provider_binding_quarantined_recent',
      'critical',
      count(*)::bigint
    from (
      select event.created_at
      from affiliate_private.affiliate_kyc_webhook_events event
      where event.processing_outcome = 'quarantined'
      union all
      select audit.created_at
      from affiliate_private.affiliate_events audit
      where audit.aggregate_type = 'kyc'
        and audit.action = 'kyc_webhook_binding_conflict'
    ) quarantined
    where quarantined.created_at >= now() - interval '24 hours'
    having count(*) > 0
    union all
    select
      'kyc_legacy_binding_quarantined_recent',
      'critical',
      count(*)::bigint
    from affiliate_private.affiliate_events audit
    where audit.aggregate_type = 'account'
      and audit.action = 'legacy_kyc_binding_quarantined'
      and audit.created_at >= now() - interval '24 hours'
    having count(*) > 0
    union all
    select
      'kyc_binding_recovery_overdue',
      'critical',
      count(*)::bigint
    from affiliate_private.affiliate_kyc_sessions session
    where session.status = 'pending'
      and session.expires_at is not null
      and session.expires_at <= now() - interval '5 minutes'
    having count(*) > 0
    union all
    select
      'kyc_quota_warning',
      case when v_kyc_used >= 500 then 'critical' else 'warning' end,
      v_kyc_used
    where v_kyc_used >= 400
    union all
    select
      'worker_heartbeat_missing',
      'critical',
      count(*)::bigint
    from (
      values
        ('commission'::text),
        ('correction'::text),
        ('maturation'::text),
        ('reconciliation'::text),
        ('payout'::text),
        ('revenuecat_transfer'::text)
    ) expected(worker_name)
    left join affiliate_private.affiliate_worker_heartbeats h
      on h.worker_name = expected.worker_name
      and h.last_seen_at >= now() - interval '15 minutes'
    where h.worker_name is null
    having count(*) > 0
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'code', a.code,
        'severity', a.severity,
        'count', a.count
      )
      order by a.severity, a.code
    ),
    '[]'::jsonb
  )
  into v_alerts
  from alerts a;

  return jsonb_build_object(
    'schema_version', 1,
    'workers', v_workers,
    'alerts', v_alerts,
    'kyc_quota', jsonb_build_object(
      'used', v_kyc_used,
      'informational_limit', 500,
      'blocking', false
    )
  );
end;
$$;

notify pgrst, 'reload schema';
