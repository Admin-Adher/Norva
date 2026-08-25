begin;
set local lock_timeout = '3s';
set local statement_timeout = '45s';
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select extensions.plan(52);

-- This acceptance harness must be deterministic on a reused disposable proof
-- database. Reset only notification proof state inside this transaction; the
-- final rollback restores the exact pre-test database.
delete from public.cloud_provider_access_notifications;
update public.cloud_source_provider_access
set provider_access_reminders_enabled = false
where provider_access_reminders_enabled;
update public.admin_feature_flags set enabled = false
where key in (
  'provider_access_notifications_v1_enabled',
  'provider_access_email_v1_enabled',
  'provider_access_push_v1_enabled',
  'provider_access_in_app_v1_enabled'
);

select extensions.is(
  (select count(*)::integer from public.admin_feature_flags
   where key in (
     'provider_access_notifications_v1_enabled',
     'provider_access_email_v1_enabled',
     'provider_access_push_v1_enabled',
     'provider_access_in_app_v1_enabled'
   ) and not enabled),
  4,
  'master and three Provider Access delivery flags install OFF'
);
select extensions.is(
  (select relrowsecurity from pg_class where oid = 'public.cloud_provider_access_notifications'::regclass),
  true,
  'notification outbox has RLS enabled'
);
select extensions.is(
  (select count(*)::integer
   from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'cloud_provider_access_notifications'
     and grantee in ('anon','authenticated')),
  0,
  'notification outbox has no direct browser grants'
);

set local role service_role;
select extensions.throws_ok(
  $$select public.norva_schedule_provider_access_notifications(now(), 10)$$,
  '55000',
  'Provider Access notifications disabled',
  'scheduler fails closed while the master flag is OFF'
);
select extensions.throws_ok(
  $$select public.norva_enqueue_provider_access_push_readiness_smoke(
    '98600000-0000-4000-8000-000000000001',1,
    'fcm-readiness:disabled-channel-proof','test:phase11'
  )$$,
  '55000','Provider Access notifications disabled',
  'readiness smoke cannot bypass the default-off notification gate'
);
reset role;

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '98600000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
  'provider-access-notify-986@invalid.test', '', now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
);
insert into public.cloud_sources (
  id, user_id, source_type, display_name, config_ciphertext, config_hint,
  sync_status, catalog_version
) values (
  '98600000-0000-4000-8000-000000000101',
  '98600000-0000-4000-8000-000000000001', 'xtream', 'Cinema 986',
  'fixture-ciphertext', '{"serverHost":"provider-986.invalid"}'::jsonb,
  'ready', 1
);
update public.cloud_provider_access_rollout
set stage='internal', revision=revision+1, updated_at=clock_timestamp()
where singleton;
insert into public.cloud_provider_access_rollout_internal_users(
  user_id,reason,added_by
) values (
  '98600000-0000-4000-8000-000000000001',
  'notification readiness smoke acceptance member','test:phase11'
) on conflict (user_id) do nothing;
update public.admin_feature_flags set enabled = true
where key in (
  'provider_access_v1_enabled',
  'provider_access_notifications_v1_enabled',
  'provider_access_email_v1_enabled',
  'provider_access_push_v1_enabled',
  'provider_access_in_app_v1_enabled'
);

set local role service_role;
select public.norva_create_provider_access_cycle(
  '98600000-0000-4000-8000-000000000001',
  '98600000-0000-4000-8000-000000000101',
  current_date, null, 7, 'day', true,
  'notify-cycle-986', repeat('a', 64), 'test:phase11'
);
select extensions.is(
  (select expires_on from public.cloud_source_access_cycles
   where source_id = '98600000-0000-4000-8000-000000000101' and status = 'active'),
  current_date + 7,
  'fixture cycle expires exactly seven calendar days from today'
);
select extensions.is(
  public.norva_schedule_provider_access_notifications(now(), 10)->>'events',
  '1',
  'daily scheduler finds the J-7 event once'
);
select extensions.is(
  (select count(*)::integer from public.cloud_provider_access_notifications
   where source_id = '98600000-0000-4000-8000-000000000101'),
  3,
  'one logical event creates one row per independent channel'
);
select extensions.is(
  public.norva_schedule_provider_access_notifications(now(), 10)->>'rowsInserted',
  '0',
  'a second scheduler is idempotent'
);
select extensions.is(
  (select string_agg(channel || ':' || state, ',' order by channel)
   from public.cloud_provider_access_notifications
   where source_id = '98600000-0000-4000-8000-000000000101'),
  'email:pending,in_app:available,push:pending',
  'network channels wait while in-app is a locally available record'
);
select extensions.is(
  (select count(distinct access_cycle_id::text || ':' || event_kind || ':' || channel)::integer
   from public.cloud_provider_access_notifications
   where source_id = '98600000-0000-4000-8000-000000000101'),
  3,
  'deduplication identity is cycle plus event kind plus channel'
);

select extensions.is(
  (select count(*)::integer from public.norva_claim_provider_access_notifications(
    'email', 'notify-worker-email', 4, 90, 12
  )),
  1,
  'email worker claims one due row'
);
select extensions.is(
  (select lease_sequence from public.cloud_provider_access_notifications
   where source_id = '98600000-0000-4000-8000-000000000101' and channel = 'email'),
  1::bigint,
  'first email claim owns lease sequence one'
);
select extensions.is(
  public.norva_authorize_provider_access_notification(
    (select id from public.cloud_provider_access_notifications
     where source_id = '98600000-0000-4000-8000-000000000101' and channel = 'email'),
    'email', 'notify-worker-email', 1, 'stale-address@invalid.test'
  ),
  false,
  'a stale Auth email is rejected immediately before network I/O'
);
select extensions.ok(
  (select state = 'pending' and last_error_code = 'RECIPIENT_CHANGED'
      and transport_started_at is null
   from public.cloud_provider_access_notifications
   where source_id = '98600000-0000-4000-8000-000000000101' and channel = 'email'),
  'recipient drift requeues without starting the Resend idempotency window'
);
select extensions.is(
  (select count(*)::integer from public.norva_claim_provider_access_notifications(
    'email', 'notify-worker-email', 4, 90, 12
  )),
  1,
  'email row can be reclaimed with the current address'
);
select extensions.is(
  (select lease_sequence from public.cloud_provider_access_notifications
   where source_id = '98600000-0000-4000-8000-000000000101' and channel = 'email'),
  2::bigint,
  'reclaim advances the email lease sequence'
);
select extensions.is(
  public.norva_authorize_provider_access_notification(
    (select id from public.cloud_provider_access_notifications
     where source_id = '98600000-0000-4000-8000-000000000101' and channel = 'email'),
    'email', 'notify-worker-email', 2, 'provider-access-notify-986@invalid.test'
  ),
  true,
  'current Auth email and current business state pass the final CAS'
);
select extensions.ok(
  (select transport_started_at is not null
   from public.cloud_provider_access_notifications
   where source_id = '98600000-0000-4000-8000-000000000101' and channel = 'email'),
  'successful authorization starts the provider idempotency window'
);
select extensions.is(
  public.norva_complete_provider_access_notification(
    (select id from public.cloud_provider_access_notifications
     where source_id = '98600000-0000-4000-8000-000000000101' and channel = 'email'),
    'email', 'notify-worker-email', 1, 'RESEND_ACCEPTED', 'email-stale'
  ),
  false,
  'an obsolete lease cannot acknowledge delivery'
);
select extensions.is(
  public.norva_complete_provider_access_notification(
    (select id from public.cloud_provider_access_notifications
     where source_id = '98600000-0000-4000-8000-000000000101' and channel = 'email'),
    'email', 'notify-worker-email', 2, 'RESEND_ACCEPTED', 'email-accepted-986'
  ),
  true,
  'current email lease acknowledges one Resend acceptance'
);
select extensions.ok(
  (select state = 'delivered' and completion_code = 'RESEND_ACCEPTED'
   from public.cloud_provider_access_notifications
   where source_id = '98600000-0000-4000-8000-000000000101' and channel = 'email'),
  'email row reaches an explicit delivered state'
);
select extensions.is(
  (select count(*)::integer from information_schema.columns
   where table_schema = 'public' and table_name = 'cloud_provider_access_notifications'
     and column_name in ('recipient_email','server_url','username','password','token','payload')),
  0,
  'outbox schema stores no recipient, credential, token or free-form payload'
);

select extensions.is(
  (select count(*)::integer from public.norva_claim_provider_access_notifications(
    'push', 'notify-worker-push', 4, 90, 12
  )),
  1,
  'push worker claims independently of email state'
);
select extensions.is(
  public.norva_authorize_provider_access_notification(
    (select id from public.cloud_provider_access_notifications
     where source_id = '98600000-0000-4000-8000-000000000101' and channel = 'push'),
    'push', 'notify-worker-push', 1, null
  ),
  true,
  'push performs its own final business-state CAS'
);
select extensions.is(
  public.norva_fail_provider_access_notification(
    (select id from public.cloud_provider_access_notifications
     where source_id = '98600000-0000-4000-8000-000000000101' and channel = 'push'),
    'push', 'notify-worker-push', 1, 'FCM_TEMPORARY_FAILURE', true, 0, 12
  ),
  'retry_scheduled',
  'retryable push failure returns to the durable queue'
);
select extensions.ok(
  (select state = 'pending' and delivery_key like 'norva-provider-access-%'
   from public.cloud_provider_access_notifications
   where source_id = '98600000-0000-4000-8000-000000000101' and channel = 'push'),
  'push retry preserves its stable delivery identity'
);
select extensions.is(
  (select count(*)::integer from public.norva_claim_provider_access_notifications(
    'push', 'notify-worker-push', 4, 90, 12
  )),
  1,
  'retryable push row is reclaimed'
);
select extensions.is(
  (select lease_sequence from public.cloud_provider_access_notifications
   where source_id = '98600000-0000-4000-8000-000000000101' and channel = 'push'),
  2::bigint,
  'push reclaim advances its lease sequence'
);
select extensions.is(
  public.norva_authorize_provider_access_notification(
    (select id from public.cloud_provider_access_notifications
     where source_id = '98600000-0000-4000-8000-000000000101' and channel = 'push'),
    'push', 'notify-worker-push', 2, null
  ),
  true,
  'reclaimed push row reauthorizes before retry'
);
select extensions.is(
  public.norva_complete_provider_access_notification(
    (select id from public.cloud_provider_access_notifications
     where source_id = '98600000-0000-4000-8000-000000000101' and channel = 'push'),
    'push', 'notify-worker-push', 2, 'NO_REGISTERED_TOKEN', null
  ),
  true,
  'absence of a registered token is classified without retrying forever'
);
select extensions.ok(
  (select state = 'delivered' and completion_code = 'NO_REGISTERED_TOKEN'
   from public.cloud_provider_access_notifications
   where source_id = '98600000-0000-4000-8000-000000000101' and channel = 'push'),
  'push no-token outcome is terminal and observable'
);
reset role;

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"98600000-0000-4000-8000-000000000001","role":"authenticated"}';
set local request.jwt.claim.sub = '98600000-0000-4000-8000-000000000001';
select extensions.is(
  jsonb_array_length(public.norva_list_provider_access_in_app_notifications(20)),
  1,
  'the owner sees one sanitized in-app notification'
);
select extensions.is(
  public.norva_dismiss_provider_access_in_app_notification(
    '00000000-0000-0000-0000-000000000000'
  ),
  false,
  'a guessed in-app notification id cannot affect another row'
);
select extensions.is(
  public.norva_dismiss_provider_access_in_app_notification(
    (public.norva_list_provider_access_in_app_notifications(20)->0->>'notificationId')::uuid
  ),
  true,
  'owner can dismiss the exact in-app row'
);
select extensions.is(
  public.norva_list_provider_access_in_app_notifications(20),
  '[]'::jsonb,
  'dismissed in-app rows disappear without mutating Provider Access state'
);
reset role;

-- A transactional access-hidden event creates one new set, then opt-out must
-- revoke every non-terminal channel immediately while preserving sent audit.
insert into public.cloud_source_lifecycle_events (
  user_id, source_id, access_cycle_id, event_kind, idempotency_key, payload, actor
) values (
  '98600000-0000-4000-8000-000000000001',
  '98600000-0000-4000-8000-000000000101',
  (select id from public.cloud_source_access_cycles
   where source_id = '98600000-0000-4000-8000-000000000101' and status = 'active'),
  'provider_access_hidden', 'notify-hidden-986', '{}'::jsonb, 'test:phase11'
);
select extensions.is(
  (select count(*)::integer from public.cloud_provider_access_notifications
   where source_id = '98600000-0000-4000-8000-000000000101'
     and event_kind = 'access_hidden'),
  3,
  'hidden event enqueues all channels in the same transaction'
);
update public.cloud_source_provider_access
set provider_access_reminders_enabled = false
where source_id = '98600000-0000-4000-8000-000000000101';
select extensions.is(
  (select count(*)::integer from public.cloud_provider_access_notifications
   where source_id = '98600000-0000-4000-8000-000000000101'
     and event_kind = 'access_hidden' and state = 'superseded'),
  3,
  'opt-out immediately supersedes pending, available and leased work'
);
select extensions.is(
  (select count(*)::integer from public.cloud_provider_access_notifications
   where source_id = '98600000-0000-4000-8000-000000000101'
     and event_kind = 'expiry_7d' and state = 'delivered'),
  2,
  'supersession preserves already terminal email and push audit'
);

set local request.jwt.claims = '{"role":"service_role"}';
set local request.jwt.claim.sub = '';
set local role service_role;
select extensions.throws_ok(
  $$select public.norva_enqueue_provider_access_push_readiness_smoke(
    '98600000-0000-4000-8000-000000000099',
    (select revision from public.cloud_provider_access_rollout where singleton),
    'fcm-readiness:outsider-refusal-proof','test:phase11'
  )$$,
  '55000','push readiness smoke requires an internal rollout user',
  'non-internal users can never receive a readiness smoke'
);
select extensions.throws_ok(
  $$select public.norva_enqueue_provider_access_push_readiness_smoke(
    '98600000-0000-4000-8000-000000000001',0,
    'fcm-readiness:stale-revision-proof','test:phase11'
  )$$,
  '40001','stale rollout revision',
  'readiness smoke is CAS-bound to the exact rollout revision'
);
select extensions.is(
  (select count(*)::integer from public.norva_claim_provider_access_notifications(
    'email', 'notify-worker-final', 4, 90, 12
  )),
  0,
  'opted-out cycle exposes no email work to a late worker'
);

select extensions.is(
  public.norva_enqueue_provider_access_push_readiness_smoke(
    '98600000-0000-4000-8000-000000000001',
    (select revision from public.cloud_provider_access_rollout where singleton),
    'fcm-readiness:phase11-physical-device-proof',
    'test:phase11'
  )->>'eventKind',
  'readiness_smoke',
  'service role enqueues an explicit readiness event instead of a fake expiry'
);
select extensions.is(
  public.norva_enqueue_provider_access_push_readiness_smoke(
    '98600000-0000-4000-8000-000000000001',
    (select revision from public.cloud_provider_access_rollout where singleton),
    'fcm-readiness:phase11-physical-device-proof',
    'test:phase11'
  )->>'notificationId',
  (select id::text from public.cloud_provider_access_notifications
   where event_kind='readiness_smoke'),
  'same rollout revision replays the same durable smoke row'
);
select extensions.is(
  (select count(*)::integer from public.cloud_provider_access_notifications
   where event_kind='readiness_smoke' and channel='push' and state='pending'),
  1,
  'readiness smoke is push-only and unique for the rollout revision'
);
select public.norva_schedule_provider_access_notifications(now(),10);
select extensions.is(
  (select state from public.cloud_provider_access_notifications
   where event_kind='readiness_smoke'),
  'pending',
  'scheduler preserves an internal readiness smoke after reminder opt-out'
);
select extensions.is(
  (select count(*)::integer from public.norva_claim_provider_access_notifications(
    'push','readiness-smoke-worker',4,90,12
  ) where event_kind='readiness_smoke'),
  1,
  'push worker claims the internal smoke through the ordinary durable lease'
);
select extensions.is(
  public.norva_authorize_provider_access_notification(
    (select id from public.cloud_provider_access_notifications where event_kind='readiness_smoke'),
    'push','readiness-smoke-worker',1,null
  ),
  true,
  'readiness smoke revalidates rollout, source, cycle and lease before FCM'
);
select extensions.is(
  public.norva_complete_provider_access_notification(
    (select id from public.cloud_provider_access_notifications where event_kind='readiness_smoke'),
    'push','readiness-smoke-worker',1,'FCM_ACCEPTED','projects/test/messages/readiness-smoke'
  ),
  true,
  'FCM acknowledgement settles the same durable smoke row'
);
select extensions.ok(
  (select state='delivered' and completion_code='FCM_ACCEPTED'
   from public.cloud_provider_access_notifications where event_kind='readiness_smoke'),
  'readiness smoke reaches the ordinary explicit delivered state'
);
select extensions.is(
  (select count(*)::integer
   from public.cloud_provider_access_notification_smoke_events smoke
   join public.cloud_provider_access_notifications notification
     on notification.id=smoke.notification_id
   where notification.event_kind='readiness_smoke'
     and smoke.readiness_reference='fcm-readiness:phase11-physical-device-proof'),
  1,
  'immutable smoke audit binds readiness reference and notification id'
);
reset role;
select extensions.ok(
  (select pg_get_constraintdef(constraint_row.oid) like '%ON DELETE CASCADE%'
   from pg_constraint constraint_row
   where constraint_row.conrelid='public.cloud_provider_access_notification_smoke_events'::regclass
     and constraint_row.contype='f'),
  'readiness audit follows the bounded outbox cascade instead of blocking deletion'
);

select * from extensions.finish();
rollback;
