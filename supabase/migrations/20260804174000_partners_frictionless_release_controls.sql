-- Frictionless Partners release controls.
--
-- Joining and sharing are membership operations: they do not require KYC,
-- fiscal evidence, a payout profile or a live payout corridor. Commission
-- accrual and access-credit redemption remain separate, audited kill
-- switches. Cash and payout controls are deliberately delegated to the
-- existing implementation unchanged.

set statement_timeout = '60s';
set lock_timeout = '10s';

-- Membership privacy is intentionally distinct from the biometric/KYC cash
-- approval. Public joining therefore proves the published membership notice
-- and documented GDPR self-assessment without claiming that Didit is ready.
alter table affiliate_private.affiliate_release_gates
  drop constraint affiliate_release_gates_key;
alter table affiliate_private.affiliate_release_gates
  add constraint affiliate_release_gates_key
  check (
    gate_key in (
      'legal_and_tax_approved',
      'membership_privacy_approved',
      'privacy_approved',
      'individual_verification_coverage_confirmed',
      'individual_payout_coverage_confirmed',
      'country_policy_approved',
      'financial_data_contract_approved',
      'shadow_reconciliation_clean',
      'backup_restore_verified',
      'payout_execution_adapter_verified',
      'tv_relay_security_verified',
      'general_release_approved',
      'manual_payout_workflow_verified',
      'revolut_api_adapter_verified'
    )
  );

insert into affiliate_private.affiliate_release_gates (gate_key)
values ('membership_privacy_approved')
on conflict (gate_key) do nothing;

create or replace function
affiliate_private.partners_approval_required_document_keys(p_gate_key text)
returns text[]
language sql
immutable
parallel safe
set search_path = ''
as $$
  select array['approval_record', 'deployment_proof']::text[] || case p_gate_key
    when 'membership_privacy_approved' then
      array[
        'gdpr_self_assessment',
        'privacy_notice',
        'records_of_processing'
      ]
    when 'privacy_approved' then
      array[
        'dpia',
        'gdpr_self_assessment',
        'biometric_consent',
        'privacy_notice',
        'records_of_processing'
      ]
    when 'legal_and_tax_approved' then
      array['legal_tax_review', 'partners_terms']
    when 'individual_verification_coverage_confirmed' then
      array['kyc_certification']
    when 'individual_payout_coverage_confirmed' then
      array['payout_coverage_review']
    when 'country_policy_approved' then
      array['country_policy_review', 'payout_corridor_review']
    when 'financial_data_contract_approved' then
      array['financial_contract_test']
    when 'shadow_reconciliation_clean' then
      array['shadow_reconciliation_report']
    when 'backup_restore_verified' then
      array['restore_rehearsal_proof']
    when 'payout_execution_adapter_verified' then
      array['payout_execution_test']
    when 'manual_payout_workflow_verified' then
      array['manual_payout_runbook_test']
    when 'revolut_api_adapter_verified' then
      array['revolut_api_certification']
    when 'tv_relay_security_verified' then
      array['tv_relay_security_review']
    when 'general_release_approved' then
      array['release_readiness_report']
    else '{}'::text[]
  end;
$$;

revoke all on function
  affiliate_private.partners_approval_required_document_keys(text)
from public, anon, authenticated, service_role;

-- The programme contract governs public membership. Its approval scope must
-- therefore bind the membership privacy package, while country-policy/KYC
-- activation continues to bind the stronger Didit privacy package.
do $partners_program_membership_privacy_gate$
declare
  v_oid regprocedure := to_regprocedure(
    'affiliate_private.guard_partners_program_approved_scope()'
  );
  v_definition text;
  v_expected constant text :=
    'where binding.gate_key = ''privacy_approved''';
  v_replacement constant text :=
    'where binding.gate_key = ''membership_privacy_approved''';
begin
  if v_oid is null then
    raise exception 'required programme approval guard is unavailable'
      using errcode = '55000';
  end if;
  select replace(
    pg_get_functiondef(v_oid::oid),
    chr(13) || chr(10),
    chr(10)
  ) into v_definition;
  if position(v_replacement in v_definition) > 0
    or position(v_expected in v_definition) = 0
  then
    raise exception 'programme approval guard contract drifted'
      using errcode = '55000';
  end if;
  execute replace(v_definition, v_expected, v_replacement);
end;
$partners_program_membership_privacy_gate$;

do $partners_program_activation_membership_privacy_gate$
declare
  v_oid regprocedure := to_regprocedure(
    'affiliate_private.admin_partners_program_activate_pre_aal2_20260802(text,text,text)'
  );
  v_wrapper_oid regprocedure := to_regprocedure(
    'affiliate_private.admin_partners_program_activate(text,text,text)'
  );
  v_definition text;
  v_wrapper_definition text;
  v_expected constant text :=
    'array[''legal_and_tax_approved'', ''privacy_approved'']::text[]';
  v_replacement constant text :=
    'array[''legal_and_tax_approved'', ''membership_privacy_approved'']::text[]';
begin
  if v_oid is null or v_wrapper_oid is null then
    raise exception 'required programme activation routine is unavailable'
      using errcode = '55000';
  end if;
  select replace(
    pg_get_functiondef(v_wrapper_oid::oid),
    chr(13) || chr(10),
    chr(10)
  ) into v_wrapper_definition;
  if position(
    'admin_partners_program_activate_pre_aal2_20260802' in
    v_wrapper_definition
  ) = 0
    or position('partners_require_aal2' in v_wrapper_definition) = 0
  then
    raise exception 'programme activation AAL2 wrapper contract drifted'
      using errcode = '55000';
  end if;
  select replace(
    pg_get_functiondef(v_oid::oid),
    chr(13) || chr(10),
    chr(10)
  ) into v_definition;
  if position(v_replacement in v_definition) > 0
    or position(v_expected in v_definition) = 0
  then
    raise exception 'programme activation routine contract drifted'
      using errcode = '55000';
  end if;
  execute replace(v_definition, v_expected, v_replacement);
end;
$partners_program_activation_membership_privacy_gate$;

create or replace function affiliate_private.is_managed_partners_flag(
  p_key text
)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(p_key, '') = any (
    array[
      'partners_enabled',
      'partners_invite_only',
      'partners_cash_pilot_allowlist_only',
      'partners_earnings_enabled',
      'partners_credit_redemptions_enabled',
      'partners_shadow_mode',
      'partners_payouts_live',
      'partners_tv_relay_enabled',
      'partners_revolut_api_enabled'
    ]::text[]
  );
$$;

revoke all on function
  affiliate_private.is_managed_partners_flag(text)
from public, anon, authenticated, service_role;

-- Keep every existing Support/Risk/Finance mapping intact and add the two
-- financial feature switches. Enabling either switch is a dual-control AAL2
-- operation; disabling is intentionally available to any operational kill-
-- switch owner.
create or replace function
affiliate_private.partners_require_control_access(
  p_action text,
  p_key text,
  p_enabled boolean
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_action text := lower(btrim(coalesce(p_action, '')));
  v_key text := lower(btrim(coalesce(p_key, '')));
  v_support boolean :=
    affiliate_private.partners_has_capability('support');
  v_risk boolean :=
    affiliate_private.partners_has_capability('risk');
  v_finance boolean :=
    affiliate_private.partners_has_capability('finance');
  v_release boolean :=
    affiliate_private.partners_is_release_manager();
  v_allowed boolean := false;
begin
  if v_action = 'set_allowlist' then
    v_allowed := case
      when p_enabled is true then v_risk
      when p_enabled is false then v_support or v_risk
      else v_risk
    end;
  elsif v_action = 'set_gate' then
    if v_key = any (
      array[
        'legal_and_tax_approved',
        'individual_payout_coverage_confirmed',
        'financial_data_contract_approved',
        'shadow_reconciliation_clean',
        'backup_restore_verified',
        'payout_execution_adapter_verified',
        'manual_payout_workflow_verified',
        'revolut_api_adapter_verified'
      ]::text[]
    ) then
      v_allowed := v_finance;
    elsif v_key = any (
      array[
        'membership_privacy_approved',
        'privacy_approved',
        'individual_verification_coverage_confirmed',
        'country_policy_approved',
        'tv_relay_security_verified'
      ]::text[]
    ) then
      v_allowed := v_risk;
    elsif v_key = 'general_release_approved' then
      v_allowed := v_release;
    end if;
  elsif v_action = 'set_flag' then
    if v_key = 'partners_payouts_live' then
      v_allowed := v_finance and v_release;
    elsif v_key = 'partners_shadow_mode' then
      v_allowed := v_finance;
    elsif v_key = 'partners_enabled' then
      v_allowed := v_release
        or (p_enabled is false and v_support);
    elsif v_key = 'partners_invite_only' then
      v_allowed := v_release;
    elsif v_key = 'partners_cash_pilot_allowlist_only' then
      v_allowed := case
        when p_enabled is false then v_release and v_risk
        when p_enabled is true then v_release or v_risk or v_support
        else v_release and v_risk
      end;
    elsif v_key in (
      'partners_earnings_enabled',
      'partners_credit_redemptions_enabled'
    ) then
      v_allowed := case
        when p_enabled is true then v_finance and v_release
        when p_enabled is false then
          v_finance or v_release or v_support
        else v_finance and v_release
      end;
    elsif v_key = 'partners_tv_relay_enabled' then
      v_allowed := case
        when p_enabled is true then v_release and v_risk
        when p_enabled is false then v_release or v_risk or v_support
        else v_release and v_risk
      end;
    elsif v_key = 'partners_revolut_api_enabled' then
      v_allowed := case
        when p_enabled is true then v_finance and v_release
        when p_enabled is false then
          v_finance or v_release or v_support
        else v_finance and v_release
      end;
    end if;
  end if;

  if not coalesce(v_allowed, false) then
    raise exception 'Partners control capability is required'
      using errcode = '42501';
  end if;

  if p_enabled is true
    and v_action = 'set_flag'
    and v_key in (
      'partners_earnings_enabled',
      'partners_credit_redemptions_enabled'
    )
  then
    perform affiliate_private.partners_require_aal2(
      'financial Partners activation'
    );
  end if;

  if p_enabled is false
    and v_action = 'set_flag'
    and v_key = 'partners_cash_pilot_allowlist_only'
  then
    perform affiliate_private.partners_require_aal2(
      'cash Partners pilot expansion'
    );
  end if;

  if p_enabled is true
    and v_action = 'set_gate'
    and v_key in (
      'membership_privacy_approved',
      'privacy_approved',
      'individual_verification_coverage_confirmed',
      'country_policy_approved'
    )
  then
    perform affiliate_private.partners_require_aal2(
      'Risk Partners approval'
    );
  end if;

  -- Preserve the historical AAL2 contract and error text for all existing
  -- financial gates and payout/API flags.
  if p_enabled is true
    and (
      (
        v_action = 'set_gate'
        and v_key = any (
          array[
            'legal_and_tax_approved',
            'individual_payout_coverage_confirmed',
            'financial_data_contract_approved',
            'shadow_reconciliation_clean',
            'backup_restore_verified',
            'payout_execution_adapter_verified',
            'manual_payout_workflow_verified',
            'revolut_api_adapter_verified'
          ]::text[]
        )
      )
      or (
        v_action = 'set_flag'
        and v_key in (
          'partners_payouts_live',
          'partners_revolut_api_enabled'
        )
      )
    )
    and coalesce(auth.jwt() ->> 'aal', '') <> 'aal2'
  then
    raise exception 'financial Partners activation requires AAL2'
      using errcode = '42501';
  end if;
end;
$$;

revoke all on function
  affiliate_private.partners_require_control_access(text, text, boolean)
from public, anon, authenticated, service_role;

-- Retain the full historical control implementation for unchanged gates,
-- allowlisting and cash/payout flags. Its public privilege is removed so all
-- clients must pass through the frictionless-aware wrapper below.
alter function public.admin_partners_control(
  text,
  text,
  boolean,
  text,
  uuid,
  text,
  text,
  timestamptz
)
rename to admin_partners_control_pre_frictionless_release_20260804;

revoke all on function
  public.admin_partners_control_pre_frictionless_release_20260804(
    text,
    text,
    boolean,
    text,
    uuid,
    text,
    text,
    timestamptz
  )
from public, anon, authenticated, service_role;

create or replace function public.admin_partners_control(
  p_action text,
  p_key text default null,
  p_enabled boolean default null,
  p_justification text default null,
  p_subject_user_id uuid default null,
  p_country_code text default null,
  p_subdivision_code text default null,
  p_expires_at timestamptz default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_action text := lower(btrim(coalesce(p_action, '')));
  v_key text := lower(btrim(coalesce(p_key, '')));
  v_justification text := btrim(coalesce(p_justification, ''));
  v_actor uuid := auth.uid();
  v_actor_pseudonym text;
  v_current boolean;
  v_count bigint;
  v_before jsonb;
  v_after jsonb;
begin
  -- Only the three membership/economic switches have new semantics. Every
  -- other action stays on the already-audited implementation.
  if not (
    v_action = 'set_flag'
    and v_key in (
      'partners_enabled',
      'partners_cash_pilot_allowlist_only',
      'partners_earnings_enabled',
      'partners_credit_redemptions_enabled'
    )
  ) then
    -- A financial release gate cannot be revoked while either new economic
    -- path depends on it. The shared advisory lock closes the check/mutation
    -- race before delegating to the legacy control function.
    if v_action = 'set_gate'
      and p_enabled is false
      and v_key in (
        'legal_and_tax_approved',
        'membership_privacy_approved',
        'financial_data_contract_approved',
        'backup_restore_verified',
        'privacy_approved',
        'individual_verification_coverage_confirmed',
        'individual_payout_coverage_confirmed',
        'country_policy_approved',
        'shadow_reconciliation_clean',
        'payout_execution_adapter_verified',
        'manual_payout_workflow_verified'
      )
    then
      if not public.is_admin() or v_actor is null then
        raise exception 'not authorized' using errcode = '42501';
      end if;
      perform affiliate_private.partners_require_control_access(
        v_action,
        v_key,
        p_enabled
      );
      if length(v_justification) not between 12 and 1000 then
        raise exception 'justification must contain 12 to 1000 characters'
          using errcode = '22023';
      end if;
      perform pg_advisory_xact_lock(
        hashtextextended('norva:partners:release-control', 0)
      );
      select count(*) into v_count
      from public.admin_feature_flags flag
      where flag.enabled
        and (
          (
            v_key = 'legal_and_tax_approved'
            and flag.key in (
              'partners_enabled',
              'partners_earnings_enabled',
              'partners_credit_redemptions_enabled',
              'partners_payouts_live'
            )
          )
          or (
            v_key = 'membership_privacy_approved'
            and flag.key = 'partners_enabled'
          )
          or (
            v_key in (
              'financial_data_contract_approved',
              'backup_restore_verified'
            )
            and flag.key in (
              'partners_earnings_enabled',
              'partners_credit_redemptions_enabled',
              'partners_payouts_live'
            )
          )
          or (
            v_key in (
              'privacy_approved',
              'individual_verification_coverage_confirmed',
              'individual_payout_coverage_confirmed',
              'country_policy_approved',
              'shadow_reconciliation_clean',
              'payout_execution_adapter_verified',
              'manual_payout_workflow_verified'
            )
            and flag.key = 'partners_payouts_live'
          )
        );
      if v_count > 0 then
        raise exception 'disable dependent Partners flags first'
          using errcode = '55000';
      end if;
    end if;

    -- The legacy function still owns provider, route, shadow-mode and
    -- adapter checks. This pre-delegation fence adds every explicit cash gate
    -- while holding the same transaction-scoped release lock, so it cannot be
    -- bypassed by the delegation branch.
    if v_action = 'set_flag'
      and v_key = 'partners_payouts_live'
      and p_enabled is true
    then
      if not public.is_admin() or v_actor is null then
        raise exception 'not authorized' using errcode = '42501';
      end if;
      perform affiliate_private.partners_require_control_access(
        v_action,
        v_key,
        p_enabled
      );
      if length(v_justification) not between 12 and 1000 then
        raise exception 'justification must contain 12 to 1000 characters'
          using errcode = '22023';
      end if;
      perform pg_advisory_xact_lock(
        hashtextextended('norva:partners:release-control', 0)
      );
      if not affiliate_private.release_gates_satisfied(
        array[
          'legal_and_tax_approved',
          'membership_privacy_approved',
          'privacy_approved',
          'individual_verification_coverage_confirmed',
          'individual_payout_coverage_confirmed',
          'country_policy_approved',
          'financial_data_contract_approved',
          'shadow_reconciliation_clean',
          'backup_restore_verified',
          'payout_execution_adapter_verified',
          'manual_payout_workflow_verified'
        ]::text[]
      ) then
        raise exception 'cash Partners prerequisites are incomplete'
          using errcode = '55000';
      end if;
    end if;

    return public.admin_partners_control_pre_frictionless_release_20260804(
      p_action,
      p_key,
      p_enabled,
      p_justification,
      p_subject_user_id,
      p_country_code,
      p_subdivision_code,
      p_expires_at
    );
  end if;

  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if v_actor is null then
    raise exception 'admin identity unavailable' using errcode = '42501';
  end if;
  perform affiliate_private.partners_require_control_access(
    v_action,
    v_key,
    p_enabled
  );
  if length(v_justification) not between 12 and 1000 then
    raise exception 'justification must contain 12 to 1000 characters'
      using errcode = '22023';
  end if;
  if p_enabled is null then
    raise exception 'flag value is required' using errcode = '22023';
  end if;

  v_actor_pseudonym := encode(
    extensions.digest(
      'norva-partners-actor:v1:' || v_actor::text,
      'sha256'
    ),
    'hex'
  );

  -- One transaction lock serializes every gate, allowlist and flag decision;
  -- row locks below make the dependency snapshot explicit as well.
  perform pg_advisory_xact_lock(
    hashtextextended('norva:partners:release-control', 0)
  );

  select flag.enabled
  into v_current
  from public.admin_feature_flags flag
  where flag.key = v_key
  for update;
  if not found then
    raise exception 'managed Partners flag is missing'
      using errcode = '55000';
  end if;

  if v_current = p_enabled then
    return jsonb_build_object(
      'action', v_action,
      'key', v_key,
      'enabled', v_current,
      'changed', false
    );
  end if;

  if not p_enabled and v_key = 'partners_cash_pilot_allowlist_only'
    and not affiliate_private.release_gates_satisfied(
      array['general_release_approved']::text[]
    )
  then
    raise exception 'general release is not approved for cash expansion'
      using errcode = '55000';
  end if;

  if p_enabled and v_key = 'partners_enabled' then
    if not affiliate_private.release_gates_satisfied(
      array[
        'legal_and_tax_approved',
        'membership_privacy_approved'
      ]::text[]
    ) then
      raise exception 'Partners legal prerequisites are incomplete'
        using errcode = '55000';
    end if;

    select count(*)
    into v_count
    from affiliate_private.affiliate_program_versions program
    where program.status = 'active'
      and program.account_type = 'individual'
      and program.commission_rate_bps = 2000
      and program.attribution_window_days = 30
      and program.maturation_days = 45
      and program.effective_from <= now()
      and (
        program.effective_until is null
        or program.effective_until > now()
      );
    if v_count <> 1 then
      raise exception 'exactly one active individual program is required'
        using errcode = '55000';
    end if;
  elsif p_enabled and v_key in (
    'partners_earnings_enabled',
    'partners_credit_redemptions_enabled'
  ) then
    perform 1
    from public.admin_feature_flags flag
    where flag.key = 'partners_enabled'
      and flag.enabled
    for share;
    if not found then
      raise exception 'Partners must be enabled before economic features'
        using errcode = '55000';
    end if;

    if not affiliate_private.release_gates_satisfied(
      array[
        'legal_and_tax_approved',
        'financial_data_contract_approved',
        'backup_restore_verified'
      ]::text[]
    ) then
      raise exception 'economic Partners prerequisites are incomplete'
        using errcode = '55000';
    end if;

    if v_key = 'partners_credit_redemptions_enabled' then
      select count(*)
      into v_count
      from affiliate_private.affiliate_access_credit_catalog catalog
      where catalog.status = 'active'
        and catalog.catalog_key = 'acc_p0_usd_plus_month_v1'
        and catalog.plan_code = 'plus'
        and catalog.currency = 'USD'
        and catalog.currency_exponent = 2
        and catalog.unit_amount_minor = 499
        and catalog.unit_duration_days = 30
        and catalog.minimum_months = 1
        and catalog.maximum_months = 12
        and catalog.effective_from <= now()
        and (
          catalog.effective_until is null
          or catalog.effective_until > now()
        );
      if v_count <> 1 then
        raise exception 'the exact active P0 USD Plus access-credit catalog is required'
          using errcode = '55000';
      end if;
    end if;
  elsif not p_enabled and v_key = 'partners_enabled' then
    select count(*)
    into v_count
    from public.admin_feature_flags flag
    where flag.key in (
      'partners_earnings_enabled',
      'partners_credit_redemptions_enabled',
      'partners_shadow_mode',
      'partners_payouts_live',
      'partners_tv_relay_enabled',
      'partners_revolut_api_enabled'
    )
      and flag.enabled;
    if v_count > 0 then
      raise exception 'disable dependent Partners flags first'
        using errcode = '55000';
    end if;
  end if;

  v_before := jsonb_build_object('enabled', v_current);
  perform set_config(
    'norva.partners_control',
    'admin_partners_control',
    true
  );
  update public.admin_feature_flags
  set
    enabled = p_enabled,
    updated_at = now(),
    updated_by = v_actor_pseudonym
  where key = v_key;
  v_after := jsonb_build_object('enabled', p_enabled);

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
    'feature_flag',
    v_key,
    'feature_flag_changed',
    'admin',
    v_actor_pseudonym,
    v_justification,
    v_before,
    v_after
  );

  return jsonb_build_object(
    'action', v_action,
    'key', v_key,
    'enabled', p_enabled,
    'changed', true
  );
end;
$$;

revoke all on function public.admin_partners_control(
  text,
  text,
  boolean,
  text,
  uuid,
  text,
  text,
  timestamptz
) from public, anon, authenticated, service_role;
grant execute on function public.admin_partners_control(
  text,
  text,
  boolean,
  text,
  uuid,
  text,
  text,
  timestamptz
) to authenticated;

-- Preserve the approval-registry enriched configuration and replace only the
-- managed flag array. This avoids duplicating programme, jurisdiction,
-- approval-provenance and deployment-manifest logic.
alter function affiliate_private.admin_partners_configuration()
rename to admin_partners_configuration_pre_frictionless_release_20260804;

revoke all on function
  affiliate_private.admin_partners_configuration_pre_frictionless_release_20260804()
from public, anon, authenticated, service_role;

create or replace function affiliate_private.admin_partners_configuration()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_base jsonb;
  v_release_flags jsonb;
begin
  v_base :=
    affiliate_private.admin_partners_configuration_pre_frictionless_release_20260804();

  with managed_flags(flag_key, position) as (
    values
      ('partners_enabled'::text, 1),
      ('partners_invite_only'::text, 2),
      ('partners_cash_pilot_allowlist_only'::text, 3),
      ('partners_earnings_enabled'::text, 4),
      ('partners_credit_redemptions_enabled'::text, 5),
      ('partners_shadow_mode'::text, 6),
      ('partners_payouts_live'::text, 7),
      ('partners_tv_relay_enabled'::text, 8),
      ('partners_revolut_api_enabled'::text, 9)
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'key', managed.flag_key,
        'enabled', coalesce(flag.enabled, false)
      )
      order by managed.position
    ),
    '[]'::jsonb
  )
  into v_release_flags
  from managed_flags managed
  left join public.admin_feature_flags flag
    on flag.key = managed.flag_key;

  return jsonb_set(
    v_base,
    '{release_flags}',
    v_release_flags,
    true
  );
end;
$$;

create or replace function public.admin_partners_configuration()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select affiliate_private.admin_partners_configuration();
$$;

revoke all on function affiliate_private.admin_partners_configuration()
from public, anon, authenticated, service_role;
grant execute on function affiliate_private.admin_partners_configuration()
to authenticated;

revoke all on function public.admin_partners_configuration()
from public, anon, authenticated, service_role;
grant execute on function public.admin_partners_configuration()
to authenticated;

reset lock_timeout;
reset statement_timeout;
