-- Norva Partners: enforce biometric-consent withdrawal and provide an
-- auditable, data-minimised human-review path. No identity document, biometric
-- capture, provider payload, provider session id, email or user UUID is exposed
-- by the public/Admin projections added here.

set statement_timeout = '120s';
set lock_timeout = '10s';

create table affiliate_private.affiliate_biometric_consent_withdrawals (
  id                         uuid primary key
    default extensions.gen_random_uuid(),
  account_id                 uuid not null unique
    references affiliate_private.affiliate_accounts(id)
    on delete restrict,
  idempotency_key            text not null,
  biometric_consent_version  text not null,
  withdrawn_at               timestamptz not null default now(),
  constraint affiliate_biometric_withdrawal_idempotency
    unique (account_id, idempotency_key),
  constraint affiliate_biometric_withdrawal_idempotency_format
    check (idempotency_key ~ '^[A-Za-z0-9._:-]{16,128}$'),
  constraint affiliate_biometric_withdrawal_version
    check (biometric_consent_version = 'partners-biometric-consent-v1')
);

create index affiliate_biometric_withdrawal_time_idx
  on affiliate_private.affiliate_biometric_consent_withdrawals (
    account_id,
    withdrawn_at desc
  );

alter table affiliate_private.affiliate_biometric_consent_withdrawals
  enable row level security;
revoke all on table
  affiliate_private.affiliate_biometric_consent_withdrawals
  from public, anon, authenticated, service_role;

create trigger affiliate_biometric_withdrawal_append_only
before update or delete
on affiliate_private.affiliate_biometric_consent_withdrawals
for each row execute function
  affiliate_private.reject_partners_append_only_mutation();

-- Keep the consent implementation delivered by 20260804084500 owner-only and
-- place the withdrawal guard in front of it. The public wrapper keeps resolving
-- the canonical function name and therefore cannot bypass this guard.
alter function affiliate_private.partners_service_kyc_prepare_v2(
  uuid, text, text, text, boolean, text
) rename to partners_service_kyc_prepare_v2_pre_withdrawal_20260804;

revoke all on function
  affiliate_private.partners_service_kyc_prepare_v2_pre_withdrawal_20260804(
    uuid, text, text, text, boolean, text
  ) from public, anon, authenticated, service_role;

create function affiliate_private.partners_service_kyc_prepare_v2(
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
  v_account_id uuid;
begin
  select account.id
  into v_account_id
  from affiliate_private.affiliate_accounts account
  where account.user_id = p_user_id
    and account.status <> 'closed'
  for update;

  if found and exists (
    select 1
    from affiliate_private.affiliate_biometric_consent_withdrawals withdrawal
    where withdrawal.account_id = v_account_id
  ) then
    raise exception 'biometric consent was withdrawn'
      using errcode = 'P0001';
  end if;

  return
    affiliate_private.partners_service_kyc_prepare_v2_pre_withdrawal_20260804(
      p_user_id,
      p_idempotency_key,
      p_disclosure_version,
      p_biometric_consent_version,
      p_capacity_attested,
      p_language
    );
end;
$$;

revoke all on function affiliate_private.partners_service_kyc_prepare_v2(
  uuid, text, text, text, boolean, text
) from public, anon, authenticated, service_role;
grant execute on function affiliate_private.partners_service_kyc_prepare_v2(
  uuid, text, text, text, boolean, text
) to service_role;

-- Serialize the final provider-session record against consent withdrawal. The
-- pre-withdrawal implementation still performs the authoritative v2 binding
-- and encrypted purge staging. If withdrawal won the shared lock first, this
-- wrapper terminalizes and activates that staged deletion in the same
-- transaction, and never reports the new session as active.
alter function affiliate_private.partners_service_kyc_session_record_v3(
  uuid, text, text, text, integer, text, timestamptz, text,
  text, text, integer, text
) rename to
  partners_service_kyc_session_record_v3_pre_withdrawal_20260804;

revoke all on function
  affiliate_private
    .partners_service_kyc_session_record_v3_pre_withdrawal_20260804(
      uuid, text, text, text, integer, text, timestamptz, text,
      text, text, integer, text
    )
  from public, anon, authenticated, service_role;

create function affiliate_private.partners_service_kyc_session_record_v3(
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
  p_provider_session_ttl_seconds integer,
  p_provider_session_envelope text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_account_id uuid;
  v_response jsonb;
  v_provider_session_hash text;
  v_purge_status text;
  v_session_status text;
  v_withdrawn boolean := false;
begin
  if p_user_id is null then
    raise exception 'user id is required' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:biometric-withdraw:' || p_user_id::text,
      0
    )
  );
  select account.id
  into v_account_id
  from affiliate_private.affiliate_accounts account
  where account.user_id = p_user_id
    and account.status <> 'closed'
  for update;

  if found then
    select exists (
      select 1
      from affiliate_private.affiliate_biometric_consent_withdrawals withdrawal
      where withdrawal.account_id = v_account_id
    ) into v_withdrawn;
  end if;

  v_response :=
    affiliate_private
      .partners_service_kyc_session_record_v3_pre_withdrawal_20260804(
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
        p_provider_session_ttl_seconds,
        p_provider_session_envelope
      );

  if not v_withdrawn then
    return v_response;
  end if;

  v_provider_session_hash := encode(
    extensions.digest(
      'norva:didit:session:v1:' || lower(p_provider_session_id),
      'sha256'
    ),
    'hex'
  );
  update affiliate_private.affiliate_kyc_sessions session
  set status = 'superseded', updated_at = now()
  where session.account_id = v_account_id
    and session.provider_session_hash = v_provider_session_hash
    and session.status = 'pending'
  returning session.status into v_session_status;
  if not found then
    select session.status
    into v_session_status
    from affiliate_private.affiliate_kyc_sessions session
    where session.account_id = v_account_id
      and session.provider_session_hash = v_provider_session_hash;
    if not found or v_session_status <> 'superseded' then
      raise exception 'withdrawn KYC session state is unavailable'
        using errcode = '55000';
    end if;
  end if;

  v_purge_status :=
    affiliate_private.partners_didit_purge_activate_staged(
      v_provider_session_hash,
      'biometric_consent_withdrawn'
    );
  return jsonb_set(
    v_response,
    '{kyc,status}',
    '"superseded"'::jsonb,
    true
  ) || jsonb_build_object(
      'session_disposition', 'withdrawn',
      'purge_status', v_purge_status
    );
end;
$$;

create or replace function public.partners_service_kyc_session_record_v3(
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
  p_provider_session_ttl_seconds integer,
  p_provider_session_envelope text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.partners_service_kyc_session_record_v3(
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
    p_provider_session_ttl_seconds,
    p_provider_session_envelope
  );
$$;

revoke all on function
  affiliate_private.partners_service_kyc_session_record_v3(
    uuid, text, text, text, integer, text, timestamptz, text,
    text, text, integer, text
  ),
  public.partners_service_kyc_session_record_v3(
    uuid, text, text, text, integer, text, timestamptz, text,
    text, text, integer, text
  )
  from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.partners_service_kyc_session_record_v3(
    uuid, text, text, text, integer, text, timestamptz, text,
    text, text, integer, text
  ),
  public.partners_service_kyc_session_record_v3(
    uuid, text, text, text, integer, text, timestamptz, text,
    text, text, integer, text
  )
  to service_role;

create table affiliate_private.affiliate_kyc_human_review_requests (
  id                       uuid primary key
    default extensions.gen_random_uuid(),
  review_key               text not null unique default (
    'khr_' || left(encode(extensions.gen_random_bytes(16), 'hex'), 24)
  ),
  account_id               uuid not null
    references affiliate_private.affiliate_accounts(id)
    on delete restrict,
  session_id               uuid not null
    references affiliate_private.affiliate_kyc_sessions(id)
    on delete restrict,
  idempotency_key          text not null,
  reason                   text not null,
  status                   text not null default 'requested',
  resolution               text,
  evidence_sha256          text,
  evidence_observed_at     timestamptz,
  requested_at             timestamptz not null default now(),
  review_started_at        timestamptz,
  resolved_at              timestamptz,
  reviewed_by_pseudonym    text,
  justification            text,
  updated_at               timestamptz not null default now(),
  constraint affiliate_kyc_human_review_key
    check (review_key ~ '^khr_[0-9a-f]{24}$'),
  constraint affiliate_kyc_human_review_idempotency
    unique (account_id, idempotency_key),
  constraint affiliate_kyc_human_review_idempotency_format
    check (idempotency_key ~ '^[A-Za-z0-9._:-]{16,128}$'),
  constraint affiliate_kyc_human_review_reason
    check (reason in (
      'identity_result_contested',
      'age_result_contested',
      'country_result_contested',
      'verification_unavailable',
      'other_result_contested'
    )),
  constraint affiliate_kyc_human_review_status
    check (status in ('requested', 'in_review', 'resolved')),
  constraint affiliate_kyc_human_review_resolution
    check (resolution is null or resolution in (
      'original_decision_upheld',
      'reverification_available'
    )),
  constraint affiliate_kyc_human_review_actor
    check (
      reviewed_by_pseudonym is null
      or reviewed_by_pseudonym ~ '^[0-9a-f]{64}$'
    ),
  constraint affiliate_kyc_human_review_evidence
    check (
      (evidence_sha256 is null and evidence_observed_at is null)
      or (
        evidence_sha256 ~ '^[0-9a-f]{64}$'
        and evidence_sha256 <> repeat('0', 64)
        and evidence_observed_at is not null
      )
    ),
  constraint affiliate_kyc_human_review_state
    check (
      (status = 'requested'
        and review_started_at is null
        and resolved_at is null
        and resolution is null
        and reviewed_by_pseudonym is null
        and justification is null
        and evidence_sha256 is null)
      or (status = 'in_review'
        and review_started_at is not null
        and resolved_at is null
        and resolution is null
        and reviewed_by_pseudonym is not null
        and justification is not null
        and evidence_sha256 is null)
      or (status = 'resolved'
        and review_started_at is not null
        and resolved_at is not null
        and resolution is not null
        and reviewed_by_pseudonym is not null
        and justification is not null
        and evidence_sha256 is not null)
    ),
  constraint affiliate_kyc_human_review_justification
    check (
      justification is null
      or length(btrim(justification)) between 12 and 1000
    )
);

create unique index affiliate_kyc_human_review_one_open_idx
  on affiliate_private.affiliate_kyc_human_review_requests (account_id)
  where status in ('requested', 'in_review');
create index affiliate_kyc_human_review_queue_idx
  on affiliate_private.affiliate_kyc_human_review_requests (
    status,
    requested_at desc,
    review_key
  );

alter table affiliate_private.affiliate_kyc_human_review_requests
  enable row level security;
revoke all on table affiliate_private.affiliate_kyc_human_review_requests
  from public, anon, authenticated, service_role;

create or replace function
affiliate_private.guard_partners_kyc_human_review_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_control text := coalesce(
    current_setting('norva.partners_kyc_review_control', true),
    ''
  );
begin
  if tg_op = 'DELETE' then
    raise exception 'KYC human-review requests are retained'
      using errcode = '55000';
  end if;

  if tg_op = 'INSERT' then
    if v_control <> 'request' then
      raise exception 'KYC human-review requests require the audited RPC'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if v_control <> 'admin' then
    raise exception 'KYC human-review decisions require the audited RPC'
      using errcode = '42501';
  end if;
  if new.id is distinct from old.id
    or new.review_key is distinct from old.review_key
    or new.account_id is distinct from old.account_id
    or new.session_id is distinct from old.session_id
    or new.idempotency_key is distinct from old.idempotency_key
    or new.reason is distinct from old.reason
    or new.requested_at is distinct from old.requested_at
  then
    raise exception 'KYC human-review request identity is immutable'
      using errcode = '55000';
  end if;
  if not (
    (old.status = 'requested' and new.status = 'in_review')
    or (old.status = 'in_review' and new.status = 'resolved')
  ) then
    raise exception 'invalid KYC human-review transition'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger affiliate_kyc_human_review_guard
before insert or update or delete
on affiliate_private.affiliate_kyc_human_review_requests
for each row execute function
  affiliate_private.guard_partners_kyc_human_review_mutation();

create or replace function
affiliate_private.partners_kyc_rights_snapshot(p_account_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_account affiliate_private.affiliate_accounts%rowtype;
  v_consent
    affiliate_private.affiliate_biometric_consent_attestations%rowtype;
  v_withdrawal
    affiliate_private.affiliate_biometric_consent_withdrawals%rowtype;
  v_review
    affiliate_private.affiliate_kyc_human_review_requests%rowtype;
  v_open_review boolean := false;
begin
  select account.*
  into v_account
  from affiliate_private.affiliate_accounts account
  where account.id = p_account_id;
  if not found then
    return jsonb_build_object(
      'schema_version', 1,
      'consent', jsonb_build_object(
        'status', 'not_available',
        'version', 'partners-biometric-consent-v1',
        'granted_at', null,
        'withdrawn_at', null
      ),
      'review', jsonb_build_object(
        'exists', false,
        'key', null,
        'status', 'none',
        'reason', null,
        'resolution', null,
        'requested_at', null,
        'updated_at', null,
        'resolved_at', null
      ),
      'actions', jsonb_build_object(
        'can_withdraw', false,
        'can_request_human_review', false
      )
    );
  end if;

  select consent.*
  into v_consent
  from affiliate_private.affiliate_biometric_consent_attestations consent
  where consent.account_id = v_account.id
  order by consent.consented_at desc, consent.id desc
  limit 1;

  select withdrawal.*
  into v_withdrawal
  from affiliate_private.affiliate_biometric_consent_withdrawals withdrawal
  where withdrawal.account_id = v_account.id
  order by withdrawal.withdrawn_at desc, withdrawal.id desc
  limit 1;

  select review.*
  into v_review
  from affiliate_private.affiliate_kyc_human_review_requests review
  where review.account_id = v_account.id
  order by review.requested_at desc, review.id desc
  limit 1;
  v_open_review := found and v_review.status in ('requested', 'in_review');

  return jsonb_build_object(
    'schema_version', 1,
    'consent', jsonb_build_object(
      'status', case
        when v_withdrawal.id is not null then 'withdrawn'
        when v_consent.id is not null then 'granted'
        else 'not_granted'
      end,
      'version', 'partners-biometric-consent-v1',
      'granted_at', v_consent.consented_at,
      'withdrawn_at', v_withdrawal.withdrawn_at
    ),
    'review', jsonb_build_object(
      'exists', v_review.id is not null,
      'key', v_review.review_key,
      'status', coalesce(v_review.status, 'none'),
      'reason', v_review.reason,
      'resolution', v_review.resolution,
      'requested_at', v_review.requested_at,
      'updated_at', v_review.updated_at,
      'resolved_at', v_review.resolved_at
    ),
    'actions', jsonb_build_object(
      'can_withdraw',
        v_consent.id is not null and v_withdrawal.id is null,
      'can_request_human_review',
        v_account.status = 'pending_verification'
        and v_account.verification_status in ('failed', 'expired')
        and not v_open_review
    )
  );
end;
$$;

create or replace function
affiliate_private.partners_service_kyc_rights_get(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_account_id uuid;
begin
  select account.id
  into v_account_id
  from affiliate_private.affiliate_accounts account
  where account.user_id = p_user_id
    and account.status <> 'closed';
  return affiliate_private.partners_kyc_rights_snapshot(v_account_id);
end;
$$;

create or replace function public.partners_service_kyc_rights_get(
  p_user_id uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select affiliate_private.partners_service_kyc_rights_get(p_user_id);
$$;

create or replace function
affiliate_private.partners_service_biometric_consent_withdraw(
  p_user_id uuid,
  p_idempotency_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_account affiliate_private.affiliate_accounts%rowtype;
  v_withdrawal
    affiliate_private.affiliate_biometric_consent_withdrawals%rowtype;
  v_replayed boolean := false;
  v_session_id uuid;
  v_provider_session_hash text;
  v_provider_environment text;
begin
  if p_user_id is null
    or p_idempotency_key is null
    or p_idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$'
  then
    raise exception 'invalid biometric-consent withdrawal'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('norva:partners:biometric-withdraw:' || p_user_id::text, 0)
  );
  select account.*
  into v_account
  from affiliate_private.affiliate_accounts account
  where account.user_id = p_user_id
    and account.status <> 'closed'
  for update;
  if not found then
    raise exception 'Partners account is unavailable' using errcode = 'P0001';
  end if;
  if not exists (
    select 1
    from affiliate_private.affiliate_biometric_consent_attestations consent
    where consent.account_id = v_account.id
  ) then
    raise exception 'no biometric consent exists' using errcode = 'P0001';
  end if;

  select withdrawal.*
  into v_withdrawal
  from affiliate_private.affiliate_biometric_consent_withdrawals withdrawal
  where withdrawal.account_id = v_account.id;
  if found then
    v_replayed := true;
  else
    insert into affiliate_private.affiliate_biometric_consent_withdrawals (
      account_id,
      idempotency_key,
      biometric_consent_version
    ) values (
      v_account.id,
      p_idempotency_key,
      'partners-biometric-consent-v1'
    ) returning * into v_withdrawal;

    for v_session_id, v_provider_session_hash, v_provider_environment in
      update affiliate_private.affiliate_kyc_sessions session
      set status = 'superseded', updated_at = now()
      where session.account_id = v_account.id
        and session.status = 'pending'
      returning
        session.id,
        session.provider_session_hash,
        session.provider_environment
    loop
      if exists (
        select 1
        from affiliate_private.affiliate_didit_purge_outbox outbox
        where outbox.provider_session_hash = v_provider_session_hash
          and outbox.session_purpose = 'member_kyc'
          and outbox.source_record_id = v_session_id
          and outbox.provider_environment = v_provider_environment
      ) then
        perform affiliate_private.partners_didit_purge_activate_staged(
          v_provider_session_hash,
          'biometric_consent_withdrawn'
        );
      else
        -- A rolling-deploy legacy session may predate atomic envelope staging.
        -- Withdrawal must still succeed, but the absence of deletion material
        -- is made an explicit dead letter so release preflight fails closed.
        update affiliate_private.affiliate_kyc_sessions session
        set
          provider_purge_status = 'purge_dead_letter',
          provider_purge_requested_at = coalesce(
            session.provider_purge_requested_at,
            now()
          ),
          provider_purged_at = null,
          updated_at = now()
        where session.id = v_session_id;

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
          'kyc_didit_purge_orphan_dead_lettered',
          'service',
          v_account.user_pseudonym,
          'Biometric withdrawal found a legacy session without encrypted deletion material.',
          jsonb_build_object(
            'purge_status', 'purge_dead_letter',
            'release_blocked', true
          )
        );
      end if;
    end loop;

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
      'kyc_biometric_consent_withdrawn',
      'service',
      v_account.user_pseudonym,
      'User withdrew consent for any new individual biometric verification.',
      jsonb_build_object(
        'biometric_consent_version',
          'partners-biometric-consent-v1',
        'new_kyc_blocked', true
      )
    );
  end if;

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'biometric_consent_withdrawn',
    'replayed', v_replayed,
    'rights', affiliate_private.partners_kyc_rights_snapshot(v_account.id)
  );
end;
$$;

create or replace function public.partners_service_biometric_consent_withdraw(
  p_user_id uuid,
  p_idempotency_key text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.partners_service_biometric_consent_withdraw(
    p_user_id,
    p_idempotency_key
  );
$$;

create or replace function
affiliate_private.partners_service_kyc_human_review_request(
  p_user_id uuid,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_reason text := lower(btrim(coalesce(p_reason, '')));
  v_account affiliate_private.affiliate_accounts%rowtype;
  v_session affiliate_private.affiliate_kyc_sessions%rowtype;
  v_review
    affiliate_private.affiliate_kyc_human_review_requests%rowtype;
  v_replayed boolean := false;
begin
  if p_user_id is null
    or p_idempotency_key is null
    or p_idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$'
    or v_reason not in (
      'identity_result_contested',
      'age_result_contested',
      'country_result_contested',
      'verification_unavailable',
      'other_result_contested'
    )
  then
    raise exception 'invalid KYC human-review request'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('norva:partners:kyc-review:' || p_user_id::text, 0)
  );
  select account.*
  into v_account
  from affiliate_private.affiliate_accounts account
  where account.user_id = p_user_id
    and account.status = 'pending_verification'
  for update;
  if not found
    or v_account.verification_status not in ('failed', 'expired')
  then
    raise exception 'KYC human review is unavailable'
      using errcode = 'P0001';
  end if;

  select review.*
  into v_review
  from affiliate_private.affiliate_kyc_human_review_requests review
  where review.account_id = v_account.id
    and review.idempotency_key = p_idempotency_key;
  if found then
    if v_review.reason <> v_reason then
      raise exception 'KYC review idempotency key was reused'
        using errcode = 'P0003';
    end if;
    v_replayed := true;
  else
    if exists (
      select 1
      from affiliate_private.affiliate_kyc_human_review_requests review
      where review.account_id = v_account.id
        and review.status in ('requested', 'in_review')
    ) then
      raise exception 'KYC human review is already in progress'
        using errcode = 'P0004';
    end if;
    if (
      select count(*)
      from affiliate_private.affiliate_kyc_human_review_requests review
      where review.account_id = v_account.id
        and review.requested_at >= now() - interval '30 days'
    ) >= 3 then
      raise exception 'KYC human-review request limit reached'
        using errcode = 'P0008';
    end if;

    select session.*
    into v_session
    from affiliate_private.affiliate_kyc_sessions session
    where session.account_id = v_account.id
      and session.status in ('failed', 'expired')
    order by session.updated_at desc, session.id desc
    limit 1;
    if not found then
      raise exception 'KYC decision is unavailable' using errcode = 'P0001';
    end if;

    perform set_config('norva.partners_kyc_review_control', 'request', true);
    insert into affiliate_private.affiliate_kyc_human_review_requests (
      account_id,
      session_id,
      idempotency_key,
      reason
    ) values (
      v_account.id,
      v_session.id,
      p_idempotency_key,
      v_reason
    ) returning * into v_review;

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
      v_review.review_key,
      'kyc_human_review_requested',
      'service',
      v_account.user_pseudonym,
      'User requested human review of a sanitized KYC outcome.',
      jsonb_build_object(
        'status', 'requested',
        'reason', v_reason
      )
    );
  end if;

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'kyc_human_review_requested',
    'replayed', v_replayed,
    'rights', affiliate_private.partners_kyc_rights_snapshot(v_account.id)
  );
end;
$$;

create or replace function public.partners_service_kyc_human_review_request(
  p_user_id uuid,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.partners_service_kyc_human_review_request(
    p_user_id,
    p_reason,
    p_idempotency_key
  );
$$;

create or replace function
affiliate_private.admin_partners_kyc_human_review_queue(
  p_limit integer,
  p_offset integer,
  p_status text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_status text := lower(btrim(coalesce(p_status, 'all')));
  v_total bigint;
  v_items jsonb;
begin
  perform affiliate_private.partners_require_capability('risk');
  if v_status not in ('all', 'requested', 'in_review', 'resolved') then
    raise exception 'invalid KYC human-review filter'
      using errcode = '22023';
  end if;

  select count(*)
  into v_total
  from affiliate_private.affiliate_kyc_human_review_requests review
  where v_status = 'all' or review.status = v_status;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'review_key', page.review_key,
      'account_id', page.account_public_id,
      'status', page.status,
      'reason', page.reason,
      'resolution', page.resolution,
      'verification_status', page.verification_status,
      'consent_status', page.consent_status,
      'requested_at', page.requested_at,
      'updated_at', page.updated_at,
      'resolved_at', page.resolved_at
    ) order by page.requested_at desc, page.review_key
  ), '[]'::jsonb)
  into v_items
  from (
    select
      review.review_key,
      affiliate_private.partners_public_account_id(account)
        as account_public_id,
      review.status,
      review.reason,
      review.resolution,
      account.verification_status,
      case when exists (
        select 1
        from affiliate_private.affiliate_biometric_consent_withdrawals withdrawal
        where withdrawal.account_id = account.id
      ) then 'withdrawn' else 'not_withdrawn' end as consent_status,
      review.requested_at,
      review.updated_at,
      review.resolved_at
    from affiliate_private.affiliate_kyc_human_review_requests review
    join affiliate_private.affiliate_accounts account
      on account.id = review.account_id
    where v_status = 'all' or review.status = v_status
    order by review.requested_at desc, review.review_key
    limit v_limit offset v_offset
  ) page;

  return jsonb_build_object(
    'schema_version', 1,
    'total', v_total,
    'items', v_items
  );
end;
$$;

create or replace function public.admin_partners_kyc_human_review_queue(
  p_limit integer,
  p_offset integer,
  p_status text
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select affiliate_private.admin_partners_kyc_human_review_queue(
    p_limit,
    p_offset,
    p_status
  );
$$;

create or replace function
affiliate_private.admin_partners_kyc_human_review_locator(
  p_review_key text,
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
  v_key text := lower(btrim(coalesce(p_review_key, '')));
  v_confirmation text := btrim(coalesce(p_confirmation, ''));
  v_justification text := btrim(coalesce(p_justification, ''));
  v_review
    affiliate_private.affiliate_kyc_human_review_requests%rowtype;
  v_locator text;
  v_actor text;
begin
  perform affiliate_private.partners_require_capability('risk');
  perform affiliate_private.partners_require_aal2(
    'Partners KYC human-review provider lookup'
  );
  if v_key !~ '^khr_[0-9a-f]{24}$'
    or v_confirmation <> 'LOOKUP:' || v_key
    or length(v_justification) not between 12 and 1000
  then
    raise exception 'invalid KYC review lookup request'
      using errcode = '22023';
  end if;

  select review.*
  into v_review
  from affiliate_private.affiliate_kyc_human_review_requests review
  join affiliate_private.affiliate_accounts account
    on account.id = review.account_id
  where review.review_key = v_key;
  if not found then
    raise exception 'KYC human-review request was not found'
      using errcode = 'P0002';
  end if;
  if v_review.status = 'resolved' then
    raise exception 'KYC human review is already resolved'
      using errcode = 'P0001';
  end if;

  select reservation.reservation_key
  into v_locator
  from affiliate_private.affiliate_kyc_session_reservations reservation
  where reservation.bound_session_id = v_review.session_id;
  if not found then
    raise exception 'KYC review locator is unavailable'
      using errcode = '55000';
  end if;

  v_actor := affiliate_private.partners_admin_actor_pseudonym();
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
    v_key,
    'kyc_human_review_locator_accessed',
    'admin',
    v_actor,
    v_justification,
    jsonb_build_object(
      'provider', 'didit',
      'lookup_accessed', true
    )
  );

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'kyc_human_review_locator_accessed',
    'lookup', jsonb_build_object(
      'review_key', v_key,
      'provider', 'didit',
      'vendor_data', v_locator
    )
  );
end;
$$;

create or replace function public.admin_partners_kyc_human_review_locator(
  p_review_key text,
  p_confirmation text,
  p_justification text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.admin_partners_kyc_human_review_locator(
    p_review_key,
    p_confirmation,
    p_justification
  );
$$;

create or replace function
affiliate_private.admin_partners_kyc_human_review_decide(
  p_review_key text,
  p_action text,
  p_evidence_sha256 text,
  p_evidence_observed_at timestamptz,
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
  v_key text := lower(btrim(coalesce(p_review_key, '')));
  v_action text := lower(btrim(coalesce(p_action, '')));
  v_evidence text := lower(btrim(coalesce(p_evidence_sha256, '')));
  v_confirmation text := btrim(coalesce(p_confirmation, ''));
  v_justification text := btrim(coalesce(p_justification, ''));
  v_review
    affiliate_private.affiliate_kyc_human_review_requests%rowtype;
  v_actor text;
  v_resolution text;
  v_now timestamptz := clock_timestamp();
begin
  perform affiliate_private.partners_require_capability('risk');
  perform affiliate_private.partners_require_aal2(
    'Partners KYC human-review decision'
  );
  if v_key !~ '^khr_[0-9a-f]{24}$'
    or v_action not in ('start', 'resolve_upheld', 'resolve_reverification')
    or length(v_justification) not between 12 and 1000
  then
    raise exception 'invalid KYC human-review decision'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('norva:partners:kyc-review-admin:' || v_key, 0)
  );
  select review.*
  into v_review
  from affiliate_private.affiliate_kyc_human_review_requests review
  join affiliate_private.affiliate_accounts account
    on account.id = review.account_id
  where review.review_key = v_key
  for update of review;
  if not found then
    raise exception 'KYC human-review request was not found'
      using errcode = 'P0002';
  end if;

  v_actor := affiliate_private.partners_admin_actor_pseudonym();
  perform set_config('norva.partners_kyc_review_control', 'admin', true);
  if v_action = 'start' then
    if v_review.status <> 'requested'
      or v_confirmation <> 'START:' || v_key
      or v_evidence <> ''
      or p_evidence_observed_at is not null
    then
      raise exception 'KYC human review cannot be started'
        using errcode = 'P0001';
    end if;
    update affiliate_private.affiliate_kyc_human_review_requests review
    set
      status = 'in_review',
      review_started_at = v_now,
      reviewed_by_pseudonym = v_actor,
      justification = v_justification,
      updated_at = v_now
    where review.id = v_review.id
    returning * into v_review;
  else
    v_resolution := case v_action
      when 'resolve_upheld' then 'original_decision_upheld'
      else 'reverification_available'
    end;
    if v_review.status <> 'in_review'
      or v_confirmation <> case v_action
        when 'resolve_upheld' then 'RESOLVE-UPHOLD:' || v_key
        else 'RESOLVE-REVERIFY:' || v_key
      end
      or v_evidence !~ '^[0-9a-f]{64}$'
      or v_evidence = repeat('0', 64)
      or p_evidence_observed_at is null
      or p_evidence_observed_at < v_review.requested_at
      or p_evidence_observed_at > v_now + interval '1 minute'
    then
      raise exception 'KYC human review cannot be resolved'
        using errcode = 'P0001';
    end if;
    update affiliate_private.affiliate_kyc_human_review_requests review
    set
      status = 'resolved',
      resolution = v_resolution,
      evidence_sha256 = v_evidence,
      evidence_observed_at = p_evidence_observed_at,
      resolved_at = v_now,
      reviewed_by_pseudonym = v_actor,
      justification = v_justification,
      updated_at = v_now
    where review.id = v_review.id
    returning * into v_review;
  end if;

  insert into affiliate_private.affiliate_events (
    aggregate_type,
    aggregate_key,
    action,
    actor_type,
    actor_pseudonym,
    justification,
    before_state,
    after_state
  ) values (
    'kyc',
    v_key,
    case v_action
      when 'start' then 'kyc_human_review_started'
      else 'kyc_human_review_resolved'
    end,
    'admin',
    v_actor,
    v_justification,
    jsonb_build_object('status', case
      when v_action = 'start' then 'requested'
      else 'in_review'
    end),
    jsonb_build_object(
      'status', v_review.status,
      'resolution', v_review.resolution,
      'evidence_sha256', v_review.evidence_sha256,
      'evidence_observed_at', v_review.evidence_observed_at
    )
  );

  return jsonb_build_object(
    'schema_version', 1,
    'action', case v_action
      when 'start' then 'kyc_human_review_started'
      else 'kyc_human_review_resolved'
    end,
    'review', jsonb_build_object(
      'key', v_review.review_key,
      'status', v_review.status,
      'resolution', v_review.resolution,
      'updated_at', v_review.updated_at,
      'resolved_at', v_review.resolved_at
    )
  );
end;
$$;

create or replace function public.admin_partners_kyc_human_review_decide(
  p_review_key text,
  p_action text,
  p_evidence_sha256 text,
  p_evidence_observed_at timestamptz,
  p_confirmation text,
  p_justification text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.admin_partners_kyc_human_review_decide(
    p_review_key,
    p_action,
    p_evidence_sha256,
    p_evidence_observed_at,
    p_confirmation,
    p_justification
  );
$$;

revoke all on function
  affiliate_private.guard_partners_kyc_human_review_mutation()
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.partners_kyc_rights_snapshot(uuid)
  from public, anon, authenticated, service_role;

revoke all on function
  affiliate_private.partners_service_kyc_rights_get(uuid)
  from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.partners_service_kyc_rights_get(uuid)
  to service_role;
revoke all on function public.partners_service_kyc_rights_get(uuid)
  from public, anon, authenticated;
grant execute on function public.partners_service_kyc_rights_get(uuid)
  to service_role;

revoke all on function
  affiliate_private.partners_service_biometric_consent_withdraw(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.partners_service_biometric_consent_withdraw(uuid, text)
  to service_role;
revoke all on function
  public.partners_service_biometric_consent_withdraw(uuid, text)
  from public, anon, authenticated;
grant execute on function
  public.partners_service_biometric_consent_withdraw(uuid, text)
  to service_role;

revoke all on function
  affiliate_private.partners_service_kyc_human_review_request(uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.partners_service_kyc_human_review_request(uuid, text, text)
  to service_role;
revoke all on function
  public.partners_service_kyc_human_review_request(uuid, text, text)
  from public, anon, authenticated;
grant execute on function
  public.partners_service_kyc_human_review_request(uuid, text, text)
  to service_role;

revoke all on function
  affiliate_private.admin_partners_kyc_human_review_queue(integer, integer, text)
  from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.admin_partners_kyc_human_review_queue(integer, integer, text)
  to authenticated;
revoke all on function
  public.admin_partners_kyc_human_review_queue(integer, integer, text)
  from public, anon, service_role;
grant execute on function
  public.admin_partners_kyc_human_review_queue(integer, integer, text)
  to authenticated;

revoke all on function
  affiliate_private.admin_partners_kyc_human_review_locator(text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.admin_partners_kyc_human_review_locator(text, text, text)
  to authenticated;
revoke all on function
  public.admin_partners_kyc_human_review_locator(text, text, text)
  from public, anon, service_role;
grant execute on function
  public.admin_partners_kyc_human_review_locator(text, text, text)
  to authenticated;

revoke all on function
  affiliate_private.admin_partners_kyc_human_review_decide(
    text, text, text, timestamptz, text, text
  ) from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.admin_partners_kyc_human_review_decide(
    text, text, text, timestamptz, text, text
  ) to authenticated;
revoke all on function
  public.admin_partners_kyc_human_review_decide(
    text, text, text, timestamptz, text, text
  ) from public, anon, service_role;
grant execute on function
  public.admin_partners_kyc_human_review_decide(
    text, text, text, timestamptz, text, text
  ) to authenticated;

comment on table
  affiliate_private.affiliate_biometric_consent_withdrawals is
  'Append-only user withdrawals that permanently block new Didit biometric capture until a separately designed re-consent contract is approved.';
comment on table affiliate_private.affiliate_kyc_human_review_requests is
  'Sanitized KYC human-review workflow. It stores no provider payload, document, biometric capture, provider session id, email or user UUID in public/Admin projections.';

reset lock_timeout;
reset statement_timeout;
