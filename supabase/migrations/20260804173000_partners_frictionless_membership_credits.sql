-- Frictionless Partners membership and non-cash Norva access credits.
--
-- Membership is deliberately independent from the legacy KYC/cash lifecycle:
-- every confirmed Cloud user may join and share immediately, while the
-- existing account status, verification, fiscal, corridor and payout controls
-- remain authoritative for cash. Access credits use the same balance lock as
-- payouts and never mutate the provider entitlement projection.

set statement_timeout = '60s';
set lock_timeout = '10s';

do $managed_flags$
begin
  perform set_config(
    'norva.partners_control',
    'admin_partners_control',
    true
  );
  insert into public.admin_feature_flags (
    key, enabled, description, updated_at, updated_by
  )
  values
    (
      'partners_earnings_enabled',
      false,
      'Allows new Partner commission accruals; existing reversals and maturation continue.',
      now(),
      'migration'
    ),
    (
      'partners_credit_redemptions_enabled',
      false,
      'Allows USD Partner balances to be converted into Norva access.',
      now(),
      'migration'
    ),
    (
      'partners_cash_pilot_allowlist_only',
      true,
      'Restricts cash-country binding and Didit KYC to the active pilot allowlist without restricting membership, sharing or access credits.',
      now(),
      'migration'
    )
  on conflict (key) do nothing;
  perform set_config('norva.partners_control', '', true);
end;
$managed_flags$;

alter table affiliate_private.affiliate_accounts
  add column member_status text not null default 'not_joined',
  add column member_program_version_id uuid
    references affiliate_private.affiliate_program_versions(id)
    on delete restrict,
  add column member_terms_version_accepted text,
  add column member_terms_accepted_at timestamptz,
  add column member_disclosure_version_accepted text,
  add column member_disclosure_accepted_at timestamptz,
  add column member_joined_at timestamptz;

update affiliate_private.affiliate_accounts account
set
  member_status = case account.status
    when 'active' then 'active'
    when 'held' then 'held'
    when 'suspended' then 'suspended'
    when 'closed' then 'closed'
    else 'not_joined'
  end,
  member_program_version_id = case
    when account.status = 'active' then account.program_version_id
    else null
  end,
  member_terms_version_accepted = case
    when account.status = 'active' then account.terms_version_accepted
    else null
  end,
  member_terms_accepted_at = case
    when account.status = 'active' then account.contract_accepted_at
    else null
  end,
  member_disclosure_version_accepted = case
    when account.status = 'active'
      then account.disclosure_version_accepted
    else null
  end,
  member_disclosure_accepted_at = case
    when account.status = 'active' then account.disclosure_accepted_at
    else null
  end,
  member_joined_at = case
    when account.status = 'active'
      then coalesce(account.contract_accepted_at, account.created_at)
    else null
  end;

alter table affiliate_private.affiliate_accounts
  add constraint affiliate_accounts_member_status
    check (
      member_status in (
        'not_joined', 'active', 'held', 'suspended', 'closed'
      )
    ),
  add constraint affiliate_accounts_member_versions
    check (
      (
        member_terms_version_accepted is null
        or member_terms_version_accepted
          ~ '^[a-z0-9][a-z0-9._-]{2,63}$'
      )
      and (
        member_disclosure_version_accepted is null
        or member_disclosure_version_accepted
          ~ '^[a-z0-9][a-z0-9._-]{2,63}$'
      )
    ),
  add constraint affiliate_accounts_member_active_consistency
    check (
      member_status <> 'active'
      or (
        user_id is not null
        and member_program_version_id is not null
        and member_terms_version_accepted is not null
        and member_terms_accepted_at is not null
        and member_disclosure_version_accepted is not null
        and member_disclosure_accepted_at is not null
        and member_joined_at is not null
      )
    ),
  add constraint affiliate_accounts_member_closed_consistency
    check (member_status <> 'closed' or status = 'closed');

create index affiliate_accounts_member_status_idx
  on affiliate_private.affiliate_accounts (
    member_status,
    member_joined_at desc
  );

create or replace function
affiliate_private.validate_affiliate_member_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_program affiliate_private.affiliate_program_versions%rowtype;
begin
  if tg_op = 'UPDATE' then
    if old.member_status = 'closed'
      and new.member_status <> 'closed'
    then
      raise exception 'closed Partners membership is terminal'
        using errcode = '55000';
    end if;

    if old.member_status is distinct from new.member_status
      and not (
        (old.member_status = 'not_joined'
          and new.member_status in ('active', 'closed'))
        or (old.member_status = 'active'
          and new.member_status in ('held', 'suspended', 'closed'))
        or (old.member_status = 'held'
          and new.member_status in ('active', 'suspended', 'closed'))
        or (old.member_status = 'suspended'
          and new.member_status in ('held', 'closed'))
      )
    then
      raise exception 'invalid Partners membership transition'
        using errcode = '55000';
    end if;

    if old.member_status = 'active'
      and new.member_status = 'active'
      and (
        new.member_program_version_id
          is distinct from old.member_program_version_id
        or new.member_terms_version_accepted
          is distinct from old.member_terms_version_accepted
        or new.member_terms_accepted_at
          is distinct from old.member_terms_accepted_at
        or new.member_disclosure_version_accepted
          is distinct from old.member_disclosure_version_accepted
        or new.member_disclosure_accepted_at
          is distinct from old.member_disclosure_accepted_at
        or new.member_joined_at is distinct from old.member_joined_at
      )
    then
      raise exception 'active Partners membership evidence is immutable'
        using errcode = '55000';
    end if;
  end if;

  if new.member_status <> 'active' then
    return new;
  end if;

  perform 1
  from auth.users cloud_user
  where cloud_user.id = new.user_id
    and cloud_user.email_confirmed_at is not null
  for share;
  if not found then
    raise exception 'active Partners membership requires a confirmed user'
      using errcode = '23514';
  end if;

  select program.*
  into v_program
  from affiliate_private.affiliate_program_versions program
  where program.id = new.member_program_version_id
  for share;
  if not found
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
    or new.member_terms_version_accepted
      is distinct from v_program.terms_version
    or new.member_disclosure_version_accepted
      is distinct from v_program.disclosure_version
  then
    raise exception 'Partners membership requires the current P0 program'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger affiliate_accounts_member_validate_transition
before insert or update of
  member_status,
  member_program_version_id,
  member_terms_version_accepted,
  member_terms_accepted_at,
  member_disclosure_version_accepted,
  member_disclosure_accepted_at,
  member_joined_at
on affiliate_private.affiliate_accounts
for each row execute function
  affiliate_private.validate_affiliate_member_transition();

create or replace function
affiliate_private.guard_affiliate_member_active_links()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.member_status <> 'active'
    and exists (
      select 1
      from affiliate_private.affiliate_links link
      where link.account_id = old.id
        and link.status = 'active'
    )
  then
    raise exception 'revoke the active Partners link before membership hold'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger affiliate_accounts_member_active_link_guard
before update of member_status
on affiliate_private.affiliate_accounts
for each row execute function
  affiliate_private.guard_affiliate_member_active_links();

-- Email confirmation is a membership invariant. The legacy account status
-- remains available exclusively to KYC/cash flows.
create or replace function
affiliate_private.guard_affiliate_auth_user_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if not affiliate_private.partners_account_deletion_ready(old.id) then
      raise exception 'prepare Partners records before deleting the user'
        using errcode = '55000';
    end if;
    return old;
  end if;

  if old.email_confirmed_at is not null
    and new.email_confirmed_at is null
    and exists (
      select 1
      from affiliate_private.affiliate_accounts account
      where account.user_id = old.id
        and account.member_status = 'active'
    )
  then
    raise exception 'active Partners membership requires a confirmed email'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

-- Active sharing links depend only on confirmed membership and the immutable
-- P0 program snapshot. KYC, country policy and payout corridors are cash-only.
create or replace function
affiliate_private.validate_affiliate_link_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_account affiliate_private.affiliate_accounts%rowtype;
  v_program affiliate_private.affiliate_program_versions%rowtype;
  v_predecessor affiliate_private.affiliate_links%rowtype;
begin
  if tg_op = 'DELETE' then
    raise exception 'Partners links are retained; revoke instead of deleting'
      using errcode = '55000';
  end if;
  if tg_op = 'INSERT' and new.status <> 'active' then
    raise exception 'new Partners links must start active'
      using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id
      or new.account_id is distinct from old.account_id
      or new.public_code is distinct from old.public_code
      or new.campaign_key is distinct from old.campaign_key
      or new.created_at is distinct from old.created_at
      or new.rotated_from_id is distinct from old.rotated_from_id
    then
      raise exception 'Partners link identity and rotation are immutable'
        using errcode = '55000';
    end if;
    if old.status = 'revoked'
      and (
        new.status <> 'revoked'
        or new.revoked_at is distinct from old.revoked_at
      )
    then
      raise exception 'revoked Partners links are terminal'
        using errcode = '55000';
    end if;
  end if;

  select account.*
  into v_account
  from affiliate_private.affiliate_accounts account
  where account.id = new.account_id
  for share;
  if not found then
    raise exception 'Partners link account is unavailable'
      using errcode = '23503';
  end if;

  if new.status = 'active' then
    if v_account.member_status <> 'active'
      or v_account.user_id is null
      or v_account.member_program_version_id is null
      or v_account.member_terms_version_accepted is null
      or v_account.member_terms_accepted_at is null
      or v_account.member_disclosure_version_accepted is null
      or v_account.member_disclosure_accepted_at is null
    then
      raise exception 'active Partners link requires active membership'
        using errcode = '23514';
    end if;

    perform 1
    from auth.users cloud_user
    where cloud_user.id = v_account.user_id
      and cloud_user.email_confirmed_at is not null
    for share;
    if not found then
      raise exception 'active Partners link requires a confirmed user'
        using errcode = '23514';
    end if;

    select program.*
    into v_program
    from affiliate_private.affiliate_program_versions program
    where program.id = v_account.member_program_version_id
    for share;
    if not found
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
      or v_account.member_terms_version_accepted
        is distinct from v_program.terms_version
      or v_account.member_disclosure_version_accepted
        is distinct from v_program.disclosure_version
    then
      raise exception 'active Partners link requires current program evidence'
        using errcode = '23514';
    end if;

    if exists (
      select 1
      from affiliate_private.affiliate_links successor
      where successor.rotated_from_id = new.id
        and successor.id <> new.id
    )
    then
      raise exception 'a rotated Partners link cannot be reactivated'
        using errcode = '55000';
    end if;
  end if;

  if new.rotated_from_id is not null then
    if new.rotated_from_id = new.id then
      raise exception 'a Partners link cannot rotate from itself'
        using errcode = '23514';
    end if;
    select predecessor.*
    into v_predecessor
    from affiliate_private.affiliate_links predecessor
    where predecessor.id = new.rotated_from_id
    for share;
    if not found then
      raise exception 'Partners predecessor link is unavailable'
        using errcode = '23503';
    end if;
    if v_predecessor.account_id <> new.account_id
      or v_predecessor.status <> 'revoked'
      or v_predecessor.created_at >= new.created_at
    then
      raise exception 'invalid Partners link rotation predecessor'
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

-- Preserve the authoritative bodies installed by later finance migrations and
-- change only their membership predicates. Every replacement is fail-closed:
-- a drifted function body aborts this migration instead of silently widening
-- cash access.
do $partners_member_predicate_upgrade$
declare
  v_change record;
  v_oid regprocedure;
  v_definition text;
  v_rewritten text;
begin
  for v_change in
    select *
    from (values
      (
        'affiliate_private.partners_service_referral_resolve(text,text,timestamptz,text,text,text)',
        'and a.status = ''active'';',
        'and a.member_status = ''active'';'
      ),
      (
        'affiliate_private.partners_service_referral_resolve(text,text,timestamptz,text,text,text)',
        'where p.id = v_account.program_version_id',
        'where p.id = v_account.member_program_version_id'
      ),
      (
        'affiliate_private.partners_service_referral_claim(uuid,text,text)',
        'v_referrer.status <> ''active''',
        'v_referrer.member_status <> ''active'''
      ),
      (
        'affiliate_private.partners_worker_financial_fact_ingest(text,text,text,text,uuid,text,text,text,text,integer,bigint,bigint,bigint,bigint,timestamptz)',
        'v_account.status = ''active''',
        'v_account.member_status = ''active'''
      ),
      (
        'affiliate_private.partners_worker_financial_fact_ingest(text,text,text,text,uuid,text,text,text,text,integer,bigint,bigint,bigint,bigint,timestamptz)',
        E'and (\n        coalesce((\n          select f.enabled\n          from public.admin_feature_flags f\n          where f.key = ''partners_shadow_mode''\n        ), false)\n        or coalesce((\n          select f.enabled\n          from public.admin_feature_flags f\n          where f.key = ''partners_payouts_live''\n        ), false)\n      )',
        E'and coalesce((\n        select flag.enabled\n        from public.admin_feature_flags flag\n        where flag.key = ''partners_earnings_enabled''\n      ), false)'
      ),
      (
        'affiliate_private.partners_worker_commission_job_complete_pre_financial_fence(text,text,text,text,text)',
        'v_account.status <> ''active''',
        'v_account.member_status <> ''active'''
      ),
      (
        'affiliate_private.partners_worker_maturation_complete(text,text,text,text,text)',
        'v_account.status <> ''active''',
        'v_account.member_status <> ''active'''
      ),
      (
        'affiliate_private.partners_worker_shadow_reconcile(text,timestamptz,timestamptz,boolean)',
        'account.status = ''active''',
        'account.member_status = ''active'''
      )
    ) as changes(signature, old_fragment, new_fragment)
  loop
    v_oid := to_regprocedure(v_change.signature);
    if v_oid is null then
      raise exception 'required Partners routine is unavailable: %',
        v_change.signature using errcode = '55000';
    end if;
    select pg_get_functiondef(v_oid::oid) into v_definition;
    v_rewritten := replace(
      v_definition,
      v_change.old_fragment,
      v_change.new_fragment
    );
    if v_rewritten = v_definition then
      raise exception 'Partners routine contract drifted: % / %',
        v_change.signature, v_change.old_fragment
        using errcode = '55000';
    end if;
    execute v_rewritten;
  end loop;
end;
$partners_member_predicate_upgrade$;

alter table affiliate_private.affiliate_service_idempotency
  drop constraint affiliate_service_idempotency_operation;
alter table affiliate_private.affiliate_service_idempotency
  add constraint affiliate_service_idempotency_operation
  check (
    operation in (
      'application',
      'terms_acceptance',
      'link_rotation',
      'referral_claim',
      'membership_join',
      'access_credit_quote',
      'access_credit_redeem'
    )
  );

-- The Edge boundary reserves a durable slot before every member mutation.
-- Extending the existing reservation contract prevents fresh idempotency keys
-- from turning link, country and credit endpoints into unbounded write paths.
alter table affiliate_private.affiliate_member_write_reservations
  drop constraint affiliate_member_write_reservations_operation;
alter table affiliate_private.affiliate_member_write_reservations
  add constraint affiliate_member_write_reservations_operation
  check (
    operation in (
      'fiscal_profile_self_attestation',
      'payout_onboarding',
      'membership_join',
      'link_rotation',
      'payout_country_bind',
      'access_credit_quote',
      'access_credit_redeem'
    )
  );

create or replace function
affiliate_private.partners_service_member_write_reserve(
  p_user_id uuid,
  p_operation text,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_operation text := lower(btrim(coalesce(p_operation, '')));
  v_request_hash text := lower(btrim(coalesce(p_request_hash, '')));
  v_existing_hash text;
  v_used integer := 0;
  -- Retained as the established fiscal/payout default and contract marker.
  v_limit constant integer := 8;
  v_operation_limit integer;
  v_window_seconds constant integer := 86400;
begin
  if p_user_id is null
    or v_operation not in (
      'fiscal_profile_self_attestation',
      'payout_onboarding',
      'membership_join',
      'link_rotation',
      'payout_country_bind',
      'access_credit_quote',
      'access_credit_redeem'
    )
    or p_idempotency_key is null
    or p_idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$'
    or v_request_hash !~ '^[0-9a-f]{64}$'
  then
    raise exception 'invalid Partners member write reservation'
      using errcode = '22023';
  end if;

  v_operation_limit := case v_operation
    when 'membership_join' then 4
    when 'link_rotation' then 4
    when 'payout_country_bind' then 8
    when 'access_credit_quote' then 24
    when 'access_credit_redeem' then 12
    else v_limit
  end;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:member-write:'
        || p_user_id::text
        || ':'
        || v_operation,
      0
    )
  );

  -- Cleanup remains scoped to the locked user/operation. Even the largest P0
  -- quota can retain at most 720 rows per member and operation over 30 days.
  delete from affiliate_private.affiliate_member_write_reservations old_row
  where old_row.operation = v_operation
    and old_row.user_id = p_user_id
    and old_row.reserved_at < now() - interval '30 days';

  delete from affiliate_private.affiliate_service_idempotency old_response
  where old_response.operation = v_operation
    and old_response.user_id = p_user_id
    and old_response.created_at < now() - interval '30 days';

  select reservation.request_hash
  into v_existing_hash
  from affiliate_private.affiliate_member_write_reservations reservation
  where reservation.operation = v_operation
    and reservation.user_id = p_user_id
    and reservation.idempotency_key = p_idempotency_key
  for update;

  if found then
    if v_existing_hash is distinct from v_request_hash then
      raise exception 'idempotency key was reused with another request'
        using errcode = 'P0003';
    end if;

    update affiliate_private.affiliate_member_write_reservations reservation
    set last_seen_at = greatest(reservation.last_seen_at, now())
    where reservation.operation = v_operation
      and reservation.user_id = p_user_id
      and reservation.idempotency_key = p_idempotency_key;

    select count(*)::integer
    into v_used
    from affiliate_private.affiliate_member_write_reservations reservation
    where reservation.operation = v_operation
      and reservation.user_id = p_user_id
      and reservation.reserved_at >= now() - interval '24 hours';

    return jsonb_build_object(
      'schema_version', 1,
      'action', 'member_write_reserved',
      'operation', v_operation,
      'replayed', true,
      'limit', v_operation_limit,
      'used', v_used,
      'remaining', greatest(v_operation_limit - v_used, 0),
      'window_seconds', v_window_seconds
    );
  end if;

  select count(*)::integer
  into v_used
  from affiliate_private.affiliate_member_write_reservations reservation
  where reservation.operation = v_operation
    and reservation.user_id = p_user_id
    and reservation.reserved_at >= now() - interval '24 hours';

  if v_used >= v_operation_limit then
    if v_operation in (
      'fiscal_profile_self_attestation', 'payout_onboarding'
    ) then
      raise exception 'Partners fiscal or payout onboarding rate limit exceeded'
        using errcode = 'P0008';
    end if;
    raise exception 'Partners member write rate limit exceeded'
      using errcode = 'P0008';
  end if;

  insert into affiliate_private.affiliate_member_write_reservations (
    operation,
    user_id,
    idempotency_key,
    request_hash
  ) values (
    v_operation,
    p_user_id,
    p_idempotency_key,
    v_request_hash
  );
  v_used := v_used + 1;

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'member_write_reserved',
    'operation', v_operation,
    'replayed', false,
    'limit', v_operation_limit,
    'used', v_used,
    'remaining', v_operation_limit - v_used,
    'window_seconds', v_window_seconds
  );
end;
$$;

create table affiliate_private.affiliate_access_credit_catalog (
  id                 uuid primary key default gen_random_uuid(),
  catalog_key        text not null unique,
  status             text not null default 'draft',
  plan_code          text not null,
  currency           text not null default 'USD',
  currency_exponent  integer not null default 2,
  unit_amount_minor  bigint not null,
  unit_duration_days integer not null default 30,
  minimum_months     integer not null default 1,
  maximum_months     integer not null default 12,
  effective_from     timestamptz not null,
  effective_until    timestamptz,
  created_at         timestamptz not null default now(),
  constraint affiliate_access_credit_catalog_key
    check (catalog_key ~ '^acc_[a-z0-9][a-z0-9._-]{2,63}$'),
  constraint affiliate_access_credit_catalog_status
    check (status in ('draft', 'active', 'retired')),
  constraint affiliate_access_credit_catalog_plan
    check (plan_code in ('plus', 'family', 'premium')),
  constraint affiliate_access_credit_catalog_usd
    check (currency = 'USD' and currency_exponent = 2),
  constraint affiliate_access_credit_catalog_price
    check (unit_amount_minor between 1 and 9007199254740991),
  constraint affiliate_access_credit_catalog_duration
    check (unit_duration_days = 30),
  constraint affiliate_access_credit_catalog_months
    check (
      minimum_months between 1 and 12
      and maximum_months between minimum_months and 12
    ),
  constraint affiliate_access_credit_catalog_effective_range
    check (effective_until is null or effective_until > effective_from)
);

create unique index affiliate_access_credit_catalog_one_active_idx
  on affiliate_private.affiliate_access_credit_catalog ((status))
  where status = 'active';

insert into affiliate_private.affiliate_access_credit_catalog (
  catalog_key,
  status,
  plan_code,
  currency,
  currency_exponent,
  unit_amount_minor,
  unit_duration_days,
  minimum_months,
  maximum_months,
  effective_from
)
values (
  'acc_p0_usd_plus_month_v1',
  'active',
  'plus',
  'USD',
  2,
  499,
  30,
  1,
  12,
  '2026-08-04T00:00:00Z'::timestamptz
);

create table affiliate_private.affiliate_access_credit_quotes (
  id                 uuid primary key default gen_random_uuid(),
  quote_key          text not null unique default (
    'crq_' || left(encode(extensions.gen_random_bytes(16), 'hex'), 24)
  ),
  account_id         uuid not null
    references affiliate_private.affiliate_accounts(id)
    on delete restrict,
  catalog_id         uuid not null
    references affiliate_private.affiliate_access_credit_catalog(id)
    on delete restrict,
  status             text not null default 'open',
  plan_code          text not null,
  currency           text not null,
  currency_exponent  integer not null,
  months             integer not null,
  unit_amount_minor  bigint not null,
  total_amount_minor bigint not null,
  duration_days      integer not null,
  expires_at         timestamptz not null,
  redeemed_at        timestamptz,
  created_at         timestamptz not null default now(),
  constraint affiliate_access_credit_quotes_key
    check (quote_key ~ '^crq_[0-9a-f]{24}$'),
  constraint affiliate_access_credit_quotes_status
    check (status in ('open', 'redeemed', 'expired', 'cancelled')),
  constraint affiliate_access_credit_quotes_usd
    check (currency = 'USD' and currency_exponent = 2),
  constraint affiliate_access_credit_quotes_amounts
    check (
      months between 1 and 12
      and unit_amount_minor between 1 and 9007199254740991
      and total_amount_minor = unit_amount_minor * months
      and duration_days = 30 * months
    ),
  constraint affiliate_access_credit_quotes_expiry
    check (
      expires_at > created_at
      and expires_at <= created_at + interval '20 minutes'
    ),
  constraint affiliate_access_credit_quotes_redemption
    check ((status = 'redeemed') = (redeemed_at is not null))
);

create index affiliate_access_credit_quotes_account_idx
  on affiliate_private.affiliate_access_credit_quotes (
    account_id,
    created_at desc
  );

create table affiliate_private.affiliate_access_credit_redemptions (
  id                 uuid primary key default gen_random_uuid(),
  redemption_key     text not null unique default (
    'crd_' || left(encode(extensions.gen_random_bytes(16), 'hex'), 24)
  ),
  quote_id           uuid not null unique
    references affiliate_private.affiliate_access_credit_quotes(id)
    on delete restrict,
  account_id         uuid not null
    references affiliate_private.affiliate_accounts(id)
    on delete restrict,
  ledger_entry_id    uuid not null unique
    references affiliate_private.affiliate_commission_entries(id)
    on delete restrict,
  plan_code          text not null,
  currency           text not null,
  currency_exponent  integer not null,
  months             integer not null,
  amount_minor       bigint not null,
  duration_days      integer not null,
  status             text not null default 'granted',
  created_at         timestamptz not null default now(),
  constraint affiliate_access_credit_redemptions_key
    check (redemption_key ~ '^crd_[0-9a-f]{24}$'),
  constraint affiliate_access_credit_redemptions_status
    check (status = 'granted'),
  constraint affiliate_access_credit_redemptions_usd
    check (currency = 'USD' and currency_exponent = 2),
  constraint affiliate_access_credit_redemptions_amount
    check (
      months between 1 and 12
      and amount_minor between 1 and 9007199254740991
      and duration_days = months * 30
    )
);

create index affiliate_access_credit_redemptions_account_idx
  on affiliate_private.affiliate_access_credit_redemptions (
    account_id,
    created_at desc
  );

create table public.cloud_access_grants (
  id                uuid primary key default gen_random_uuid(),
  grant_key         text not null unique default (
    'cag_' || left(encode(extensions.gen_random_bytes(16), 'hex'), 24)
  ),
  user_id           uuid references auth.users(id) on delete restrict,
  user_pseudonym    text not null,
  redemption_id     uuid not null unique
    references affiliate_private.affiliate_access_credit_redemptions(id)
    on delete restrict,
  source            text not null default 'partners_credit',
  plan_code         text not null,
  status            text not null default 'queued',
  duration_seconds  bigint not null,
  remaining_seconds bigint not null,
  active_from       timestamptz,
  active_until      timestamptz,
  paused_at         timestamptz,
  consumed_at       timestamptz,
  revoked_at        timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint cloud_access_grants_key
    check (grant_key ~ '^cag_[0-9a-f]{24}$'),
  constraint cloud_access_grants_user_pseudonym
    check (user_pseudonym ~ '^[0-9a-f]{64}$'),
  constraint cloud_access_grants_source
    check (source = 'partners_credit'),
  constraint cloud_access_grants_plan
    check (plan_code in ('plus', 'family', 'premium')),
  constraint cloud_access_grants_status
    check (
      status in (
        'queued', 'active', 'paused_provider', 'consumed', 'revoked'
      )
    ),
  constraint cloud_access_grants_duration
    check (
      duration_seconds between 86400 and 31622400
      and remaining_seconds between 0 and duration_seconds
    ),
  constraint cloud_access_grants_active_range
    check (
      (
        status = 'active'
        and active_from is not null
        and active_until is not null
        and active_until > active_from
        and remaining_seconds > 0
      )
      or (
        status <> 'active'
        and active_from is null
        and active_until is null
      )
    ),
  constraint cloud_access_grants_terminal_state
    check (
      (status = 'consumed') = (consumed_at is not null)
      and (status = 'revoked') = (revoked_at is not null)
    ),
  constraint cloud_access_grants_user_retention
    check (
      user_id is not null
      or status in ('consumed', 'revoked')
    )
);

create unique index cloud_access_grants_one_active_per_user_idx
  on public.cloud_access_grants (user_id)
  where status = 'active';
create index cloud_access_grants_queue_idx
  on public.cloud_access_grants (user_id, created_at, id)
  where status in ('queued', 'paused_provider', 'active');

alter table affiliate_private.affiliate_access_credit_catalog
  enable row level security;
alter table affiliate_private.affiliate_access_credit_quotes
  enable row level security;
alter table affiliate_private.affiliate_access_credit_redemptions
  enable row level security;
alter table public.cloud_access_grants enable row level security;

revoke all on table
  affiliate_private.affiliate_access_credit_catalog,
  affiliate_private.affiliate_access_credit_quotes,
  affiliate_private.affiliate_access_credit_redemptions
from public, anon, authenticated, service_role;
revoke all on table public.cloud_access_grants
  from public, anon, authenticated, service_role;
grant select on table public.cloud_access_grants to service_role;

-- The access overlay must not make auth.users undeletable. Terminal grants are
-- retained under the same deterministic pseudonym as the immutable affiliate
-- ledger, while queued/active grants are revoked in the account-deletion
-- transaction. The existing deletion routine is upgraded fail-closed: any
-- drift in its audited body aborts this migration.
create or replace function
affiliate_private.partners_account_deletion_ready(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_user_id is not null
    and not exists (
      select 1
      from affiliate_private.affiliate_accounts account
      where account.user_id = p_user_id
    )
    and not exists (
      select 1
      from affiliate_private.affiliate_link_claims claim
      where claim.consumed_by_user_id = p_user_id
    )
    and not exists (
      select 1
      from affiliate_private.affiliate_attributions attribution
      where attribution.referred_user_id = p_user_id
    )
    and not exists (
      select 1
      from affiliate_private.affiliate_financial_facts fact
      where fact.referred_user_id = p_user_id
    )
    and not exists (
      select 1
      from affiliate_private.affiliate_tv_relay_sessions relay
      where relay.consumed_by_user_id = p_user_id
    )
    and not exists (
      select 1
      from affiliate_private.affiliate_tv_relay_sessions relay
      join public.cloud_devices device on device.id = relay.device_id
      where device.user_id = p_user_id
    )
    and not exists (
      select 1
      from affiliate_private.affiliate_admin_capabilities capability
      where capability.user_id = p_user_id
    )
    and not exists (
      select 1
      from affiliate_private.affiliate_pilot_allowlist allowlist_row
      where allowlist_row.user_id = p_user_id
    )
    and not exists (
      select 1
      from affiliate_private.affiliate_service_idempotency idempotency
      where idempotency.user_id = p_user_id
    )
    and not exists (
      select 1
      from public.cloud_access_grants grant_row
      where grant_row.user_id = p_user_id
    );
$$;

do $partners_member_privacy_and_risk_upgrade$
declare
  v_oid regprocedure;
  v_definition text;
  v_rewritten text;
  v_expected text;
  v_replacement text;
begin
  v_oid := to_regprocedure(
    'affiliate_private.partners_service_prepare_account_deletion(uuid)'
  );
  if v_oid is null then
    raise exception 'Partners deletion preparation function is unavailable'
      using errcode = '55000';
  end if;
  v_definition := pg_get_functiondef(v_oid);
  v_rewritten := v_definition;

  v_expected := E'  for v_account in\n    select a.*\n    from affiliate_private.affiliate_accounts a\n    where a.user_id = p_user_id';
  v_replacement := E'  update public.cloud_access_grants grant_row\n  set\n    user_id = null,\n    user_pseudonym = v_user_pseudonym,\n    status = case\n      when grant_row.status = ''consumed'' then ''consumed''\n      else ''revoked''\n    end,\n    remaining_seconds = 0,\n    active_from = null,\n    active_until = null,\n    consumed_at = case\n      when grant_row.status = ''consumed'' then grant_row.consumed_at\n      else null\n    end,\n    revoked_at = case\n      when grant_row.status = ''consumed'' then null\n      else coalesce(grant_row.revoked_at, now())\n    end,\n    updated_at = now()\n  where grant_row.user_id = p_user_id;\n  get diagnostics v_rows = row_count;\n  v_changes := v_changes + v_rows;\n\n' || v_expected;
  if position(v_expected in v_rewritten) = 0 then
    raise exception 'Partners deletion grant hook drifted'
      using errcode = '55000';
  end if;
  v_rewritten := replace(v_rewritten, v_expected, v_replacement);

  v_expected := E'      user_id = null,\n      status = ''closed'',';
  v_replacement := E'      user_id = null,\n      status = ''closed'',\n      member_status = ''closed'',';
  if position(v_expected in v_rewritten) = 0 then
    raise exception 'Partners deletion membership transition drifted'
      using errcode = '55000';
  end if;
  v_rewritten := replace(v_rewritten, v_expected, v_replacement);
  execute v_rewritten;

  v_oid := to_regprocedure(
    'affiliate_private.admin_partners_account_action(text,text,text,text)'
  );
  if v_oid is null then
    raise exception 'Partners Risk account action is unavailable'
      using errcode = '55000';
  end if;
  v_definition := pg_get_functiondef(v_oid);
  v_rewritten := v_definition;

  v_expected := E'  v_target_status text;\n  v_actor text;';
  v_replacement := E'  v_target_status text;\n  v_target_member_status text;\n  v_actor text;';
  if position(v_expected in v_rewritten) = 0 then
    raise exception 'Partners Risk member declaration drifted'
      using errcode = '55000';
  end if;
  v_rewritten := replace(v_rewritten, v_expected, v_replacement);

  v_expected := E'  end;\n  if v_account.status = v_target_status then';
  v_replacement := E'  end;\n  v_target_member_status := case\n    when v_account.member_status = ''not_joined'' then ''not_joined''\n    when v_action = ''release'' then ''active''\n    else v_target_status\n  end;\n  if v_account.status = v_target_status\n    and v_account.member_status = v_target_member_status\n  then';
  if position(v_expected in v_rewritten) = 0 then
    raise exception 'Partners Risk no-op guard drifted'
      using errcode = '55000';
  end if;
  v_rewritten := replace(v_rewritten, v_expected, v_replacement);

  v_expected := E'    status = v_target_status,\n    closed_at = case';
  v_replacement := E'    status = v_target_status,\n    member_status = v_target_member_status,\n    closed_at = case';
  if position(v_expected in v_rewritten) = 0 then
    raise exception 'Partners Risk account mutation drifted'
      using errcode = '55000';
  end if;
  v_rewritten := replace(v_rewritten, v_expected, v_replacement);

  v_expected := E'    jsonb_build_object(''status'', v_account.status),\n    jsonb_build_object(''status'', v_target_status)';
  v_replacement := E'    jsonb_build_object(\n      ''status'', v_account.status,\n      ''member_status'', v_account.member_status\n    ),\n    jsonb_build_object(\n      ''status'', v_target_status,\n      ''member_status'', v_target_member_status\n    )';
  if position(v_expected in v_rewritten) = 0 then
    raise exception 'Partners Risk audit state drifted'
      using errcode = '55000';
  end if;
  v_rewritten := replace(v_rewritten, v_expected, v_replacement);
  execute v_rewritten;
end;
$partners_member_privacy_and_risk_upgrade$;

alter table affiliate_private.affiliate_commission_entries
  drop constraint affiliate_commission_entries_kind;
alter table affiliate_private.affiliate_commission_entries
  add constraint affiliate_commission_entries_kind
  check (
    entry_kind in (
      'accrual', 'reversal', 'manual_reversal', 'reinstatement',
      'release', 'recovery_offset', 'payout_allocation',
      'payout_settlement', 'payout_release', 'payout_return',
      'payout_late_settlement', 'payout_duplicate_settlement',
      'access_credit_redemption'
    )
  );

alter table affiliate_private.affiliate_commission_entries
  drop constraint affiliate_commission_entries_attribution_scope;
alter table affiliate_private.affiliate_commission_entries
  add constraint affiliate_commission_entries_attribution_scope
  check (
    (
      entry_kind in (
        'accrual', 'reversal', 'manual_reversal', 'reinstatement', 'release'
      )
      and attribution_id is not null
    )
    or (
      entry_kind in (
        'recovery_offset', 'payout_allocation', 'payout_settlement',
        'payout_release', 'payout_return', 'payout_late_settlement',
        'payout_duplicate_settlement', 'access_credit_redemption'
      )
      and attribution_id is null
    )
  );

alter table affiliate_private.affiliate_commission_entries
  drop constraint affiliate_commission_entries_relation;
alter table affiliate_private.affiliate_commission_entries
  add constraint affiliate_commission_entries_relation
  check (
    (
      entry_kind = 'accrual'
      and fact_id is not null
      and related_entry_id is null
      and matures_at is not null
    )
    or (
      entry_kind in ('reversal', 'reinstatement', 'release')
      and fact_id is not null
      and related_entry_id is not null
      and matures_at is null
    )
    or (
      entry_kind = 'manual_reversal'
      and fact_id is null
      and related_entry_id is not null
      and matures_at is null
    )
    or (
      entry_kind in (
        'payout_allocation', 'recovery_offset', 'access_credit_redemption'
      )
      and fact_id is null
      and related_entry_id is null
      and matures_at is null
    )
    or (
      entry_kind in (
        'payout_settlement', 'payout_release', 'payout_return',
        'payout_late_settlement', 'payout_duplicate_settlement'
      )
      and fact_id is null
      and related_entry_id is not null
      and matures_at is null
    )
  );

alter table affiliate_private.affiliate_commission_postings
  drop constraint affiliate_commission_postings_account;
alter table affiliate_private.affiliate_commission_postings
  add constraint affiliate_commission_postings_account
  check (
    ledger_account in (
      'platform_commission_expense',
      'platform_commission_recovery',
      'partner_commission_pending',
      'partner_commission_available',
      'partner_payout_clearing',
      'partner_cash_settled',
      'partner_recovery_due',
      'partner_access_credit_clearing'
    )
  );

create or replace function
affiliate_private.partners_access_credit_balances(
  p_account_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with balance as (
    select
      coalesce(sum(case
        when posting.ledger_account = 'partner_commission_pending'
          and posting.direction = 'credit' then posting.amount_minor
        when posting.ledger_account = 'partner_commission_pending'
          and posting.direction = 'debit' then -posting.amount_minor
        else 0
      end), 0)::bigint as pending_minor,
      coalesce(sum(case
        when posting.ledger_account = 'partner_commission_available'
          and posting.direction = 'credit' then posting.amount_minor
        when posting.ledger_account = 'partner_commission_available'
          and posting.direction = 'debit' then -posting.amount_minor
        else 0
      end), 0)::bigint as available_gross_minor,
      coalesce(sum(case
        when posting.ledger_account = 'partner_recovery_due'
          and posting.direction = 'debit' then posting.amount_minor
        when posting.ledger_account = 'partner_recovery_due'
          and posting.direction = 'credit' then -posting.amount_minor
        else 0
      end), 0)::bigint as recovery_due_minor,
      coalesce(sum(case
        when posting.ledger_account = 'partner_access_credit_clearing'
          and posting.direction = 'credit' then posting.amount_minor
        when posting.ledger_account = 'partner_access_credit_clearing'
          and posting.direction = 'debit' then -posting.amount_minor
        else 0
      end), 0)::bigint as redeemed_minor
    from affiliate_private.affiliate_commission_postings posting
    join affiliate_private.affiliate_commission_entries entry
      on entry.id = posting.entry_id
    where entry.account_id = p_account_id
      and posting.currency = 'USD'
  )
  select jsonb_build_object(
    'currency', 'USD',
    'currency_exponent', 2,
    'pending_minor', greatest(pending_minor, 0),
    'available_minor', greatest(
      available_gross_minor - greatest(recovery_due_minor, 0),
      0
    ),
    'recovery_due_minor', greatest(recovery_due_minor, 0),
    'redeemed_minor', greatest(redeemed_minor, 0)
  )
  from balance;
$$;

-- Dashboard balances expose every ledger currency exactly as posted. No FX is
-- performed and no synthetic USD row is manufactured for a non-USD account.
create or replace function affiliate_private.partners_account_balances(
  p_account_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_balances jsonb := '[]'::jsonb;
  v_currency_count integer := 0;
begin
  if p_account_id is null then
    return v_balances;
  end if;

  if exists (
    select 1
    from affiliate_private.affiliate_commission_entries entry
    join affiliate_private.affiliate_commission_postings posting
      on posting.entry_id = entry.id
    where entry.account_id = p_account_id
    group by posting.currency
    having count(distinct entry.currency_exponent) <> 1
  ) then
    raise exception 'Partner balance currency exponent is inconsistent'
      using errcode = '55000';
  end if;

  select count(distinct posting.currency)
  into v_currency_count
  from affiliate_private.affiliate_commission_entries entry
  join affiliate_private.affiliate_commission_postings posting
    on posting.entry_id = entry.id
  where entry.account_id = p_account_id;
  if v_currency_count > 32 then
    raise exception 'Partner balance currency limit exceeded'
      using errcode = '54000';
  end if;

  with balances as (
    select
      posting.currency,
      min(entry.currency_exponent) as currency_exponent,
      coalesce(sum(case
        when posting.ledger_account = 'partner_commission_pending'
          and posting.direction = 'credit' then posting.amount_minor
        when posting.ledger_account = 'partner_commission_pending'
          and posting.direction = 'debit' then -posting.amount_minor
        else 0
      end), 0)::bigint as pending_minor,
      coalesce(sum(case
        when posting.ledger_account = 'partner_commission_available'
          and posting.direction = 'credit' then posting.amount_minor
        when posting.ledger_account = 'partner_commission_available'
          and posting.direction = 'debit' then -posting.amount_minor
        else 0
      end), 0)::bigint as available_gross_minor,
      coalesce(sum(case
        when posting.ledger_account = 'partner_recovery_due'
          and posting.direction = 'debit' then posting.amount_minor
        when posting.ledger_account = 'partner_recovery_due'
          and posting.direction = 'credit' then -posting.amount_minor
        else 0
      end), 0)::bigint as recovery_due_minor,
      coalesce(sum(case
        when posting.ledger_account = 'partner_access_credit_clearing'
          and posting.direction = 'credit' then posting.amount_minor
        when posting.ledger_account = 'partner_access_credit_clearing'
          and posting.direction = 'debit' then -posting.amount_minor
        else 0
      end), 0)::bigint as redeemed_minor
    from affiliate_private.affiliate_commission_entries entry
    join affiliate_private.affiliate_commission_postings posting
      on posting.entry_id = entry.id
    where entry.account_id = p_account_id
    group by posting.currency
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'currency', balance.currency,
      'currency_exponent', balance.currency_exponent,
      'pending_minor', greatest(balance.pending_minor, 0),
      'available_minor', greatest(
        balance.available_gross_minor
          - greatest(balance.recovery_due_minor, 0),
        0
      ),
      'recovery_due_minor', greatest(balance.recovery_due_minor, 0),
      'redeemed_minor', greatest(balance.redeemed_minor, 0)
    ) order by balance.currency
  ), '[]'::jsonb)
  into v_balances
  from balances balance;

  return v_balances;
end;
$$;

-- Cash eligibility deliberately remains independent from membership and
-- access-credit eligibility. Keep one authoritative, ordered reason matrix so
-- join, bootstrap, status and dashboard never disagree about the next step.
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

  v_ready :=
    v_account.member_status = 'active'
    and v_account.status = 'active'
    and v_account.verification_status = 'verified'
    and exists (
      select 1
      from affiliate_private.affiliate_fiscal_profiles fiscal
      where fiscal.account_id = v_account.id
        and fiscal.status = 'verified'
    )
    and exists (
      select 1
      from affiliate_private.affiliate_payout_profiles profile
      join affiliate_private.affiliate_payout_provider_configs route
        on route.provider = profile.provider
        and route.country_code = v_account.country_code
        and route.currency = profile.currency
      where profile.account_id = v_account.id
        and profile.status = 'active'
        and route.status = 'active'
    );

  v_reason := case
    when v_account.member_status in ('held', 'suspended', 'closed')
      or v_account.status in ('held', 'suspended', 'closed')
      then 'account_blocked'
    when v_account.member_status <> 'active' then 'membership_required'
    when v_account.status <> 'active'
      or v_account.verification_status <> 'verified'
      then 'kyc_required'
    when not exists (
      select 1
      from affiliate_private.affiliate_fiscal_profiles fiscal
      where fiscal.account_id = v_account.id
        and fiscal.status = 'verified'
    ) then 'fiscal_profile_required'
    when not v_ready then 'corridor_required'
    else null
  end;

  return jsonb_build_object('ready', v_ready, 'reason', v_reason);
end;
$$;

create or replace function affiliate_private.partners_service_join_v2(
  p_user_id uuid,
  p_terms_accepted boolean,
  p_disclosure_accepted boolean,
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
  v_program affiliate_private.affiliate_program_versions%rowtype;
  v_account affiliate_private.affiliate_accounts%rowtype;
  v_link affiliate_private.affiliate_links%rowtype;
  v_pseudonym text;
  v_now timestamptz := clock_timestamp();
  v_cash_readiness jsonb;
  v_has_account boolean := false;
  v_membership_transitioned boolean := false;
begin
  if p_user_id is null
    or p_terms_accepted is distinct from true
    or p_disclosure_accepted is distinct from true
    or p_idempotency_key is null
    or p_idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$'
  then
    raise exception 'invalid Partners membership request'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('norva:partners:user:' || p_user_id::text, 0)
  );

  select program.*
  into v_program
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
    )
  order by program.effective_from desc
  limit 1
  for share;
  if not found then
    raise exception 'active Partners program is unavailable'
      using errcode = '55000';
  end if;

  v_request_hash := encode(
    extensions.digest(
      concat_ws(
        chr(31),
        'membership_join:v2',
        p_user_id::text,
        v_program.id::text,
        v_program.terms_version,
        v_program.disclosure_version
      ),
      'sha256'
    ),
    'hex'
  );
  v_replay := affiliate_private.partners_replayed_response(
    'membership_join',
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
    raise exception 'Partners membership is disabled'
      using errcode = 'P0001';
  end if;

  select account.*
  into v_account
  from affiliate_private.affiliate_accounts account
  where account.user_id = p_user_id
    and account.status <> 'closed'
  for update;
  v_has_account := found;

  if v_has_account
    and v_account.member_status in ('held', 'suspended', 'closed')
  then
    raise exception 'Partners membership is unavailable'
      using errcode = 'P0001';
  end if;

  if not v_has_account then
    v_pseudonym := encode(
      extensions.digest(
        'norva-partners-subject:v1:' || p_user_id::text,
        'sha256'
      ),
      'hex'
    );
    insert into affiliate_private.affiliate_accounts (
      user_id,
      user_pseudonym,
      account_type,
      status,
      verification_status,
      contract_status,
      member_status,
      member_program_version_id,
      member_terms_version_accepted,
      member_terms_accepted_at,
      member_disclosure_version_accepted,
      member_disclosure_accepted_at,
      member_joined_at
    ) values (
      p_user_id,
      v_pseudonym,
      'individual',
      'pending_verification',
      'not_started',
      'not_accepted',
      'active',
      v_program.id,
      v_program.terms_version,
      v_now,
      v_program.disclosure_version,
      v_now,
      v_now
    ) returning * into v_account;
    v_membership_transitioned := true;
  elsif v_account.member_status = 'not_joined' then
    update affiliate_private.affiliate_accounts account
    set
      status = case
        when account.status = 'invited' then 'pending_verification'
        else account.status
      end,
      member_status = 'active',
      member_program_version_id = v_program.id,
      member_terms_version_accepted = v_program.terms_version,
      member_terms_accepted_at = v_now,
      member_disclosure_version_accepted = v_program.disclosure_version,
      member_disclosure_accepted_at = v_now,
      member_joined_at = v_now,
      updated_at = now()
    where account.id = v_account.id
    returning * into v_account;
    v_membership_transitioned := true;
  elsif v_account.member_program_version_id <> v_program.id then
    raise exception 'membership program renewal requires explicit migration'
      using errcode = 'P0004';
  end if;

  select link.*
  into v_link
  from affiliate_private.affiliate_links link
  where link.account_id = v_account.id
    and link.status = 'active'
  for update;
  if not found then
    insert into affiliate_private.affiliate_links (account_id)
    values (v_account.id)
    returning * into v_link;
  end if;

  v_cash_readiness := affiliate_private.partners_cash_readiness(v_account.id);

  if v_membership_transitioned then
    insert into affiliate_private.affiliate_events (
      aggregate_type,
      aggregate_key,
      action,
      actor_type,
      actor_pseudonym,
      justification,
      after_state
    ) values (
      'account',
      v_account.id::text,
      'membership_joined',
      'service',
      v_account.user_pseudonym,
      'Confirmed Cloud user accepted the active Partners program.',
      jsonb_build_object(
        'member_status', 'active',
        'verification_status', v_account.verification_status,
        'link_status', 'active'
      )
    );
  end if;

  v_response := jsonb_build_object(
    'schema_version', 2,
    'action', 'membership_joined',
    'replayed', false,
    'changed', v_membership_transitioned,
    'membership', jsonb_build_object(
      'status', v_account.member_status,
      'joined_at', v_account.member_joined_at,
      'verification_status', v_account.verification_status
    ),
    'program', jsonb_build_object(
      'commission_rate_bps', v_program.commission_rate_bps,
      'attribution_window_days', v_program.attribution_window_days,
      'maturation_days', v_program.maturation_days,
      'terms_version', v_program.terms_version,
      'disclosure_version', v_program.disclosure_version
    ),
    'link', jsonb_build_object(
      'status', 'active',
      'share_url', 'https://norva.tv/r/' || v_link.public_code,
      'created_at', v_link.created_at
    ),
    'cash_readiness', v_cash_readiness,
    'next_action', 'share_link'
  );
  perform affiliate_private.partners_store_response(
    'membership_join',
    p_user_id,
    p_idempotency_key,
    v_request_hash,
    v_response
  );
  return v_response;
end;
$$;

create or replace function
affiliate_private.partners_service_access_grants_reconcile(
  p_user_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_provider_status text;
  v_provider text;
  v_provider_period_end timestamptz;
  v_provider_trial_end timestamptz;
  v_provider_fail_open_until timestamptz;
  v_provider_last_verified_at timestamptz;
  v_provider_reason text := 'subscription_required';
  v_provider_fail_open boolean := false;
  v_provider_active boolean := false;
  v_hard_block boolean := false;
  v_active public.cloud_access_grants%rowtype;
  v_candidate public.cloud_access_grants%rowtype;
  v_queued integer := 0;
  v_remaining bigint := 0;
begin
  if p_user_id is null then
    raise exception 'user id is required' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended('norva:access-grants:user:' || p_user_id::text, 0)
  );

  select
    projection.status,
    lower(projection.provider),
    projection.current_period_end,
    projection.trial_ends_at,
    projection.fail_open_until,
    projection.last_verified_at
  into
    v_provider_status,
    v_provider,
    v_provider_period_end,
    v_provider_trial_end,
    v_provider_fail_open_until,
    v_provider_last_verified_at
  from public.cloud_entitlement_projection projection
  where projection.user_id = p_user_id;

  v_hard_block := coalesce(
    v_provider_status in ('revoked', 'refunded', 'fraud'),
    false
  );

  -- Mirror _shared/entitlement-evaluator.mjs exactly for the provider
  -- branches that are allowed to serve content. An allowed provider branch,
  -- including fail-open and recently-verified grace, always pauses the
  -- additive credit clock. Terminal billing blocks take priority and never
  -- activate a credit as a way around a revoke, refund or fraud decision.
  if v_hard_block then
    v_provider_reason := v_provider_status;
  elsif v_provider_status = 'trialing' then
    v_provider_active := coalesce(
      coalesce(v_provider_trial_end, v_provider_period_end) > now(),
      false
    );
    v_provider_reason := case
      when v_provider_active then 'trialing'
      when coalesce(v_provider_trial_end, v_provider_period_end) is null
        then 'billing_unverified'
      else 'trial_expired'
    end;
  elsif v_provider_status = 'active' then
    if v_provider_period_end > now()
      or (
        v_provider_period_end is null
        and v_provider in ('system', 'manual')
      )
    then
      v_provider_active := true;
      v_provider_reason := 'active';
    elsif v_provider_fail_open_until > now() then
      v_provider_active := true;
      v_provider_fail_open := true;
      v_provider_reason := 'billing_grace';
    elsif v_provider_last_verified_at + interval '72 hours' > now() then
      v_provider_active := true;
      v_provider_fail_open := true;
      v_provider_reason := 'billing_recently_verified';
    else
      v_provider_reason := case
        when v_provider_period_end is null then 'billing_unverified'
        else 'subscription_expired'
      end;
    end if;
  elsif v_provider_status = 'cancelled_at_period_end' then
    v_provider_active := coalesce(v_provider_period_end > now(), false);
    v_provider_reason := case
      when v_provider_active then 'cancelled_at_period_end'
      when v_provider_period_end is null then 'billing_unverified'
      else 'subscription_expired'
    end;
  elsif v_provider_status in ('grace', 'past_due', 'unknown') then
    if v_provider_period_end > now()
      or v_provider_fail_open_until > now()
    then
      v_provider_active := true;
      v_provider_fail_open := true;
      v_provider_reason := 'billing_grace';
    elsif v_provider_last_verified_at + interval '72 hours' > now() then
      v_provider_active := true;
      v_provider_fail_open := true;
      v_provider_reason := 'billing_recently_verified';
    else
      v_provider_reason := 'billing_unverified';
    end if;
  elsif v_provider_status = 'expired' then
    v_provider_reason := 'subscription_expired';
  end if;

  update public.cloud_access_grants grant_row
  set
    status = 'consumed',
    remaining_seconds = 0,
    active_from = null,
    active_until = null,
    consumed_at = now(),
    updated_at = now()
  where grant_row.user_id = p_user_id
    and grant_row.status = 'active'
    and grant_row.active_until <= now();

  if v_provider_active or v_hard_block then
    update public.cloud_access_grants grant_row
    set
      status = 'paused_provider',
      remaining_seconds = greatest(
        ceil(extract(epoch from grant_row.active_until - now()))::bigint,
        1
      ),
      active_from = null,
      active_until = null,
      paused_at = now(),
      updated_at = now()
    where grant_row.user_id = p_user_id
      and grant_row.status = 'active';

    update public.cloud_access_grants grant_row
    set
      status = 'paused_provider',
      paused_at = coalesce(grant_row.paused_at, now()),
      updated_at = now()
    where grant_row.user_id = p_user_id
      and grant_row.status = 'queued';
  else
    select grant_row.*
    into v_active
    from public.cloud_access_grants grant_row
    where grant_row.user_id = p_user_id
      and grant_row.status = 'active'
    for update;

    if not found then
      select grant_row.*
      into v_candidate
      from public.cloud_access_grants grant_row
      where grant_row.user_id = p_user_id
        and grant_row.status in ('queued', 'paused_provider')
      order by grant_row.created_at, grant_row.id
      limit 1
      for update;
      if found then
        update public.cloud_access_grants grant_row
        set
          status = 'active',
          active_from = now(),
          active_until = now()
            + make_interval(secs => v_candidate.remaining_seconds::double precision),
          paused_at = null,
          updated_at = now()
        where grant_row.id = v_candidate.id
        returning * into v_active;
      end if;
    end if;
  end if;

  select grant_row.*
  into v_active
  from public.cloud_access_grants grant_row
  where grant_row.user_id = p_user_id
    and grant_row.status = 'active';
  if found then
    v_remaining := greatest(
      ceil(extract(epoch from v_active.active_until - now()))::bigint,
      0
    );
  end if;
  select count(*)
  into v_queued
  from public.cloud_access_grants grant_row
  where grant_row.user_id = p_user_id
    and grant_row.status in ('queued', 'paused_provider');

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'access_grants_reconciled',
    'provider', jsonb_build_object(
      'provider', v_provider,
      'status', v_provider_status,
      'active', v_provider_active,
      'hard_block', v_hard_block,
      'reason', v_provider_reason,
      'fail_open', v_provider_fail_open,
      'current_period_end', v_provider_period_end,
      'trial_ends_at', v_provider_trial_end,
      'fail_open_until', v_provider_fail_open_until,
      'last_verified_at', v_provider_last_verified_at
    ),
    'overlay', jsonb_build_object(
      'status', case
        when v_hard_block then 'blocked_provider'
        when v_provider_active then 'paused_provider'
        when v_active.id is not null then 'active'
        when v_queued > 0 then 'queued'
        else 'none'
      end,
      'active_grant', case
        when v_active.id is null then null
        else jsonb_build_object(
          'key', v_active.grant_key,
          'status', v_active.status,
          'plan_code', v_active.plan_code,
          'remaining_seconds', v_remaining,
          'active_from', v_active.active_from,
          'active_until', v_active.active_until
        )
      end,
      'queued_grants', v_queued,
      'remaining_seconds', v_remaining
    )
  );
end;
$$;

-- Stop an active credit clock in the same transaction that makes a provider
-- entitlement authoritative (or hard-blocked). This event-driven path avoids
-- spending credit between a purchase/webhook write and the next API read.
-- The reconciler itself is user-scoped, serialized by its advisory lock and
-- never writes cloud_entitlement_projection.
create or replace function
affiliate_private.reconcile_access_grants_after_projection()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Always enter the per-user access-grant lock. Testing for a visible grant
  -- first can miss a concurrent, still-uncommitted redemption and leave its
  -- clock active after this provider projection commits. The reconciler uses
  -- an MVCC read of this row (not FOR SHARE): an AFTER trigger already owns
  -- the projection row lock, so taking the advisory lock and then requesting
  -- a second projection lock would invert the redemption order and permit a
  -- projection-row <-> access-grant advisory-lock deadlock.
  perform affiliate_private.partners_service_access_grants_reconcile(
    new.user_id
  );
  return null;
end;
$$;

create trigger cloud_entitlement_projection_access_grants_insert
after insert on public.cloud_entitlement_projection
for each row execute function
  affiliate_private.reconcile_access_grants_after_projection();

create trigger cloud_entitlement_projection_access_grants_update
after update of
  provider,
  status,
  current_period_end,
  trial_ends_at,
  fail_open_until,
  last_verified_at
on public.cloud_entitlement_projection
for each row
when (
  old.provider is distinct from new.provider
  or old.status is distinct from new.status
  or old.current_period_end is distinct from new.current_period_end
  or old.trial_ends_at is distinct from new.trial_ends_at
  or old.fail_open_until is distinct from new.fail_open_until
  or old.last_verified_at is distinct from new.last_verified_at
)
execute function affiliate_private.reconcile_access_grants_after_projection();

create or replace function
affiliate_private.partners_service_access_credit_status(
  p_user_id uuid
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
  v_balances jsonb;
  v_overlay jsonb;
  v_next_maturation timestamptz;
  v_credit_enabled boolean := false;
  v_has_any_balance boolean := false;
  v_has_usd_balance boolean := false;
  v_credit_reason text;
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
    raise exception 'Partners membership is unavailable'
      using errcode = 'P1001';
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
    and catalog.effective_from <= now()
    and (
      catalog.effective_until is null
      or catalog.effective_until > now()
    )
  order by catalog.effective_from desc
  limit 1;

  v_balances := affiliate_private.partners_access_credit_balances(
    v_account.id
  );
  v_overlay := affiliate_private.partners_service_access_grants_reconcile(
    p_user_id
  );
  select min(entry.matures_at)
  into v_next_maturation
  from affiliate_private.affiliate_commission_entries entry
  where entry.account_id = v_account.id
    and entry.entry_kind = 'accrual'
    and entry.matures_at > now()
    and not exists (
      select 1
      from affiliate_private.affiliate_commission_entries release
      where release.related_entry_id = entry.id
        and release.entry_kind = 'release'
    );

  select coalesce(flag.enabled, false)
  into v_credit_enabled
  from public.admin_feature_flags flag
  where flag.key = 'partners_credit_redemptions_enabled';
  v_credit_enabled := coalesce(v_credit_enabled, false);

  select
    exists (
      select 1
      from affiliate_private.affiliate_commission_entries entry
      join affiliate_private.affiliate_commission_postings posting
        on posting.entry_id = entry.id
      where entry.account_id = v_account.id
    ),
    exists (
      select 1
      from affiliate_private.affiliate_commission_entries entry
      join affiliate_private.affiliate_commission_postings posting
        on posting.entry_id = entry.id
      where entry.account_id = v_account.id
        and posting.currency = 'USD'
    )
  into v_has_any_balance, v_has_usd_balance;

  v_credit_reason := case
    when v_account.member_status <> 'active' then 'membership_required'
    when not v_credit_enabled then 'credits_disabled'
    when v_has_any_balance and not v_has_usd_balance
      then 'currency_not_supported'
    when v_catalog.id is null then 'catalog_unavailable'
    else null
  end;

  v_cash_readiness := affiliate_private.partners_cash_readiness(v_account.id);

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'access_credit_status',
    'balance', v_balances,
    'catalog', case
      when v_credit_reason is not null then null
      else jsonb_build_object(
        'catalog_key', v_catalog.catalog_key,
        'plan_code', v_catalog.plan_code,
        'currency', v_catalog.currency,
        'currency_exponent', v_catalog.currency_exponent,
        'unit_amount_minor', v_catalog.unit_amount_minor,
        'unit_duration_days', v_catalog.unit_duration_days,
        'minimum_months', v_catalog.minimum_months,
        'maximum_months', v_catalog.maximum_months
      )
    end,
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
  v_request_hash text;
  v_replay jsonb;
  v_response jsonb;
  v_available bigint;
  v_total bigint;
begin
  if p_user_id is null
    or p_months is null
    or p_months not between 1 and 12
    or p_idempotency_key is null
    or p_idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$'
  then
    raise exception 'invalid access credit quote request'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('norva:partners:user:' || p_user_id::text, 0)
  );
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

  update affiliate_private.affiliate_access_credit_quotes quote
  set status = 'expired'
  where quote.account_id = v_account.id
    and quote.status = 'open'
    and quote.expires_at <= now();
  delete from affiliate_private.affiliate_access_credit_quotes quote
  where quote.account_id = v_account.id
    and quote.status in ('expired', 'cancelled')
    and quote.created_at < now() - interval '30 days';

  if not coalesce((
    select flag.enabled
    from public.admin_feature_flags flag
    where flag.key = 'partners_credit_redemptions_enabled'
  ), false)
  then
    raise exception 'access credit redemptions are disabled'
      using errcode = 'P1002';
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
    and (
      catalog.effective_until is null
      or catalog.effective_until > now()
    )
  order by catalog.effective_from desc
  limit 1
  for share;
  if not found then
    raise exception 'access credit catalog is unavailable'
      using errcode = 'P1005';
  end if;

  v_request_hash := encode(
    extensions.digest(
      concat_ws(
        chr(31),
        'access_credit_quote:v1',
        p_user_id::text,
        v_catalog.id::text,
        p_months::text
      ),
      'sha256'
    ),
    'hex'
  );
  v_replay := affiliate_private.partners_replayed_response(
    'access_credit_quote',
    p_user_id,
    p_idempotency_key,
    v_request_hash
  );
  if v_replay is not null then
    return v_replay;
  end if;

  v_total := v_catalog.unit_amount_minor * p_months;
  v_available := affiliate_private.partners_account_payable_balance(
    v_account.id,
    'USD'
  );
  if v_available < v_total then
    raise exception 'insufficient available Partner balance'
      using errcode = 'P1004';
  end if;

  insert into affiliate_private.affiliate_access_credit_quotes (
    account_id,
    catalog_id,
    plan_code,
    currency,
    currency_exponent,
    months,
    unit_amount_minor,
    total_amount_minor,
    duration_days,
    expires_at
  ) values (
    v_account.id,
    v_catalog.id,
    v_catalog.plan_code,
    'USD',
    2,
    p_months,
    v_catalog.unit_amount_minor,
    v_total,
    v_catalog.unit_duration_days * p_months,
    now() + interval '15 minutes'
  ) returning * into v_quote;

  v_response := jsonb_build_object(
    'schema_version', 1,
    'action', 'access_credit_quoted',
    'replayed', false,
    'quote', jsonb_build_object(
      'key', v_quote.quote_key,
      'status', v_quote.status,
      'currency', v_quote.currency,
      'currency_exponent', v_quote.currency_exponent,
      'plan_code', v_quote.plan_code,
      'months', v_quote.months,
      'unit_amount_minor', v_quote.unit_amount_minor,
      'total_amount_minor', v_quote.total_amount_minor,
      'duration_days', v_quote.duration_days,
      'expires_at', v_quote.expires_at
    ),
    'balance', jsonb_build_object(
      'currency', 'USD',
      'currency_exponent', 2,
      'available_minor', v_available
    )
  );
  perform affiliate_private.partners_store_response(
    'access_credit_quote',
    p_user_id,
    p_idempotency_key,
    v_request_hash,
    v_response
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
  v_redemption
    affiliate_private.affiliate_access_credit_redemptions%rowtype;
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
    raise exception 'invalid access credit redemption request'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('norva:partners:user:' || p_user_id::text, 0)
  );
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
  if not coalesce((
    select flag.enabled
    from public.admin_feature_flags flag
    where flag.key = 'partners_credit_redemptions_enabled'
  ), false)
  then
    raise exception 'access credit redemptions are disabled'
      using errcode = 'P1002';
  end if;

  v_request_hash := encode(
    extensions.digest(
      concat_ws(chr(31), 'access_credit_redeem:v1', p_user_id::text, v_key),
      'sha256'
    ),
    'hex'
  );
  v_replay := affiliate_private.partners_replayed_response(
    'access_credit_redeem',
    p_user_id,
    p_idempotency_key,
    v_request_hash
  );
  if v_replay is not null then
    return v_replay;
  end if;

  select quote.*
  into v_quote
  from affiliate_private.affiliate_access_credit_quotes quote
  where quote.quote_key = v_key
    and quote.account_id = v_account.id
  for update;
  if not found then
    raise exception 'access credit quote is unavailable'
      using errcode = 'P1006';
  end if;

  if v_quote.status = 'redeemed' then
    select redemption.*
    into strict v_redemption
    from affiliate_private.affiliate_access_credit_redemptions redemption
    where redemption.quote_id = v_quote.id;
    select grant_row.*
    into strict v_grant
    from public.cloud_access_grants grant_row
    where grant_row.redemption_id = v_redemption.id;
  else
    if v_quote.status <> 'open' or v_quote.expires_at <= now() then
      raise exception 'access credit quote expired'
        using errcode = 'P1003';
    end if;
    select catalog.*
    into v_catalog
    from affiliate_private.affiliate_access_credit_catalog catalog
    where catalog.id = v_quote.catalog_id
    for share;
    if not found
      or v_quote.currency <> 'USD'
      or v_quote.currency_exponent <> 2
      or v_quote.plan_code <> v_catalog.plan_code
      or v_quote.unit_amount_minor <> v_catalog.unit_amount_minor
      or v_quote.total_amount_minor
        <> v_catalog.unit_amount_minor * v_quote.months
      or v_quote.duration_days
        <> v_catalog.unit_duration_days * v_quote.months
    then
      raise exception 'access credit quote evidence is inconsistent'
        using errcode = 'P1006';
    end if;

    perform affiliate_private.partners_balance_lock(v_account.id, 'USD');
    v_available := affiliate_private.partners_account_payable_balance(
      v_account.id,
      'USD'
    );
    if v_available < v_quote.total_amount_minor then
      raise exception 'insufficient available Partner balance'
        using errcode = 'P1004';
    end if;

    insert into affiliate_private.affiliate_commission_entries (
      account_id,
      entry_kind,
      currency,
      currency_exponent,
      amount_minor
    ) values (
      v_account.id,
      'access_credit_redemption',
      'USD',
      2,
      v_quote.total_amount_minor
    ) returning id into v_entry_id;
    insert into affiliate_private.affiliate_commission_postings (
      entry_id, ledger_account, direction, amount_minor, currency
    ) values
      (
        v_entry_id,
        'partner_commission_available',
        'debit',
        v_quote.total_amount_minor,
        'USD'
      ),
      (
        v_entry_id,
        'partner_access_credit_clearing',
        'credit',
        v_quote.total_amount_minor,
        'USD'
      );

    insert into affiliate_private.affiliate_access_credit_redemptions (
      quote_id,
      account_id,
      ledger_entry_id,
      plan_code,
      currency,
      currency_exponent,
      months,
      amount_minor,
      duration_days
    ) values (
      v_quote.id,
      v_account.id,
      v_entry_id,
      v_quote.plan_code,
      'USD',
      2,
      v_quote.months,
      v_quote.total_amount_minor,
      v_quote.duration_days
    ) returning * into v_redemption;

    insert into public.cloud_access_grants (
      user_id,
      user_pseudonym,
      redemption_id,
      plan_code,
      duration_seconds,
      remaining_seconds
    ) values (
      p_user_id,
      v_account.user_pseudonym,
      v_redemption.id,
      v_redemption.plan_code,
      v_redemption.duration_days::bigint * 86400,
      v_redemption.duration_days::bigint * 86400
    ) returning * into v_grant;

    update affiliate_private.affiliate_access_credit_quotes quote
    set status = 'redeemed', redeemed_at = now()
    where quote.id = v_quote.id;
  end if;

  v_overlay := affiliate_private.partners_service_access_grants_reconcile(
    p_user_id
  );
  select grant_row.*
  into strict v_grant
  from public.cloud_access_grants grant_row
  where grant_row.id = v_grant.id;
  v_available := affiliate_private.partners_account_payable_balance(
    v_account.id,
    'USD'
  );

  v_response := jsonb_build_object(
    'schema_version', 1,
    'action', 'access_credit_redeemed',
    'replayed', v_quote.status = 'redeemed',
    'redemption', jsonb_build_object(
      'key', v_redemption.redemption_key,
      'status', v_redemption.status,
      'currency', v_redemption.currency,
      'currency_exponent', v_redemption.currency_exponent,
      'amount_minor', v_redemption.amount_minor,
      'months', v_redemption.months
    ),
    'grant', jsonb_build_object(
      'key', v_grant.grant_key,
      'status', v_grant.status,
      'plan_code', v_grant.plan_code,
      'duration_days', v_redemption.duration_days,
      'remaining_seconds', case
        when v_grant.status = 'active' then greatest(
          ceil(extract(epoch from v_grant.active_until - now()))::bigint,
          0
        )
        else v_grant.remaining_seconds
      end,
      'active_from', v_grant.active_from,
      'active_until', v_grant.active_until
    ),
    'balance', jsonb_build_object(
      'currency', 'USD',
      'currency_exponent', 2,
      'available_minor', v_available
    ),
    'overlay', v_overlay -> 'overlay'
  );
  perform affiliate_private.partners_store_response(
    'access_credit_redeem',
    p_user_id,
    p_idempotency_key,
    v_request_hash,
    v_response
  );
  return v_response;
end;
$$;

create or replace function
affiliate_private.partners_service_bootstrap_v2(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_confirmed boolean := false;
  v_account affiliate_private.affiliate_accounts%rowtype;
  v_program affiliate_private.affiliate_program_versions%rowtype;
  v_link affiliate_private.affiliate_links%rowtype;
  v_partners_enabled boolean := false;
  v_invite_only boolean := true;
  v_cash_pilot_allowlist_only boolean := true;
  v_earnings_enabled boolean := false;
  v_credits_enabled boolean := false;
  v_payouts_live boolean := false;
  v_blocked boolean := false;
  v_cash_readiness jsonb;
begin
  if p_user_id is null then
    raise exception 'user id is required' using errcode = '22023';
  end if;
  select cloud_user.email_confirmed_at is not null
  into v_confirmed
  from auth.users cloud_user
  where cloud_user.id = p_user_id;
  if not found then
    raise exception 'Cloud user is unavailable' using errcode = 'P0002';
  end if;

  select
    coalesce(bool_or(flag.enabled) filter (
      where flag.key = 'partners_enabled'
    ), false),
    coalesce(bool_or(flag.enabled) filter (
      where flag.key = 'partners_invite_only'
    ), true),
    coalesce(bool_or(flag.enabled) filter (
      where flag.key = 'partners_cash_pilot_allowlist_only'
    ), true),
    coalesce(bool_or(flag.enabled) filter (
      where flag.key = 'partners_earnings_enabled'
    ), false),
    coalesce(bool_or(flag.enabled) filter (
      where flag.key = 'partners_credit_redemptions_enabled'
    ), false),
    coalesce(bool_or(flag.enabled) filter (
      where flag.key = 'partners_payouts_live'
    ), false)
  into
    v_partners_enabled,
    v_invite_only,
    v_cash_pilot_allowlist_only,
    v_earnings_enabled,
    v_credits_enabled,
    v_payouts_live
  from public.admin_feature_flags flag
  where flag.key in (
    'partners_enabled',
    'partners_invite_only',
    'partners_cash_pilot_allowlist_only',
    'partners_earnings_enabled',
    'partners_credit_redemptions_enabled',
    'partners_payouts_live'
  );

  select account.*
  into v_account
  from affiliate_private.affiliate_accounts account
  where account.user_id = p_user_id
    and account.status <> 'closed'
  order by account.created_at desc
  limit 1;
  if found then
    v_blocked := v_account.member_status in ('held', 'suspended', 'closed');
    if v_account.member_program_version_id is not null then
      select program.*
      into v_program
      from affiliate_private.affiliate_program_versions program
      where program.id = v_account.member_program_version_id;
    end if;
    select link.*
    into v_link
    from affiliate_private.affiliate_links link
    where link.account_id = v_account.id
      and link.status = 'active'
    order by link.created_at desc
    limit 1;
  else
    select program.*
    into v_program
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
      )
    order by program.effective_from desc
    limit 1;
  end if;
  v_cash_readiness := affiliate_private.partners_cash_readiness(v_account.id);

  return jsonb_build_object(
    'schema_version', 2,
    'flags', jsonb_build_object(
      'partners_enabled', v_partners_enabled,
      'partners_invite_only', v_invite_only,
      'partners_cash_pilot_allowlist_only', v_cash_pilot_allowlist_only,
      'partners_earnings_enabled', v_earnings_enabled,
      'partners_credit_redemptions_enabled', v_credits_enabled,
      'partners_payouts_live', v_payouts_live
    ),
    'eligibility', jsonb_build_object(
      'visible', v_partners_enabled or v_account.id is not null,
      'eligible',
        v_partners_enabled
        and v_confirmed
        and not v_blocked
        and v_program.id is not null,
      'reason', case
        when not v_confirmed then 'email_unconfirmed'
        when v_blocked then 'account_blocked'
        when not v_partners_enabled then 'disabled'
        when v_program.id is null then 'program_unavailable'
        else 'available'
      end
    ),
    'membership', jsonb_build_object(
      'exists', v_account.id is not null,
      'status', coalesce(v_account.member_status, 'not_joined'),
      'joined_at', v_account.member_joined_at,
      'verification_status', v_account.verification_status
    ),
    'program', case
      when v_program.id is null then null
      else jsonb_build_object(
        'commission_rate_bps', v_program.commission_rate_bps,
        'attribution_window_days', v_program.attribution_window_days,
        'maturation_days', v_program.maturation_days,
        'terms_version', v_program.terms_version,
        'disclosure_version', v_program.disclosure_version
      )
    end,
    'link', case
      when v_link.id is null then null
      else jsonb_build_object(
        'status', v_link.status,
        'share_url', 'https://norva.tv/r/' || v_link.public_code,
        'created_at', v_link.created_at
      )
    end,
    'credit_readiness', jsonb_build_object(
      'ready',
        v_account.member_status = 'active'
        and v_credits_enabled,
      'reason', case
        when v_account.member_status is distinct from 'active'
          then 'membership_required'
        when not v_credits_enabled then 'credits_disabled'
        else null
      end
    ),
    'cash_readiness', v_cash_readiness
  );
end;
$$;

create or replace function
affiliate_private.partners_service_dashboard_v2(
  p_user_id uuid,
  p_history_limit integer,
  p_history_cursor text,
  p_history_status text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_limit integer := coalesce(p_history_limit, 25);
  v_filter text := lower(btrim(coalesce(p_history_status, 'all')));
  v_cursor bigint;
  v_account affiliate_private.affiliate_accounts%rowtype;
  v_program affiliate_private.affiliate_program_versions%rowtype;
  v_link affiliate_private.affiliate_links%rowtype;
  v_status jsonb;
  v_balances jsonb := '[]'::jsonb;
  v_items jsonb := '[]'::jsonb;
  v_next_cursor text;
  v_candidate_count integer := 0;
  v_last_sequence bigint;
  v_flags jsonb;
begin
  if p_user_id is null
    or v_limit not between 1 and 50
    or v_filter not in (
      'all', 'pending', 'available', 'redeemed', 'paid', 'reversed'
    )
  then
    raise exception 'invalid Partners dashboard request'
      using errcode = '22023';
  end if;
  if p_history_cursor is not null then
    if p_history_cursor !~ '^history_[0-9]{20}$' then
      raise exception 'invalid history cursor' using errcode = '22023';
    end if;
    begin
      v_cursor := substring(p_history_cursor from 9)::bigint;
    exception when numeric_value_out_of_range then
      raise exception 'invalid history cursor' using errcode = '22023';
    end;
  end if;

  select account.*
  into v_account
  from affiliate_private.affiliate_accounts account
  where account.user_id = p_user_id
    and account.status <> 'closed'
  order by account.created_at desc
  limit 1;
  if not found then
    v_status := affiliate_private.partners_service_bootstrap_v2(p_user_id);
    return (v_status - 'eligibility')
      || jsonb_build_object(
        'balances', '[]'::jsonb,
        'next_maturation_at', null,
        'credit_readiness',
          (v_status -> 'credit_readiness')
          || jsonb_build_object('catalog', null),
        'overlay', jsonb_build_object(
          'status', 'none',
          'active_grant', null,
          'queued_grants', 0,
          'remaining_seconds', 0
        ),
        'provider', jsonb_build_object(
          'provider', null,
          'status', null,
          'active', false,
          'hard_block', false,
          'reason', 'subscription_required',
          'fail_open', false,
          'current_period_end', null,
          'trial_ends_at', null,
          'fail_open_until', null,
          'last_verified_at', null
        ),
        'history', jsonb_build_object(
          'status', v_filter,
          'items', '[]'::jsonb,
          'next_cursor', null
        )
      );
  end if;

  select program.*
  into v_program
  from affiliate_private.affiliate_program_versions program
  where program.id = v_account.member_program_version_id;
  select link.*
  into v_link
  from affiliate_private.affiliate_links link
  where link.account_id = v_account.id
    and link.status = 'active'
  order by link.created_at desc
  limit 1;
  v_status := affiliate_private.partners_service_access_credit_status(
    p_user_id
  );
  v_balances := affiliate_private.partners_account_balances(v_account.id);
  select jsonb_build_object(
    'partners_enabled', coalesce(bool_or(flag.enabled) filter (
      where flag.key = 'partners_enabled'
    ), false),
    'partners_invite_only', coalesce(bool_or(flag.enabled) filter (
      where flag.key = 'partners_invite_only'
    ), true),
    'partners_cash_pilot_allowlist_only', coalesce(bool_or(flag.enabled) filter (
      where flag.key = 'partners_cash_pilot_allowlist_only'
    ), true),
    'partners_earnings_enabled', coalesce(bool_or(flag.enabled) filter (
      where flag.key = 'partners_earnings_enabled'
    ), false),
    'partners_credit_redemptions_enabled', coalesce(bool_or(flag.enabled)
      filter (where flag.key = 'partners_credit_redemptions_enabled'), false),
    'partners_payouts_live', coalesce(bool_or(flag.enabled) filter (
      where flag.key = 'partners_payouts_live'
    ), false)
  )
  into v_flags
  from public.admin_feature_flags flag
  where flag.key in (
    'partners_enabled',
    'partners_invite_only',
    'partners_cash_pilot_allowlist_only',
    'partners_earnings_enabled',
    'partners_credit_redemptions_enabled',
    'partners_payouts_live'
  );

  with candidates as (
    select
      entry.sequence_no,
      entry.entry_key,
      entry.entry_kind,
      entry.currency,
      entry.currency_exponent,
      entry.amount_minor,
      entry.matures_at,
      entry.created_at,
      case
        when entry.entry_kind = 'accrual'
          and exists (
            select 1
            from affiliate_private.affiliate_commission_entries release
            where release.related_entry_id = entry.id
              and release.entry_kind = 'release'
          ) then 'available'
        when entry.entry_kind = 'accrual' then 'pending'
        when entry.entry_kind = 'access_credit_redemption' then 'redeemed'
        when entry.entry_kind in (
          'payout_settlement', 'payout_late_settlement'
        ) then 'paid'
        when entry.entry_kind in (
          'reversal', 'manual_reversal', 'payout_return'
        ) then 'reversed'
        else null
      end as public_status
    from affiliate_private.affiliate_commission_entries entry
    where entry.account_id = v_account.id
      and entry.entry_kind <> 'release'
      and (v_cursor is null or entry.sequence_no < v_cursor)
    order by entry.sequence_no desc
  ), filtered as (
    select *
    from candidates
    where public_status is not null
      and (v_filter = 'all' or public_status = v_filter)
    order by sequence_no desc
    limit v_limit + 1
  ), page as (
    select * from filtered order by sequence_no desc limit v_limit
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'key', page.entry_key,
      'type', page.entry_kind,
      'status', page.public_status,
      'currency', page.currency,
      'currency_exponent', page.currency_exponent,
      'amount_minor', page.amount_minor,
      'occurred_at', page.created_at,
      'matures_at', page.matures_at
    ) order by page.sequence_no desc), '[]'::jsonb),
    (select count(*) from filtered),
    min(page.sequence_no)
  into v_items, v_candidate_count, v_last_sequence
  from page;
  if v_candidate_count > v_limit and v_last_sequence is not null then
    v_next_cursor := 'history_' || lpad(v_last_sequence::text, 20, '0');
  end if;

  return jsonb_build_object(
    'schema_version', 2,
    'membership', jsonb_build_object(
      'exists', true,
      'status', v_account.member_status,
      'joined_at', v_account.member_joined_at,
      'verification_status', v_account.verification_status
    ),
    'link', case when v_link.id is null then null else jsonb_build_object(
      'status', v_link.status,
      'share_url', 'https://norva.tv/r/' || v_link.public_code,
      'created_at', v_link.created_at
    ) end,
    'program', case when v_program.id is null then null else jsonb_build_object(
      'commission_rate_bps', v_program.commission_rate_bps,
      'attribution_window_days', v_program.attribution_window_days,
      'maturation_days', v_program.maturation_days,
      'terms_version', v_program.terms_version,
      'disclosure_version', v_program.disclosure_version
    ) end,
    'flags', v_flags,
    'balances', v_balances,
    'next_maturation_at', v_status -> 'next_maturation_at',
    'credit_readiness',
      (v_status -> 'credit_readiness')
      || jsonb_build_object('catalog', v_status -> 'catalog'),
    'cash_readiness', v_status -> 'cash_readiness',
    'overlay', v_status -> 'overlay',
    'provider', v_status -> 'provider',
    'history', jsonb_build_object(
      'status', v_filter,
      'items', v_items,
      'next_cursor', v_next_cursor
    )
  );
end;
$$;

create or replace function public.partners_service_bootstrap_v2(
  p_user_id uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select affiliate_private.partners_service_bootstrap_v2(p_user_id);
$$;

create or replace function public.partners_service_dashboard_v2(
  p_user_id uuid,
  p_history_limit integer,
  p_history_cursor text,
  p_history_status text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.partners_service_dashboard_v2(
    p_user_id,
    p_history_limit,
    p_history_cursor,
    p_history_status
  );
$$;

create or replace function public.partners_service_join_v2(
  p_user_id uuid,
  p_terms_accepted boolean,
  p_disclosure_accepted boolean,
  p_idempotency_key text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.partners_service_join_v2(
    p_user_id,
    p_terms_accepted,
    p_disclosure_accepted,
    p_idempotency_key
  );
$$;

create or replace function public.partners_service_access_credit_quote(
  p_user_id uuid,
  p_months integer,
  p_idempotency_key text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.partners_service_access_credit_quote(
    p_user_id,
    p_months,
    p_idempotency_key
  );
$$;

create or replace function public.partners_service_access_credit_redeem(
  p_user_id uuid,
  p_quote_key text,
  p_idempotency_key text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.partners_service_access_credit_redeem(
    p_user_id,
    p_quote_key,
    p_idempotency_key
  );
$$;

create or replace function public.partners_service_access_grants_reconcile(
  p_user_id uuid
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.partners_service_access_grants_reconcile(
    p_user_id
  );
$$;

create or replace function public.partners_service_access_credit_status(
  p_user_id uuid
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.partners_service_access_credit_status(p_user_id);
$$;

revoke all on function
  affiliate_private.validate_affiliate_member_transition()
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.guard_affiliate_member_active_links()
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.partners_access_credit_balances(uuid)
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.partners_account_balances(uuid)
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.partners_cash_readiness(uuid)
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.partners_service_join_v2(uuid,boolean,boolean,text)
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.partners_service_access_credit_quote(uuid,integer,text)
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.partners_service_access_credit_redeem(uuid,text,text)
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.partners_service_access_grants_reconcile(uuid)
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.reconcile_access_grants_after_projection()
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.partners_service_access_credit_status(uuid)
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.partners_service_bootstrap_v2(uuid)
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.partners_service_dashboard_v2(uuid,integer,text,text)
  from public, anon, authenticated, service_role;

grant execute on function
  affiliate_private.partners_service_join_v2(uuid,boolean,boolean,text)
  to service_role;
grant execute on function
  affiliate_private.partners_service_access_credit_quote(uuid,integer,text)
  to service_role;
grant execute on function
  affiliate_private.partners_service_access_credit_redeem(uuid,text,text)
  to service_role;
grant execute on function
  affiliate_private.partners_service_access_grants_reconcile(uuid)
  to service_role;
grant execute on function
  affiliate_private.partners_service_access_credit_status(uuid)
  to service_role;
grant execute on function
  affiliate_private.partners_service_bootstrap_v2(uuid)
  to service_role;
grant execute on function
  affiliate_private.partners_service_dashboard_v2(uuid,integer,text,text)
  to service_role;

revoke all on function
  public.partners_service_join_v2(uuid,boolean,boolean,text)
  from public, anon, authenticated, service_role;
revoke all on function
  public.partners_service_access_credit_quote(uuid,integer,text)
  from public, anon, authenticated, service_role;
revoke all on function
  public.partners_service_access_credit_redeem(uuid,text,text)
  from public, anon, authenticated, service_role;
revoke all on function
  public.partners_service_access_grants_reconcile(uuid)
  from public, anon, authenticated, service_role;
revoke all on function
  public.partners_service_access_credit_status(uuid)
  from public, anon, authenticated, service_role;
revoke all on function
  public.partners_service_bootstrap_v2(uuid)
  from public, anon, authenticated, service_role;
revoke all on function
  public.partners_service_dashboard_v2(uuid,integer,text,text)
  from public, anon, authenticated, service_role;

grant execute on function
  public.partners_service_join_v2(uuid,boolean,boolean,text)
  to service_role;
grant execute on function
  public.partners_service_access_credit_quote(uuid,integer,text)
  to service_role;
grant execute on function
  public.partners_service_access_credit_redeem(uuid,text,text)
  to service_role;
grant execute on function
  public.partners_service_access_grants_reconcile(uuid)
  to service_role;
grant execute on function
  public.partners_service_access_credit_status(uuid)
  to service_role;
grant execute on function
  public.partners_service_bootstrap_v2(uuid)
  to service_role;
grant execute on function
  public.partners_service_dashboard_v2(uuid,integer,text,text)
  to service_role;

comment on column
  affiliate_private.affiliate_accounts.member_status is
  'Referral membership lifecycle, independent from legacy KYC/cash account status.';
comment on table
  affiliate_private.affiliate_access_credit_quotes is
  'Short-lived authoritative USD quotes; clients provide months only, never price or currency.';
comment on function
  affiliate_private.partners_access_credit_balances(uuid) is
  'USD-only access-credit view over the immutable ledger; non-USD commission remains in its original ledger currency and is never converted implicitly.';
comment on table
  affiliate_private.affiliate_access_credit_redemptions is
  'Exactly-once conversions of available Partner USD balance into Norva access grants.';
comment on table public.cloud_access_grants is
  'Additive entitlement overlay. Provider projection remains authoritative and is never overwritten.';
comment on function
  affiliate_private.partners_service_access_credit_redeem(uuid,text,text) is
  'Atomically spends USD available balance under partners_balance_lock and issues one access grant; KYC is intentionally not required.';

reset lock_timeout;
reset statement_timeout;
