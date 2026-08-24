\set ON_ERROR_STOP on
begin;
set local "request.jwt.claim.role" = 'service_role';

delete from public.legal_billing_archive
where source_ledger_id in ('account-delete-retention-expired','account-delete-retention-live');

insert into public.legal_billing_archive(
  source_ledger_id,provider,kind,status,amount_minor,currency,issued_at,
  legal_basis,retention_until
) values
  ('account-delete-retention-expired','test','invoice','paid',100,'EUR',
   clock_timestamp() - interval '11 years','test-retention-policy',clock_timestamp() - interval '1 second'),
  ('account-delete-retention-live','test','invoice','paid',100,'EUR',
   clock_timestamp(),'test-retention-policy',clock_timestamp() + interval '1 day');

do $retention_reaper$
declare v_first jsonb; v_second jsonb;
begin
  v_first := public.norva_purge_expired_legal_billing_archive(1);
  v_second := public.norva_purge_expired_legal_billing_archive(1);
  if (v_first->>'deletedRows')::integer <> 1 or coalesce((v_first->>'complete')::boolean,false)
     or (v_second->>'deletedRows')::integer <> 0 or not coalesce((v_second->>'complete')::boolean,false)
     or exists (select 1 from public.legal_billing_archive
                where source_ledger_id='account-delete-retention-expired')
     or not exists (select 1 from public.legal_billing_archive
                    where source_ledger_id='account-delete-retention-live') then
    raise exception 'legal billing retention reaper contract failed';
  end if;
end
$retention_reaper$;

do $fiscal_boundaries$
begin
  if public.norva_legal_billing_fiscal_close('2026-12-31',12,31) <> '2026-12-31'
     or public.norva_legal_billing_fiscal_close('2027-01-01',12,31) <> '2027-12-31'
     or public.norva_legal_billing_fiscal_close('2026-06-30',6,30) <> '2026-06-30'
     or public.norva_legal_billing_fiscal_close('2026-07-01',6,30) <> '2027-06-30'
     or public.norva_legal_billing_retention_until(
          '2026-12-31 23:59:59+00',10,12,31
        ) <> '2037-01-01 00:00:00+00'::timestamptz
     or public.norva_legal_billing_retention_until(
          '2027-01-01 00:00:00+00',10,12,31
        ) <> '2038-01-01 00:00:00+00'::timestamptz then
    raise exception 'fiscal-close retention boundary contract failed';
  end if;
end
$fiscal_boundaries$;

-- A non-empty ledger cannot silently bypass the explicitly provisioned policy.
-- The policy below is a transaction-local fixture, not a product legal rule.
delete from public.legal_billing_archive_retention_policy where record_kind='billing_ledger';
delete from public.legal_billing_archive where source_ledger_id='account-delete-legal-ledger';
delete from public.cloud_billing_ledger where pi_id='account-delete-legal-ledger';
delete from public.cloud_account_deletion_workflows where user_id='d0000000-0000-0000-0000-000000000097';
delete from auth.users where id='d0000000-0000-0000-0000-000000000097';
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values ('d0000000-0000-0000-0000-000000000097',
  '00000000-0000-0000-0000-000000000000','authenticated','authenticated',
  'account-delete-legal-097@invalid.test','not-used',clock_timestamp(),
  '{}'::jsonb,'{}'::jsonb,clock_timestamp(),clock_timestamp());
insert into public.cloud_account_deletion_workflows(user_id,state,revision)
values ('d0000000-0000-0000-0000-000000000097','archiving_legal',0);
insert into public.cloud_billing_ledger(
  pi_id,user_id,kind,amount,currency,status,provider,user_pseudonym
) values ('account-delete-legal-ledger','d0000000-0000-0000-0000-000000000097',
  'renewal',100,'EUR','paid','web',repeat('f',64));

do $policy_and_archive$
declare
  v_missing boolean := false;
  v_stale boolean := false;
  v_append_only boolean := false;
  v_integrity_refusal boolean := false;
  v_policy jsonb;
  v_archive jsonb;
  v_complete jsonb;
begin
  begin
    perform public.norva_archive_account_deletion_legal_billing(
      'd0000000-0000-0000-0000-000000000097',0,1);
  exception when sqlstate '55000' then v_missing := true;
  end;
  if not v_missing then
    raise exception 'legal archive advanced without an explicit retention policy';
  end if;
  v_policy := public.norva_configure_legal_billing_archive_policy(
    0,
    'fixture-accounting-obligation',
    'fixture://reviewed-policy/accounting-records-v2',
    10,
    12,
    31,
    'account-deletion-retention-smoke'
  );
  begin
    perform public.norva_configure_legal_billing_archive_policy(
      0,'fixture-accounting-obligation',
      'fixture://reviewed-policy/accounting-records-v2',10,12,31,
      'account-deletion-retention-smoke'
    );
  exception when sqlstate '40001' then v_stale := true;
  end;
  begin
    update public.legal_billing_archive_policy_events
    set actor='forbidden-event-rewrite'
    where revision=1;
  exception when sqlstate '55000' then v_append_only := true;
  end;
  update public.legal_billing_archive_retention_policy
  set config_hash=repeat('0',64)
  where record_kind='billing_ledger';
  begin
    perform public.norva_archive_account_deletion_legal_billing(
      'd0000000-0000-0000-0000-000000000097',0,1);
  exception when sqlstate '55000' then v_integrity_refusal := true;
  end;
  update public.legal_billing_archive_retention_policy
  set config_hash=v_policy->>'configHash'
  where record_kind='billing_ledger';
  v_archive := public.norva_archive_account_deletion_legal_billing(
    'd0000000-0000-0000-0000-000000000097',0,1);
  v_complete := public.norva_archive_account_deletion_legal_billing(
    'd0000000-0000-0000-0000-000000000097',1,1);
  if (v_policy->>'revision')::bigint <> 1
     or not v_stale
     or not v_append_only
     or not v_integrity_refusal
     or has_function_privilege(
          'authenticated',
          'public.norva_configure_legal_billing_archive_policy(bigint,text,text,integer,integer,integer,text)',
          'execute'
        )
     or has_table_privilege('service_role','public.legal_billing_archive','select')
     or has_table_privilege('service_role','public.legal_billing_archive_policy_events','select')
     or (v_archive->>'archivedRows')::integer <> 1
     or (v_complete->>'state') <> 'purging_product'
     or exists (select 1 from public.cloud_billing_ledger
                where pi_id='account-delete-legal-ledger' and user_id is not null)
     or not exists (select 1 from public.legal_billing_archive
                    where source_ledger_id='account-delete-legal-ledger'
                      and legal_basis='fixture-accounting-obligation'
                      and retention_policy_revision=1
                      and retention_calculation_version=2
                      and retention_policy_reference=
                        'fixture://reviewed-policy/accounting-records-v2'
                      and retention_policy_config_hash ~ '^[0-9a-f]{64}$'
                      and retention_basis_date =
                        public.norva_legal_billing_fiscal_close(issued_at::date,12,31)
                      and retention_until =
                        public.norva_legal_billing_retention_until(issued_at,10,12,31))
     or (select count(*) from public.legal_billing_archive_policy_events
         where revision=1 and previous_revision=0) <> 1 then
    raise exception 'legal archive fixture did not remain minimal and idempotent'
      using detail=format('policy=%s archive=%s complete=%s',v_policy,v_archive,v_complete);
  end if;
end
$policy_and_archive$;

rollback;
