\set ON_ERROR_STOP on
begin;

delete from public.legal_billing_archive_access_grants
where user_id='d0000000-0000-0000-0000-000000000098';
delete from auth.mfa_factors where id='d0000000-0000-0000-0000-000000000099';
delete from auth.users where id='d0000000-0000-0000-0000-000000000098';
delete from public.legal_billing_archive
where source_ledger_id='legal-access-smoke-ledger';

insert into auth.users(
  id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) values (
  'd0000000-0000-0000-0000-000000000098',
  '00000000-0000-0000-0000-000000000000','authenticated','authenticated',
  'legal-archive-reader@invalid.test','not-used',clock_timestamp(),
  '{"provider":"email","providers":["email"],"role":"admin"}'::jsonb,
  '{}'::jsonb,clock_timestamp(),clock_timestamp()
);
insert into auth.mfa_factors(
  id,user_id,friendly_name,factor_type,status,created_at,updated_at,secret
) values (
  'd0000000-0000-0000-0000-000000000099',
  'd0000000-0000-0000-0000-000000000098','Legal archive access smoke',
  'totp','verified',clock_timestamp(),clock_timestamp(),'fixture-secret-not-production'
);
insert into public.legal_billing_archive(
  source_ledger_id,provider,provider_payment_id,order_id,kind,status,
  amount_minor,currency,country_code,plan_code,issued_at,legal_basis,
  retention_until,retention_policy_revision,retention_policy_reference,
  retention_policy_config_hash,retention_calculation_version,retention_basis_date
) values (
  'legal-access-smoke-ledger','fixture-provider','fixture-payment-001',
  'fixture-order-001','invoice','paid',1299,'EUR','FR','plus',
  '2026-08-25 10:00:00+00','fixture-accounting-obligation',
  '2037-01-01 00:00:00+00',1,
  'fixture://reviewed-policy/accounting-records-v2',repeat('a',64),2,'2026-12-31'
);

do $access_contract$
declare
  v_grant jsonb;
  v_read jsonb;
  v_stale boolean := false;
  v_aal1_denied boolean := false;
  v_disabled_denied boolean := false;
  v_append_only boolean := false;
begin
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  v_grant := public.norva_set_legal_billing_archive_access_grant(
    'd0000000-0000-0000-0000-000000000098',0,true,
    'LEGAL-READER-APPROVAL-2026-001','legal-access-smoke'
  );
  begin
    perform public.norva_set_legal_billing_archive_access_grant(
      'd0000000-0000-0000-0000-000000000098',0,true,
      'LEGAL-READER-APPROVAL-2026-001','legal-access-smoke'
    );
  exception when sqlstate 'PT409' then v_stale := true;
  end;

  perform set_config(
    'request.jwt.claims',
    '{"sub":"d0000000-0000-0000-0000-000000000098","role":"authenticated","aal":"aal1","app_metadata":{"role":"admin"}}',
    true
  );
  perform set_config('request.jwt.claim.sub','d0000000-0000-0000-0000-000000000098',true);
  begin
    perform public.norva_read_legal_billing_archive(
      'provider_payment_id','fixture-payment-001','LEGAL-CASE-2026-0001','accounting_reconciliation'
    );
  exception when sqlstate '42501' then v_aal1_denied := true;
  end;

  perform set_config(
    'request.jwt.claims',
    '{"sub":"d0000000-0000-0000-0000-000000000098","role":"authenticated","aal":"aal2","app_metadata":{"role":"admin"}}',
    true
  );
  perform set_config('request.jwt.claim.sub','d0000000-0000-0000-0000-000000000098',true);
  v_read := public.norva_read_legal_billing_archive(
    'provider_payment_id','fixture-payment-001','LEGAL-CASE-2026-0001','accounting_reconciliation'
  );
  begin
    update public.legal_billing_archive_access_events
    set reason='statutory_audit';
  exception when sqlstate '55000' then v_append_only := true;
  end;

  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  perform public.norva_set_legal_billing_archive_access_grant(
    'd0000000-0000-0000-0000-000000000098',1,false,
    'LEGAL-READER-REVOCATION-2026-001','legal-access-smoke'
  );
  perform set_config(
    'request.jwt.claims',
    '{"sub":"d0000000-0000-0000-0000-000000000098","role":"authenticated","aal":"aal2","app_metadata":{"role":"admin"}}',
    true
  );
  perform set_config('request.jwt.claim.sub','d0000000-0000-0000-0000-000000000098',true);
  begin
    perform public.norva_read_legal_billing_archive(
      'provider_payment_id','fixture-payment-001','LEGAL-CASE-2026-0002','accounting_reconciliation'
    );
  exception when sqlstate '42501' then v_disabled_denied := true;
  end;

  if (v_grant->>'revision')::bigint<>1 or not coalesce((v_grant->>'enabled')::boolean,false)
     or not v_stale or not v_aal1_denied or not v_disabled_denied or not v_append_only
     or (v_read->>'returnedRows')::integer<>1
     or coalesce((v_read->>'truncated')::boolean,true)
     or v_read->'records'->0->>'sourceLedgerId'<>'legal-access-smoke-ledger'
     or (select count(*) from public.legal_billing_archive_access_events)<>1
     or exists (
       select 1 from public.legal_billing_archive_access_events
       where lookup_digest !~ '^[0-9a-f]{64}$'
          or operator_key !~ '^op_[0-9a-f]{64}$'
          or returned_rows<>1
          or case_reference<>'LEGAL-CASE-2026-0001'
     )
     or (select count(*) from public.legal_billing_archive_access_grant_events)<>2
     or has_table_privilege('authenticated','public.legal_billing_archive','select')
     or has_table_privilege('service_role','public.legal_billing_archive','select')
     or has_table_privilege('authenticated','public.legal_billing_archive_access_events','select')
     or has_table_privilege('service_role','public.legal_billing_archive_access_events','select')
     or not has_function_privilege(
       'authenticated','public.norva_read_legal_billing_archive(text,text,text,text)','execute'
     )
     or has_function_privilege(
       'service_role','public.norva_read_legal_billing_archive(text,text,text,text)','execute'
     ) then
    raise exception 'legal billing archive audited access contract failed'
      using detail=format('grant=%s read=%s stale=%s aal1=%s disabled=%s append=%s',
        v_grant,v_read,v_stale,v_aal1_denied,v_disabled_denied,v_append_only);
  end if;
end
$access_contract$;

rollback;
