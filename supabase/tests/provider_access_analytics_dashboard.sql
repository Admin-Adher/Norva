begin;
create extension if not exists pgtap with schema extensions;
select plan(16);

select has_function(
  'public', 'norva_provider_access_analytics_dashboard', array['integer'],
  'aggregate Provider Access dashboard exists'
);
select has_function(
  'public', 'norva_assert_provider_access_rollout_safe', array[]::text[],
  'hard Provider Access rollout gate exists'
);
select ok(
  not has_function_privilege('anon', 'public.norva_provider_access_analytics_dashboard(integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.norva_provider_access_analytics_dashboard(integer)', 'EXECUTE'),
  'browser roles cannot execute the operational dashboard'
);
select ok(
  has_function_privilege('service_role', 'public.norva_provider_access_analytics_dashboard(integer)', 'EXECUTE'),
  'service role can execute the operational dashboard'
);
select throws_ok(
  $$select public.norva_provider_access_analytics_dashboard(0)$$,
  '22023', 'analytics window must be between 1 and 90 days',
  'invalid analytics windows fail closed'
);

select is(
  public.norva_provider_access_analytics_dashboard(30)->>'schemaVersion', '1',
  'dashboard schema is versioned'
);
select ok(
  (public.norva_provider_access_analytics_dashboard(30)->'access')
    ?& array['sources_with_access_date','provider_reported_expiry','user_entered_expiry','expected_expired','confirmed_expired','access_restored'],
  'access metrics are complete'
);
select ok(
  (public.norva_provider_access_analytics_dashboard(30)->'restoration')
    ?& array['current_access_extended','new_credentials_submitted','same_catalog_detected','different_catalog_detected','ambiguous_catalog','credential_swaps_completed','credential_swaps_rolled_back'],
  'restoration metrics are complete'
);
select ok(
  (public.norva_provider_access_analytics_dashboard(30)->'replacement')
    ?& array['replacements_started','completed','failed','cancelled','staging_visibility_violation','cleanup_pending'],
  'replacement metrics are complete'
);
select ok(
  (public.norva_provider_access_analytics_dashboard(30)->'notifications')
    ?& array['7d_sent','1d_sent','today_sent','superseded','dead_letter','push_delivered','email_delivered'],
  'notification metrics are complete'
);
select ok(
  public.norva_assert_provider_access_rollout_safe()->>'safe' = 'true',
  'clean proof database passes the rollout gate'
);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '98800000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'analytics-proof-988@invalid.test', '', now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
) on conflict (id) do nothing;
insert into public.cloud_sources (
  id, user_id, source_type, display_name, config_ciphertext, config_hint, sync_status, catalog_version
) values
  ('98800000-0000-4000-8000-000000000101','98800000-0000-4000-8000-000000000001','xtream','Analytics A','fixture-a','{"serverHost":"a.invalid"}'::jsonb,'ready',1),
  ('98800000-0000-4000-8000-000000000102','98800000-0000-4000-8000-000000000001','xtream','Analytics B','fixture-b','{"serverHost":"b.invalid"}'::jsonb,'ready',1)
on conflict (id) do nothing;

insert into public.cloud_source_access_cycles(
  id,user_id,source_id,started_on,expires_on,origin,status,
  idempotency_key,request_fingerprint
) values (
  '98800000-0000-4000-8000-000000000301',
  '98800000-0000-4000-8000-000000000001',
  '98800000-0000-4000-8000-000000000101',
  current_date,current_date+7,'user_entered','active',
  'analytics-delivered-cycle-988',repeat('8',64)
);
set local session_replication_role = replica;
insert into public.cloud_provider_access_notifications(
  id,user_id,source_id,access_cycle_id,event_kind,channel,state,
  scheduled_at,delivery_key,next_attempt_at,completion_code,delivered_at
) values (
  '98800000-0000-4000-8000-000000000401',
  '98800000-0000-4000-8000-000000000001',
  '98800000-0000-4000-8000-000000000101',
  '98800000-0000-4000-8000-000000000301',
  'expiry_7d','email','delivered',clock_timestamp(),
  'norva-provider-access-98800000-0000-4000-8000-000000000401',
  clock_timestamp(),'RESEND_ACCEPTED',clock_timestamp()
);
set local session_replication_role = origin;
select is(
  (public.norva_provider_access_analytics_dashboard(30)#>>'{notifications,7d_sent}')::integer,
  1,'a delivered 7-day reminder is counted'
);
select is(
  (public.norva_provider_access_analytics_dashboard(30)#>>'{notifications,email_delivered}')::integer,
  1,'a delivered email is counted'
);

set local session_replication_role = replica;
insert into public.cloud_source_transitions (
  id,user_id,transition_kind,old_source_id,candidate_source_id,state,
  idempotency_key,expected_source_revision,expected_candidate_revision
) values (
  '98800000-0000-4000-8000-000000000201','98800000-0000-4000-8000-000000000001',
  'replacement','98800000-0000-4000-8000-000000000101','98800000-0000-4000-8000-000000000102',
  'validating','analytics-proof-988',0,0
);
set local session_replication_role = origin;

select is(
  public.norva_provider_access_analytics_dashboard(30)#>>'{p0,severity}', 'P0',
  'a visible replacement candidate is classified P0'
);
select cmp_ok(
  (public.norva_provider_access_analytics_dashboard(30)#>>'{replacement,staging_visibility_violation}')::integer,
  '>=', 1,
  'the exact violation count is exposed as an aggregate'
);
select throws_ok(
  $$select public.norva_assert_provider_access_rollout_safe()$$,
  'P0001', 'provider access rollout blocked by staging visibility violation',
  'the hard rollout gate refuses a P0 state'
);

select * from finish();
rollback;
