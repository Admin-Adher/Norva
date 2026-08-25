begin;
set local lock_timeout='3s';
set local statement_timeout='45s';
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select extensions.plan(43);

insert into auth.users(
  id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) values
('98600000-0000-4000-8000-000000000045','00000000-0000-0000-0000-000000000000','authenticated','authenticated','rollout-internal@invalid.test','',now(),'{}','{}',now(),now()),
('98600000-0000-4000-8000-000000000002','00000000-0000-0000-0000-000000000000','authenticated','authenticated','rollout-other@invalid.test','',now(),'{}','{}',now(),now());

insert into public.cloud_sources(id,user_id,source_type,display_name,config_ciphertext,config_hint,sync_status,catalog_version)
values
('98600000-0000-4000-8000-000000000101','98600000-0000-4000-8000-000000000045','xtream','Rollout internal','fixture','{}','ready',1),
('98600000-0000-4000-8000-000000000102','98600000-0000-4000-8000-000000000002','xtream','Rollout other','fixture','{}','ready',1);
insert into public.cloud_source_access_cycles(
  id,user_id,source_id,started_on,expires_on,origin,status,idempotency_key,request_fingerprint
) values
('98600000-0000-4000-8000-000000000201','98600000-0000-4000-8000-000000000045','98600000-0000-4000-8000-000000000101',current_date,current_date+7,'user_entered','active','rollout-member-cycle',repeat('1',64)),
('98600000-0000-4000-8000-000000000202','98600000-0000-4000-8000-000000000002','98600000-0000-4000-8000-000000000102',current_date,current_date+7,'user_entered','active','rollout-other-cycle',repeat('2',64));

select extensions.is((select stage from public.cloud_provider_access_rollout where singleton),'off','rollout installs OFF');
select extensions.is((select cohort_basis_points from public.cloud_provider_access_rollout where singleton),0,'OFF has an empty cohort');
select extensions.is((select count(*)::integer from public.admin_feature_flags where key like 'provider_access_%_v1_enabled' and enabled),0,'all Provider Access capability flags install OFF');
insert into public.cloud_provider_access_check_jobs(user_id,source_id,idempotency_key)
values ('98600000-0000-4000-8000-000000000002','98600000-0000-4000-8000-000000000102','phase16-off-job');
select extensions.is((select count(*)::integer from public.cloud_provider_access_check_jobs where idempotency_key='phase16-off-job'),0,'OFF suppresses new detection work at the table boundary');

update public.cloud_provider_access_foundation_rollout
set phase='complete',completed_at=coalesce(completed_at,clock_timestamp()),updated_at=clock_timestamp()
where singleton;
update public.cloud_source_provider_account_affinity_rollout
set phase='complete',completed_at=coalesce(completed_at,clock_timestamp()),updated_at=clock_timestamp()
where singleton;
alter table public.provider_account_activity validate constraint provider_account_activity_opaque_key_ck;
update public.cloud_catalog_cache_epoch_v2_rollout
set installed_at=installed_at-interval '8 days'
where singleton and phase='installed';
set local role service_role;
select public.norva_complete_catalog_cache_epoch_v2_rollout(
  'catalog-cache-epoch-v2',
  '23c0fa2cdaf09c08d9de4378d1a82f0f631ce71d6f955a0bdbb2c786b8ff98d3'
);
select extensions.is(
  (public.norva_provider_access_rollout_status('98600000-0000-4000-8000-000000000045')->>'eligible')::boolean,
  false,'OFF is fail-closed for every user'
);
select extensions.throws_ok(
  $$update public.cloud_provider_access_rollout set updated_at=clock_timestamp() where singleton$$,
  '42501','permission denied for table cloud_provider_access_rollout',
  'service role cannot bypass the rollout RPCs with direct table DML'
);
select public.norva_configure_provider_access_rollout_gates(
  1,'legal-policy:account-delete-v1-approved','ops-proof:phase11-15-green','acceptance-service'
);
select extensions.is((select revision::integer from public.cloud_provider_access_rollout where singleton),2,'gate approval advances the CAS revision');
select extensions.throws_ok(
  $$select public.norva_configure_provider_access_rollout_gates(1,'legal-policy:stale','ops-proof:stale','acceptance-service')$$,
  '40001','stale rollout revision','stale gate approval loses cleanly'
);
select public.norva_set_provider_access_rollout_internal_user(
  '98600000-0000-4000-8000-000000000045',true,'acceptance allowlist member','acceptance-service'
);
select public.norva_register_active_catalog_refresh_worker(
  'phase16-rollout-acceptance-worker',
  'credential-transition-worker-v3-active-catalog-refresh',
  'active-catalog-refresh-checkpoint-prune-v1'
);
select public.norva_set_provider_access_rollout_stage(
  2,'internal','Explicit acceptance promotion to the internal cohort.','acceptance-service'
);
select extensions.ok(public.norva_provider_access_rollout_eligible_internal('98600000-0000-4000-8000-000000000045'),'allowlisted user is eligible at INTERNAL');
select extensions.ok(not public.norva_provider_access_rollout_eligible_internal('98600000-0000-4000-8000-000000000002'),'non-allowlisted user is excluded at INTERNAL');
reset role;
select extensions.is((select count(*)::integer from public.admin_feature_flags where key in (
  'provider_access_v1_enabled','provider_access_auto_detection_v1_enabled','provider_access_notifications_v1_enabled',
  'provider_access_email_v1_enabled','provider_access_push_v1_enabled','provider_access_in_app_v1_enabled',
  'provider_access_visibility_v1_enabled','provider_credential_transition_v1_enabled','provider_replacement_v1_enabled'
) and enabled),6,'INTERNAL opens only the durable core and in-app capabilities');
select extensions.is((select count(*)::integer from public.admin_feature_flags where key in (
  'provider_access_auto_detection_v1_enabled','provider_access_email_v1_enabled','provider_access_push_v1_enabled'
) and enabled),0,'INTERNAL leaves automatic provider calls, email and push OFF');
insert into public.cloud_provider_access_check_jobs(user_id,source_id,idempotency_key)
values ('98600000-0000-4000-8000-000000000002','98600000-0000-4000-8000-000000000102','phase16-outsider-job');
insert into public.cloud_provider_access_notifications(
  id,user_id,source_id,access_cycle_id,event_kind,channel,state,scheduled_at,delivery_key,next_attempt_at
) values (
  '98600000-0000-4000-8000-000000000302','98600000-0000-4000-8000-000000000002',
  '98600000-0000-4000-8000-000000000102','98600000-0000-4000-8000-000000000202',
  'expiry_7d','in_app','available',now(),'norva-provider-access-98600000-0000-4000-8000-000000000302',now()
);
select extensions.is((select count(*)::integer from public.cloud_provider_access_check_jobs where idempotency_key='phase16-outsider-job'),0,'INTERNAL suppresses non-member detection work');
select extensions.is((select count(*)::integer from public.cloud_provider_access_notifications where id='98600000-0000-4000-8000-000000000302'),0,'INTERNAL suppresses non-member notifications');
insert into public.cloud_provider_access_check_jobs(user_id,source_id,idempotency_key)
values ('98600000-0000-4000-8000-000000000045','98600000-0000-4000-8000-000000000101','phase16-member-job');
insert into public.cloud_provider_access_notifications(
  id,user_id,source_id,access_cycle_id,event_kind,channel,state,scheduled_at,delivery_key,next_attempt_at
) values (
  '98600000-0000-4000-8000-000000000301','98600000-0000-4000-8000-000000000045',
  '98600000-0000-4000-8000-000000000101','98600000-0000-4000-8000-000000000201',
  'expiry_7d','in_app','available',now(),'norva-provider-access-98600000-0000-4000-8000-000000000301',now()
);
select extensions.is((select count(*)::integer from public.cloud_provider_access_check_jobs where idempotency_key='phase16-member-job'),1,'INTERNAL accepts member detection work');
select extensions.is((select count(*)::integer from public.cloud_provider_access_notifications where id='98600000-0000-4000-8000-000000000301'),1,'INTERNAL accepts member notifications');

set local role service_role;
select extensions.throws_ok(
  $$select public.norva_set_provider_access_rollout_stage(3,'5_percent','Skipping a mandatory observation stage is forbidden.','acceptance-service')$$,
  '55000','rollout stage cannot be skipped','an upward stage cannot be skipped'
);
select public.norva_set_provider_access_rollout_channels(
  3,true,true,true,
  'channel-readiness:acceptance-secrets-and-worker-proof',
  'acceptance-service'
);
select extensions.is((select revision::integer from public.cloud_provider_access_rollout where singleton),4,'channel approval advances the rollout CAS revision');
select extensions.is((select count(*)::integer from public.admin_feature_flags where key in (
  'provider_access_auto_detection_v1_enabled','provider_access_email_v1_enabled','provider_access_push_v1_enabled'
) and enabled),3,'separate channel approval enables the three requested external channels');
select extensions.is((select count(*)::integer from public.admin_feature_flags where key in (
  'provider_access_v1_enabled','provider_access_notifications_v1_enabled','provider_access_in_app_v1_enabled',
  'provider_access_visibility_v1_enabled','provider_credential_transition_v1_enabled','provider_replacement_v1_enabled'
) and enabled),6,'channel approval cannot disable the active core capability set');
select extensions.throws_ok(
  $$select public.norva_set_provider_access_rollout_channels(3,false,false,false,'channel-readiness:stale-proof','acceptance-service')$$,
  '40001','stale rollout revision','stale channel approval loses cleanly'
);
select extensions.throws_ok(
  $$select public.norva_set_provider_access_rollout_stage(4,'1_percent','Promotion without a durable observation must fail.','acceptance-service')$$,
  '55000','rollout stage lacks an accepted observation','promotion requires an accepted observation for the exact revision'
);
select public.norva_start_provider_access_rollout_observation(4,'acceptance-service');
select extensions.is(
  (select state from public.cloud_provider_access_rollout_observations where rollout_revision=4),
  'collecting','observation starts durably for the current revision'
);
select extensions.throws_ok(
  $$select public.norva_complete_provider_access_rollout_observation(
    (select id from public.cloud_provider_access_rollout_observations where rollout_revision=4),
    4,'proof:too-early','Observation cannot finish before the server time gate.','acceptance-service'
  )$$,
  '55000','rollout observation window is incomplete','server time gate refuses early observation completion'
);
reset role;
update public.cloud_provider_access_rollout_observations
set not_before=clock_timestamp()-interval '1 second'
where rollout_revision=4 and state='collecting';
insert into public.cloud_source_lifecycle_events(
  user_id,source_id,access_cycle_id,event_kind,idempotency_key,payload,actor,occurred_at
) values (
  '98600000-0000-4000-8000-000000000045',
  '98600000-0000-4000-8000-000000000101',
  '98600000-0000-4000-8000-000000000201',
  'provider_access_cycle_updated','phase16-observation-activity','{}','acceptance-service',clock_timestamp()
);
set local role service_role;
select public.norva_complete_provider_access_rollout_observation(
  (select id from public.cloud_provider_access_rollout_observations where rollout_revision=4),
  4,'proof:phase16-observation-green',
  'Observed real qualifying activity with all versioned thresholds green.',
  'acceptance-service'
);
select extensions.is(
  (select state from public.cloud_provider_access_rollout_observations where rollout_revision=4),
  'accepted','green metrics and explicit evidence accept the observation'
);
select extensions.is(
  (select final_snapshot->>'qualifyingActivity' from public.cloud_provider_access_rollout_observations where rollout_revision=4),
  '1','accepted observation records real qualifying activity'
);
select public.norva_set_provider_access_rollout_stage(
  4,'1_percent','Explicit acceptance promotion after internal observation.','acceptance-service'
);
select extensions.is((select cohort_basis_points from public.cloud_provider_access_rollout where singleton),100,'1 percent is represented as exactly 100 basis points');
select extensions.is((select count(*)::integer from public.admin_feature_flags where key in (
  'provider_access_auto_detection_v1_enabled','provider_access_email_v1_enabled','provider_access_push_v1_enabled'
) and enabled),0,'every stage transition resets external channels OFF');
select extensions.is(
  public.norva_provider_access_rollout_eligible_internal('98600000-0000-4000-8000-000000000002'),
  public.norva_provider_access_rollout_eligible_internal('98600000-0000-4000-8000-000000000002'),
  'percentage assignment is deterministic'
);
select extensions.throws_ok(
  $$select public.norva_set_provider_access_rollout_stage(4,'5_percent','A stale concurrent promotion must lose cleanly.','acceptance-service')$$,
  '40001','stale rollout revision','concurrent promotion is fenced by revision CAS'
);
select public.norva_start_provider_access_rollout_observation(5,'acceptance-service');
reset role;
update public.cloud_provider_access_rollout_observations
set not_before=clock_timestamp()-interval '1 second'
where rollout_revision=5 and state='collecting';
insert into public.cloud_source_lifecycle_events(
  user_id,source_id,access_cycle_id,event_kind,idempotency_key,payload,actor,occurred_at
) values (
  '98600000-0000-4000-8000-000000000045',
  '98600000-0000-4000-8000-000000000101',
  '98600000-0000-4000-8000-000000000201',
  'credential_compensation_completed','phase16-observation-rollback','{}','acceptance-service',clock_timestamp()
);
set local role service_role;
select public.norva_complete_provider_access_rollout_observation(
  (select id from public.cloud_provider_access_rollout_observations where rollout_revision=5 and state='collecting'),
  5,'proof:phase16-observation-rejected',
  'A rollback during the observation must reject this cohort revision.',
  'acceptance-service'
);
select extensions.is(
  (select state from public.cloud_provider_access_rollout_observations where rollout_revision=5),
  'rejected','rollback above the threshold rejects the observation'
);
select extensions.ok(
  (select decision_reasons ? 'CREDENTIAL_ROLLBACK_RATE_EXCEEDED'
   from public.cloud_provider_access_rollout_observations where rollout_revision=5),
  'rejection durably records the exceeded threshold reason'
);
select public.norva_start_provider_access_rollout_observation(5,'acceptance-service');
select public.norva_set_provider_access_rollout_channels(
  5,false,false,false,
  'channel-readiness:revision-change-invalidates-observation',
  'acceptance-service'
);
select extensions.is(
  (select state from public.cloud_provider_access_rollout_observations
   where rollout_revision=5 order by created_at desc limit 1),
  'stale','a channel revision change invalidates a collecting observation'
);
select extensions.is(
  (select revision::integer from public.cloud_provider_access_rollout where singleton),
  6,'channel decision creates a new revision requiring a fresh observation'
);
select public.norva_set_provider_access_rollout_stage(
  6,'off','Emergency rollback to OFF remains available immediately.','acceptance-service'
);
select extensions.throws_ok(
  $$select public.norva_set_provider_access_rollout_channels(7,true,false,false,'channel-readiness:off-refusal','acceptance-service')$$,
  '55000','rollout channels require an active cohort','OFF refuses every external channel activation'
);
select extensions.ok(not public.norva_provider_access_rollout_eligible_internal('98600000-0000-4000-8000-000000000045'),'OFF overrides the retained internal allowlist');
reset role;
select extensions.is((select count(*)::integer from public.admin_feature_flags where key in (
  'provider_access_v1_enabled','provider_access_auto_detection_v1_enabled','provider_access_notifications_v1_enabled',
  'provider_access_email_v1_enabled','provider_access_push_v1_enabled','provider_access_in_app_v1_enabled',
  'provider_access_visibility_v1_enabled','provider_credential_transition_v1_enabled','provider_replacement_v1_enabled'
) and enabled),0,'emergency OFF closes every capability flag');
select extensions.is((select count(*)::integer from public.cloud_provider_access_rollout_events),3,'every stage transition is durably audited');
select extensions.is((select string_agg(stage,',' order by revision) from public.cloud_provider_access_rollout_events),'internal,1_percent,off','audit preserves the exact transition order');
select extensions.is((select count(*)::integer from public.cloud_provider_access_rollout_channel_events),2,'channel approvals are durably and separately audited');
select extensions.ok((select legal_policy_approved_at is not null and operational_approved_at is not null from public.cloud_provider_access_rollout where singleton),'approval evidence remains durable after rollback');

set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','98600000-0000-4000-8000-000000000002',true);
select extensions.throws_ok(
  $$select public.norva_provider_access_rollout_status('98600000-0000-4000-8000-000000000045')$$,
  '42501','rollout status forbidden','a user cannot inspect another user rollout status'
);
select extensions.is(
  public.norva_provider_access_rollout_status('98600000-0000-4000-8000-000000000002')->>'stage',
  'off','a user may read only the sanitized own status'
);
reset role;

select * from extensions.finish();
rollback;
