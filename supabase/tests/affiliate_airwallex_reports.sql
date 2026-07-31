begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(26);

select extensions.ok(
  to_regclass(
    'affiliate_private.affiliate_airwallex_report_contracts'
  ) is not null,
  'the private Airwallex report contract registry exists'
);
select extensions.ok(
  to_regclass(
    'affiliate_private.affiliate_airwallex_report_runs'
  ) is not null,
  'the private Airwallex async report run table exists'
);
select extensions.ok(
  not has_table_privilege(
    'anon',
    'affiliate_private.affiliate_airwallex_report_contracts',
    'SELECT'
  ),
  'anon cannot inspect report contract evidence'
);
select extensions.ok(
  not has_table_privilege(
    'authenticated',
    'affiliate_private.affiliate_airwallex_report_runs',
    'SELECT'
  ),
  'authenticated clients cannot inspect provider report state'
);
select extensions.ok(
  not has_table_privilege(
    'service_role',
    'affiliate_private.affiliate_airwallex_report_runs',
    'SELECT'
  ),
  'service role must use the bounded report RPCs'
);
select extensions.ok(
  not has_function_privilege(
    'anon',
    'public.partners_worker_airwallex_report_lease(text,text,text,integer,integer)',
    'EXECUTE'
  ),
  'anon cannot lease reports'
);
select extensions.ok(
  not has_function_privilege(
    'authenticated',
    'public.partners_worker_airwallex_report_apply(text,text,text,text,integer,integer,integer,jsonb)',
    'EXECUTE'
  ),
  'authenticated clients cannot atomically apply reports'
);
select extensions.ok(
  has_function_privilege(
    'service_role',
    'public.partners_worker_airwallex_report_lease(text,text,text,integer,integer)',
    'EXECUTE'
  ),
  'service role can lease bounded reports'
);
select extensions.ok(
  has_function_privilege(
    'service_role',
    'public.partners_worker_airwallex_report_candidates(text,text,text)',
    'EXECUTE'
  ),
  'service role can read only bounded payout candidates'
);
select extensions.ok(
  has_function_privilege(
    'authenticated',
    'public.admin_partners_airwallex_report_contract_set(text,boolean,text,text,text)',
    'EXECUTE'
  ),
  'authenticated Finance actors can enter the guarded approval RPC'
);
select extensions.ok(
  not has_function_privilege(
    'anon',
    'public.admin_partners_airwallex_report_contract_set(text,boolean,text,text,text)',
    'EXECUTE'
  ),
  'anon cannot enter report contract approval'
);
select extensions.is(
  (
    select count(*)::integer
    from affiliate_private.affiliate_airwallex_report_contracts
  ),
  2,
  'sandbox and production contracts are both installed'
);
select extensions.is(
  (
    select count(*)::integer
    from affiliate_private.affiliate_airwallex_report_contracts
    where status = 'draft'
  ),
  2,
  'both report contracts start fail-closed in draft'
);
select extensions.is(
  (
    select count(*)::integer
    from affiliate_private.affiliate_airwallex_report_contracts
    where api_version = '2024-04-30'
      and report_version = '1.1.0'
      and contract_version =
        'transaction_recon_csv_1_1_0_preamble_v1'
  ),
  2,
  'both environments pin the reviewed API, report and parser versions'
);
select extensions.is(
  (
    select enabled::text
    from public.admin_feature_flags
    where key = 'partners_payouts_live'
  ),
  'false',
  'the Financial Reports migration never enables live payouts'
);
select extensions.throws_ok(
  $$
    select public.partners_worker_airwallex_report_lease(
      'sandbox',
      'report-worker-test',
      repeat('1', 64),
      35,
      180
    )
  $$,
  'P0001',
  'Airwallex report contract is not Finance-approved',
  'a draft parser contract blocks the worker before provider access'
);
select extensions.throws_ok(
  $$
    insert into affiliate_private.affiliate_airwallex_report_contracts (
      environment,
      contract_version,
      api_version,
      report_version
    )
    values (
      'invalid',
      'transaction_recon_csv_1_1_0_preamble_v1',
      '2024-04-30',
      '1.1.0'
    )
  $$,
  '23514',
  null,
  'an unknown provider environment is rejected'
);
select extensions.lives_ok(
  $$
    select affiliate_private.partners_worker_heartbeat(
      'payout_report',
      'blocked',
      '{"state":"not_configured","error_code":"contract_draft"}'::jsonb
    )
  $$,
  'the distinct report worker heartbeat is accepted'
);
select extensions.throws_ok(
  $$
    select affiliate_private.partners_worker_heartbeat(
      'payout_report',
      'degraded',
      '{"provider_report_id":"must-not-leak"}'::jsonb
    )
  $$,
  '22023',
  'invalid worker heartbeat',
  'provider report identifiers cannot leak into heartbeat details'
);
select extensions.ok(
  not exists (
    select 1
    from information_schema.columns column_info
    where column_info.table_schema = 'affiliate_private'
      and column_info.table_name =
        'affiliate_airwallex_report_runs'
      and column_info.column_name in (
        'payload',
        'raw_csv',
        'beneficiary_name',
        'bank_account_number'
      )
  ),
  'report state persists no CSV payload or beneficiary PII'
);
select extensions.ok(
  exists (
    select 1
    from pg_catalog.pg_constraint constraint_info
    where constraint_info.conname =
        'affiliate_airwallex_report_runs_result'
      and pg_catalog.pg_get_constraintdef(
        constraint_info.oid
      ) ~ 'matched_count = candidate_count'
      and pg_catalog.pg_get_constraintdef(
        constraint_info.oid
      ) ~ 'unmatched_count = 0'
  ),
  'a completed report requires every current candidate to match'
);
select extensions.ok(
  pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_airwallex_report_status()'::regprocedure
  ) like '%airwallex_report_candidates_unmatched%',
  'Finance receives a distinct unmatched-candidate alert'
);
select extensions.ok(
  not has_function_privilege(
    'service_role',
    'public.partners_service_airwallex_settlement_observe(text,text,text,text,bigint,text,date,timestamp with time zone,text)',
    'EXECUTE'
  ),
  'service role cannot bypass the atomic report pipeline through the public observation RPC'
);
select extensions.ok(
  not has_function_privilege(
    'service_role',
    'affiliate_private.partners_service_airwallex_settlement_observe(text,text,text,text,bigint,text,date,timestamp with time zone,text)',
    'EXECUTE'
  ),
  'service role cannot bypass the atomic report pipeline through the private observation RPC'
);
select extensions.ok(
  not (
    affiliate_private.partners_ops_alert_snapshot() -> 'workers'
      @> '[{"worker":"payout_report"}]'::jsonb
  ),
  'Revolut manual mode removes the inactive Airwallex report heartbeat'
);
select extensions.ok(
  not exists (
    select 1
    from jsonb_array_elements(
      affiliate_private.partners_ops_alert_snapshot() -> 'alerts'
    ) alert
    where alert ->> 'code' in (
      'airwallex_report_exception',
      'airwallex_report_stale',
      'airwallex_report_candidates_unmatched'
    )
  )
  and affiliate_private.partners_ops_alert_snapshot() ->> 'payout_mode'
    = 'revolut_manual',
  'Revolut manual mode removes inactive Airwallex report alerts'
);

select * from extensions.finish();
rollback;
