-- Norva Partners - isolated, pre-gate Didit certification.
--
-- This path lets an existing live Admin+Risk operator exercise the hosted
-- Didit workflow before individual_verification_coverage_confirmed can be
-- approved. It is intentionally unable to create or mutate a Partners
-- account, link, attribution, commission, payout, feature flag or release
-- gate. Provider identifiers are accepted only by service-role RPCs and are
-- irreversibly hashed before persistence.

alter default privileges in schema affiliate_private
  revoke execute on functions from public;
alter default privileges in schema affiliate_private
  revoke all on tables from public, anon, authenticated, service_role;
alter default privileges in schema affiliate_private
  revoke all on sequences from public, anon, authenticated, service_role;

-- A provider session may belong to exactly one Norva purpose. The registry is
-- deliberately independent from affiliate_accounts so the certification path
-- cannot inherit the member lifecycle or its release-gate side effects.
create table affiliate_private.affiliate_didit_session_registry (
  provider_session_hash text primary key,
  session_purpose       text not null,
  source_record_id      uuid not null,
  registered_at         timestamptz not null default now(),
  constraint affiliate_didit_session_registry_hash
    check (provider_session_hash ~ '^[0-9a-f]{64}$'),
  constraint affiliate_didit_session_registry_purpose
    check (session_purpose in ('member_kyc', 'certification')),
  constraint affiliate_didit_session_registry_source_once
    unique (session_purpose, source_record_id)
);

create or replace function
affiliate_private.register_member_didit_session()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  insert into affiliate_private.affiliate_didit_session_registry (
    provider_session_hash,
    session_purpose,
    source_record_id,
    registered_at
  )
  values (
    new.provider_session_hash,
    'member_kyc',
    new.id,
    new.created_at
  );
  return new;
end;
$$;

create trigger affiliate_kyc_sessions_register_didit_purpose
after insert on affiliate_private.affiliate_kyc_sessions
for each row
execute function affiliate_private.register_member_didit_session();

-- Install the writer before copying historical rows. An insert that races the
-- migration is therefore captured by the trigger, while the backfill remains
-- idempotent if that exact member session was registered milliseconds first.
insert into affiliate_private.affiliate_didit_session_registry (
  provider_session_hash,
  session_purpose,
  source_record_id,
  registered_at
)
select
  session.provider_session_hash,
  'member_kyc',
  session.id,
  session.created_at
from affiliate_private.affiliate_kyc_sessions session
on conflict do nothing;

create table affiliate_private.affiliate_didit_certification_sessions (
  id                           uuid primary key default gen_random_uuid(),
  certification_key_hash       text not null unique,
  operator_hash                text not null,
  idempotency_key_hash         text not null,
  request_hash                 text not null,
  confirmation_hash            text not null,
  justification_hash           text not null,
  consent_version              text not null,
  capacity_attested            boolean not null,
  provider_session_hash        text unique,
  provider_workflow_hash       text,
  provider_workflow_version    integer,
  provider_environment         text,
  provider_config_fingerprint  text,
  provider_status              text,
  provider_create_dispatched_at timestamptz,
  status                       text not null default 'reserved',
  id_check_approved            boolean,
  liveness_approved            boolean,
  face_match_approved          boolean,
  age_over_minimum             boolean,
  jurisdiction_result_present  boolean,
  verified                     boolean not null default false,
  quarantine_reason            text,
  last_event_created_at        timestamptz,
  verified_at                  timestamptz,
  quarantined_at               timestamptz,
  expires_at                   timestamptz not null,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now(),
  constraint affiliate_didit_certification_sessions_hashes
    check (
      certification_key_hash ~ '^[0-9a-f]{64}$'
      and operator_hash ~ '^[0-9a-f]{64}$'
      and idempotency_key_hash ~ '^[0-9a-f]{64}$'
      and request_hash ~ '^[0-9a-f]{64}$'
      and confirmation_hash ~ '^[0-9a-f]{64}$'
      and justification_hash ~ '^[0-9a-f]{64}$'
      and (
        provider_session_hash is null
        or provider_session_hash ~ '^[0-9a-f]{64}$'
      )
      and (
        provider_workflow_hash is null
        or provider_workflow_hash ~ '^[0-9a-f]{64}$'
      )
      and (
        provider_config_fingerprint is null
        or provider_config_fingerprint ~ '^[0-9a-f]{64}$'
      )
    ),
  constraint affiliate_didit_certification_sessions_idempotency
    unique (operator_hash, idempotency_key_hash),
  constraint affiliate_didit_certification_sessions_consent
    check (consent_version = 'partners-didit-certification-v1'),
  constraint affiliate_didit_certification_sessions_capacity
    check (capacity_attested),
  constraint affiliate_didit_certification_sessions_workflow_version
    check (
      provider_workflow_version is null
      or provider_workflow_version = 1
    ),
  constraint affiliate_didit_certification_sessions_environment
    check (
      provider_environment is null
      or provider_environment in ('sandbox', 'live')
    ),
  constraint affiliate_didit_certification_sessions_provider_status
    check (
      provider_status is null
      or affiliate_private.partners_valid_didit_status(provider_status)
    ),
  constraint affiliate_didit_certification_sessions_status
    check (
      status in (
        'reserved',
        'pending',
        'in_review',
        'approved',
        'declined',
        'expired',
        'quarantined'
      )
    ),
  constraint affiliate_didit_certification_sessions_binding
    check (
      (
        provider_session_hash is null
        and provider_workflow_hash is null
        and provider_workflow_version is null
        and provider_environment is null
        and provider_config_fingerprint is null
        and provider_status is null
      )
      or (
        provider_session_hash is not null
        and provider_workflow_hash is not null
        and provider_workflow_version is not null
        and provider_environment is not null
        and provider_config_fingerprint is not null
        and provider_status is not null
        and provider_create_dispatched_at is not null
      )
    ),
  constraint affiliate_didit_certification_sessions_reserved
    check (status <> 'reserved' or provider_session_hash is null),
  constraint affiliate_didit_certification_sessions_verified
    check (
      not verified
      or (
        status = 'approved'
        and provider_environment = 'live'
        and id_check_approved
        and liveness_approved
        and face_match_approved
        and age_over_minimum
        and jurisdiction_result_present
        and verified_at is not null
      )
    ),
  constraint affiliate_didit_certification_sessions_quarantine
    check (
      (status = 'quarantined')
      = (quarantine_reason is not null and quarantined_at is not null)
    ),
  constraint affiliate_didit_certification_sessions_quarantine_reason
    check (
      quarantine_reason is null
      or quarantine_reason in (
        'cross_purpose_session_conflict',
        'session_binding_conflict',
        'workflow_mismatch',
        'workflow_version_mismatch',
        'environment_mismatch',
        'config_fingerprint_mismatch',
        'event_before_session',
        'approved_checks_incomplete',
        'event_replay_conflict'
      )
    ),
  constraint affiliate_didit_certification_sessions_expiry
    check (
      expires_at > created_at
      and expires_at <= created_at + interval '2 hours'
    ),
  constraint affiliate_didit_certification_sessions_timestamps
    check (
      updated_at >= created_at
      and (
        provider_create_dispatched_at is null
        or (
          provider_create_dispatched_at >= created_at
          and provider_create_dispatched_at < expires_at
        )
      )
      and (verified_at is null or verified_at >= created_at)
      and (quarantined_at is null or quarantined_at >= created_at)
      and (
        last_event_created_at is null
        or last_event_created_at >= created_at - interval '5 minutes'
      )
    )
);

create unique index affiliate_didit_certification_sessions_active_operator_idx
  on affiliate_private.affiliate_didit_certification_sessions (
    operator_hash
  )
  where status in ('reserved', 'pending', 'in_review');

create index affiliate_didit_certification_sessions_operator_idx
  on affiliate_private.affiliate_didit_certification_sessions (
    operator_hash,
    created_at desc
  );

create table affiliate_private.affiliate_didit_certification_events (
  id                           uuid primary key default gen_random_uuid(),
  certification_session_id     uuid not null
    references affiliate_private.affiliate_didit_certification_sessions(id)
    on delete restrict,
  provider_event_hash          text not null unique,
  provider_session_hash        text not null,
  provider_workflow_hash       text not null,
  provider_workflow_version    integer not null,
  provider_environment         text not null,
  provider_config_fingerprint  text not null,
  payload_hash                 text not null,
  provider_status              text not null,
  processing_outcome           text not null,
  bounded_reason               text,
  id_check_approved            boolean,
  liveness_approved            boolean,
  face_match_approved          boolean,
  age_over_minimum             boolean,
  jurisdiction_result_present  boolean,
  verified                     boolean not null default false,
  provider_event_created_at    timestamptz not null,
  created_at                   timestamptz not null default now(),
  constraint affiliate_didit_certification_events_hashes
    check (
      provider_event_hash ~ '^[0-9a-f]{64}$'
      and provider_session_hash ~ '^[0-9a-f]{64}$'
      and provider_workflow_hash ~ '^[0-9a-f]{64}$'
      and provider_config_fingerprint ~ '^[0-9a-f]{64}$'
      and payload_hash ~ '^[0-9a-f]{64}$'
    ),
  constraint affiliate_didit_certification_events_workflow_version
    check (provider_workflow_version between 1 and 2147483647),
  constraint affiliate_didit_certification_events_environment
    check (provider_environment in ('sandbox', 'live')),
  constraint affiliate_didit_certification_events_provider_status
    check (affiliate_private.partners_valid_didit_status(provider_status)),
  constraint affiliate_didit_certification_events_outcome
    check (processing_outcome in ('applied', 'ignored', 'quarantined')),
  constraint affiliate_didit_certification_events_reason
    check (
      bounded_reason is null
      or bounded_reason in (
        'stale_event',
        'workflow_mismatch',
        'workflow_version_mismatch',
        'environment_mismatch',
        'config_fingerprint_mismatch',
        'event_before_session',
        'approved_checks_incomplete'
      )
    ),
  constraint affiliate_didit_certification_events_quarantine
    check (
      (processing_outcome = 'quarantined')
      = (
        bounded_reason is not null
        and bounded_reason <> 'stale_event'
      )
    ),
  constraint affiliate_didit_certification_events_verified
    check (
      not verified
      or (
        processing_outcome = 'applied'
        and provider_status = 'approved'
        and provider_environment = 'live'
        and id_check_approved
        and liveness_approved
        and face_match_approved
        and age_over_minimum
        and jurisdiction_result_present
      )
    )
);

create index affiliate_didit_certification_events_session_idx
  on affiliate_private.affiliate_didit_certification_events (
    certification_session_id,
    provider_event_created_at desc
  );

alter table affiliate_private.affiliate_didit_session_registry
  enable row level security;
alter table affiliate_private.affiliate_didit_certification_sessions
  enable row level security;
alter table affiliate_private.affiliate_didit_certification_events
  enable row level security;

revoke all on
  affiliate_private.affiliate_didit_session_registry,
  affiliate_private.affiliate_didit_certification_sessions,
  affiliate_private.affiliate_didit_certification_events
  from public, anon, authenticated, service_role;

create trigger affiliate_didit_session_registry_append_only
before update or delete
on affiliate_private.affiliate_didit_session_registry
for each row
execute function affiliate_private.reject_partners_append_only_mutation();

create trigger affiliate_didit_certification_events_append_only
before update or delete
on affiliate_private.affiliate_didit_certification_events
for each row
execute function affiliate_private.reject_partners_append_only_mutation();

create or replace function
affiliate_private.guard_didit_certification_session_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Didit certification sessions are retained'
      using errcode = '55000';
  end if;

  if new.id is distinct from old.id
    or new.certification_key_hash is distinct from old.certification_key_hash
    or new.operator_hash is distinct from old.operator_hash
    or new.idempotency_key_hash is distinct from old.idempotency_key_hash
    or new.request_hash is distinct from old.request_hash
    or new.confirmation_hash is distinct from old.confirmation_hash
    or new.justification_hash is distinct from old.justification_hash
    or new.consent_version is distinct from old.consent_version
    or new.capacity_attested is distinct from old.capacity_attested
    or new.created_at is distinct from old.created_at
  then
    raise exception 'Didit certification identity is immutable'
      using errcode = '55000';
  end if;

  if old.provider_session_hash is not null
    and (
      new.provider_session_hash is distinct from old.provider_session_hash
      or new.provider_workflow_hash
        is distinct from old.provider_workflow_hash
      or new.provider_workflow_version
        is distinct from old.provider_workflow_version
      or new.provider_environment
        is distinct from old.provider_environment
      or new.provider_config_fingerprint
        is distinct from old.provider_config_fingerprint
    )
  then
    raise exception 'Didit certification provider binding is immutable'
      using errcode = '55000';
  end if;

  if old.provider_create_dispatched_at is not null
    and new.provider_create_dispatched_at
      is distinct from old.provider_create_dispatched_at
  then
    raise exception 'Didit certification provider dispatch is immutable'
      using errcode = '55000';
  end if;
  if old.provider_create_dispatched_at is null
    and new.provider_create_dispatched_at is not null
    and (
      old.status <> 'reserved'
      or new.status <> 'reserved'
      or new.provider_session_hash is not null
    )
  then
    raise exception 'Didit certification provider dispatch is invalid'
      using errcode = '55000';
  end if;

  if new.expires_at > old.expires_at then
    raise exception 'Didit certification expiry cannot be extended'
      using errcode = '55000';
  end if;

  if not (
    (old.status = 'reserved'
      and new.status in ('reserved', 'pending', 'expired', 'quarantined'))
    or (old.status = 'pending'
      and new.status in (
        'pending', 'in_review', 'approved', 'declined', 'expired',
        'quarantined'
      ))
    or (old.status = 'in_review'
      and new.status in (
        'in_review', 'pending', 'approved', 'declined', 'expired',
        'quarantined'
      ))
    or (old.status in ('approved', 'declined', 'expired')
      and new.status in (old.status, 'quarantined'))
    or (old.status = 'quarantined' and new.status = 'quarantined')
  ) then
    raise exception 'invalid Didit certification transition'
      using errcode = '55000';
  end if;

  if old.verified and not new.verified and new.status <> 'quarantined' then
    raise exception 'Didit certification proof cannot be cleared'
      using errcode = '55000';
  end if;
  if old.quarantine_reason is not null
    and new.quarantine_reason is distinct from old.quarantine_reason
  then
    raise exception 'Didit certification quarantine is immutable'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger affiliate_didit_certification_sessions_validate
before update or delete
on affiliate_private.affiliate_didit_certification_sessions
for each row
execute function
  affiliate_private.guard_didit_certification_session_transition();

create or replace function
affiliate_private.partners_didit_certification_key_hash(
  p_certification_key text
)
returns text
language sql
immutable
strict
parallel safe
set search_path = ''
as $$
  select encode(
    extensions.digest(
      'norva:didit:certification-key:v1:' || p_certification_key,
      'sha256'
    ),
    'hex'
  );
$$;

-- The opaque browser key is derivable from immutable reservation identity,
-- so an authenticated operator can resume after a browser/process loss
-- without persisting the plaintext key. The helper is private and its EXECUTE
-- privilege is revoked below from every API role.
create or replace function
affiliate_private.partners_didit_certification_key(
  p_operator_hash text,
  p_session_id uuid
)
returns text
language sql
immutable
strict
parallel safe
set search_path = ''
as $$
  select 'kcf_' || left(
    encode(
      extensions.digest(
        concat_ws(
          chr(31),
          'norva:didit:certification-key-material:v2',
          p_operator_hash,
          p_session_id::text
        ),
        'sha256'
      ),
      'hex'
    ),
    24
  );
$$;

-- Internal observations are intentionally more precise than the browser
-- contract. This single closed mapper prevents storage-only reason codes from
-- leaking through a future response branch.
create or replace function
affiliate_private.partners_didit_certification_public_reason(
  p_internal_reason text
)
returns text
language sql
immutable
strict
parallel safe
set search_path = ''
as $$
  select case p_internal_reason
    when 'environment_mismatch' then 'provider_environment_mismatch'
    when 'config_fingerprint_mismatch' then 'provider_config_mismatch'
    when 'workflow_mismatch' then 'provider_workflow_mismatch'
    when 'workflow_version_mismatch' then 'provider_workflow_mismatch'
    when 'approved_checks_incomplete' then 'approved_checks_incomplete'
    when 'event_before_session' then 'stale_event'
    when 'stale_event' then 'stale_event'
    else 'binding_conflict'
  end;
$$;

create or replace function
affiliate_private.partners_didit_certification_operator_hash()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select encode(
    extensions.digest(
      'norva:didit:certification-operator:v1:' || auth.uid()::text,
      'sha256'
    ),
    'hex'
  );
$$;

-- Read-only observation remains available to the originating live Risk
-- operator after the one-shot kill switch is closed or the release gates move.
-- It still requires the live Auth row and delegated Risk capability, but does
-- not require AAL2 or a fresh token because the closed response contains only
-- the caller's bounded status, booleans, environment and timestamps.
create or replace function
affiliate_private.partners_require_didit_certification_observer(
  p_operation text
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null
    or auth.jwt() ->> 'sub' is distinct from auth.uid()::text
    or not affiliate_private.partners_has_capability('risk')
  then
    raise exception 'Partners Risk capability is required'
      using errcode = '42501';
  end if;

  return affiliate_private.partners_didit_certification_operator_hash();
end;
$$;

-- The mutable pre-gate state is deliberately factored out so the service-role
-- session recorder can recheck it after the remote Didit call. A flag or gate
-- transition during that network window therefore leaves only an unbound,
-- expiring reservation and can never produce an authoritative proof.
create or replace function
affiliate_private.partners_assert_didit_certification_pre_gate()
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_disabled_flag_count integer := 0;
begin
  perform 1
  from affiliate_private.affiliate_release_gates gate
  where gate.gate_key in (
    'privacy_approved',
    'individual_verification_coverage_confirmed'
  )
  for share;
  perform 1
  from public.admin_feature_flags flag
  where flag.key in (
    'partners_enabled',
    'partners_payouts_live',
    'partners_tv_relay_enabled',
    'partners_revolut_api_enabled'
  )
  for share;

  if not exists (
    select 1
    from affiliate_private.affiliate_release_gates gate
    where gate.gate_key = 'privacy_approved'
      and gate.satisfied
  ) then
    raise exception 'Privacy approval is required for Didit certification'
      using errcode = 'P0001';
  end if;
  if not exists (
    select 1
    from affiliate_private.affiliate_release_gates gate
    where gate.gate_key = 'individual_verification_coverage_confirmed'
      and not gate.satisfied
  ) then
    raise exception 'Didit certification is available only before coverage approval'
      using errcode = 'P0001';
  end if;

  select count(*)
  into v_disabled_flag_count
  from public.admin_feature_flags flag
  where flag.key in (
      'partners_enabled',
      'partners_payouts_live',
      'partners_tv_relay_enabled',
      'partners_revolut_api_enabled'
    )
    and not flag.enabled;
  if v_disabled_flag_count <> 4 then
    raise exception 'Didit certification requires all live Partners paths disabled'
      using errcode = 'P0001';
  end if;
end;
$$;

-- Every browser-facing preparation rechecks the live Admin row, delegated
-- Risk capability, AAL2 factor, JWT subject/freshness and the exact pre-gate
-- state. A stale token cannot keep this exceptional write path open for more
-- than ten minutes.
create or replace function
affiliate_private.partners_require_didit_certification_operator(
  p_operation text
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_iat_text text := coalesce(auth.jwt() ->> 'iat', '');
  v_issued_at timestamptz;
  v_operator_hash text;
begin
  v_operator_hash :=
    affiliate_private.partners_require_didit_certification_observer(
      p_operation
    );
  perform affiliate_private.partners_require_aal2(p_operation);

  if v_iat_text !~ '^[0-9]{10}(?:\.[0-9]{1,6})?$' then
    raise exception 'freshly issued JWT is required'
      using errcode = '42501';
  end if;
  begin
    v_issued_at := to_timestamp(v_iat_text::double precision);
  exception when others then
    raise exception 'freshly issued JWT is required'
      using errcode = '42501';
  end;
  if v_issued_at < now() - interval '10 minutes'
    or v_issued_at > now() + interval '1 minute'
  then
    raise exception 'freshly issued JWT is required'
      using errcode = '42501';
  end if;

  perform affiliate_private.partners_assert_didit_certification_pre_gate();
  return v_operator_hash;
end;
$$;

create or replace function
affiliate_private.admin_partners_kyc_certification_prepare(
  p_idempotency_key text,
  p_consent_version text,
  p_capacity_attested boolean,
  p_language text,
  p_confirmation text,
  p_justification text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_operator_hash text;
  v_idempotency_key text := btrim(coalesce(p_idempotency_key, ''));
  v_language text := lower(btrim(coalesce(p_language, '')));
  v_justification text := btrim(coalesce(p_justification, ''));
  v_idempotency_hash text;
  v_request_hash text;
  v_certification_key text;
  v_certification_key_hash text;
  v_session_id uuid;
  v_existing
    affiliate_private.affiliate_didit_certification_sessions%rowtype;
  v_session
    affiliate_private.affiliate_didit_certification_sessions%rowtype;
begin
  v_operator_hash :=
    affiliate_private.partners_require_didit_certification_operator(
      'Didit certification preparation'
    );

  if v_idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$' then
    raise exception 'invalid idempotency key' using errcode = '22023';
  end if;
  if p_consent_version is distinct from
      'partners-didit-certification-v1'
    or p_capacity_attested is distinct from true
    or p_confirmation is distinct from 'CERTIFIER DIDIT'
    or v_language !~ '^[a-z]{2}$'
    or length(v_justification) not between 12 and 1000
    or v_justification ~ '[[:cntrl:]]'
  then
    raise exception 'invalid Didit certification consent'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:didit:certification-operator:v1:' || v_operator_hash,
      0
    )
  );

  v_idempotency_hash := encode(
    extensions.digest(
      concat_ws(
        chr(31),
        'norva:didit:certification-idempotency:v1',
        v_operator_hash,
        v_idempotency_key
      ),
      'sha256'
    ),
    'hex'
  );
  v_request_hash := encode(
    extensions.digest(
      concat_ws(
        chr(31),
        'norva:didit:certification-prepare:v1',
        v_operator_hash,
        p_consent_version,
        p_capacity_attested::text,
        v_language,
        p_confirmation,
        v_justification
      ),
      'sha256'
    ),
    'hex'
  );
  select session.*
  into v_existing
  from affiliate_private.affiliate_didit_certification_sessions session
  where session.operator_hash = v_operator_hash
    and session.idempotency_key_hash = v_idempotency_hash
  for update;
  if found then
    if v_existing.request_hash <> v_request_hash then
      raise exception 'idempotency key was reused with a different request'
        using errcode = 'P0003';
    end if;
    v_certification_key :=
      affiliate_private.partners_didit_certification_key(
        v_existing.operator_hash,
        v_existing.id
      );
    v_certification_key_hash :=
      affiliate_private.partners_didit_certification_key_hash(
        v_certification_key
      );
    if v_existing.certification_key_hash <> v_certification_key_hash then
      raise exception 'Didit certification reservation identity is invalid'
        using errcode = 'P0006';
    end if;
    if v_existing.status not in ('reserved', 'pending')
      or v_existing.expires_at <= now()
    then
      raise exception 'Didit certification replay is unavailable'
        using errcode = 'P0004';
    end if;
    return jsonb_build_object(
      'schema_version', 1,
      'action', 'kyc_certification_reserved',
      'replayed', true,
      'certification', jsonb_build_object(
        'key', v_certification_key,
        'status', v_existing.status,
        'expires_at', v_existing.expires_at
      )
    );
  end if;

  update affiliate_private.affiliate_didit_certification_sessions session
  set
    status = 'expired',
    updated_at = now()
  where session.operator_hash = v_operator_hash
    and session.status in ('reserved', 'pending', 'in_review')
    and session.expires_at <= now();

  if exists (
    select 1
    from affiliate_private.affiliate_didit_certification_sessions session
    where session.operator_hash = v_operator_hash
      and session.status in ('reserved', 'pending', 'in_review')
      and session.expires_at > now()
  ) then
    raise exception 'a Didit certification is already active'
      using errcode = 'P0004';
  end if;

  v_session_id := gen_random_uuid();
  v_certification_key :=
    affiliate_private.partners_didit_certification_key(
      v_operator_hash,
      v_session_id
    );
  v_certification_key_hash :=
    affiliate_private.partners_didit_certification_key_hash(
      v_certification_key
    );

  insert into affiliate_private.affiliate_didit_certification_sessions (
    id,
    certification_key_hash,
    operator_hash,
    idempotency_key_hash,
    request_hash,
    confirmation_hash,
    justification_hash,
    consent_version,
    capacity_attested,
    expires_at
  )
  values (
    v_session_id,
    v_certification_key_hash,
    v_operator_hash,
    v_idempotency_hash,
    v_request_hash,
    encode(
      extensions.digest(
        'norva:didit:certification-confirmation:v1:' || p_confirmation,
        'sha256'
      ),
      'hex'
    ),
    encode(
      extensions.digest(
        'norva:didit:certification-justification:v1:' || v_justification,
        'sha256'
      ),
      'hex'
    ),
    p_consent_version,
    true,
    now() + interval '2 hours'
  )
  returning * into v_session;

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'kyc_certification_reserved',
    'replayed', false,
    'certification', jsonb_build_object(
      'key', v_certification_key,
      'status', v_session.status,
      'expires_at', v_session.expires_at
    )
  );
end;
$$;

create or replace function
affiliate_private.admin_partners_kyc_certification_resume()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_operator_hash text;
  v_certification_key text;
  v_session
    affiliate_private.affiliate_didit_certification_sessions%rowtype;
begin
  v_operator_hash :=
    affiliate_private.partners_require_didit_certification_operator(
      'Didit certification resume'
    );

  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:didit:certification-operator:v1:' || v_operator_hash,
      0
    )
  );

  update affiliate_private.affiliate_didit_certification_sessions session
  set
    status = 'expired',
    updated_at = now()
  where session.operator_hash = v_operator_hash
    and session.status in ('reserved', 'pending', 'in_review')
    and session.expires_at <= now();

  select session.*
  into v_session
  from affiliate_private.affiliate_didit_certification_sessions session
  where session.operator_hash = v_operator_hash
    and session.status in ('reserved', 'pending')
    and session.expires_at > now()
  order by session.created_at desc, session.id desc
  limit 1
  for update;

  if not found then
    raise exception 'Didit certification is not resumable'
      using errcode = 'P0004';
  end if;

  v_certification_key :=
    affiliate_private.partners_didit_certification_key(
      v_session.operator_hash,
      v_session.id
    );
  if v_session.certification_key_hash <>
      affiliate_private.partners_didit_certification_key_hash(
        v_certification_key
      )
  then
    raise exception 'Didit certification reservation identity is invalid'
      using errcode = 'P0006';
  end if;

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'kyc_certification_reserved',
    'replayed', true,
    'certification', jsonb_build_object(
      'key', v_certification_key,
      'status', v_session.status,
      'expires_at', v_session.expires_at
    )
  );
end;
$$;

create or replace function
affiliate_private.admin_partners_kyc_certification_status()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_operator_hash text;
  v_session
    affiliate_private.affiliate_didit_certification_sessions%rowtype;
begin
  v_operator_hash :=
    affiliate_private.partners_require_didit_certification_observer(
      'Didit certification status'
    );

  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:didit:certification-operator:v1:' || v_operator_hash,
      0
    )
  );
  update affiliate_private.affiliate_didit_certification_sessions session
  set
    status = 'expired',
    updated_at = now()
  where session.operator_hash = v_operator_hash
    and session.status in ('reserved', 'pending', 'in_review')
    and session.expires_at <= now();

  select session.*
  into v_session
  from affiliate_private.affiliate_didit_certification_sessions session
  where session.operator_hash = v_operator_hash
  order by session.created_at desc, session.id desc
  limit 1;

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'kyc_certification_status',
    'certification', case
      when v_session.id is null then null
      else jsonb_build_object(
        'status', v_session.status,
        'environment', v_session.provider_environment,
        'expires_at', v_session.expires_at,
        'observed_at', v_session.updated_at,
        'verified', v_session.verified,
        'reason', case
          when v_session.status = 'quarantined' then
            affiliate_private.partners_didit_certification_public_reason(
              v_session.quarantine_reason
            )
          else null
        end
      )
    end
  );
end;
$$;

-- The provider create dispatch is a durable, one-way claim. A multi-replica
-- race may observe the same empty Didit list, but exactly one transaction can
-- move the timestamp from NULL. Later retries can inspect the timestamp yet
-- can never clear, replace or extend it.
create or replace function
affiliate_private.partners_service_kyc_certification_create_claim(
  p_certification_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_certification_key text := lower(
    btrim(coalesce(p_certification_key, ''))
  );
  v_certification_key_hash text;
  v_claimed boolean := false;
  v_session
    affiliate_private.affiliate_didit_certification_sessions%rowtype;
begin
  if v_certification_key !~ '^kcf_[0-9a-f]{24}$' then
    raise exception 'invalid Didit certification create claim'
      using errcode = '22023';
  end if;

  -- This runs after the authoritative provider list read. Closing a flag or
  -- gate during that network window prevents the irreversible dispatch claim.
  perform affiliate_private.partners_assert_didit_certification_pre_gate();

  v_certification_key_hash :=
    affiliate_private.partners_didit_certification_key_hash(
      v_certification_key
    );
  select session.*
  into v_session
  from affiliate_private.affiliate_didit_certification_sessions session
  where session.certification_key_hash = v_certification_key_hash
  for update;
  if not found
    or v_session.status <> 'reserved'
    or v_session.expires_at <= now()
  then
    raise exception 'Didit certification create claim is unavailable'
      using errcode = 'P0004';
  end if;

  if v_session.provider_create_dispatched_at is null then
    update affiliate_private.affiliate_didit_certification_sessions
    set
      provider_create_dispatched_at = now(),
      updated_at = now()
    where id = v_session.id
      and provider_create_dispatched_at is null
    returning * into v_session;
    v_claimed := found;
  end if;
  if v_session.provider_create_dispatched_at is null then
    raise exception 'Didit certification create claim was not persisted'
      using errcode = 'P0006';
  end if;

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'kyc_certification_create_claimed',
    'claimed', v_claimed,
    'certification', jsonb_build_object(
      'status', 'reserved',
      'expires_at', v_session.expires_at,
      'provider_create_dispatched_at',
        v_session.provider_create_dispatched_at
    )
  );
end;
$$;

-- A pending browser recovery first resolves the exact vendor_data through the
-- Didit list API. This service-only probe proves that the returned raw session
-- id hashes to the already-bound local row. It never returns the provider id,
-- URL, workflow metadata or a boolean oracle for arbitrary sessions.
create or replace function
affiliate_private.partners_service_kyc_certification_binding_match(
  p_certification_key text,
  p_provider_session_id text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_certification_key text := lower(
    btrim(coalesce(p_certification_key, ''))
  );
  v_certification_key_hash text;
  v_session_hash text;
  v_session
    affiliate_private.affiliate_didit_certification_sessions%rowtype;
begin
  if v_certification_key !~ '^kcf_[0-9a-f]{24}$'
    or p_provider_session_id is null
    or length(p_provider_session_id) not between 8 and 255
    or p_provider_session_id ~ '[[:space:][:cntrl:]]'
  then
    raise exception 'invalid Didit certification binding candidate'
      using errcode = '22023';
  end if;

  -- Recheck the kill switches after the provider lookup, not only before it.
  perform affiliate_private.partners_assert_didit_certification_pre_gate();

  v_certification_key_hash :=
    affiliate_private.partners_didit_certification_key_hash(
      v_certification_key
    );
  v_session_hash := encode(
    extensions.digest(
      'norva:didit:session:v1:' || p_provider_session_id,
      'sha256'
    ),
    'hex'
  );

  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:didit:certification-session:v1:' || v_session_hash,
      0
    )
  );
  select session.*
  into v_session
  from affiliate_private.affiliate_didit_certification_sessions session
  where session.certification_key_hash = v_certification_key_hash
  for update;
  if not found
    or v_session.status <> 'pending'
    or v_session.expires_at <= now()
  then
    raise exception 'Didit certification binding is not recoverable'
      using errcode = 'P0004';
  end if;
  if v_session.provider_session_hash is null
    or v_session.provider_session_hash <> v_session_hash
  then
    raise exception 'Didit certification binding candidate does not match'
      using errcode = 'P0006';
  end if;

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'kyc_certification_binding_matched',
    'matched', true,
    'certification', jsonb_build_object(
      'status', 'pending',
      'expires_at', v_session.expires_at
    )
  );
end;
$$;

create or replace function
affiliate_private.partners_service_kyc_certification_session_record(
  p_certification_key text,
  p_provider_session_id text,
  p_provider_workflow_id text,
  p_provider_workflow_version integer,
  p_provider_status text,
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
  v_certification_key text := lower(
    btrim(coalesce(p_certification_key, ''))
  );
  v_provider_status text := lower(
    replace(btrim(coalesce(p_provider_status, '')), ' ', '_')
  );
  v_environment text := lower(
    btrim(coalesce(p_provider_environment, ''))
  );
  v_fingerprint text := lower(
    btrim(coalesce(p_provider_config_fingerprint, ''))
  );
  v_certification_key_hash text;
  v_session_hash text;
  v_workflow_hash text;
  v_session
    affiliate_private.affiliate_didit_certification_sessions%rowtype;
  v_expires_at timestamptz;
begin
  if v_certification_key !~ '^kcf_[0-9a-f]{24}$'
    or p_provider_session_id is null
    or length(p_provider_session_id) not between 8 and 255
    or p_provider_session_id ~ '[[:space:][:cntrl:]]'
    or p_provider_workflow_id is null
    or length(p_provider_workflow_id) not between 3 and 255
    or p_provider_workflow_id ~ '[[:space:][:cntrl:]]'
    or p_provider_workflow_version is distinct from 1
    or v_provider_status not in (
      'not_started', 'in_progress', 'awaiting_user', 'in_review'
    )
    or v_environment not in ('sandbox', 'live')
    or v_fingerprint !~ '^[0-9a-f]{64}$'
    or p_provider_session_ttl_seconds is null
    or p_provider_session_ttl_seconds not between 3600 and 2419200
  then
    raise exception 'invalid Didit certification session response'
      using errcode = '22023';
  end if;

  perform affiliate_private.partners_assert_didit_certification_pre_gate();

  v_certification_key_hash :=
    affiliate_private.partners_didit_certification_key_hash(
      v_certification_key
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
    hashtextextended(
      'norva:didit:certification-session:v1:' || v_session_hash,
      0
    )
  );
  select session.*
  into v_session
  from affiliate_private.affiliate_didit_certification_sessions session
  where session.certification_key_hash = v_certification_key_hash
  for update;
  if not found then
    raise exception 'Didit certification reservation is unavailable'
      using errcode = 'P0006';
  end if;

  if v_session.expires_at <= now()
    and v_session.status in ('reserved', 'pending', 'in_review')
  then
    raise exception 'Didit certification reservation has expired'
      using errcode = 'P0004';
  end if;
  if v_session.provider_create_dispatched_at is null then
    raise exception 'Didit certification create dispatch was not claimed'
      using errcode = 'P0004';
  end if;

  if v_session.provider_session_hash is not null then
    if v_session.provider_session_hash = v_session_hash
      and v_session.provider_workflow_hash = v_workflow_hash
      and v_session.provider_workflow_version
        = p_provider_workflow_version
      and v_session.provider_environment = v_environment
      and v_session.provider_config_fingerprint = v_fingerprint
    then
      return jsonb_build_object(
        'schema_version', 1,
        'action', 'kyc_certification_session_recorded',
        'replayed', true,
        'certification', jsonb_build_object(
          'status', case
            when v_provider_status = 'in_review' then 'in_review'
            else 'pending'
          end,
          'expires_at', v_session.expires_at
        )
      );
    end if;

    update affiliate_private.affiliate_didit_certification_sessions
    set
      status = 'quarantined',
      verified = false,
      quarantine_reason = 'session_binding_conflict',
      quarantined_at = now(),
      updated_at = now()
    where id = v_session.id
    returning * into v_session;
    return jsonb_build_object(
      'schema_version', 1,
      'action', 'kyc_certification_session_recorded',
      'replayed', false,
      'certification', jsonb_build_object(
        'status', v_session.status,
        'expires_at', v_session.expires_at
      )
    );
  end if;

  if v_session.status <> 'reserved' then
    raise exception 'Didit certification reservation is unavailable'
      using errcode = 'P0004';
  end if;

  perform 1
  from affiliate_private.affiliate_didit_session_registry registry
  where registry.provider_session_hash = v_session_hash;
  if found then
    update affiliate_private.affiliate_didit_certification_sessions
    set
      status = 'quarantined',
      verified = false,
      quarantine_reason = 'cross_purpose_session_conflict',
      quarantined_at = now(),
      updated_at = now()
    where id = v_session.id
    returning * into v_session;
    return jsonb_build_object(
      'schema_version', 1,
      'action', 'kyc_certification_session_recorded',
      'replayed', false,
      'certification', jsonb_build_object(
        'status', v_session.status,
        'expires_at', v_session.expires_at
      )
    );
  end if;

  begin
    insert into affiliate_private.affiliate_didit_session_registry (
      provider_session_hash,
      session_purpose,
      source_record_id
    )
    values (
      v_session_hash,
      'certification',
      v_session.id
    );
  exception when unique_violation then
    update affiliate_private.affiliate_didit_certification_sessions
    set
      status = 'quarantined',
      verified = false,
      quarantine_reason = 'cross_purpose_session_conflict',
      quarantined_at = now(),
      updated_at = now()
    where id = v_session.id
    returning * into v_session;
    return jsonb_build_object(
      'schema_version', 1,
      'action', 'kyc_certification_session_recorded',
      'replayed', false,
      'certification', jsonb_build_object(
        'status', v_session.status,
        'expires_at', v_session.expires_at
      )
    );
  end;

  v_expires_at := least(
    v_session.expires_at,
    now() + make_interval(secs => p_provider_session_ttl_seconds)
  );
  update affiliate_private.affiliate_didit_certification_sessions
  set
    provider_session_hash = v_session_hash,
    provider_workflow_hash = v_workflow_hash,
    provider_workflow_version = p_provider_workflow_version,
    provider_environment = v_environment,
    provider_config_fingerprint = v_fingerprint,
    provider_status = v_provider_status,
    status = case
      when v_provider_status = 'in_review' then 'in_review'
      else 'pending'
    end,
    expires_at = v_expires_at,
    updated_at = now()
  where id = v_session.id
  returning * into v_session;

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'kyc_certification_session_recorded',
    'replayed', false,
    'certification', jsonb_build_object(
      'status', v_session.status,
      'expires_at', v_session.expires_at
    )
  );
end;
$$;

create or replace function
affiliate_private.partners_service_kyc_certification_webhook_apply(
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
  v_environment text := lower(
    btrim(coalesce(p_provider_environment, ''))
  );
  v_fingerprint text := lower(
    btrim(coalesce(p_provider_config_fingerprint, ''))
  );
  v_payload_hash text := lower(btrim(coalesce(p_payload_hash, '')));
  v_iso3 text := nullif(
    upper(btrim(coalesce(p_document_country_iso3, ''))),
    ''
  );
  v_event_hash text;
  v_session_hash text;
  v_workflow_hash text;
  v_age_over_minimum boolean := coalesce(p_document_age >= 18, false);
  v_jurisdiction_present boolean := v_iso3 is not null;
  v_verified boolean := false;
  v_target_status text;
  v_reason text;
  v_outcome text;
  v_registry
    affiliate_private.affiliate_didit_session_registry%rowtype;
  v_session
    affiliate_private.affiliate_didit_certification_sessions%rowtype;
  v_existing_event
    affiliate_private.affiliate_didit_certification_events%rowtype;
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
    or p_provider_workflow_version not between 1 and 2147483647
    or not affiliate_private.partners_valid_didit_status(v_provider_status)
    or p_event_created_at is null
    or p_event_created_at > now() + interval '5 minutes'
    or (
      p_document_age is not null
      and p_document_age not between 0 and 150
    )
    or (v_iso3 is not null and v_iso3 !~ '^[A-Z]{3}$')
    or v_payload_hash !~ '^[0-9a-f]{64}$'
    or v_environment not in ('sandbox', 'live')
    or v_fingerprint !~ '^[0-9a-f]{64}$'
  then
    raise exception 'invalid Didit certification webhook envelope'
      using errcode = '22023';
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
    hashtextextended(
      'norva:didit:certification-session:v1:' || v_session_hash,
      0
    )
  );
  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:didit:certification-event:v1:' || v_event_hash,
      0
    )
  );

  select registry.*
  into v_registry
  from affiliate_private.affiliate_didit_session_registry registry
  where registry.provider_session_hash = v_session_hash;
  if not found or v_registry.session_purpose <> 'certification' then
    raise exception 'Didit certification session is unknown'
      using errcode = 'P0006';
  end if;

  select session.*
  into v_session
  from affiliate_private.affiliate_didit_certification_sessions session
  where session.id = v_registry.source_record_id
    and session.provider_session_hash = v_session_hash
  for update;
  if not found then
    raise exception 'Didit certification session is unknown'
      using errcode = 'P0006';
  end if;

  select event.*
  into v_existing_event
  from affiliate_private.affiliate_didit_certification_events event
  where event.provider_event_hash = v_event_hash;
  if found then
    if v_existing_event.certification_session_id = v_session.id
      and v_existing_event.provider_session_hash = v_session_hash
      and v_existing_event.provider_workflow_hash = v_workflow_hash
      and v_existing_event.provider_workflow_version
        = p_provider_workflow_version
      and v_existing_event.provider_environment = v_environment
      and v_existing_event.provider_config_fingerprint = v_fingerprint
      and v_existing_event.payload_hash = v_payload_hash
      and v_existing_event.provider_status = v_provider_status
      and v_existing_event.provider_event_created_at = p_event_created_at
      and v_existing_event.id_check_approved
        is not distinct from p_id_check_approved
      and v_existing_event.liveness_approved
        is not distinct from p_liveness_approved
      and v_existing_event.face_match_approved
        is not distinct from p_face_match_approved
      and v_existing_event.age_over_minimum = v_age_over_minimum
      and v_existing_event.jurisdiction_result_present
        = v_jurisdiction_present
    then
      return jsonb_build_object(
        'schema_version', 1,
        'action', case
          when v_existing_event.processing_outcome = 'quarantined'
            or v_session.status = 'quarantined'
            then 'kyc_certification_result_quarantined'
          else 'kyc_certification_result_applied'
        end,
        'replayed', true,
        'certification', case
          when v_existing_event.processing_outcome = 'quarantined'
            or v_session.status = 'quarantined' then
            jsonb_build_object(
              'status', v_session.status,
              'verified', v_session.verified,
              'reason',
                affiliate_private.partners_didit_certification_public_reason(
                  coalesce(
                    v_session.quarantine_reason,
                    v_existing_event.bounded_reason
                  )
                )
            )
          else jsonb_build_object(
            'status', v_session.status,
            'verified', v_session.verified
          )
        end
      );
    end if;

    if v_session.status <> 'quarantined' then
      update affiliate_private.affiliate_didit_certification_sessions
      set
        status = 'quarantined',
        verified = false,
        quarantine_reason = 'event_replay_conflict',
        quarantined_at = now(),
        updated_at = now()
      where id = v_session.id
      returning * into v_session;
    end if;
    return jsonb_build_object(
      'schema_version', 1,
      'action', 'kyc_certification_result_quarantined',
      'replayed', true,
      'certification', jsonb_build_object(
        'status', v_session.status,
        'verified', false,
        'reason', 'binding_conflict'
      )
    );
  end if;

  -- The local two-hour reservation is authoritative even when Didit's hosted
  -- session is configured with a longer provider TTL. A late delivery is kept
  -- as a bounded observation but can never approve the certification.
  if (
      v_session.expires_at <= now()
      or p_event_created_at > v_session.expires_at
    )
    and v_session.status in ('reserved', 'pending', 'in_review')
  then
    insert into affiliate_private.affiliate_didit_certification_events (
      certification_session_id,
      provider_event_hash,
      provider_session_hash,
      provider_workflow_hash,
      provider_workflow_version,
      provider_environment,
      provider_config_fingerprint,
      payload_hash,
      provider_status,
      processing_outcome,
      bounded_reason,
      id_check_approved,
      liveness_approved,
      face_match_approved,
      age_over_minimum,
      jurisdiction_result_present,
      verified,
      provider_event_created_at
    )
    values (
      v_session.id,
      v_event_hash,
      v_session_hash,
      v_workflow_hash,
      p_provider_workflow_version,
      v_environment,
      v_fingerprint,
      v_payload_hash,
      v_provider_status,
      'ignored',
      'stale_event',
      p_id_check_approved,
      p_liveness_approved,
      p_face_match_approved,
      v_age_over_minimum,
      v_jurisdiction_present,
      false,
      p_event_created_at
    );
    update affiliate_private.affiliate_didit_certification_sessions
    set
      status = 'expired',
      verified = false,
      last_event_created_at = greatest(created_at, p_event_created_at),
      updated_at = now()
    where id = v_session.id
    returning * into v_session;
    return jsonb_build_object(
      'schema_version', 1,
      'action', 'kyc_certification_result_applied',
      'replayed', false,
      'certification', jsonb_build_object(
        'status', v_session.status,
        'verified', false
      )
    );
  end if;

  v_reason := case
    when v_session.provider_workflow_hash <> v_workflow_hash
      then 'workflow_mismatch'
    when v_session.provider_workflow_version
        <> p_provider_workflow_version
      then 'workflow_version_mismatch'
    when v_session.provider_environment <> v_environment
      then 'environment_mismatch'
    when v_session.provider_config_fingerprint <> v_fingerprint
      then 'config_fingerprint_mismatch'
    when p_event_created_at < v_session.created_at - interval '5 minutes'
      then 'event_before_session'
    when v_provider_status = 'approved'
      and not (
        p_id_check_approved is true
        and p_liveness_approved is true
        and p_face_match_approved is true
        and v_age_over_minimum
        and v_jurisdiction_present
      )
      then 'approved_checks_incomplete'
    else null
  end;

  if v_reason is not null then
    insert into affiliate_private.affiliate_didit_certification_events (
      certification_session_id,
      provider_event_hash,
      provider_session_hash,
      provider_workflow_hash,
      provider_workflow_version,
      provider_environment,
      provider_config_fingerprint,
      payload_hash,
      provider_status,
      processing_outcome,
      bounded_reason,
      id_check_approved,
      liveness_approved,
      face_match_approved,
      age_over_minimum,
      jurisdiction_result_present,
      verified,
      provider_event_created_at
    )
    values (
      v_session.id,
      v_event_hash,
      v_session_hash,
      v_workflow_hash,
      p_provider_workflow_version,
      v_environment,
      v_fingerprint,
      v_payload_hash,
      v_provider_status,
      'quarantined',
      v_reason,
      p_id_check_approved,
      p_liveness_approved,
      p_face_match_approved,
      v_age_over_minimum,
      v_jurisdiction_present,
      false,
      p_event_created_at
    );

    if v_session.status <> 'quarantined' then
      update affiliate_private.affiliate_didit_certification_sessions
      set
        status = 'quarantined',
        verified = false,
        quarantine_reason = v_reason,
        quarantined_at = now(),
        last_event_created_at = greatest(
          coalesce(last_event_created_at, created_at),
          p_event_created_at
        ),
        updated_at = now()
      where id = v_session.id
      returning * into v_session;
    end if;

    return jsonb_build_object(
      'schema_version', 1,
      'action', 'kyc_certification_result_quarantined',
      'replayed', false,
      'certification', jsonb_build_object(
        'status', v_session.status,
        'verified', false,
        'reason',
          affiliate_private.partners_didit_certification_public_reason(
            v_reason
          )
      )
    );
  end if;

  if v_session.last_event_created_at is not null
      and p_event_created_at < v_session.last_event_created_at
    or v_session.status in ('approved', 'declined', 'expired', 'quarantined')
  then
    insert into affiliate_private.affiliate_didit_certification_events (
      certification_session_id,
      provider_event_hash,
      provider_session_hash,
      provider_workflow_hash,
      provider_workflow_version,
      provider_environment,
      provider_config_fingerprint,
      payload_hash,
      provider_status,
      processing_outcome,
      bounded_reason,
      id_check_approved,
      liveness_approved,
      face_match_approved,
      age_over_minimum,
      jurisdiction_result_present,
      verified,
      provider_event_created_at
    )
    values (
      v_session.id,
      v_event_hash,
      v_session_hash,
      v_workflow_hash,
      p_provider_workflow_version,
      v_environment,
      v_fingerprint,
      v_payload_hash,
      v_provider_status,
      'ignored',
      'stale_event',
      p_id_check_approved,
      p_liveness_approved,
      p_face_match_approved,
      v_age_over_minimum,
      v_jurisdiction_present,
      false,
      p_event_created_at
    );
    return jsonb_build_object(
      'schema_version', 1,
      'action', case
        when v_session.status = 'quarantined'
          then 'kyc_certification_result_quarantined'
        else 'kyc_certification_result_applied'
      end,
      'replayed', false,
      'certification', case
        when v_session.status = 'quarantined' then jsonb_build_object(
          'status', v_session.status,
          'verified', false,
          'reason',
            affiliate_private.partners_didit_certification_public_reason(
              v_session.quarantine_reason
            )
        )
        else jsonb_build_object(
          'status', v_session.status,
          'verified', v_session.verified
        )
      end
    );
  end if;

  v_target_status := case
    when v_provider_status in (
      'not_started', 'in_progress', 'awaiting_user', 'resubmitted'
    ) then 'pending'
    when v_provider_status = 'in_review' then 'in_review'
    when v_provider_status = 'approved' then 'approved'
    when v_provider_status in ('declined', 'abandoned') then 'declined'
    when v_provider_status in ('expired', 'kyc_expired') then 'expired'
    else 'pending'
  end;
  v_verified :=
    v_target_status = 'approved'
    and v_environment = 'live'
    and p_id_check_approved is true
    and p_liveness_approved is true
    and p_face_match_approved is true
    and v_age_over_minimum
    and v_jurisdiction_present;
  v_outcome := 'applied';

  insert into affiliate_private.affiliate_didit_certification_events (
    certification_session_id,
    provider_event_hash,
    provider_session_hash,
    provider_workflow_hash,
    provider_workflow_version,
    provider_environment,
    provider_config_fingerprint,
    payload_hash,
    provider_status,
    processing_outcome,
    id_check_approved,
    liveness_approved,
    face_match_approved,
    age_over_minimum,
    jurisdiction_result_present,
    verified,
    provider_event_created_at
  )
  values (
    v_session.id,
    v_event_hash,
    v_session_hash,
    v_workflow_hash,
    p_provider_workflow_version,
    v_environment,
    v_fingerprint,
    v_payload_hash,
    v_provider_status,
    v_outcome,
    p_id_check_approved,
    p_liveness_approved,
    p_face_match_approved,
    v_age_over_minimum,
    v_jurisdiction_present,
    v_verified,
    p_event_created_at
  );

  update affiliate_private.affiliate_didit_certification_sessions
  set
    provider_status = v_provider_status,
    status = v_target_status,
    id_check_approved = p_id_check_approved,
    liveness_approved = p_liveness_approved,
    face_match_approved = p_face_match_approved,
    age_over_minimum = v_age_over_minimum,
    jurisdiction_result_present = v_jurisdiction_present,
    verified = v_verified,
    verified_at = case
      when v_verified then greatest(p_event_created_at, created_at)
      else verified_at
    end,
    last_event_created_at = p_event_created_at,
    updated_at = now()
  where id = v_session.id
  returning * into v_session;

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'kyc_certification_result_applied',
    'replayed', false,
    'certification', jsonb_build_object(
      'status', v_session.status,
      'verified', v_session.verified
    )
  );
end;
$$;

-- Browser shims deliberately expose no subject UUID. The authenticated
-- principal can prepare and inspect only the certification derived from its
-- own auth.uid().
create or replace function public.admin_partners_kyc_certification_prepare(
  p_idempotency_key text,
  p_consent_version text,
  p_capacity_attested boolean,
  p_language text,
  p_confirmation text,
  p_justification text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.admin_partners_kyc_certification_prepare(
    p_idempotency_key,
    p_consent_version,
    p_capacity_attested,
    p_language,
    p_confirmation,
    p_justification
  );
$$;

create or replace function public.admin_partners_kyc_certification_resume()
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.admin_partners_kyc_certification_resume();
$$;

create or replace function public.admin_partners_kyc_certification_status()
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.admin_partners_kyc_certification_status();
$$;

-- Service shims are callable only by the Edge service role. Raw Didit
-- identifiers are normalized and hashed inside the private implementation.
create or replace function
public.partners_service_kyc_certification_create_claim(
  p_certification_key text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select
    affiliate_private.partners_service_kyc_certification_create_claim(
      p_certification_key
    );
$$;

create or replace function
public.partners_service_kyc_certification_binding_match(
  p_certification_key text,
  p_provider_session_id text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select
    affiliate_private.partners_service_kyc_certification_binding_match(
      p_certification_key,
      p_provider_session_id
    );
$$;

create or replace function
public.partners_service_kyc_certification_session_record(
  p_certification_key text,
  p_provider_session_id text,
  p_provider_workflow_id text,
  p_provider_workflow_version integer,
  p_provider_status text,
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
  select
    affiliate_private.partners_service_kyc_certification_session_record(
      p_certification_key,
      p_provider_session_id,
      p_provider_workflow_id,
      p_provider_workflow_version,
      p_provider_status,
      p_provider_environment,
      p_provider_config_fingerprint,
      p_provider_session_ttl_seconds
    );
$$;

create or replace function
public.partners_service_kyc_certification_webhook_apply(
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
  select
    affiliate_private.partners_service_kyc_certification_webhook_apply(
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

revoke all on function
  affiliate_private.register_member_didit_session()
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.guard_didit_certification_session_transition()
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.partners_didit_certification_key_hash(text)
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.partners_didit_certification_key(text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.partners_didit_certification_public_reason(text)
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.partners_didit_certification_operator_hash()
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.partners_require_didit_certification_observer(text)
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.partners_assert_didit_certification_pre_gate()
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.partners_require_didit_certification_operator(text)
  from public, anon, authenticated, service_role;

revoke all on function
  affiliate_private.admin_partners_kyc_certification_prepare(
    text, text, boolean, text, text, text
  )
  from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.admin_partners_kyc_certification_prepare(
    text, text, boolean, text, text, text
  )
  to authenticated;
revoke all on function
  affiliate_private.admin_partners_kyc_certification_resume()
  from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.admin_partners_kyc_certification_resume()
  to authenticated;
revoke all on function
  affiliate_private.admin_partners_kyc_certification_status()
  from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.admin_partners_kyc_certification_status()
  to authenticated;

revoke all on function
  affiliate_private.partners_service_kyc_certification_create_claim(text)
  from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.partners_service_kyc_certification_create_claim(text)
  to service_role;
revoke all on function
  affiliate_private.partners_service_kyc_certification_binding_match(
    text, text
  )
  from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.partners_service_kyc_certification_binding_match(
    text, text
  )
  to service_role;
revoke all on function
  affiliate_private.partners_service_kyc_certification_session_record(
    text, text, text, integer, text, text, text, integer
  )
  from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.partners_service_kyc_certification_session_record(
    text, text, text, integer, text, text, text, integer
  )
  to service_role;
revoke all on function
  affiliate_private.partners_service_kyc_certification_webhook_apply(
    text, text, text, integer, text, timestamptz, integer, text,
    boolean, boolean, boolean, text, text, text
  )
  from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.partners_service_kyc_certification_webhook_apply(
    text, text, text, integer, text, timestamptz, integer, text,
    boolean, boolean, boolean, text, text, text
  )
  to service_role;

revoke all on function public.admin_partners_kyc_certification_prepare(
  text, text, boolean, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.admin_partners_kyc_certification_prepare(
  text, text, boolean, text, text, text
) to authenticated;
revoke all on function public.admin_partners_kyc_certification_resume()
  from public, anon, authenticated, service_role;
grant execute on function public.admin_partners_kyc_certification_resume()
  to authenticated;
revoke all on function public.admin_partners_kyc_certification_status()
  from public, anon, authenticated, service_role;
grant execute on function public.admin_partners_kyc_certification_status()
  to authenticated;

revoke all on function
  public.partners_service_kyc_certification_create_claim(text)
  from public, anon, authenticated, service_role;
grant execute on function
  public.partners_service_kyc_certification_create_claim(text)
  to service_role;
revoke all on function
  public.partners_service_kyc_certification_binding_match(text, text)
  from public, anon, authenticated, service_role;
grant execute on function
  public.partners_service_kyc_certification_binding_match(text, text)
  to service_role;
revoke all on function
  public.partners_service_kyc_certification_session_record(
    text, text, text, integer, text, text, text, integer
  )
  from public, anon, authenticated, service_role;
grant execute on function
  public.partners_service_kyc_certification_session_record(
    text, text, text, integer, text, text, text, integer
  )
  to service_role;
revoke all on function
  public.partners_service_kyc_certification_webhook_apply(
    text, text, text, integer, text, timestamptz, integer, text,
    boolean, boolean, boolean, text, text, text
  )
  from public, anon, authenticated, service_role;
grant execute on function
  public.partners_service_kyc_certification_webhook_apply(
    text, text, text, integer, text, timestamptz, integer, text,
    boolean, boolean, boolean, text, text, text
  )
  to service_role;

comment on table
  affiliate_private.affiliate_didit_session_registry is
  'Cross-purpose Didit session registry containing only provider hashes; one provider session can never be reused between member KYC and pre-gate certification.';
comment on table
  affiliate_private.affiliate_didit_certification_sessions is
  'Isolated, two-hour pre-gate Didit certification state for a live Admin+Risk operator; it has no affiliate account foreign key and cannot promote release controls.';
comment on table
  affiliate_private.affiliate_didit_certification_events is
  'Append-only, payload-free certification observations containing only hashes, bounded states, booleans and timestamps.';
comment on column
  affiliate_private.affiliate_didit_certification_sessions.operator_hash is
  'One-way pseudonym derived from auth.uid(); the raw Auth subject is never stored here.';
comment on column
  affiliate_private.affiliate_didit_certification_sessions.provider_session_hash is
  'SHA-256 of the namespaced raw Didit session identifier.';
comment on column
  affiliate_private.affiliate_didit_certification_sessions.provider_create_dispatched_at is
  'Immutable timestamp of the sole durable provider-create dispatch claim; NULL means no Edge replica is authorized to POST.';
comment on column
  affiliate_private.affiliate_didit_certification_events.provider_event_hash is
  'SHA-256 of the namespaced raw Didit event identifier.';
comment on function
  affiliate_private.partners_didit_certification_key(text, uuid) is
  'Private deterministic derivation of a resumable opaque key from the immutable operator pseudonym and certification session UUID; no plaintext key is persisted.';
comment on function
  affiliate_private.admin_partners_kyc_certification_resume() is
  'Private guarded implementation for resuming only an unexpired reserved or pending certification owned by auth.uid().';
comment on function public.admin_partners_kyc_certification_prepare(
  text, text, boolean, text, text, text
) is
  'Reserves one isolated Didit certification for auth.uid() after live Risk, AAL2, fresh-JWT, privacy and kill-switch checks.';
comment on function public.admin_partners_kyc_certification_resume() is
  'Recomputes and returns the opaque key for auth.uid() current unexpired reserved or pending certification after rechecking live Risk, AAL2, fresh JWT, privacy and every pre-gate kill switch; in-review and terminal runs cannot be resumed.';
comment on function public.admin_partners_kyc_certification_status() is
  'Returns only the sanitized current or latest certification state for auth.uid() after rechecking the live Admin and Risk observer boundary; status remains readable after the one-shot pre-gate controls close.';
comment on function
  public.partners_service_kyc_certification_create_claim(text) is
  'Service-only one-way claim acquired after an exact Didit list read; exactly one replica can authorize a first provider POST.';
comment on function
  public.partners_service_kyc_certification_binding_match(text, text) is
  'Service-only hash comparison for one pending certification and one Didit list candidate; returns no provider identifier, URL or workflow metadata.';
comment on function
  public.partners_service_kyc_certification_session_record(
    text, text, text, integer, text, text, text, integer
  ) is
  'Service-only binding of a hosted Didit session to a pre-gate certification; provider identifiers are hashed internally.';
comment on function
  public.partners_service_kyc_certification_webhook_apply(
    text, text, text, integer, text, timestamptz, integer, text,
    boolean, boolean, boolean, text, text, text
  ) is
  'Service-only idempotent Didit certification observation; mismatches are quarantined and no feature flag or release gate is promoted.';
