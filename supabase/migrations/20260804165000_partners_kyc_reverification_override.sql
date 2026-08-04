-- Norva Partners: make a Risk+AAL2 human-review decision actionable without
-- weakening the ordinary KYC attempt policy. A resolved review can issue one
-- private right. Only the canonical v2 prepare path can consume it, once, in
-- the same transaction as the replacement reservation and biometric consent.

set statement_timeout = '120s';
set lock_timeout = '10s';

create table
affiliate_private.affiliate_kyc_reverification_grants (
  id                           uuid primary key
    default extensions.gen_random_uuid(),
  review_id                    uuid not null unique
    references affiliate_private.affiliate_kyc_human_review_requests(id)
    on delete restrict,
  account_id                   uuid not null
    references affiliate_private.affiliate_accounts(id)
    on delete restrict,
  issued_at                    timestamptz not null default now(),
  issued_by_pseudonym          text not null,
  consumed_at                  timestamptz,
  reservation_key_sha256       text,
  constraint affiliate_kyc_reverification_grant_actor
    check (issued_by_pseudonym ~ '^[0-9a-f]{64}$'),
  constraint affiliate_kyc_reverification_grant_reservation_hash
    check (
      reservation_key_sha256 is null
      or reservation_key_sha256 ~ '^[0-9a-f]{64}$'
    ),
  constraint affiliate_kyc_reverification_grant_state
    check (
      (consumed_at is null and reservation_key_sha256 is null)
      or (
        consumed_at is not null
        and consumed_at >= issued_at
        and reservation_key_sha256 is not null
      )
    )
);

create unique index affiliate_kyc_reverification_one_available_idx
  on affiliate_private.affiliate_kyc_reverification_grants (account_id)
  where consumed_at is null;

create index affiliate_kyc_reverification_account_time_idx
  on affiliate_private.affiliate_kyc_reverification_grants (
    account_id,
    issued_at desc
  );

alter table affiliate_private.affiliate_kyc_reverification_grants
  enable row level security;
revoke all on table
  affiliate_private.affiliate_kyc_reverification_grants
  from public, anon, authenticated, service_role;

create function
affiliate_private.guard_kyc_reverification_grant_mutation()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if not exists (
      select 1
      from affiliate_private.affiliate_kyc_human_review_requests review
      where review.id = new.review_id
        and review.account_id = new.account_id
        and review.status = 'resolved'
        and review.resolution = 'reverification_available'
        and review.reviewed_by_pseudonym = new.issued_by_pseudonym
    ) then
      raise exception
        'KYC re-verification grant does not match reviewed decision'
        using errcode = '23514';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE'
    or current_setting(
      'norva.partners_kyc_reverification_grant_control',
      true
    ) is distinct from 'consume'
    or old.review_id is distinct from new.review_id
    or old.account_id is distinct from new.account_id
    or old.issued_at is distinct from new.issued_at
    or old.issued_by_pseudonym is distinct from new.issued_by_pseudonym
    or old.consumed_at is not null
    or old.reservation_key_sha256 is not null
    or new.consumed_at is null
    or new.reservation_key_sha256 is null
  then
    raise exception 'KYC re-verification grant is immutable'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger affiliate_kyc_reverification_grant_guard
before insert or update or delete
on affiliate_private.affiliate_kyc_reverification_grants
for each row execute function
  affiliate_private.guard_kyc_reverification_grant_mutation();

create function
affiliate_private.partners_service_kyc_prepare_reverification_once_v2(
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
  v_language text := lower(btrim(coalesce(p_language, '')));
  v_request_hash text;
  v_replay jsonb;
  v_response jsonb;
  v_account affiliate_private.affiliate_accounts%rowtype;
  v_program affiliate_private.affiliate_program_versions%rowtype;
  v_policy affiliate_private.affiliate_country_policies%rowtype;
  v_attempt_policy
    affiliate_private.affiliate_kyc_attempt_policies%rowtype;
  v_attempt_count integer := 0;
  v_last_terminal_at timestamptz;
  v_has_pending boolean := false;
  v_reservation
    affiliate_private.affiliate_kyc_session_reservations%rowtype;
  v_grant
    affiliate_private.affiliate_kyc_reverification_grants%rowtype;
  v_review_key text;
  v_existing_consent
    affiliate_private.affiliate_biometric_consent_attestations%rowtype;
  v_inserted_consent_id uuid;
  v_attempt_limit_overridden boolean := false;
  v_cooldown_overridden boolean := false;
begin
  if p_user_id is null
    or p_idempotency_key is null
    or p_idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$'
    or v_disclosure !~ '^[a-z0-9][a-z0-9._-]{2,63}$'
    or v_biometric_consent <> 'partners-biometric-consent-v1'
    or v_language !~ '^[a-z]{2}$'
    or p_capacity_attested is distinct from true
  then
    raise exception 'invalid versioned biometric consent'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('norva:partners:user:' || p_user_id::text, 0)
  );

  v_request_hash := encode(
    extensions.digest(
      concat_ws(
        chr(31),
        'kyc_prepare:v1',
        p_user_id::text,
        v_disclosure,
        p_capacity_attested::text,
        v_language
      ),
      'sha256'
    ),
    'hex'
  );
  v_replay := affiliate_private.partners_replayed_response(
    'kyc_prepare',
    p_user_id,
    p_idempotency_key,
    v_request_hash
  );
  if v_replay is not null then
    -- Replays use the preserved v2 wrapper so the existing reservation and
    -- biometric attestation binding are revalidated. A replay never spends a
    -- newly issued human-review right.
    return
      affiliate_private.partners_service_kyc_prepare_v2_pre_withdrawal_20260804(
        p_user_id,
        p_idempotency_key,
        v_disclosure,
        v_biometric_consent,
        p_capacity_attested,
        v_language
      );
  end if;

  select account.*
  into v_account
  from affiliate_private.affiliate_accounts account
  where account.user_id = p_user_id
    and account.status <> 'closed'
  for update;
  if not found
    or v_account.status <> 'pending_verification'
    or v_account.account_type <> 'individual'
    or v_account.contract_status <> 'accepted'
  then
    raise exception 'Partners account is not ready for KYC'
      using errcode = 'P0001';
  end if;
  if exists (
    select 1
    from affiliate_private.affiliate_biometric_consent_withdrawals withdrawal
    where withdrawal.account_id = v_account.id
  ) then
    raise exception 'biometric consent was withdrawn'
      using errcode = 'P0001';
  end if;

  select grant_row, review.review_key
  into v_grant, v_review_key
  from affiliate_private.affiliate_kyc_reverification_grants grant_row
  join affiliate_private.affiliate_kyc_human_review_requests review
    on review.id = grant_row.review_id
  where grant_row.account_id = v_account.id
    and grant_row.consumed_at is null
    and review.status = 'resolved'
    and review.resolution = 'reverification_available'
  order by grant_row.issued_at, grant_row.id
  limit 1
  for update of grant_row;
  if not found then
    raise exception 'one-time KYC re-verification is unavailable'
      using errcode = 'P0001';
  end if;

  select program.*
  into v_program
  from affiliate_private.affiliate_program_versions program
  where program.id = v_account.program_version_id
  for share;
  select policy.*
  into v_policy
  from affiliate_private.affiliate_country_policies policy
  where policy.id = v_account.country_policy_id
  for share;

  if v_program.id is null
    or v_policy.id is null
    or v_program.status <> 'active'
    or v_program.account_type <> 'individual'
    or v_program.commission_rate_bps <> 2000
    or v_program.attribution_window_days <> 30
    or v_program.maturation_days <> 45
    or v_program.effective_from is null
    or v_program.effective_from > now()
    or (
      v_program.effective_until is not null
      and v_program.effective_until <= now()
    )
    or v_policy.program_version_id <> v_program.id
    or not v_policy.individual_available
    or v_policy.minimum_age not between 18 and 99
    or v_policy.verification_provider <> 'didit'
    or v_policy.verification_level not in (
      'identity_age_country',
      'identity_age_country_capacity'
    )
    or (v_policy.effective_from is not null and v_policy.effective_from > now())
    or (
      v_policy.effective_until is not null
      and v_policy.effective_until <= now()
    )
  then
    raise exception 'Didit KYC policy is unavailable'
      using errcode = 'P0001';
  end if;
  if v_disclosure is distinct from v_policy.disclosure_version then
    raise exception 'capacity consent version is not current'
      using errcode = 'P0001';
  end if;
  if v_account.terms_version_accepted
      is distinct from v_policy.terms_version
    or v_account.disclosure_version_accepted
      is distinct from v_policy.disclosure_version
  then
    raise exception 'accepted Partners terms are not current'
      using errcode = 'P0001';
  end if;

  select attempt_policy.*
  into v_attempt_policy
  from affiliate_private.affiliate_kyc_attempt_policies attempt_policy
  where attempt_policy.country_policy_id = v_policy.id
    and attempt_policy.status = 'active';
  if not found then
    raise exception 'KYC attempt policy is unavailable'
      using errcode = 'P0001';
  end if;

  select exists (
    select 1
    from affiliate_private.affiliate_kyc_sessions session
    where session.account_id = v_account.id
      and session.status = 'pending'
      and (session.expires_at is null or session.expires_at > now())
  )
  into v_has_pending;

  update affiliate_private.affiliate_kyc_session_reservations reservation
  set status = 'expired', updated_at = now()
  where reservation.account_id = v_account.id
    and reservation.status = 'reserved'
    and reservation.expires_at <= now();

  if v_has_pending or exists (
    select 1
    from affiliate_private.affiliate_kyc_session_reservations reservation
    where reservation.account_id = v_account.id
      and reservation.status = 'reserved'
      and reservation.expires_at > now()
  ) then
    raise exception 'KYC session creation is already in progress'
      using errcode = 'P0004';
  end if;

  select
    (
      select count(*)
      from affiliate_private.affiliate_kyc_session_reservations reservation
      where reservation.account_id = v_account.id
        and reservation.created_at >= now()
          - make_interval(secs => v_attempt_policy.window_seconds)
    ) + (
      select count(*)
      from affiliate_private.affiliate_kyc_sessions session
      where session.account_id = v_account.id
        and session.created_at >= now()
          - make_interval(secs => v_attempt_policy.window_seconds)
        and not exists (
          select 1
          from affiliate_private.affiliate_kyc_session_reservations reservation
          where reservation.bound_session_id = session.id
        )
    ),
    (
      select max(session.updated_at)
      from affiliate_private.affiliate_kyc_sessions session
      where session.account_id = v_account.id
        and session.status in (
          'verified', 'failed', 'expired', 'superseded'
        )
    )
  into v_attempt_count, v_last_terminal_at;

  v_attempt_limit_overridden :=
    v_attempt_count >= v_attempt_policy.max_attempts;
  v_cooldown_overridden := v_last_terminal_at is not null
    and v_last_terminal_at
      + make_interval(secs => v_attempt_policy.cooldown_seconds) > now();

  -- The grant bypasses only the historical count and terminal cooldown. All
  -- in-progress, policy, contract, consent and release-gate checks above and
  -- below remain authoritative.
  if not coalesce((
    select flag.enabled
    from public.admin_feature_flags flag
    where flag.key = 'partners_enabled'
  ), false)
    or not affiliate_private.release_gates_satisfied(
      array[
        'legal_and_tax_approved',
        'privacy_approved',
        'individual_verification_coverage_confirmed',
        'country_policy_approved'
      ]::text[]
    )
  then
    raise exception 'KYC release gates are incomplete'
      using errcode = 'P0001';
  end if;

  insert into affiliate_private.affiliate_capacity_attestations (
    account_id,
    consent_version,
    capacity_attested
  ) values (
    v_account.id,
    v_disclosure,
    true
  )
  on conflict (account_id, consent_version) do nothing;

  insert into affiliate_private.affiliate_kyc_session_reservations (
    account_id
  ) values (v_account.id)
  returning * into v_reservation;

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
      v_reservation.reservation_key,
      v_disclosure,
      v_biometric_consent
    )
  on conflict (account_id, idempotency_key) do nothing
  returning id into v_inserted_consent_id;

  if v_inserted_consent_id is null then
    select consent.*
    into v_existing_consent
    from affiliate_private.affiliate_biometric_consent_attestations consent
    where consent.account_id = v_account.id
      and consent.idempotency_key = p_idempotency_key;
    if not found
      or v_existing_consent.reservation_key
        <> v_reservation.reservation_key
      or v_existing_consent.disclosure_version <> v_disclosure
      or v_existing_consent.biometric_consent_version
        <> v_biometric_consent
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
          extensions.digest(v_reservation.reservation_key, 'sha256'),
          'hex'
        )
      )
    );
  end if;

  perform set_config(
    'norva.partners_kyc_reverification_grant_control',
    'consume',
    true
  );
  update affiliate_private.affiliate_kyc_reverification_grants grant_row
  set
    consumed_at = now(),
    reservation_key_sha256 = encode(
      extensions.digest(v_reservation.reservation_key, 'sha256'),
      'hex'
    )
  where grant_row.id = v_grant.id
    and grant_row.consumed_at is null;
  if not found then
    perform set_config(
      'norva.partners_kyc_reverification_grant_control',
      '',
      true
    );
    raise exception 'one-time KYC re-verification was already consumed'
      using errcode = 'P0004';
  end if;
  perform set_config(
    'norva.partners_kyc_reverification_grant_control',
    '',
    true
  );

  v_response := jsonb_build_object(
    'schema_version', 1,
    'action', 'kyc_ready',
    'replayed', false,
    'account', jsonb_build_object(
      'id', affiliate_private.partners_public_account_id(v_account),
      'status', v_account.status
    ),
    'kyc', jsonb_build_object(
      'provider', 'didit',
      'readiness', 'ready',
      'minimum_age', v_policy.minimum_age,
      'country_code', v_policy.country_code,
      'capacity_required', v_policy.capacity_required,
      'reservation_key', v_reservation.reservation_key,
      'reservation_expires_at', v_reservation.expires_at,
      'biometric_consent_version', v_biometric_consent
    )
  );

  insert into affiliate_private.affiliate_events (
    aggregate_type,
    aggregate_key,
    action,
    actor_type,
    actor_pseudonym,
    justification,
    after_state
  ) values
  (
    'kyc',
    v_account.id::text,
    'kyc_capacity_attested',
    'service',
    v_account.user_pseudonym,
    'User affirmed the versioned individual-capacity statement.',
    jsonb_build_object(
      'capacity_attested', true,
      'consent_version', v_disclosure
    )
  ),
  (
    'kyc',
    v_review_key,
    'kyc_human_review_reverification_consumed',
    'service',
    v_account.user_pseudonym,
    'One reviewed KYC re-verification right was consumed atomically.',
    jsonb_build_object(
      'attempt_limit_overridden', v_attempt_limit_overridden,
      'cooldown_overridden', v_cooldown_overridden,
      'reservation_key_sha256', encode(
        extensions.digest(v_reservation.reservation_key, 'sha256'),
        'hex'
      )
    )
  );

  perform affiliate_private.partners_store_response(
    'kyc_prepare',
    p_user_id,
    p_idempotency_key,
    v_request_hash,
    v_response
  );
  return v_response;
end;
$$;

create or replace function affiliate_private.partners_service_kyc_prepare_v2(
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
  v_has_reverification_grant boolean := false;
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

  if found then
    select exists (
      select 1
      from affiliate_private.affiliate_kyc_reverification_grants grant_row
      join affiliate_private.affiliate_kyc_human_review_requests review
        on review.id = grant_row.review_id
      where grant_row.account_id = v_account_id
        and grant_row.consumed_at is null
        and review.status = 'resolved'
        and review.resolution = 'reverification_available'
    ) into v_has_reverification_grant;
  end if;

  if v_has_reverification_grant then
    return
      affiliate_private
        .partners_service_kyc_prepare_reverification_once_v2(
          p_user_id,
          p_idempotency_key,
          p_disclosure_version,
          p_biometric_consent_version,
          p_capacity_attested,
          p_language
        );
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

alter function affiliate_private.admin_partners_kyc_human_review_decide(
  text, text, text, timestamptz, text, text
) rename to
  admin_partners_kyc_human_review_decide_pre_reverification_grant_20260804;

revoke all on function
  affiliate_private
    .admin_partners_kyc_human_review_decide_pre_reverification_grant_20260804(
      text, text, text, timestamptz, text, text
    )
  from public, anon, authenticated, service_role;

create function affiliate_private.admin_partners_kyc_human_review_decide(
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
  v_review
    affiliate_private.affiliate_kyc_human_review_requests%rowtype;
  v_actor text;
  v_response jsonb;
begin
  perform affiliate_private.partners_require_capability('risk');
  perform affiliate_private.partners_require_aal2(
    'Partners KYC human-review decision'
  );

  if v_action = 'resolve_reverification' then
    if v_key !~ '^khr_[0-9a-f]{24}$' then
      raise exception 'invalid KYC human-review decision'
        using errcode = '22023';
    end if;

    select review.*
    into v_review
    from affiliate_private.affiliate_kyc_human_review_requests review
    join affiliate_private.affiliate_accounts account
      on account.id = review.account_id
    where review.review_key = v_key
    for update of review, account;
    if not found then
      raise exception 'KYC human-review request was not found'
        using errcode = 'P0002';
    end if;
    if exists (
      select 1
      from affiliate_private.affiliate_biometric_consent_withdrawals withdrawal
      where withdrawal.account_id = v_review.account_id
    ) then
      raise exception 'biometric consent was withdrawn'
        using errcode = 'P0001';
    end if;
    if exists (
      select 1
      from affiliate_private.affiliate_kyc_reverification_grants grant_row
      where grant_row.account_id = v_review.account_id
        and grant_row.consumed_at is null
    ) then
      raise exception 'one-time KYC re-verification is already available'
        using errcode = 'P0004';
    end if;
  end if;

  v_response :=
    affiliate_private
      .admin_partners_kyc_human_review_decide_pre_reverification_grant_20260804(
        p_review_key,
        p_action,
        p_evidence_sha256,
        p_evidence_observed_at,
        p_confirmation,
        p_justification
      );

  if v_action <> 'resolve_reverification' then
    return v_response;
  end if;

  select review.*
  into strict v_review
  from affiliate_private.affiliate_kyc_human_review_requests review
  where review.review_key = v_key
    and review.status = 'resolved'
    and review.resolution = 'reverification_available'
  for update;

  v_actor := affiliate_private.partners_admin_actor_pseudonym();
  insert into affiliate_private.affiliate_kyc_reverification_grants (
    review_id,
    account_id,
    issued_by_pseudonym
  ) values (
    v_review.id,
    v_review.account_id,
    v_actor
  );

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
    'kyc_human_review_reverification_granted',
    'admin',
    v_actor,
    btrim(p_justification),
    jsonb_build_object(
      'available', true,
      'single_use', true,
      'ordinary_attempt_policy_unchanged', true
    )
  );

  return jsonb_set(
    v_response,
    '{review,reverification_granted}',
    'true'::jsonb,
    true
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
  affiliate_private.guard_kyc_reverification_grant_mutation()
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.partners_service_kyc_prepare_reverification_once_v2(
    uuid, text, text, text, boolean, text
  ) from public, anon, authenticated, service_role;
revoke all on function affiliate_private.partners_service_kyc_prepare_v2(
  uuid, text, text, text, boolean, text
) from public, anon, authenticated, service_role;
grant execute on function affiliate_private.partners_service_kyc_prepare_v2(
  uuid, text, text, text, boolean, text
) to service_role;
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
  affiliate_private.affiliate_kyc_reverification_grants is
  'Private, one-shot KYC re-verification rights issued only by a Risk+AAL2 human-review resolution and atomically consumed by canonical prepare_v2.';
comment on function
  affiliate_private.partners_service_kyc_prepare_reverification_once_v2(
    uuid, text, text, text, boolean, text
  ) is
  'Owner-only prepare path that bypasses only max-attempt and cooldown checks for one locked human-review grant; it preserves all other KYC policy and consent checks.';

reset lock_timeout;
reset statement_timeout;
