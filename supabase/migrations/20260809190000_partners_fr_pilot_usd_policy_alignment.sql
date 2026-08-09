-- Norva Partners: align the unopened France cash pilot with the authoritative
-- USD reference contract selected for P0.
--
-- This is deliberately a one-shot, fail-closed production alignment rather
-- than a general policy-editing API. Published or assigned payout policies
-- remain versioned and immutable. The update is allowed only while the cash
-- policy is closed and no non-closed account is assigned to it.

do $$
declare
  v_program affiliate_private.affiliate_program_versions%rowtype;
  v_policy affiliate_private.affiliate_country_policies%rowtype;
  v_disabled_flag_keys text[] := '{}'::text[];
  v_revoked_gate_keys text[] := '{}'::text[];
  v_flag_key text;
  v_gate_key text;
  v_disabled integer := 0;
  v_revoked integer := 0;
  v_updated integer := 0;
begin
  perform pg_advisory_xact_lock(
    hashtextextended('norva:partners:release-control', 0)
  );

  select program.*
  into v_program
  from affiliate_private.affiliate_program_versions program
  where program.version_key = 'individual-global-p0-v2'
    and program.status = 'active'
    and program.account_type = 'individual'
    and program.commission_rate_bps = 2000
    and program.attribution_window_days = 30
    and program.maturation_days = 45
    and program.threshold_reference_currency = 'USD'
    and program.threshold_reference_minor = 1000
    and program.payout_fee_policy = 'platform_absorbed'
  for update;

  if not found then
    return;
  end if;

  select policy.*
  into v_policy
  from affiliate_private.affiliate_country_policies policy
  where policy.program_version_id = v_program.id
    and policy.country_code = 'FR'
    and policy.subdivision_code is null
  for update;

  if not found or v_policy.payout_currencies = array['USD']::text[] then
    return;
  end if;

  if v_policy.payout_currencies <> array['EUR']::text[] then
    raise exception
      'France P0 payout policy has an unexpected currency contract'
      using errcode = '55000';
  end if;

  if v_policy.individual_available then
    raise exception
      'France P0 payout policy must be closed before USD alignment'
      using errcode = '55000';
  end if;

  if exists (
    select 1
    from affiliate_private.affiliate_accounts account
    where account.country_policy_id = v_policy.id
      and account.status <> 'closed'
  ) then
    raise exception
      'France P0 payout policy is already assigned and requires a new version'
      using errcode = '55000';
  end if;

  if not exists (
    select 1
    from affiliate_private.affiliate_currency_metadata currency
    where currency.currency_code = 'USD'
      and currency.exponent = 2
      and currency.status = 'active'
  ) or not affiliate_private.payout_currencies_covered(
    v_program.payout_thresholds,
    array['USD']::text[]
  ) then
    raise exception
      'active USD metadata and a positive USD threshold are required'
      using errcode = '55000';
  end if;

  if exists (
    select 1
    from public.admin_feature_flags flag
    where flag.key in (
      'partners_payouts_live',
      'partners_tv_relay_enabled',
      'partners_revolut_api_enabled'
    )
      and flag.enabled
  ) then
    raise exception
      'disable live cash, TV relay and Revolut API before France USD alignment'
      using errcode = '55000';
  end if;

  -- The existing database contract correctly refuses to invalidate release
  -- evidence while membership or an economic worker is live. Enter a bounded
  -- maintenance state first. These flags remain off after the migration until
  -- an operator registers the new manifest, renews the scoped approvals under
  -- AAL2 and explicitly re-enables each capability.
  perform 1
  from public.admin_feature_flags flag
  where flag.key in (
    'partners_enabled',
    'partners_earnings_enabled',
    'partners_credit_redemptions_enabled',
    'partners_shadow_mode'
  )
  order by flag.key
  for update;

  select coalesce(
    array_agg(flag.key order by flag.key),
    '{}'::text[]
  )
  into v_disabled_flag_keys
  from public.admin_feature_flags flag
  where flag.key in (
    'partners_enabled',
    'partners_earnings_enabled',
    'partners_credit_redemptions_enabled',
    'partners_shadow_mode'
  )
    and flag.enabled;

  perform set_config(
    'norva.partners_control',
    'admin_partners_control',
    true
  );
  update public.admin_feature_flags flag
  set
    enabled = false,
    updated_at = now(),
    updated_by = null
  where flag.key = any(v_disabled_flag_keys)
    and flag.enabled;

  get diagnostics v_disabled = row_count;
  if v_disabled <> cardinality(v_disabled_flag_keys) then
    raise exception 'France P0 maintenance flag transition was not atomic'
      using errcode = '55000';
  end if;

  foreach v_flag_key in array v_disabled_flag_keys loop
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
    values (
      'feature_flag',
      v_flag_key,
      'feature_flag_disabled_for_policy_alignment',
      'system',
      null,
      'Maintenance contrôlée avant alignement USD et renouvellement des approbations France.',
      jsonb_build_object('enabled', true),
      jsonb_build_object(
        'enabled', false,
        'requires_explicit_reactivation', true
      )
    );
  end loop;

  -- Approval packages are immutable and a scoped satisfied gate deliberately
  -- prevents edits to the policy it approved. Revoke only the currently bound
  -- France-scoped gates before changing the unopened policy. Their bindings
  -- are cleared by the audited release-gate trigger and must later be replaced
  -- by fresh AAL2 approvals against the new deployment manifest.
  perform 1
  from affiliate_private.affiliate_release_gates gate
  order by gate.gate_key
  for update;

  select coalesce(
    array_agg(scoped_gate.gate_key order by scoped_gate.gate_key),
    '{}'::text[]
  )
  into v_revoked_gate_keys
  from (
    select distinct gate.gate_key
    from affiliate_private.affiliate_release_gates gate
    join affiliate_private.affiliate_release_gate_approval_bindings binding
      on binding.gate_key = gate.gate_key
    join affiliate_private.affiliate_approval_packages package
      on package.id = binding.approval_package_id
    cross join lateral jsonb_array_elements(
      package.jurisdiction_scope
    ) scope(item)
    where gate.satisfied
      and package.program_version_id = v_program.id
      and scope.item ->> 'country_code' = 'FR'
      and nullif(scope.item ->> 'subdivision_code', '') is null
  ) scoped_gate;

  update affiliate_private.affiliate_release_gates gate
  set
    satisfied = false,
    satisfied_at = null,
    updated_by_pseudonym = null,
    updated_at = now()
  where gate.gate_key = any(v_revoked_gate_keys)
    and gate.satisfied;

  get diagnostics v_revoked = row_count;
  if v_revoked <> cardinality(v_revoked_gate_keys) then
    raise exception 'France P0 scoped approval revocation was not atomic'
      using errcode = '55000';
  end if;

  foreach v_gate_key in array v_revoked_gate_keys loop
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
    values (
      'release_gate',
      v_gate_key,
      'release_gate_revoked_for_policy_alignment',
      'system',
      null,
      'Révocation contrôlée avant alignement USD de la politique France non ouverte.',
      jsonb_build_object(
        'satisfied', true,
        'country_code', 'FR',
        'subdivision_code', null
      ),
      jsonb_build_object(
        'satisfied', false,
        'requires_fresh_aal2_approval', true
      )
    );
  end loop;

  update affiliate_private.affiliate_country_policies policy
  set
    payout_currencies = array['USD']::text[],
    updated_at = now()
  where policy.id = v_policy.id;

  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    raise exception 'France P0 payout policy alignment was not atomic'
      using errcode = '55000';
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
  )
  values (
    'country_policy',
    'individual-global-p0-v2:FR:*',
    'country_policy_currency_aligned',
    'system',
    null,
    'Alignement pre-pilote France sur le contrat autoritatif USD sans fait financier existant.',
    jsonb_build_object(
      'individual_available', v_policy.individual_available,
      'payout_currencies', to_jsonb(v_policy.payout_currencies)
    ),
    jsonb_build_object(
      'individual_available', false,
      'payout_currencies', jsonb_build_array('USD')
    )
  );
end;
$$;
