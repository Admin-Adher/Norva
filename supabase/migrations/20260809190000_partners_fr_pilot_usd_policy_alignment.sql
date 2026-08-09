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
  v_updated integer := 0;
begin
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
