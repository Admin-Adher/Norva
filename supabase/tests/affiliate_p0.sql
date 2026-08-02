begin;

create extension if not exists pgtap with schema extensions;

select extensions.plan(225);

select extensions.ok(
  exists (
    select 1
    from pg_constraint constraint_row
    where constraint_row.conrelid =
        'affiliate_private.affiliate_payout_provider_configs'::regclass
      and constraint_row.conname =
        'affiliate_payout_provider_configs_pilot_adapter'
      and constraint_row.contype = 'c'
      and constraint_row.convalidated
      and pg_get_constraintdef(constraint_row.oid)
        like
          '%status <> ''active''%provider = ''revolut''%'
          || 'execution_adapter%revolut_manual%revolut_api%'
  ),
  'the payout pilot has a validated Revolut manual/API active-adapter lock'
);
select extensions.ok(
  exists (
    select 1
    from pg_index index_row
    where index_row.indexrelid = to_regclass(
        'affiliate_private.'
        || 'affiliate_payout_provider_configs_active_route_idx'
      )
      and index_row.indisunique
      and pg_get_indexdef(index_row.indexrelid)
        like '%(country_code, currency)%'
      and pg_get_expr(index_row.indpred, index_row.indrelid)
        like '%status = ''active''%'
  ),
  'each country-currency corridor has at most one active payout configuration'
);

select extensions.ok(
  not exists (
    select 1
    from affiliate_private.affiliate_kyc_sessions session
    where session.status = 'pending'
      and session.provider_environment = 'legacy_unbound'
  ),
  'the binding migration terminalizes every unprovable legacy pending KYC session'
);

do $fixture_grant$
declare
  v_temp_schema name;
begin
  select namespace.nspname
  into strict v_temp_schema
  from pg_namespace namespace
  where namespace.oid = pg_my_temp_schema();
  execute format(
    'grant usage on schema %I to service_role',
    v_temp_schema
  );
end;
$fixture_grant$;

select extensions.ok(
  not has_function_privilege(
    'anon',
    'public.partners_service_apply(uuid,text,text,text,text)',
    'EXECUTE'
  ),
  'anon cannot execute the Partners application RPC'
);
select extensions.ok(
  not has_function_privilege(
    'authenticated',
    'public.partners_service_apply(uuid,text,text,text,text)',
    'EXECUTE'
  ),
  'authenticated clients cannot bypass the Partners Edge Function'
);
select extensions.ok(
  not has_function_privilege(
    'authenticated',
    'affiliate_private.partners_can_manage_capabilities()',
    'EXECUTE'
  ),
  'authenticated clients cannot execute the capability-manager predicate'
);
select extensions.ok(
  not has_function_privilege(
    'authenticated',
    'public.partners_service_prepare_account_deletion(uuid)',
    'EXECUTE'
  ),
  'authenticated clients cannot prepare retained Partners data for deletion'
);
select extensions.ok(
  not has_function_privilege(
    'anon',
    'public.partners_service_prepare_account_deletion(uuid)',
    'EXECUTE'
  ),
  'anonymous clients cannot prepare retained Partners data for deletion'
);
select extensions.ok(
  has_function_privilege(
    'service_role',
    'public.partners_service_prepare_account_deletion(uuid)',
    'EXECUTE'
  ),
  'service_role can prepare retained Partners data for account deletion'
);
select extensions.ok(
  not has_function_privilege(
    'authenticated',
    'public.partners_service_ops_alert_snapshot()',
    'EXECUTE'
  ),
  'authenticated clients cannot read the Partners ops alert snapshot'
);
select extensions.ok(
  has_function_privilege(
    'service_role',
    'public.partners_service_ops_alert_snapshot()',
    'EXECUTE'
  ),
  'service_role can read the sanitized Partners ops alert snapshot'
);
select extensions.ok(
  has_function_privilege(
    'service_role',
    'public.partners_service_apply(uuid,text,text,text,text)',
    'EXECUTE'
  ),
  'service_role can execute the Partners application RPC'
);
select extensions.ok(
  (
    select p.prosecdef
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'affiliate_private'
      and p.proname = 'partners_service_apply'
  ),
  'the privileged application implementation is SECURITY DEFINER'
);
select extensions.ok(
  not (
    select p.prosecdef
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'partners_service_apply'
  ),
  'the public application shim is SECURITY INVOKER'
);
select extensions.ok(
  (
    select c.relrowsecurity
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'affiliate_private'
      and c.relname = 'affiliate_service_idempotency'
  ),
  'the private idempotency table has RLS enabled'
);
select extensions.ok(
  exists (
    select 1
    from pg_indexes i
    where i.schemaname = 'affiliate_private'
      and i.indexname = 'affiliate_events_sequence_idx'
      and i.indexdef ilike '%unique%'
  ),
  'affiliate history has a unique monotonic sequence cursor'
);
select extensions.ok(
  (
    select pg_get_constraintdef(c.oid)
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'affiliate_private'
      and t.relname = 'affiliate_country_policies'
      and c.conname = 'affiliate_country_policies_age'
  ) like '%18%99%',
  'country-policy age bounds remain aligned to 18 through 99'
);
select extensions.ok(
  (
    select pg_get_constraintdef(c.oid)
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'affiliate_private'
      and t.relname = 'affiliate_country_policies'
      and c.conname = 'affiliate_country_policies_verification_level'
  ) like '%identity_age_country_capacity%',
  'verification-level values remain the exact foundation enum'
);

select extensions.ok(
  to_regclass(
    'affiliate_private.affiliate_payout_settlement_allocation_once_idx'
  ) is not null,
  'one payout allocation can produce only one settlement ledger entry'
);

insert into auth.users (
  id,
  instance_id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
values
  (
    '10000000-0000-4000-8000-000000000001',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'partners-admin@example.invalid',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '10000000-0000-4000-8000-000000000002',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'partners-member@example.invalid',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '10000000-0000-4000-8000-000000000003',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'partners-kyc@example.invalid',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '10000000-0000-4000-8000-000000000004',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'partners-referred@example.invalid',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb,
    now() + interval '1 second',
    now() + interval '1 second'
  ),
  (
    '10000000-0000-4000-8000-000000000005',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'partners-unattributed@example.invalid',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  );

insert into affiliate_private.affiliate_program_versions (
  version_key,
  account_type,
  status,
  commission_rate_bps,
  attribution_window_days,
  maturation_days,
  payout_thresholds,
  terms_version,
  disclosure_version,
  effective_from
)
values (
  'p0-test-v1',
  'individual',
  'active',
  2000,
  30,
  45,
  '{"USD":1000,"EUR":900}'::jsonb,
  'partners-terms-v1',
  'partners-disclosure-v1',
  now() - interval '1 minute'
);

insert into affiliate_private.affiliate_country_policies (
  program_version_id,
  country_code,
  individual_available,
  minimum_age,
  capacity_required,
  verification_level,
  verification_provider,
  payout_currencies,
  terms_version,
  disclosure_version,
  effective_from
)
select
  p.id,
  'US',
  true,
  18,
  false,
  'identity_age_country',
  'didit',
  array['USD']::text[],
  'partners-terms-v1',
  'partners-disclosure-v1',
  now() - interval '1 minute'
from affiliate_private.affiliate_program_versions p
where p.version_key = 'p0-test-v1';

insert into affiliate_private.affiliate_country_code_mappings (
  iso3,
  country_code,
  status,
  configured_by_pseudonym,
  justification
)
values (
  'USA',
  'US',
  'active',
  repeat('a', 64),
  'P0 database integration country mapping.'
);

insert into affiliate_private.affiliate_kyc_attempt_policies (
  country_policy_id,
  max_attempts,
  window_seconds,
  cooldown_seconds,
  status,
  configured_by_pseudonym,
  justification
)
select
  policy.id,
  3,
  86400,
  60,
  'active',
  repeat('a', 64),
  'P0 database integration KYC attempt policy.'
from affiliate_private.affiliate_country_policies policy
where policy.country_code = 'US'
  and policy.subdivision_code is null;

insert into affiliate_private.affiliate_currency_metadata (
  currency_code,
  exponent,
  status,
  configured_by_pseudonym,
  justification
)
values (
  'USD',
  2,
  'active',
  repeat('a', 64),
  'P0 database integration currency metadata.'
);

set local request.jwt.claims =
  '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"role":"admin"}}';

select extensions.is(
  public.admin_partners_capabilities() ->> 'can_manage',
  'false',
  'a regular admin cannot manage Partners capabilities'
);
select extensions.is(
  public.admin_partners_capabilities() ->> 'can_manage_release',
  'false',
  'a regular admin has no server-managed Partners release authority'
);

select extensions.throws_ok(
  $$
    select public.admin_partners_capability_set(
      '10000000-0000-4000-8000-000000000001',
      'support',
      true,
      'A regular admin must not self-elevate.'
    )
  $$,
  '42501',
  'Partners capability manager role is required',
  'a regular admin cannot grant itself a Partners capability'
);
select extensions.throws_ok(
  $$
    select public.admin_partners_control(
      'set_flag',
      'partners_enabled',
      false,
      'A regular admin must not control the Partners release.'
    )
  $$,
  '42501',
  'Partners control capability is required',
  'a regular admin cannot mutate Partners release controls'
);

set local request.jwt.claims =
  '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2","app_metadata":{"role":"admin","partners_capability_admin":true}}';

select extensions.is(
  public.admin_partners_capabilities() ->> 'can_manage',
  'true',
  'a server-designated capability manager can manage capabilities'
);
select extensions.is(
  public.admin_partners_capabilities() ->> 'can_manage_release',
  'false',
  'capability delegation does not grant production release authority'
);

select public.admin_partners_capability_set(
  '10000000-0000-4000-8000-000000000001',
  'support',
  true,
  'P0 database integration support capability.'
);
select public.admin_partners_capability_set(
  '10000000-0000-4000-8000-000000000001',
  'risk',
  true,
  'P0 database integration risk capability.'
);
select public.admin_partners_capability_set(
  '10000000-0000-4000-8000-000000000001',
  'finance',
  true,
  'P0 database integration finance capability.'
);

select extensions.is(
  public.admin_partners_capability_set(
    '10000000-0000-4000-8000-000000000001',
    'risk',
    false,
    'P0 database integration risk capability revocation.'
  ) ->> 'enabled',
  'false',
  'a capability manager can revoke a capability'
);

select extensions.is(
  public.admin_partners_capability_set(
    '10000000-0000-4000-8000-000000000001',
    'risk',
    true,
    'P0 database integration risk capability restoration.'
  ) ->> 'enabled',
  'true',
  'a capability manager can grant a capability'
);

select extensions.ok(
  exists (
    select 1
    from affiliate_private.affiliate_events e
    where e.aggregate_type = 'admin_capability'
      and e.action = 'admin_capability_set'
      and e.after_state @> '{"capability":"risk","enabled":true}'::jsonb
  )
  and exists (
    select 1
    from affiliate_private.affiliate_events e
    where e.aggregate_type = 'admin_capability'
      and e.action = 'admin_capability_set'
      and e.after_state @> '{"capability":"risk","enabled":false}'::jsonb
  ),
  'capability grant and revoke mutations append distinct audit events'
);

set local request.jwt.claims =
  '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2","app_metadata":{"role":"admin","partners_release_manager":true}}';

do $setup$
declare
  v_gate text;
begin
  foreach v_gate in array array[
    'legal_and_tax_approved',
    'privacy_approved',
    'individual_verification_coverage_confirmed',
    'individual_payout_coverage_confirmed',
    'country_policy_approved',
    'financial_data_contract_approved',
    'backup_restore_verified',
    'manual_payout_workflow_verified'
  ]::text[]
  loop
    perform public.admin_partners_control(
      'set_gate',
      v_gate,
      true,
      'P0 database integration test approval.'
    );
  end loop;

  perform public.admin_partners_control(
    'set_allowlist',
    null,
    true,
    'P0 database integration test allowlist.',
    '10000000-0000-4000-8000-000000000002',
    'US',
    null,
    now() + interval '1 day'
  );
  perform public.admin_partners_control(
    'set_allowlist',
    null,
    true,
    'P0 database integration KYC allowlist.',
    '10000000-0000-4000-8000-000000000003',
    'US',
    null,
    now() + interval '1 day'
  );
  perform public.admin_partners_control(
    'set_flag',
    'partners_invite_only',
    true,
    'P0 database integration test invite-only activation.'
  );
  perform public.admin_partners_control(
    'set_flag',
    'partners_enabled',
    true,
    'P0 database integration test programme activation.'
  );
  perform public.admin_partners_control(
    'set_flag',
    'partners_shadow_mode',
    true,
    'P0 database integration shadow worker activation.'
  );
end;
$setup$;

set local role service_role;

select extensions.is(
  public.partners_service_apply(
    '10000000-0000-4000-8000-000000000002',
    'US',
    null,
    'individual',
    'apply.integration.0001'
  ) ->> 'action',
  'application_submitted',
  'an allowlisted individual can submit an application'
);
select extensions.is(
  public.partners_service_apply(
    '10000000-0000-4000-8000-000000000002',
    'US',
    null,
    'individual',
    'apply.integration.0001'
  ) ->> 'replayed',
  'true',
  'application retries replay the stored response'
);

reset role;

select extensions.is(
  (
    select count(*)::bigint
    from affiliate_private.affiliate_accounts a
    where a.user_id = '10000000-0000-4000-8000-000000000002'
      and a.status <> 'closed'
  ),
  1::bigint,
  'application idempotency creates one open account'
);
select extensions.is(
  (
    select a.status
    from affiliate_private.affiliate_accounts a
    where a.user_id = '10000000-0000-4000-8000-000000000002'
  ),
  'pending_verification',
  'new applications remain pending verification'
);

set local role service_role;

select extensions.is(
  public.partners_service_accept_terms(
    '10000000-0000-4000-8000-000000000002',
    'partners-terms-v1',
    'partners-disclosure-v1',
    'terms.integration.0001'
  ) ->> 'action',
  'terms_accepted',
  'the current versioned terms can be accepted'
);

reset role;

select extensions.is(
  (
    select a.contract_status
    from affiliate_private.affiliate_accounts a
    where a.user_id = '10000000-0000-4000-8000-000000000002'
  ),
  'accepted',
  'term acceptance is stored on the private account'
);
select extensions.is(
  (
    select a.status
    from affiliate_private.affiliate_accounts a
    where a.user_id = '10000000-0000-4000-8000-000000000002'
  ),
  'pending_verification',
  'term acceptance does not bypass KYC'
);

update affiliate_private.affiliate_accounts
set
  verification_status = 'verified',
  verification_provider = 'didit',
  verification_reference = 'test-verification-reference',
  age_verified = true,
  capacity_verified = true,
  updated_at = now()
where user_id = '10000000-0000-4000-8000-000000000002';

set local role service_role;

select extensions.is(
  public.partners_service_accept_terms(
    '10000000-0000-4000-8000-000000000002',
    'partners-terms-v1',
    'partners-disclosure-v1',
    'terms.integration.0002'
  ) #>> '{account,status}',
  'active',
  'a server-verified account activates after every gate passes'
);
select extensions.is(
  public.partners_service_rotate_link(
    '10000000-0000-4000-8000-000000000002',
    'links.integration.0001'
  ) ->> 'action',
  'link_rotated',
  'an active account can create its first sharing link'
);
select extensions.is(
  public.partners_service_rotate_link(
    '10000000-0000-4000-8000-000000000002',
    'links.integration.0001'
  ) ->> 'replayed',
  'true',
  'link retries replay without rotating again'
);

reset role;

select extensions.is(
  (
    select count(*)::bigint
    from affiliate_private.affiliate_links
  ),
  1::bigint,
  'a replayed link request creates no extra link'
);
select extensions.is(
  (
    select count(*)::bigint
    from affiliate_private.affiliate_links
    where status = 'active'
  ),
  1::bigint,
  'exactly one active link exists after initial creation'
);

set local role service_role;

select extensions.is(
  public.partners_service_rotate_link(
    '10000000-0000-4000-8000-000000000002',
    'links.integration.0002'
  ) ->> 'action',
  'link_rotated',
  'a fresh key atomically rotates the sharing link'
);

reset role;

select extensions.is(
  (
    select count(*)::bigint
    from affiliate_private.affiliate_links
    where status = 'active'
  ),
  1::bigint,
  'link rotation preserves one active link'
);
select extensions.is(
  (
    select count(*)::bigint
    from affiliate_private.affiliate_links
    where status = 'revoked'
  ),
  1::bigint,
  'link rotation retains one terminal predecessor'
);

set local role service_role;

select extensions.is(
  public.partners_service_dashboard(
    '10000000-0000-4000-8000-000000000002',
    2,
    null,
    'all'
  ) #>> '{reporting,available}',
  'false',
  'dashboard reporting stays explicitly unavailable without a ledger'
);
select extensions.ok(
  (
    public.partners_service_dashboard(
      '10000000-0000-4000-8000-000000000002',
      2,
      null,
      'all'
    ) #> '{reporting,pending_minor}'
  ) = 'null'::jsonb,
  'dashboard does not invent a pending commission balance'
);
select extensions.ok(
  (
    public.partners_service_dashboard(
      '10000000-0000-4000-8000-000000000002',
      2,
      null,
      'all'
    ) #>> '{link,share_url}'
  ) ~ '^https://norva[.]tv/r/[A-Za-z0-9_-]{32}$',
  'dashboard exposes the real active sharing URL'
);
select extensions.is(
  jsonb_typeof(
    public.partners_service_dashboard(
      '10000000-0000-4000-8000-000000000002',
      2,
      null,
      'all'
    ) #> '{history,items}'
  ),
  'array',
  'dashboard history is a bounded JSON array'
);
select extensions.ok(
  (
    public.partners_service_dashboard(
      '10000000-0000-4000-8000-000000000002',
      2,
      null,
      'all'
    ) #> '{history,next_cursor}'
  ) = 'null'::jsonb,
  'dashboard has no synthetic cursor before financial activity exists'
);
select extensions.ok(
  public.partners_service_dashboard(
    '10000000-0000-4000-8000-000000000002',
    2,
    null,
    'all'
  )::text !~
    '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}',
  'member dashboard contains no UUID'
);
select extensions.is(
  jsonb_array_length(
    public.partners_service_dashboard(
      '10000000-0000-4000-8000-000000000002',
      25,
      null,
      'pending'
    ) #> '{history,items}'
  ),
  0,
  'financial history filters stay empty until ledger facts exist'
);
select extensions.throws_ok(
  $$
    select public.partners_service_apply(
      '10000000-0000-4000-8000-000000000002',
      'CA',
      null,
      'individual',
      'apply.integration.0001'
    )
  $$,
  'P0003',
  'idempotency key was reused with another request',
  'idempotency-key reuse with another payload is rejected'
);

select extensions.is(
  public.partners_service_apply(
    '10000000-0000-4000-8000-000000000003',
    'US',
    null,
    'individual',
    'apply.kyc.integration.0001'
  ) ->> 'action',
  'application_submitted',
  'the KYC fixture can submit an allowlisted application'
);
select extensions.is(
  public.partners_service_accept_terms(
    '10000000-0000-4000-8000-000000000003',
    'partners-terms-v1',
    'partners-disclosure-v1',
    'terms.kyc.integration.0001'
  ) ->> 'action',
  'terms_accepted',
  'the KYC fixture accepts the current terms and disclosure'
);
select extensions.throws_ok(
  $$
    select public.partners_service_kyc_prepare(
      '10000000-0000-4000-8000-000000000003',
      'kyc.prepare.integration.bad1',
      'partners-disclosure-old',
      true,
      'en'
    )
  $$,
  'P0001',
  'capacity consent version is not current',
  'KYC preparation rejects a stale disclosure'
);
select extensions.is(
  public.partners_service_kyc_prepare(
    '10000000-0000-4000-8000-000000000003',
    'kyc.prepare.integration.0001',
    'partners-disclosure-v1',
    true,
    'en'
  ) ->> 'action',
  'kyc_ready',
  'KYC preparation reserves exactly one hosted session slot'
);
select extensions.is(
  public.partners_service_kyc_prepare(
    '10000000-0000-4000-8000-000000000003',
    'kyc.prepare.integration.0001',
    'partners-disclosure-v1',
    true,
    'en'
  ) ->> 'replayed',
  'true',
  'the same KYC preparation key replays its reservation'
);
select extensions.throws_ok(
  $$
    select public.partners_service_kyc_prepare(
      '10000000-0000-4000-8000-000000000003',
      'kyc.prepare.integration.0002',
      'partners-disclosure-v1',
      true,
      'en'
    )
  $$,
  'P0004',
  'KYC session creation is already in progress',
  'a second KYC key cannot create a concurrent hosted session'
);

reset role;
create temporary table partners_test_state (
  state_key text primary key,
  state_value text not null
) on commit drop;
insert into partners_test_state (state_key, state_value)
select
  'kyc_reservation',
  reservation.reservation_key
from affiliate_private.affiliate_kyc_session_reservations reservation
join affiliate_private.affiliate_accounts account
  on account.id = reservation.account_id
where account.user_id = '10000000-0000-4000-8000-000000000003';
grant select, insert on partners_test_state to service_role;
grant select, insert on partners_test_state to authenticated;
set local role service_role;

select extensions.is(
  public.partners_service_kyc_session_record(
    '10000000-0000-4000-8000-000000000003',
    'kyc.session.integration.0001',
    'didit-session-integration-0001',
    'didit-workflow-integration',
    1,
    'not_started',
    null,
    (
      select state_value
      from partners_test_state
      where state_key = 'kyc_reservation'
    ),
    'sandbox',
    repeat('1', 64),
    604800
  ) ->> 'action',
  'kyc_session_recorded',
  'a Didit session binds to its database reservation'
);
select extensions.is(
  public.partners_service_kyc_session_record(
    '10000000-0000-4000-8000-000000000003',
    'kyc.session.integration.0001',
    'didit-session-integration-0001',
    'didit-workflow-integration',
    1,
    'not_started',
    null,
    (
      select state_value
      from partners_test_state
      where state_key = 'kyc_reservation'
    ),
    'sandbox',
    repeat('1', 64),
    604800
  ) ->> 'replayed',
  'true',
  'provider session recording is retry-safe after a network timeout'
);
select extensions.throws_ok(
  $$
    select public.partners_service_kyc_session_record(
      '10000000-0000-4000-8000-000000000003',
      'kyc.session.integration.0002',
      'didit-session-integration-0001',
      'different-workflow-integration',
      1,
      'not_started',
      null,
      (
        select state_value
        from partners_test_state
        where state_key = 'kyc_reservation'
      ),
      'sandbox',
      repeat('1', 64),
      604800
    )
  $$,
  'P0003',
  'provider session identity conflict',
  'a Didit provider id cannot be rebound to another workflow'
);

reset role;
select extensions.is(
  (
    select concat_ws(
      ':',
      session.provider_environment,
      session.provider_config_fingerprint,
      session.expires_at is not null
    )
    from affiliate_private.affiliate_kyc_sessions session
    where session.provider_session_hash = encode(
      extensions.digest(
        'norva:didit:session:v1:didit-session-integration-0001',
        'sha256'
      ),
      'hex'
    )
  ),
  'sandbox:' || repeat('1', 64) || ':t',
  'a KYC session stores its immutable sandbox binding and bounded local expiry'
);
select extensions.throws_ok(
  $$
    update affiliate_private.affiliate_kyc_sessions
    set provider_environment = 'live'
    where provider_session_hash = encode(
      extensions.digest(
        'norva:didit:session:v1:didit-session-integration-0001',
        'sha256'
      ),
      'hex'
    )
  $$,
  '55000',
  'KYC session identity is immutable',
  'a stored KYC environment cannot be promoted from sandbox to live'
);

set local role service_role;
select extensions.is(
  public.partners_service_kyc_webhook_apply(
    'didit-event-sandbox-integration-0001',
    'didit-session-integration-0001',
    'didit-workflow-integration',
    1,
    'approved',
    now(),
    27,
    'USA',
    true,
    true,
    true,
    repeat('a', 64),
    'sandbox',
    repeat('1', 64)
  ) ->> 'action',
  'kyc_result_observed',
  'an approved sandbox decision is observation-only'
);
select extensions.is(
  public.partners_service_kyc_webhook_apply(
    'didit-event-sandbox-integration-0001',
    'didit-session-integration-0001',
    'didit-workflow-integration',
    1,
    'approved',
    now(),
    27,
    'USA',
    true,
    true,
    true,
    repeat('a', 64),
    'sandbox',
    repeat('1', 64)
  ) ->> 'replayed',
  'true',
  'the exact sandbox observation replays without another decision'
);

reset role;
select extensions.is(
  (
    select concat_ws(':', account.status, account.verification_status)
    from affiliate_private.affiliate_accounts account
    where account.user_id =
      '10000000-0000-4000-8000-000000000003'
  ),
  'pending_verification:not_started',
  'sandbox approval never verifies or activates the Partners account'
);
select extensions.is(
  (
    select session.status
    from affiliate_private.affiliate_kyc_sessions session
    where session.provider_session_hash = encode(
      extensions.digest(
        'norva:didit:session:v1:didit-session-integration-0001',
        'sha256'
      ),
      'hex'
    )
  ),
  'superseded',
  'a sandbox attempt is terminally closed without becoming verified'
);
select extensions.is(
  (
    select concat_ws(
      ':',
      event.processing_outcome,
      event.decision_reason,
      event.provider_environment
    )
    from affiliate_private.affiliate_kyc_webhook_events event
    where event.provider_event_hash = encode(
      extensions.digest(
        'norva:didit:event:v1:didit-event-sandbox-integration-0001',
        'sha256'
      ),
      'hex'
    )
  ),
  'observed_sandbox:sandbox_non_authoritative:sandbox',
  'the exact sandbox outcome remains visible in append-only audit evidence'
);

insert into affiliate_private.affiliate_kyc_session_reservations (
  account_id
)
select account.id
from affiliate_private.affiliate_accounts account
where account.user_id = '10000000-0000-4000-8000-000000000003'
returning reservation_key;
insert into partners_test_state (state_key, state_value)
select
  'kyc_live_reservation',
  reservation.reservation_key
from affiliate_private.affiliate_kyc_session_reservations reservation
join affiliate_private.affiliate_accounts account
  on account.id = reservation.account_id
where account.user_id = '10000000-0000-4000-8000-000000000003'
  and reservation.status = 'reserved';

set local role service_role;
select extensions.is(
  public.partners_service_kyc_session_record(
    '10000000-0000-4000-8000-000000000003',
    'kyc.session.live.integration.0001',
    'didit-session-live-integration-0001',
    'didit-workflow-integration',
    1,
    'not_started',
    null,
    (
      select state_value
      from partners_test_state
      where state_key = 'kyc_live_reservation'
    ),
    'live',
    repeat('2', 64),
    604800
  ) ->> 'action',
  'kyc_session_recorded',
  'a fresh production session receives a distinct live binding'
);
select extensions.is(
  concat_ws(
    ':',
    public.partners_service_kyc_webhook_apply(
      'didit-event-pending-config-drift-0001',
      'didit-session-live-integration-0001',
      'didit-workflow-integration',
      1,
      'approved',
      now(),
      null,
      null,
      false,
      false,
      false,
      repeat('9', 64),
      'live',
      repeat('6', 64)
    ) ->> 'action',
    public.partners_service_kyc_webhook_apply(
      'didit-event-pending-config-drift-0001',
      'didit-session-live-integration-0001',
      'didit-workflow-integration',
      1,
      'approved',
      now(),
      null,
      null,
      false,
      false,
      false,
      repeat('9', 64),
      'live',
      repeat('6', 64)
    ) ->> 'reason'
  ),
  'kyc_result_quarantined:provider_config_mismatch',
  'a mismatched signed event is quarantined before the exact live decision'
);
reset role;
select extensions.is(
  (
    select session.status
    from affiliate_private.affiliate_kyc_sessions session
    where session.provider_session_hash = encode(
      extensions.digest(
        'norva:didit:session:v1:didit-session-live-integration-0001',
        'sha256'
      ),
      'hex'
    )
  ),
  'pending',
  'a binding quarantine cannot poison or supersede the real pending session'
);
set local role service_role;
select extensions.is(
  public.partners_service_kyc_webhook_apply(
    'didit-event-live-integration-0001',
    'didit-session-live-integration-0001',
    'didit-workflow-integration',
    1,
    'approved',
    now(),
    27,
    'USA',
    true,
    true,
    true,
    repeat('b', 64),
    'live',
    repeat('2', 64)
  ) ->> 'action',
  'kyc_result_applied',
  'an exact live binding reaches the authoritative KYC reducer'
);
select extensions.is(
  public.partners_service_kyc_webhook_apply(
    'didit-event-live-integration-0001',
    'didit-session-live-integration-0001',
    'didit-workflow-integration',
    1,
    'approved',
    now(),
    27,
    'USA',
    true,
    true,
    true,
    repeat('b', 64),
    'live',
    repeat('2', 64)
  ) #>> '{kyc,status}',
  'verified',
  'the exact live result is retry-safe and remains verified'
);

reset role;
select extensions.is(
  (
    select concat_ws(':', account.status, account.verification_status)
    from affiliate_private.affiliate_accounts account
    where account.user_id =
      '10000000-0000-4000-8000-000000000003'
  ),
  'active:verified',
  'only the exact live contract activates the allowlisted account'
);

set local role service_role;
select extensions.is(
  public.partners_service_kyc_webhook_apply(
    'didit-event-binding-conflict-0001',
    'didit-session-live-integration-0001',
    'didit-workflow-integration',
    1,
    'approved',
    now(),
    27,
    'USA',
    true,
    true,
    true,
    repeat('c', 64),
    'sandbox',
    repeat('1', 64)
  ) ->> 'action',
  'kyc_result_quarantined',
  'an environment conflict is rejected into a visible quarantine'
);
select extensions.is(
  concat_ws(
    ':',
    public.partners_service_kyc_webhook_apply(
      'didit-event-workflow-drift-0001',
      'didit-session-live-integration-0001',
      'didit-workflow-replaced',
      1,
      'approved',
      now(),
      null,
      null,
      false,
      false,
      false,
      repeat('d', 64),
      'live',
      repeat('3', 64)
    ) ->> 'action',
    public.partners_service_kyc_webhook_apply(
      'didit-event-workflow-drift-0001',
      'didit-session-live-integration-0001',
      'didit-workflow-replaced',
      1,
      'approved',
      now(),
      null,
      null,
      false,
      false,
      false,
      repeat('d', 64),
      'live',
      repeat('3', 64)
    ) ->> 'reason'
  ),
  'kyc_result_quarantined:provider_config_mismatch',
  'a signed known-session workflow-id drift reaches visible quarantine'
);
select extensions.is(
  concat_ws(
    ':',
    public.partners_service_kyc_webhook_apply(
      'didit-event-version-drift-0001',
      'didit-session-live-integration-0001',
      'didit-workflow-integration',
      2,
      'approved',
      now(),
      null,
      null,
      false,
      false,
      false,
      repeat('e', 64),
      'live',
      repeat('4', 64)
    ) ->> 'action',
    public.partners_service_kyc_webhook_apply(
      'didit-event-version-drift-0001',
      'didit-session-live-integration-0001',
      'didit-workflow-integration',
      2,
      'approved',
      now(),
      null,
      null,
      false,
      false,
      false,
      repeat('e', 64),
      'live',
      repeat('4', 64)
    ) ->> 'reason'
  ),
  'kyc_result_quarantined:provider_config_mismatch',
  'a signed known-session workflow-version drift reaches visible quarantine'
);
select extensions.is(
  concat_ws(
    ':',
    public.partners_service_kyc_webhook_apply(
      'didit-event-node-drift-0001',
      'didit-session-live-integration-0001',
      'didit-workflow-integration',
      1,
      'approved',
      now(),
      null,
      null,
      false,
      false,
      false,
      repeat('f', 64),
      'live',
      repeat('5', 64)
    ) ->> 'action',
    public.partners_service_kyc_webhook_apply(
      'didit-event-node-drift-0001',
      'didit-session-live-integration-0001',
      'didit-workflow-integration',
      1,
      'approved',
      now(),
      null,
      null,
      false,
      false,
      false,
      repeat('f', 64),
      'live',
      repeat('5', 64)
    ) ->> 'reason'
  ),
  'kyc_result_quarantined:provider_config_mismatch',
  'a signed known-session node/config drift reaches visible quarantine'
);
select extensions.is(
  public.partners_service_kyc_webhook_apply(
    'didit-event-live-integration-0001',
    'didit-session-live-integration-0001',
    'didit-workflow-integration',
    1,
    'approved',
    now(),
    27,
    'USA',
    true,
    true,
    true,
    repeat('b', 64),
    'sandbox',
    repeat('1', 64)
  ) ->> 'action',
  'kyc_result_quarantined',
  'a replay of a live event through another provider binding is quarantined'
);
select extensions.is(
  public.partners_service_kyc_webhook_apply(
    'didit-event-live-integration-0001',
    'didit-session-live-integration-0001',
    'didit-workflow-integration',
    1,
    'approved',
    now(),
    27,
    'USA',
    true,
    true,
    true,
    repeat('b', 64),
    'sandbox',
    repeat('1', 64)
  ) ->> 'action',
  'kyc_result_quarantined',
  'a retry of the same binding-conflict replay remains idempotent'
);

reset role;
select extensions.is(
  (
    select concat_ws(':', account.status, account.verification_status)
    from affiliate_private.affiliate_accounts account
    where account.user_id =
      '10000000-0000-4000-8000-000000000003'
  ),
  'active:verified',
  'a quarantined conflict cannot rewrite the prior live decision'
);
select extensions.is(
  (
    select concat_ws(
      ':',
      event.processing_outcome,
      event.decision_reason,
      event.provider_environment
    )
    from affiliate_private.affiliate_kyc_webhook_events event
    where event.provider_event_hash = encode(
      extensions.digest(
        'norva:didit:event:v1:didit-event-binding-conflict-0001',
        'sha256'
      ),
      'hex'
    )
  ),
  'quarantined:provider_environment_mismatch:sandbox',
  'the conflicting environment is retained as minimized quarantine evidence'
);
select set_config('norva.didit.environment', 'live', true);
select set_config(
  'norva.didit.config_fingerprint',
  repeat('6', 64),
  true
);
insert into affiliate_private.affiliate_kyc_sessions (
  account_id,
  provider,
  provider_session_hash,
  provider_workflow_hash,
  provider_workflow_version,
  provider_status,
  status,
  consent_version,
  capacity_attested,
  expires_at,
  created_at
)
select
  account.id,
  'didit',
  encode(
    extensions.digest(
      'norva:didit:session:v1:didit-recovery-session-old-0001',
      'sha256'
    ),
    'hex'
  ),
  encode(
    extensions.digest(
      'norva:didit:workflow:v1:didit-workflow-recovery',
      'sha256'
    ),
    'hex'
  ),
  1,
  'not_started',
  'pending',
  'partners-kyc-v1',
  true,
  now() + interval '1 hour',
  now() - interval '1 hour'
from affiliate_private.affiliate_accounts account
where account.user_id = '10000000-0000-4000-8000-000000000003';
set local role service_role;
select extensions.is(
  public.partners_service_kyc_webhook_apply(
    'didit-event-recovery-drift-0001',
    'didit-recovery-session-old-0001',
    'didit-workflow-recovery',
    1,
    'approved',
    now(),
    null,
    null,
    false,
    false,
    false,
    repeat('6', 64),
    'live',
    repeat('7', 64)
  ) ->> 'action',
  'kyc_result_quarantined',
  'a known pending session enters bounded recovery after config drift'
);
reset role;
select extensions.is(
  (
    select concat_ws(
      ':',
      session.status,
      session.expires_at <= now() + interval '15 minutes'
    )
    from affiliate_private.affiliate_kyc_sessions session
    where session.provider_session_hash = encode(
      extensions.digest(
        'norva:didit:session:v1:didit-recovery-session-old-0001',
        'sha256'
      ),
      'hex'
    )
  ),
  'pending:t',
  'quarantine preserves pending state but installs a bounded grace deadline'
);
update affiliate_private.affiliate_kyc_sessions
set expires_at = now() - interval '1 minute'
where provider_session_hash = encode(
  extensions.digest(
    'norva:didit:session:v1:didit-recovery-session-old-0001',
    'sha256'
  ),
  'hex'
);
set local role service_role;
select extensions.is(
  public.partners_service_kyc_binding_recover(10) ->> 'expired',
  '1',
  'the bounded worker recovery expires the elapsed drifted session'
);
select extensions.is(
  public.partners_service_kyc_webhook_apply(
    'didit-event-recovery-late-exact-0001',
    'didit-recovery-session-old-0001',
    'didit-workflow-recovery',
    1,
    'approved',
    now(),
    27,
    'USA',
    true,
    true,
    true,
    repeat('a', 64),
    'live',
    repeat('6', 64)
  ) #>> '{kyc,status}',
  'expired',
  'an exact live decision arriving after recovery cannot activate an expired session'
);
reset role;
select extensions.ok(
  exists (
    select 1
    from affiliate_private.affiliate_events event
    where event.action = 'kyc_session_recovery_expired'
      and event.aggregate_key = (
        select session.id::text
        from affiliate_private.affiliate_kyc_sessions session
        where session.provider_session_hash = encode(
          extensions.digest(
            'norva:didit:session:v1:didit-recovery-session-old-0001',
            'sha256'
          ),
          'hex'
        )
      )
  ),
  'elapsed recovery appends one sanitized terminal audit event'
);
select set_config('norva.didit.environment', 'live', true);
select set_config(
  'norva.didit.config_fingerprint',
  repeat('8', 64),
  true
);
insert into affiliate_private.affiliate_kyc_sessions (
  account_id,
  provider,
  provider_session_hash,
  provider_workflow_hash,
  provider_workflow_version,
  provider_status,
  status,
  consent_version,
  capacity_attested,
  expires_at
)
select
  account.id,
  'didit',
  encode(
    extensions.digest(
      'norva:didit:session:v1:didit-recovery-session-new-0001',
      'sha256'
    ),
    'hex'
  ),
  encode(
    extensions.digest(
      'norva:didit:workflow:v1:didit-workflow-recovery-new',
      'sha256'
    ),
    'hex'
  ),
  2,
  'not_started',
  'pending',
  'partners-kyc-v1',
  true,
  now() + interval '7 days'
from affiliate_private.affiliate_accounts account
where account.user_id = '10000000-0000-4000-8000-000000000003';
select extensions.is(
  (
    select concat_ws(
      ':',
      session.status,
      session.provider_environment,
      session.provider_config_fingerprint
    )
    from affiliate_private.affiliate_kyc_sessions session
    where session.provider_session_hash = encode(
      extensions.digest(
        'norva:didit:session:v1:didit-recovery-session-new-0001',
        'sha256'
      ),
      'hex'
    )
  ),
  'pending:live:' || repeat('8', 64),
  'an expired drifted session no longer blocks a fresh distinct binding'
);
select set_config('norva.didit.environment', 'sandbox', true);
select set_config(
  'norva.didit.config_fingerprint',
  repeat('7', 64),
  true
);
insert into affiliate_private.affiliate_kyc_sessions (
  account_id,
  provider,
  provider_session_hash,
  provider_workflow_hash,
  provider_workflow_version,
  provider_status,
  status,
  consent_version,
  capacity_attested
)
select
  account.id,
  'didit',
  repeat('7', 64),
  repeat('8', 64),
  1,
  'approved',
  'pending',
  'partners-kyc-v1',
  true
from affiliate_private.affiliate_accounts account
where account.user_id = '10000000-0000-4000-8000-000000000003';
update affiliate_private.affiliate_kyc_sessions
set
  status = 'verified',
  verified_at = now(),
  age_over_minimum = true,
  country_policy_match = true,
  identity_checks_approved = true,
  capacity_attested = true
where provider_session_hash = repeat('7', 64);
select extensions.is(
  (
    select count(*)::bigint
    from affiliate_private.affiliate_kyc_sessions session
    where session.status = 'verified'
      and session.verified_at >= now() - interval '30 days'
  ),
  2::bigint,
  'the analytics fixture contains one live and one synthetic sandbox verification'
);
set local request.jwt.claims =
  '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"role":"admin"}}';
set local role authenticated;
select extensions.is(
  (
    public.admin_partners_analytics(30)
      #>> '{activation,kyc_verified_sessions,value}'
  )::bigint,
  1::bigint,
  'activation analytics count only the authoritative shareable live session'
);
select extensions.is(
  (
    select sum((day ->> 'kyc_verified')::bigint)
    from jsonb_array_elements(
      public.admin_partners_analytics(30) -> 'daily'
    ) day
  ),
  1::numeric,
  'daily KYC analytics count only the authoritative shareable live session'
);
reset role;
select extensions.ok(
  exists (
    select 1
    from jsonb_array_elements(
      affiliate_private.partners_ops_alert_snapshot() -> 'alerts'
    ) alert
    where alert ->> 'code' =
      'kyc_provider_binding_quarantined_recent'
      and alert ->> 'severity' = 'critical'
      and (alert ->> 'count')::bigint = 7
  ),
  'seven distinct Didit binding conflicts produce exactly seven Ops incidents'
);
insert into affiliate_private.affiliate_events (
  aggregate_type,
  aggregate_key,
  action,
  actor_type,
  actor_pseudonym,
  justification
)
values (
  'account',
  '00000000-0000-4000-8000-000000000099',
  'legacy_kyc_binding_quarantined',
  'system',
  null,
  'Synthetic legacy binding quarantine used to verify the separate operations signal.'
);
select extensions.ok(
  exists (
    select 1
    from jsonb_array_elements(
      affiliate_private.partners_ops_alert_snapshot() -> 'alerts'
    ) alert
    where alert ->> 'code' =
      'kyc_legacy_binding_quarantined_recent'
      and alert ->> 'severity' = 'critical'
      and (alert ->> 'count')::bigint = 1
  ),
  'legacy fail-closed backfill is visible as one separate Ops incident'
);
select extensions.ok(
  not has_function_privilege(
    'service_role',
    'public.partners_service_kyc_webhook_apply(text,text,text,integer,text,timestamp with time zone,integer,text,boolean,boolean,boolean,text)',
    'EXECUTE'
  ),
  'the pre-binding webhook service signature is no longer callable'
);
select extensions.ok(
  has_function_privilege(
    'service_role',
    'public.partners_service_kyc_webhook_apply(text,text,text,integer,text,timestamp with time zone,integer,text,boolean,boolean,boolean,text,text,text)',
    'EXECUTE'
  ),
  'service_role can call only the environment-bound webhook signature'
);
select extensions.ok(
  not has_function_privilege(
    'authenticated',
    'public.partners_service_kyc_webhook_apply(text,text,text,integer,text,timestamp with time zone,integer,text,boolean,boolean,boolean,text,text,text)',
    'EXECUTE'
  ),
  'authenticated clients cannot forge an environment-bound KYC result'
);

select extensions.ok(
  not exists (
    select 1
    from affiliate_private.affiliate_kyc_sessions session
    where session.provider_session_hash =
      'didit-session-integration-0001'
       or session.provider_workflow_hash =
      'didit-workflow-integration'
  ),
  'raw Didit session and workflow identifiers are never stored'
);
insert into partners_test_state (state_key, state_value)
select 'referral_code_hash', link.code_hash
from affiliate_private.affiliate_links link
join affiliate_private.affiliate_accounts account
  on account.id = link.account_id
where account.user_id = '10000000-0000-4000-8000-000000000002'
  and link.status = 'active';
set local role service_role;

select extensions.is(
  public.partners_service_referral_resolve(
    (
      select state_value
      from partners_test_state
      where state_key = 'referral_code_hash'
    ),
    repeat('b', 64),
    now() + interval '1 day',
    repeat('c', 64),
    repeat('d', 64),
    repeat('e', 64)
  ) ->> 'accepted',
  'true',
  'an active public link resolves to a privacy-preserving claim'
);
select extensions.is(
  public.partners_service_referral_claim(
    '10000000-0000-4000-8000-000000000004',
    repeat('b', 64),
    'referral.claim.integration.0001'
  ) ->> 'outcome',
  'attributed',
  'a strictly pre-signup referral claim is attributed once'
);
select extensions.is(
  public.partners_service_referral_claim(
    '10000000-0000-4000-8000-000000000004',
    repeat('b', 64),
    'referral.claim.integration.0001'
  ) ->> 'replayed',
  'true',
  'referral consumption replays without duplicate attribution'
);

reset role;
select extensions.is(
  (
    select count(*)::bigint
    from affiliate_private.affiliate_attributions attribution
    where attribution.referred_user_id =
      '10000000-0000-4000-8000-000000000004'
  ),
  1::bigint,
  'one referred user has exactly one immutable attribution'
);

select extensions.is(
  affiliate_private.partners_commission_minor(2, 2000),
  0::bigint,
  '20 percent of two minor units rounds half up to zero'
);
select extensions.is(
  affiliate_private.partners_commission_minor(3, 2000),
  1::bigint,
  '20 percent of three minor units rounds half up to one'
);
select extensions.is(
  affiliate_private.partners_commission_minor(800, 2000),
  160::bigint,
  'the centralized commission calculator applies the exact 20 percent rate'
);

set local role service_role;
select extensions.ok(
  public.partners_worker_financial_observation_required(
    '10000000-0000-4000-8000-000000000004'
  ),
  'the finance producer enriches only a user with an immutable attribution'
);
select extensions.ok(
  not public.partners_worker_financial_observation_required(
    '10000000-0000-4000-8000-000000000005'
  ),
  'the finance producer skips Google Orders for an unattributed user'
);
select extensions.is(
  public.partners_worker_currency_exponent_resolve('usd'),
  2,
  'the finance producer resolves a configured active currency exponent'
);
select extensions.ok(
  public.partners_worker_currency_exponent_resolve('EUR') is null,
  'the finance producer never guesses an unconfigured currency exponent'
);
select extensions.is(
  public.partners_worker_financial_fact_ingest(
    repeat('1', 64),
    repeat('2', 64),
    repeat('3', 64),
    null,
    '10000000-0000-4000-8000-000000000004',
    'web',
    'capture',
    'production',
    'USD',
    2,
    1000,
    null,
    100,
    900,
    now() - interval '45 days'
  ) #>> '{fact,job_status}',
  'pending',
  'a complete attributed capture creates a durable commission job'
);
select extensions.is(
  public.partners_worker_financial_fact_ingest(
    repeat('1', 64),
    repeat('2', 64),
    repeat('3', 64),
    null,
    '10000000-0000-4000-8000-000000000004',
    'web',
    'capture',
    'production',
    'USD',
    2,
    1000,
    null,
    100,
    900,
    now() - interval '45 days'
  ) ->> 'replayed',
  'true',
  'financial fact ingestion replays the same source event exactly once'
);
select extensions.is(
  public.partners_worker_financial_fact_ingest(
    repeat('4', 64),
    repeat('5', 64),
    repeat('6', 64),
    null,
    '10000000-0000-4000-8000-000000000005',
    'web',
    'capture',
    'production',
    'USD',
    2,
    1000,
    100,
    100,
    800,
    now() - interval '45 days'
  ) #>> '{fact,status}',
  'incomplete',
  'a discount is context and cannot be subtracted twice from gross'
);

reset role;
select extensions.is(
  (
    select fact.facts_status
    from affiliate_private.affiliate_financial_facts fact
    where fact.transaction_hash = repeat('3', 64)
  ),
  'complete',
  'gross minus tax is a complete canonical fact when discount is absent'
);
select extensions.ok(
  (
    select fact.discount_minor is null
    from affiliate_private.affiliate_financial_facts fact
    where fact.transaction_hash = repeat('3', 64)
  ),
  'discount remains optional context in immutable facts'
);
select extensions.is(
  (
    select fact.eligible_minor
    from affiliate_private.affiliate_financial_facts fact
    where fact.transaction_hash = repeat('3', 64)
  ),
  900::bigint,
  'eligible minor units equal the final gross paid minus tax'
);
insert into partners_test_state (state_key, state_value)
select 'commission_job', job.job_key
from affiliate_private.affiliate_commission_jobs job
join affiliate_private.affiliate_financial_facts fact
  on fact.id = job.fact_id
where fact.transaction_hash = repeat('3', 64);
set local role service_role;
select extensions.is(
  jsonb_array_length(
    public.partners_worker_commission_jobs_lease(
      'p0-finance-worker',
      repeat('f', 64),
      10,
      60
    ) -> 'jobs'
  ),
  1,
  'the commission worker leases the due capture once'
);
select extensions.is(
  public.partners_worker_commission_job_complete(
    (
      select state_value
      from partners_test_state
      where state_key = 'commission_job'
    ),
    'p0-finance-worker',
    repeat('f', 64),
    'succeeded',
    null
  ) #>> '{ledger_entry,status}',
  'pending',
  'the worker appends a pending balanced commission entry'
);

reset role;
select extensions.is(
  (
    select entry.amount_minor
    from affiliate_private.affiliate_commission_entries entry
    join affiliate_private.affiliate_financial_facts fact
      on fact.id = entry.fact_id
    where fact.transaction_hash = repeat('3', 64)
      and entry.entry_kind = 'accrual'
  ),
  180::bigint,
  'the persisted commission is 20 percent of the eligible amount'
);
insert into partners_test_state (state_key, state_value)
select 'commission_entry', entry.entry_key
from affiliate_private.affiliate_commission_entries entry
join affiliate_private.affiliate_financial_facts fact
  on fact.id = entry.fact_id
where fact.transaction_hash = repeat('3', 64)
  and entry.entry_kind = 'accrual';
insert into partners_test_state (state_key, state_value)
select 'maturation_job', job.job_key
from affiliate_private.affiliate_maturation_jobs job
join affiliate_private.affiliate_commission_entries entry
  on entry.id = job.accrual_entry_id
where entry.entry_key = (
  select state_value
  from partners_test_state
  where state_key = 'commission_entry'
);

set local request.jwt.claims =
  '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2","app_metadata":{"role":"admin"}}';
set local role authenticated;
select extensions.is(
  public.admin_partners_commission_reverse(
    (
      select state_value
      from partners_test_state
      where state_key = 'commission_entry'
    ),
    'REVERSE:' || (
      select state_value
      from partners_test_state
      where state_key = 'commission_entry'
    ),
    'P0 database integration manual reversal.'
  ) ->> 'action',
  'manual_commission_reversal',
  'Finance can append a traceable manual counter-entry'
);

reset role;
set local role service_role;
select extensions.is(
  jsonb_array_length(
    public.partners_worker_maturation_lease(
      'p0-maturation-worker',
      repeat('9', 64),
      10,
      60
    ) -> 'jobs'
  ),
  1,
  'the J plus 45 maturation job becomes leasable'
);
select extensions.ok(
  (
    public.partners_worker_maturation_complete(
      (
        select state_value
        from partners_test_state
        where state_key = 'maturation_job'
      ),
      'p0-maturation-worker',
      repeat('9', 64),
      'succeeded',
      null
    ) -> 'ledger_entry'
  ) = 'null'::jsonb,
  'a fully reversed commission releases no value at J plus 45'
);
select extensions.is(
  public.partners_service_dashboard(
    '10000000-0000-4000-8000-000000000002',
    25,
    null,
    'reversed'
  ) #>> '{history,items,0,type}',
  'commission_reversed',
  'the member dashboard exposes a sanitized real reversal event'
);

reset role;
select extensions.is(
  (
    select coalesce(sum(entry.amount_minor), 0)::bigint
    from affiliate_private.affiliate_commission_entries entry
    where entry.related_entry_id = (
      select accrual.id
      from affiliate_private.affiliate_commission_entries accrual
      where accrual.entry_key = (
        select state_value
        from partners_test_state
        where state_key = 'commission_entry'
      )
    )
      and entry.entry_kind in ('reversal', 'manual_reversal')
  ),
  180::bigint,
  'manual reversal is included in the immutable reversal cap'
);

set local request.jwt.claims =
  '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2","app_metadata":{"role":"admin","partners_release_manager":true}}';
set local role authenticated;

select extensions.is(
  public.admin_partners_overview() ->> 'accounts_open',
  '2',
  'admin overview reports the real open-account count'
);
select extensions.is(
  jsonb_array_length(
    public.admin_partners_accounts(25, 0, 'all', null) -> 'items'
  ),
  2,
  'admin account list returns both sanitized partner rows'
);
select extensions.ok(
  not ((
    public.admin_partners_detail((
      select (item ->> 'account_id')::uuid
      from jsonb_array_elements(
        public.admin_partners_accounts(25, 0, 'all', null) -> 'items'
      ) item
      where item ->> 'link_status' = 'active'
      limit 1
    )) -> 'account'
  ) ? 'verification_provider'),
  'admin detail omits the KYC provider'
);
select extensions.ok(
  not ((
    public.admin_partners_detail((
      select (item ->> 'account_id')::uuid
      from jsonb_array_elements(
        public.admin_partners_accounts(25, 0, 'all', null) -> 'items'
      ) item
      where item ->> 'link_status' = 'active'
      limit 1
    )) -> 'account'
  ) ? 'verification_reference'),
  'admin detail omits the KYC provider reference'
);
select extensions.is(
  length(
    public.admin_partners_detail((
      select (item ->> 'account_id')::uuid
      from jsonb_array_elements(
        public.admin_partners_accounts(25, 0, 'all', null) -> 'items'
      ) item
      where item ->> 'link_status' = 'active'
      limit 1
    )) #>> '{link,code_preview}'
  ),
  11,
  'admin detail exposes only a shortened affiliate-code preview'
);
select extensions.is(
  public.admin_partners_detail((
    select (item ->> 'account_id')::uuid
    from jsonb_array_elements(
      public.admin_partners_accounts(25, 0, 'all', null) -> 'items'
    ) item
    where item ->> 'link_status' = 'active'
    limit 1
  )) #>> '{readiness,financial_ledger}',
  'true',
  'admin detail reports the installed financial ledger'
);
select extensions.is(
  public.admin_partners_overview()
    #>> '{readiness,payout_operations}',
  'false',
  'Admin readiness does not advertise a payout adapter that is absent'
);
select extensions.is(
  public.admin_partners_overview() #>> '{readiness,reason}',
  'payout_execution_adapter_not_verified',
  'Admin readiness states the exact missing payout control'
);
select extensions.is(
  jsonb_array_length(
    public.admin_partners_configuration() -> 'release_flags'
  ),
  6,
  'Admin configuration exposes all six managed flags without audit actors'
);
select extensions.ok(
  exists (
    select 1
    from jsonb_array_elements(
      public.admin_partners_configuration() -> 'release_flags'
    ) flag
    where flag ->> 'key' = 'partners_revolut_api_enabled'
      and flag ->> 'enabled' = 'false'
  ),
  'Admin configuration explicitly exposes the fail-closed Revolut API flag'
);
select extensions.ok(
  exists (
    select 1
    from jsonb_array_elements(
      public.admin_partners_configuration() -> 'release_gates'
    ) gate
    where gate ->> 'key' = 'payout_execution_adapter_verified'
      and gate ->> 'satisfied' = 'false'
      and not (gate ? 'updated_by_pseudonym')
      and not (gate ? 'justification')
  ),
  'Admin configuration exposes the redacted payout adapter gate'
);

select public.admin_partners_control(
  'set_flag',
  'partners_shadow_mode',
  false,
  'P0 database integration payout gate test.'
);
select public.admin_partners_control(
  'set_gate',
  'shadow_reconciliation_clean',
  true,
  'P0 database integration clean shadow result.'
);
select extensions.throws_ok(
  $$
    select public.admin_partners_control(
      'set_flag',
      'partners_payouts_live',
      true,
      'P0 database integration live payout attempt.'
    )
  $$,
  '55000',
  'payout prerequisites are incomplete',
  'live payouts cannot be enabled before the adapter is verified'
);
select public.admin_partners_control(
  'set_flag',
  'partners_shadow_mode',
  true,
  'P0 database integration resumes shadow processing.'
);

reset role;

set local request.jwt.claims =
  '{"sub":"10000000-0000-4000-8000-000000000002","role":"authenticated","app_metadata":{}}';
set local role authenticated;

select extensions.throws_ok(
  $$select public.admin_partners_overview()$$,
  '42501',
  'Partners Admin capability is required',
  'a non-admin without a capability cannot read Partners admin data'
);

reset role;

select extensions.ok(
  (
    select count(*) >= 5
    from affiliate_private.affiliate_events e
    where e.aggregate_type = 'account'
      and e.aggregate_key = (
        select a.id::text
        from affiliate_private.affiliate_accounts a
        where a.user_id = '10000000-0000-4000-8000-000000000002'
      )
  ),
  'application, contract, activation and link changes are audited'
);
select extensions.ok(
  not exists (
    select 1
    from affiliate_private.affiliate_events e
    where e.aggregate_type = 'account'
      and (
        e.before_state::text ilike '%verification_reference%'
        or e.after_state::text ilike '%verification_reference%'
      )
  ),
  'member audit events do not copy KYC references'
);
select extensions.ok(
  not has_table_privilege(
    'service_role',
    'affiliate_private.affiliate_accounts',
    'SELECT'
  ),
  'service_role reaches private accounts only through RPCs'
);
select extensions.ok(
  not has_table_privilege(
    'authenticated',
    'affiliate_private.affiliate_accounts',
    'SELECT'
  ),
  'authenticated admins reach private accounts only through sanitized RPCs'
);
select extensions.ok(
  has_function_privilege(
    'service_role',
    'public.partners_worker_financial_fact_ingest(text,text,text,text,uuid,text,text,text,text,integer,bigint,bigint,bigint,bigint,timestamptz)',
    'EXECUTE'
  ),
  'service_role alone can reach the financial fact ingestion boundary'
);
select extensions.ok(
  has_function_privilege(
    'service_role',
    'public.partners_worker_financial_observation_required(uuid)',
    'EXECUTE'
  ),
  'service_role can decide whether a financial observation needs enrichment'
);
select extensions.ok(
  not has_function_privilege(
    'authenticated',
    'public.partners_worker_financial_observation_required(uuid)',
    'EXECUTE'
  ),
  'authenticated clients cannot probe financial attribution requirements'
);
select extensions.ok(
  has_function_privilege(
    'service_role',
    'public.partners_worker_currency_exponent_resolve(text)',
    'EXECUTE'
  ),
  'service_role can resolve active currency metadata'
);
select extensions.ok(
  not has_function_privilege(
    'authenticated',
    'public.partners_worker_currency_exponent_resolve(text)',
    'EXECUTE'
  ),
  'authenticated clients cannot probe private currency configuration'
);
select extensions.ok(
  not has_function_privilege(
    'authenticated',
    'public.partners_worker_financial_fact_ingest(text,text,text,text,uuid,text,text,text,text,integer,bigint,bigint,bigint,bigint,timestamptz)',
    'EXECUTE'
  ),
  'authenticated clients cannot ingest financial facts'
);
select extensions.ok(
  (
    select relation.relrowsecurity
    from pg_class relation
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'affiliate_private'
      and relation.relname = 'affiliate_financial_facts'
  ),
  'immutable financial facts are protected by fail-closed RLS'
);
select extensions.ok(
  not (
    select gate.satisfied
    from affiliate_private.affiliate_release_gates gate
    where gate.gate_key = 'payout_execution_adapter_verified'
  ),
  'the real payout execution adapter gate is seeded fail-closed'
);

reset role;

select extensions.ok(
  position(
    'partners_balance_lock' in pg_get_functiondef(
      'affiliate_private.partners_route_commission_recovery(uuid,uuid,text,bigint,boolean)'::regprocedure
    )
  ) > 0
  and position(
    'partners_balance_lock' in pg_get_functiondef(
      'affiliate_private.partners_worker_commission_job_complete(text,text,text,text,text)'::regprocedure
    )
  ) > 0
  and position(
    'partners_balance_lock' in pg_get_functiondef(
      'affiliate_private.admin_partners_payout_cycle_approve(text,text,text)'::regprocedure
    )
  ) > 0,
  'refund routing and payout approval share one account-currency transaction lock'
);
select extensions.is(
  (
    select count(*)::bigint
    from pg_constraint constraint_row
    where constraint_row.conname in (
      'affiliate_payout_items_cycle_currency_fk',
      'affiliate_payout_items_profile_currency_fk'
    )
  ),
  2::bigint,
  'payout items are bound to the exact cycle and destination currency'
);

insert into partners_test_state (state_key, state_value)
select 'payout_account', account.id::text
from affiliate_private.affiliate_accounts account
where account.user_id = '10000000-0000-4000-8000-000000000002';

set local request.jwt.claims =
  '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2","app_metadata":{"role":"admin","partners_capability_admin":true}}';
set local role authenticated;
select public.admin_partners_capability_set(
  '10000000-0000-4000-8000-000000000005',
  'finance',
  true,
  'P0 payout integration independent approver.'
);
select public.admin_partners_capability_set(
  '10000000-0000-4000-8000-000000000004',
  'finance',
  true,
  'P0 payout integration competing Finance writer.'
);

reset role;
set local request.jwt.claims =
  '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2","app_metadata":{"role":"admin"}}';
set local role authenticated;
select extensions.throws_ok(
  $$
    select public.admin_partners_payout_provider_set(
      'wise',
      'US',
      'USD',
      'active',
      'P0 payout pilot must reject an unimplemented execution adapter.'
    )
  $$,
  '22023',
  'invalid legacy payout route disable request',
  'the compatibility wrapper cannot activate a legacy payout provider'
);
reset role;
select extensions.ok(
  not exists (
    select 1
    from affiliate_private.affiliate_payout_provider_configs config
    where config.provider = 'wise'
      and config.country_code = 'US'
      and config.currency = 'USD'
  ),
  'unsupported future-provider corridors are not materialized'
);
set local role authenticated;
select public.admin_partners_payout_route_set(
  'revolut',
  'revolut_manual',
  'US',
  'USD',
  'active',
  'P0 payout pilot exact Revolut manual USD corridor.'
);
select public.admin_partners_fiscal_review(
  (
    select state_value::uuid
    from partners_test_state
    where state_key = 'payout_account'
  ),
  'verified',
  'US',
  'didit',
  encode(extensions.digest('p0-fiscal-profile', 'sha256'), 'hex'),
  'W9',
  'P0 payout integration verified fiscal profile.'
);

reset role;
insert into partners_test_state (state_key, state_value)
select
  'revolut_binding_ticket_usd',
  authorized.result ->> 'binding_ticket'
from (
  select public.admin_partners_revolut_beneficiary_binding_authorize(
    (
      select state_value::uuid
      from partners_test_state
      where state_key = 'payout_account'
    ),
    'USD',
    '11111111-1111-4111-8111-111111111111',
    null,
    'Bank •••• 8421',
    1,
    repeat('b', 64),
    'P0 payout integration tokenized USD beneficiary authorization.'
  ) as result
) authorized;

reset role;
set local role service_role;
insert into partners_test_state (state_key, state_value)
select
  'revolut_binding_usd',
  proposed.result #>> '{binding,key}'
from (
  select public.partners_service_revolut_beneficiary_binding_propose(
    repeat('c', 64),
    repeat('d', 64),
    (
      select state_value
      from partners_test_state
      where state_key = 'revolut_binding_ticket_usd'
    )
  ) as result
) proposed;

reset role;
set local request.jwt.claims =
  '{"sub":"10000000-0000-4000-8000-000000000005","role":"authenticated","aal":"aal2","app_metadata":{"role":"admin"}}';
set local role authenticated;
select extensions.is(
  public.admin_partners_revolut_beneficiary_binding_verify(
    (
      select state_value
      from partners_test_state
      where state_key = 'revolut_binding_usd'
    ),
    'VERIFY:' || (
      select state_value
      from partners_test_state
      where state_key = 'revolut_binding_usd'
    ),
    'P0 payout integration independent USD beneficiary verification.'
  ) ->> 'action',
  'revolut_beneficiary_binding_verified',
  'the released manual adapter records a verified tokenized USD destination'
);

reset role;
create or replace function pg_temp.partners_test_add_released_commission(
  p_transaction_hash text,
  p_currency text,
  p_commission_minor bigint,
  p_created_at timestamptz
)
returns uuid
language plpgsql
as $test$
declare
  v_account_id uuid;
  v_attribution_id uuid;
  v_referred_user_id uuid;
  v_fact_id uuid;
  v_accrual_id uuid;
  v_release_id uuid;
begin
  select
    attribution.referrer_account_id,
    attribution.id,
    attribution.referred_user_id
  into strict v_account_id, v_attribution_id, v_referred_user_id
  from affiliate_private.affiliate_attributions attribution
  where attribution.referrer_account_id = (
    select state_value::uuid
    from partners_test_state
    where state_key = 'payout_account'
  );

  insert into affiliate_private.affiliate_financial_facts (
    transaction_hash,
    referred_user_id,
    attribution_id,
    rail,
    event_type,
    environment,
    facts_status,
    currency,
    currency_exponent,
    gross_minor,
    discount_minor,
    tax_minor,
    eligible_minor,
    occurred_at,
    created_at
  )
  values (
    p_transaction_hash,
    v_referred_user_id,
    v_attribution_id,
    'web',
    'renewal',
    'production',
    'complete',
    p_currency,
    2,
    p_commission_minor * 5,
    null,
    0,
    p_commission_minor * 5,
    p_created_at - interval '60 days',
    p_created_at
  )
  returning id into v_fact_id;

  insert into affiliate_private.affiliate_commission_jobs (
    fact_id,
    job_kind,
    status,
    next_attempt_at,
    created_at,
    updated_at,
    completed_at
  )
  values (
    v_fact_id,
    'accrual',
    'succeeded',
    p_created_at,
    p_created_at,
    p_created_at,
    p_created_at
  );

  insert into affiliate_private.affiliate_commission_entries (
    account_id,
    attribution_id,
    fact_id,
    entry_kind,
    currency,
    currency_exponent,
    amount_minor,
    matures_at,
    created_at
  )
  values (
    v_account_id,
    v_attribution_id,
    v_fact_id,
    'accrual',
    p_currency,
    2,
    p_commission_minor,
    p_created_at - interval '1 day',
    p_created_at
  )
  returning id into v_accrual_id;
  insert into affiliate_private.affiliate_commission_postings (
    entry_id, ledger_account, direction, amount_minor, currency
  )
  values
    (
      v_accrual_id,
      'platform_commission_expense',
      'debit',
      p_commission_minor,
      p_currency
    ),
    (
      v_accrual_id,
      'partner_commission_pending',
      'credit',
      p_commission_minor,
      p_currency
    );

  insert into affiliate_private.affiliate_maturation_jobs (
    accrual_entry_id,
    status,
    available_at,
    next_attempt_at,
    created_at,
    updated_at,
    completed_at
  )
  values (
    v_accrual_id,
    'succeeded',
    p_created_at - interval '1 day',
    p_created_at - interval '1 day',
    p_created_at,
    p_created_at,
    p_created_at
  );

  insert into affiliate_private.affiliate_commission_entries (
    account_id,
    attribution_id,
    fact_id,
    entry_kind,
    related_entry_id,
    currency,
    currency_exponent,
    amount_minor,
    created_at
  )
  values (
    v_account_id,
    v_attribution_id,
    v_fact_id,
    'release',
    v_accrual_id,
    p_currency,
    2,
    p_commission_minor,
    p_created_at
  )
  returning id into v_release_id;
  insert into affiliate_private.affiliate_commission_postings (
    entry_id, ledger_account, direction, amount_minor, currency
  )
  values
    (
      v_release_id,
      'partner_commission_pending',
      'debit',
      p_commission_minor,
      p_currency
    ),
    (
      v_release_id,
      'partner_commission_available',
      'credit',
      p_commission_minor,
      p_currency
    );
  perform affiliate_private.partners_recovery_due_consume(
    v_account_id,
    p_currency
  );
  return v_accrual_id;
end;
$test$;

create or replace function pg_temp.partners_test_recover_commission(
  p_accrual_id uuid,
  p_amount_minor bigint
)
returns jsonb
language plpgsql
as $test$
declare
  v_accrual affiliate_private.affiliate_commission_entries%rowtype;
  v_reversal_id uuid;
begin
  select entry.*
  into strict v_accrual
  from affiliate_private.affiliate_commission_entries entry
  where entry.id = p_accrual_id;

  insert into affiliate_private.affiliate_commission_entries (
    account_id,
    attribution_id,
    entry_kind,
    related_entry_id,
    currency,
    currency_exponent,
    amount_minor
  )
  values (
    v_accrual.account_id,
    v_accrual.attribution_id,
    'manual_reversal',
    v_accrual.id,
    v_accrual.currency,
    v_accrual.currency_exponent,
    p_amount_minor
  )
  returning id into v_reversal_id;

  return affiliate_private.partners_route_commission_recovery(
    v_reversal_id,
    v_accrual.account_id,
    v_accrual.currency,
    p_amount_minor,
    false
  );
end;
$test$;

insert into partners_test_state (state_key, state_value)
values (
  'payout_accrual_1',
  pg_temp.partners_test_add_released_commission(
    repeat('7', 64),
    'USD',
    2000,
    now() - interval '2 days'
  )::text
);

set local request.jwt.claims =
  '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2","app_metadata":{"role":"admin","partners_release_manager":true}}';
set local role authenticated;
select public.admin_partners_control(
  'set_gate',
  'payout_execution_adapter_verified',
  true,
  'P0 payout integration verified test adapter.'
);
select public.admin_partners_control(
  'set_flag',
  'partners_shadow_mode',
  false,
  'P0 payout integration exits shadow mode.'
);
select public.admin_partners_control(
  'set_flag',
  'partners_payouts_live',
  true,
  'P0 payout integration enables live test path.'
);

select extensions.is(
  public.admin_partners_payout_cycle_create(
    current_date - 30,
    current_date - 1,
    'USD',
    false,
    'CREATE:' || (current_date - 30)::text || ':'
      || (current_date - 1)::text || ':USD:DRY',
    'P0 payout integration dry cycle.'
  ) ->> 'action',
  'payout_cycle_created',
  'Finance can create the dry payout snapshot'
);
reset role;
insert into partners_test_state (state_key, state_value)
select 'payout_cycle_1', cycle.cycle_key
from affiliate_private.affiliate_payout_cycles cycle
where cycle.period_start = current_date - 30
  and cycle.period_end = current_date - 1
  and cycle.currency = 'USD';
set local request.jwt.claims =
  '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2","app_metadata":{"role":"admin","partners_release_manager":true}}';
set local role authenticated;
select extensions.ok(
  (
    select result ->> 'replayed' = 'true'
      and result #>> '{cycle,key}' = (
        select state_value
        from partners_test_state
        where state_key = 'payout_cycle_1'
      )
    from (
      select public.admin_partners_payout_cycle_create(
        current_date - 30,
        current_date - 1,
        'USD',
        false,
        'CREATE:' || (current_date - 30)::text || ':'
          || (current_date - 1)::text || ':USD:DRY',
        'P0 payout integration dry replay.'
      ) as result
    ) replay
  ),
  'a repeated dry cycle request replays the same cycle'
);
select extensions.is(
  public.admin_partners_payout_cycle_create(
    current_date - 30,
    current_date - 1,
    'USD',
    true,
    'CREATE:' || (current_date - 30)::text || ':'
      || (current_date - 1)::text || ':USD:LIVE',
    'P0 payout integration live promotion.'
  ) ->> 'action',
  'payout_cycle_promoted_live',
  'the dry cycle is atomically promoted instead of duplicated'
);
reset role;
select extensions.ok(
  (
    select count(*) = 1
      and bool_and(cycle.live_execution)
      and min(cycle.cycle_key) = (
        select state_value
        from partners_test_state
        where state_key = 'payout_cycle_1'
      )
    from affiliate_private.affiliate_payout_cycles cycle
    where cycle.period_start = current_date - 30
      and cycle.period_end = current_date - 1
      and cycle.currency = 'USD'
  ),
  'dry-to-live promotion preserves one period-currency cycle and its key'
);
select extensions.ok(
  exists (
    select 1
    from affiliate_private.affiliate_events event
    where event.aggregate_key = (
        select state_value
        from partners_test_state
        where state_key = 'payout_cycle_1'
      )
      and event.action = 'payout_cycle_promoted_live'
      and event.before_state @> '{"live_execution":false}'::jsonb
      and event.after_state @> '{"live_execution":true}'::jsonb
  ),
  'dry-to-live promotion appends a redacted audit transition'
);
set local request.jwt.claims =
  '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2","app_metadata":{"role":"admin","partners_release_manager":true}}';
set local role authenticated;
select extensions.throws_ok(
  format(
    'select public.admin_partners_payout_cycle_approve(%L,%L,%L)',
    (
      select state_value
      from partners_test_state
      where state_key = 'payout_cycle_1'
    ),
    'APPROVE:' || (
      select state_value
      from partners_test_state
      where state_key = 'payout_cycle_1'
    ),
    'P0 payout integration same-actor rejection.'
  ),
  'P0001',
  'live payout approval controls are incomplete',
  'the live promoter cannot approve their own promoted cycle'
);

reset role;
create temporary sequence partners_conflict_signal;
grant usage, select on sequence partners_conflict_signal to authenticated;
select nextval('partners_conflict_signal');
savepoint payout_conflict_probe;
insert into affiliate_private.affiliate_financial_fact_conflicts (
  fact_id,
  source_event_hash,
  payload_hash,
  mismatched_fields,
  observed_at
)
select
  accrual.fact_id,
  encode(extensions.digest('p0-payout-conflict-source', 'sha256'), 'hex'),
  encode(extensions.digest('p0-payout-conflict-payload', 'sha256'), 'hex'),
  array['gross']::text[],
  now()
from affiliate_private.affiliate_commission_entries accrual
where accrual.id = (
  select state_value::uuid
  from partners_test_state
  where state_key = 'payout_accrual_1'
);
set local request.jwt.claims =
  '{"sub":"10000000-0000-4000-8000-000000000005","role":"authenticated","aal":"aal2","app_metadata":{"role":"admin"}}';
set local role authenticated;
do $probe$
begin
  perform public.admin_partners_payout_cycle_approve(
    (
      select state_value
      from partners_test_state
      where state_key = 'payout_cycle_1'
    ),
    'APPROVE:' || (
      select state_value
      from partners_test_state
      where state_key = 'payout_cycle_1'
    ),
    'P0 payout integration conflict rejection.'
  );
exception
  when sqlstate 'P0004' then
    perform nextval('partners_conflict_signal');
end;
$probe$;
rollback to savepoint payout_conflict_probe;
select extensions.is(
  (select last_value from partners_conflict_signal),
  2::bigint,
  'payout approval fails closed while an exact financial fact is conflicted'
);

set local request.jwt.claims =
  '{"sub":"10000000-0000-4000-8000-000000000005","role":"authenticated","aal":"aal2","app_metadata":{"role":"admin"}}';
set local role authenticated;
select extensions.is(
  public.admin_partners_payout_cycle_approve(
    (
      select state_value
      from partners_test_state
      where state_key = 'payout_cycle_1'
    ),
    'APPROVE:' || (
      select state_value
      from partners_test_state
      where state_key = 'payout_cycle_1'
    ),
    'P0 payout integration independent approval.'
  ) ->> 'action',
  'payout_cycle_approved',
  'an independent Finance actor approves the authoritative live cycle'
);

reset role;
insert into partners_test_state (state_key, state_value)
values (
  'payout_partial_route',
  pg_temp.partners_test_recover_commission(
    (
      select state_value::uuid
      from partners_test_state
      where state_key = 'payout_accrual_1'
    ),
    500
  )::text
);
select extensions.is(
  (
    select state_value::jsonb ->> 'clearing_minor'
    from partners_test_state
    where state_key = 'payout_partial_route'
  ),
  '500',
  'a partial refund is recovered from approved clearing'
);
select extensions.is(
  (
    select concat_ws(
      ':',
      item.amount_minor,
      item.recovered_minor,
      item.status,
      cycle.total_minor,
      cycle.item_count
    )
    from affiliate_private.affiliate_payout_items item
    join affiliate_private.affiliate_payout_cycles cycle
      on cycle.id = item.cycle_id
    where cycle.cycle_key = (
      select state_value
      from partners_test_state
      where state_key = 'payout_cycle_1'
    )
  ),
  '1500:500:pending:1500:1',
  'partial recovery atomically reduces both the item and cycle payable total'
);
insert into partners_test_state (state_key, state_value)
values (
  'payout_full_route',
  pg_temp.partners_test_recover_commission(
    (
      select state_value::uuid
      from partners_test_state
      where state_key = 'payout_accrual_1'
    ),
    1500
  )::text
);
select extensions.is(
  (
    select state_value::jsonb ->> 'clearing_minor'
    from partners_test_state
    where state_key = 'payout_full_route'
  ),
  '1500',
  'the remaining refund is fully recovered from approved clearing'
);
select extensions.is(
  (
    select concat_ws(
      ':',
      item.amount_minor,
      item.recovered_minor,
      item.status,
      cycle.total_minor,
      cycle.item_count
    )
    from affiliate_private.affiliate_payout_items item
    join affiliate_private.affiliate_payout_cycles cycle
      on cycle.id = item.cycle_id
    where cycle.cycle_key = (
      select state_value
      from partners_test_state
      where state_key = 'payout_cycle_1'
    )
  ),
  '0:2000:reversed:0:0',
  'a full recovery cancels the item and zeroes cycle totals'
);
select extensions.is(
  (
    select coalesce(sum(
      case
        when posting.direction = 'credit' then posting.amount_minor
        else -posting.amount_minor
      end
    ), 0)::bigint
    from affiliate_private.affiliate_commission_postings posting
    join affiliate_private.affiliate_commission_entries entry
      on entry.id = posting.entry_id
    where entry.account_id = (
        select state_value::uuid
        from partners_test_state
        where state_key = 'payout_account'
      )
      and posting.currency = 'USD'
      and posting.ledger_account = 'partner_payout_clearing'
  ),
  0::bigint,
  'pre-submission recovery leaves no payable value in clearing'
);

insert into partners_test_state (state_key, state_value)
values (
  'payout_accrual_2',
  pg_temp.partners_test_add_released_commission(
    repeat('8', 64),
    'USD',
    2000,
    now() - interval '2 days'
  )::text
);
set local request.jwt.claims =
  '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2","app_metadata":{"role":"admin","partners_release_manager":true}}';
set local role authenticated;
select public.admin_partners_payout_cycle_create(
  current_date - 29,
  current_date - 1,
  'USD',
  true,
  'CREATE:' || (current_date - 29)::text || ':'
    || (current_date - 1)::text || ':USD:LIVE',
  'P0 payout integration settled cycle.'
);
reset role;
insert into partners_test_state (state_key, state_value)
select 'payout_cycle_2', cycle.cycle_key
from affiliate_private.affiliate_payout_cycles cycle
where cycle.period_start = current_date - 29
  and cycle.period_end = current_date - 1
  and cycle.currency = 'USD';

set local request.jwt.claims =
  '{"sub":"10000000-0000-4000-8000-000000000005","role":"authenticated","aal":"aal2","app_metadata":{"role":"admin"}}';
set local role authenticated;
select public.admin_partners_payout_cycle_approve(
  (
    select state_value
    from partners_test_state
    where state_key = 'payout_cycle_2'
  ),
  'APPROVE:' || (
    select state_value
    from partners_test_state
    where state_key = 'payout_cycle_2'
  ),
  'P0 payout integration settled approval.'
);
insert into partners_test_state (state_key, state_value)
select
  'payout_batch_2',
  public.admin_partners_revolut_manual_batch_prepare(
    (
      select state_value
      from partners_test_state
      where state_key = 'payout_cycle_2'
    ),
    'PREPARE:' || (
      select state_value
      from partners_test_state
      where state_key = 'payout_cycle_2'
    ),
    'P0 payout integration prepares the manual Revolut batch.'
  ) #>> '{batch,key}';
select public.admin_partners_revolut_manual_batch_export(
  (
    select state_value
    from partners_test_state
    where state_key = 'payout_batch_2'
  ),
  'EXPORT:' || (
    select state_value
    from partners_test_state
    where state_key = 'payout_batch_2'
  ),
  'P0 payout integration exports the manual Revolut batch.'
);
reset role;

insert into partners_test_state (state_key, state_value)
select 'payout_reference_2', execution.payout_reference
from affiliate_private.affiliate_revolut_payout_executions execution
join affiliate_private.affiliate_revolut_manual_batches batch
  on batch.id = execution.manual_batch_id
where batch.batch_key = (
  select state_value
  from partners_test_state
  where state_key = 'payout_batch_2'
);

set local request.jwt.claims =
  '{"sub":"10000000-0000-4000-8000-000000000005","role":"authenticated","aal":"aal2","app_metadata":{"role":"admin"}}';
set local role authenticated;
select public.admin_partners_revolut_manual_batch_mark_submitted(
  (
    select state_value
    from partners_test_state
    where state_key = 'payout_batch_2'
  ),
  jsonb_build_array(jsonb_build_object(
    'reference',
    (
      select state_value
      from partners_test_state
      where state_key = 'payout_reference_2'
    )
  )),
  'SUBMIT:' || (
    select state_value
    from partners_test_state
    where state_key = 'payout_batch_2'
  ),
  'P0 payout integration records entry in Revolut Business.'
);
reset role;

set local request.jwt.claims =
  '{"sub":"10000000-0000-4000-8000-000000000004","role":"authenticated","aal":"aal2","app_metadata":{"role":"admin"}}';
set local role authenticated;
insert into partners_test_state (state_key, state_value)
select
  'statement_ticket_2',
  public.admin_partners_revolut_statement_authorize()
    ->> 'import_ticket';
reset role;

set local role service_role;
select public.partners_service_revolut_statement_ingest(
  encode(
    extensions.digest('p0-revolut-statement-2', 'sha256'),
    'hex'
  ),
  current_date - 1,
  current_date,
  'USD',
  jsonb_build_array(jsonb_build_object(
    'reference',
    (
      select state_value
      from partners_test_state
      where state_key = 'payout_reference_2'
    ),
    'provider_transaction_id',
    'p0-transfer-00000002',
    'provider_state',
    'COMPLETED',
    'amount_minor',
    2000,
    'currency',
    'USD',
    'value_date',
    current_date::text
  )),
  'p0-revolut-statement',
  (
    select state_value
    from partners_test_state
    where state_key = 'statement_ticket_2'
  )
);
reset role;

insert into partners_test_state (state_key, state_value)
select 'statement_row_2', statement.row_key
from affiliate_private.affiliate_revolut_statement_rows statement
where statement.payout_reference = (
  select state_value
  from partners_test_state
  where state_key = 'payout_reference_2'
);

set local request.jwt.claims =
  '{"sub":"10000000-0000-4000-8000-000000000004","role":"authenticated","aal":"aal2","app_metadata":{"role":"admin"}}';
set local role authenticated;
insert into partners_test_state (state_key, state_value)
select
  'reconciliation_review_2',
  public.admin_partners_revolut_reconciliation_review(
    (
      select state_value
      from partners_test_state
      where state_key = 'statement_row_2'
    ),
    'REVIEW:' || (
      select state_value
      from partners_test_state
      where state_key = 'statement_row_2'
    ),
    'P0 payout integration reviews the matched statement evidence.'
  ) #>> '{review,key}';
reset role;

set local request.jwt.claims =
  '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2","app_metadata":{"role":"admin"}}';
set local role authenticated;
select public.admin_partners_revolut_reconciliation_decide(
  (
    select state_value
    from partners_test_state
    where state_key = 'reconciliation_review_2'
  ),
  'confirmed',
  'CONFIRM:' || (
    select state_value
    from partners_test_state
    where state_key = 'reconciliation_review_2'
  ),
  'P0 payout integration confirms the exact settled transfer.'
);
reset role;

create or replace function
pg_temp.partners_test_invalid_payout_settlement()
returns void
language plpgsql
volatile
as $invalid$
declare
  v_item affiliate_private.affiliate_payout_items%rowtype;
  v_cycle affiliate_private.affiliate_payout_cycles%rowtype;
  v_entry_id uuid;
begin
  select item.*
  into strict v_item
  from affiliate_private.affiliate_payout_items item
  join affiliate_private.affiliate_payout_cycles cycle
    on cycle.id = item.cycle_id
  where cycle.cycle_key = (
    select state_value
    from partners_test_state
    where state_key = 'payout_cycle_1'
  );
  select cycle.*
  into strict v_cycle
  from affiliate_private.affiliate_payout_cycles cycle
  where cycle.id = v_item.cycle_id;
  insert into affiliate_private.affiliate_commission_entries (
    account_id,
    entry_kind,
    related_entry_id,
    currency,
    currency_exponent,
    amount_minor
  )
  values (
    v_item.account_id,
    'payout_settlement',
    v_item.allocation_entry_id,
    v_cycle.currency,
    v_cycle.currency_exponent,
    v_item.amount_minor + 1
  )
  returning id into v_entry_id;
  insert into affiliate_private.affiliate_commission_postings (
    entry_id, ledger_account, direction, amount_minor, currency
  )
  values
    (
      v_entry_id,
      'partner_payout_clearing',
      'debit',
      v_item.amount_minor + 1,
      v_cycle.currency
    ),
    (
      v_entry_id,
      'partner_cash_settled',
      'credit',
      v_item.amount_minor + 1,
      v_cycle.currency
    );
  set constraints
    affiliate_private.affiliate_payout_settlement_semantics immediate;
end;
$invalid$;
select extensions.throws_ok(
  'select pg_temp.partners_test_invalid_payout_settlement()',
  '23514',
  'payout settlement does not match its allocation',
  'the deferred ledger guard rejects a settlement that differs by one unit'
);

insert into partners_test_state (state_key, state_value)
values (
  'payout_settled_route',
  pg_temp.partners_test_recover_commission(
    (
      select state_value::uuid
      from partners_test_state
      where state_key = 'payout_accrual_2'
    ),
    2000
  )::text
);
select extensions.is(
  (
    select state_value::jsonb ->> 'recovery_due_minor'
    from partners_test_state
    where state_key = 'payout_settled_route'
  ),
  '2000',
  'a post-settlement refund becomes an explicit recovery receivable'
);
select extensions.is(
  (
    select concat_ws(
      ':',
      item.amount_minor,
      item.recovered_minor,
      item.status
    )
    from affiliate_private.affiliate_payout_items item
    join affiliate_private.affiliate_payout_cycles cycle
      on cycle.id = item.cycle_id
    where cycle.cycle_key = (
      select state_value
      from partners_test_state
      where state_key = 'payout_cycle_2'
    )
  ),
  '2000:0:settled',
  'post-settlement recovery never rewrites the settled transfer'
);
select extensions.is(
  (
    select coalesce(sum(
      case
        when posting.direction = 'debit' then posting.amount_minor
        else -posting.amount_minor
      end
    ), 0)::bigint
    from affiliate_private.affiliate_commission_postings posting
    join affiliate_private.affiliate_commission_entries entry
      on entry.id = posting.entry_id
    where entry.account_id = (
        select state_value::uuid
        from partners_test_state
        where state_key = 'payout_account'
      )
      and posting.currency = 'USD'
      and posting.ledger_account = 'partner_recovery_due'
  ),
  2000::bigint,
  'post-settlement recovery debt is visible in the immutable ledger'
);

insert into partners_test_state (state_key, state_value)
values (
  'payout_accrual_3',
  pg_temp.partners_test_add_released_commission(
    repeat('0', 64),
    'USD',
    2000,
    now() - interval '2 days'
  )::text
);
set local request.jwt.claims =
  '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2","app_metadata":{"role":"admin","partners_release_manager":true}}';
set local role authenticated;
select public.admin_partners_payout_cycle_create(
  current_date - 28,
  current_date - 1,
  'USD',
  true,
  'CREATE:' || (current_date - 28)::text || ':'
    || (current_date - 1)::text || ':USD:LIVE',
  'P0 payout integration recovery offset cycle.'
);
reset role;
select extensions.is(
  (
    select cycle.item_count
    from affiliate_private.affiliate_payout_cycles cycle
    where cycle.period_start = current_date - 28
      and cycle.period_end = current_date - 1
      and cycle.currency = 'USD'
  ),
  0,
  'a recovery receivable prevents a second payout allocation'
);
select extensions.ok(
  affiliate_private.partners_account_payable_balance(
    (
      select state_value::uuid
      from partners_test_state
      where state_key = 'payout_account'
    ),
    'USD'
  ) = 0
  and (
    select coalesce(sum(
      case
        when posting.direction = 'debit' then posting.amount_minor
        else -posting.amount_minor
      end
    ), 0)::bigint
    from affiliate_private.affiliate_commission_postings posting
    join affiliate_private.affiliate_commission_entries entry
      on entry.id = posting.entry_id
    where entry.account_id = (
        select state_value::uuid
        from partners_test_state
        where state_key = 'payout_account'
      )
      and posting.currency = 'USD'
      and posting.ledger_account = 'partner_recovery_due'
  ) = 0
  and exists (
    select 1
    from affiliate_private.affiliate_commission_entries entry
    where entry.account_id = (
        select state_value::uuid
        from partners_test_state
        where state_key = 'payout_account'
      )
      and entry.currency = 'USD'
      and entry.entry_kind = 'recovery_offset'
      and entry.amount_minor = 2000
  ),
  'future commission atomically settles recovery debt before another payout'
);
select extensions.ok(
  (
    select count(*) = count(distinct item.allocation_entry_id)
    from affiliate_private.affiliate_payout_items item
    where item.allocation_entry_id is not null
  ),
  'each payout item owns at most one immutable allocation entry'
);

insert into affiliate_private.affiliate_currency_metadata (
  currency_code,
  exponent,
  status,
  configured_by_pseudonym,
  justification
)
values (
  'EUR',
  2,
  'active',
  repeat('a', 64),
  'P0 payout integration EUR metadata.'
);
set local request.jwt.claims =
  '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2","app_metadata":{"role":"admin"}}';
set local role authenticated;
select public.admin_partners_payout_route_set(
  'revolut',
  'revolut_manual',
  'US',
  'EUR',
  'active',
  'P0 payout pilot exact Revolut manual EUR corridor.'
);
reset role;
select extensions.ok(
  (
    select count(*) = 2
      and count(distinct config.provider) = 1
      and min(config.provider) = 'revolut'
    from affiliate_private.affiliate_payout_provider_configs config
    where config.status = 'active'
      and config.country_code = 'US'
      and config.currency in ('USD', 'EUR')
  ),
  'one active provider can serve several pilot payout corridors'
);

insert into partners_test_state (state_key, state_value)
select
  'revolut_binding_ticket_eur',
  authorized.result ->> 'binding_ticket'
from (
  select public.admin_partners_revolut_beneficiary_binding_authorize(
    (
      select state_value::uuid
      from partners_test_state
      where state_key = 'payout_account'
    ),
    'EUR',
    '22222222-2222-4222-8222-222222222222',
    null,
    'Bank •••• 1932',
    1,
    repeat('e', 64),
    'P0 payout integration tokenized EUR beneficiary authorization.'
  ) as result
) authorized;

reset role;
set local role service_role;
insert into partners_test_state (state_key, state_value)
select
  'revolut_binding_eur',
  proposed.result #>> '{binding,key}'
from (
  select public.partners_service_revolut_beneficiary_binding_propose(
    repeat('f', 64),
    repeat('1', 64),
    (
      select state_value
      from partners_test_state
      where state_key = 'revolut_binding_ticket_eur'
    )
  ) as result
) proposed;

reset role;
set local request.jwt.claims =
  '{"sub":"10000000-0000-4000-8000-000000000005","role":"authenticated","aal":"aal2","app_metadata":{"role":"admin"}}';
set local role authenticated;
select public.admin_partners_revolut_beneficiary_binding_verify(
  (
    select state_value
    from partners_test_state
    where state_key = 'revolut_binding_eur'
  ),
  'VERIFY:' || (
    select state_value
    from partners_test_state
    where state_key = 'revolut_binding_eur'
  ),
  'P0 payout integration independent EUR beneficiary verification.'
);

reset role;
insert into partners_test_state (state_key, state_value)
values (
  'payout_accrual_eur',
  pg_temp.partners_test_add_released_commission(
    encode(extensions.digest('p0-eur-renewal', 'sha256'), 'hex'),
    'EUR',
    2000,
    now() - interval '2 days'
  )::text
);
insert into partners_test_state (state_key, state_value)
values (
  'payout_accrual_4',
  pg_temp.partners_test_add_released_commission(
    encode(extensions.digest('p0-usd-after-recovery', 'sha256'), 'hex'),
    'USD',
    2000,
    now() - interval '2 days'
  )::text
);
update affiliate_private.affiliate_payout_profiles profile
set status = 'disabled', updated_at = now()
where profile.account_id = (
    select state_value::uuid
    from partners_test_state
    where state_key = 'payout_account'
  )
  and profile.currency = 'USD';
set local request.jwt.claims =
  '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2","app_metadata":{"role":"admin","partners_release_manager":true}}';
set local role authenticated;
select public.admin_partners_payout_cycle_create(
  current_date - 27,
  current_date - 1,
  'USD',
  false,
  'CREATE:' || (current_date - 27)::text || ':'
    || (current_date - 1)::text || ':USD:DRY',
  'P0 payout integration no-FX dry cycle.'
);
reset role;
select extensions.is(
  (
    select cycle.item_count
    from affiliate_private.affiliate_payout_cycles cycle
    where cycle.period_start = current_date - 27
      and cycle.period_end = current_date - 1
      and cycle.currency = 'USD'
  ),
  0,
  'an EUR destination never receives USD commission through an implicit FX fallback'
);

update affiliate_private.affiliate_payout_profiles profile
set
  status = 'active',
  revolut_binding_id = binding.id,
  revolut_binding_version = binding.binding_version,
  updated_at = now()
from affiliate_private.affiliate_revolut_beneficiary_bindings binding
where profile.account_id = (
    select state_value::uuid
    from partners_test_state
    where state_key = 'payout_account'
  )
  and profile.currency = 'USD'
  and binding.account_id = profile.account_id
  and binding.currency = profile.currency
  and binding.status = 'active';
select extensions.ok(
  position(
    'on conflict (account_id, currency)' in lower(pg_get_functiondef(
      'affiliate_private.partners_service_payout_profile_set(uuid,text,text,text,text,text)'::regprocedure
    ))
  ) > 0,
  'the payout profile RPC upserts one destination per account and currency'
);
select extensions.is(
  (
    select count(*)::bigint
    from affiliate_private.affiliate_payout_profiles profile
    where profile.account_id = (
      select state_value::uuid
      from partners_test_state
      where state_key = 'payout_account'
    )
  ),
  2::bigint,
  'payout profiles are unique per account and currency rather than per account'
);
set local role service_role;
select extensions.ok(
  jsonb_array_length(
    public.partners_service_payout_profile_get(
      '10000000-0000-4000-8000-000000000002'
    ) -> 'profiles'
  ) = 2
  and public.partners_service_payout_profile_get(
    '10000000-0000-4000-8000-000000000002'
  )::text !~* '(beneficiary|tok_test_)',
  'the payout profile API returns every masked currency destination and no token'
);
select extensions.ok(
  (
    public.partners_service_dashboard(
      '10000000-0000-4000-8000-000000000002',
      25,
      null,
      'all'
    ) #>> '{reporting,available}'
  ) = 'true'
  and (
    public.partners_service_dashboard(
      '10000000-0000-4000-8000-000000000002',
      25,
      null,
      'all'
    ) #>> '{reporting,reason}'
  ) = 'multiple_currencies'
  and jsonb_array_length(
    public.partners_service_dashboard(
      '10000000-0000-4000-8000-000000000002',
      25,
      null,
      'all'
    ) #> '{reporting,currencies}'
  ) = 2
  and not exists (
    select 1
    from jsonb_array_elements(
      public.partners_service_dashboard(
        '10000000-0000-4000-8000-000000000002',
        25,
        null,
        'all'
      ) #> '{reporting,currencies}'
    ) balance
    where balance ->> 'payout_destination_ready' <> 'true'
  ),
  'the member dashboard exposes authoritative balances and readiness by currency'
);

reset role;


reset role;

select extensions.throws_ok(
  $$
    delete from auth.users
    where id = '10000000-0000-4000-8000-000000000003'
  $$,
  '55000',
  'prepare Partners records before deleting the user',
  'auth deletion fails closed while direct Partners references remain'
);

set local role service_role;

select extensions.ok(
  public.partners_service_ops_alert_snapshot()
    ?& array['schema_version', 'workers', 'alerts', 'kyc_quota']::text[]
  and public.partners_service_ops_alert_snapshot()::text
    !~* '(email|user_id|account_id|token|secret)',
  'the service ops snapshot is complete and contains no identity material'
);

select extensions.is(
  public.partners_service_prepare_account_deletion(
    '10000000-0000-4000-8000-000000000004'
  ) ->> 'ready',
  'true',
  'service preparation atomically makes a referred user deletion-ready'
);
select extensions.is(
  public.partners_service_prepare_account_deletion(
    '10000000-0000-4000-8000-000000000004'
  ) ->> 'changed',
  'false',
  'account deletion preparation is idempotent before Auth deletion'
);

reset role;

delete from auth.users
where id = '10000000-0000-4000-8000-000000000004';

select extensions.ok(
  not exists (
    select 1
    from affiliate_private.affiliate_link_claims c
    where c.consumed_by_user_id =
      '10000000-0000-4000-8000-000000000004'
  )
  and not exists (
    select 1
    from affiliate_private.affiliate_attributions a
    where a.referred_user_id =
      '10000000-0000-4000-8000-000000000004'
  )
  and not exists (
    select 1
    from affiliate_private.affiliate_financial_facts f
    where f.referred_user_id =
      '10000000-0000-4000-8000-000000000004'
  ),
  'retained referral and finance rows contain no deleted Auth UUID'
);
select extensions.ok(
  (
    select count(*) = 8
      and count(distinct identity_pseudonym) = 1
      and bool_and(identity_pseudonym ~ '^[0-9a-f]{64}$')
    from (
      select c.consumed_by_pseudonym as identity_pseudonym
      from affiliate_private.affiliate_link_claims c
      where c.consumed_by_pseudonym =
        affiliate_private.partners_user_deletion_pseudonym(
          '10000000-0000-4000-8000-000000000004'
        )
      union all
      select a.referred_user_pseudonym
      from affiliate_private.affiliate_attributions a
      where a.referred_user_pseudonym =
        affiliate_private.partners_user_deletion_pseudonym(
          '10000000-0000-4000-8000-000000000004'
        )
      union all
      select f.referred_user_pseudonym
      from affiliate_private.affiliate_financial_facts f
      where f.referred_user_pseudonym =
        affiliate_private.partners_user_deletion_pseudonym(
          '10000000-0000-4000-8000-000000000004'
        )
    ) retained_identity
  ),
  'claims, attribution and finance retain one bounded lineage pseudonym'
);
select extensions.is(
  (
    select count(*)::bigint
    from affiliate_private.affiliate_financial_facts f
    where f.referred_user_pseudonym =
      affiliate_private.partners_user_deletion_pseudonym(
        '10000000-0000-4000-8000-000000000004'
      )
  ),
  6::bigint,
  'all immutable financial facts survive referred-user deletion'
);

set local role service_role;

select extensions.is(
  public.partners_service_prepare_account_deletion(
    '10000000-0000-4000-8000-000000000002'
  ) ->> 'state',
  'pending_financial_closure',
  'service preparation refuses account closure while balances remain'
);

reset role;

select pg_temp.partners_test_recover_commission(
  (
    select state_value::uuid
    from partners_test_state
    where state_key = 'payout_accrual_eur'
  ),
  2000
);
select pg_temp.partners_test_recover_commission(
  (
    select state_value::uuid
    from partners_test_state
    where state_key = 'payout_accrual_4'
  ),
  2000
);

set local role service_role;

select extensions.is(
  public.partners_service_prepare_account_deletion(
    '10000000-0000-4000-8000-000000000002'
  ) ->> 'accounts_closed',
  '1',
  'service preparation closes and minimizes the owned Partners account'
);

reset role;

delete from auth.users
where id = '10000000-0000-4000-8000-000000000002';

select extensions.ok(
  exists (
    select 1
    from affiliate_private.affiliate_accounts a
    where a.user_pseudonym =
      affiliate_private.partners_user_deletion_pseudonym(
        '10000000-0000-4000-8000-000000000002'
      )
      and a.user_id is null
      and a.status = 'closed'
      and a.program_version_id is null
      and a.country_policy_id is null
      and a.country_code is null
      and a.subdivision_code is null
      and a.verification_status = 'expired'
      and a.verification_reference is null
      and a.contract_status = 'expired'
      and exists (
        select 1
        from affiliate_private.affiliate_links l
        where l.account_id = a.id
          and l.status = 'revoked'
      )
      and exists (
        select 1
        from affiliate_private.affiliate_commission_entries e
        where e.account_id = a.id
      )
  ),
  'partner deletion retains ledger lineage on a closed minimized account'
);

update affiliate_private.affiliate_links link
set
  status = 'revoked',
  revoked_at = coalesce(link.revoked_at, now())
where link.status = 'active'
  and link.account_id = (
    select account.id
    from affiliate_private.affiliate_accounts account
    where account.user_id =
      '10000000-0000-4000-8000-000000000003'
  );
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
select
  'account',
  account.id::text,
  'legacy_kyc_binding_quarantined',
  'system',
  account.user_pseudonym,
  'Runtime fixture verifies the guarded legacy account re-verification transition.',
  jsonb_build_object('status', 'active'),
  jsonb_build_object('status', 'pending_verification')
from affiliate_private.affiliate_accounts account
where account.user_id =
  '10000000-0000-4000-8000-000000000003';
update affiliate_private.affiliate_accounts account
set
  status = 'held',
  verification_status = 'expired',
  verification_reference = null,
  age_verified = false,
  capacity_verified = false,
  updated_at = now()
where account.user_id =
  '10000000-0000-4000-8000-000000000003'
  and account.status = 'active';
update affiliate_private.affiliate_accounts account
set
  status = 'pending_verification',
  updated_at = now()
where account.user_id =
  '10000000-0000-4000-8000-000000000003'
  and account.status = 'held'
  and exists (
    select 1
    from affiliate_private.affiliate_events event
    where event.aggregate_type = 'account'
      and event.aggregate_key = account.id::text
      and event.action = 'legacy_kyc_binding_quarantined'
      and event.before_state ->> 'status' = 'active'
  );
select extensions.is(
  (
    select account.status
    from affiliate_private.affiliate_accounts account
    where account.user_id =
      '10000000-0000-4000-8000-000000000003'
  ),
  'pending_verification',
  'legacy active accounts traverse guarded held state into self-service re-verification'
);

select extensions.is(
  (
    select program.threshold_reference_currency
    from affiliate_private.affiliate_program_versions program
    where program.version_key = 'p0-test-v1'
  ),
  'USD',
  'the P0 programme persists USD as its commercial threshold reference'
);

select extensions.is(
  (
    select program.threshold_reference_minor
    from affiliate_private.affiliate_program_versions program
    where program.version_key = 'p0-test-v1'
  ),
  1000::bigint,
  'the P0 programme persists the worldwide 10 USD reference threshold'
);

select extensions.is(
  (
    select program.payout_fee_policy
    from affiliate_private.affiliate_program_versions program
    where program.version_key = 'p0-test-v1'
  ),
  'platform_absorbed',
  'the P0 programme makes payout fees a platform expense'
);

select extensions.ok(
  exists (
    select 1
    from pg_constraint constraint_row
    where constraint_row.conrelid =
      'affiliate_private.affiliate_program_versions'::regclass
      and constraint_row.conname =
        'affiliate_program_versions_threshold_reference_currency'
      and constraint_row.convalidated
      and pg_get_constraintdef(constraint_row.oid) like '%= ''USD''%'
  )
  and exists (
    select 1
    from pg_constraint constraint_row
    where constraint_row.conrelid =
      'affiliate_private.affiliate_program_versions'::regclass
      and constraint_row.conname =
        'affiliate_program_versions_threshold_reference_minor'
      and constraint_row.convalidated
      and pg_get_constraintdef(constraint_row.oid) like '%= 1000%'
  ),
  'every programme version is constrained to the worldwide USD 10 reference'
);

select extensions.ok(
  exists (
    select 1
    from pg_constraint constraint_row
    where constraint_row.conrelid =
      'affiliate_private.affiliate_payout_eligibility_snapshots'::regclass
      and constraint_row.conname =
        'affiliate_payout_eligibility_snapshots_result'
      and constraint_row.convalidated
      and pg_get_constraintdef(constraint_row.oid)
        like '%balance_minor >= settlement_threshold_minor%'
  ),
  'payout eligibility uses the exact settlement threshold, not shadow FX value'
);

select extensions.ok(
  exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid =
      'affiliate_private.affiliate_currency_metadata'::regclass
      and trigger_row.tgname =
        'affiliate_currency_metadata_identity_immutable'
      and not trigger_row.tgisinternal
  ),
  'currency identity and minor-unit exponent are immutable exact-money facts'
);

select extensions.is(
  affiliate_private.partners_fx_value_floor(12345, 100000, 91320),
  11273::bigint,
  'reference valuation uses conservative integer floor arithmetic'
);

select extensions.throws_ok(
  $$
    select affiliate_private.partners_fx_value_floor(-1, 100000, 91320)
  $$,
  '22023',
  'invalid exact-money FX valuation input',
  'negative FX valuation inputs fail closed'
);

select extensions.ok(
  (
    select count(*) = 3
    from pg_class relation
    join pg_namespace namespace
      on namespace.oid = relation.relnamespace
    where namespace.nspname = 'affiliate_private'
      and relation.relname in (
        'affiliate_fx_rate_snapshots',
        'affiliate_payout_eligibility_snapshots',
        'affiliate_payout_cost_facts'
      )
      and relation.relrowsecurity
  ),
  'every FX and payout-cost evidence table has RLS enabled'
);

select extensions.is(
  (
    select count(*)::bigint
    from pg_trigger trigger_row
    where trigger_row.tgrelid in (
      'affiliate_private.affiliate_fx_rate_snapshots'::regclass,
      'affiliate_private.affiliate_payout_eligibility_snapshots'::regclass,
      'affiliate_private.affiliate_payout_cost_facts'::regclass
    )
      and trigger_row.tgname in (
        'affiliate_fx_rate_snapshots_append_only',
        'affiliate_payout_eligibility_snapshots_append_only',
        'affiliate_payout_cost_facts_append_only'
      )
      and not trigger_row.tgisinternal
  ),
  3::bigint,
  'FX, eligibility and payout-cost evidence is append-only'
);

select extensions.ok(
  not has_table_privilege(
    'authenticated',
    'affiliate_private.affiliate_fx_rate_snapshots',
    'SELECT'
  )
  and not has_table_privilege(
    'authenticated',
    'affiliate_private.affiliate_payout_eligibility_snapshots',
    'SELECT'
  )
  and not has_table_privilege(
    'authenticated',
    'affiliate_private.affiliate_payout_cost_facts',
    'SELECT'
  ),
  'authenticated clients cannot read private FX or payout-cost evidence'
);

select extensions.ok(
  to_regprocedure(
    'public.admin_partners_fx_rate_record(text,bigint,text,bigint,text,timestamptz,timestamptz,text,text,text)'
  ) is not null
  and to_regprocedure(
    'public.admin_partners_payout_eligibility_record(uuid,text,text,timestamptz,text,text)'
  ) is not null
  and to_regprocedure(
    'public.admin_partners_payout_cost_record(text,text,text,text,bigint,text,text,bigint,uuid,text,text,timestamptz,text,text)'
  ) is not null,
  'the audited FX, eligibility and payout-cost RPC surface is installed'
);

select extensions.ok(
  has_function_privilege(
    'authenticated',
    'public.admin_partners_fx_rate_record(text,bigint,text,bigint,text,timestamptz,timestamptz,text,text,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'authenticated',
    'public.admin_partners_payout_eligibility_record(uuid,text,text,timestamptz,text,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'authenticated',
    'public.admin_partners_payout_cost_record(text,text,text,text,bigint,text,text,bigint,uuid,text,text,timestamptz,text,text)',
    'EXECUTE'
  ),
  'authenticated Finance operators can call only the guarded public wrappers'
);

select extensions.ok(
  exists (
    select 1
    from pg_constraint constraint_row
    where constraint_row.conrelid =
      'affiliate_private.affiliate_payout_cost_facts'::regclass
      and constraint_row.conname =
        'affiliate_payout_cost_facts_platform_only'
      and constraint_row.contype = 'c'
      and constraint_row.convalidated
      and pg_get_constraintdef(constraint_row.oid)
        like '%borne_by = ''platform''%'
  ),
  'payout costs can only be borne by Norva and never by the partner'
);

-- Runtime FX/eligibility regression coverage. The surrounding transaction and
-- transaction-stable now() keep every observation deterministic and isolated.
reset role;

select extensions.throws_ok(
  $$
    update affiliate_private.affiliate_currency_metadata
    set exponent = 3
    where currency_code = 'EUR'
  $$,
  '55000',
  'currency code and minor-unit exponent are immutable; add a new versioned currency contract',
  'a recorded currency exponent cannot be reinterpreted in place'
);

insert into auth.users (
  id,
  instance_id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
values (
  '10000000-0000-4000-8000-000000000006',
  '00000000-0000-0000-0000-000000000000',
  'authenticated',
  'authenticated',
  'partners-fx-runtime@example.invalid',
  '',
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb,
  now(),
  now()
);

insert into affiliate_private.affiliate_accounts (
  user_id,
  user_pseudonym,
  status,
  program_version_id,
  country_policy_id,
  country_code
)
select
  '10000000-0000-4000-8000-000000000006',
  repeat('f', 64),
  'pending_verification',
  program.id,
  (
    select policy.id
    from affiliate_private.affiliate_country_policies policy
    where policy.program_version_id = program.id
      and policy.country_code = 'US'
      and policy.subdivision_code is null
    order by policy.effective_from desc
    limit 1
  ),
  'US'
from affiliate_private.affiliate_program_versions program
where program.version_key = 'p0-test-v1';

insert into partners_test_state (state_key, state_value)
select 'fx_runtime_account', account.id::text
from affiliate_private.affiliate_accounts account
where account.user_id = '10000000-0000-4000-8000-000000000006';

set local request.jwt.claims =
  '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2","app_metadata":{"role":"admin"}}';
set local role authenticated;

select public.admin_partners_fx_rate_record(
  'EUR',
  100,
  'USD',
  110,
  'finance_manual',
  now() - interval '1 minute',
  now() + interval '30 minutes',
  repeat('a', 64),
  'fx.pgtap.valid.0001',
  'pgTAP current EUR to USD evidence.'
);
select public.admin_partners_fx_rate_record(
  'EUR',
  100,
  'USD',
  110,
  'finance_manual',
  now() - interval '20 minutes',
  now() - interval '10 minutes',
  repeat('b', 64),
  'fx.pgtap.stale.0001',
  'pgTAP stale EUR to USD evidence.'
);
select public.admin_partners_fx_rate_record(
  'USD',
  110,
  'EUR',
  100,
  'finance_manual',
  now() - interval '1 minute',
  now() + interval '30 minutes',
  repeat('c', 64),
  'fx.pgtap.reverse.0001',
  'pgTAP current reverse USD to EUR evidence.'
);

reset role;
insert into partners_test_state (state_key, state_value)
select 'fx_runtime_rate_valid', rate.snapshot_key
from affiliate_private.affiliate_fx_rate_snapshots rate
where rate.idempotency_key = 'fx.pgtap.valid.0001';
insert into partners_test_state (state_key, state_value)
select 'fx_runtime_rate_stale', rate.snapshot_key
from affiliate_private.affiliate_fx_rate_snapshots rate
where rate.idempotency_key = 'fx.pgtap.stale.0001';
insert into partners_test_state (state_key, state_value)
select 'fx_runtime_rate_reverse', rate.snapshot_key
from affiliate_private.affiliate_fx_rate_snapshots rate
where rate.idempotency_key = 'fx.pgtap.reverse.0001';
set local role authenticated;

select extensions.is(
  public.admin_partners_payout_eligibility_record(
    (
      select state_value::uuid
      from partners_test_state
      where state_key = 'fx_runtime_account'
    ),
    'USD',
    null,
    now(),
    'eligibility.pgtap.same.0001',
    'pgTAP same-currency eligibility evidence.'
  ) ->> 'replayed',
  'false',
  'same-currency eligibility records without FX evidence'
);

select extensions.is(
  public.admin_partners_payout_eligibility_record(
    (
      select state_value::uuid
      from partners_test_state
      where state_key = 'fx_runtime_account'
    ),
    'EUR',
    (
      select state_value
      from partners_test_state
      where state_key = 'fx_runtime_rate_valid'
    ),
    now(),
    'eligibility.pgtap.cross.0001',
    'pgTAP cross-currency eligibility evidence.'
  ) #>> '{snapshot,settlement_threshold_minor}',
  '900',
  'cross-currency eligibility preserves the local settlement threshold'
);

select extensions.throws_ok(
  $$
    select public.admin_partners_payout_eligibility_record(
      (
        select state_value::uuid
        from partners_test_state
        where state_key = 'fx_runtime_account'
      ),
      'EUR',
      (
        select state_value
        from partners_test_state
        where state_key = 'fx_runtime_rate_stale'
      ),
      now(),
      'eligibility.pgtap.stale.0001',
      'pgTAP rejects stale eligibility FX evidence.'
    )
  $$,
  'P0001',
  'FX evidence is unavailable or stale',
  'stale FX evidence cannot authorize payout eligibility'
);

select extensions.throws_ok(
  $$
    select public.admin_partners_payout_eligibility_record(
      (
        select state_value::uuid
        from partners_test_state
        where state_key = 'fx_runtime_account'
      ),
      'EUR',
      (
        select state_value
        from partners_test_state
        where state_key = 'fx_runtime_rate_reverse'
      ),
      now(),
      'eligibility.pgtap.reverse.0001',
      'pgTAP rejects reversed eligibility FX evidence.'
    )
  $$,
  'P0001',
  'FX evidence is unavailable or stale',
  'a reversed FX pair cannot authorize payout eligibility'
);

select extensions.throws_ok(
  $$
    select public.admin_partners_payout_cost_record(
      'revolut',
      'revolut_manual',
      'US',
      'EUR',
      1000,
      'fx_fee',
      'USD',
      500,
      null,
      (
        select state_value
        from partners_test_state
        where state_key = 'fx_runtime_rate_stale'
      ),
      repeat('d', 64),
      now(),
      'cost.pgtap.stale.0001',
      'pgTAP rejects stale payout-cost FX evidence.'
    )
  $$,
  'P0001',
  'FX evidence is unavailable, stale or mismatched',
  'stale FX evidence cannot support a payout cost fact'
);

select extensions.throws_ok(
  $$
    select public.admin_partners_payout_cost_record(
      'revolut',
      'revolut_manual',
      'US',
      'EUR',
      1000,
      'fx_fee',
      'USD',
      500,
      null,
      (
        select state_value
        from partners_test_state
        where state_key = 'fx_runtime_rate_reverse'
      ),
      repeat('e', 64),
      now(),
      'cost.pgtap.reverse.0001',
      'pgTAP rejects reversed payout-cost FX evidence.'
    )
  $$,
  'P0001',
  'FX evidence is unavailable, stale or mismatched',
  'a reversed FX pair cannot support a payout cost fact'
);

select extensions.throws_ok(
  $$
    select public.admin_partners_payout_cost_record(
      'revolut',
      'revolut_manual',
      'US',
      'USD',
      1000,
      'fx_fee',
      'USD',
      500,
      null,
      null,
      repeat('f', 64),
      now(),
      'cost.pgtap.same-fx.0001',
      'pgTAP rejects a same-currency FX fee.'
    )
  $$,
  'P0001',
  'FX payout costs require exact FX evidence',
  'same-currency costs cannot be classified as FX fees'
);

select extensions.is(
  public.admin_partners_payout_cost_record(
    'revolut',
    'revolut_manual',
    'US',
    'EUR',
    1000,
    'fx_fee',
    'USD',
    500,
    null,
    (
      select state_value
      from partners_test_state
      where state_key = 'fx_runtime_rate_valid'
    ),
    repeat('0', 64),
    now(),
    'cost.pgtap.valid.0001',
    'pgTAP valid payout-cost FX evidence.'
  ) #>> '{cost,borne_by}',
  'platform',
  'a valid FX payout cost remains a Norva platform expense'
);

reset role;
insert into affiliate_private.affiliate_commission_entries (
  id,
  account_id,
  entry_kind,
  currency,
  currency_exponent,
  amount_minor
)
select
  '91000000-0000-4000-8000-000000000001',
  account.id,
  'payout_allocation',
  'USD',
  2,
  100
from affiliate_private.affiliate_accounts account
where account.user_id = '10000000-0000-4000-8000-000000000006';
insert into affiliate_private.affiliate_commission_postings (
  entry_id,
  ledger_account,
  direction,
  amount_minor,
  currency
)
values
  (
    '91000000-0000-4000-8000-000000000001',
    'partner_commission_available',
    'debit',
    100,
    'USD'
  ),
  (
    '91000000-0000-4000-8000-000000000001',
    'partner_payout_clearing',
    'credit',
    100,
    'USD'
  );

set local role authenticated;
select extensions.is(
  public.admin_partners_payout_eligibility_record(
    (
      select state_value::uuid
      from partners_test_state
      where state_key = 'fx_runtime_account'
    ),
    'USD',
    null,
    now(),
    'eligibility.pgtap.same.0001',
    'pgTAP same-currency eligibility evidence.'
  ) ->> 'replayed',
  'true',
  'an identical eligibility retry replays after later ledger evolution'
);
reset role;

-- P0 operator-read and AAL2 regression matrix.
set local request.jwt.claims =
  '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"role":"admin","partners_capability_admin":true}}';
set local role authenticated;

select extensions.throws_ok(
  $$
    select public.admin_partners_capability_set(
      '10000000-0000-4000-8000-000000000003',
      'risk',
      true,
      'AAL1 capability mutation regression probe.'
    )
  $$,
  '42501',
  'Partners capability mutation requires AAL2',
  'capability delegation fails closed without an AAL2 session'
);

reset role;
insert into affiliate_private.affiliate_admin_capabilities (
  user_id,
  capability,
  enabled,
  granted_by_pseudonym,
  justification,
  updated_at
)
values (
  '10000000-0000-4000-8000-000000000003',
  'risk',
  true,
  repeat('9', 64),
  'pgTAP risk-only operator read fixture.',
  now()
)
on conflict (user_id, capability) do update
set
  enabled = excluded.enabled,
  granted_by_pseudonym = excluded.granted_by_pseudonym,
  justification = excluded.justification,
  updated_at = excluded.updated_at;

set local request.jwt.claims =
  '{"sub":"10000000-0000-4000-8000-000000000003","role":"authenticated","app_metadata":{"role":"admin"}}';
set local role authenticated;

select extensions.is(
  public.admin_partners_overview() ->> 'schema_version',
  '1',
  'a Risk-only operator can read the shared sanitized overview'
);
select extensions.is(
  public.admin_partners_configuration() ->> 'schema_version',
  '1',
  'a Risk-only operator can read shared Partners configuration'
);

reset role;
set local request.jwt.claims =
  '{"sub":"10000000-0000-4000-8000-000000000005","role":"authenticated","app_metadata":{"role":"admin"}}';
set local role authenticated;

select extensions.is(
  public.admin_partners_overview() ->> 'schema_version',
  '1',
  'a Finance-only operator can read the shared sanitized overview'
);
select extensions.is(
  public.admin_partners_configuration() ->> 'schema_version',
  '1',
  'a Finance-only operator can read shared Partners configuration'
);

reset role;
set local request.jwt.claims =
  '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"role":"admin"}}';
set local role authenticated;

select extensions.throws_ok(
  $$
    select public.admin_partners_program_create(
      'p0-aal1-denied',
      '{"USD":1000}'::jsonb,
      'partners-terms-p0',
      'partners-disclosure-p0',
      now() + interval '10 minutes',
      'AAL1 program creation regression probe.'
    )
  $$,
  '42501',
  'Partners program mutation requires AAL2',
  'programme creation fails closed without an AAL2 session'
);
select extensions.throws_ok(
  $$
    select public.admin_partners_program_activate(
      'p0-test-v1',
      'ACTIVATE:p0-test-v1',
      'AAL1 program activation regression probe.'
    )
  $$,
  '42501',
  'Partners program mutation requires AAL2',
  'programme activation fails closed without an AAL2 session'
);

set local request.jwt.claims =
  '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2","app_metadata":{"role":"admin"}}';
select extensions.is(
  public.admin_partners_program_create(
    'p0-aal2-wrapper',
    '{"USD":1000}'::jsonb,
    'partners-terms-p0',
    'partners-disclosure-p0',
    now() + interval '10 minutes',
    'AAL2 program creation delegation probe.'
  ) ->> 'action',
  'program_draft_created',
  'an AAL2 programme mutation delegates to the versioned implementation'
);

reset role;
select extensions.ok(
  position(
    'live payout cycle creation requires AAL2' in pg_get_functiondef(
      'affiliate_private.guard_revolut_live_payout_cycle()'::regprocedure
    )
  ) > 0
  and position(
    'live payout cycle approval requires AAL2' in pg_get_functiondef(
      'affiliate_private.guard_revolut_live_payout_cycle()'::regprocedure
    )
  ) > 0
  and exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid =
        'affiliate_private.affiliate_payout_cycles'::regclass
      and trigger_row.tgname =
        'affiliate_payout_cycles_live_promotion_aal2'
      and not trigger_row.tgisinternal
  ),
  'all live create, promote and approve boundaries require AAL2'
);

set local request.jwt.claims =
  '{"sub":"10000000-0000-4000-8000-000000000005","role":"authenticated","app_metadata":{"role":"admin"}}';
set local role authenticated;

select extensions.throws_ok(
  format(
    'select public.admin_partners_payout_cycle_create(%L,%L,%L,true,%L,%L)',
    current_date - 140,
    current_date - 111,
    'USD',
    'CREATE:' || (current_date - 140)::text || ':'
      || (current_date - 111)::text || ':USD:LIVE',
    'AAL1 live payout creation regression probe.'
  ),
  '42501',
  'live payout cycle creation requires AAL2',
  'Finance cannot create a live payout cycle in AAL1'
);
select extensions.is(
  public.admin_partners_payout_cycle_create(
    current_date - 100,
    current_date - 71,
    'USD',
    false,
    'CREATE:' || (current_date - 100)::text || ':'
      || (current_date - 71)::text || ':USD:DRY',
    'AAL1 dry payout cycle regression probe.'
  ) ->> 'action',
  'payout_cycle_created',
  'Finance can still create a dry-run payout cycle in AAL1'
);

reset role;
insert into partners_test_state (state_key, state_value)
select 'payout_aal2_dry_cycle', cycle.cycle_key
from affiliate_private.affiliate_payout_cycles cycle
where cycle.period_start = current_date - 100
  and cycle.period_end = current_date - 71
  and cycle.currency = 'USD'
on conflict (state_key) do update
set state_value = excluded.state_value;

set local role authenticated;
select extensions.is(
  public.admin_partners_payout_cycle_approve(
    (
      select state_value
      from partners_test_state
      where state_key = 'payout_aal2_dry_cycle'
    ),
    'APPROVE:' || (
      select state_value
      from partners_test_state
      where state_key = 'payout_aal2_dry_cycle'
    ),
    'AAL1 dry payout approval regression probe.'
  ) ->> 'action',
  'payout_cycle_approved',
  'Finance can still approve a dry-run payout cycle in AAL1'
);
select extensions.throws_ok(
  format(
    'select public.admin_partners_payout_cycle_create(%L,%L,%L,true,%L,%L)',
    current_date - 100,
    current_date - 71,
    'USD',
    'CREATE:' || (current_date - 100)::text || ':'
      || (current_date - 71)::text || ':USD:LIVE',
    'AAL1 live promotion regression probe.'
  ),
  '42501',
  'live payout cycle promotion requires AAL2',
  'Finance cannot promote a dry payout cycle to live in AAL1'
);

reset role;

select * from extensions.finish();

rollback;
