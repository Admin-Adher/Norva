-- Keep the three Partners state machines explicit:
--   * account activation,
--   * member cash KYC,
--   * isolated Didit pre-gate certification.
--
-- This status endpoint deliberately exposes only aggregate technical history.
-- It never returns provider identifiers, account identifiers, identity results
-- or a bridge capable of promoting a technical certification into member KYC.

create or replace function
affiliate_private.admin_partners_kyc_certification_status()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_operator_hash text;
  v_session
    affiliate_private.affiliate_didit_certification_sessions%rowtype;
  v_sessions_total integer := 0;
  v_sessions_with_events integer := 0;
  v_sessions_without_events integer := 0;
  v_verified_live_sessions integer := 0;
  v_quarantined_sessions integer := 0;
  v_last_event_observed_at timestamptz;
begin
  v_operator_hash :=
    affiliate_private.partners_require_didit_certification_observer(
      'Didit certification status'
    );

  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:didit:certification-operator:v1:' || v_operator_hash,
      0
    )
  );

  update affiliate_private.affiliate_didit_certification_sessions session
  set
    status = 'expired',
    updated_at = now()
  where session.operator_hash = v_operator_hash
    and session.status in ('reserved', 'pending', 'in_review')
    and session.expires_at <= now();

  select session.*
  into v_session
  from affiliate_private.affiliate_didit_certification_sessions session
  where session.operator_hash = v_operator_hash
  order by session.created_at desc, session.id desc
  limit 1;

  select
    count(*)::integer,
    count(event_history.last_event_observed_at)::integer,
    count(*) filter (
      where session.provider_session_hash is not null
        and event_history.last_event_observed_at is null
    )::integer,
    count(*) filter (
      where session.status = 'approved'
        and session.provider_environment = 'live'
        and session.verified
    )::integer,
    count(*) filter (
      where session.status = 'quarantined'
    )::integer,
    max(event_history.last_event_observed_at)
  into
    v_sessions_total,
    v_sessions_with_events,
    v_sessions_without_events,
    v_verified_live_sessions,
    v_quarantined_sessions,
    v_last_event_observed_at
  from affiliate_private.affiliate_didit_certification_sessions session
  left join lateral (
    select max(event_row.created_at) as last_event_observed_at
    from affiliate_private.affiliate_didit_certification_events event_row
    where event_row.certification_session_id = session.id
  ) event_history on true
  where session.operator_hash = v_operator_hash;

  return jsonb_build_object(
    'schema_version', 2,
    'action', 'kyc_certification_status',
    'certification', case
      when v_session.id is null then null
      else jsonb_build_object(
        'status', v_session.status,
        'environment', v_session.provider_environment,
        'expires_at', v_session.expires_at,
        'observed_at', v_session.updated_at,
        'verified', v_session.verified,
        'reason', case
          when v_session.status = 'quarantined' then
            affiliate_private.partners_didit_certification_public_reason(
              v_session.quarantine_reason
            )
          else null
        end
      )
    end,
    'technical_history', jsonb_build_object(
      'sessions_total', v_sessions_total,
      'sessions_with_events', v_sessions_with_events,
      'sessions_without_events', v_sessions_without_events,
      'verified_live_sessions', v_verified_live_sessions,
      'quarantined_sessions', v_quarantined_sessions,
      'last_event_observed_at', v_last_event_observed_at
    )
  );
end;
$$;

revoke all on function
  affiliate_private.admin_partners_kyc_certification_status()
  from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.admin_partners_kyc_certification_status()
  to authenticated;

revoke all on function public.admin_partners_kyc_certification_status()
  from public, anon, authenticated, service_role;
grant execute on function public.admin_partners_kyc_certification_status()
  to authenticated;

comment on function
  affiliate_private.admin_partners_kyc_certification_status() is
  'Returns the JWT-scoped latest technical Didit certification plus aggregate, identifier-free local delivery history. It cannot mutate or infer member cash KYC.';
comment on function public.admin_partners_kyc_certification_status() is
  'Returns schema v2 technical Didit certification truth for auth.uid(): bounded latest state and aggregate local-event coverage only. No provider/account identifier or member cash-KYC promotion is exposed.';

do $contract$
declare
  v_private oid :=
    'affiliate_private.admin_partners_kyc_certification_status()'::regprocedure;
  v_public oid :=
    'public.admin_partners_kyc_certification_status()'::regprocedure;
begin
  if not exists (
    select 1
    from pg_proc function_row
    where function_row.oid = v_private
      and function_row.prosecdef
      and function_row.provolatile = 'v'
      and function_row.proconfig @> array['search_path=""']::text[]
  ) then
    raise exception 'private Didit certification status contract is invalid';
  end if;

  if has_function_privilege(
      'anon',
      'public.admin_partners_kyc_certification_status()',
      'execute'
    )
    or has_function_privilege(
      'service_role',
      'public.admin_partners_kyc_certification_status()',
      'execute'
    )
    or not has_function_privilege(
      'authenticated',
      'public.admin_partners_kyc_certification_status()',
      'execute'
    )
  then
    raise exception 'public Didit certification status grants are invalid';
  end if;

  if exists (
    select 1
    from information_schema.columns column_row
    where column_row.table_schema = 'affiliate_private'
      and column_row.table_name in (
        'affiliate_didit_certification_sessions',
        'affiliate_didit_certification_events'
      )
      and column_row.column_name in (
        'account_id',
        'user_id',
        'provider_session_id',
        'provider_event_id',
        'payload',
        'date_of_birth',
        'document_country_iso3',
        'name',
        'document'
      )
  ) then
    raise exception 'technical Didit certification persistence contains forbidden identity columns';
  end if;

  if v_public is null then
    raise exception 'public Didit certification status wrapper is missing';
  end if;
end;
$contract$;
