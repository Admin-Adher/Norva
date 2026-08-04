-- A biometric-consent attestation is distinct from acceptance of the general
-- Partners disclosure. It is recorded atomically with the KYC reservation so
-- an older terms/disclosure attestation can never silently authorize a new
-- document, selfie, liveness or face-match capture.

set statement_timeout = '120s';
set lock_timeout = '10s';

create table affiliate_private.affiliate_biometric_consent_attestations (
  id                         uuid primary key
    default extensions.gen_random_uuid(),
  account_id                 uuid not null
    references affiliate_private.affiliate_accounts(id),
  idempotency_key            text not null,
  reservation_key            text not null,
  disclosure_version         text not null,
  biometric_consent_version  text not null,
  consented_at               timestamptz not null default now(),
  constraint affiliate_biometric_consent_idempotency
    unique (account_id, idempotency_key),
  constraint affiliate_biometric_consent_reservation
    unique (reservation_key),
  constraint affiliate_biometric_consent_idempotency_format
    check (idempotency_key ~ '^[A-Za-z0-9._:-]{16,128}$'),
  constraint affiliate_biometric_consent_reservation_format
    check (reservation_key ~ '^kyr_[0-9a-f]{24}$'),
  constraint affiliate_biometric_consent_disclosure_format
    check (disclosure_version ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
  constraint affiliate_biometric_consent_version
    check (biometric_consent_version = 'partners-biometric-consent-v1')
);

create index affiliate_biometric_consent_account_time_idx
  on affiliate_private.affiliate_biometric_consent_attestations (
    account_id,
    consented_at desc
  );

alter table affiliate_private.affiliate_biometric_consent_attestations
  enable row level security;
revoke all on table
  affiliate_private.affiliate_biometric_consent_attestations
  from public, anon, authenticated, service_role;

create trigger affiliate_biometric_consent_append_only
before update or delete
on affiliate_private.affiliate_biometric_consent_attestations
for each row execute function
  affiliate_private.reject_partners_append_only_mutation();

create or replace function
affiliate_private.partners_service_kyc_prepare_v2(
  p_user_id uuid,
  p_idempotency_key text,
  p_disclosure_version text,
  p_biometric_consent_version text,
  p_capacity_attested boolean,
  p_language text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_disclosure text := lower(
    btrim(coalesce(p_disclosure_version, ''))
  );
  v_biometric_consent text := lower(
    btrim(coalesce(p_biometric_consent_version, ''))
  );
  v_response jsonb;
  v_reservation_key text;
  v_account affiliate_private.affiliate_accounts%rowtype;
  v_existing
    affiliate_private.affiliate_biometric_consent_attestations%rowtype;
  v_inserted_id uuid;
begin
  if p_user_id is null
    or p_idempotency_key is null
    or p_idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$'
    or v_disclosure !~ '^[a-z0-9][a-z0-9._-]{2,63}$'
    or v_biometric_consent <> 'partners-biometric-consent-v1'
    or p_capacity_attested is distinct from true
  then
    raise exception 'invalid versioned biometric consent'
      using errcode = '22023';
  end if;

  -- The legacy routine remains the authoritative policy, rate-limit and
  -- idempotency implementation. Calling it inside this function keeps its
  -- reservation and this dedicated consent row in the same transaction.
  v_response := affiliate_private.partners_service_kyc_prepare(
    p_user_id,
    p_idempotency_key,
    v_disclosure,
    p_capacity_attested,
    p_language
  );
  v_reservation_key := v_response #>> '{kyc,reservation_key}';
  if v_reservation_key !~ '^kyr_[0-9a-f]{24}$' then
    raise exception 'KYC reservation is unavailable'
      using errcode = '55000';
  end if;

  select account.*
  into v_account
  from affiliate_private.affiliate_accounts account
  where account.user_id = p_user_id
    and account.status <> 'closed'
  for update;
  if not found
    or v_account.disclosure_version_accepted
      is distinct from v_disclosure
  then
    raise exception 'accepted Partners disclosure is not current'
      using errcode = 'P0001';
  end if;

  insert into
    affiliate_private.affiliate_biometric_consent_attestations (
      account_id,
      idempotency_key,
      reservation_key,
      disclosure_version,
      biometric_consent_version
    ) values (
      v_account.id,
      p_idempotency_key,
      v_reservation_key,
      v_disclosure,
      v_biometric_consent
    )
  on conflict (account_id, idempotency_key) do nothing
  returning id into v_inserted_id;

  if v_inserted_id is null then
    select consent.*
    into v_existing
    from affiliate_private.affiliate_biometric_consent_attestations consent
    where consent.account_id = v_account.id
      and consent.idempotency_key = p_idempotency_key;
    if not found
      or v_existing.reservation_key <> v_reservation_key
      or v_existing.disclosure_version <> v_disclosure
      or v_existing.biometric_consent_version <> v_biometric_consent
    then
      raise exception 'biometric consent idempotency key was reused'
        using errcode = 'P0003';
    end if;
  else
    insert into affiliate_private.affiliate_events (
      aggregate_type,
      aggregate_key,
      action,
      actor_type,
      actor_pseudonym,
      justification,
      after_state
    ) values (
      'kyc',
      v_account.id::text,
      'kyc_biometric_consent_attested',
      'service',
      v_account.user_pseudonym,
      'User explicitly consented to versioned individual biometric capture.',
      jsonb_build_object(
        'disclosure_version', v_disclosure,
        'biometric_consent_version', v_biometric_consent,
        'reservation_key_sha256', encode(
          extensions.digest(v_reservation_key, 'sha256'),
          'hex'
        )
      )
    );
  end if;

  return jsonb_set(
    v_response,
    '{kyc,biometric_consent_version}',
    to_jsonb(v_biometric_consent),
    true
  );
end;
$$;

create or replace function public.partners_service_kyc_prepare_v2(
  p_user_id uuid,
  p_idempotency_key text,
  p_disclosure_version text,
  p_biometric_consent_version text,
  p_capacity_attested boolean,
  p_language text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.partners_service_kyc_prepare_v2(
    p_user_id,
    p_idempotency_key,
    p_disclosure_version,
    p_biometric_consent_version,
    p_capacity_attested,
    p_language
  );
$$;

create or replace function
affiliate_private.partners_service_kyc_session_record_v2(
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
  v_reservation_key text := lower(
    btrim(coalesce(p_reservation_key, ''))
  );
  v_account affiliate_private.affiliate_accounts%rowtype;
begin
  if p_user_id is null
    or v_reservation_key !~ '^kyr_[0-9a-f]{24}$'
  then
    raise exception 'invalid KYC biometric-consent binding'
      using errcode = '22023';
  end if;

  select account.*
  into v_account
  from affiliate_private.affiliate_accounts account
  where account.user_id = p_user_id
    and account.status = 'pending_verification';
  if not found or not exists (
    select 1
    from
      affiliate_private.affiliate_biometric_consent_attestations consent
    where consent.account_id = v_account.id
      and consent.reservation_key = v_reservation_key
      and consent.disclosure_version =
        v_account.disclosure_version_accepted
      and consent.biometric_consent_version =
        'partners-biometric-consent-v1'
  ) then
    raise exception 'versioned biometric consent is required'
      using errcode = 'P0001';
  end if;

  return affiliate_private.partners_service_kyc_session_record(
    p_user_id,
    p_idempotency_key,
    p_provider_session_id,
    p_provider_workflow_id,
    p_provider_workflow_version,
    p_provider_status,
    p_expires_at,
    v_reservation_key,
    p_provider_environment,
    p_provider_config_fingerprint,
    p_provider_session_ttl_seconds
  );
end;
$$;

create or replace function public.partners_service_kyc_session_record_v2(
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
  select affiliate_private.partners_service_kyc_session_record_v2(
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

revoke all on function
  affiliate_private.partners_service_kyc_prepare_v2(
    uuid, text, text, text, boolean, text
  ) from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.partners_service_kyc_prepare_v2(
    uuid, text, text, text, boolean, text
  ) to service_role;
revoke all on function public.partners_service_kyc_prepare_v2(
  uuid, text, text, text, boolean, text
) from public, anon, authenticated;
grant execute on function public.partners_service_kyc_prepare_v2(
  uuid, text, text, text, boolean, text
) to service_role;
revoke all on function
  affiliate_private.partners_service_kyc_session_record_v2(
    uuid, text, text, text, integer, text, timestamptz, text,
    text, text, integer
  ) from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.partners_service_kyc_session_record_v2(
    uuid, text, text, text, integer, text, timestamptz, text,
    text, text, integer
  ) to service_role;
revoke all on function public.partners_service_kyc_session_record_v2(
  uuid, text, text, text, integer, text, timestamptz, text,
  text, text, integer
) from public, anon, authenticated;
grant execute on function public.partners_service_kyc_session_record_v2(
  uuid, text, text, text, integer, text, timestamptz, text,
  text, text, integer
) to service_role;

comment on table
  affiliate_private.affiliate_biometric_consent_attestations is
  'Private append-only evidence of explicit Didit document/selfie/liveness/face-match consent, distinct from general Partners terms acceptance.';

reset lock_timeout;
reset statement_timeout;
