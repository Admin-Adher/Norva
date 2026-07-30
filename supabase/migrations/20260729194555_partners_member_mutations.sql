-- Norva Partners P0: authenticated member mutations and sanitized dashboards.
--
-- Public RPCs are SECURITY INVOKER shims with narrow grants. Every privileged
-- implementation remains in the non-exposed affiliate_private schema, uses an
-- empty search_path and receives only the role that needs it.

create table affiliate_private.affiliate_service_idempotency (
  operation          text not null,
  user_id             uuid not null
    references auth.users(id)
    on delete cascade,
  idempotency_key     text not null,
  request_hash        text not null,
  response            jsonb not null,
  created_at          timestamptz not null default now(),
  primary key (operation, user_id, idempotency_key),
  constraint affiliate_service_idempotency_operation
    check (
      operation in (
        'application',
        'terms_acceptance',
        'link_rotation'
      )
    ),
  constraint affiliate_service_idempotency_key
    check (idempotency_key ~ '^[A-Za-z0-9._:-]{16,128}$'),
  constraint affiliate_service_idempotency_hash
    check (request_hash ~ '^[0-9a-f]{64}$'),
  constraint affiliate_service_idempotency_response
    check (jsonb_typeof(response) = 'object')
);

create index affiliate_service_idempotency_retention_idx
  on affiliate_private.affiliate_service_idempotency (created_at);

alter table affiliate_private.affiliate_service_idempotency
  enable row level security;

revoke all on table affiliate_private.affiliate_service_idempotency
  from public, anon, authenticated, service_role;

-- A monotonic cursor avoids returning an account/event UUID in user history.
alter table affiliate_private.affiliate_events
  add column sequence_no bigint generated always as identity;

create unique index affiliate_events_sequence_idx
  on affiliate_private.affiliate_events (sequence_no);

create index affiliate_events_account_history_idx
  on affiliate_private.affiliate_events (
    aggregate_type,
    aggregate_key,
    sequence_no desc
  );

create or replace function affiliate_private.partners_account_state(
  p_account affiliate_private.affiliate_accounts
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'exists', true,
    'status', p_account.status,
    'verification_status', p_account.verification_status,
    'contract_status', p_account.contract_status,
    'link_status',
      case
        when exists (
          select 1
          from affiliate_private.affiliate_links l
          where l.account_id = p_account.id
            and l.status = 'active'
        ) then 'active'
        when exists (
          select 1
          from affiliate_private.affiliate_links l
          where l.account_id = p_account.id
            and l.status = 'revoked'
        ) then 'revoked'
        else 'none'
      end
  );
$$;

create or replace function affiliate_private.partners_next_action(
  p_account affiliate_private.affiliate_accounts
)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when p_account.status in ('held', 'suspended', 'closed')
      then 'contact_support'
    when p_account.contract_status <> 'accepted'
      then 'accept_terms'
    when p_account.verification_status = 'not_started'
      then 'start_verification'
    when p_account.verification_status = 'pending'
      then 'await_verification'
    when p_account.verification_status in ('failed', 'expired')
      then 'start_verification'
    when p_account.status <> 'active'
      then 'activate_account'
    when exists (
      select 1
      from affiliate_private.affiliate_links l
      where l.account_id = p_account.id
        and l.status = 'active'
    ) then 'share_link'
    else 'share_link'
  end;
$$;

create or replace function affiliate_private.partners_replayed_response(
  p_operation text,
  p_user_id uuid,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_request_hash text;
  v_response jsonb;
begin
  select i.request_hash, i.response
  into v_request_hash, v_response
  from affiliate_private.affiliate_service_idempotency i
  where i.operation = p_operation
    and i.user_id = p_user_id
    and i.idempotency_key = p_idempotency_key;

  if not found then
    return null;
  end if;

  if v_request_hash is distinct from p_request_hash then
    raise exception 'idempotency key was reused with another request'
      using errcode = 'P0003';
  end if;

  return v_response || jsonb_build_object('replayed', true);
end;
$$;

create or replace function affiliate_private.partners_store_response(
  p_operation text,
  p_user_id uuid,
  p_idempotency_key text,
  p_request_hash text,
  p_response jsonb
)
returns void
language sql
volatile
set search_path = ''
as $$
  insert into affiliate_private.affiliate_service_idempotency (
    operation,
    user_id,
    idempotency_key,
    request_hash,
    response
  )
  values (
    p_operation,
    p_user_id,
    p_idempotency_key,
    p_request_hash,
    p_response
  );
$$;

create or replace function affiliate_private.partners_service_apply(
  p_user_id uuid,
  p_country_code text,
  p_subdivision_code text,
  p_account_type text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_country text := nullif(upper(btrim(coalesce(p_country_code, ''))), '');
  v_subdivision text := nullif(
    upper(btrim(coalesce(p_subdivision_code, ''))),
    ''
  );
  v_account_type text := lower(btrim(coalesce(p_account_type, '')));
  v_request_hash text;
  v_replay jsonb;
  v_response jsonb;
  v_program affiliate_private.affiliate_program_versions%rowtype;
  v_policy affiliate_private.affiliate_country_policies%rowtype;
  v_account affiliate_private.affiliate_accounts%rowtype;
  v_invite_only boolean := true;
  v_actor_pseudonym text;
begin
  if p_user_id is null then
    raise exception 'user id is required' using errcode = '22023';
  end if;
  if p_idempotency_key is null
    or p_idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$'
  then
    raise exception 'invalid idempotency key' using errcode = '22023';
  end if;
  if v_account_type <> 'individual' then
    raise exception 'only individual Partners accounts are supported'
      using errcode = '22023';
  end if;
  if v_country is null or v_country !~ '^[A-Z]{2}$' then
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
  if v_subdivision is not null
    and position('-' in v_subdivision) > 0
    and split_part(v_subdivision, '-', 1) <> v_country
  then
    raise exception 'subdivision does not match country'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('norva:partners:user:' || p_user_id::text, 0)
  );

  v_request_hash := encode(
    extensions.digest(
      concat_ws(
        chr(31),
        'application:v1',
        p_user_id::text,
        v_country,
        coalesce(v_subdivision, ''),
        v_account_type
      ),
      'sha256'
    ),
    'hex'
  );
  v_replay := affiliate_private.partners_replayed_response(
    'application',
    p_user_id,
    p_idempotency_key,
    v_request_hash
  );
  if v_replay is not null then
    return v_replay;
  end if;

  perform 1
  from auth.users u
  where u.id = p_user_id
  for share;
  if not found then
    raise exception 'user not found' using errcode = 'P0002';
  end if;

  select a.*
  into v_account
  from affiliate_private.affiliate_accounts a
  where a.user_id = p_user_id
    and a.status <> 'closed'
  for update;

  if found then
    v_response := jsonb_build_object(
      'schema_version', 1,
      'action', 'application_submitted',
      'replayed', false,
      'account', affiliate_private.partners_account_state(v_account),
      'next_action', affiliate_private.partners_next_action(v_account)
    );
    perform affiliate_private.partners_store_response(
      'application',
      p_user_id,
      p_idempotency_key,
      v_request_hash,
      v_response
    );
    return v_response;
  end if;

  if not coalesce((
    select f.enabled
    from public.admin_feature_flags f
    where f.key = 'partners_enabled'
  ), false) then
    raise exception 'Partners applications are disabled'
      using errcode = 'P0001';
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
    raise exception 'Partners application prerequisites are incomplete'
      using errcode = '55000';
  end if;

  select coalesce(f.enabled, true)
  into v_invite_only
  from public.admin_feature_flags f
  where f.key = 'partners_invite_only';
  v_invite_only := coalesce(v_invite_only, true);

  if v_invite_only and not exists (
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
  ) then
    raise exception 'user is not included in the Partners pilot'
      using errcode = 'P0001';
  end if;

  if not v_invite_only
    and not affiliate_private.release_gates_satisfied(
      array['general_release_approved']::text[]
    )
  then
    raise exception 'Partners general release is not approved'
      using errcode = 'P0001';
  end if;

  select p.*
  into v_program
  from affiliate_private.affiliate_program_versions p
  where p.status = 'active'
    and p.account_type = 'individual'
    and p.commission_rate_bps = 2000
    and p.attribution_window_days = 30
    and p.maturation_days = 45
    and p.effective_from <= now()
    and (p.effective_until is null or p.effective_until > now())
  for share;
  if not found then
    raise exception 'active Partners program is unavailable'
      using errcode = '55000';
  end if;

  select cp.*
  into v_policy
  from affiliate_private.affiliate_country_policies cp
  where cp.program_version_id = v_program.id
    and cp.country_code = v_country
    and (
      cp.subdivision_code is null
      or cp.subdivision_code = v_subdivision
    )
    and cp.individual_available
    and cp.minimum_age between 18 and 99
    and cp.verification_level in (
      'identity_age_country',
      'identity_age_country_capacity'
    )
    and cp.verification_provider is not null
    and affiliate_private.payout_currencies_covered(
      v_program.payout_thresholds,
      cp.payout_currencies
    )
    and (cp.effective_from is null or cp.effective_from <= now())
    and (cp.effective_until is null or cp.effective_until > now())
  order by
    case
      when v_subdivision is not null
        and cp.subdivision_code = v_subdivision
      then 0
      else 1
    end
  limit 1
  for share;
  if not found then
    raise exception 'Partners country policy is unavailable'
      using errcode = '55000';
  end if;

  v_actor_pseudonym := encode(
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
    program_version_id,
    country_policy_id,
    country_code,
    subdivision_code,
    verification_status,
    contract_status
  )
  values (
    p_user_id,
    v_actor_pseudonym,
    'individual',
    'pending_verification',
    v_program.id,
    v_policy.id,
    v_country,
    v_subdivision,
    'not_started',
    'not_accepted'
  )
  returning * into v_account;

  insert into affiliate_private.affiliate_events (
    aggregate_type,
    aggregate_key,
    action,
    actor_type,
    actor_pseudonym,
    justification,
    after_state
  )
  values (
    'account',
    v_account.id::text,
    'application_submitted',
    'service',
    v_actor_pseudonym,
    'Authenticated user submitted a Partners application.',
    jsonb_build_object(
      'status', v_account.status,
      'verification_status', v_account.verification_status,
      'contract_status', v_account.contract_status
    )
  );

  v_response := jsonb_build_object(
    'schema_version', 1,
    'action', 'application_submitted',
    'replayed', false,
    'account', affiliate_private.partners_account_state(v_account),
    'next_action', 'accept_terms'
  );
  perform affiliate_private.partners_store_response(
    'application',
    p_user_id,
    p_idempotency_key,
    v_request_hash,
    v_response
  );
  return v_response;
end;
$$;

create or replace function affiliate_private.partners_service_accept_terms(
  p_user_id uuid,
  p_terms_version text,
  p_disclosure_version text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_terms text := lower(btrim(coalesce(p_terms_version, '')));
  v_disclosure text := lower(btrim(coalesce(p_disclosure_version, '')));
  v_request_hash text;
  v_replay jsonb;
  v_response jsonb;
  v_account affiliate_private.affiliate_accounts%rowtype;
  v_program affiliate_private.affiliate_program_versions%rowtype;
  v_policy affiliate_private.affiliate_country_policies%rowtype;
  v_contract_changed boolean := false;
  v_before_contract_status text;
  v_activated boolean := false;
  v_invite_only boolean := true;
  v_release_ready boolean := false;
  v_allowlisted boolean := false;
  v_email_confirmed boolean := false;
begin
  if p_user_id is null then
    raise exception 'user id is required' using errcode = '22023';
  end if;
  if p_idempotency_key is null
    or p_idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$'
  then
    raise exception 'invalid idempotency key' using errcode = '22023';
  end if;
  if v_terms !~ '^[a-z0-9][a-z0-9._-]{2,63}$'
    or v_disclosure !~ '^[a-z0-9][a-z0-9._-]{2,63}$'
  then
    raise exception 'invalid contract version' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('norva:partners:user:' || p_user_id::text, 0)
  );

  v_request_hash := encode(
    extensions.digest(
      concat_ws(
        chr(31),
        'terms_acceptance:v1',
        p_user_id::text,
        v_terms,
        v_disclosure
      ),
      'sha256'
    ),
    'hex'
  );
  v_replay := affiliate_private.partners_replayed_response(
    'terms_acceptance',
    p_user_id,
    p_idempotency_key,
    v_request_hash
  );
  if v_replay is not null then
    return v_replay;
  end if;

  select a.*
  into v_account
  from affiliate_private.affiliate_accounts a
  where a.user_id = p_user_id
    and a.status <> 'closed'
  for update;
  if not found then
    raise exception 'Partners account is unavailable'
      using errcode = 'P0001';
  end if;
  if v_account.status in ('suspended', 'closed') then
    raise exception 'Partners account cannot accept terms'
      using errcode = 'P0001';
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
    raise exception 'Partners program is unavailable'
      using errcode = '55000';
  end if;

  select cp.*
  into v_policy
  from affiliate_private.affiliate_country_policies cp
  where cp.id = v_account.country_policy_id
  for share;
  if not found
    or v_policy.program_version_id <> v_program.id
    or v_policy.country_code <> v_account.country_code
    or (
      v_policy.subdivision_code is not null
      and v_policy.subdivision_code
        is distinct from v_account.subdivision_code
    )
    or not v_policy.individual_available
    or v_policy.minimum_age not between 18 and 99
    or v_policy.verification_level not in (
      'identity_age_country',
      'identity_age_country_capacity'
    )
    or v_policy.verification_provider is null
    or (v_policy.effective_from is not null and v_policy.effective_from > now())
    or (
      v_policy.effective_until is not null
      and v_policy.effective_until <= now()
    )
    or not affiliate_private.payout_currencies_covered(
      v_program.payout_thresholds,
      v_policy.payout_currencies
    )
  then
    raise exception 'Partners country policy is unavailable'
      using errcode = '55000';
  end if;

  if v_terms is distinct from v_policy.terms_version
    or v_disclosure is distinct from v_policy.disclosure_version
  then
    raise exception 'current Partners terms must be accepted'
      using errcode = 'P0001';
  end if;

  v_contract_changed :=
    v_account.contract_status <> 'accepted'
    or v_account.terms_version_accepted is distinct from v_terms
    or v_account.disclosure_version_accepted is distinct from v_disclosure;
  v_before_contract_status := v_account.contract_status;

  if v_contract_changed or v_account.status = 'invited' then
    update affiliate_private.affiliate_accounts
    set
      status = case
        when status = 'invited' then 'pending_verification'
        else status
      end,
      contract_status = 'accepted',
      terms_version_accepted = v_terms,
      contract_accepted_at = case
        when v_contract_changed then now()
        else contract_accepted_at
      end,
      disclosure_version_accepted = v_disclosure,
      disclosure_accepted_at = case
        when v_contract_changed then now()
        else disclosure_accepted_at
      end,
      updated_at = now()
    where id = v_account.id
    returning * into v_account;
  end if;

  if v_contract_changed then
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
      'account',
      v_account.id::text,
      'terms_accepted',
      'service',
      v_account.user_pseudonym,
      'Authenticated user accepted the current Partners terms.',
      jsonb_build_object('contract_status', v_before_contract_status),
      jsonb_build_object('contract_status', 'accepted')
    );
  end if;

  select exists (
    select 1
    from auth.users u
    where u.id = p_user_id
      and u.email_confirmed_at is not null
  )
  into v_email_confirmed;

  select coalesce(f.enabled, true)
  into v_invite_only
  from public.admin_feature_flags f
  where f.key = 'partners_invite_only';
  v_invite_only := coalesce(v_invite_only, true);

  select exists (
    select 1
    from affiliate_private.affiliate_pilot_allowlist a
    where a.user_id = p_user_id
      and a.status = 'active'
      and (a.expires_at is null or a.expires_at > now())
      and (
        a.country_code is null
        or a.country_code = v_account.country_code
      )
      and (
        a.subdivision_code is null
        or a.subdivision_code = v_account.subdivision_code
      )
  )
  into v_allowlisted;

  v_release_ready :=
    coalesce((
      select f.enabled
      from public.admin_feature_flags f
      where f.key = 'partners_enabled'
    ), false)
    and affiliate_private.release_gates_satisfied(
      array[
        'legal_and_tax_approved',
        'privacy_approved',
        'individual_verification_coverage_confirmed',
        'individual_payout_coverage_confirmed',
        'country_policy_approved'
      ]::text[]
    )
    and (
      (v_invite_only and v_allowlisted)
      or (
        not v_invite_only
        and affiliate_private.release_gates_satisfied(
          array['general_release_approved']::text[]
        )
      )
    );

  if v_account.status = 'pending_verification'
    and v_account.verification_status = 'verified'
    and v_account.verification_provider
      is not distinct from v_policy.verification_provider
    and nullif(btrim(v_account.verification_reference), '') is not null
    and v_account.age_verified
    and (
      not v_policy.capacity_required
      or v_account.capacity_verified
    )
    and v_email_confirmed
    and v_release_ready
  then
    update affiliate_private.affiliate_accounts
    set
      status = 'active',
      updated_at = now()
    where id = v_account.id
    returning * into v_account;
    v_activated := true;

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
      'account',
      v_account.id::text,
      'account_activated',
      'system',
      v_account.user_pseudonym,
      'Partners account passed all server-side activation gates.',
      jsonb_build_object('status', 'pending_verification'),
      jsonb_build_object('status', 'active')
    );
  end if;

  v_response := jsonb_build_object(
    'schema_version', 1,
    'action', 'terms_accepted',
    'replayed', false,
    'account', affiliate_private.partners_account_state(v_account),
    'next_action',
      case
        when v_account.status in ('held', 'suspended', 'closed')
          then 'contact_support'
        when v_account.verification_status in (
          'not_started',
          'failed',
          'expired'
        ) then 'start_verification'
        when v_account.verification_status = 'pending'
          then 'await_verification'
        when v_activated or v_account.status = 'active'
          then 'share_link'
        when v_account.verification_status = 'verified'
          then 'activate_account'
        else 'none'
      end
  );
  perform affiliate_private.partners_store_response(
    'terms_acceptance',
    p_user_id,
    p_idempotency_key,
    v_request_hash,
    v_response
  );
  return v_response;
end;
$$;

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
  v_policy affiliate_private.affiliate_country_policies%rowtype;
  v_old_link affiliate_private.affiliate_links%rowtype;
  v_new_link affiliate_private.affiliate_links%rowtype;
  v_invite_only boolean := true;
begin
  if p_user_id is null then
    raise exception 'user id is required' using errcode = '22023';
  end if;
  if p_idempotency_key is null
    or p_idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$'
  then
    raise exception 'invalid idempotency key' using errcode = '22023';
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

  select a.*
  into v_account
  from affiliate_private.affiliate_accounts a
  where a.user_id = p_user_id
    and a.status <> 'closed'
  for update;
  if not found or v_account.status <> 'active' then
    raise exception 'active Partners account is required'
      using errcode = 'P0001';
  end if;

  if not coalesce((
    select f.enabled
    from public.admin_feature_flags f
    where f.key = 'partners_enabled'
  ), false)
  then
    raise exception 'Partners link management is disabled'
      using errcode = 'P0001';
  end if;

  select p.*
  into v_program
  from affiliate_private.affiliate_program_versions p
  where p.id = v_account.program_version_id
  for share;
  select cp.*
  into v_policy
  from affiliate_private.affiliate_country_policies cp
  where cp.id = v_account.country_policy_id
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
    or v_policy.verification_level not in (
      'identity_age_country',
      'identity_age_country_capacity'
    )
    or (v_policy.effective_from is not null and v_policy.effective_from > now())
    or (
      v_policy.effective_until is not null
      and v_policy.effective_until <= now()
    )
    or v_account.verification_status <> 'verified'
    or v_account.verification_provider
      is distinct from v_policy.verification_provider
    or nullif(btrim(v_account.verification_reference), '') is null
    or not v_account.age_verified
    or (
      v_policy.capacity_required
      and not v_account.capacity_verified
    )
    or v_account.contract_status <> 'accepted'
    or v_account.terms_version_accepted
      is distinct from v_policy.terms_version
    or v_account.disclosure_version_accepted
      is distinct from v_policy.disclosure_version
  then
    raise exception 'Partners link evidence is not current'
      using errcode = 'P0001';
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
    raise exception 'Partners link prerequisites are incomplete'
      using errcode = '55000';
  end if;

  select coalesce(f.enabled, true)
  into v_invite_only
  from public.admin_feature_flags f
  where f.key = 'partners_invite_only';
  v_invite_only := coalesce(v_invite_only, true);

  if v_invite_only and not exists (
    select 1
    from affiliate_private.affiliate_pilot_allowlist a
    where a.user_id = p_user_id
      and a.status = 'active'
      and (a.expires_at is null or a.expires_at > now())
      and (
        a.country_code is null
        or a.country_code = v_account.country_code
      )
      and (
        a.subdivision_code is null
        or a.subdivision_code = v_account.subdivision_code
      )
  ) then
    raise exception 'user is not included in the Partners pilot'
      using errcode = 'P0001';
  end if;
  if not v_invite_only
    and not affiliate_private.release_gates_satisfied(
      array['general_release_approved']::text[]
    )
  then
    raise exception 'Partners general release is not approved'
      using errcode = 'P0001';
  end if;

  select l.*
  into v_old_link
  from affiliate_private.affiliate_links l
  where l.account_id = v_account.id
    and l.status = 'active'
  for update;

  if found then
    update affiliate_private.affiliate_links
    set
      status = 'revoked',
      revoked_at = now()
    where id = v_old_link.id;
  end if;

  insert into affiliate_private.affiliate_links (
    account_id,
    rotated_from_id,
    created_at
  )
  values (
    v_account.id,
    case when v_old_link.id is null then null else v_old_link.id end,
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
  )
  values (
    'account',
    v_account.id::text,
    case
      when v_old_link.id is null then 'link_created'
      else 'link_rotated'
    end,
    'service',
    v_account.user_pseudonym,
    'Authenticated user renewed the active Partners sharing link.',
    jsonb_build_object(
      'link_status',
      case when v_old_link.id is null then 'none' else 'active' end
    ),
    jsonb_build_object('link_status', 'active')
  );

  v_response := jsonb_build_object(
    'schema_version', 1,
    'action', 'link_rotated',
    'replayed', false,
    'account', affiliate_private.partners_account_state(v_account),
    'next_action', 'share_link',
    'link', jsonb_build_object(
      'status', 'active',
      'share_url', 'https://norva.tv/r/' || v_new_link.public_code,
      'rotated_at', v_new_link.created_at
    )
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

create or replace function affiliate_private.partners_service_dashboard(
  p_user_id uuid,
  p_history_limit integer,
  p_history_cursor text,
  p_history_status text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := coalesce(p_history_limit, 25);
  v_status text := lower(btrim(coalesce(p_history_status, 'all')));
  v_cursor bigint := null;
  v_account affiliate_private.affiliate_accounts%rowtype;
  v_link affiliate_private.affiliate_links%rowtype;
  v_items jsonb := '[]'::jsonb;
  v_candidate_count integer := 0;
  v_last_sequence bigint := null;
  v_next_cursor text := null;
begin
  if p_user_id is null then
    raise exception 'user id is required' using errcode = '22023';
  end if;
  if v_limit not between 1 and 50 then
    raise exception 'history limit must be between 1 and 50'
      using errcode = '22023';
  end if;
  if v_status not in (
    'all',
    'pending',
    'available',
    'held',
    'paid',
    'reversed'
  ) then
    raise exception 'invalid history status' using errcode = '22023';
  end if;
  if p_history_cursor is not null then
    if p_history_cursor !~ '^history_[0-9]{20}$' then
      raise exception 'invalid history cursor' using errcode = '22023';
    end if;
    begin
      v_cursor := substring(p_history_cursor from 9)::bigint;
    exception
      when numeric_value_out_of_range then
        raise exception 'invalid history cursor' using errcode = '22023';
    end;
  end if;

  perform 1
  from auth.users u
  where u.id = p_user_id;
  if not found then
    raise exception 'user not found' using errcode = 'P0002';
  end if;

  select a.*
  into v_account
  from affiliate_private.affiliate_accounts a
  where a.user_id = p_user_id
    and a.status <> 'closed'
  order by a.created_at desc
  limit 1;

  if not found then
    return jsonb_build_object(
      'schema_version', 1,
      'account', jsonb_build_object(
        'exists', false,
        'status', null,
        'verification_status', null,
        'contract_status', null,
        'link_status', null,
        'country_code', null,
        'subdivision_code', null,
        'created_at', null,
        'updated_at', null
      ),
      'link', null,
      'reporting', jsonb_build_object(
        'available', false,
        'reason', 'financial_ledger_not_configured',
        'currency', null,
        'clicks', null,
        'referrals', null,
        'pending_minor', null,
        'available_minor', null,
        'paid_minor', null
      ),
      'history', jsonb_build_object(
        'status', v_status,
        'items', '[]'::jsonb,
        'next_cursor', null
      )
    );
  end if;

  select l.*
  into v_link
  from affiliate_private.affiliate_links l
  where l.account_id = v_account.id
    and l.status = 'active'
  order by l.created_at desc
  limit 1;

  -- Financial filters remain empty until the immutable ledger is introduced.
  -- This prevents audit events from masquerading as commissions or payouts.
  if v_status = 'all' then
    with candidates as (
      select
        e.sequence_no,
        e.action,
        e.created_at
      from affiliate_private.affiliate_events e
      where e.aggregate_type = 'account'
        and e.aggregate_key = v_account.id::text
        and (v_cursor is null or e.sequence_no < v_cursor)
        and e.action in (
          'application_submitted',
          'terms_accepted',
          'account_activated',
          'account_held',
          'account_suspended',
          'link_created',
          'link_rotated',
          'link_revoked'
        )
      order by e.sequence_no desc
      limit v_limit + 1
    ),
    page as (
      select *
      from candidates
      order by sequence_no desc
      limit v_limit
    )
    select
      coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'type', p.action,
            'occurred_at', p.created_at
          )
          order by p.sequence_no desc
        )
        from page p
      ), '[]'::jsonb),
      (select count(*) from candidates),
      (select min(p.sequence_no) from page p)
    into v_items, v_candidate_count, v_last_sequence;

    if v_candidate_count > v_limit and v_last_sequence is not null then
      v_next_cursor := 'history_' || lpad(v_last_sequence::text, 20, '0');
    end if;
  end if;

  return jsonb_build_object(
    'schema_version', 1,
    'account',
      affiliate_private.partners_account_state(v_account)
      || jsonb_build_object(
        'country_code', v_account.country_code,
        'subdivision_code', v_account.subdivision_code,
        'created_at', v_account.created_at,
        'updated_at', v_account.updated_at
      ),
    'link',
      case
        when v_link.id is null then null
        else jsonb_build_object(
          'status', 'active',
          'share_url', 'https://norva.tv/r/' || v_link.public_code,
          'created_at', v_link.created_at
        )
      end,
    'reporting', jsonb_build_object(
      'available', false,
      'reason', 'financial_ledger_not_configured',
      'currency', null,
      'clicks', null,
      'referrals', null,
      'pending_minor', null,
      'available_minor', null,
      'paid_minor', null
    ),
    'history', jsonb_build_object(
      'status', v_status,
      'items', v_items,
      'next_cursor', v_next_cursor
    )
  );
end;
$$;

create or replace function affiliate_private.admin_partners_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_account_statuses jsonb;
  v_verification_statuses jsonb;
  v_link_statuses jsonb;
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select coalesce(
    jsonb_object_agg(s.status, s.total),
    '{}'::jsonb
  )
  into v_account_statuses
  from (
    select a.status, count(*) as total
    from affiliate_private.affiliate_accounts a
    group by a.status
    order by a.status
  ) s;

  select coalesce(
    jsonb_object_agg(s.verification_status, s.total),
    '{}'::jsonb
  )
  into v_verification_statuses
  from (
    select a.verification_status, count(*) as total
    from affiliate_private.affiliate_accounts a
    where a.status <> 'closed'
    group by a.verification_status
    order by a.verification_status
  ) s;

  select coalesce(
    jsonb_object_agg(s.status, s.total),
    '{}'::jsonb
  )
  into v_link_statuses
  from (
    select l.status, count(*) as total
    from affiliate_private.affiliate_links l
    group by l.status
    order by l.status
  ) s;

  return jsonb_build_object(
    'schema_version', 1,
    'accounts_total', (
      select count(*)
      from affiliate_private.affiliate_accounts
    ),
    'accounts_open', (
      select count(*)
      from affiliate_private.affiliate_accounts a
      where a.status <> 'closed'
    ),
    'account_statuses', v_account_statuses,
    'verification_statuses', v_verification_statuses,
    'link_statuses', v_link_statuses,
    'readiness', jsonb_build_object(
      'member_accounts', true,
      'member_links', true,
      'audit_history', true,
      'financial_ledger', false,
      'fraud_workbench', false,
      'payout_operations', false,
      'reason', 'financial_control_plane_not_configured'
    ),
    'generated_at', now()
  );
end;
$$;

create or replace function affiliate_private.admin_partners_accounts(
  p_limit integer,
  p_offset integer,
  p_status text,
  p_search text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := coalesce(p_limit, 50);
  v_offset integer := coalesce(p_offset, 0);
  v_status text := lower(btrim(coalesce(p_status, 'all')));
  v_search text := nullif(lower(btrim(coalesce(p_search, ''))), '');
  v_total bigint := 0;
  v_items jsonb := '[]'::jsonb;
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if v_limit not between 1 and 100
    or v_offset not between 0 and 100000
  then
    raise exception 'invalid pagination' using errcode = '22023';
  end if;
  if v_status not in (
    'all',
    'invited',
    'pending_verification',
    'active',
    'held',
    'suspended',
    'closed'
  ) then
    raise exception 'invalid account status filter' using errcode = '22023';
  end if;
  if v_search is not null
    and (
      length(v_search) > 64
      or v_search !~ '^[0-9a-f-]+$'
    )
  then
    raise exception 'invalid account search' using errcode = '22023';
  end if;

  select count(*)
  into v_total
  from affiliate_private.affiliate_accounts a
  where (v_status = 'all' or a.status = v_status)
    and (
      v_search is null
      or lower(a.id::text) like v_search || '%'
      or a.user_pseudonym like v_search || '%'
    );

  select coalesce(jsonb_agg(row_data order by created_at desc), '[]'::jsonb)
  into v_items
  from (
    select
      a.created_at,
      jsonb_build_object(
        'account_id', a.id,
        'partner_key', left(a.user_pseudonym, 12),
        'status', a.status,
        'country_code', a.country_code,
        'subdivision_code', a.subdivision_code,
        'verification_status', a.verification_status,
        'contract_status', a.contract_status,
        'link_status',
          case
            when exists (
              select 1
              from affiliate_private.affiliate_links l
              where l.account_id = a.id
                and l.status = 'active'
            ) then 'active'
            when exists (
              select 1
              from affiliate_private.affiliate_links l
              where l.account_id = a.id
                and l.status = 'revoked'
            ) then 'revoked'
            else 'none'
          end,
        'created_at', a.created_at,
        'updated_at', a.updated_at
      ) as row_data
    from affiliate_private.affiliate_accounts a
    where (v_status = 'all' or a.status = v_status)
      and (
        v_search is null
        or lower(a.id::text) like v_search || '%'
        or a.user_pseudonym like v_search || '%'
      )
    order by a.created_at desc, a.id
    limit v_limit
    offset v_offset
  ) page;

  return jsonb_build_object(
    'schema_version', 1,
    'total', v_total,
    'limit', v_limit,
    'offset', v_offset,
    'items', v_items
  );
end;
$$;

create or replace function affiliate_private.admin_partners_detail(
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
  v_program affiliate_private.affiliate_program_versions%rowtype;
  v_policy affiliate_private.affiliate_country_policies%rowtype;
  v_link affiliate_private.affiliate_links%rowtype;
  v_activity jsonb := '[]'::jsonb;
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_account_id is null then
    raise exception 'account id is required' using errcode = '22023';
  end if;

  select a.*
  into v_account
  from affiliate_private.affiliate_accounts a
  where a.id = p_account_id;
  if not found then
    raise exception 'Partners account not found' using errcode = 'P0002';
  end if;

  select p.*
  into v_program
  from affiliate_private.affiliate_program_versions p
  where p.id = v_account.program_version_id;

  select cp.*
  into v_policy
  from affiliate_private.affiliate_country_policies cp
  where cp.id = v_account.country_policy_id;

  select l.*
  into v_link
  from affiliate_private.affiliate_links l
  where l.account_id = v_account.id
  order by
    case when l.status = 'active' then 0 else 1 end,
    l.created_at desc
  limit 1;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'action', e.action,
        'actor_type', e.actor_type,
        'occurred_at', e.created_at
      )
      order by e.sequence_no desc
    ),
    '[]'::jsonb
  )
  into v_activity
  from (
    select event.*
    from affiliate_private.affiliate_events event
    where event.aggregate_type = 'account'
      and event.aggregate_key = v_account.id::text
    order by event.sequence_no desc
    limit 50
  ) e;

  return jsonb_build_object(
    'schema_version', 1,
    'account', jsonb_build_object(
      'account_id', v_account.id,
      'partner_key', left(v_account.user_pseudonym, 12),
      'account_type', v_account.account_type,
      'status', v_account.status,
      'country_code', v_account.country_code,
      'subdivision_code', v_account.subdivision_code,
      'verification_status', v_account.verification_status,
      'age_verified', v_account.age_verified,
      'capacity_verified', v_account.capacity_verified,
      'contract_status', v_account.contract_status,
      'terms_version_accepted', v_account.terms_version_accepted,
      'disclosure_version_accepted',
        v_account.disclosure_version_accepted,
      'created_at', v_account.created_at,
      'updated_at', v_account.updated_at,
      'closed_at', v_account.closed_at
    ),
    'program',
      case
        when v_program.id is null then null
        else jsonb_build_object(
          'version_key', v_program.version_key,
          'commission_rate_bps', v_program.commission_rate_bps,
          'attribution_window_days', v_program.attribution_window_days,
          'maturation_days', v_program.maturation_days,
          'status', v_program.status
        )
      end,
    'policy',
      case
        when v_policy.id is null then null
        else jsonb_build_object(
          'country_code', v_policy.country_code,
          'subdivision_code', v_policy.subdivision_code,
          'minimum_age', v_policy.minimum_age,
          'capacity_required', v_policy.capacity_required,
          'verification_level', v_policy.verification_level,
          'payout_currencies', v_policy.payout_currencies,
          'terms_version', v_policy.terms_version,
          'disclosure_version', v_policy.disclosure_version
        )
      end,
    'link',
      case
        when v_link.id is null then null
        else jsonb_build_object(
          'status', v_link.status,
          'code_preview',
            left(v_link.public_code, 4)
            || '...'
            || right(v_link.public_code, 4),
          'created_at', v_link.created_at,
          'revoked_at', v_link.revoked_at
        )
      end,
    'activity', v_activity,
    'readiness', jsonb_build_object(
      'financial_ledger', false,
      'fraud_workbench', false,
      'payout_operations', false,
      'reason', 'financial_control_plane_not_configured'
    )
  );
end;
$$;

-- Public service RPC shims. The Edge Function validates the user JWT and passes
-- only its authoritative user id; browsers never receive service-role access.
create or replace function public.partners_service_apply(
  p_user_id uuid,
  p_country_code text,
  p_subdivision_code text,
  p_account_type text,
  p_idempotency_key text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.partners_service_apply(
    p_user_id,
    p_country_code,
    p_subdivision_code,
    p_account_type,
    p_idempotency_key
  );
$$;

create or replace function public.partners_service_accept_terms(
  p_user_id uuid,
  p_terms_version text,
  p_disclosure_version text,
  p_idempotency_key text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.partners_service_accept_terms(
    p_user_id,
    p_terms_version,
    p_disclosure_version,
    p_idempotency_key
  );
$$;

create or replace function public.partners_service_rotate_link(
  p_user_id uuid,
  p_idempotency_key text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.partners_service_rotate_link(
    p_user_id,
    p_idempotency_key
  );
$$;

create or replace function public.partners_service_dashboard(
  p_user_id uuid,
  p_history_limit integer,
  p_history_cursor text,
  p_history_status text
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select affiliate_private.partners_service_dashboard(
    p_user_id,
    p_history_limit,
    p_history_cursor,
    p_history_status
  );
$$;

create or replace function public.admin_partners_overview()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select affiliate_private.admin_partners_overview();
$$;

create or replace function public.admin_partners_accounts(
  p_limit integer,
  p_offset integer,
  p_status text,
  p_search text
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select affiliate_private.admin_partners_accounts(
    p_limit,
    p_offset,
    p_status,
    p_search
  );
$$;

create or replace function public.admin_partners_detail(
  p_account_id uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select affiliate_private.admin_partners_detail(p_account_id);
$$;

-- Remove PostgreSQL's default PUBLIC execute from every function introduced by
-- this migration. Keep foundation privileges untouched for safe roll-forward.
revoke all on function affiliate_private.partners_account_state(
  affiliate_private.affiliate_accounts
) from public, anon, authenticated, service_role;
revoke all on function affiliate_private.partners_next_action(
  affiliate_private.affiliate_accounts
) from public, anon, authenticated, service_role;
revoke all on function affiliate_private.partners_replayed_response(
  text,
  uuid,
  text,
  text
) from public, anon, authenticated, service_role;
revoke all on function affiliate_private.partners_store_response(
  text,
  uuid,
  text,
  text,
  jsonb
) from public, anon, authenticated, service_role;
revoke all on function affiliate_private.partners_service_apply(
  uuid,
  text,
  text,
  text,
  text
) from public, anon, authenticated, service_role;
revoke all on function affiliate_private.partners_service_accept_terms(
  uuid,
  text,
  text,
  text
) from public, anon, authenticated, service_role;
revoke all on function affiliate_private.partners_service_rotate_link(
  uuid,
  text
) from public, anon, authenticated, service_role;
revoke all on function affiliate_private.partners_service_dashboard(
  uuid,
  integer,
  text,
  text
) from public, anon, authenticated, service_role;
revoke all on function affiliate_private.admin_partners_overview()
  from public, anon, authenticated, service_role;
revoke all on function affiliate_private.admin_partners_accounts(
  integer,
  integer,
  text,
  text
) from public, anon, authenticated, service_role;
revoke all on function affiliate_private.admin_partners_detail(uuid)
  from public, anon, authenticated, service_role;

grant usage on schema affiliate_private to authenticated;

grant execute on function affiliate_private.partners_service_apply(
  uuid,
  text,
  text,
  text,
  text
) to service_role;
grant execute on function affiliate_private.partners_service_accept_terms(
  uuid,
  text,
  text,
  text
) to service_role;
grant execute on function affiliate_private.partners_service_rotate_link(
  uuid,
  text
) to service_role;
grant execute on function affiliate_private.partners_service_dashboard(
  uuid,
  integer,
  text,
  text
) to service_role;

grant execute on function affiliate_private.admin_partners_overview()
  to authenticated;
grant execute on function affiliate_private.admin_partners_accounts(
  integer,
  integer,
  text,
  text
) to authenticated;
grant execute on function affiliate_private.admin_partners_detail(uuid)
  to authenticated;

revoke all on function public.partners_service_apply(
  uuid,
  text,
  text,
  text,
  text
) from public, anon, authenticated, service_role;
grant execute on function public.partners_service_apply(
  uuid,
  text,
  text,
  text,
  text
) to service_role;

revoke all on function public.partners_service_accept_terms(
  uuid,
  text,
  text,
  text
) from public, anon, authenticated, service_role;
grant execute on function public.partners_service_accept_terms(
  uuid,
  text,
  text,
  text
) to service_role;

revoke all on function public.partners_service_rotate_link(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.partners_service_rotate_link(uuid, text)
  to service_role;

revoke all on function public.partners_service_dashboard(
  uuid,
  integer,
  text,
  text
) from public, anon, authenticated, service_role;
grant execute on function public.partners_service_dashboard(
  uuid,
  integer,
  text,
  text
) to service_role;

revoke all on function public.admin_partners_overview()
  from public, anon, authenticated, service_role;
grant execute on function public.admin_partners_overview()
  to authenticated;

revoke all on function public.admin_partners_accounts(
  integer,
  integer,
  text,
  text
) from public, anon, authenticated, service_role;
grant execute on function public.admin_partners_accounts(
  integer,
  integer,
  text,
  text
) to authenticated;

revoke all on function public.admin_partners_detail(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_partners_detail(uuid)
  to authenticated;
