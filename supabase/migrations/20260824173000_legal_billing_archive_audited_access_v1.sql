-- Legal archive access is deliberately narrower than ordinary Admin access.
-- A current admin must also have an explicit, revisioned legal-reader grant,
-- an AAL2 JWT and a currently verified TOTP factor. Every exact lookup is
-- audited atomically without retaining the raw lookup value in observability.
begin;
set local lock_timeout='2s';
set local statement_timeout='30s';

create table public.legal_billing_archive_access_grants (
  user_id uuid primary key references auth.users(id) on delete cascade,
  access_role text not null default 'legal_billing_archive_reader'
    check (access_role='legal_billing_archive_reader'),
  enabled boolean not null,
  revision bigint not null check (revision>0),
  approval_reference text not null
    check (approval_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{11,119}$'),
  configured_at timestamptz not null default clock_timestamp(),
  configured_by text not null check (length(btrim(configured_by)) between 3 and 200)
);

create table public.legal_billing_archive_access_grant_events (
  event_id bigint generated always as identity primary key,
  operator_key text not null check (operator_key ~ '^op_[0-9a-f]{64}$'),
  previous_revision bigint not null check (previous_revision>=0),
  revision bigint not null check (revision=previous_revision+1),
  enabled boolean not null,
  access_role text not null check (access_role='legal_billing_archive_reader'),
  approval_reference text not null
    check (approval_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{11,119}$'),
  configured_by text not null check (length(btrim(configured_by)) between 3 and 200),
  created_at timestamptz not null default clock_timestamp(),
  unique (operator_key,revision)
);

create table public.legal_billing_archive_access_events (
  event_id uuid primary key default gen_random_uuid(),
  operator_key text not null check (operator_key ~ '^op_[0-9a-f]{64}$'),
  access_role text not null check (access_role='legal_billing_archive_reader'),
  case_reference text not null
    check (case_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{11,119}$'),
  reason text not null check (reason in (
    'statutory_audit','accounting_reconciliation','legal_defense','tax_authority_request'
  )),
  lookup_kind text not null check (lookup_kind in (
    'source_ledger_id','provider_payment_id','order_id'
  )),
  lookup_digest text not null check (lookup_digest ~ '^[0-9a-f]{64}$'),
  returned_rows smallint not null check (returned_rows between 0 and 20),
  truncated boolean not null,
  max_retention_until timestamptz,
  created_at timestamptz not null default clock_timestamp()
);

alter table public.legal_billing_archive_access_grants enable row level security;
alter table public.legal_billing_archive_access_grant_events enable row level security;
alter table public.legal_billing_archive_access_events enable row level security;
revoke all on table public.legal_billing_archive_access_grants,
  public.legal_billing_archive_access_grant_events,
  public.legal_billing_archive_access_events
from public, anon, authenticated, service_role;

create index legal_billing_archive_provider_payment_id_idx
on public.legal_billing_archive(provider_payment_id)
where provider_payment_id is not null;
create index legal_billing_archive_order_id_idx
on public.legal_billing_archive(order_id)
where order_id is not null;
create index legal_billing_archive_access_events_created_idx
on public.legal_billing_archive_access_events(created_at desc);

create or replace function public.norva_legal_billing_archive_operator_key(p_user_id uuid)
returns text
language sql
immutable
strict
set search_path=''
as $function$
  select 'op_' || encode(
    extensions.digest(
      'norva-legal-billing-archive-operator:v1:' || p_user_id::text,
      'sha256'
    ),
    'hex'
  )
$function$;

create or replace function public.norva_reject_legal_billing_access_audit_mutation()
returns trigger
language plpgsql
volatile
security definer
set search_path=''
as $function$
begin
  raise exception 'legal billing archive access audit is append-only' using errcode='55000';
end
$function$;

revoke all on function public.norva_reject_legal_billing_access_audit_mutation()
from public, anon, authenticated, service_role;

create trigger trg_legal_billing_archive_access_grant_events_append_only
before update or delete on public.legal_billing_archive_access_grant_events
for each row execute function public.norva_reject_legal_billing_access_audit_mutation();
create trigger trg_legal_billing_archive_access_events_append_only
before update or delete on public.legal_billing_archive_access_events
for each row execute function public.norva_reject_legal_billing_access_audit_mutation();

create or replace function public.norva_set_legal_billing_archive_access_grant(
  p_user_id uuid,
  p_expected_revision bigint,
  p_enabled boolean,
  p_approval_reference text,
  p_configured_by text
) returns jsonb
language plpgsql
volatile
security definer
set search_path=''
as $function$
declare
  v_grant public.legal_billing_archive_access_grants%rowtype;
  v_revision bigint;
  v_exists boolean;
  v_operator_key text;
begin
  perform public.norva_credential_require_service_role();
  if p_user_id is null or p_expected_revision is null or p_expected_revision<0
     or p_enabled is null
     or coalesce(p_approval_reference,'') !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{11,119}$'
     or length(btrim(coalesce(p_configured_by,''))) not between 3 and 200 then
    raise exception 'invalid legal archive access grant' using errcode='22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('legal-billing-archive-grant:v1:'||p_user_id::text,0)
  );
  select * into v_grant
  from public.legal_billing_archive_access_grants
  where user_id=p_user_id
  for update;
  v_exists := found;
  if (not v_exists and p_expected_revision<>0)
     or (v_exists and v_grant.revision<>p_expected_revision) then
    raise exception 'stale legal archive access grant revision'
      using errcode='40001',detail='reason=stale';
  end if;
  if p_enabled and not exists (
    select 1 from auth.users account
    where account.id=p_user_id
      and account.raw_app_meta_data->>'role'='admin'
      and coalesce(account.banned_until,'-infinity'::timestamptz)<=clock_timestamp()
  ) then
    raise exception 'legal archive reader must be a current admin'
      using errcode='55000',detail='reason=admin_required';
  end if;

  v_revision := p_expected_revision+1;
  v_operator_key := public.norva_legal_billing_archive_operator_key(p_user_id);
  insert into public.legal_billing_archive_access_grants(
    user_id,access_role,enabled,revision,approval_reference,configured_at,configured_by
  ) values (
    p_user_id,'legal_billing_archive_reader',p_enabled,v_revision,
    p_approval_reference,clock_timestamp(),btrim(p_configured_by)
  )
  on conflict (user_id) do update
  set enabled=excluded.enabled,
      revision=excluded.revision,
      approval_reference=excluded.approval_reference,
      configured_at=excluded.configured_at,
      configured_by=excluded.configured_by;

  insert into public.legal_billing_archive_access_grant_events(
    operator_key,previous_revision,revision,enabled,access_role,
    approval_reference,configured_by
  ) values (
    v_operator_key,p_expected_revision,v_revision,p_enabled,
    'legal_billing_archive_reader',p_approval_reference,btrim(p_configured_by)
  );

  return jsonb_build_object(
    'contract','legal-billing-archive-access-grant-v1',
    'operatorKey',v_operator_key,
    'revision',v_revision,
    'enabled',p_enabled
  );
end
$function$;

create or replace function public.norva_read_legal_billing_archive(
  p_lookup_kind text,
  p_lookup_value text,
  p_case_reference text,
  p_reason text
) returns jsonb
language plpgsql
volatile
security definer
set search_path=''
as $function$
declare
  v_actor uuid := auth.uid();
  v_operator_key text;
  v_records jsonb := '[]'::jsonb;
  v_returned integer := 0;
  v_truncated boolean := false;
  v_max_retention timestamptz;
begin
  if v_actor is null or not public.is_admin() then
    raise exception 'legal archive admin required' using errcode='42501';
  end if;
  if coalesce(auth.jwt()->>'aal','')<>'aal2'
     or not exists (
       select 1 from auth.mfa_factors factor
       where factor.user_id=v_actor
         and factor.factor_type='totp'
         and factor.status='verified'
     ) then
    raise exception 'legal archive access requires AAL2 with verified TOTP'
      using errcode='42501';
  end if;
  if not exists (
    select 1 from public.legal_billing_archive_access_grants access_grant
    where access_grant.user_id=v_actor
      and access_grant.access_role='legal_billing_archive_reader'
      and access_grant.enabled
  ) then
    raise exception 'legal archive reader grant required' using errcode='42501';
  end if;
  if p_lookup_kind not in ('source_ledger_id','provider_payment_id','order_id')
     or length(coalesce(p_lookup_value,'')) not between 1 and 300
     or coalesce(p_case_reference,'') !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{11,119}$'
     or p_reason not in (
       'statutory_audit','accounting_reconciliation','legal_defense','tax_authority_request'
     ) then
    raise exception 'invalid legal archive access request' using errcode='22023';
  end if;

  with selected as materialized (
    select archive.*
    from public.legal_billing_archive archive
    where case p_lookup_kind
      when 'source_ledger_id' then archive.source_ledger_id=p_lookup_value
      when 'provider_payment_id' then archive.provider_payment_id=p_lookup_value
      when 'order_id' then archive.order_id=p_lookup_value
      else false
    end
    order by archive.issued_at,archive.legal_record_id
    limit 21
  ), numbered as (
    select selected.*,row_number() over (order by issued_at,legal_record_id) ordinal
    from selected
  ), projected as (
    select ordinal,jsonb_build_object(
      'legalRecordId',legal_record_id,
      'sourceLedgerId',source_ledger_id,
      'provider',provider,
      'providerPaymentId',provider_payment_id,
      'orderId',order_id,
      'kind',kind,
      'status',status,
      'amountMinor',amount_minor,
      'currency',currency,
      'countryCode',country_code,
      'planCode',plan_code,
      'billingPeriodEnd',billing_period_end,
      'issuedAt',issued_at,
      'legalBasis',legal_basis,
      'retentionUntil',retention_until,
      'policyRevision',retention_policy_revision,
      'policyReference',retention_policy_reference,
      'retentionBasisDate',retention_basis_date,
      'archivedAt',archived_at
    ) record
    from numbered
  )
  select coalesce(jsonb_agg(record order by ordinal) filter (where ordinal<=20),'[]'::jsonb),
    count(*) filter (where ordinal<=20)::integer,
    bool_or(ordinal=21),
    max((record->>'retentionUntil')::timestamptz) filter (where ordinal<=20)
  into v_records,v_returned,v_truncated,v_max_retention
  from projected;

  v_truncated := coalesce(v_truncated,false);
  v_operator_key := public.norva_legal_billing_archive_operator_key(v_actor);
  insert into public.legal_billing_archive_access_events(
    operator_key,access_role,case_reference,reason,lookup_kind,lookup_digest,
    returned_rows,truncated,max_retention_until
  ) values (
    v_operator_key,'legal_billing_archive_reader',p_case_reference,p_reason,p_lookup_kind,
    encode(extensions.digest(
      'norva-legal-billing-archive-lookup:v1:'||p_lookup_kind||':'||p_lookup_value,
      'sha256'
    ),'hex'),
    v_returned,v_truncated,v_max_retention
  );

  return jsonb_build_object(
    'contract','legal-billing-archive-read-v1',
    'caseReference',p_case_reference,
    'records',v_records,
    'returnedRows',v_returned,
    'truncated',v_truncated
  );
end
$function$;

revoke all on function public.norva_legal_billing_archive_operator_key(uuid)
from public, anon, authenticated, service_role;
revoke all on function public.norva_set_legal_billing_archive_access_grant(uuid,bigint,boolean,text,text)
from public, anon, authenticated;
grant execute on function public.norva_set_legal_billing_archive_access_grant(uuid,bigint,boolean,text,text)
to service_role;
revoke all on function public.norva_read_legal_billing_archive(text,text,text,text)
from public, anon, authenticated, service_role;
grant execute on function public.norva_read_legal_billing_archive(text,text,text,text)
to authenticated;

comment on function public.norva_read_legal_billing_archive(text,text,text,text) is
  'Exact, bounded legal-archive lookup for explicitly granted Admin+AAL2+verified-TOTP readers. Every result, including zero rows, is atomically audited without raw lookup values.';
comment on table public.legal_billing_archive_access_events is
  'Append-only access evidence. Stores an operator pseudonym and lookup digest, never the raw lookup value or returned billing record.';

commit;
