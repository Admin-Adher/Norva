-- Norva Partners P0: private, fail-closed foundations.
--
-- This schema deliberately stays outside PostgREST's exposed schemas. Every
-- canonical table also has RLS enabled with no policy as defence in depth.

create schema if not exists affiliate_private;

revoke all on schema affiliate_private from public, anon, authenticated;

create or replace function affiliate_private.valid_payout_thresholds(
  p_thresholds jsonb
)
returns boolean
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  v_key text;
  v_value jsonb;
begin
  if p_thresholds is null
    or jsonb_typeof(p_thresholds) <> 'object'
    or p_thresholds = '{}'::jsonb
  then
    return false;
  end if;

  if (
    select count(*)
    from jsonb_each(p_thresholds)
  ) > 32 then
    return false;
  end if;

  for v_key, v_value in
    select e.key, e.value
    from jsonb_each(p_thresholds) e
  loop
    if v_key !~ '^[A-Z]{3}$'
      or jsonb_typeof(v_value) <> 'number'
      or v_value::text !~ '^[1-9][0-9]{0,15}$'
      or v_value::text::numeric > 9007199254740991
    then
      return false;
    end if;
  end loop;

  return true;
end;
$$;

create or replace function affiliate_private.valid_currency_codes(
  p_codes text[]
)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select
    p_codes is not null
    and cardinality(p_codes) <= 10
    and not exists (
      select 1
      from unnest(p_codes) c(code)
      where c.code is null or c.code !~ '^[A-Z]{3}$'
    )
    and cardinality(p_codes) = (
      select count(distinct c.code)
      from unnest(p_codes) c(code)
    );
$$;

create or replace function affiliate_private.payout_currencies_covered(
  p_thresholds jsonb,
  p_currencies text[]
)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select
    affiliate_private.valid_payout_thresholds(p_thresholds)
    and affiliate_private.valid_currency_codes(p_currencies)
    and cardinality(p_currencies) > 0
    and not exists (
      select 1
      from unnest(p_currencies) c(code)
      where not (p_thresholds ? c.code)
        or (p_thresholds ->> c.code)::numeric <= 0
    );
$$;

create table affiliate_private.affiliate_program_versions (
  id                       uuid primary key default gen_random_uuid(),
  version_key              text not null unique,
  account_type             text not null default 'individual',
  status                   text not null default 'draft',
  commission_rate_bps      integer not null,
  attribution_window_days  integer not null,
  maturation_days          integer not null,
  payout_thresholds        jsonb not null,
  terms_version            text not null,
  disclosure_version       text not null,
  effective_from           timestamptz,
  effective_until          timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint affiliate_program_versions_key_format
    check (version_key ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
  constraint affiliate_program_versions_individual_only
    check (account_type = 'individual'),
  constraint affiliate_program_versions_status
    check (status in ('draft', 'active', 'retired')),
  constraint affiliate_program_versions_rate
    check (commission_rate_bps between 0 and 10000),
  constraint affiliate_program_versions_window
    check (attribution_window_days between 1 and 365),
  constraint affiliate_program_versions_maturation
    check (maturation_days between 0 and 365),
  constraint affiliate_program_versions_thresholds
    check (
      affiliate_private.valid_payout_thresholds(payout_thresholds)
    ),
  constraint affiliate_program_versions_terms
    check (
      terms_version ~ '^[a-z0-9][a-z0-9._-]{2,63}$'
      and disclosure_version ~ '^[a-z0-9][a-z0-9._-]{2,63}$'
    ),
  constraint affiliate_program_versions_effective_range
    check (
      effective_until is null
      or (
        effective_from is not null
        and effective_until > effective_from
      )
    ),
  constraint affiliate_program_versions_active_start
    check (status <> 'active' or effective_from is not null)
);

create unique index affiliate_program_versions_one_active_idx
  on affiliate_private.affiliate_program_versions ((status))
  where status = 'active';

create table affiliate_private.affiliate_country_policies (
  id                     uuid primary key default gen_random_uuid(),
  program_version_id     uuid not null
    references affiliate_private.affiliate_program_versions(id)
    on delete restrict,
  country_code           text not null,
  subdivision_code       text,
  individual_available   boolean not null default false,
  minimum_age            integer not null default 18,
  capacity_required      boolean not null default true,
  verification_level     text not null
    default 'identity_age_country_capacity',
  verification_provider  text,
  payout_currencies      text[] not null default '{}'::text[],
  terms_version          text not null,
  disclosure_version     text not null,
  effective_from         timestamptz,
  effective_until        timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint affiliate_country_policies_country
    check (country_code ~ '^[A-Z]{2}$'),
  constraint affiliate_country_policies_subdivision
    check (
      subdivision_code is null
      or (
        length(subdivision_code) <= 12
        and subdivision_code ~ '^[A-Z0-9]+(?:-[A-Z0-9]+)*$'
      )
    ),
  constraint affiliate_country_policies_subdivision_country
    check (
      subdivision_code is null
      or position('-' in subdivision_code) = 0
      or split_part(subdivision_code, '-', 1) = country_code
    ),
  constraint affiliate_country_policies_age
    check (minimum_age between 18 and 99),
  constraint affiliate_country_policies_verification_level
    check (
      verification_level in (
        'identity_age_country',
        'identity_age_country_capacity'
      )
    ),
  constraint affiliate_country_policies_capacity_level
    check (
      not capacity_required
      or verification_level = 'identity_age_country_capacity'
    ),
  constraint affiliate_country_policies_provider
    check (
      (
        verification_provider is null
        or (
          length(verification_provider) between 2 and 64
          and verification_provider ~ '^[a-z0-9][a-z0-9._-]+$'
        )
      )
      and (
        not individual_available
        or verification_provider is not null
      )
    ),
  constraint affiliate_country_policies_currencies
    check (
      affiliate_private.valid_currency_codes(payout_currencies)
      and (
        not individual_available
        or cardinality(payout_currencies) between 1 and 10
      )
    ),
  constraint affiliate_country_policies_terms
    check (
      terms_version ~ '^[a-z0-9][a-z0-9._-]{2,63}$'
      and disclosure_version ~ '^[a-z0-9][a-z0-9._-]{2,63}$'
    ),
  constraint affiliate_country_policies_effective_range
    check (
      effective_until is null
      or (
        effective_from is not null
        and effective_until > effective_from
      )
    )
);

create unique index affiliate_country_policies_scope_idx
  on affiliate_private.affiliate_country_policies (
    program_version_id,
    country_code,
    coalesce(subdivision_code, '')
  );

create index affiliate_country_policies_lookup_idx
  on affiliate_private.affiliate_country_policies (
    country_code,
    subdivision_code,
    individual_available,
    effective_from
  );

create table affiliate_private.affiliate_accounts (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid references auth.users(id) on delete restrict,
  user_pseudonym           text not null,
  account_type             text not null default 'individual',
  status                   text not null default 'invited',
  program_version_id       uuid
    references affiliate_private.affiliate_program_versions(id)
    on delete restrict,
  country_policy_id        uuid
    references affiliate_private.affiliate_country_policies(id)
    on delete restrict,
  country_code             text,
  subdivision_code         text,
  verification_status      text not null default 'not_started',
  verification_provider    text,
  verification_reference   text,
  age_verified             boolean not null default false,
  capacity_verified        boolean not null default false,
  contract_status          text not null default 'not_accepted',
  terms_version_accepted   text,
  contract_accepted_at     timestamptz,
  disclosure_version_accepted text,
  disclosure_accepted_at   timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  closed_at                timestamptz,
  constraint affiliate_accounts_pseudonym
    check (user_pseudonym ~ '^[0-9a-f]{64}$'),
  constraint affiliate_accounts_individual_only
    check (account_type = 'individual'),
  constraint affiliate_accounts_status
    check (
      status in (
        'invited',
        'pending_verification',
        'active',
        'held',
        'suspended',
        'closed'
      )
    ),
  constraint affiliate_accounts_country
    check (country_code is null or country_code ~ '^[A-Z]{2}$'),
  constraint affiliate_accounts_subdivision
    check (
      subdivision_code is null
      or (
        length(subdivision_code) <= 12
        and subdivision_code ~ '^[A-Z0-9]+(?:-[A-Z0-9]+)*$'
      )
    ),
  constraint affiliate_accounts_subdivision_country
    check (
      subdivision_code is null
      or (
        country_code is not null
        and (
          position('-' in subdivision_code) = 0
          or split_part(subdivision_code, '-', 1) = country_code
        )
      )
    ),
  constraint affiliate_accounts_verification_status
    check (
      verification_status in (
        'not_started',
        'pending',
        'verified',
        'failed',
        'expired'
      )
    ),
  constraint affiliate_accounts_verification_provider
    check (
      verification_provider is null
      or (
        length(verification_provider) between 2 and 64
        and verification_provider ~ '^[a-z0-9][a-z0-9._-]+$'
      )
    ),
  constraint affiliate_accounts_verification_reference
    check (
      verification_reference is null
      or (
        length(verification_reference) between 8 and 255
        and verification_reference !~ '[[:space:][:cntrl:]]'
      )
    ),
  constraint affiliate_accounts_contract_status
    check (contract_status in ('not_accepted', 'accepted', 'expired')),
  constraint affiliate_accounts_accepted_version_format
    check (
      (
        terms_version_accepted is null
        or terms_version_accepted ~ '^[a-z0-9][a-z0-9._-]{2,63}$'
      )
      and (
        disclosure_version_accepted is null
        or disclosure_version_accepted
          ~ '^[a-z0-9][a-z0-9._-]{2,63}$'
      )
    ),
  constraint affiliate_accounts_contract_consistency
    check (
      contract_status <> 'accepted'
      or (
        nullif(btrim(terms_version_accepted), '') is not null
        and contract_accepted_at is not null
        and nullif(btrim(disclosure_version_accepted), '') is not null
        and disclosure_accepted_at is not null
      )
    ),
  constraint affiliate_accounts_user_or_minimized
    check (
      user_id is not null
      or (
        status = 'closed'
        and verification_status in ('not_started', 'expired')
        and verification_provider is null
        and verification_reference is null
        and not age_verified
        and not capacity_verified
        and contract_status <> 'accepted'
        and terms_version_accepted is null
        and contract_accepted_at is null
        and disclosure_version_accepted is null
        and disclosure_accepted_at is null
      )
    ),
  constraint affiliate_accounts_active_consistency
    check (
      status <> 'active'
      or (
        user_id is not null
        and program_version_id is not null
        and country_policy_id is not null
        and country_code is not null
        and verification_status = 'verified'
        and nullif(btrim(verification_provider), '') is not null
        and nullif(btrim(verification_reference), '') is not null
        and age_verified
        and contract_status = 'accepted'
      )
    ),
  constraint affiliate_accounts_closed_consistency
    check ((status = 'closed') = (closed_at is not null))
);

create unique index affiliate_accounts_one_open_per_user_idx
  on affiliate_private.affiliate_accounts (user_id)
  where user_id is not null and status <> 'closed';

create unique index affiliate_accounts_verification_identity_idx
  on affiliate_private.affiliate_accounts (
    verification_provider,
    verification_reference
  )
  where verification_provider is not null
    and verification_reference is not null;

create index affiliate_accounts_user_lookup_idx
  on affiliate_private.affiliate_accounts (user_id, created_at desc);

-- Account transitions lock their referenced program and policy with FOR SHARE.
-- Program/policy UPDATE takes a conflicting row lock, so validation and commit
-- cannot be separated by a concurrent reverse mutation (TOCTOU).
create or replace function affiliate_private.validate_affiliate_account_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_program affiliate_private.affiliate_program_versions%rowtype;
  v_policy affiliate_private.affiliate_country_policies%rowtype;
begin
  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id
      or new.user_pseudonym is distinct from old.user_pseudonym
      or new.created_at is distinct from old.created_at
    then
      raise exception 'Partners account identity is immutable'
        using errcode = '55000';
    end if;

    if old.status is distinct from new.status
      and not (
        (old.status = 'invited'
          and new.status in ('pending_verification', 'closed'))
        or (old.status = 'pending_verification'
          and new.status in ('active', 'held', 'suspended', 'closed'))
        or (old.status = 'active'
          and new.status in ('held', 'suspended', 'closed'))
        or (old.status = 'held'
          and new.status in (
            'pending_verification',
            'active',
            'suspended',
            'closed'
          ))
        or (old.status = 'suspended'
          and new.status in ('held', 'closed'))
      )
    then
      raise exception 'invalid Partners account status transition'
        using errcode = '55000';
    end if;

    if old.status = 'closed' and new.status <> 'closed' then
      raise exception 'closed Partners accounts are terminal'
        using errcode = '55000';
    end if;

    if old.status = 'closed'
      and new.closed_at is distinct from old.closed_at
    then
      raise exception 'Partners account closure timestamp is immutable'
        using errcode = '55000';
    end if;

    if new.user_id is distinct from old.user_id then
      if new.user_id is not null then
        raise exception 'Partners account user identity is immutable'
          using errcode = '55000';
      end if;

      if new.status <> 'closed'
        or new.verification_status not in ('not_started', 'expired')
        or new.verification_provider is not null
        or new.verification_reference is not null
        or new.age_verified
        or new.capacity_verified
        or new.contract_status = 'accepted'
        or new.terms_version_accepted is not null
        or new.contract_accepted_at is not null
        or new.disclosure_version_accepted is not null
        or new.disclosure_accepted_at is not null
      then
        raise exception
          'unlinking a Partners user requires a closed minimized account'
          using errcode = '55000';
      end if;
    end if;
  end if;

  if (new.program_version_id is null)
    <> (new.country_policy_id is null)
  then
    raise exception 'Partners account program and policy must be assigned together'
      using errcode = '23514';
  end if;

  if new.program_version_id is null then
    return new;
  end if;

  select p.*
  into v_program
  from affiliate_private.affiliate_program_versions p
  where p.id = new.program_version_id
  for share;

  if not found then
    raise exception 'Partners account program is unavailable'
      using errcode = '23503';
  end if;

  select cp.*
  into v_policy
  from affiliate_private.affiliate_country_policies cp
  where cp.id = new.country_policy_id
  for share;

  if not found then
    raise exception 'Partners account policy is unavailable'
      using errcode = '23503';
  end if;

  if v_policy.program_version_id <> new.program_version_id
    or new.country_code is null
    or v_policy.country_code <> new.country_code
    or (
      v_policy.subdivision_code is not null
      and v_policy.subdivision_code is distinct from new.subdivision_code
    )
  then
    raise exception 'Partners account jurisdiction does not match its policy'
      using errcode = '23514';
  end if;

  if new.status = 'active' then
    if new.user_id is null then
      raise exception 'active Partners account requires a user'
        using errcode = '23514';
    end if;

    perform 1
    from auth.users u
    where u.id = new.user_id
      and u.email_confirmed_at is not null
    for share;

    if not found then
      raise exception 'active Partners account requires a confirmed email'
        using errcode = '23514';
    end if;

    if v_program.status <> 'active'
      or v_program.effective_from is null
      or v_program.effective_from > now()
      or (
        v_program.effective_until is not null
        and v_program.effective_until <= now()
      )
      or v_program.account_type <> 'individual'
      or v_program.commission_rate_bps <> 2000
      or v_program.attribution_window_days <> 30
      or v_program.maturation_days <> 45
    then
      raise exception 'Partners account requires the active P0 program'
        using errcode = '23514';
    end if;

    if not v_policy.individual_available
      or (
        v_policy.effective_from is not null
        and v_policy.effective_from > now()
      )
      or (
        v_policy.effective_until is not null
        and v_policy.effective_until <= now()
      )
      or not affiliate_private.payout_currencies_covered(
        v_program.payout_thresholds,
        v_policy.payout_currencies
      )
      or (
        v_policy.capacity_required
        and not new.capacity_verified
      )
    then
      raise exception 'Partners account requires an available funded policy'
        using errcode = '23514';
    end if;

    if new.terms_version_accepted is distinct from v_policy.terms_version
      or new.disclosure_version_accepted
        is distinct from v_policy.disclosure_version
      or new.verification_provider
        is distinct from v_policy.verification_provider
      or new.contract_accepted_at is null
      or new.disclosure_accepted_at is null
    then
      raise exception 'Partners account acceptances do not match its policy'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

-- Policy transitions take a share lock on their program. The policy row lock
-- itself serializes them against account validation of that same policy.
create or replace function affiliate_private.validate_affiliate_policy_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_program affiliate_private.affiliate_program_versions%rowtype;
begin
  if tg_op = 'UPDATE'
    and (
      new.program_version_id is distinct from old.program_version_id
      or new.country_code is distinct from old.country_code
      or new.subdivision_code is distinct from old.subdivision_code
    )
    and exists (
      select 1
      from affiliate_private.affiliate_accounts a
      where a.country_policy_id = old.id
    )
  then
    raise exception 'cannot change the scope of an assigned Partners policy'
      using errcode = '55000';
  end if;

  if tg_op = 'UPDATE'
    and (
      new.minimum_age is distinct from old.minimum_age
      or new.capacity_required is distinct from old.capacity_required
      or new.verification_level is distinct from old.verification_level
      or new.verification_provider is distinct from old.verification_provider
      or new.payout_currencies is distinct from old.payout_currencies
      or new.terms_version is distinct from old.terms_version
      or new.disclosure_version is distinct from old.disclosure_version
    )
    and exists (
      select 1
      from affiliate_private.affiliate_accounts a
      where a.country_policy_id = old.id
        and a.status <> 'closed'
    )
  then
    raise exception
      'versioned Partners policy requirements require a new policy for assigned accounts'
      using errcode = '55000';
  end if;

  select p.*
  into v_program
  from affiliate_private.affiliate_program_versions p
  where p.id = new.program_version_id
  for share;

  if not found then
    raise exception 'Partners policy program is unavailable'
      using errcode = '23503';
  end if;

  if new.individual_available
    and not affiliate_private.payout_currencies_covered(
      v_program.payout_thresholds,
      new.payout_currencies
    )
  then
    raise exception 'Partners policy payout currencies lack positive thresholds'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from affiliate_private.affiliate_accounts a
    where a.country_policy_id = new.id
      and a.status = 'active'
      and (
        a.program_version_id is distinct from new.program_version_id
        or a.country_code is distinct from new.country_code
        or (
          new.subdivision_code is not null
          and a.subdivision_code is distinct from new.subdivision_code
        )
        or not new.individual_available
        or (
          new.effective_from is not null
          and new.effective_from > now()
        )
        or (
          new.effective_until is not null
          and new.effective_until <= now()
        )
        or a.terms_version_accepted is distinct from new.terms_version
        or a.disclosure_version_accepted
          is distinct from new.disclosure_version
        or a.verification_provider
          is distinct from new.verification_provider
      )
  ) then
    raise exception 'Partners policy update would invalidate an active account'
      using errcode = '55000';
  end if;

  if exists (
    select 1
    from affiliate_private.affiliate_accounts a
    where a.country_policy_id = new.id
      and a.status = 'active'
  )
    and (
      v_program.status <> 'active'
      or v_program.effective_from is null
      or v_program.effective_from > now()
      or (
        v_program.effective_until is not null
        and v_program.effective_until <= now()
      )
      or v_program.account_type <> 'individual'
      or v_program.commission_rate_bps <> 2000
      or v_program.attribution_window_days <> 30
      or v_program.maturation_days <> 45
    )
  then
    raise exception 'Partners policy program cannot support active accounts'
      using errcode = '55000';
  end if;

  return new;
end;
$$;

-- A program row is already write-locked by UPDATE. Concurrent account/policy
-- transitions either committed first and are observed below, or wait and then
-- validate the new program state.
create or replace function affiliate_private.validate_affiliate_program_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id is distinct from old.id then
    raise exception 'Partners program identifiers are immutable'
      using errcode = '55000';
  end if;

  if old.status is distinct from new.status
    and not (
      (old.status = 'draft' and new.status in ('active', 'retired'))
      or (old.status = 'active' and new.status = 'retired')
    )
  then
    raise exception 'invalid Partners program status transition'
      using errcode = '55000';
  end if;

  if (
    new.version_key is distinct from old.version_key
    or new.account_type is distinct from old.account_type
    or new.commission_rate_bps is distinct from old.commission_rate_bps
    or new.attribution_window_days
      is distinct from old.attribution_window_days
    or new.maturation_days is distinct from old.maturation_days
    or new.payout_thresholds is distinct from old.payout_thresholds
    or new.terms_version is distinct from old.terms_version
    or new.disclosure_version is distinct from old.disclosure_version
    or new.effective_from is distinct from old.effective_from
  )
    and (
      old.status <> 'draft'
      or exists (
        select 1
        from affiliate_private.affiliate_accounts a
        where a.program_version_id = old.id
          and a.status <> 'closed'
      )
    )
  then
    raise exception
      'published or assigned Partners program terms require a new version'
      using errcode = '55000';
  end if;

  if exists (
    select 1
    from affiliate_private.affiliate_country_policies cp
    where cp.program_version_id = old.id
      and cp.individual_available
      and not affiliate_private.payout_currencies_covered(
        new.payout_thresholds,
        cp.payout_currencies
      )
  ) then
    raise exception 'Partners program update would unfund an available policy'
      using errcode = '55000';
  end if;

  if exists (
    select 1
    from affiliate_private.affiliate_accounts a
    where a.program_version_id = old.id
      and a.status = 'active'
  )
    and (
      new.status <> 'active'
      or new.effective_from is null
      or new.effective_from > now()
      or (
        new.effective_until is not null
        and new.effective_until <= now()
      )
      or new.account_type <> 'individual'
      or new.commission_rate_bps <> 2000
      or new.attribution_window_days <> 30
      or new.maturation_days <> 45
    )
  then
    raise exception 'Partners program update would invalidate an active account'
      using errcode = '55000';
  end if;

  return new;
end;
$$;

-- Program/policy mutations and Admin release decisions use the same advisory
-- lock. Whichever transaction commits second must validate the state committed
-- by the first, so partners_enabled can never remain true without a complete
-- current individual release contract.
create or replace function affiliate_private.guard_partners_release_contract()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_partners_enabled boolean := false;
  v_count bigint;
begin
  perform pg_advisory_xact_lock(
    hashtextextended('norva:partners:release-control', 0)
  );

  select coalesce(f.enabled, false)
  into v_partners_enabled
  from public.admin_feature_flags f
  where f.key = 'partners_enabled';
  v_partners_enabled := coalesce(v_partners_enabled, false);

  if v_partners_enabled then
    select count(*)
    into v_count
    from affiliate_private.affiliate_program_versions p
    where p.status = 'active'
      and p.account_type = 'individual'
      and p.commission_rate_bps = 2000
      and p.attribution_window_days = 30
      and p.maturation_days = 45
      and p.effective_from <= now()
      and (p.effective_until is null or p.effective_until > now());

    if v_count <> 1 then
      raise exception
        'disable Partners before invalidating its active program'
        using errcode = '55000';
    end if;

    select count(*)
    into v_count
    from affiliate_private.affiliate_country_policies cp
    join affiliate_private.affiliate_program_versions pv
      on pv.id = cp.program_version_id
    where pv.status = 'active'
      and pv.account_type = 'individual'
      and pv.commission_rate_bps = 2000
      and pv.attribution_window_days = 30
      and pv.maturation_days = 45
      and pv.effective_from <= now()
      and (pv.effective_until is null or pv.effective_until > now())
      and cp.individual_available
      and coalesce(cp.effective_from, pv.effective_from) <= now()
      and (cp.effective_until is null or cp.effective_until > now())
      and affiliate_private.payout_currencies_covered(
        pv.payout_thresholds,
        cp.payout_currencies
      );

    if v_count < 1 then
      raise exception
        'disable Partners before invalidating its last available policy'
        using errcode = '55000';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger affiliate_accounts_validate_transition
before insert or update on affiliate_private.affiliate_accounts
for each row
execute function affiliate_private.validate_affiliate_account_transition();

create trigger affiliate_country_policies_validate_transition
before insert or update on affiliate_private.affiliate_country_policies
for each row
execute function affiliate_private.validate_affiliate_policy_transition();

create trigger affiliate_program_versions_validate_transition
before update on affiliate_private.affiliate_program_versions
for each row
execute function affiliate_private.validate_affiliate_program_transition();

create trigger affiliate_country_policies_release_contract
after insert or update or delete
on affiliate_private.affiliate_country_policies
for each row
execute function affiliate_private.guard_partners_release_contract();

create trigger affiliate_program_versions_release_contract
after insert or update or delete
on affiliate_private.affiliate_program_versions
for each row
execute function affiliate_private.guard_partners_release_contract();

create table affiliate_private.affiliate_links (
  id               uuid primary key default gen_random_uuid(),
  account_id       uuid not null
    references affiliate_private.affiliate_accounts(id)
    on delete restrict,
  public_code      text not null unique default translate(
    rtrim(
      encode(extensions.gen_random_bytes(24), 'base64'),
      '='
    ),
    '+/',
    '-_'
  ),
  code_hash        text generated always as (
    encode(
      extensions.digest(public_code, 'sha256'),
      'hex'
    )
  ) stored unique,
  status           text not null default 'active',
  campaign_key     text,
  rotated_from_id  uuid
    references affiliate_private.affiliate_links(id)
    on delete restrict,
  created_at       timestamptz not null default now(),
  revoked_at       timestamptz,
  constraint affiliate_links_public_code
    check (public_code ~ '^[A-Za-z0-9_-]{32}$'),
  constraint affiliate_links_hash
    check (code_hash ~ '^[0-9a-f]{64}$'),
  constraint affiliate_links_status
    check (status in ('active', 'revoked')),
  constraint affiliate_links_campaign
    check (
      campaign_key is null
      or campaign_key ~ '^[a-z0-9][a-z0-9_-]{0,63}$'
    ),
  constraint affiliate_links_rotation_not_self
    check (rotated_from_id is null or rotated_from_id <> id),
  constraint affiliate_links_revocation
    check ((status = 'revoked') = (revoked_at is not null))
);

create unique index affiliate_links_one_active_per_account_idx
  on affiliate_private.affiliate_links (account_id)
  where status = 'active';

create unique index affiliate_links_one_successor_per_predecessor_idx
  on affiliate_private.affiliate_links (rotated_from_id)
  where rotated_from_id is not null;

create or replace function affiliate_private.validate_affiliate_link_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_account affiliate_private.affiliate_accounts%rowtype;
  v_program affiliate_private.affiliate_program_versions%rowtype;
  v_policy affiliate_private.affiliate_country_policies%rowtype;
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

  -- Account is always the first related row lock. Account downgrade already
  -- owns this row and sees the old committed link state, so either ordering
  -- leaves no transaction where a non-active account has an active link.
  select a.*
  into v_account
  from affiliate_private.affiliate_accounts a
  where a.id = new.account_id
  for share;

  if not found then
    raise exception 'Partners link account is unavailable'
      using errcode = '23503';
  end if;

  if new.status = 'active' then
    if v_account.status <> 'active'
      or v_account.user_id is null
      or v_account.program_version_id is null
      or v_account.country_policy_id is null
      or v_account.country_code is null
      or v_account.verification_status <> 'verified'
      or nullif(btrim(v_account.verification_provider), '') is null
      or nullif(btrim(v_account.verification_reference), '') is null
      or not v_account.age_verified
      or v_account.contract_status <> 'accepted'
      or v_account.contract_accepted_at is null
      or v_account.disclosure_accepted_at is null
    then
      raise exception 'active Partners link requires a verified active account'
        using errcode = '23514';
    end if;

    perform 1
    from auth.users u
    where u.id = v_account.user_id
      and u.email_confirmed_at is not null
    for share;

    if not found then
      raise exception 'active Partners link requires a confirmed user'
        using errcode = '23514';
    end if;

    select p.*
    into v_program
    from affiliate_private.affiliate_program_versions p
    where p.id = v_account.program_version_id
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
    then
      raise exception 'active Partners link requires the current P0 program'
        using errcode = '23514';
    end if;

    select cp.*
    into v_policy
    from affiliate_private.affiliate_country_policies cp
    where cp.id = v_account.country_policy_id
    for share;

    if not found
      or v_policy.program_version_id <> v_account.program_version_id
      or v_policy.country_code <> v_account.country_code
      or (
        v_policy.subdivision_code is not null
        and v_policy.subdivision_code
          is distinct from v_account.subdivision_code
      )
      or not v_policy.individual_available
      or (
        v_policy.effective_from is not null
        and v_policy.effective_from > now()
      )
      or (
        v_policy.effective_until is not null
        and v_policy.effective_until <= now()
      )
      or not affiliate_private.payout_currencies_covered(
        v_program.payout_thresholds,
        v_policy.payout_currencies
      )
      or (
        v_policy.capacity_required
        and not v_account.capacity_verified
      )
      or v_account.verification_provider
        is distinct from v_policy.verification_provider
      or v_account.terms_version_accepted
        is distinct from v_policy.terms_version
      or v_account.disclosure_version_accepted
        is distinct from v_policy.disclosure_version
    then
      raise exception 'active Partners link requires current policy evidence'
        using errcode = '23514';
    end if;

    if exists (
      select 1
      from affiliate_private.affiliate_links successor
      where successor.rotated_from_id = new.id
        and successor.id <> new.id
    ) then
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

create or replace function affiliate_private.guard_affiliate_account_active_links()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status <> 'active'
    and exists (
      select 1
      from affiliate_private.affiliate_links l
      where l.account_id = old.id
        and l.status = 'active'
    )
  then
    raise exception 'revoke the active Partners link before account downgrade'
      using errcode = '55000';
  end if;

  return new;
end;
$$;

create or replace function affiliate_private.guard_affiliate_auth_user_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if exists (
      select 1
      from affiliate_private.affiliate_accounts a
      where a.user_id = old.id
    ) then
      raise exception
        'unlink and minimize Partners accounts before deleting the user'
        using errcode = '55000';
    end if;
    return old;
  end if;

  if old.email_confirmed_at is not null
    and new.email_confirmed_at is null
    and exists (
      select 1
      from affiliate_private.affiliate_accounts a
      where a.user_id = old.id
        and a.status = 'active'
    )
  then
    raise exception 'active Partners accounts require a confirmed email'
      using errcode = '55000';
  end if;

  return new;
end;
$$;

create trigger affiliate_links_validate_transition
before insert or update or delete on affiliate_private.affiliate_links
for each row
execute function affiliate_private.validate_affiliate_link_transition();

create trigger affiliate_accounts_active_link_guard
before update of status on affiliate_private.affiliate_accounts
for each row
execute function affiliate_private.guard_affiliate_account_active_links();

create trigger affiliate_auth_users_partners_guard
before update of email_confirmed_at or delete on auth.users
for each row
execute function affiliate_private.guard_affiliate_auth_user_transition();

create table affiliate_private.affiliate_pilot_allowlist (
  user_id                uuid primary key
    references auth.users(id)
    on delete cascade,
  status                 text not null default 'active',
  country_code           text,
  subdivision_code       text,
  expires_at             timestamptz,
  added_by_pseudonym     text not null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint affiliate_pilot_allowlist_status
    check (status in ('active', 'revoked')),
  constraint affiliate_pilot_allowlist_country
    check (country_code is null or country_code ~ '^[A-Z]{2}$'),
  constraint affiliate_pilot_allowlist_subdivision
    check (
      subdivision_code is null
      or (
        length(subdivision_code) <= 12
        and subdivision_code ~ '^[A-Z0-9]+(?:-[A-Z0-9]+)*$'
      )
    ),
  constraint affiliate_pilot_allowlist_scope
    check (subdivision_code is null or country_code is not null),
  constraint affiliate_pilot_allowlist_subdivision_country
    check (
      subdivision_code is null
      or position('-' in subdivision_code) = 0
      or split_part(subdivision_code, '-', 1) = country_code
    ),
  constraint affiliate_pilot_allowlist_actor
    check (added_by_pseudonym ~ '^[0-9a-f]{64}$')
);

create index affiliate_pilot_allowlist_active_idx
  on affiliate_private.affiliate_pilot_allowlist (
    status,
    expires_at,
    country_code,
    subdivision_code
  );

create table affiliate_private.affiliate_release_gates (
  gate_key                text primary key,
  satisfied               boolean not null default false,
  satisfied_at            timestamptz,
  updated_by_pseudonym    text,
  updated_at              timestamptz not null default now(),
  constraint affiliate_release_gates_key
    check (
      gate_key in (
        'legal_and_tax_approved',
        'privacy_approved',
        'individual_verification_coverage_confirmed',
        'individual_payout_coverage_confirmed',
        'country_policy_approved',
        'financial_data_contract_approved',
        'shadow_reconciliation_clean',
        'backup_restore_verified',
        'payout_execution_adapter_verified',
        'tv_relay_security_verified',
        'general_release_approved'
      )
    ),
  constraint affiliate_release_gates_satisfaction
    check (satisfied = (satisfied_at is not null)),
  constraint affiliate_release_gates_actor
    check (
      updated_by_pseudonym is null
      or updated_by_pseudonym ~ '^[0-9a-f]{64}$'
    )
);

create table affiliate_private.affiliate_events (
  id                 uuid primary key default gen_random_uuid(),
  aggregate_type     text not null,
  aggregate_key      text not null,
  action             text not null,
  actor_type         text not null,
  actor_pseudonym    text,
  justification      text not null,
  before_state       jsonb not null default '{}'::jsonb,
  after_state        jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  constraint affiliate_events_aggregate_type
    check (
      aggregate_type in (
        'release_gate',
        'feature_flag',
        'pilot_allowlist',
        'program_version',
        'country_policy',
        'account',
        'link'
      )
    ),
  constraint affiliate_events_action
    check (action ~ '^[a-z][a-z0-9_]{2,63}$'),
  constraint affiliate_events_actor_type
    check (actor_type in ('admin', 'service', 'system')),
  constraint affiliate_events_actor
    check (
      actor_pseudonym is null
      or actor_pseudonym ~ '^[0-9a-f]{64}$'
    ),
  constraint affiliate_events_justification
    check (length(btrim(justification)) between 12 and 1000),
  constraint affiliate_events_before_object
    check (jsonb_typeof(before_state) = 'object'),
  constraint affiliate_events_after_object
    check (jsonb_typeof(after_state) = 'object')
);

create index affiliate_events_aggregate_idx
  on affiliate_private.affiliate_events (
    aggregate_type,
    aggregate_key,
    created_at desc
  );

alter table affiliate_private.affiliate_program_versions
  enable row level security;
alter table affiliate_private.affiliate_country_policies
  enable row level security;
alter table affiliate_private.affiliate_accounts
  enable row level security;
alter table affiliate_private.affiliate_links
  enable row level security;
alter table affiliate_private.affiliate_pilot_allowlist
  enable row level security;
alter table affiliate_private.affiliate_release_gates
  enable row level security;
alter table affiliate_private.affiliate_events
  enable row level security;

revoke all on all tables in schema affiliate_private
  from public, anon, authenticated, service_role;
revoke all on all sequences in schema affiliate_private
  from public, anon, authenticated, service_role;
grant usage on schema affiliate_private to service_role;

insert into affiliate_private.affiliate_release_gates (gate_key)
values
  ('legal_and_tax_approved'),
  ('privacy_approved'),
  ('individual_verification_coverage_confirmed'),
  ('individual_payout_coverage_confirmed'),
  ('country_policy_approved'),
  ('financial_data_contract_approved'),
  ('shadow_reconciliation_clean'),
  ('backup_restore_verified'),
  ('payout_execution_adapter_verified'),
  ('tv_relay_security_verified'),
  ('general_release_approved')
on conflict (gate_key) do nothing;

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
      'partners_shadow_mode',
      'partners_payouts_live',
      'partners_tv_relay_enabled'
    ]::text[]
  );
$$;

create or replace function affiliate_private.release_gates_satisfied(
  p_gate_keys text[]
)
returns boolean
language sql
stable
set search_path = ''
as $$
  select
    cardinality(p_gate_keys) > 0
    and count(*) = cardinality(p_gate_keys)
    and coalesce(bool_and(g.satisfied), false)
  from affiliate_private.affiliate_release_gates g
  where g.gate_key = any (p_gate_keys);
$$;

create or replace function affiliate_private.reject_affiliate_event_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'affiliate_events is append-only'
    using errcode = '55000';
end;
$$;

create or replace function affiliate_private.guard_managed_partners_flags()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_managed boolean := case
    when tg_op = 'INSERT'
      then affiliate_private.is_managed_partners_flag(new.key)
    when tg_op = 'DELETE'
      then affiliate_private.is_managed_partners_flag(old.key)
    else
      affiliate_private.is_managed_partners_flag(old.key)
      or affiliate_private.is_managed_partners_flag(new.key)
  end;
  v_table_owner text;
begin
  if not v_managed then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  select pg_get_userbyid(c.relowner)
  into v_table_owner
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'admin_feature_flags';

  -- A trusted migration role may be a member of the restored table owner
  -- rather than the literal owner (self-hosted dumps preserve ownership).
  -- Membership grants SET ROLE already, so accepting it here adds no
  -- capability while keeping managed writes behind the explicit GUC.
  if not pg_has_role(current_user, v_table_owner, 'MEMBER')
    or current_setting('norva.partners_control', true)
      is distinct from 'admin_partners_control'
  then
    raise exception 'managed Partners flags require admin_partners_control'
      using errcode = '42501';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists affiliate_events_append_only
  on affiliate_private.affiliate_events;
create trigger affiliate_events_append_only
before update or delete on affiliate_private.affiliate_events
for each row
execute function affiliate_private.reject_affiliate_event_mutation();

revoke all on all functions in schema affiliate_private
  from public, anon, authenticated;

insert into public.admin_feature_flags (
  key,
  enabled,
  description,
  updated_at,
  updated_by
)
values
  (
    'partners_enabled',
    false,
    'Master visibility and activation gate for Norva Partners.',
    now(),
    'migration'
  ),
  (
    'partners_invite_only',
    false,
    'Restricts Norva Partners to the private pilot allowlist.',
    now(),
    'migration'
  ),
  (
    'partners_shadow_mode',
    false,
    'Runs commission calculations without making balances payable.',
    now(),
    'migration'
  ),
  (
    'partners_payouts_live',
    false,
    'Permits real individual payout execution after release checks.',
    now(),
    'migration'
  ),
  (
    'partners_tv_relay_enabled',
    false,
    'Enables the TV-to-phone Partners relay after security validation.',
    now(),
    'migration'
  )
on conflict (key) do update
set
  enabled = false,
  description = excluded.description,
  updated_at = now(),
  updated_by = 'migration';

drop trigger if exists admin_feature_flags_partners_guard
  on public.admin_feature_flags;
create trigger admin_feature_flags_partners_guard
before insert or update or delete on public.admin_feature_flags
for each row
execute function affiliate_private.guard_managed_partners_flags();

-- The generic flag CRUD remains available for unrelated flags, but managed
-- Partners flags can only move through public.admin_partners_control().
create or replace function public.admin_flag_set(
  p_key text,
  p_enabled boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_email text;
  v_key text := btrim(coalesce(p_key, ''));
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if v_key = '' then
    raise exception 'empty key' using errcode = '22023';
  end if;
  if affiliate_private.is_managed_partners_flag(v_key) then
    raise exception 'managed Partners flag requires admin_partners_control'
      using errcode = '42501';
  end if;

  v_email := nullif(auth.jwt() ->> 'email', '');
  update public.admin_feature_flags
  set
    enabled = coalesce(p_enabled, false),
    updated_at = now(),
    updated_by = v_email
  where key = v_key;

  if not found then
    raise exception 'unknown flag' using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'key', v_key,
    'enabled', coalesce(p_enabled, false)
  );
end;
$$;

create or replace function public.admin_flag_create(
  p_key text,
  p_description text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key text := left(
    lower(regexp_replace(
      btrim(coalesce(p_key, '')),
      '[^a-z0-9_]+',
      '_',
      'g'
    )),
    60
  );
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if v_key = '' then
    raise exception 'empty key' using errcode = '22023';
  end if;
  if affiliate_private.is_managed_partners_flag(v_key) then
    raise exception 'managed Partners flag requires admin_partners_control'
      using errcode = '42501';
  end if;

  insert into public.admin_feature_flags (
    key,
    description,
    updated_by
  )
  values (
    v_key,
    nullif(btrim(coalesce(p_description, '')), ''),
    nullif(auth.jwt() ->> 'email', '')
  )
  on conflict (key) do update
  set description = coalesce(
    excluded.description,
    public.admin_feature_flags.description
  );

  return jsonb_build_object('key', v_key);
end;
$$;

create or replace function public.admin_flag_delete(p_key text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key text := btrim(coalesce(p_key, ''));
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if affiliate_private.is_managed_partners_flag(v_key) then
    raise exception 'managed Partners flag cannot be deleted'
      using errcode = '42501';
  end if;

  delete from public.admin_feature_flags
  where key = v_key;
  return found;
end;
$$;

revoke all on function public.admin_flag_set(text, boolean)
  from public, anon;
revoke all on function public.admin_flag_create(text, text)
  from public, anon;
revoke all on function public.admin_flag_delete(text)
  from public, anon;
grant execute on function public.admin_flag_set(text, boolean)
  to authenticated;
grant execute on function public.admin_flag_create(text, text)
  to authenticated;
grant execute on function public.admin_flag_delete(text)
  to authenticated;

-- The foundation fails closed until the granular Support/Risk/Finance mapping
-- is installed by the final P0 migration. Only a server-managed JSON boolean
-- in app_metadata can authorize release control during that interval.
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
begin
  if not coalesce(public.is_admin(), false)
    or not coalesce(
      (
        auth.jwt()
        -> 'app_metadata'
        -> 'partners_release_manager'
      ) = 'true'::jsonb,
      false
    )
  then
    raise exception 'Partners control capability is required'
      using errcode = '42501';
  end if;
end;
$$;

revoke all on function
  affiliate_private.partners_require_control_access(text, text, boolean)
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
  v_country text := nullif(upper(btrim(coalesce(p_country_code, ''))), '');
  v_subdivision text := nullif(
    upper(btrim(coalesce(p_subdivision_code, ''))),
    ''
  );
  v_actor uuid := auth.uid();
  v_actor_pseudonym text;
  v_subject_pseudonym text;
  v_current boolean;
  v_other boolean;
  v_before jsonb := '{}'::jsonb;
  v_after jsonb := '{}'::jsonb;
  v_count bigint;
begin
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
  if v_action not in ('set_flag', 'set_gate', 'set_allowlist') then
    raise exception 'unsupported Partners control action'
      using errcode = '22023';
  end if;

  v_actor_pseudonym := encode(
    extensions.digest(
      'norva-partners-actor:v1:' || v_actor::text,
      'sha256'
    ),
    'hex'
  );

  -- All release decisions share one transaction lock so a flag cannot pass
  -- preconditions against a gate that is being revoked concurrently.
  perform pg_advisory_xact_lock(
    hashtextextended('norva:partners:release-control', 0)
  );

  if v_action = 'set_flag' then
    if not affiliate_private.is_managed_partners_flag(v_key) then
      raise exception 'unknown managed Partners flag'
        using errcode = 'P0002';
    end if;
    if p_enabled is null then
      raise exception 'flag value is required' using errcode = '22023';
    end if;

    select f.enabled
    into v_current
    from public.admin_feature_flags f
    where f.key = v_key
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

    if p_enabled and v_key = 'partners_enabled' then
      select coalesce(f.enabled, false)
      into v_other
      from public.admin_feature_flags f
      where f.key = 'partners_invite_only';

      if not coalesce(v_other, false) then
        raise exception 'invite-only must be enabled before Partners'
          using errcode = '55000';
      end if;
      if not affiliate_private.release_gates_satisfied(
        array[
          'legal_and_tax_approved',
          'privacy_approved',
          'individual_verification_coverage_confirmed',
          'individual_payout_coverage_confirmed',
          'country_policy_approved'
        ]::text[]
      ) then
        raise exception 'Partners activation prerequisites are incomplete'
          using errcode = '55000';
      end if;

      select count(*)
      into v_count
      from affiliate_private.affiliate_program_versions p
      where p.status = 'active'
        and p.account_type = 'individual'
        and p.commission_rate_bps = 2000
        and p.attribution_window_days = 30
        and p.maturation_days = 45
        and p.effective_from <= now()
        and (p.effective_until is null or p.effective_until > now());
      if v_count <> 1 then
        raise exception 'exactly one active individual program is required'
          using errcode = '55000';
      end if;

      select count(*)
      into v_count
      from affiliate_private.affiliate_country_policies cp
      join affiliate_private.affiliate_program_versions pv
        on pv.id = cp.program_version_id
      where pv.status = 'active'
        and cp.individual_available
        and affiliate_private.payout_currencies_covered(
          pv.payout_thresholds,
          cp.payout_currencies
        )
        and coalesce(cp.effective_from, pv.effective_from) <= now()
        and (cp.effective_until is null or cp.effective_until > now());
      if v_count < 1 then
        raise exception 'an active individual country policy is required'
          using errcode = '55000';
      end if;

      select count(*)
      into v_count
      from affiliate_private.affiliate_country_policies cp
      join affiliate_private.affiliate_program_versions pv
        on pv.id = cp.program_version_id
      where pv.status = 'active'
        and pv.effective_from <= now()
        and (pv.effective_until is null or pv.effective_until > now())
        and cp.individual_available
        and coalesce(cp.effective_from, pv.effective_from) <= now()
        and (cp.effective_until is null or cp.effective_until > now())
        and not affiliate_private.payout_currencies_covered(
          pv.payout_thresholds,
          cp.payout_currencies
        );
      if v_count > 0 then
        raise exception 'an available country policy lacks payout coverage'
          using errcode = '55000';
      end if;

      select count(*)
      into v_count
      from affiliate_private.affiliate_pilot_allowlist a
      where a.status = 'active'
        and (a.expires_at is null or a.expires_at > now());
      if v_count < 1 then
        raise exception 'the pilot allowlist is empty'
          using errcode = '55000';
      end if;
    elsif p_enabled and v_key = 'partners_shadow_mode' then
      select coalesce(f.enabled, false)
      into v_other
      from public.admin_feature_flags f
      where f.key = 'partners_payouts_live';
      if coalesce(v_other, false) then
        raise exception 'shadow mode cannot run with live payouts'
          using errcode = '55000';
      end if;
      if not affiliate_private.release_gates_satisfied(
        array[
          'financial_data_contract_approved',
          'backup_restore_verified'
        ]::text[]
      ) then
        raise exception 'shadow mode prerequisites are incomplete'
          using errcode = '55000';
      end if;
    elsif p_enabled and v_key = 'partners_payouts_live' then
      select coalesce(f.enabled, false)
      into v_other
      from public.admin_feature_flags f
      where f.key = 'partners_enabled';
      if not coalesce(v_other, false) then
        raise exception 'Partners must be enabled before payouts'
          using errcode = '55000';
      end if;

      select coalesce(f.enabled, false)
      into v_other
      from public.admin_feature_flags f
      where f.key = 'partners_shadow_mode';
      if coalesce(v_other, false) then
        raise exception 'shadow mode must be disabled before live payouts'
          using errcode = '55000';
      end if;
      if not affiliate_private.release_gates_satisfied(
        array[
          'legal_and_tax_approved',
          'financial_data_contract_approved',
          'individual_payout_coverage_confirmed',
          'shadow_reconciliation_clean',
          'backup_restore_verified',
          'payout_execution_adapter_verified'
        ]::text[]
      ) then
        raise exception 'payout prerequisites are incomplete'
          using errcode = '55000';
      end if;
    elsif p_enabled and v_key = 'partners_tv_relay_enabled' then
      select coalesce(f.enabled, false)
      into v_other
      from public.admin_feature_flags f
      where f.key = 'partners_enabled';
      if not coalesce(v_other, false) then
        raise exception 'Partners must be enabled before TV relay'
          using errcode = '55000';
      end if;
      if not affiliate_private.release_gates_satisfied(
        array['tv_relay_security_verified']::text[]
      ) then
        raise exception 'TV relay security prerequisite is incomplete'
          using errcode = '55000';
      end if;
    elsif not p_enabled and v_key = 'partners_enabled' then
      select count(*)
      into v_count
      from public.admin_feature_flags f
      where f.key in (
        'partners_payouts_live',
        'partners_tv_relay_enabled'
      )
        and f.enabled;
      if v_count > 0 then
        raise exception 'disable dependent Partners flags first'
          using errcode = '55000';
      end if;
    elsif not p_enabled and v_key = 'partners_invite_only' then
      select coalesce(f.enabled, false)
      into v_other
      from public.admin_feature_flags f
      where f.key = 'partners_enabled';
      if coalesce(v_other, false)
        and not affiliate_private.release_gates_satisfied(
          array['general_release_approved']::text[]
        )
      then
        raise exception 'general release is not approved'
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
    )
    values (
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
  end if;

  if v_action = 'set_gate' then
    if v_key = '' or p_enabled is null then
      raise exception 'gate key and value are required'
        using errcode = '22023';
    end if;

    select g.satisfied
    into v_current
    from affiliate_private.affiliate_release_gates g
    where g.gate_key = v_key
    for update;

    if not found then
      raise exception 'unknown Partners release gate'
        using errcode = 'P0002';
    end if;

    if v_current = p_enabled then
      return jsonb_build_object(
        'action', v_action,
        'key', v_key,
        'satisfied', v_current,
        'changed', false
      );
    end if;

    if not p_enabled then
      if v_key = any (
        array[
          'legal_and_tax_approved',
          'privacy_approved',
          'individual_verification_coverage_confirmed',
          'individual_payout_coverage_confirmed',
          'country_policy_approved'
        ]::text[]
      ) then
        select coalesce(f.enabled, false)
        into v_other
        from public.admin_feature_flags f
        where f.key = 'partners_enabled';
        if coalesce(v_other, false) then
          raise exception 'disable Partners before revoking this gate'
            using errcode = '55000';
        end if;
      end if;

      if v_key = any (
        array[
          'financial_data_contract_approved',
          'backup_restore_verified'
        ]::text[]
      ) then
        select count(*)
        into v_count
        from public.admin_feature_flags f
        where f.key in (
          'partners_shadow_mode',
          'partners_payouts_live'
        )
          and f.enabled;
        if v_count > 0 then
          raise exception 'disable financial Partners flags first'
            using errcode = '55000';
        end if;
      end if;

      if v_key = any (
        array[
          'individual_payout_coverage_confirmed',
          'shadow_reconciliation_clean',
          'payout_execution_adapter_verified'
        ]::text[]
      ) then
        select coalesce(f.enabled, false)
        into v_other
        from public.admin_feature_flags f
        where f.key = 'partners_payouts_live';
        if coalesce(v_other, false) then
          raise exception 'disable payouts before revoking this gate'
            using errcode = '55000';
        end if;
      end if;

      if v_key = 'tv_relay_security_verified' then
        select coalesce(f.enabled, false)
        into v_other
        from public.admin_feature_flags f
        where f.key = 'partners_tv_relay_enabled';
        if coalesce(v_other, false) then
          raise exception 'disable TV relay before revoking this gate'
            using errcode = '55000';
        end if;
      end if;

      if v_key = 'general_release_approved' then
        select count(*)
        into v_count
        from public.admin_feature_flags f
        where (
          f.key = 'partners_enabled'
          and f.enabled
        )
        or (
          f.key = 'partners_invite_only'
          and not f.enabled
        );
        if v_count = 2 then
          raise exception 'restore invite-only before revoking this gate'
            using errcode = '55000';
        end if;
      end if;
    end if;

    v_before := jsonb_build_object('satisfied', v_current);

    update affiliate_private.affiliate_release_gates
    set
      satisfied = p_enabled,
      satisfied_at = case when p_enabled then now() else null end,
      updated_by_pseudonym = v_actor_pseudonym,
      updated_at = now()
    where gate_key = v_key;

    v_after := jsonb_build_object('satisfied', p_enabled);

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
      v_key,
      'release_gate_changed',
      'admin',
      v_actor_pseudonym,
      v_justification,
      v_before,
      v_after
    );

    return jsonb_build_object(
      'action', v_action,
      'key', v_key,
      'satisfied', p_enabled,
      'changed', true
    );
  end if;

  if p_subject_user_id is null or p_enabled is null then
    raise exception 'allowlist subject and value are required'
      using errcode = '22023';
  end if;
  if p_country_code is not null
    and (v_country is null or v_country !~ '^[A-Z]{2}$')
  then
    raise exception 'invalid country code' using errcode = '22023';
  end if;
  if p_subdivision_code is not null
    and (
      v_subdivision is null
      or length(v_subdivision) > 12
      or v_subdivision !~ '^[A-Z0-9]+(?:-[A-Z0-9]+)*$'
    )
  then
    raise exception 'invalid subdivision code' using errcode = '22023';
  end if;
  if v_subdivision is not null and v_country is null then
    raise exception 'subdivision requires a country'
      using errcode = '22023';
  end if;
  if v_subdivision is not null
    and position('-' in v_subdivision) > 0
    and split_part(v_subdivision, '-', 1) <> v_country
  then
    raise exception 'subdivision does not match country'
      using errcode = '22023';
  end if;
  if p_enabled and p_expires_at is not null and p_expires_at <= now() then
    raise exception 'allowlist expiry must be in the future'
      using errcode = '22023';
  end if;
  if not exists (
    select 1
    from auth.users u
    where u.id = p_subject_user_id
  ) then
    raise exception 'allowlist user not found' using errcode = 'P0002';
  end if;

  v_subject_pseudonym := encode(
    extensions.digest(
      'norva-partners-subject:v1:' || p_subject_user_id::text,
      'sha256'
    ),
    'hex'
  );

  select jsonb_build_object(
    'status', a.status,
    'country_code', a.country_code,
    'subdivision_code', a.subdivision_code,
    'expires_at', a.expires_at
  )
  into v_before
  from affiliate_private.affiliate_pilot_allowlist a
  where a.user_id = p_subject_user_id
  for update;

  if not found then
    v_before := '{}'::jsonb;
  end if;

  insert into affiliate_private.affiliate_pilot_allowlist (
    user_id,
    status,
    country_code,
    subdivision_code,
    expires_at,
    added_by_pseudonym,
    created_at,
    updated_at
  )
  values (
    p_subject_user_id,
    case when p_enabled then 'active' else 'revoked' end,
    v_country,
    v_subdivision,
    case when p_enabled then p_expires_at else null end,
    v_actor_pseudonym,
    now(),
    now()
  )
  on conflict (user_id) do update
  set
    status = excluded.status,
    country_code = excluded.country_code,
    subdivision_code = excluded.subdivision_code,
    expires_at = excluded.expires_at,
    added_by_pseudonym = excluded.added_by_pseudonym,
    updated_at = now();

  select jsonb_build_object(
    'status', a.status,
    'country_code', a.country_code,
    'subdivision_code', a.subdivision_code,
    'expires_at', a.expires_at
  )
  into v_after
  from affiliate_private.affiliate_pilot_allowlist a
  where a.user_id = p_subject_user_id;

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
    'pilot_allowlist',
    v_subject_pseudonym,
    'pilot_allowlist_changed',
    'admin',
    v_actor_pseudonym,
    v_justification,
    v_before,
    v_after
  );

  return jsonb_build_object(
    'action', v_action,
    'subject_key', v_subject_pseudonym,
    'included', p_enabled,
    'changed', v_before is distinct from v_after
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
) from public, anon, authenticated;
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

create or replace function public.partners_service_bootstrap(
  p_user_id uuid,
  p_country_code text default null,
  p_subdivision_code text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_country text := nullif(upper(btrim(coalesce(p_country_code, ''))), '');
  v_subdivision text := nullif(
    upper(btrim(coalesce(p_subdivision_code, ''))),
    ''
  );
  v_partners_enabled boolean := false;
  v_invite_only boolean := false;
  v_shadow_mode boolean := false;
  v_payouts_live boolean := false;
  v_tv_relay_enabled boolean := false;
  v_account affiliate_private.affiliate_accounts%rowtype;
  v_program affiliate_private.affiliate_program_versions%rowtype;
  v_policy affiliate_private.affiliate_country_policies%rowtype;
  v_account_exists boolean := false;
  v_program_exists boolean := false;
  v_program_valid boolean := false;
  v_policy_exists boolean := false;
  v_policy_valid boolean := false;
  v_account_user_confirmed boolean := false;
  v_account_evidence_valid boolean := true;
  v_account_attention_required boolean := false;
  v_allowlisted_any boolean := false;
  v_allowlisted_for_jurisdiction boolean := false;
  v_link_status text;
  v_visibility boolean := false;
  v_visibility_reason text := 'disabled';
  v_eligible boolean := false;
  v_eligibility_reason text := 'disabled';
  v_program_json jsonb := null;
  v_policy_json jsonb := null;
begin
  if p_user_id is null then
    raise exception 'user id is required' using errcode = '22023';
  end if;
  if p_country_code is not null
    and (v_country is null or v_country !~ '^[A-Z]{2}$')
  then
    raise exception 'invalid country code' using errcode = '22023';
  end if;
  if p_subdivision_code is not null
    and (
      v_subdivision is null
      or length(v_subdivision) > 12
      or v_subdivision !~ '^[A-Z0-9]+(?:-[A-Z0-9]+)*$'
    )
  then
    raise exception 'invalid subdivision code' using errcode = '22023';
  end if;
  if v_subdivision is not null and v_country is null then
    raise exception 'subdivision requires a country'
      using errcode = '22023';
  end if;
  if v_subdivision is not null
    and position('-' in v_subdivision) > 0
    and split_part(v_subdivision, '-', 1) <> v_country
  then
    raise exception 'subdivision does not match country'
      using errcode = '22023';
  end if;
  if not exists (
    select 1
    from auth.users u
    where u.id = p_user_id
  ) then
    raise exception 'user not found' using errcode = 'P0002';
  end if;

  select coalesce(f.enabled, false)
  into v_partners_enabled
  from public.admin_feature_flags f
  where f.key = 'partners_enabled';
  v_partners_enabled := coalesce(v_partners_enabled, false);

  select coalesce(f.enabled, false)
  into v_invite_only
  from public.admin_feature_flags f
  where f.key = 'partners_invite_only';
  v_invite_only := coalesce(v_invite_only, false);

  select coalesce(f.enabled, false)
  into v_shadow_mode
  from public.admin_feature_flags f
  where f.key = 'partners_shadow_mode';
  v_shadow_mode := coalesce(v_shadow_mode, false);

  select coalesce(f.enabled, false)
  into v_payouts_live
  from public.admin_feature_flags f
  where f.key = 'partners_payouts_live';
  v_payouts_live := coalesce(v_payouts_live, false);

  select coalesce(f.enabled, false)
  into v_tv_relay_enabled
  from public.admin_feature_flags f
  where f.key = 'partners_tv_relay_enabled';
  v_tv_relay_enabled := coalesce(v_tv_relay_enabled, false);

  select a.*
  into v_account
  from affiliate_private.affiliate_accounts a
  where a.user_id = p_user_id
  order by
    case when a.status = 'closed' then 1 else 0 end,
    a.created_at desc
  limit 1;
  v_account_exists := found;

  if v_account_exists then
    select exists (
      select 1
      from auth.users u
      where u.id = v_account.user_id
        and u.email_confirmed_at is not null
    )
    into v_account_user_confirmed;

    if v_account.account_type <> 'individual'
      or v_account.status not in (
        'invited',
        'pending_verification',
        'active',
        'held',
        'suspended',
        'closed'
      )
      or v_account.verification_status not in (
        'not_started',
        'pending',
        'verified',
        'failed',
        'expired'
      )
      or v_account.contract_status not in (
        'not_accepted',
        'accepted',
        'expired'
      )
    then
      raise exception 'invalid Partners account state'
        using errcode = '55000';
    end if;

    v_country := coalesce(v_account.country_code, v_country);
    v_subdivision := coalesce(v_account.subdivision_code, v_subdivision);
  end if;

  if v_account_exists and v_account.program_version_id is not null then
    select p.*
    into v_program
    from affiliate_private.affiliate_program_versions p
    where p.id = v_account.program_version_id;
  else
    select p.*
    into v_program
    from affiliate_private.affiliate_program_versions p
    where p.status = 'active'
      and p.account_type = 'individual'
      and p.effective_from <= now()
      and (p.effective_until is null or p.effective_until > now())
    order by p.effective_from desc
    limit 1;
  end if;
  v_program_exists := found;

  if v_program_exists
    and (
      v_program.account_type <> 'individual'
      or v_program.commission_rate_bps <> 2000
      or v_program.attribution_window_days <> 30
      or v_program.maturation_days <> 45
    )
  then
    raise exception 'Partners P0 program contract is inconsistent'
      using errcode = '55000';
  end if;

  v_program_valid := v_program_exists
    and v_program.status = 'active'
    and v_program.effective_from is not null
    and v_program.effective_from <= now()
    and (
      v_program.effective_until is null
      or v_program.effective_until > now()
    );

  if v_account_exists and v_account.country_policy_id is not null then
    select cp.*
    into v_policy
    from affiliate_private.affiliate_country_policies cp
    where cp.id = v_account.country_policy_id;
  elsif v_program_exists and v_country is not null then
    select cp.*
    into v_policy
    from affiliate_private.affiliate_country_policies cp
    where cp.program_version_id = v_program.id
      and cp.country_code = v_country
      and (
        cp.subdivision_code is null
        or cp.subdivision_code = v_subdivision
      )
    order by
      case
        when v_subdivision is not null
          and cp.subdivision_code = v_subdivision
        then 0
        else 1
      end
    limit 1;
  end if;
  v_policy_exists := found;

  v_policy_valid := v_policy_exists
    and v_program_valid
    and v_policy.individual_available
    and affiliate_private.payout_currencies_covered(
      v_program.payout_thresholds,
      v_policy.payout_currencies
    )
    and (
      v_policy.effective_from is null
      or v_policy.effective_from <= now()
    )
    and (
      v_policy.effective_until is null
      or v_policy.effective_until > now()
    );

  if v_account_exists
    and v_account.program_version_id is not null
    and not v_program_exists
  then
    raise exception 'Partners account program is unavailable'
      using errcode = '55000';
  end if;
  if v_account_exists
    and v_account.country_policy_id is not null
    and (
      not v_policy_exists
      or (
        v_account.program_version_id is not null
        and v_policy.program_version_id <> v_account.program_version_id
      )
      or v_account.country_code is null
      or v_policy.country_code <> v_account.country_code
      or (
        v_account.subdivision_code is null
        and v_policy.subdivision_code is not null
      )
      or (
        v_account.subdivision_code is not null
        and v_policy.subdivision_code is not null
        and v_policy.subdivision_code <> v_account.subdivision_code
      )
    )
  then
    raise exception 'Partners account policy is inconsistent'
      using errcode = '55000';
  end if;

  -- Natural time expiry is an attention state, not a service failure. Keep the
  -- sanitized account snapshot available and let eligibility fail closed.
  v_account_evidence_valid := not v_account_exists
    or v_account.status <> 'active'
    or (
      v_account_user_confirmed
      and v_account.verification_status = 'verified'
      and nullif(btrim(v_account.verification_provider), '') is not null
      and nullif(btrim(v_account.verification_reference), '') is not null
      and v_account.age_verified
      and (
        not v_policy.capacity_required
        or v_account.capacity_verified
      )
      and v_account.contract_status = 'accepted'
      and v_account.verification_provider
        is not distinct from v_policy.verification_provider
      and v_account.terms_version_accepted
        is not distinct from v_policy.terms_version
      and v_account.disclosure_version_accepted
        is not distinct from v_policy.disclosure_version
      and v_account.contract_accepted_at is not null
      and v_account.disclosure_accepted_at is not null
    );
  v_account_attention_required := v_account_exists
    and v_account.status = 'active'
    and (
      not v_program_valid
      or not v_policy_valid
      or not v_account_evidence_valid
    );

  select exists (
    select 1
    from affiliate_private.affiliate_pilot_allowlist a
    where a.user_id = p_user_id
      and a.status = 'active'
      and (a.expires_at is null or a.expires_at > now())
  )
  into v_allowlisted_any;

  select exists (
    select 1
    from affiliate_private.affiliate_pilot_allowlist a
    where a.user_id = p_user_id
      and a.status = 'active'
      and (a.expires_at is null or a.expires_at > now())
      and (a.country_code is null or a.country_code = v_country)
      and (
        a.subdivision_code is null
        or a.subdivision_code = v_subdivision
      )
  )
  into v_allowlisted_for_jurisdiction;

  if v_account_exists then
    select case
      when exists (
        select 1
        from affiliate_private.affiliate_links l
        where l.account_id = v_account.id
          and l.status = 'active'
      ) then 'active'
      when exists (
        select 1
        from affiliate_private.affiliate_links l
        where l.account_id = v_account.id
          and l.status = 'revoked'
      ) then 'revoked'
      else 'none'
    end
    into v_link_status;
  end if;

  if v_account_exists then
    v_visibility := true;
    v_visibility_reason := 'existing_account';
  elsif not v_partners_enabled then
    v_visibility := false;
    v_visibility_reason := 'disabled';
  elsif v_invite_only and not v_allowlisted_any then
    v_visibility := false;
    v_visibility_reason := 'invite_only';
  else
    v_visibility := true;
    v_visibility_reason := 'available';
  end if;

  if not v_partners_enabled then
    v_eligible := false;
    v_eligibility_reason := 'disabled';
  elsif v_account_exists
    and v_account.status in ('held', 'suspended', 'closed')
  then
    v_eligible := false;
    v_eligibility_reason := 'account_blocked';
  elsif v_account_attention_required then
    v_eligible := false;
    v_eligibility_reason := 'account_attention_required';
  elsif not v_program_valid then
    v_eligible := false;
    v_eligibility_reason := 'disabled';
  elsif v_country is null then
    v_eligible := false;
    v_eligibility_reason := 'country_required';
  elsif not v_policy_valid then
    v_eligible := false;
    if v_subdivision is not null
      and exists (
        select 1
        from affiliate_private.affiliate_country_policies cp
        where cp.program_version_id = v_program.id
          and cp.country_code = v_country
      )
    then
      v_eligibility_reason := 'subdivision_not_supported';
    else
      v_eligibility_reason := 'country_not_supported';
    end if;
  elsif v_invite_only and not v_allowlisted_for_jurisdiction then
    v_eligible := false;
    v_eligibility_reason := 'not_allowlisted';
  else
    v_eligible := true;
    v_eligibility_reason := 'eligible';
  end if;

  if v_program_exists then
    v_program_json := jsonb_build_object(
      'version_key', v_program.version_key,
      'commission_rate_bps', v_program.commission_rate_bps,
      'attribution_window_days', v_program.attribution_window_days,
      'maturation_days', v_program.maturation_days,
      'payout_thresholds', v_program.payout_thresholds,
      'effective_from', v_program.effective_from,
      'effective_until', v_program.effective_until
    );
  end if;

  if v_policy_exists then
    v_policy_json := jsonb_build_object(
      'country_code', v_policy.country_code,
      'subdivision_code', v_policy.subdivision_code,
      'individual_available', v_policy.individual_available,
      'minimum_age', v_policy.minimum_age,
      'capacity_required', v_policy.capacity_required,
      'kyc_level', v_policy.verification_level,
      'payout_currencies', v_policy.payout_currencies,
      'terms_version', v_policy.terms_version,
      'disclosure_version', v_policy.disclosure_version
    );
  end if;

  return jsonb_build_object(
    'schema_version', 1,
    'flags', jsonb_build_object(
      'partners_enabled', v_partners_enabled,
      'partners_invite_only', v_invite_only,
      'partners_shadow_mode', v_shadow_mode,
      'partners_payouts_live', v_payouts_live,
      'partners_tv_relay_enabled', v_tv_relay_enabled
    ),
    'visibility', jsonb_build_object(
      'visible', v_visibility,
      'reason', v_visibility_reason
    ),
    'eligibility', jsonb_build_object(
      'eligible', v_eligible,
      'reason', v_eligibility_reason
    ),
    'program', v_program_json,
    'policy', v_policy_json,
    'allowlist', jsonb_build_object(
      'required', v_invite_only,
      'included', v_allowlisted_any
    ),
    'account', jsonb_build_object(
      'exists', v_account_exists,
      'status', case when v_account_exists then v_account.status else null end,
      'account_type',
        case when v_account_exists then v_account.account_type else null end,
      'verification_status',
        case
          when v_account_exists then v_account.verification_status
          else null
        end,
      'contract_status',
        case
          when v_account_exists then v_account.contract_status
          else null
        end,
      'link_status',
        case when v_account_exists then v_link_status else null end
    )
  );
end;
$$;

revoke all on function public.partners_service_bootstrap(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.partners_service_bootstrap(uuid, text, text)
  to service_role;
