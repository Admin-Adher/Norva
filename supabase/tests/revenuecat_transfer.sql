begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(53);

select extensions.ok(
  to_regclass('public.cloud_revenuecat_transfer_events') is not null,
  'the dedicated RevenueCat TRANSFER inbox exists'
);
select extensions.ok(
  not has_table_privilege(
    'anon',
    'public.cloud_revenuecat_transfer_events',
    'SELECT'
  ),
  'anon cannot read transfer identities or state'
);
select extensions.ok(
  not has_function_privilege(
    'anon',
    'public.record_revenuecat_entitlement_transfer(text,timestamp with time zone,text,text,uuid,uuid[],integer,integer,text,text,boolean,boolean)',
    'EXECUTE'
  ),
  'anon cannot record transfer deliveries'
);
select extensions.ok(
  not has_function_privilege(
    'authenticated',
    'public.apply_revenuecat_entitlement_transfer(text,timestamp with time zone,text,text,uuid,uuid[],integer,integer,text,text,jsonb)',
    'EXECUTE'
  ),
  'authenticated clients cannot apply transfer projections'
);
select extensions.ok(
  has_function_privilege(
    'service_role',
    'public.apply_revenuecat_entitlement_transfer(text,timestamp with time zone,text,text,uuid,uuid[],integer,integer,text,text,jsonb)',
    'EXECUTE'
  ),
  'service_role can apply transfer projections'
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
select
  user_id,
  '00000000-0000-0000-0000-000000000000'::uuid,
  'authenticated',
  'authenticated',
  email,
  '',
  clock_timestamp(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb,
  clock_timestamp(),
  clock_timestamp()
from (
  values
    ('30000000-0000-4000-8000-000000000001'::uuid, 'rc-destination-newer@example.invalid'),
    ('30000000-0000-4000-8000-000000000002'::uuid, 'rc-source-older@example.invalid'),
    ('30000000-0000-4000-8000-000000000003'::uuid, 'rc-destination-partial@example.invalid'),
    ('30000000-0000-4000-8000-000000000004'::uuid, 'rc-source-newer@example.invalid'),
    ('30000000-0000-4000-8000-000000000005'::uuid, 'rc-destination-counts@example.invalid'),
    ('30000000-0000-4000-8000-000000000006'::uuid, 'rc-source-absent@example.invalid'),
    ('30000000-0000-4000-8000-000000000007'::uuid, 'rc-source-hard@example.invalid'),
    ('30000000-0000-4000-8000-000000000008'::uuid, 'rc-source-cross@example.invalid'),
    ('30000000-0000-4000-8000-000000000009'::uuid, 'rc-destination-causal@example.invalid'),
    ('30000000-0000-4000-8000-000000000010'::uuid, 'rc-source-repurchased@example.invalid'),
    ('30000000-0000-4000-8000-000000000012'::uuid, 'rc-source-expired@example.invalid')
) fixtures(user_id, email);

create temporary table rc_clock as
select
  clock_timestamp() - interval '1 hour' as event_a,
  clock_timestamp() - interval '50 minutes' as event_b,
  clock_timestamp() - interval '40 minutes' as event_c,
  clock_timestamp() + interval '30 days' as period_end;

insert into public.cloud_entitlement_projection (
  user_id,
  provider,
  provider_customer_id,
  plan_code,
  status,
  limits,
  current_period_end,
  last_verified_at,
  last_event_at,
  mrr_cents,
  billing_currency,
  billing_product_id,
  bill_period,
  billing_terms_source
)
select
  '30000000-0000-4000-8000-000000000001'::uuid,
  'google_play',
  '30000000-0000-4000-8000-000000000001',
  'plus',
  'active',
  '{}'::jsonb,
  period_end + interval '1 day',
  clock_timestamp(),
  event_a + interval '10 minutes',
  999,
  'EUR',
  'norva_plus:monthly',
  'monthly',
  'revenuecat_webhook'
from rc_clock
union all
select
  '30000000-0000-4000-8000-000000000002'::uuid,
  'google_play',
  '30000000-0000-4000-8000-000000000002',
  'plus',
  'active',
  '{}'::jsonb,
  period_end,
  clock_timestamp(),
  event_a - interval '10 minutes',
  499,
  'EUR',
  'norva_plus:monthly',
  'monthly',
  'revenuecat_webhook'
from rc_clock;

insert into public.cloud_revenuecat_projection_cursor (
  user_id,
  last_event_at,
  last_event_id,
  last_projection_applied
)
select
  '30000000-0000-4000-8000-000000000001',
  event_a + interval '10 minutes',
  'newer-destination-event',
  true
from rc_clock;

create temporary table rc_result_a as
select result.*
from rc_clock fixture
cross join lateral public.apply_revenuecat_entitlement_transfer(
  'rc-transfer-pgtap-a',
  fixture.event_a,
  repeat('a', 64),
  repeat('b', 64),
  '30000000-0000-4000-8000-000000000001',
  array['30000000-0000-4000-8000-000000000002'::uuid],
  1,
  1,
  'production',
  'play_store',
  jsonb_build_object(
    'user_id', '30000000-0000-4000-8000-000000000001',
    'provider', 'google_play',
    'provider_customer_id', '30000000-0000-4000-8000-000000000001',
    'plan_code', 'plus',
    'status', 'active',
    'limits', '{}'::jsonb,
    'current_period_end', fixture.period_end,
    'last_verified_at', clock_timestamp(),
    'last_event_at', fixture.event_a,
    'fail_open_until', null,
    'mrr_cents', null,
    'billing_currency', null,
    'billing_product_id', 'norva_plus:monthly',
    'billing_package_id', null,
    'bill_period', 'monthly',
    'billing_terms_source', 'revenuecat_transfer_refetch'
  )
) result;

select extensions.is(
  (select terminal from rc_result_a),
  true,
  'a causally newer equivalent destination is terminal'
);
select extensions.is(
  (select applied from rc_result_a),
  true,
  'the newer equivalent destination confirms the transfer authority'
);
select extensions.is(
  (select disposition from rc_result_a),
  'applied_destination_already_current',
  'the newer destination has an explicit disposition'
);
select extensions.is(
  (select source_expired_count from rc_result_a),
  1,
  'an older same-rail source is expired'
);
select extensions.is(
  (
    select last_event_id
    from public.cloud_revenuecat_projection_cursor
    where user_id = '30000000-0000-4000-8000-000000000001'
  ),
  'newer-destination-event',
  'the destination causal cursor is not backdated'
);
select extensions.ok(
  (
    select mrr_cents is null and billing_currency is null
    from public.cloud_entitlement_projection
    where user_id = '30000000-0000-4000-8000-000000000001'
  ),
  'commercial amounts are cleared because CustomerInfo proves no money'
);
select extensions.is(
  (
    select status
    from public.cloud_entitlement_projection
    where user_id = '30000000-0000-4000-8000-000000000002'
  ),
  'expired',
  'the source projection is terminally expired'
);
select extensions.is(
  (
    select partner_status
    from public.cloud_revenuecat_transfer_events
    where event_id = 'rc-transfer-pgtap-a'
  ),
  'pending',
  'Partners is queued only after entitlement application commits'
);

create temporary table rc_result_a_retry as
select result.*
from rc_clock fixture
cross join lateral public.apply_revenuecat_entitlement_transfer(
  'rc-transfer-pgtap-a',
  fixture.event_a,
  repeat('a', 64),
  repeat('b', 64),
  '30000000-0000-4000-8000-000000000001',
  array['30000000-0000-4000-8000-000000000002'::uuid],
  1,
  1,
  'production',
  'play_store',
  jsonb_build_object(
    'user_id', '30000000-0000-4000-8000-000000000001',
    'provider', 'google_play',
    'provider_customer_id', '30000000-0000-4000-8000-000000000001',
    'plan_code', 'plus',
    'status', 'active',
    'limits', '{}'::jsonb,
    'current_period_end', fixture.period_end,
    'last_verified_at', clock_timestamp(),
    'last_event_at', fixture.event_a,
    'fail_open_until', null,
    'mrr_cents', null,
    'billing_currency', null,
    'billing_product_id', 'norva_plus:monthly',
    'billing_package_id', null,
    'bill_period', 'monthly',
    'billing_terms_source', 'revenuecat_transfer_refetch'
  )
) result;

select extensions.is(
  (select terminal from rc_result_a_retry),
  true,
  'an exact applied retry reproduces the terminal result'
);
select extensions.is(
  (select disposition from rc_result_a_retry),
  'applied_destination_already_current',
  'an exact applied retry preserves the terminal reason'
);
select extensions.is(
  (
    select delivery_count
    from public.cloud_revenuecat_transfer_events
    where event_id = 'rc-transfer-pgtap-a'
  ),
  1,
  'an internal apply retry does not masquerade as another webhook delivery'
);

select *
from public.record_revenuecat_entitlement_transfer(
  'rc-transfer-pgtap-a',
  (select event_a from rc_clock),
  repeat('a', 64),
  'later_retry_must_not_overwrite',
  '30000000-0000-4000-8000-000000000001',
  array['30000000-0000-4000-8000-000000000002'::uuid],
  1,
  1,
  'production',
  'play_store',
  true
);

select extensions.is(
  (
    select reason
    from public.cloud_revenuecat_transfer_events
    where event_id = 'rc-transfer-pgtap-a'
  ),
  'applied_destination_already_current',
  'a duplicate delivery cannot overwrite a terminal reason'
);
select extensions.is(
  (
    select delivery_count
    from public.cloud_revenuecat_transfer_events
    where event_id = 'rc-transfer-pgtap-a'
  ),
  2,
  'terminal duplicate delivery accounting is idempotent'
);

insert into public.cloud_entitlement_projection (
  user_id,
  provider,
  plan_code,
  status,
  limits,
  current_period_end,
  last_verified_at,
  last_event_at
)
select
  '30000000-0000-4000-8000-000000000004',
  'google_play',
  'plus',
  'active',
  '{}'::jsonb,
  period_end,
  clock_timestamp(),
  event_b
from rc_clock;

create temporary table rc_result_b as
select result.*
from rc_clock fixture
cross join lateral public.apply_revenuecat_entitlement_transfer(
  'rc-transfer-pgtap-b',
  fixture.event_b,
  repeat('c', 64),
  repeat('d', 64),
  '30000000-0000-4000-8000-000000000003',
  array['30000000-0000-4000-8000-000000000004'::uuid],
  1,
  1,
  'production',
  'play_store',
  jsonb_build_object(
    'user_id', '30000000-0000-4000-8000-000000000003',
    'provider', 'google_play',
    'provider_customer_id', '30000000-0000-4000-8000-000000000003',
    'plan_code', 'plus',
    'status', 'active',
    'limits', '{}'::jsonb,
    'current_period_end', fixture.period_end,
    'last_verified_at', clock_timestamp(),
    'last_event_at', fixture.event_b,
    'fail_open_until', null,
    'mrr_cents', null,
    'billing_currency', null,
    'billing_product_id', 'norva_plus:monthly',
    'billing_package_id', null,
    'bill_period', 'monthly',
    'billing_terms_source', 'revenuecat_transfer_refetch'
  )
) result;

select extensions.is(
  (select terminal from rc_result_b),
  false,
  'an equal-timestamp source keeps the transfer retryable'
);
select extensions.is(
  (select source_newer_pending_count from rc_result_b),
  1,
  'the legacy pending counter remains compatible for equal timestamps'
);
select extensions.is(
  (select source_equal_pending_count from rc_result_b),
  1,
  'equal-timestamp sources are counted explicitly'
);
select extensions.is(
  (
    select status
    from public.cloud_revenuecat_transfer_events
    where event_id = 'rc-transfer-pgtap-b'
  ),
  'partial',
  'the retryable source conflict is persisted as partial'
);
select extensions.is(
  (
    select count(*)::integer
    from public.cloud_entitlement_events
    where provider = 'revenuecat'
      and provider_event_id = 'rc-transfer-pgtap-b'
  ),
  0,
  'a partial transfer has no generic terminal event marker'
);

create temporary table rc_result_b_replay as
select result.*
from rc_clock fixture
cross join lateral public.apply_revenuecat_entitlement_transfer(
  'rc-transfer-pgtap-b',
  fixture.event_b,
  repeat('c', 64),
  repeat('d', 64),
  '30000000-0000-4000-8000-000000000003',
  array['30000000-0000-4000-8000-000000000004'::uuid],
  1,
  1,
  'production',
  'play_store',
  jsonb_build_object(
    'user_id', '30000000-0000-4000-8000-000000000003',
    'provider', 'google_play',
    'provider_customer_id', '30000000-0000-4000-8000-000000000003',
    'plan_code', 'plus',
    'status', 'active',
    'limits', '{}'::jsonb,
    'current_period_end', fixture.period_end,
    'last_verified_at', clock_timestamp(),
    'last_event_at', fixture.event_b,
    'fail_open_until', null,
    'mrr_cents', null,
    'billing_currency', null,
    'billing_product_id', 'norva_plus:monthly',
    'billing_package_id', null,
    'bill_period', 'monthly',
    'billing_terms_source', 'revenuecat_transfer_refetch'
  )
) result;
select extensions.is(
  (select disposition from rc_result_b_replay),
  'source_equal_timestamp_requires_reconciliation',
  'replay recognizes its destination cursor and resumes source reconciliation'
);

update public.cloud_revenuecat_transfer_events
set next_retry_at = clock_timestamp() - interval '1 second'
where event_id = 'rc-transfer-pgtap-b';

create temporary table rc_lease_b as
select public.revenuecat_transfer_retry_jobs_lease(
  'revenuecat-transfer-worker:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  repeat('e', 64),
  1,
  90
) as envelope;

select extensions.is(
  (select jsonb_array_length(envelope->'jobs') from rc_lease_b),
  1,
  'the due partial transfer is leased once'
);
select extensions.throws_ok(
  $$
    select public.revenuecat_transfer_retry_job_complete(
      'rc-transfer-pgtap-b',
      'revenuecat-transfer-worker:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      repeat('0', 64),
      'authority_fetch_unavailable',
      null
    )
  $$,
  'P0001',
  'revenuecat_transfer_lease_lost',
  'a mismatched lease token cannot complete another worker job'
);

select public.revenuecat_transfer_retry_job_defer(
  'rc-transfer-pgtap-b',
  'revenuecat-transfer-worker:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  repeat('e', 64),
  'authority_batch_deferred',
  120
);

select extensions.ok(
  (
    select attempt_count = 0
      and next_retry_at >= clock_timestamp() + interval '100 seconds'
      and lease_until is null
    from public.cloud_revenuecat_transfer_events
    where event_id = 'rc-transfer-pgtap-b'
  ),
  'deferring an unattempted job honors Retry-After without consuming an attempt'
);

update public.cloud_revenuecat_transfer_events
set next_retry_at = clock_timestamp() - interval '1 second'
where event_id = 'rc-transfer-pgtap-b';

select public.revenuecat_transfer_retry_jobs_lease(
  'revenuecat-transfer-worker:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  repeat('e', 64),
  1,
  90
);

select public.revenuecat_transfer_retry_job_complete(
  'rc-transfer-pgtap-b',
  'revenuecat-transfer-worker:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  repeat('e', 64),
  'authority_fetch_unavailable'
);

select extensions.ok(
  (
    select status = 'partial'
      and attempt_count = 1
      and next_retry_at > clock_timestamp()
      and lease_until is null
    from public.cloud_revenuecat_transfer_events
    where event_id = 'rc-transfer-pgtap-b'
  ),
  'retry completion applies bounded backoff and releases the lease'
);

update public.cloud_revenuecat_transfer_events
set attempt_count = 11,
    next_retry_at = clock_timestamp() - interval '1 second'
where event_id = 'rc-transfer-pgtap-b';
select public.revenuecat_transfer_retry_jobs_lease(
  'revenuecat-transfer-worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  repeat('f', 64),
  1,
  90
);
create temporary table rc_live_lease_sweep as
select public.revenuecat_transfer_retry_jobs_lease(
  'revenuecat-transfer-worker:dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  repeat('5', 64),
  1,
  90
) as envelope;
select extensions.is(
  (
    select (envelope->>'dead_letter_moved')::integer
    from rc_live_lease_sweep
  ),
  0,
  'an active twelfth-attempt lease is never swept from another worker'
);
select public.revenuecat_transfer_retry_job_complete(
  'rc-transfer-pgtap-b',
  'revenuecat-transfer-worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  repeat('f', 64),
  'authority_fetch_unavailable'
);

select extensions.is(
  (
    select status
    from public.cloud_revenuecat_transfer_events
    where event_id = 'rc-transfer-pgtap-b'
  ),
  'dead_letter',
  'the twelfth failed replay is dead-lettered'
);
update public.cloud_revenuecat_transfer_events
set status = 'partial',
    reason = 'source_equal_timestamp_requires_reconciliation',
    attempt_count = 12,
    next_retry_at = clock_timestamp() - interval '1 second',
    terminal_at = null
where event_id = 'rc-transfer-pgtap-b';
create temporary table rc_dead_letter_sweep as
select public.revenuecat_transfer_retry_jobs_lease(
  'revenuecat-transfer-worker:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  repeat('6', 64),
  1,
  120
) as envelope;
select extensions.is(
  (
    select (envelope->>'dead_letter_moved')::integer
    from rc_dead_letter_sweep
  ),
  1,
  'the lease envelope reports rows moved to dead-letter'
);
select extensions.is(
  (
    select jsonb_array_length(envelope->'jobs')
    from rc_dead_letter_sweep
  ),
  0,
  'a dead-letter sweep never returns the exhausted row as leased work'
);

update public.cloud_revenuecat_transfer_events
set partner_attempt_count = 11,
    partner_next_retry_at = clock_timestamp() - interval '1 second'
where event_id = 'rc-transfer-pgtap-a';

create temporary table rc_partner_lease as
select public.revenuecat_transfer_partner_jobs_lease(
  'revenuecat-transfer-worker:cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  repeat('1', 64),
  1,
  90
) as envelope;
select extensions.is(
  (select jsonb_array_length(envelope->'jobs') from rc_partner_lease),
  1,
  'the post-commit Partners observation is leased separately'
);
create temporary table rc_partner_live_lease_sweep as
select public.revenuecat_transfer_partner_jobs_lease(
  'revenuecat-transfer-worker:dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  repeat('2', 64),
  1,
  90
) as envelope;
select extensions.is(
  (
    select (envelope->>'partner_dead_letter_moved')::integer
    from rc_partner_live_lease_sweep
  ),
  0,
  'an active Partners lease is never swept from another worker'
);
select public.revenuecat_transfer_partner_job_complete(
  'rc-transfer-pgtap-a',
  'revenuecat-transfer-worker:cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  repeat('1', 64),
  'succeeded',
  null
);
select extensions.is(
  (
    select partner_status
    from public.cloud_revenuecat_transfer_events
    where event_id = 'rc-transfer-pgtap-a'
  ),
  'succeeded',
  'Partners completion cannot alter the entitlement result'
);
select extensions.ok(
  (
    select partner_observed_at is not null
    from public.cloud_revenuecat_transfer_events
    where event_id = 'rc-transfer-pgtap-a'
  ),
  'Partners completion records its independent observation time'
);

insert into public.cloud_entitlement_projection (
  user_id,
  provider,
  plan_code,
  status,
  limits,
  current_period_end,
  last_verified_at,
  last_event_at
)
select
  '30000000-0000-4000-8000-000000000010'::uuid,
  'google_play',
  'plus',
  'active',
  '{}'::jsonb,
  period_end + interval '30 days',
  clock_timestamp(),
  event_c + interval '10 minutes'
from rc_clock
union all
select
  '30000000-0000-4000-8000-000000000012'::uuid,
  'google_play',
  'plus',
  'expired',
  '{}'::jsonb,
  event_c,
  clock_timestamp(),
  event_c + interval '5 minutes'
from rc_clock;

create temporary table rc_result_causal as
select result.*
from rc_clock fixture
cross join lateral public.apply_revenuecat_entitlement_transfer(
  'rc-transfer-pgtap-causal',
  fixture.event_c,
  repeat('7', 64),
  repeat('8', 64),
  '30000000-0000-4000-8000-000000000009',
  array[
    '30000000-0000-4000-8000-000000000010'::uuid,
    '30000000-0000-4000-8000-000000000012'::uuid
  ],
  2,
  1,
  'production',
  'play_store',
  jsonb_build_object(
    'user_id', '30000000-0000-4000-8000-000000000009',
    'provider', 'google_play',
    'provider_customer_id', '30000000-0000-4000-8000-000000000009',
    'plan_code', 'plus',
    'status', 'active',
    'limits', '{}'::jsonb,
    'current_period_end', fixture.period_end,
    'last_verified_at', clock_timestamp(),
    'last_event_at', fixture.event_c,
    'fail_open_until', null,
    'mrr_cents', null,
    'billing_currency', null,
    'billing_product_id', 'norva_plus:monthly',
    'billing_package_id', null,
    'bill_period', 'monthly',
    'billing_terms_source', 'revenuecat_transfer_refetch'
  )
) result;

select extensions.is(
  (select terminal from rc_result_causal),
  true,
  'a strictly newer active source is a terminal post-transfer purchase'
);
select extensions.is(
  (select source_newer_preserved_count from rc_result_causal),
  1,
  'strictly newer active sources are counted as preserved'
);
select extensions.is(
  (select source_expired_count from rc_result_causal),
  1,
  'an already-expired source is resolved without another mutation'
);
select extensions.is(
  (
    select status
    from public.cloud_entitlement_projection
    where user_id = '30000000-0000-4000-8000-000000000010'
  ),
  'active',
  'a post-transfer purchase remains active'
);
select extensions.is(
  (
    select source_equal_pending_count
    from public.cloud_revenuecat_transfer_events
    where event_id = 'rc-transfer-pgtap-causal'
  ),
  0::smallint,
  'the terminal causal reconciliation has no ambiguous equality'
);

insert into public.cloud_entitlement_projection (
  user_id,
  provider,
  plan_code,
  status,
  limits,
  current_period_end,
  last_verified_at,
  last_event_at
)
select
  '30000000-0000-4000-8000-000000000007'::uuid,
  'google_play',
  'plus',
  'fraud',
  '{}'::jsonb,
  period_end,
  clock_timestamp(),
  event_c - interval '1 minute'
from rc_clock
union all
select
  '30000000-0000-4000-8000-000000000008'::uuid,
  'manual',
  'manual',
  'active',
  '{}'::jsonb,
  period_end,
  clock_timestamp(),
  event_c - interval '1 minute'
from rc_clock;

create temporary table rc_result_c as
select result.*
from rc_clock fixture
cross join lateral public.apply_revenuecat_entitlement_transfer(
  'rc-transfer-pgtap-c',
  fixture.event_c,
  repeat('2', 64),
  repeat('3', 64),
  '30000000-0000-4000-8000-000000000005',
  array[
    '30000000-0000-4000-8000-000000000006'::uuid,
    '30000000-0000-4000-8000-000000000007'::uuid,
    '30000000-0000-4000-8000-000000000008'::uuid
  ],
  3,
  1,
  'production',
  'play_store',
  jsonb_build_object(
    'user_id', '30000000-0000-4000-8000-000000000005',
    'provider', 'google_play',
    'provider_customer_id', '30000000-0000-4000-8000-000000000005',
    'plan_code', 'plus',
    'status', 'active',
    'limits', '{}'::jsonb,
    'current_period_end', fixture.period_end,
    'last_verified_at', clock_timestamp(),
    'last_event_at', fixture.event_c,
    'fail_open_until', null,
    'mrr_cents', null,
    'billing_currency', null,
    'billing_product_id', 'norva_plus:monthly',
    'billing_package_id', null,
    'bill_period', 'monthly',
    'billing_terms_source', 'revenuecat_transfer_refetch'
  )
) result;

select extensions.is(
  (select terminal from rc_result_c),
  true,
  'absent and policy-preserved sources are terminal outcomes'
);
select extensions.is(
  (select source_absent_count from rc_result_c),
  1,
  'absent sources are counted explicitly'
);
select extensions.is(
  (select source_hard_block_preserved_count from rc_result_c),
  1,
  'hard-blocked sources are counted explicitly'
);
select extensions.is(
  (select source_cross_rail_preserved_count from rc_result_c),
  1,
  'cross-rail sources are counted explicitly'
);
select extensions.is(
  (
    select
      source_absent_count +
      source_internal_preserved_count +
      source_hard_block_preserved_count +
      source_cross_rail_preserved_count +
      source_expired_count +
      source_newer_pending_count
    from public.cloud_revenuecat_transfer_events
    where event_id = 'rc-transfer-pgtap-c'
  ),
  3::smallint,
  'every canonical source has exactly one persisted outcome'
);
select extensions.is(
  (
    select count(*)::integer
    from public.cloud_entitlement_events
    where provider = 'revenuecat'
      and provider_event_id = 'rc-transfer-pgtap-c'
  ),
  1,
  'the generic transfer marker exists only after a terminal outcome'
);

select *
from public.record_revenuecat_entitlement_transfer(
  'rc-transfer-pgtap-terminal-reject',
  (select event_c from rc_clock),
  repeat('4', 64),
  'invalid_contract',
  '30000000-0000-4000-8000-000000000005',
  '{}'::uuid[],
  1,
  1,
  'production',
  'play_store',
  false
);
select extensions.is(
  (
    select status
    from public.cloud_revenuecat_transfer_events
    where event_id = 'rc-transfer-pgtap-terminal-reject'
  ),
  'rejected',
  'a non-retryable contract disposition is terminally rejected'
);

update public.cloud_revenuecat_transfer_events
set next_retry_at = clock_timestamp() - interval '1 second'
where event_id in (
  'rc-transfer-pgtap-a',
  'rc-transfer-pgtap-terminal-reject'
);
create temporary table rc_terminal_lease as
select public.revenuecat_transfer_retry_jobs_lease(
  'revenuecat-transfer-worker:dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  repeat('5', 64),
  20,
  90
) as envelope;
select extensions.is(
  (select jsonb_array_length(envelope->'jobs') from rc_terminal_lease),
  0,
  'applied and rejected terminal transfers are never re-leased'
);

select public.partners_worker_heartbeat(
  'revenuecat_transfer',
  'degraded',
  jsonb_build_object(
    'duration_ms', 1200,
    'transfer_partial', 1,
    'transfer_dead_letter', 1
  )
);
select extensions.is(
  (
    select status
    from affiliate_private.affiliate_worker_heartbeats
    where worker_name = 'revenuecat_transfer'
  ),
  'degraded',
  'the TRANSFER worker publishes a first-class sanitized heartbeat'
);
select extensions.ok(
  exists (
    select 1
    from jsonb_array_elements(
      affiliate_private.partners_ops_alert_snapshot()->'workers'
    ) worker
    where worker->>'worker' = 'revenuecat_transfer'
      and worker->>'status' = 'degraded'
  ),
  'the operations snapshot exposes the TRANSFER worker health'
);
select extensions.ok(
  exists (
    select 1
    from jsonb_array_elements(
      affiliate_private.partners_ops_alert_snapshot()->'workers'
    ) worker
    where worker->>'worker' = 'payout'
      and worker->>'status' = 'not_configured'
  ),
  'the operations snapshot keeps the payout heartbeat explicit before configuration'
);
select extensions.ok(
  exists (
    select 1
    from jsonb_array_elements(
      affiliate_private.partners_ops_alert_snapshot()->'alerts'
    ) alert
    where alert->>'code' = 'revenuecat_transfer_dead_letter'
      and (alert->>'count')::integer > 0
  ),
  'the operations snapshot exposes bounded TRANSFER dead-letter counts'
);

select * from extensions.finish();
rollback;
