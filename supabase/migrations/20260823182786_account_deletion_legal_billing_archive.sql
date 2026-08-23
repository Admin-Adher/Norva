-- Legal retention is deliberately separated from the product ledger.  This
-- migration does not invent a retention period: an authorised operator must
-- provision the policy row before any account reaches ARCHIVING_LEGAL.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

create table if not exists public.legal_billing_archive_retention_policy (
  record_kind text primary key check (record_kind = 'billing_ledger'),
  legal_basis text not null check (btrim(legal_basis) <> ''),
  retention_interval interval not null check (retention_interval > interval '0'),
  configured_at timestamptz not null default clock_timestamp(),
  configured_by text not null check (btrim(configured_by) <> '')
);

create table if not exists public.legal_billing_archive (
  legal_record_id uuid primary key default gen_random_uuid(),
  source_ledger_id text not null unique,
  provider text not null,
  provider_payment_id text,
  order_id text,
  kind text not null,
  status text not null,
  amount_minor integer not null,
  currency text not null,
  country_code text,
  plan_code text,
  billing_period_end timestamptz,
  issued_at timestamptz not null,
  legal_basis text not null check (btrim(legal_basis) <> ''),
  retention_until timestamptz not null,
  archived_at timestamptz not null default clock_timestamp(),
  check (retention_until > issued_at)
);

alter table public.legal_billing_archive_retention_policy enable row level security;
alter table public.legal_billing_archive enable row level security;
revoke all on table public.legal_billing_archive_retention_policy,
  public.legal_billing_archive from public, anon, authenticated, service_role;

create or replace function public.norva_archive_account_deletion_legal_billing(
  p_user_id uuid,
  p_expected_revision bigint,
  p_limit integer default 500
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_workflow public.cloud_account_deletion_workflows%rowtype;
  v_policy public.legal_billing_archive_retention_policy%rowtype;
  v_archived integer := 0;
begin
  perform public.norva_credential_require_service_role();
  if p_limit is null or p_limit not between 1 and 5000 then
    raise exception 'account deletion legal archive batch limit is invalid' using errcode = '22023';
  end if;
  select * into v_workflow from public.cloud_account_deletion_workflows
  where user_id = p_user_id for update;
  if not found or v_workflow.state <> 'archiving_legal'
     or v_workflow.revision <> p_expected_revision then
    raise exception 'account deletion legal archive batch is stale' using errcode = '40001';
  end if;
  if not exists (select 1 from public.cloud_billing_ledger where user_id=p_user_id) then
    update public.cloud_account_deletion_workflows
    set state='purging_product',revision=revision + 1,updated_at=clock_timestamp()
    where user_id=p_user_id returning * into v_workflow;
    return jsonb_build_object('contract','account-deletion-legal-archive-v1',
      'state',v_workflow.state,'revision',v_workflow.revision,
      'archivedRows',0,'complete',true);
  end if;
  select * into v_policy from public.legal_billing_archive_retention_policy
  where record_kind = 'billing_ledger';
  if not found then
    raise exception 'account deletion legal retention policy is not configured'
      using errcode = '55000', detail = 'record_kind=billing_ledger';
  end if;

  with selected as materialized (
    select ledger.* from public.cloud_billing_ledger ledger
    where ledger.user_id = p_user_id
    order by ledger.created_at,ledger.pi_id
    for update skip locked limit p_limit
  ), archived as (
    insert into public.legal_billing_archive(
      source_ledger_id,provider,provider_payment_id,order_id,kind,status,
      amount_minor,currency,country_code,plan_code,billing_period_end,issued_at,
      legal_basis,retention_until
    )
    select ledger.pi_id,ledger.provider,ledger.provider_payment_id,ledger.order_id,
      ledger.kind,ledger.status,ledger.amount,ledger.currency,ledger.country_code,
      ledger.plan_code,ledger.billing_period_end,ledger.created_at,
      v_policy.legal_basis,ledger.created_at + v_policy.retention_interval
    from selected ledger
    on conflict (source_ledger_id) do nothing
    returning source_ledger_id
  ), unlinked as (
    update public.cloud_billing_ledger ledger
    set user_id = null,updated_at = clock_timestamp()
    from selected where ledger.pi_id = selected.pi_id
      and exists (select 1 from public.legal_billing_archive archive
                  where archive.source_ledger_id = selected.pi_id)
    returning ledger.pi_id
  )
  select count(*)::integer into v_archived from unlinked;
  update public.cloud_account_deletion_workflows
  set revision = revision + 1,updated_at = clock_timestamp()
  where user_id = p_user_id returning * into v_workflow;
  return jsonb_build_object('contract','account-deletion-legal-archive-v1',
    'state',v_workflow.state,'revision',v_workflow.revision,
    'archivedRows',v_archived,'complete',v_archived < p_limit);
end
$function$;

revoke all on function public.norva_archive_account_deletion_legal_billing(uuid,bigint,integer)
from public, anon, authenticated;
grant execute on function public.norva_archive_account_deletion_legal_billing(uuid,bigint,integer)
to service_role;

commit;
