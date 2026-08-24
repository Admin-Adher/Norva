-- Legal-billing retention policy v2.
--
-- The v1 interval was measured from issued_at. French accounting retention is
-- expressed from the close of the accounting year, so v2 records the fiscal
-- close explicitly and derives an exclusive deletion boundary from it. No
-- product/legal policy is provisioned by this migration: legacy or absent
-- policy rows remain fail-closed until an authorised service operator performs
-- the CAS configuration with a reviewed legal reference.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

alter table public.legal_billing_archive_retention_policy
  add column if not exists revision bigint not null default 0,
  add column if not exists policy_reference text,
  add column if not exists retention_years smallint,
  add column if not exists fiscal_year_end_month smallint,
  add column if not exists fiscal_year_end_day smallint,
  add column if not exists calculation_version smallint,
  add column if not exists config_hash text;

alter table public.legal_billing_archive
  add column if not exists retention_policy_revision bigint,
  add column if not exists retention_policy_reference text,
  add column if not exists retention_policy_config_hash text,
  add column if not exists retention_calculation_version smallint,
  add column if not exists retention_basis_date date;

do $constraints$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid='public.legal_billing_archive_retention_policy'::regclass
      and conname='legal_billing_policy_v2_complete'
  ) then
    alter table public.legal_billing_archive_retention_policy
      add constraint legal_billing_policy_v2_complete check (
        (revision=0 and policy_reference is null and retention_years is null
          and fiscal_year_end_month is null and fiscal_year_end_day is null
          and calculation_version is null and config_hash is null)
        or
        (revision>0 and length(btrim(policy_reference)) between 12 and 1000
          and retention_years between 1 and 30
          and fiscal_year_end_month between 1 and 12
          and fiscal_year_end_day between 1 and 31
          and calculation_version=2
          and config_hash ~ '^[0-9a-f]{64}$')
      );
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid='public.legal_billing_archive'::regclass
      and conname='legal_billing_archive_v2_provenance_complete'
  ) then
    alter table public.legal_billing_archive
      add constraint legal_billing_archive_v2_provenance_complete check (
        (retention_policy_revision is null
          and retention_policy_reference is null
          and retention_policy_config_hash is null
          and retention_calculation_version is null
          and retention_basis_date is null)
        or
        (retention_policy_revision>0
          and length(btrim(retention_policy_reference)) between 12 and 1000
          and retention_policy_config_hash ~ '^[0-9a-f]{64}$'
          and retention_calculation_version=2
          and retention_basis_date >= issued_at::date)
      );
  end if;
end
$constraints$;

create table if not exists public.legal_billing_archive_policy_events (
  event_id bigint generated always as identity primary key,
  previous_revision bigint not null check (previous_revision >= 0),
  revision bigint not null check (revision = previous_revision + 1),
  legal_basis text not null check (length(btrim(legal_basis)) between 3 and 1000),
  policy_reference text not null check (length(btrim(policy_reference)) between 12 and 1000),
  retention_years smallint not null check (retention_years between 1 and 30),
  fiscal_year_end_month smallint not null check (fiscal_year_end_month between 1 and 12),
  fiscal_year_end_day smallint not null check (fiscal_year_end_day between 1 and 31),
  calculation_version smallint not null check (calculation_version=2),
  config_hash text not null check (config_hash ~ '^[0-9a-f]{64}$'),
  actor text not null check (length(btrim(actor)) between 3 and 200),
  created_at timestamptz not null default clock_timestamp(),
  unique (revision)
);

alter table public.legal_billing_archive_policy_events enable row level security;
revoke all on table public.legal_billing_archive_policy_events
from public, anon, authenticated, service_role;

create or replace function public.norva_reject_legal_billing_policy_event_mutation()
returns trigger
language plpgsql
volatile
security definer
set search_path=''
as $function$
begin
  raise exception 'legal billing policy events are append-only' using errcode='55000';
end
$function$;

revoke all on function public.norva_reject_legal_billing_policy_event_mutation()
from public, anon, authenticated, service_role;

drop trigger if exists trg_legal_billing_policy_events_append_only
on public.legal_billing_archive_policy_events;
create trigger trg_legal_billing_policy_events_append_only
before update or delete on public.legal_billing_archive_policy_events
for each row execute function public.norva_reject_legal_billing_policy_event_mutation();

create or replace function public.norva_legal_billing_policy_config_hash(
  p_legal_basis text,
  p_policy_reference text,
  p_retention_years integer,
  p_fiscal_year_end_month integer,
  p_fiscal_year_end_day integer
) returns text
language sql
immutable
strict
set search_path=''
as $function$
  select encode(
    extensions.digest(
      convert_to(
        jsonb_build_object(
          'calculationVersion',2,
          'fiscalYearEndDay',p_fiscal_year_end_day,
          'fiscalYearEndMonth',p_fiscal_year_end_month,
          'legalBasis',btrim(p_legal_basis),
          'policyReference',btrim(p_policy_reference),
          'retentionYears',p_retention_years
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  )
$function$;

create or replace function public.norva_legal_billing_fiscal_close(
  p_issued_on date,
  p_fiscal_year_end_month integer,
  p_fiscal_year_end_day integer
) returns date
language plpgsql
immutable
strict
set search_path=''
as $function$
declare
  v_close date;
begin
  if p_fiscal_year_end_month not between 1 and 12
     or p_fiscal_year_end_day not between 1 and 31 then
    raise exception 'invalid fiscal year close' using errcode='22023';
  end if;
  begin
    -- 2001 deliberately rejects February 29: the configured close must exist
    -- in every civil year.
    perform pg_catalog.make_date(2001,p_fiscal_year_end_month,p_fiscal_year_end_day);
    v_close := pg_catalog.make_date(
      extract(year from p_issued_on)::integer,
      p_fiscal_year_end_month,
      p_fiscal_year_end_day
    );
  exception when datetime_field_overflow then
    raise exception 'invalid fiscal year close' using errcode='22023';
  end;
  if p_issued_on > v_close then
    v_close := pg_catalog.make_date(
      extract(year from p_issued_on)::integer + 1,
      p_fiscal_year_end_month,
      p_fiscal_year_end_day
    );
  end if;
  return v_close;
end
$function$;

create or replace function public.norva_legal_billing_retention_until(
  p_issued_at timestamptz,
  p_retention_years integer,
  p_fiscal_year_end_month integer,
  p_fiscal_year_end_day integer
) returns timestamptz
language plpgsql
immutable
strict
set search_path=''
as $function$
declare
  v_close date;
begin
  if p_retention_years not between 1 and 30 then
    raise exception 'invalid legal retention years' using errcode='22023';
  end if;
  v_close := public.norva_legal_billing_fiscal_close(
    (p_issued_at at time zone 'UTC')::date,
    p_fiscal_year_end_month,
    p_fiscal_year_end_day
  );
  -- Exclusive deletion boundary: a record for a 31-Dec-2026 close and ten
  -- retention years first becomes purgeable at 00:00 UTC on 1-Jan-2037.
  return ((v_close + pg_catalog.make_interval(years=>p_retention_years)
    + interval '1 day')::timestamp at time zone 'UTC');
end
$function$;

create or replace function public.norva_configure_legal_billing_archive_policy(
  p_expected_revision bigint,
  p_legal_basis text,
  p_policy_reference text,
  p_retention_years integer,
  p_fiscal_year_end_month integer,
  p_fiscal_year_end_day integer,
  p_actor text
) returns jsonb
language plpgsql
volatile
security definer
set search_path=''
as $function$
declare
  v_policy public.legal_billing_archive_retention_policy%rowtype;
  v_exists boolean := false;
  v_hash text;
  v_revision bigint;
begin
  perform public.norva_credential_require_service_role();
  if p_expected_revision is null or p_expected_revision < 0
     or length(btrim(coalesce(p_legal_basis,''))) not between 3 and 1000
     or length(btrim(coalesce(p_policy_reference,''))) not between 12 and 1000
     or p_retention_years not between 1 and 30
     or p_fiscal_year_end_month not between 1 and 12
     or p_fiscal_year_end_day not between 1 and 31
     or length(btrim(coalesce(p_actor,''))) not between 3 and 200 then
    raise exception 'invalid legal billing retention policy' using errcode='22023';
  end if;
  perform pg_catalog.make_date(2001,p_fiscal_year_end_month,p_fiscal_year_end_day);

  -- The singleton may not exist yet, so SELECT ... FOR UPDATE alone cannot
  -- serialize two first-time configurations. This transaction-scoped lock
  -- closes that empty-row race; subsequent checks still use the durable
  -- revision as the authority and return a clean STALE loser.
  perform pg_catalog.pg_advisory_xact_lock(1770317200);

  select * into v_policy
  from public.legal_billing_archive_retention_policy
  where record_kind='billing_ledger'
  for update;
  v_exists := found;
  if (not v_exists and p_expected_revision <> 0)
     or (v_exists and v_policy.revision <> p_expected_revision) then
    raise exception 'stale legal billing retention policy revision'
      using errcode='40001', detail='reason=stale';
  end if;

  v_revision := p_expected_revision + 1;
  v_hash := public.norva_legal_billing_policy_config_hash(
    p_legal_basis,p_policy_reference,p_retention_years,
    p_fiscal_year_end_month,p_fiscal_year_end_day
  );

  insert into public.legal_billing_archive_retention_policy(
    record_kind,legal_basis,retention_interval,configured_at,configured_by,
    revision,policy_reference,retention_years,fiscal_year_end_month,
    fiscal_year_end_day,calculation_version,config_hash
  ) values (
    'billing_ledger',btrim(p_legal_basis),
    pg_catalog.make_interval(years=>p_retention_years),clock_timestamp(),btrim(p_actor),
    v_revision,btrim(p_policy_reference),p_retention_years,
    p_fiscal_year_end_month,p_fiscal_year_end_day,2,v_hash
  )
  on conflict (record_kind) do update
  set legal_basis=excluded.legal_basis,
      retention_interval=excluded.retention_interval,
      configured_at=excluded.configured_at,
      configured_by=excluded.configured_by,
      revision=excluded.revision,
      policy_reference=excluded.policy_reference,
      retention_years=excluded.retention_years,
      fiscal_year_end_month=excluded.fiscal_year_end_month,
      fiscal_year_end_day=excluded.fiscal_year_end_day,
      calculation_version=excluded.calculation_version,
      config_hash=excluded.config_hash;

  insert into public.legal_billing_archive_policy_events(
    previous_revision,revision,legal_basis,policy_reference,retention_years,
    fiscal_year_end_month,fiscal_year_end_day,calculation_version,config_hash,actor
  ) values (
    p_expected_revision,v_revision,btrim(p_legal_basis),btrim(p_policy_reference),
    p_retention_years,p_fiscal_year_end_month,p_fiscal_year_end_day,2,v_hash,btrim(p_actor)
  );

  return jsonb_build_object(
    'contract','legal-billing-retention-policy-v2',
    'revision',v_revision,
    'calculationVersion',2,
    'configHash',v_hash
  );
exception when datetime_field_overflow then
  raise exception 'invalid legal billing retention policy' using errcode='22023';
end
$function$;

create or replace function public.norva_archive_account_deletion_legal_billing(
  p_user_id uuid,
  p_expected_revision bigint,
  p_limit integer default 500
) returns jsonb
language plpgsql
volatile
security definer
set search_path=''
as $function$
declare
  v_workflow public.cloud_account_deletion_workflows%rowtype;
  v_policy public.legal_billing_archive_retention_policy%rowtype;
  v_archived integer := 0;
  v_expected_hash text;
begin
  perform public.norva_credential_require_service_role();
  if p_limit is null or p_limit not between 1 and 5000 then
    raise exception 'account deletion legal archive batch limit is invalid' using errcode='22023';
  end if;
  select * into v_workflow from public.cloud_account_deletion_workflows
  where user_id=p_user_id for update;
  if not found or v_workflow.state <> 'archiving_legal'
     or v_workflow.revision <> p_expected_revision then
    raise exception 'account deletion legal archive batch is stale' using errcode='40001';
  end if;
  if not exists (select 1 from public.cloud_billing_ledger where user_id=p_user_id) then
    update public.cloud_account_deletion_workflows
    set state='purging_product',revision=revision+1,updated_at=clock_timestamp()
    where user_id=p_user_id returning * into v_workflow;
    return jsonb_build_object('contract','account-deletion-legal-archive-v2',
      'state',v_workflow.state,'revision',v_workflow.revision,
      'archivedRows',0,'complete',true);
  end if;

  select * into v_policy
  from public.legal_billing_archive_retention_policy
  where record_kind='billing_ledger'
  for share;
  if not found or v_policy.revision <= 0 or v_policy.calculation_version <> 2
     or v_policy.policy_reference is null or v_policy.retention_years is null
     or v_policy.fiscal_year_end_month is null or v_policy.fiscal_year_end_day is null
     or v_policy.config_hash is null then
    raise exception 'account deletion legal retention policy v2 is not configured'
      using errcode='55000',detail='record_kind=billing_ledger';
  end if;
  v_expected_hash := public.norva_legal_billing_policy_config_hash(
    v_policy.legal_basis,v_policy.policy_reference,v_policy.retention_years,
    v_policy.fiscal_year_end_month,v_policy.fiscal_year_end_day
  );
  if v_expected_hash <> v_policy.config_hash then
    raise exception 'account deletion legal retention policy integrity check failed'
      using errcode='55000',detail='reason=config_hash_mismatch';
  end if;

  if exists (
    select 1
    from public.cloud_billing_ledger ledger
    join public.legal_billing_archive archive on archive.source_ledger_id=ledger.pi_id
    where ledger.user_id=p_user_id
      and (archive.retention_policy_revision is null
        or archive.retention_calculation_version <> 2
        or archive.retention_policy_config_hash is null
        or archive.retention_basis_date is null)
  ) then
    raise exception 'legacy legal archive provenance requires reviewed remediation'
      using errcode='55000',detail='reason=legacy_archive_provenance';
  end if;

  with selected as materialized (
    select ledger.* from public.cloud_billing_ledger ledger
    where ledger.user_id=p_user_id
    order by ledger.created_at,ledger.pi_id
    for update skip locked limit p_limit
  ), inserted as (
    insert into public.legal_billing_archive(
      source_ledger_id,provider,provider_payment_id,order_id,kind,status,
      amount_minor,currency,country_code,plan_code,billing_period_end,issued_at,
      legal_basis,retention_until,retention_policy_revision,
      retention_policy_reference,retention_policy_config_hash,
      retention_calculation_version,retention_basis_date
    )
    select ledger.pi_id,ledger.provider,ledger.provider_payment_id,ledger.order_id,
      ledger.kind,ledger.status,ledger.amount,ledger.currency,ledger.country_code,
      ledger.plan_code,ledger.billing_period_end,ledger.created_at,
      v_policy.legal_basis,
      public.norva_legal_billing_retention_until(
        ledger.created_at,v_policy.retention_years,
        v_policy.fiscal_year_end_month,v_policy.fiscal_year_end_day
      ),
      v_policy.revision,v_policy.policy_reference,v_policy.config_hash,2,
      public.norva_legal_billing_fiscal_close(
        (ledger.created_at at time zone 'UTC')::date,
        v_policy.fiscal_year_end_month,v_policy.fiscal_year_end_day
      )
    from selected ledger
    on conflict (source_ledger_id) do nothing
    returning source_ledger_id
  ), eligible as materialized (
    select source_ledger_id from inserted
    union
    select selected.pi_id from selected
    where exists (
      select 1 from public.legal_billing_archive archive
      where archive.source_ledger_id=selected.pi_id
        and archive.retention_policy_revision is not null
        and archive.retention_calculation_version=2
        and archive.retention_policy_config_hash is not null
        and archive.retention_basis_date is not null
    )
  ), unlinked as (
    update public.cloud_billing_ledger ledger
    set user_id=null,updated_at=clock_timestamp()
    from eligible
    where ledger.pi_id=eligible.source_ledger_id and ledger.user_id=p_user_id
    returning ledger.pi_id
  )
  select count(*)::integer into v_archived from unlinked;

  update public.cloud_account_deletion_workflows
  set revision=revision+1,updated_at=clock_timestamp()
  where user_id=p_user_id returning * into v_workflow;
  return jsonb_build_object('contract','account-deletion-legal-archive-v2',
    'state',v_workflow.state,'revision',v_workflow.revision,
    'policyRevision',v_policy.revision,'archivedRows',v_archived,
    'complete',v_archived < p_limit);
end
$function$;

revoke all on function public.norva_legal_billing_policy_config_hash(text,text,integer,integer,integer)
from public, anon, authenticated, service_role;
revoke all on function public.norva_legal_billing_fiscal_close(date,integer,integer)
from public, anon, authenticated, service_role;
revoke all on function public.norva_legal_billing_retention_until(timestamptz,integer,integer,integer)
from public, anon, authenticated, service_role;
revoke all on function public.norva_configure_legal_billing_archive_policy(bigint,text,text,integer,integer,integer,text)
from public, anon, authenticated;
grant execute on function public.norva_configure_legal_billing_archive_policy(bigint,text,text,integer,integer,integer,text)
to service_role;
revoke all on function public.norva_archive_account_deletion_legal_billing(uuid,bigint,integer)
from public, anon, authenticated;
grant execute on function public.norva_archive_account_deletion_legal_billing(uuid,bigint,integer)
to service_role;

comment on table public.legal_billing_archive_policy_events is
  'Append-only, PII-free evidence of each CAS legal-retention policy decision.';
comment on function public.norva_configure_legal_billing_archive_policy(bigint,text,text,integer,integer,integer,text) is
  'Service-only CAS configuration for legal billing retention. The fiscal close and reviewed legal reference are mandatory.';
comment on column public.legal_billing_archive_retention_policy.retention_interval is
  'Legacy compatibility column only. V2 retention is derived from fiscal close plus retention_years.';

commit;
