-- Included inside the rolled-back credential-transition fixture.
reset role;
update public.admin_feature_flags set enabled=true
where key='provider_access_auto_detection_v1_enabled';
update public.cloud_source_provider_access set provider_access_last_checked_at=now();
update public.cloud_source_provider_access set provider_access_last_checked_at=now()-interval '1 minute'
where source_id='93000000-0000-4000-8000-000000000102';
insert into public.cloud_provider_access_check_jobs(user_id,source_id,state,completed_at,idempotency_key)
values('93000000-0000-4000-8000-000000000001','93000000-0000-4000-8000-000000000102',
  'completed',now()-interval '1 minute',
  'provider-access-check:93000000-0000-4000-8000-000000000102:'||to_char(now() at time zone 'UTC','YYYY-MM-DD'));
set local role service_role;
select public.norva_schedule_provider_access_checks(100,now());
select extensions.is((select count(*)::integer from public.cloud_provider_access_check_jobs
  where source_id='93000000-0000-4000-8000-000000000102' and state='queued'),1,
  'completed renewal queues a fresh check despite a recent check and same-day terminal job');
select public.norva_schedule_provider_access_checks(100,now());
select extensions.is((select count(*)::integer from public.cloud_provider_access_check_jobs
  where source_id='93000000-0000-4000-8000-000000000102' and state='queued'),1,
  'scheduler replay preserves exactly one renewal access check');
insert into phase3_ctx
select 'renewal-access-claim',to_jsonb(claim) from public.norva_claim_provider_access_check_jobs('renewal-proof',1,180) claim;
select public.norva_apply_claimed_provider_access_detection(
  (select (value->>'job_id')::uuid from phase3_ctx where key='renewal-access-claim'),
  'renewal-proof',(select (value->>'lease_sequence')::bigint from phase3_ctx where key='renewal-access-claim'),
  '{"detectionVersion":1,"status":"active","reasonCode":"PROVIDER_CONFIRMED_ACTIVE","expiresOn":"2027-09-20","hideEligible":false,"restorationConfirmed":true,"contradictions":[]}'::jsonb,
  clock_timestamp(),null);
select extensions.ok(public.norva_source_catalog_visible_internal(
  '93000000-0000-4000-8000-000000000102','93000000-0000-4000-8000-000000000001'),
  'fresh provider detection restores the verified renewed catalogue');
select public.norva_schedule_provider_access_checks(100,now());
select extensions.is((select count(*)::integer from public.cloud_provider_access_check_jobs
  where source_id='93000000-0000-4000-8000-000000000102' and state in ('queued','leased','retry')),0,
  'successful fresh check stops renewal scheduling');
reset role;
select extensions.is((select count(*)::integer from public.cloud_provider_access_check_jobs
  where source_id='93000000-0000-4000-8000-000000000102' and state='completed'),2,
  'restoration retains the old daily check and the new renewal check');
