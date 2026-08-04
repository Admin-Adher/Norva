-- Authoritative payout-country binding and frictionless member links.
--
-- A confirmed member may join and share without KYC. Cash remains a separate,
-- fail-closed journey: the member must explicitly choose an ISO-3166 alpha-2
-- country backed by the accepted program, an active Didit policy and an active
-- Revolut manual corridor. No IP, locale, profile or fiscal value is inferred.

set statement_timeout = '60s';
set lock_timeout = '10s';

alter default privileges in schema affiliate_private
  revoke execute on functions from public;

-- Add the cash-country mutation to the service idempotency allowlist without
-- weakening any operation installed by the immediately preceding migration.
alter table affiliate_private.affiliate_service_idempotency
  add constraint affiliate_service_idempotency_operation_v4
  check (
    operation in (
      'application',
      'terms_acceptance',
      'link_rotation',
      'referral_claim',
      'membership_join',
      'access_credit_quote',
      'access_credit_redeem',
      'payout_country_bind'
    )
  ) not valid;
alter table affiliate_private.affiliate_service_idempotency
  validate constraint affiliate_service_idempotency_operation_v4;
alter table affiliate_private.affiliate_service_idempotency
  drop constraint affiliate_service_idempotency_operation;
alter table affiliate_private.affiliate_service_idempotency
  rename constraint affiliate_service_idempotency_operation_v4
  to affiliate_service_idempotency_operation;

create index if not exists affiliate_service_idempotency_country_bind_idx
  on affiliate_private.affiliate_service_idempotency (
    operation,
    created_at,
    user_id
  )
  where operation = 'payout_country_bind';

-- One ordered cash-readiness matrix is shared by join, bootstrap, dashboard
-- and the country-binding response. Membership and access credits remain
-- independent from every cash prerequisite below.
create or replace function affiliate_private.partners_cash_readiness(
  p_account_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_account affiliate_private.affiliate_accounts%rowtype;
  v_program_ready boolean := false;
  v_policy_ready boolean := false;
  v_kyc_ready boolean := false;
  v_fiscal_ready boolean := false;
  v_corridor_ready boolean := false;
  v_cash_pilot_allowlist_only boolean := true;
  v_cash_pilot_allowed boolean := false;
  v_ready boolean := false;
  v_reason text;
begin
  if p_account_id is null then
    return jsonb_build_object(
      'ready', false,
      'reason', 'membership_required'
    );
  end if;

  select account.*
  into v_account
  from affiliate_private.affiliate_accounts account
  where account.id = p_account_id;
  if not found then
    return jsonb_build_object(
      'ready', false,
      'reason', 'membership_required'
    );
  end if;

  select exists (
    select 1
    from affiliate_private.affiliate_program_versions program
    where program.id = v_account.program_version_id
      and program.id = v_account.member_program_version_id
      and program.status = 'active'
      and program.account_type = 'individual'
      and program.commission_rate_bps = 2000
      and program.attribution_window_days = 30
      and program.maturation_days = 45
      and program.effective_from <= now()
      and (
        program.effective_until is null
        or program.effective_until > now()
      )
      and program.terms_version = v_account.member_terms_version_accepted
      and program.disclosure_version =
        v_account.member_disclosure_version_accepted
  ) into v_program_ready;

  select exists (
    select 1
    from affiliate_private.affiliate_country_policies policy
    join affiliate_private.affiliate_program_versions program
      on program.id = policy.program_version_id
    where policy.id = v_account.country_policy_id
      and program.id = v_account.program_version_id
      and policy.country_code = v_account.country_code
      and policy.subdivision_code is not distinct from
        v_account.subdivision_code
      and policy.individual_available
      and policy.verification_provider = 'didit'
      and policy.terms_version = v_account.member_terms_version_accepted
      and policy.disclosure_version =
        v_account.member_disclosure_version_accepted
      and (
        policy.effective_from is null
        or policy.effective_from <= now()
      )
      and (
        policy.effective_until is null
        or policy.effective_until > now()
      )
      and affiliate_private.payout_currencies_covered(
        program.payout_thresholds,
        policy.payout_currencies
      )
      and exists (
        select 1
        from affiliate_private.affiliate_kyc_attempt_policies attempt_policy
        where attempt_policy.country_policy_id = policy.id
          and attempt_policy.status = 'active'
      )
  ) into v_policy_ready;

  select coalesce(flag.enabled, true)
  into v_cash_pilot_allowlist_only
  from public.admin_feature_flags flag
  where flag.key = 'partners_cash_pilot_allowlist_only';
  v_cash_pilot_allowlist_only := coalesce(
    v_cash_pilot_allowlist_only,
    true
  );
  v_cash_pilot_allowed := not v_cash_pilot_allowlist_only or exists (
    select 1
    from affiliate_private.affiliate_pilot_allowlist allowlist_row
    where allowlist_row.user_id = v_account.user_id
      and allowlist_row.status = 'active'
      and (
        allowlist_row.expires_at is null
        or allowlist_row.expires_at > now()
      )
      and (
        v_account.country_code is null
        or allowlist_row.country_code is null
        or allowlist_row.country_code = v_account.country_code
      )
      and allowlist_row.subdivision_code is null
  );

  v_kyc_ready :=
    v_account.status = 'active'
    and v_account.verification_status = 'verified'
    and v_account.verification_provider = 'didit'
    and nullif(btrim(v_account.verification_reference), '') is not null
    and v_account.age_verified
    and exists (
      select 1
      from affiliate_private.affiliate_country_policies policy
      where policy.id = v_account.country_policy_id
        and (not policy.capacity_required or v_account.capacity_verified)
    );

  select exists (
    select 1
    from affiliate_private.affiliate_fiscal_profiles fiscal
    where fiscal.account_id = v_account.id
      and fiscal.status = 'verified'
      and fiscal.residence_country_code = v_account.country_code
  ) into v_fiscal_ready;

  select exists (
    select 1
    from affiliate_private.affiliate_payout_profiles profile
    join affiliate_private.affiliate_payout_provider_configs route
      on route.provider = profile.provider
      and route.country_code = v_account.country_code
      and route.currency = profile.currency
    join affiliate_private.affiliate_currency_metadata currency_metadata
      on currency_metadata.currency_code = profile.currency
      and currency_metadata.status = 'active'
    where profile.account_id = v_account.id
      and profile.provider = 'revolut'
      and profile.status = 'active'
      and route.status = 'active'
      and route.execution_adapter = 'revolut_manual'
  ) into v_corridor_ready;

  v_ready :=
    v_account.member_status = 'active'
    and v_cash_pilot_allowed
    and v_program_ready
    and v_policy_ready
    and v_kyc_ready
    and v_fiscal_ready
    and v_corridor_ready;

  v_reason := case
    when v_account.member_status in ('held', 'suspended', 'closed')
      or v_account.status in ('held', 'suspended', 'closed')
      then 'account_blocked'
    when v_account.member_status <> 'active' then 'membership_required'
    when not v_cash_pilot_allowed then 'cash_pilot_not_allowed'
    when v_account.country_code is null
      or v_account.program_version_id is null
      or v_account.country_policy_id is null
      or not v_program_ready
      or not v_policy_ready
      then 'payout_country_required'
    when not v_kyc_ready then 'kyc_required'
    when not v_fiscal_ready then 'fiscal_profile_required'
    when not v_corridor_ready then 'corridor_required'
    else null
  end;

  return jsonb_build_object('ready', v_ready, 'reason', v_reason);
end;
$$;

-- Didit is a cash-payout prerequisite, never a prerequisite for joining,
-- sharing or redeeming Norva access credits. The canonical v2 prepare RPC is
-- guarded before its replay, reservation and provider-session side effects so
-- legacy pre-membership accounts cannot enter KYC through either normal or
-- human-approved reverification branches.
create or replace function
affiliate_private.partners_assert_kyc_cash_eligibility(p_user_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_account affiliate_private.affiliate_accounts%rowtype;
  v_program affiliate_private.affiliate_program_versions%rowtype;
  v_policy affiliate_private.affiliate_country_policies%rowtype;
  v_cash_pilot_allowlist_only boolean := true;
begin
  perform pg_advisory_xact_lock(
    hashtextextended('norva:partners:user:' || p_user_id::text, 0)
  );

  select account.*
  into v_account
  from affiliate_private.affiliate_accounts account
  where account.user_id = p_user_id
    and account.status <> 'closed'
  for update;

  if not found
    or v_account.member_status <> 'active'
    or v_account.status in ('held', 'suspended', 'closed')
    or v_account.member_program_version_id is null
    or v_account.member_terms_version_accepted is null
    or v_account.member_terms_accepted_at is null
    or v_account.member_disclosure_version_accepted is null
    or v_account.member_disclosure_accepted_at is null
  then
    raise exception 'Partners membership is required for KYC'
      using errcode = 'P1001';
  end if;

  if v_account.status not in ('pending_verification', 'active')
    or v_account.country_code is null
    or v_account.program_version_id is null
    or v_account.country_policy_id is null
    or v_account.program_version_id
      <> v_account.member_program_version_id
    or v_account.contract_status <> 'accepted'
    or v_account.terms_version_accepted
      is distinct from v_account.member_terms_version_accepted
    or v_account.disclosure_version_accepted
      is distinct from v_account.member_disclosure_version_accepted
  then
    raise exception 'payout country is unavailable'
      using errcode = 'P1007';
  end if;

  select program.*
  into v_program
  from affiliate_private.affiliate_program_versions program
  where program.id = v_account.member_program_version_id;
  select policy.*
  into v_policy
  from affiliate_private.affiliate_country_policies policy
  where policy.id = v_account.country_policy_id;

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
    or v_policy.country_code <> v_account.country_code
    or v_policy.subdivision_code is not null
    or not v_policy.individual_available
    or v_policy.verification_provider <> 'didit'
    or v_policy.terms_version
      is distinct from v_account.member_terms_version_accepted
    or v_policy.disclosure_version
      is distinct from v_account.member_disclosure_version_accepted
    or (v_policy.effective_from is not null and v_policy.effective_from > now())
    or (
      v_policy.effective_until is not null
      and v_policy.effective_until <= now()
    )
    or not affiliate_private.payout_currencies_covered(
      v_program.payout_thresholds,
      v_policy.payout_currencies
    )
    or not exists (
      select 1
      from affiliate_private.affiliate_kyc_attempt_policies attempt_policy
      where attempt_policy.country_policy_id = v_policy.id
        and attempt_policy.status = 'active'
    )
    or not exists (
      select 1
      from unnest(v_policy.payout_currencies) currency(code)
      join affiliate_private.affiliate_currency_metadata metadata
        on metadata.currency_code = currency.code
        and metadata.status = 'active'
      join affiliate_private.affiliate_payout_provider_configs route
        on route.provider = 'revolut'
        and route.country_code = v_account.country_code
        and route.currency = currency.code
        and route.status = 'active'
        and route.execution_adapter = 'revolut_manual'
    )
  then
    raise exception 'payout country is unavailable'
      using errcode = 'P1007';
  end if;

  select coalesce(flag.enabled, true)
  into v_cash_pilot_allowlist_only
  from public.admin_feature_flags flag
  where flag.key = 'partners_cash_pilot_allowlist_only';
  if coalesce(v_cash_pilot_allowlist_only, true) and not exists (
    select 1
    from affiliate_private.affiliate_pilot_allowlist allowlist_row
    where allowlist_row.user_id = p_user_id
      and allowlist_row.status = 'active'
      and (
        allowlist_row.expires_at is null
        or allowlist_row.expires_at > now()
      )
      and (
        allowlist_row.country_code is null
        or allowlist_row.country_code = v_account.country_code
      )
      and allowlist_row.subdivision_code is null
  ) then
    raise exception 'payout country is unavailable'
      using errcode = 'P1007';
  end if;
end;
$$;

do $partners_kyc_cash_only_guard$
declare
  v_signature constant text :=
    'affiliate_private.partners_service_kyc_prepare_v2(uuid,text,text,text,boolean,text)';
  v_oid regprocedure;
  v_definition text;
  v_expected constant text := E'begin\n  select account.id';
  v_replacement constant text := $replacement$begin
  -- Keep the public v2 input contract ahead of every account read and cash
  -- eligibility check. The delegated normal/re-verification implementations
  -- validate the same values, but doing it here preserves the fail-fast
  -- biometric-consent boundary after this dispatch wrapper is guarded.
  if p_user_id is null
    or p_idempotency_key is null
    or p_idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$'
    or lower(btrim(coalesce(p_disclosure_version, '')))
      !~ '^[a-z0-9][a-z0-9._-]{2,63}$'
    or lower(btrim(coalesce(p_biometric_consent_version, '')))
      <> 'partners-biometric-consent-v1'
    or lower(btrim(coalesce(p_language, ''))) !~ '^[a-z]{2}$'
    or p_capacity_attested is distinct from true
  then
    raise exception 'invalid versioned biometric consent'
      using errcode = '22023';
  end if;

  perform affiliate_private.partners_assert_kyc_cash_eligibility(p_user_id);

  select account.id$replacement$;
begin
  v_oid := to_regprocedure(v_signature);
  if v_oid is null then
    raise exception 'required canonical Partners KYC routine is unavailable'
      using errcode = '55000';
  end if;
  select pg_get_functiondef(v_oid::oid) into v_definition;
  if position(
    'partners_assert_kyc_cash_eligibility' in lower(v_definition)
  ) > 0 then
    raise exception 'canonical Partners KYC routine was already rewritten'
      using errcode = '55000';
  end if;
  if position(v_expected in v_definition) = 0 then
    raise exception 'canonical Partners KYC routine contract drifted'
      using errcode = '55000';
  end if;
  execute replace(v_definition, v_expected, v_replacement);
end;
$partners_kyc_cash_only_guard$;

-- Legacy verified accounts must not bypass the cash-pilot boundary through a
-- later fiscal or payout-onboarding entry point. Reuse the same authoritative
-- membership/country/corridor/allowlist guard before replay or mutation.
do $partners_fiscal_cash_only_guard$
declare
  v_oid regprocedure;
  v_definition text;
  v_expected constant text := $expected$
  perform pg_advisory_xact_lock(
    hashtextextended('norva:partners:user:' || p_user_id::text, 0)
  );
  v_request_hash := encode($expected$;
  v_replacement constant text := $replacement$
  perform affiliate_private.partners_assert_kyc_cash_eligibility(p_user_id);

  perform pg_advisory_xact_lock(
    hashtextextended('norva:partners:user:' || p_user_id::text, 0)
  );
  v_request_hash := encode($replacement$;
begin
  v_oid := to_regprocedure(
    'affiliate_private.partners_service_fiscal_profile_self_attest(uuid,text,text,boolean,text)'
  );
  if v_oid is null then
    raise exception 'required fiscal self-attestation routine is unavailable'
      using errcode = '55000';
  end if;
  select pg_get_functiondef(v_oid::oid) into v_definition;
  if position('partners_assert_kyc_cash_eligibility' in lower(v_definition)) > 0
    or position(v_expected in v_definition) = 0
  then
    raise exception 'fiscal self-attestation routine contract drifted'
      using errcode = '55000';
  end if;
  execute replace(v_definition, v_expected, v_replacement);
end;
$partners_fiscal_cash_only_guard$;

do $partners_onboarding_cash_only_guard$
declare
  v_oid regprocedure;
  v_definition text;
  v_expected constant text := $expected$
  perform pg_advisory_xact_lock(
    hashtextextended('norva:partners:user:' || p_user_id::text, 0)
  );
  v_request_hash := encode($expected$;
  v_replacement constant text := $replacement$
  perform affiliate_private.partners_assert_kyc_cash_eligibility(p_user_id);

  perform pg_advisory_xact_lock(
    hashtextextended('norva:partners:user:' || p_user_id::text, 0)
  );
  v_request_hash := encode($replacement$;
begin
  v_oid := to_regprocedure(
    'affiliate_private.partners_service_payout_onboarding_request(uuid,text,boolean,text)'
  );
  if v_oid is null then
    raise exception 'required payout-onboarding routine is unavailable'
      using errcode = '55000';
  end if;
  select pg_get_functiondef(v_oid::oid) into v_definition;
  if position('partners_assert_kyc_cash_eligibility' in lower(v_definition)) > 0
    or position(v_expected in v_definition) = 0
  then
    raise exception 'payout-onboarding routine contract drifted'
      using errcode = '55000';
  end if;
  execute replace(v_definition, v_expected, v_replacement);
end;
$partners_onboarding_cash_only_guard$;

-- Batch preparation is the final manual-cash boundary. Hold the same release
-- lock used by allowlist mutations and reject a cycle containing any legacy,
-- non-member or non-allowlisted account before a batch/execution is created.
do $partners_manual_batch_cash_only_guard$
declare
  v_oid regprocedure;
  v_definition text;
  v_lock_expected constant text := $expected$
  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:payout-approval-configuration',
      0
    )
  );$expected$;
  v_lock_replacement constant text := $replacement$
  perform pg_advisory_xact_lock(
    hashtextextended('norva:partners:release-control', 0)
  );
  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:payout-approval-configuration',
      0
    )
  );$replacement$;
  v_batch_expected constant text := $expected$
  select batch.*
  into v_batch
  from affiliate_private.affiliate_revolut_manual_batches batch$expected$;
  v_batch_replacement constant text := $replacement$
  if coalesce((
    select flag.enabled
    from public.admin_feature_flags flag
    where flag.key = 'partners_cash_pilot_allowlist_only'
  ), true) and exists (
    select 1
    from affiliate_private.affiliate_payout_items item
    join affiliate_private.affiliate_accounts account
      on account.id = item.account_id
    where item.cycle_id = v_cycle.id
      and (
        account.member_status <> 'active'
        or not exists (
          select 1
          from affiliate_private.affiliate_pilot_allowlist allowlist_row
          where allowlist_row.user_id = account.user_id
            and allowlist_row.status = 'active'
            and (
              allowlist_row.expires_at is null
              or allowlist_row.expires_at > now()
            )
            and (
              allowlist_row.country_code is null
              or allowlist_row.country_code = account.country_code
            )
            and allowlist_row.subdivision_code is null
        )
      )
  ) then
    raise exception 'payout cycle contains an account outside the cash pilot'
      using errcode = 'P0001';
  end if;

  select batch.*
  into v_batch
  from affiliate_private.affiliate_revolut_manual_batches batch$replacement$;
begin
  v_oid := to_regprocedure(
    'affiliate_private.admin_partners_revolut_manual_batch_prepare(text,text,text)'
  );
  if v_oid is null then
    raise exception 'required manual payout batch routine is unavailable'
      using errcode = '55000';
  end if;
  select pg_get_functiondef(v_oid::oid) into v_definition;
  if position('partners_cash_pilot_allowlist_only' in lower(v_definition)) > 0
    or position(v_lock_expected in v_definition) = 0
    or position(v_batch_expected in v_definition) = 0
  then
    raise exception 'manual payout batch routine contract drifted'
      using errcode = '55000';
  end if;
  v_definition := replace(
    v_definition,
    v_lock_expected,
    v_lock_replacement
  );
  v_definition := replace(
    v_definition,
    v_batch_expected,
    v_batch_replacement
  );
  execute v_definition;
end;
$partners_manual_batch_cash_only_guard$;

create or replace function
affiliate_private.partners_service_payout_country_bind(
  p_user_id uuid,
  p_country_code text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_country text := upper(btrim(coalesce(p_country_code, '')));
  v_request_hash text;
  v_replay jsonb;
  v_response jsonb;
  v_account affiliate_private.affiliate_accounts%rowtype;
  v_policy affiliate_private.affiliate_country_policies%rowtype;
  v_program affiliate_private.affiliate_program_versions%rowtype;
  v_latest_session affiliate_private.affiliate_kyc_sessions%rowtype;
  v_cash_pilot_allowlist_only boolean := true;
  v_country_changed boolean := false;
  v_previous_country text;
  v_now timestamptz := clock_timestamp();
  v_cash_readiness jsonb;
begin
  if p_user_id is null
    or v_country !~ '^[A-Z]{2}$'
    or p_idempotency_key is null
    or p_idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$'
  then
    raise exception 'invalid payout country request'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('norva:partners:user:' || p_user_id::text, 0)
  );

  v_request_hash := encode(
    extensions.digest(
      concat_ws(chr(31), 'payout_country_bind:v1', p_user_id::text, v_country),
      'sha256'
    ),
    'hex'
  );
  v_replay := affiliate_private.partners_replayed_response(
    'payout_country_bind',
    p_user_id,
    p_idempotency_key,
    v_request_hash
  );
  if v_replay is not null then
    return v_replay;
  end if;

  perform 1
  from auth.users cloud_user
  where cloud_user.id = p_user_id
    and cloud_user.email_confirmed_at is not null
  for share;
  if not found then
    raise exception 'confirmed Cloud user is required'
      using errcode = 'P0001';
  end if;

  if not coalesce((
    select flag.enabled
    from public.admin_feature_flags flag
    where flag.key = 'partners_enabled'
  ), false)
  then
    raise exception 'Partners cash journey is disabled'
      using errcode = 'P0001';
  end if;

  select account.*
  into v_account
  from affiliate_private.affiliate_accounts account
  where account.user_id = p_user_id
    and account.status <> 'closed'
  for update;
  if not found or v_account.member_status <> 'active' then
    raise exception 'active Partners membership is required'
      using errcode = 'P1001';
  end if;
  if v_account.member_status in ('held', 'suspended', 'closed')
    or v_account.status in ('held', 'suspended', 'closed')
  then
    raise exception 'Partners cash journey is unavailable'
      using errcode = 'P0001';
  end if;
  v_previous_country := v_account.country_code;

  select program.*
  into v_program
  from affiliate_private.affiliate_program_versions program
  where program.id = v_account.member_program_version_id
    and program.status = 'active'
    and program.account_type = 'individual'
    and program.commission_rate_bps = 2000
    and program.attribution_window_days = 30
    and program.maturation_days = 45
    and program.effective_from <= now()
    and (
      program.effective_until is null
      or program.effective_until > now()
    )
    and program.terms_version = v_account.member_terms_version_accepted
    and program.disclosure_version =
      v_account.member_disclosure_version_accepted
  for share;
  if not found then
    raise exception 'accepted Partners program is unavailable'
      using errcode = 'P1007';
  end if;

  select policy.*
  into v_policy
  from affiliate_private.affiliate_country_policies policy
  where policy.program_version_id = v_program.id
    and policy.country_code = v_country
    and policy.subdivision_code is null
    and policy.individual_available
    and policy.verification_provider = 'didit'
    and policy.terms_version = v_account.member_terms_version_accepted
    and policy.disclosure_version =
      v_account.member_disclosure_version_accepted
    and (
      policy.effective_from is null
      or policy.effective_from <= now()
    )
    and (
      policy.effective_until is null
      or policy.effective_until > now()
    )
    and affiliate_private.payout_currencies_covered(
      v_program.payout_thresholds,
      policy.payout_currencies
    )
    and exists (
      select 1
      from affiliate_private.affiliate_kyc_attempt_policies attempt_policy
      where attempt_policy.country_policy_id = policy.id
        and attempt_policy.status = 'active'
    )
    and exists (
      select 1
      from unnest(policy.payout_currencies) currency(code)
      join affiliate_private.affiliate_currency_metadata metadata
        on metadata.currency_code = currency.code
        and metadata.status = 'active'
      join affiliate_private.affiliate_payout_provider_configs route
        on route.provider = 'revolut'
        and route.country_code = policy.country_code
        and route.currency = currency.code
        and route.status = 'active'
        and route.execution_adapter = 'revolut_manual'
    )
  limit 1
  for share;
  if not found then
    raise exception 'payout country is unavailable'
      using errcode = 'P1007';
  end if;

  select coalesce(flag.enabled, true)
  into v_cash_pilot_allowlist_only
  from public.admin_feature_flags flag
  where flag.key = 'partners_cash_pilot_allowlist_only';
  v_cash_pilot_allowlist_only := coalesce(
    v_cash_pilot_allowlist_only,
    true
  );
  if v_cash_pilot_allowlist_only and not exists (
    select 1
    from affiliate_private.affiliate_pilot_allowlist pilot
    where pilot.user_id = p_user_id
      and pilot.status = 'active'
      and (pilot.expires_at is null or pilot.expires_at > now())
      and (pilot.country_code is null or pilot.country_code = v_country)
      and pilot.subdivision_code is null
  ) then
    raise exception 'payout country is unavailable for this pilot'
      using errcode = 'P1007';
  end if;

  v_country_changed := v_account.country_code is not null
    and v_account.country_code <> v_country;

  if v_country_changed then
    if v_account.status = 'active'
      or v_account.verification_status = 'verified'
    then
      raise exception 'verified payout country is immutable'
        using errcode = 'P0001';
    end if;

    if exists (
      select 1
      from affiliate_private.affiliate_kyc_session_reservations reservation
      where reservation.account_id = v_account.id
        and reservation.status = 'reserved'
        and reservation.expires_at > now()
    ) or exists (
      select 1
      from affiliate_private.affiliate_kyc_sessions session
      where session.account_id = v_account.id
        and session.status = 'pending'
    ) then
      raise exception 'finish the current verification before changing country'
        using errcode = 'P0004';
    end if;

    if exists (
      select 1
      from affiliate_private.affiliate_fiscal_profiles fiscal
      where fiscal.account_id = v_account.id
    ) or exists (
      select 1
      from affiliate_private.affiliate_payout_profiles profile
      where profile.account_id = v_account.id
    ) or exists (
      select 1
      from affiliate_private.affiliate_payout_onboarding_requests request
      where request.account_id = v_account.id
    ) then
      raise exception 'financial setup must be cleared before changing country'
        using errcode = 'P0001';
    end if;

    select session.*
    into v_latest_session
    from affiliate_private.affiliate_kyc_sessions session
    where session.account_id = v_account.id
    order by session.created_at desc, session.id desc
    limit 1;
    if found and not (
      v_latest_session.status in ('failed', 'expired', 'superseded')
      and v_latest_session.country_policy_match is false
    ) then
      raise exception 'country change requires a terminal country mismatch'
        using errcode = 'P0001';
    end if;
  end if;

  update affiliate_private.affiliate_accounts account
  set
    status = case
      when account.status = 'invited' then 'pending_verification'
      else account.status
    end,
    program_version_id = v_program.id,
    country_policy_id = v_policy.id,
    country_code = v_country,
    subdivision_code = null,
    verification_status = case
      when v_country_changed then 'not_started'
      else account.verification_status
    end,
    verification_provider = case
      when v_country_changed then null
      else account.verification_provider
    end,
    verification_reference = case
      when v_country_changed then null
      else account.verification_reference
    end,
    age_verified = case
      when v_country_changed then false
      else account.age_verified
    end,
    capacity_verified = case
      when v_country_changed then false
      else account.capacity_verified
    end,
    contract_status = 'accepted',
    terms_version_accepted = v_account.member_terms_version_accepted,
    contract_accepted_at = v_account.member_terms_accepted_at,
    disclosure_version_accepted =
      v_account.member_disclosure_version_accepted,
    disclosure_accepted_at = v_account.member_disclosure_accepted_at,
    updated_at = now()
  where account.id = v_account.id
  returning * into v_account;

  v_cash_readiness :=
    affiliate_private.partners_cash_readiness(v_account.id);

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
    'account',
    v_account.id::text,
    case when v_country_changed
      then 'payout_country_rebound'
      else 'payout_country_bound'
    end,
    'service',
    v_account.user_pseudonym,
    'Member explicitly selected the country for the cash payout journey.',
    jsonb_build_object(
      'country_code', v_previous_country
    ),
    jsonb_build_object(
      'country_code', v_account.country_code,
      'cash_readiness', v_cash_readiness
    )
  );

  v_response := jsonb_build_object(
    'schema_version', 1,
    'action', 'payout_country_bound',
    'replayed', false,
    'account', jsonb_build_object(
      'id', affiliate_private.partners_public_account_id(v_account),
      'status', v_account.status,
      'country_code', v_account.country_code
    ),
    'cash_readiness', v_cash_readiness
  );
  perform affiliate_private.partners_store_response(
    'payout_country_bind',
    p_user_id,
    p_idempotency_key,
    v_request_hash,
    v_response
  );
  return v_response;
end;
$$;

create or replace function public.partners_service_payout_country_bind(
  p_user_id uuid,
  p_country_code text,
  p_idempotency_key text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.partners_service_payout_country_bind(
    p_user_id,
    p_country_code,
    p_idempotency_key
  );
$$;

-- Member links are a core sharing capability. Their lifecycle is governed by
-- confirmed membership and the accepted program only; KYC, country, fiscal,
-- allowlist and payout release gates must never gate link creation/rotation.
create or replace function affiliate_private.partners_service_rotate_link(
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
  v_request_hash text;
  v_replay jsonb;
  v_response jsonb;
  v_account affiliate_private.affiliate_accounts%rowtype;
  v_program affiliate_private.affiliate_program_versions%rowtype;
  v_old_link affiliate_private.affiliate_links%rowtype;
  v_new_link affiliate_private.affiliate_links%rowtype;
begin
  if p_user_id is null
    or p_idempotency_key is null
    or p_idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$'
  then
    raise exception 'invalid Partners link request'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('norva:partners:user:' || p_user_id::text, 0)
  );

  v_request_hash := encode(
    extensions.digest(
      'link_rotation:v1:' || p_user_id::text,
      'sha256'
    ),
    'hex'
  );
  v_replay := affiliate_private.partners_replayed_response(
    'link_rotation',
    p_user_id,
    p_idempotency_key,
    v_request_hash
  );
  if v_replay is not null then
    return v_replay;
  end if;

  perform 1
  from auth.users cloud_user
  where cloud_user.id = p_user_id
    and cloud_user.email_confirmed_at is not null
  for share;
  if not found then
    raise exception 'confirmed Cloud user is required'
      using errcode = 'P0001';
  end if;

  if not coalesce((
    select flag.enabled
    from public.admin_feature_flags flag
    where flag.key = 'partners_enabled'
  ), false)
  then
    raise exception 'Partners link management is disabled'
      using errcode = 'P0001';
  end if;

  select account.*
  into v_account
  from affiliate_private.affiliate_accounts account
  where account.user_id = p_user_id
    and account.status <> 'closed'
  for update;
  if not found or v_account.member_status <> 'active' then
    raise exception 'active Partners membership is required'
      using errcode = 'P1001';
  end if;
  if v_account.member_status in ('held', 'suspended', 'closed') then
    raise exception 'Partners link management is unavailable'
      using errcode = 'P0001';
  end if;

  select program.*
  into v_program
  from affiliate_private.affiliate_program_versions program
  where program.id = v_account.member_program_version_id
    and program.status = 'active'
    and program.account_type = 'individual'
    and program.commission_rate_bps = 2000
    and program.attribution_window_days = 30
    and program.maturation_days = 45
    and program.effective_from <= now()
    and (
      program.effective_until is null
      or program.effective_until > now()
    )
    and program.terms_version = v_account.member_terms_version_accepted
    and program.disclosure_version =
      v_account.member_disclosure_version_accepted
  for share;
  if not found then
    raise exception 'accepted Partners program is unavailable'
      using errcode = 'P0001';
  end if;

  select link.*
  into v_old_link
  from affiliate_private.affiliate_links link
  where link.account_id = v_account.id
    and link.status = 'active'
  for update;
  if found then
    update affiliate_private.affiliate_links link
    set status = 'revoked', revoked_at = now()
    where link.id = v_old_link.id;
  end if;

  insert into affiliate_private.affiliate_links (
    account_id,
    rotated_from_id,
    created_at
  ) values (
    v_account.id,
    v_old_link.id,
    case
      when v_old_link.id is null then clock_timestamp()
      else greatest(
        clock_timestamp(),
        v_old_link.created_at + interval '1 microsecond'
      )
    end
  )
  returning * into v_new_link;

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
    'account',
    v_account.id::text,
    case when v_old_link.id is null then 'link_created' else 'link_rotated' end,
    'service',
    v_account.user_pseudonym,
    'Authenticated member renewed the active Partners sharing link.',
    jsonb_build_object(
      'link_status', case when v_old_link.id is null then 'none' else 'active' end
    ),
    jsonb_build_object('link_status', 'active')
  );

  v_response := jsonb_build_object(
    'schema_version', 2,
    'action', 'link_rotated',
    'replayed', false,
    'membership', jsonb_build_object(
      'status', v_account.member_status,
      'joined_at', v_account.member_joined_at,
      'verification_status', v_account.verification_status
    ),
    'link', jsonb_build_object(
      'status', 'active',
      'share_url', 'https://norva.tv/r/' || v_new_link.public_code,
      'rotated_at', v_new_link.created_at
    ),
    'next_action', 'share_link'
  );
  perform affiliate_private.partners_store_response(
    'link_rotation',
    p_user_id,
    p_idempotency_key,
    v_request_hash,
    v_response
  );
  return v_response;
end;
$$;

-- The payout profile exposes the explicitly bound country and makes its
-- absence the first recoverable cash state. No fiscal or network value is used
-- as a fallback.
create or replace function
affiliate_private.partners_service_payout_profile_get(
  p_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_account affiliate_private.affiliate_accounts%rowtype;
  v_fiscal affiliate_private.affiliate_fiscal_profiles%rowtype;
  v_profile affiliate_private.affiliate_payout_profiles%rowtype;
  v_profiles jsonb := '[]'::jsonb;
  v_payouts_live boolean := false;
  v_ready boolean := false;
  v_reason text;
  v_cash_readiness jsonb;
begin
  if p_user_id is null then
    raise exception 'user id is required' using errcode = '22023';
  end if;
  select account.*
  into v_account
  from affiliate_private.affiliate_accounts account
  where account.user_id = p_user_id
    and account.status <> 'closed';
  if not found then
    raise exception 'Partners account is unavailable'
      using errcode = 'P0002';
  end if;

  select fiscal.*
  into v_fiscal
  from affiliate_private.affiliate_fiscal_profiles fiscal
  where fiscal.account_id = v_account.id;

  select profile.*
  into v_profile
  from affiliate_private.affiliate_payout_profiles profile
  where profile.account_id = v_account.id
  order by
    case when profile.status = 'active' and exists (
      select 1
      from affiliate_private.affiliate_payout_provider_configs route
      where route.provider = profile.provider
        and route.country_code = v_account.country_code
        and route.currency = profile.currency
        and route.status = 'active'
        and route.execution_adapter = 'revolut_manual'
    ) then 0 else 1 end,
    profile.currency,
    profile.id
  limit 1;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'provider', profile.provider,
      'display_masked', profile.display_masked,
      'currency', profile.currency,
      'status', profile.status
    ) order by profile.currency, profile.id
  ), '[]'::jsonb)
  into v_profiles
  from affiliate_private.affiliate_payout_profiles profile
  where profile.account_id = v_account.id;

  select coalesce(flag.enabled, false)
  into v_payouts_live
  from public.admin_feature_flags flag
  where flag.key = 'partners_payouts_live';
  v_payouts_live := coalesce(v_payouts_live, false);

  v_cash_readiness :=
    affiliate_private.partners_cash_readiness(v_account.id);
  v_ready := coalesce((v_cash_readiness ->> 'ready')::boolean, false)
    and v_payouts_live;
  v_reason := case
    when v_cash_readiness ->> 'reason' in (
      'account_blocked', 'membership_required'
    ) then 'account_not_active'
    when v_cash_readiness ->> 'reason' = 'cash_pilot_not_allowed'
      then 'cash_pilot_not_allowed'
    when v_cash_readiness ->> 'reason' = 'payout_country_required'
      then 'payout_country_required'
    when v_cash_readiness ->> 'reason' = 'kyc_required'
      then 'kyc_not_verified'
    when v_cash_readiness ->> 'reason' = 'fiscal_profile_required'
      then 'fiscal_profile_required'
    when v_cash_readiness ->> 'reason' = 'corridor_required'
      then 'provider_not_configured'
    when not v_payouts_live then 'payouts_not_live'
    else null
  end;

  return jsonb_build_object(
    'schema_version', 1,
    'account', jsonb_build_object(
      'id', affiliate_private.partners_public_account_id(v_account),
      'status', v_account.status,
      'country_code', v_account.country_code
    ),
    'fiscal', case when v_fiscal.account_id is null then null else
      jsonb_build_object(
        'status', v_fiscal.status,
        'country_code', v_fiscal.residence_country_code
      )
    end,
    'profile', case when v_profile.id is null then null else
      jsonb_build_object(
        'provider', v_profile.provider,
        'display_masked', v_profile.display_masked,
        'currency', v_profile.currency,
        'status', v_profile.status
      )
    end,
    'profiles', v_profiles,
    'readiness', jsonb_build_object(
      'ready', v_ready,
      'payouts_live', v_payouts_live,
      'reason', v_reason
    )
  );
end;
$$;

comment on function
  affiliate_private.partners_service_payout_country_bind(uuid, text, text)
is
  'Service-only explicit cash-country binding. Never infers jurisdiction and never changes membership or access credits.';
comment on function
  public.partners_service_payout_country_bind(uuid, text, text)
is
  'Invoker shim for the Partners Edge service role.';
comment on function
  affiliate_private.partners_service_rotate_link(uuid, text)
is
  'Rotates a sharing link for an active confirmed member without KYC or payout prerequisites.';
comment on function
  affiliate_private.partners_assert_kyc_cash_eligibility(uuid)
is
  'Owner-only fail-closed guard proving active membership, explicit payout country and one active Revolut manual corridor before canonical Didit preparation.';

revoke all on function
  affiliate_private.partners_cash_readiness(uuid)
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.partners_assert_kyc_cash_eligibility(uuid)
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.partners_service_payout_country_bind(uuid, text, text)
  from public, anon, authenticated;
grant execute on function
  affiliate_private.partners_service_payout_country_bind(uuid, text, text)
  to service_role;
revoke all on function
  affiliate_private.partners_service_rotate_link(uuid, text)
  from public, anon, authenticated;
grant execute on function
  affiliate_private.partners_service_rotate_link(uuid, text)
  to service_role;
revoke all on function
  affiliate_private.partners_service_payout_profile_get(uuid)
  from public, anon, authenticated;
grant execute on function
  affiliate_private.partners_service_payout_profile_get(uuid)
  to service_role;

revoke all on function
  public.partners_service_payout_country_bind(uuid, text, text)
  from public, anon, authenticated;
grant execute on function
  public.partners_service_payout_country_bind(uuid, text, text)
  to service_role;
revoke all on function public.partners_service_rotate_link(uuid, text)
  from public, anon, authenticated;
grant execute on function public.partners_service_rotate_link(uuid, text)
  to service_role;
revoke all on function public.partners_service_payout_profile_get(uuid)
  from public, anon, authenticated;
grant execute on function public.partners_service_payout_profile_get(uuid)
  to service_role;

reset lock_timeout;
reset statement_timeout;
