-- Norva Partners: non-commercial access requests while the programme is closed.
--
-- An access request is deliberately separate from an affiliate account. It
-- cannot accept contractual terms, start KYC, create a referral link, post a
-- ledger fact or change any release flag/gate. Approval only adds the existing
-- audited pilot allowlist entry; partners_enabled remains the authoritative
-- enrollment boundary.

alter default privileges in schema affiliate_private
  revoke execute on functions from public;

create table affiliate_private.affiliate_access_requests (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null unique
    references auth.users(id)
    on delete cascade,
  user_pseudonym           text not null,
  status                   text not null default 'requested',
  country_code             text not null,
  subdivision_code         text,
  requested_at             timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  reviewed_at              timestamptz,
  reviewed_by_pseudonym    text,
  constraint affiliate_access_requests_pseudonym
    check (user_pseudonym ~ '^[0-9a-f]{64}$'),
  constraint affiliate_access_requests_status
    check (status in ('requested', 'approved', 'declined')),
  constraint affiliate_access_requests_country
    check (country_code ~ '^[A-Z]{2}$'),
  constraint affiliate_access_requests_subdivision
    check (
      subdivision_code is null
      or (
        length(subdivision_code) <= 12
        and subdivision_code ~ '^[A-Z0-9]+(?:-[A-Z0-9]+)*$'
      )
    ),
  constraint affiliate_access_requests_subdivision_country
    check (
      subdivision_code is null
      or position('-' in subdivision_code) = 0
      or split_part(subdivision_code, '-', 1) = country_code
    ),
  constraint affiliate_access_requests_reviewer
    check (
      reviewed_by_pseudonym is null
      or reviewed_by_pseudonym ~ '^[0-9a-f]{64}$'
    ),
  constraint affiliate_access_requests_review_state
    check (
      (
        status = 'requested'
        and reviewed_at is null
        and reviewed_by_pseudonym is null
      )
      or (
        status in ('approved', 'declined')
        and reviewed_at is not null
        and reviewed_by_pseudonym is not null
      )
    )
);

create index affiliate_access_requests_queue_idx
  on affiliate_private.affiliate_access_requests (
    status,
    requested_at desc,
    id
  );

alter table affiliate_private.affiliate_access_requests
  enable row level security;

revoke all on table affiliate_private.affiliate_access_requests
  from public, anon, authenticated, service_role;

alter table affiliate_private.affiliate_service_idempotency
  add constraint affiliate_service_idempotency_operation_v2
  check (
    operation in (
      'application',
      'terms_acceptance',
      'link_rotation',
      'kyc_prepare',
      'kyc_session_record',
      'referral_claim',
      'payout_profile',
      'tv_relay_consume',
      'access_request'
    )
  ) not valid;
alter table affiliate_private.affiliate_service_idempotency
  validate constraint affiliate_service_idempotency_operation_v2;
alter table affiliate_private.affiliate_service_idempotency
  drop constraint affiliate_service_idempotency_operation;
alter table affiliate_private.affiliate_service_idempotency
  rename constraint affiliate_service_idempotency_operation_v2
  to affiliate_service_idempotency_operation;

alter table affiliate_private.affiliate_events
  add constraint affiliate_events_aggregate_type_v2
  check (
    aggregate_type in (
      'release_gate',
      'feature_flag',
      'pilot_allowlist',
      'program_version',
      'country_policy',
      'account',
      'link',
      'kyc',
      'attribution',
      'financial_fact',
      'commission',
      'payout',
      'tv_relay',
      'admin_capability',
      'worker',
      'configuration',
      'access_request'
    )
  ) not valid;
alter table affiliate_private.affiliate_events
  validate constraint affiliate_events_aggregate_type_v2;
alter table affiliate_private.affiliate_events
  drop constraint affiliate_events_aggregate_type;
alter table affiliate_private.affiliate_events
  rename constraint affiliate_events_aggregate_type_v2
  to affiliate_events_aggregate_type;

create index affiliate_service_idempotency_access_request_retention_idx
  on affiliate_private.affiliate_service_idempotency (created_at, user_id)
  where operation = 'access_request';

create or replace function affiliate_private.partners_access_request_state(
  p_request affiliate_private.affiliate_access_requests
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'exists', true,
    'status', p_request.status,
    'country_code', p_request.country_code,
    'subdivision_code', p_request.subdivision_code,
    'requested_at', p_request.requested_at,
    'reviewed_at', p_request.reviewed_at
  );
$$;

create or replace function affiliate_private.partners_access_request_next_action(
  p_status text
)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_status
    when 'requested' then 'await_review'
    when 'approved' then 'access_approved'
    else 'contact_support'
  end;
$$;

create or replace function affiliate_private.partners_access_program_preview()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'commission_rate_bps', programme.commission_rate_bps,
    'attribution_window_days', programme.attribution_window_days,
    'maturation_days', programme.maturation_days,
    'payout_thresholds', programme.payout_thresholds
  )
  from affiliate_private.affiliate_program_versions programme
  where programme.account_type = 'individual'
    and programme.status in ('draft', 'active')
    and programme.commission_rate_bps = 2000
    and programme.attribution_window_days = 30
    and programme.maturation_days = 45
    and programme.payout_thresholds @> '{"USD": 1000}'::jsonb
  order by
    case when programme.status = 'active' then 0 else 1 end,
    programme.created_at desc
  limit 1;
$$;

create or replace function affiliate_private.partners_service_access_request_get(
  p_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_request affiliate_private.affiliate_access_requests%rowtype;
begin
  if p_user_id is null then
    raise exception 'user id is required' using errcode = '22023';
  end if;
  if not exists (
    select 1
    from auth.users account_user
    where account_user.id = p_user_id
  ) then
    raise exception 'user not found' using errcode = 'P0002';
  end if;

  select request_row.*
  into v_request
  from affiliate_private.affiliate_access_requests request_row
  where request_row.user_id = p_user_id;

  return jsonb_build_object(
    'schema_version', 1,
    'program_preview',
      affiliate_private.partners_access_program_preview(),
    'request', case
      when found then
        affiliate_private.partners_access_request_state(v_request)
      else jsonb_build_object(
        'exists', false,
        'status', null,
        'country_code', null,
        'subdivision_code', null,
        'requested_at', null,
        'reviewed_at', null
      )
    end
  );
end;
$$;

create or replace function affiliate_private.partners_service_access_request_submit(
  p_user_id uuid,
  p_country_code text,
  p_subdivision_code text,
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
  v_request_hash text;
  v_replay jsonb;
  v_response jsonb;
  v_request affiliate_private.affiliate_access_requests%rowtype;
  v_actor_pseudonym text;
  v_before jsonb := '{}'::jsonb;
  v_changed boolean := false;
  v_recent_attempts integer := 0;
begin
  if p_user_id is null then
    raise exception 'user id is required' using errcode = '22023';
  end if;
  if p_idempotency_key is null
    or p_idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$'
  then
    raise exception 'invalid idempotency key' using errcode = '22023';
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
        'access-request:v1',
        p_user_id::text,
        v_country,
        coalesce(v_subdivision, '')
      ),
      'sha256'
    ),
    'hex'
  );
  v_replay := affiliate_private.partners_replayed_response(
    'access_request',
    p_user_id,
    p_idempotency_key,
    v_request_hash
  );
  if v_replay is not null then
    return v_replay;
  end if;

  -- A successful retry with the same key is handled above. Distinct-key bursts
  -- are bounded here, inside the per-user advisory lock, so a client cannot
  -- grow the idempotency table or alternate jurisdictions without limit.
  delete from affiliate_private.affiliate_service_idempotency old_request
  where old_request.ctid in (
    select candidate.ctid
    from affiliate_private.affiliate_service_idempotency candidate
    where candidate.operation = 'access_request'
      and candidate.created_at < now() - interval '30 days'
    order by candidate.created_at
    limit 200
  );
  select count(*)::integer
  into v_recent_attempts
  from affiliate_private.affiliate_service_idempotency recent_request
  where recent_request.operation = 'access_request'
    and recent_request.user_id = p_user_id
    and recent_request.created_at >= now() - interval '24 hours';
  if v_recent_attempts >= 8
    or exists (
      select 1
      from affiliate_private.affiliate_service_idempotency recent_request
      where recent_request.operation = 'access_request'
        and recent_request.user_id = p_user_id
        and recent_request.created_at >= now() - interval '60 seconds'
    )
  then
    raise exception 'access request rate limit exceeded'
      using errcode = 'P0008';
  end if;

  perform 1
  from auth.users account_user
  where account_user.id = p_user_id
    and account_user.email_confirmed_at is not null
  for share;
  if not found then
    raise exception 'a confirmed user account is required'
      using errcode = 'P0001';
  end if;

  if exists (
    select 1
    from affiliate_private.affiliate_accounts account
    where account.user_id = p_user_id
      and account.status <> 'closed'
  ) then
    raise exception 'an open Partners account already exists'
      using errcode = 'P0001';
  end if;

  v_actor_pseudonym := encode(
    extensions.digest(
      'norva-partners-subject:v1:' || p_user_id::text,
      'sha256'
    ),
    'hex'
  );

  select request_row.*
  into v_request
  from affiliate_private.affiliate_access_requests request_row
  where request_row.user_id = p_user_id
  for update;

  if not found then
    insert into affiliate_private.affiliate_access_requests (
      user_id,
      user_pseudonym,
      status,
      country_code,
      subdivision_code
    )
    values (
      p_user_id,
      v_actor_pseudonym,
      'requested',
      v_country,
      v_subdivision
    )
    returning * into v_request;
    v_changed := true;
  elsif v_request.status = 'requested'
    and (
      v_request.country_code is distinct from v_country
      or v_request.subdivision_code is distinct from v_subdivision
    )
  then
    v_before := affiliate_private.partners_access_request_state(v_request);
    update affiliate_private.affiliate_access_requests request_row
    set
      country_code = v_country,
      subdivision_code = v_subdivision,
      updated_at = now()
    where request_row.id = v_request.id
    returning request_row.* into v_request;
    v_changed := true;
  end if;

  if v_changed then
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
      'access_request',
      v_request.id::text,
      case
        when v_before = '{}'::jsonb then 'access_request_submitted'
        else 'access_request_updated'
      end,
      'service',
      v_actor_pseudonym,
      'Authenticated user requested access to the Norva Partners pilot.',
      v_before,
      affiliate_private.partners_access_request_state(v_request)
        - 'requested_at'
        - 'reviewed_at'
    );
  end if;

  v_response := jsonb_build_object(
    'schema_version', 1,
    'program_preview',
      affiliate_private.partners_access_program_preview(),
    'action', 'access_requested',
    'replayed', not v_changed,
    'request', affiliate_private.partners_access_request_state(v_request),
    'next_action',
      affiliate_private.partners_access_request_next_action(v_request.status)
  );
  perform affiliate_private.partners_store_response(
    'access_request',
    p_user_id,
    p_idempotency_key,
    v_request_hash,
    v_response
  );
  return v_response;
end;
$$;

create or replace function affiliate_private.admin_partners_access_requests(
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
  if not (
    affiliate_private.partners_has_capability('support')
    or affiliate_private.partners_has_capability('risk')
  ) then
    raise exception 'Partners Support or Risk capability is required'
      using errcode = '42501';
  end if;
  if v_limit not between 1 and 100
    or v_offset not between 0 and 100000
  then
    raise exception 'invalid pagination' using errcode = '22023';
  end if;
  if v_status not in ('all', 'requested', 'approved', 'declined') then
    raise exception 'invalid access request status filter'
      using errcode = '22023';
  end if;
  if v_search is not null
    and (
      length(v_search) > 254
      or v_search ~ '[[:cntrl:]]'
    )
  then
    raise exception 'invalid access request search'
      using errcode = '22023';
  end if;

  select count(*)
  into v_total
  from affiliate_private.affiliate_access_requests request_row
  join auth.users account_user on account_user.id = request_row.user_id
  where (v_status = 'all' or request_row.status = v_status)
    and (
      v_search is null
      or lower(account_user.email) like '%' || v_search || '%'
      or request_row.user_pseudonym like v_search || '%'
      or lower(request_row.id::text) like v_search || '%'
    );

  select coalesce(
    jsonb_agg(row_data order by requested_at desc, request_id),
    '[]'::jsonb
  )
  into v_items
  from (
    select
      request_row.requested_at,
      request_row.id as request_id,
      jsonb_build_object(
        'request_id', request_row.id,
        'subject_key', left(request_row.user_pseudonym, 12),
        'email_masked', case
          when nullif(account_user.email, '') is null
            or position('@' in account_user.email) <= 1
          then null
          else left(account_user.email, 1)
            || '***'
            || substring(
              account_user.email
              from position('@' in account_user.email)
            )
        end,
        'status', request_row.status,
        'country_code', request_row.country_code,
        'subdivision_code', request_row.subdivision_code,
        'requested_at', request_row.requested_at,
        'reviewed_at', request_row.reviewed_at
      ) as row_data
    from affiliate_private.affiliate_access_requests request_row
    join auth.users account_user on account_user.id = request_row.user_id
    where (v_status = 'all' or request_row.status = v_status)
      and (
        v_search is null
        or lower(account_user.email) like '%' || v_search || '%'
        or request_row.user_pseudonym like v_search || '%'
        or lower(request_row.id::text) like v_search || '%'
      )
    order by request_row.requested_at desc, request_row.id
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

create or replace function affiliate_private.admin_partners_access_request_decide(
  p_request_id uuid,
  p_decision text,
  p_expires_at timestamptz,
  p_justification text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_decision text := lower(btrim(coalesce(p_decision, '')));
  v_target_status text;
  v_justification text := btrim(coalesce(p_justification, ''));
  v_request affiliate_private.affiliate_access_requests%rowtype;
  v_actor uuid := auth.uid();
  v_actor_pseudonym text;
  v_before jsonb;
  v_allowlist_included boolean := false;
begin
  perform affiliate_private.partners_require_capability('risk');
  perform affiliate_private.partners_require_aal2(
    'Partners access request decision'
  );
  if p_request_id is null then
    raise exception 'access request id is required' using errcode = '22023';
  end if;
  if v_decision not in ('approve', 'decline') then
    raise exception 'invalid access request decision'
      using errcode = '22023';
  end if;
  if length(v_justification) not between 12 and 1000 then
    raise exception 'justification must contain 12 to 1000 characters'
      using errcode = '22023';
  end if;
  if v_decision = 'decline' and p_expires_at is not null then
    raise exception 'declined access requests cannot have an expiry'
      using errcode = '22023';
  end if;
  if v_decision = 'approve'
    and p_expires_at is not null
    and p_expires_at <= now()
  then
    raise exception 'allowlist expiry must be in the future'
      using errcode = '22023';
  end if;
  if v_actor is null then
    raise exception 'admin identity unavailable' using errcode = '42501';
  end if;

  v_target_status := case
    when v_decision = 'approve' then 'approved'
    else 'declined'
  end;
  v_actor_pseudonym := encode(
    extensions.digest(
      'norva-partners-actor:v1:' || v_actor::text,
      'sha256'
    ),
    'hex'
  );

  perform pg_advisory_xact_lock(
    hashtextextended('norva:partners:release-control', 0)
  );
  select request_row.*
  into v_request
  from affiliate_private.affiliate_access_requests request_row
  where request_row.id = p_request_id
  for update;
  if not found then
    raise exception 'Partners access request not found'
      using errcode = 'P0002';
  end if;

  if v_request.status = v_target_status then
    select exists (
      select 1
      from affiliate_private.affiliate_pilot_allowlist allowlist_row
      where allowlist_row.user_id = v_request.user_id
        and allowlist_row.status = 'active'
        and (
          allowlist_row.expires_at is null
          or allowlist_row.expires_at > now()
        )
    )
    into v_allowlist_included;
    return jsonb_build_object(
      'schema_version', 1,
      'action', 'access_request_decided',
      'status', v_request.status,
      'changed', false,
      'allowlist_included', v_allowlist_included
    );
  end if;
  if v_request.status <> 'requested' then
    raise exception 'Partners access request is already decided'
      using errcode = 'P0001';
  end if;

  v_before := affiliate_private.partners_access_request_state(v_request)
    - 'requested_at'
    - 'reviewed_at';

  if v_decision = 'approve' then
    perform public.admin_partners_control(
      'set_allowlist',
      null,
      true,
      v_justification,
      v_request.user_id,
      v_request.country_code,
      v_request.subdivision_code,
      p_expires_at
    );
    v_allowlist_included := true;
  end if;

  update affiliate_private.affiliate_access_requests request_row
  set
    status = v_target_status,
    reviewed_at = now(),
    reviewed_by_pseudonym = v_actor_pseudonym,
    updated_at = now()
  where request_row.id = v_request.id
  returning request_row.* into v_request;

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
    'access_request',
    v_request.id::text,
    'access_request_decided',
    'admin',
    v_actor_pseudonym,
    v_justification,
    v_before,
    affiliate_private.partners_access_request_state(v_request)
      - 'requested_at'
      - 'reviewed_at'
  );

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'access_request_decided',
    'status', v_request.status,
    'changed', true,
    'allowlist_included', v_allowlist_included
  );
end;
$$;

create or replace function public.partners_service_access_request_get(
  p_user_id uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select affiliate_private.partners_service_access_request_get(p_user_id);
$$;

create or replace function public.partners_service_access_request_submit(
  p_user_id uuid,
  p_country_code text,
  p_subdivision_code text,
  p_idempotency_key text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.partners_service_access_request_submit(
    p_user_id,
    p_country_code,
    p_subdivision_code,
    p_idempotency_key
  );
$$;

create or replace function public.admin_partners_access_requests(
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
  select affiliate_private.admin_partners_access_requests(
    p_limit,
    p_offset,
    p_status,
    p_search
  );
$$;

create or replace function public.admin_partners_access_request_decide(
  p_request_id uuid,
  p_decision text,
  p_expires_at timestamptz,
  p_justification text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.admin_partners_access_request_decide(
    p_request_id,
    p_decision,
    p_expires_at,
    p_justification
  );
$$;

revoke all on function affiliate_private.partners_access_request_state(
  affiliate_private.affiliate_access_requests
) from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.partners_access_request_next_action(text)
from public, anon, authenticated, service_role;
revoke all on function affiliate_private.partners_access_program_preview()
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.partners_service_access_request_get(uuid)
from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.partners_service_access_request_submit(
    uuid, text, text, text
  )
from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.admin_partners_access_requests(
    integer, integer, text, text
  )
from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.admin_partners_access_request_decide(
    uuid, text, timestamptz, text
  )
from public, anon, authenticated, service_role;

grant execute on function
  affiliate_private.partners_service_access_request_get(uuid)
to service_role;
grant execute on function
  affiliate_private.partners_service_access_request_submit(
    uuid, text, text, text
  )
to service_role;
grant execute on function
  affiliate_private.admin_partners_access_requests(
    integer, integer, text, text
  )
to authenticated;
grant execute on function
  affiliate_private.admin_partners_access_request_decide(
    uuid, text, timestamptz, text
  )
to authenticated;

revoke all on function public.partners_service_access_request_get(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.partners_service_access_request_get(uuid)
  to service_role;

revoke all on function public.partners_service_access_request_submit(
  uuid, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.partners_service_access_request_submit(
  uuid, text, text, text
) to service_role;

revoke all on function public.admin_partners_access_requests(
  integer, integer, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.admin_partners_access_requests(
  integer, integer, text, text
) to authenticated;

revoke all on function public.admin_partners_access_request_decide(
  uuid, text, timestamptz, text
) from public, anon, authenticated, service_role;
grant execute on function public.admin_partners_access_request_decide(
  uuid, text, timestamptz, text
) to authenticated;
