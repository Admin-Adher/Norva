-- Norva Partners: exact multi-currency access-credit conversion.
--
-- The commercial catalogue remains expressed in USD. A partner may redeem an
-- available balance in another ledger currency only when an immutable, current
-- source->USD FX snapshot exists. The quote freezes both the source debit and
-- the USD reference; redemption replays that evidence and never performs a
-- floating-point or implicit conversion.

alter default privileges in schema affiliate_private
  revoke execute on functions from public;

alter table affiliate_private.affiliate_access_credit_quotes
  drop constraint affiliate_access_credit_quotes_usd,
  drop constraint affiliate_access_credit_quotes_amounts,
  add column reference_currency text not null default 'USD',
  add column reference_currency_exponent integer not null default 2,
  add column reference_unit_amount_minor bigint not null default 499,
  add column reference_total_amount_minor bigint,
  add column fx_rate_snapshot_id uuid
    references affiliate_private.affiliate_fx_rate_snapshots(id)
    on delete restrict;

update affiliate_private.affiliate_access_credit_quotes quote
set reference_total_amount_minor = quote.total_amount_minor
where quote.reference_total_amount_minor is null;

alter table affiliate_private.affiliate_access_credit_quotes
  alter column reference_total_amount_minor set not null,
  add constraint affiliate_access_credit_quotes_currencies
    check (
      currency ~ '^[A-Z]{3}$'
      and currency_exponent between 0 and 6
      and reference_currency = 'USD'
      and reference_currency_exponent = 2
    ),
  add constraint affiliate_access_credit_quotes_amounts
    check (
      months between 1 and 12
      and unit_amount_minor between 1 and 9007199254740991
      and total_amount_minor between 1 and 9007199254740991
      and reference_unit_amount_minor between 1 and 9007199254740991
      and reference_total_amount_minor = reference_unit_amount_minor * months
      and duration_days = 30 * months
    ),
  add constraint affiliate_access_credit_quotes_fx
    check (
      (currency = reference_currency and fx_rate_snapshot_id is null)
      or
      (currency <> reference_currency and fx_rate_snapshot_id is not null)
    );

alter table affiliate_private.affiliate_access_credit_redemptions
  drop constraint affiliate_access_credit_redemptions_usd,
  add column reference_currency text not null default 'USD',
  add column reference_currency_exponent integer not null default 2,
  add column reference_amount_minor bigint,
  add column fx_rate_snapshot_id uuid
    references affiliate_private.affiliate_fx_rate_snapshots(id)
    on delete restrict;

update affiliate_private.affiliate_access_credit_redemptions redemption
set reference_amount_minor = redemption.amount_minor
where redemption.reference_amount_minor is null;

alter table affiliate_private.affiliate_access_credit_redemptions
  alter column reference_amount_minor set not null,
  add constraint affiliate_access_credit_redemptions_currencies
    check (
      currency ~ '^[A-Z]{3}$'
      and currency_exponent between 0 and 6
      and reference_currency = 'USD'
      and reference_currency_exponent = 2
    ),
  add constraint affiliate_access_credit_redemptions_reference_amount
    check (reference_amount_minor between 1 and 9007199254740991),
  add constraint affiliate_access_credit_redemptions_fx
    check (
      (currency = reference_currency and fx_rate_snapshot_id is null)
      or
      (currency <> reference_currency and fx_rate_snapshot_id is not null)
    );

create or replace function affiliate_private.partners_fx_source_amount_ceil(
  p_target_amount_minor bigint,
  p_source_units_minor bigint,
  p_target_units_minor bigint
)
returns bigint
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  v_result numeric;
begin
  if p_target_amount_minor is null
    or p_target_amount_minor < 0
    or p_target_amount_minor > 9007199254740991
    or p_source_units_minor is null
    or p_source_units_minor < 1
    or p_source_units_minor > 9007199254740991
    or p_target_units_minor is null
    or p_target_units_minor < 1
    or p_target_units_minor > 9007199254740991
  then
    raise exception 'invalid exact-money FX source input'
      using errcode = '22023';
  end if;
  v_result := ceil(
    p_target_amount_minor::numeric
      * p_source_units_minor::numeric
      / p_target_units_minor::numeric
  );
  if v_result > 9007199254740991 then
    raise exception 'exact-money FX source amount exceeds safe range'
      using errcode = '22003';
  end if;
  return v_result::bigint;
end;
$$;

create or replace function affiliate_private.partners_access_credit_offer(
  p_account_id uuid,
  p_months integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_catalog affiliate_private.affiliate_access_credit_catalog%rowtype;
  v_offer jsonb;
  v_has_positive_balance boolean := false;
begin
  if p_account_id is null or p_months is null or p_months not between 1 and 12 then
    raise exception 'invalid access credit offer request' using errcode = '22023';
  end if;

  select catalog.*
  into v_catalog
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
    and p_months between catalog.minimum_months and catalog.maximum_months
    and catalog.effective_from <= now()
    and (catalog.effective_until is null or catalog.effective_until > now())
  order by catalog.effective_from desc
  limit 1;
  if not found then
    return null;
  end if;

  select exists (
    select 1
    from jsonb_to_recordset(
      affiliate_private.partners_account_balances(p_account_id)
    ) as balance(
      currency text,
      currency_exponent integer,
      pending_minor bigint,
      available_minor bigint,
      recovery_due_minor bigint,
      redeemed_minor bigint
    )
    where balance.available_minor > 0
  ) into v_has_positive_balance;

  with balances as (
    select balance.*
    from jsonb_to_recordset(
      affiliate_private.partners_account_balances(p_account_id)
    ) as balance(
      currency text,
      currency_exponent integer,
      pending_minor bigint,
      available_minor bigint,
      recovery_due_minor bigint,
      redeemed_minor bigint
    )
    where balance.available_minor > 0
  ), candidates as (
    select
      balance.*,
      rate.id as rate_id,
      rate.snapshot_key,
      rate.rate_source,
      rate.observed_at,
      rate.valid_until,
      case
        when balance.currency = v_catalog.currency
          then v_catalog.unit_amount_minor
        else affiliate_private.partners_fx_source_amount_ceil(
          v_catalog.unit_amount_minor,
          rate.source_units_minor,
          rate.target_units_minor
        )
      end as source_unit_amount_minor,
      case
        when balance.currency = v_catalog.currency
          then v_catalog.unit_amount_minor * p_months
        else affiliate_private.partners_fx_source_amount_ceil(
          v_catalog.unit_amount_minor * p_months,
          rate.source_units_minor,
          rate.target_units_minor
        )
      end as source_total_amount_minor
    from balances balance
    left join lateral (
      select snapshot.*
      from affiliate_private.affiliate_fx_rate_snapshots snapshot
      where snapshot.source_currency = balance.currency
        and snapshot.target_currency = v_catalog.currency
        and snapshot.source_exponent = balance.currency_exponent
        and snapshot.target_exponent = v_catalog.currency_exponent
        and snapshot.observed_at <= now()
        and snapshot.valid_until >= now()
      order by snapshot.observed_at desc, snapshot.created_at desc
      limit 1
    ) rate on balance.currency <> v_catalog.currency
    where balance.currency = v_catalog.currency or rate.id is not null
  )
  select jsonb_build_object(
    'catalog', jsonb_build_object(
      'catalog_key', v_catalog.catalog_key,
      'plan_code', v_catalog.plan_code,
      'currency', candidate.currency,
      'currency_exponent', candidate.currency_exponent,
      'unit_amount_minor', candidate.source_unit_amount_minor,
      'unit_duration_days', v_catalog.unit_duration_days,
      'minimum_months', v_catalog.minimum_months,
      'maximum_months', v_catalog.maximum_months,
      'reference_currency', v_catalog.currency,
      'reference_currency_exponent', v_catalog.currency_exponent,
      'reference_unit_amount_minor', v_catalog.unit_amount_minor,
      'fx_rate_snapshot_key', candidate.snapshot_key,
      'fx_rate_source', candidate.rate_source,
      'fx_observed_at', candidate.observed_at,
      'fx_valid_until', candidate.valid_until
    ),
    'balance', jsonb_build_object(
      'currency', candidate.currency,
      'currency_exponent', candidate.currency_exponent,
      'pending_minor', candidate.pending_minor,
      'available_minor', candidate.available_minor,
      'recovery_due_minor', candidate.recovery_due_minor,
      'redeemed_minor', candidate.redeemed_minor
    ),
    'source_total_amount_minor', candidate.source_total_amount_minor,
    'fx_rate_snapshot_id', candidate.rate_id
  )
  into v_offer
  from candidates candidate
  order by
    (candidate.available_minor >= candidate.source_total_amount_minor) desc,
    (candidate.currency = v_catalog.currency) desc,
    floor(
      candidate.available_minor::numeric
        / candidate.source_total_amount_minor::numeric
    ) desc,
    candidate.currency
  limit 1;

  if v_offer is not null or v_has_positive_balance then
    return v_offer;
  end if;

  -- A new member with no released balance still receives a stable catalogue
  -- preview. Quote creation will correctly fail with insufficient_balance.
  return jsonb_build_object(
    'catalog', jsonb_build_object(
      'catalog_key', v_catalog.catalog_key,
      'plan_code', v_catalog.plan_code,
      'currency', v_catalog.currency,
      'currency_exponent', v_catalog.currency_exponent,
      'unit_amount_minor', v_catalog.unit_amount_minor,
      'unit_duration_days', v_catalog.unit_duration_days,
      'minimum_months', v_catalog.minimum_months,
      'maximum_months', v_catalog.maximum_months,
      'reference_currency', v_catalog.currency,
      'reference_currency_exponent', v_catalog.currency_exponent,
      'reference_unit_amount_minor', v_catalog.unit_amount_minor,
      'fx_rate_snapshot_key', null,
      'fx_rate_source', null,
      'fx_observed_at', null,
      'fx_valid_until', null
    ),
    'balance', jsonb_build_object(
      'currency', v_catalog.currency,
      'currency_exponent', v_catalog.currency_exponent,
      'pending_minor', 0,
      'available_minor', 0,
      'recovery_due_minor', 0,
      'redeemed_minor', 0
    ),
    'source_total_amount_minor', v_catalog.unit_amount_minor * p_months,
    'fx_rate_snapshot_id', null
  );
end;
$$;

create or replace function
affiliate_private.partners_service_access_credit_status(p_user_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_account affiliate_private.affiliate_accounts%rowtype;
  v_catalog affiliate_private.affiliate_access_credit_catalog%rowtype;
  v_offer jsonb;
  v_overlay jsonb;
  v_next_maturation timestamptz;
  v_credit_enabled boolean := false;
  v_has_positive_balance boolean := false;
  v_credit_reason text;
  v_cash_readiness jsonb;
begin
  if p_user_id is null then
    raise exception 'user id is required' using errcode = '22023';
  end if;
  select account.* into v_account
  from affiliate_private.affiliate_accounts account
  where account.user_id = p_user_id and account.status <> 'closed';
  if not found then
    raise exception 'Partners membership is unavailable' using errcode = 'P1001';
  end if;

  select catalog.* into v_catalog
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
    and (catalog.effective_until is null or catalog.effective_until > now())
  order by catalog.effective_from desc limit 1;

  v_offer := affiliate_private.partners_access_credit_offer(v_account.id, 1);
  v_overlay := affiliate_private.partners_service_access_grants_reconcile(p_user_id);
  select min(entry.matures_at) into v_next_maturation
  from affiliate_private.affiliate_commission_entries entry
  where entry.account_id = v_account.id
    and entry.entry_kind = 'accrual'
    and entry.matures_at > now()
    and not exists (
      select 1 from affiliate_private.affiliate_commission_entries release
      where release.related_entry_id = entry.id and release.entry_kind = 'release'
    );
  select coalesce(flag.enabled, false) into v_credit_enabled
  from public.admin_feature_flags flag
  where flag.key = 'partners_credit_redemptions_enabled';
  v_credit_enabled := coalesce(v_credit_enabled, false);
  select exists (
    select 1
    from jsonb_to_recordset(
      affiliate_private.partners_account_balances(v_account.id)
    ) as balance(
      currency text,
      currency_exponent integer,
      pending_minor bigint,
      available_minor bigint,
      recovery_due_minor bigint,
      redeemed_minor bigint
    )
    where balance.available_minor > 0
  ) into v_has_positive_balance;

  v_credit_reason := case
    when v_account.member_status <> 'active' then 'membership_required'
    when not v_credit_enabled then 'credits_disabled'
    when v_catalog.id is null then 'catalog_unavailable'
    when v_has_positive_balance and v_offer is null then 'fx_rate_unavailable'
    else null
  end;
  v_cash_readiness := affiliate_private.partners_cash_readiness(v_account.id);

  return jsonb_build_object(
    'schema_version', 2,
    'action', 'access_credit_status',
    'balance', coalesce(v_offer -> 'balance', jsonb_build_object(
      'currency', 'USD', 'currency_exponent', 2, 'pending_minor', 0,
      'available_minor', 0, 'recovery_due_minor', 0, 'redeemed_minor', 0
    )),
    'catalog', case when v_credit_reason is null then v_offer -> 'catalog' else null end,
    'next_maturation_at', v_next_maturation,
    'credit_readiness', jsonb_build_object(
      'ready', v_credit_reason is null,
      'reason', v_credit_reason
    ),
    'cash_readiness', v_cash_readiness,
    'overlay', v_overlay -> 'overlay',
    'provider', v_overlay -> 'provider'
  );
end;
$$;

create or replace function
affiliate_private.partners_service_access_credit_quote(
  p_user_id uuid,
  p_months integer,
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
  v_catalog affiliate_private.affiliate_access_credit_catalog%rowtype;
  v_quote affiliate_private.affiliate_access_credit_quotes%rowtype;
  v_rate affiliate_private.affiliate_fx_rate_snapshots%rowtype;
  v_offer jsonb;
  v_request_hash text;
  v_replay jsonb;
  v_response jsonb;
  v_source_currency text;
  v_source_exponent integer;
  v_source_unit bigint;
  v_source_total bigint;
  v_available bigint;
begin
  if p_user_id is null
    or p_months is null or p_months not between 1 and 12
    or p_idempotency_key is null
    or p_idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$'
  then
    raise exception 'invalid access credit quote request' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended('norva:partners:user:' || p_user_id::text, 0)
  );
  select account.* into v_account
  from affiliate_private.affiliate_accounts account
  where account.user_id = p_user_id and account.status <> 'closed'
  for update;
  if not found or v_account.member_status <> 'active' then
    raise exception 'active Partners membership is required' using errcode = 'P1001';
  end if;
  update affiliate_private.affiliate_access_credit_quotes quote
  set status = 'expired'
  where quote.account_id = v_account.id
    and quote.status = 'open' and quote.expires_at <= now();
  delete from affiliate_private.affiliate_access_credit_quotes quote
  where quote.account_id = v_account.id
    and quote.status in ('expired', 'cancelled')
    and quote.created_at < now() - interval '30 days';
  if not coalesce((
    select flag.enabled from public.admin_feature_flags flag
    where flag.key = 'partners_credit_redemptions_enabled'
  ), false) then
    raise exception 'access credit redemptions are disabled' using errcode = 'P1002';
  end if;

  select catalog.* into v_catalog
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
    and p_months between catalog.minimum_months and catalog.maximum_months
    and catalog.effective_from <= now()
    and (catalog.effective_until is null or catalog.effective_until > now())
  order by catalog.effective_from desc limit 1 for share;
  if not found then
    raise exception 'access credit catalog is unavailable' using errcode = 'P1005';
  end if;

  v_request_hash := encode(extensions.digest(concat_ws(
    chr(31), 'access_credit_quote:v2', p_user_id::text,
    v_catalog.id::text, p_months::text
  ), 'sha256'), 'hex');
  v_replay := affiliate_private.partners_replayed_response(
    'access_credit_quote', p_user_id, p_idempotency_key, v_request_hash
  );
  if v_replay is not null then return v_replay; end if;

  v_offer := affiliate_private.partners_access_credit_offer(v_account.id, p_months);
  if v_offer is null then
    raise exception 'exact FX evidence is unavailable for access credit'
      using errcode = 'P1008';
  end if;
  v_source_currency := v_offer #>> '{catalog,currency}';
  v_source_exponent := (v_offer #>> '{catalog,currency_exponent}')::integer;
  v_source_unit := (v_offer #>> '{catalog,unit_amount_minor}')::bigint;
  v_source_total := (v_offer ->> 'source_total_amount_minor')::bigint;

  perform affiliate_private.partners_balance_lock(
    v_account.id, v_source_currency
  );
  v_available := affiliate_private.partners_account_payable_balance(
    v_account.id, v_source_currency
  );
  if v_available < v_source_total then
    raise exception 'insufficient available Partner balance' using errcode = 'P1004';
  end if;
  if v_source_currency <> v_catalog.currency then
    select rate.* into v_rate
    from affiliate_private.affiliate_fx_rate_snapshots rate
    where rate.id = (v_offer ->> 'fx_rate_snapshot_id')::uuid
      and rate.source_currency = v_source_currency
      and rate.source_exponent = v_source_exponent
      and rate.target_currency = v_catalog.currency
      and rate.target_exponent = v_catalog.currency_exponent
      and rate.observed_at <= now() and rate.valid_until >= now();
    if not found
      or v_source_unit <> affiliate_private.partners_fx_source_amount_ceil(
        v_catalog.unit_amount_minor,
        v_rate.source_units_minor,
        v_rate.target_units_minor
      )
      or v_source_total <> affiliate_private.partners_fx_source_amount_ceil(
        v_catalog.unit_amount_minor * p_months,
        v_rate.source_units_minor,
        v_rate.target_units_minor
      )
    then
      raise exception 'exact FX evidence is unavailable for access credit'
        using errcode = 'P1008';
    end if;
  elsif v_source_unit <> v_catalog.unit_amount_minor
    or v_source_total <> v_catalog.unit_amount_minor * p_months
  then
    raise exception 'same-currency access credit evidence is inconsistent'
      using errcode = 'P1006';
  end if;

  insert into affiliate_private.affiliate_access_credit_quotes (
    account_id, catalog_id, plan_code, currency, currency_exponent,
    months, unit_amount_minor, total_amount_minor, duration_days, expires_at,
    reference_currency, reference_currency_exponent,
    reference_unit_amount_minor, reference_total_amount_minor,
    fx_rate_snapshot_id
  ) values (
    v_account.id, v_catalog.id, v_catalog.plan_code,
    v_source_currency, v_source_exponent, p_months,
    v_source_unit, v_source_total, v_catalog.unit_duration_days * p_months,
    now() + interval '15 minutes', v_catalog.currency,
    v_catalog.currency_exponent, v_catalog.unit_amount_minor,
    v_catalog.unit_amount_minor * p_months, v_rate.id
  ) returning * into v_quote;

  v_response := jsonb_build_object(
    'schema_version', 2,
    'action', 'access_credit_quoted',
    'replayed', false,
    'quote', jsonb_build_object(
      'key', v_quote.quote_key, 'status', v_quote.status,
      'currency', v_quote.currency,
      'currency_exponent', v_quote.currency_exponent,
      'plan_code', v_quote.plan_code, 'months', v_quote.months,
      'unit_amount_minor', v_quote.unit_amount_minor,
      'total_amount_minor', v_quote.total_amount_minor,
      'reference_currency', v_quote.reference_currency,
      'reference_currency_exponent', v_quote.reference_currency_exponent,
      'reference_unit_amount_minor', v_quote.reference_unit_amount_minor,
      'reference_total_amount_minor', v_quote.reference_total_amount_minor,
      'fx_rate_snapshot_key', v_rate.snapshot_key,
      'fx_rate_source', v_rate.rate_source,
      'fx_observed_at', v_rate.observed_at,
      'fx_valid_until', v_rate.valid_until,
      'duration_days', v_quote.duration_days,
      'expires_at', v_quote.expires_at
    ),
    'balance', jsonb_build_object(
      'currency', v_source_currency,
      'currency_exponent', v_source_exponent,
      'available_minor', v_available
    )
  );
  perform affiliate_private.partners_store_response(
    'access_credit_quote', p_user_id, p_idempotency_key,
    v_request_hash, v_response
  );
  return v_response;
end;
$$;

create or replace function
affiliate_private.partners_service_access_credit_redeem(
  p_user_id uuid,
  p_quote_key text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key text := lower(btrim(coalesce(p_quote_key, '')));
  v_account affiliate_private.affiliate_accounts%rowtype;
  v_quote affiliate_private.affiliate_access_credit_quotes%rowtype;
  v_catalog affiliate_private.affiliate_access_credit_catalog%rowtype;
  v_rate affiliate_private.affiliate_fx_rate_snapshots%rowtype;
  v_redemption affiliate_private.affiliate_access_credit_redemptions%rowtype;
  v_grant public.cloud_access_grants%rowtype;
  v_entry_id uuid;
  v_available bigint;
  v_request_hash text;
  v_replay jsonb;
  v_response jsonb;
  v_overlay jsonb;
begin
  if p_user_id is null
    or v_key !~ '^crq_[0-9a-f]{24}$'
    or p_idempotency_key is null
    or p_idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$'
  then
    raise exception 'invalid access credit redemption request' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended('norva:partners:user:' || p_user_id::text, 0)
  );
  select account.* into v_account
  from affiliate_private.affiliate_accounts account
  where account.user_id = p_user_id and account.status <> 'closed'
  for update;
  if not found or v_account.member_status <> 'active' then
    raise exception 'active Partners membership is required' using errcode = 'P1001';
  end if;
  if not coalesce((
    select flag.enabled from public.admin_feature_flags flag
    where flag.key = 'partners_credit_redemptions_enabled'
  ), false) then
    raise exception 'access credit redemptions are disabled' using errcode = 'P1002';
  end if;
  v_request_hash := encode(extensions.digest(concat_ws(
    chr(31), 'access_credit_redeem:v2', p_user_id::text, v_key
  ), 'sha256'), 'hex');
  v_replay := affiliate_private.partners_replayed_response(
    'access_credit_redeem', p_user_id, p_idempotency_key, v_request_hash
  );
  if v_replay is not null then return v_replay; end if;

  select quote.* into v_quote
  from affiliate_private.affiliate_access_credit_quotes quote
  where quote.quote_key = v_key and quote.account_id = v_account.id
  for update;
  if not found then
    raise exception 'access credit quote is unavailable' using errcode = 'P1006';
  end if;
  if v_quote.status = 'redeemed' then
    select redemption.* into strict v_redemption
    from affiliate_private.affiliate_access_credit_redemptions redemption
    where redemption.quote_id = v_quote.id;
    select grant_row.* into strict v_grant
    from public.cloud_access_grants grant_row
    where grant_row.redemption_id = v_redemption.id;
  else
    if v_quote.status <> 'open' or v_quote.expires_at <= now() then
      raise exception 'access credit quote expired' using errcode = 'P1003';
    end if;
    select catalog.* into v_catalog
    from affiliate_private.affiliate_access_credit_catalog catalog
    where catalog.id = v_quote.catalog_id for share;
    if not found
      or v_quote.reference_currency <> v_catalog.currency
      or v_quote.reference_currency_exponent <> v_catalog.currency_exponent
      or v_quote.plan_code <> v_catalog.plan_code
      or v_quote.reference_unit_amount_minor <> v_catalog.unit_amount_minor
      or v_quote.reference_total_amount_minor
        <> v_catalog.unit_amount_minor * v_quote.months
      or v_quote.duration_days <> v_catalog.unit_duration_days * v_quote.months
    then
      raise exception 'access credit quote evidence is inconsistent'
        using errcode = 'P1006';
    end if;
    if v_quote.currency = v_quote.reference_currency then
      if v_quote.fx_rate_snapshot_id is not null
        or v_quote.currency_exponent <> v_quote.reference_currency_exponent
        or v_quote.unit_amount_minor <> v_quote.reference_unit_amount_minor
        or v_quote.total_amount_minor <> v_quote.reference_total_amount_minor
      then
        raise exception 'same-currency access credit evidence is inconsistent'
          using errcode = 'P1006';
      end if;
    else
      select rate.* into v_rate
      from affiliate_private.affiliate_fx_rate_snapshots rate
      where rate.id = v_quote.fx_rate_snapshot_id
        and rate.source_currency = v_quote.currency
        and rate.source_exponent = v_quote.currency_exponent
        and rate.target_currency = v_quote.reference_currency
        and rate.target_exponent = v_quote.reference_currency_exponent
        and rate.observed_at <= v_quote.created_at
        and rate.valid_until >= v_quote.created_at;
      if not found
        or v_quote.unit_amount_minor
          <> affiliate_private.partners_fx_source_amount_ceil(
            v_quote.reference_unit_amount_minor,
            v_rate.source_units_minor,
            v_rate.target_units_minor
          )
        or v_quote.total_amount_minor
          <> affiliate_private.partners_fx_source_amount_ceil(
            v_quote.reference_total_amount_minor,
            v_rate.source_units_minor,
            v_rate.target_units_minor
          )
      then
        raise exception 'access credit quote FX evidence is inconsistent'
          using errcode = 'P1006';
      end if;
    end if;

    perform affiliate_private.partners_balance_lock(v_account.id, v_quote.currency);
    v_available := affiliate_private.partners_account_payable_balance(
      v_account.id, v_quote.currency
    );
    if v_available < v_quote.total_amount_minor then
      raise exception 'insufficient available Partner balance' using errcode = 'P1004';
    end if;
    insert into affiliate_private.affiliate_commission_entries (
      account_id, entry_kind, currency, currency_exponent, amount_minor
    ) values (
      v_account.id, 'access_credit_redemption', v_quote.currency,
      v_quote.currency_exponent, v_quote.total_amount_minor
    ) returning id into v_entry_id;
    insert into affiliate_private.affiliate_commission_postings (
      entry_id, ledger_account, direction, amount_minor, currency
    ) values
      (v_entry_id, 'partner_commission_available', 'debit',
       v_quote.total_amount_minor, v_quote.currency),
      (v_entry_id, 'partner_access_credit_clearing', 'credit',
       v_quote.total_amount_minor, v_quote.currency);
    insert into affiliate_private.affiliate_access_credit_redemptions (
      quote_id, account_id, ledger_entry_id, plan_code,
      currency, currency_exponent, months, amount_minor, duration_days,
      reference_currency, reference_currency_exponent,
      reference_amount_minor, fx_rate_snapshot_id
    ) values (
      v_quote.id, v_account.id, v_entry_id, v_quote.plan_code,
      v_quote.currency, v_quote.currency_exponent, v_quote.months,
      v_quote.total_amount_minor, v_quote.duration_days,
      v_quote.reference_currency, v_quote.reference_currency_exponent,
      v_quote.reference_total_amount_minor, v_quote.fx_rate_snapshot_id
    ) returning * into v_redemption;
    insert into public.cloud_access_grants (
      user_id, user_pseudonym, redemption_id, plan_code,
      duration_seconds, remaining_seconds
    ) values (
      p_user_id, v_account.user_pseudonym, v_redemption.id,
      v_redemption.plan_code, v_redemption.duration_days::bigint * 86400,
      v_redemption.duration_days::bigint * 86400
    ) returning * into v_grant;
    update affiliate_private.affiliate_access_credit_quotes quote
    set status = 'redeemed', redeemed_at = now()
    where quote.id = v_quote.id;
  end if;

  v_overlay := affiliate_private.partners_service_access_grants_reconcile(p_user_id);
  select grant_row.* into strict v_grant
  from public.cloud_access_grants grant_row where grant_row.id = v_grant.id;
  v_available := affiliate_private.partners_account_payable_balance(
    v_account.id, v_redemption.currency
  );
  if v_redemption.fx_rate_snapshot_id is not null then
    select rate.* into strict v_rate
    from affiliate_private.affiliate_fx_rate_snapshots rate
    where rate.id = v_redemption.fx_rate_snapshot_id;
  end if;
  v_response := jsonb_build_object(
    'schema_version', 2,
    'action', 'access_credit_redeemed',
    'replayed', v_quote.status = 'redeemed',
    'redemption', jsonb_build_object(
      'key', v_redemption.redemption_key, 'status', v_redemption.status,
      'currency', v_redemption.currency,
      'currency_exponent', v_redemption.currency_exponent,
      'amount_minor', v_redemption.amount_minor,
      'reference_currency', v_redemption.reference_currency,
      'reference_currency_exponent', v_redemption.reference_currency_exponent,
      'reference_amount_minor', v_redemption.reference_amount_minor,
      'fx_rate_snapshot_key', v_rate.snapshot_key,
      'fx_rate_source', v_rate.rate_source,
      'fx_observed_at', v_rate.observed_at,
      'months', v_redemption.months
    ),
    'grant', jsonb_build_object(
      'key', v_grant.grant_key, 'status', v_grant.status,
      'plan_code', v_grant.plan_code,
      'duration_days', v_redemption.duration_days,
      'remaining_seconds', case when v_grant.status = 'active' then greatest(
        ceil(extract(epoch from v_grant.active_until - now()))::bigint, 0
      ) else v_grant.remaining_seconds end,
      'active_from', v_grant.active_from,
      'active_until', v_grant.active_until
    ),
    'balance', jsonb_build_object(
      'currency', v_redemption.currency,
      'currency_exponent', v_redemption.currency_exponent,
      'available_minor', v_available
    ),
    'overlay', v_overlay -> 'overlay'
  );
  perform affiliate_private.partners_store_response(
    'access_credit_redeem', p_user_id, p_idempotency_key,
    v_request_hash, v_response
  );
  return v_response;
end;
$$;

revoke all on function
  affiliate_private.partners_fx_source_amount_ceil(bigint,bigint,bigint)
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.partners_access_credit_offer(uuid,integer)
  from public, anon, authenticated, service_role;

comment on function
  affiliate_private.partners_fx_source_amount_ceil(bigint,bigint,bigint) is
  'Conservative exact-money source debit for a frozen target amount; integer ceil prevents underpayment.';
comment on function
  affiliate_private.partners_access_credit_offer(uuid,integer) is
  'Chooses an exact ledger currency for access credit and freezes only current immutable source-to-USD FX evidence.';
comment on column
  affiliate_private.affiliate_access_credit_quotes.reference_total_amount_minor is
  'Immutable USD catalogue value. total_amount_minor remains the exact source-ledger debit.';
