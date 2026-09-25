-- Run after the private Postal transport schema is installed. No network work:
-- all fixtures, receipts and feature settings are rolled back together.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select extensions.plan(10);
update public.admin_feature_flags set enabled=true
where key in ('provider_access_notifications_v1_enabled','provider_access_email_v1_enabled') and not enabled;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values('98610000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','provider-postal@invalid.test','',now(),'{}','{}',now(),now());
insert into public.cloud_provider_access_rollout_internal_users(user_id,reason,added_by)
values('98610000-0000-4000-8000-000000000001','Rolled-back Postal receipt assertion','test:provider-postal');
insert into public.cloud_sources(id,user_id,source_type,display_name,config_ciphertext,config_hint,sync_status,catalog_version)
values('98610000-0000-4000-8000-000000000101','98610000-0000-4000-8000-000000000001',
  'xtream','Postal receipt fixture','fixture-ciphertext','{"serverHost":"postal.invalid"}','ready',1);
insert into public.cloud_source_access_cycles(id,user_id,source_id,started_on,expires_on,origin,idempotency_key,request_fingerprint)
values('98610000-0000-4000-8000-000000000201','98610000-0000-4000-8000-000000000001',
  '98610000-0000-4000-8000-000000000101',current_date,current_date+1,'user_entered','postal-receipt-cycle-9861',repeat('b',64));
insert into public.cloud_provider_access_notifications(id,user_id,source_id,access_cycle_id,event_kind,
  channel,state,scheduled_at,delivery_key,next_attempt_at,lease_owner,lease_sequence,lease_expires_at,transport_started_at)
values('98610000-0000-4000-8000-000000000301','98610000-0000-4000-8000-000000000001',
  '98610000-0000-4000-8000-000000000101','98610000-0000-4000-8000-000000000201',
  'expiry_1d','email','processing',now(),'norva-provider-access-98610000-0000-4000-8000-000000000301',
  now(),'postal-proof',2,now()+interval '90 seconds',now());
set local role service_role;
select extensions.is(norva_complete_provider_access_notification(
  '98610000-0000-4000-8000-000000000301','email','postal-proof',2,'POSTAL_SMTP_SENT',
  'postal_98610000-0000-4000-8000-000000000401'),false,'missing SMTP receipt cannot complete delivery');
reset role;
insert into norva_postal_full.receipts(id,delivery_key,recipient,auth,flow)
values('postal_98610000-0000-4000-8000-000000000401',
  'norva-provider-access-98610000-0000-4000-8000-000000000301','provider-postal@invalid.test',false,'provider_access');
set local role service_role;
select extensions.is(norva_complete_provider_access_notification(
  '98610000-0000-4000-8000-000000000301','email','postal-proof',2,'POSTAL_SMTP_SENT',
  'postal_98610000-0000-4000-8000-000000000401'),false,'queued mail is not a secure SMTP receipt');
reset role;
update norva_postal_full.receipts set state='sent',secure=true,postal_message_id=986100000401,
  sent_at=now(),delivery_key='postal-wrong-delivery-key'
where id='postal_98610000-0000-4000-8000-000000000401';
set local role service_role;
select extensions.is(norva_complete_provider_access_notification(
  '98610000-0000-4000-8000-000000000301','email','postal-proof',2,'POSTAL_SMTP_SENT',
  'postal_98610000-0000-4000-8000-000000000401'),false,'receipt for another delivery key is rejected');
reset role;
update norva_postal_full.receipts set delivery_key='norva-provider-access-98610000-0000-4000-8000-000000000301'
where id='postal_98610000-0000-4000-8000-000000000401';
set local role service_role;
select extensions.is(norva_complete_provider_access_notification(
  '98610000-0000-4000-8000-000000000301','email','wrong-worker',2,'POSTAL_SMTP_SENT',
  'postal_98610000-0000-4000-8000-000000000401'),false,'another worker cannot acknowledge delivery');
select extensions.is(norva_complete_provider_access_notification(
  '98610000-0000-4000-8000-000000000301','email','postal-proof',1,'POSTAL_SMTP_SENT',
  'postal_98610000-0000-4000-8000-000000000401'),false,'obsolete lease cannot acknowledge delivery');
select extensions.throws_ok($$select norva_complete_provider_access_notification(
  '98610000-0000-4000-8000-000000000301','email','postal-proof',2,'POSTAL_SMTP_SENT',null)$$,
  '22023','invalid Provider Access notification completion','Postal completion requires a receipt ID');
select extensions.is(norva_complete_provider_access_notification(
  '98610000-0000-4000-8000-000000000301','email','postal-proof',2,'POSTAL_SMTP_SENT',
  'postal_98610000-0000-4000-8000-000000000401'),true,'current lease completes from the matching secure SMTP receipt');
select extensions.is(norva_complete_provider_access_notification(
  '98610000-0000-4000-8000-000000000301','email','postal-proof',2,'POSTAL_SMTP_SENT',
  'postal_98610000-0000-4000-8000-000000000401'),false,'acknowledgement replay cannot complete the row twice');
reset role;
select extensions.ok((select state='delivered' and completion_code='POSTAL_SMTP_SENT'
  and lease_owner is null and delivered_at is not null from cloud_provider_access_notifications
  where id='98610000-0000-4000-8000-000000000301'),'outbox records Postal delivery and releases its lease');
select extensions.ok(not has_function_privilege('authenticated',
  'public.norva_complete_provider_access_notification(uuid,text,text,bigint,text,text)','execute'),
  'browser users cannot forge transport completion');
select * from extensions.finish();
rollback;
