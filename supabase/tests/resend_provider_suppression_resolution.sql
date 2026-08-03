begin;

create extension if not exists pgtap with schema extensions;

select extensions.plan(27);

select extensions.ok(
  to_regnamespace('email_private') is not null,
  'the owner-only email schema exists'
);
select extensions.ok(
  not has_schema_privilege('anon', 'email_private', 'USAGE')
  and not has_schema_privilege('authenticated', 'email_private', 'USAGE')
  and not has_schema_privilege('service_role', 'email_private', 'USAGE'),
  'no API role can use the owner-only email schema'
);
select extensions.ok(
  not has_function_privilege(
    'anon',
    'email_private.norva_resolve_provider_email_suppression(uuid,text,text,text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'email_private.norva_resolve_provider_email_suppression(uuid,text,text,text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'email_private.norva_resolve_provider_email_suppression(uuid,text,text,text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'email_private.norva_prune_email_suppression_resolution_audit()',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'email_private.norva_prune_email_suppression_resolution_audit()',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'email_private.norva_prune_email_suppression_resolution_audit()',
    'EXECUTE'
  ),
  'no API role can execute private remediation or retention'
);
select extensions.ok(
  not has_table_privilege('service_role', 'public.cloud_email_suppressions', 'UPDATE')
  and not has_table_privilege(
    'service_role',
    'public.cloud_email_suppression_resolution_audit',
    'DELETE'
  )
  and has_function_privilege(
    'service_role',
    'public.norva_prune_resend_delivery_events()',
    'EXECUTE'
  ),
  'service_role keeps only the public prune path and no direct destructive write'
);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
)
values
  (
    '32000000-0000-4000-8000-000000000001',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'provider-good@example.invalid', '',
    now() - interval '10 days',
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
    now(), now()
  ),
  (
    '32000000-0000-4000-8000-000000000002',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'provider-stale@example.invalid', '',
    now() - interval '10 days',
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
    now(), now()
  ),
  (
    '32000000-0000-4000-8000-000000000003',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'provider-complaint@example.invalid', '',
    now() - interval '10 days',
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
    now(), now()
  ),
  (
    '32000000-0000-4000-8000-000000000004',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'provider-bounce@example.invalid', '',
    now() - interval '10 days',
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
    now(), now()
  ),
  (
    '32000000-0000-4000-8000-000000000005',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'provider-later-hard@example.invalid', '',
    now() - interval '10 days',
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
    now(), now()
  ),
  (
    '32000000-0000-4000-8000-000000000006',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'provider-unconfirmed@example.invalid', '',
    null,
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
    now(), now()
  );

insert into public.cloud_email_delivery_events (
  event_id, event_type, provider_email_id, occurred_at, received_at,
  from_email, to_emails, tags, diagnostic_data
)
values
  (
    'evt_provider_good_suppressed', 'email.suppressed',
    '10000000-0000-4000-8000-000000000001',
    now() - interval '10 minutes', now() - interval '10 minutes',
    'Norva <support@norva.tv>', array['provider-good@example.invalid'],
    '{}'::jsonb, '{"reason":"provider"}'::jsonb
  ),
  (
    'evt_provider_good_delivered', 'email.delivered',
    '10000000-0000-4000-8000-000000000002',
    now() - interval '2 minutes', now() - interval '2 minutes',
    'Norva <support@norva.tv>', array['provider-good@example.invalid'],
    '{}'::jsonb, '{}'::jsonb
  ),
  (
    'evt_provider_stale_suppressed', 'email.suppressed',
    '10000000-0000-4000-8000-000000000003',
    now() - interval '26 hours', now() - interval '26 hours',
    'Norva <support@norva.tv>', array['provider-stale@example.invalid'],
    '{}'::jsonb, '{"reason":"provider"}'::jsonb
  ),
  (
    'evt_provider_stale_delivered', 'email.delivered',
    '10000000-0000-4000-8000-000000000004',
    now() - interval '25 hours', now() - interval '25 hours',
    'Norva <support@norva.tv>', array['provider-stale@example.invalid'],
    '{}'::jsonb, '{}'::jsonb
  ),
  (
    'evt_provider_complaint_suppressed', 'email.suppressed',
    '10000000-0000-4000-8000-000000000005',
    now() - interval '10 minutes', now() - interval '10 minutes',
    'Norva <support@norva.tv>', array['provider-complaint@example.invalid'],
    '{}'::jsonb, '{"reason":"provider"}'::jsonb
  ),
  (
    'evt_provider_complaint_delivered', 'email.delivered',
    '10000000-0000-4000-8000-000000000006',
    now() - interval '2 minutes', now() - interval '2 minutes',
    'Norva <support@norva.tv>', array['provider-complaint@example.invalid'],
    '{}'::jsonb, '{}'::jsonb
  ),
  (
    'evt_provider_bounce_source', 'email.bounced',
    '10000000-0000-4000-8000-000000000007',
    now() - interval '10 minutes', now() - interval '10 minutes',
    'Norva <support@norva.tv>', array['provider-bounce@example.invalid'],
    '{}'::jsonb, '{"type":"permanent"}'::jsonb
  ),
  (
    'evt_provider_bounce_delivered', 'email.delivered',
    '10000000-0000-4000-8000-000000000008',
    now() - interval '2 minutes', now() - interval '2 minutes',
    'Norva <support@norva.tv>', array['provider-bounce@example.invalid'],
    '{}'::jsonb, '{}'::jsonb
  ),
  (
    'evt_provider_later_suppressed', 'email.suppressed',
    '10000000-0000-4000-8000-000000000009',
    now() - interval '10 minutes', now() - interval '10 minutes',
    'Norva <support@norva.tv>', array['provider-later-hard@example.invalid'],
    '{}'::jsonb, '{"reason":"provider"}'::jsonb
  ),
  (
    'evt_provider_later_delivered', 'email.delivered',
    '10000000-0000-4000-8000-000000000010',
    now() - interval '2 minutes', now() - interval '2 minutes',
    'Norva <support@norva.tv>', array['provider-later-hard@example.invalid'],
    '{}'::jsonb, '{}'::jsonb
  ),
  (
    'evt_provider_later_bounced', 'email.bounced',
    '10000000-0000-4000-8000-000000000011',
    now() - interval '1 minute', now() - interval '1 minute',
    'Norva <support@norva.tv>', array['provider-later-hard@example.invalid'],
    '{}'::jsonb, '{"type":"permanent"}'::jsonb
  );

insert into public.cloud_email_suppressions (
  email, reason, source_event_id, source_email_id, active,
  first_seen_at, last_seen_at, resolved_at,
  complaint_seen_at, provider_suppression_seen_at
)
values
  (
    'provider-good@example.invalid', 'provider',
    'evt_provider_good_suppressed', '10000000-0000-4000-8000-000000000001', true,
    now() - interval '10 minutes', now() - interval '10 minutes', null,
    null, now() - interval '10 minutes'
  ),
  (
    'provider-stale@example.invalid', 'provider',
    'evt_provider_stale_suppressed', '10000000-0000-4000-8000-000000000003', true,
    now() - interval '26 hours', now() - interval '26 hours', null,
    null, now() - interval '26 hours'
  ),
  (
    'provider-complaint@example.invalid', 'provider',
    'evt_provider_complaint_suppressed', '10000000-0000-4000-8000-000000000005', true,
    now() - interval '10 minutes', now() - interval '10 minutes', null,
    now() - interval '20 minutes', now() - interval '10 minutes'
  ),
  (
    'provider-bounce@example.invalid', 'permanent',
    'evt_provider_bounce_source', '10000000-0000-4000-8000-000000000007', true,
    now() - interval '10 minutes', now() - interval '10 minutes', null,
    null, null
  ),
  (
    'provider-later-hard@example.invalid', 'provider',
    'evt_provider_later_suppressed', '10000000-0000-4000-8000-000000000009', true,
    now() - interval '10 minutes', now() - interval '10 minutes', null,
    null, now() - interval '10 minutes'
  );

create temporary table provider_resolution_result (audit_id uuid not null) on commit drop;
insert into provider_resolution_result (audit_id)
select email_private.norva_resolve_provider_email_suppression(
  '32000000-0000-4000-8000-000000000001',
  'provider-good@example.invalid',
  '10000000-0000-4000-8000-000000000002',
  'Recipient explicitly requested transactional mail after Resend removal.',
  'ops:pgtap'
);

select extensions.is(
  (select count(*)::bigint from provider_resolution_result),
  1::bigint,
  'fresh provider remediation returns one audit id'
);
select extensions.ok(
  exists (
    select 1
    from public.cloud_email_suppressions s
    where s.email = 'provider-good@example.invalid'
      and not s.active
      and s.resolved_at is not null
  ),
  'fresh provider remediation resolves the local suppression'
);
select extensions.ok(
  exists (
    select 1
    from public.cloud_email_suppression_resolution_audit a
    join provider_resolution_result r on r.audit_id = a.id
    where a.verification_method = 'provider_post_remediation_delivery'
      and a.verification_reference =
          'resend_delivery:10000000-0000-4000-8000-000000000002'
      and a.source_event_id = 'evt_provider_good_suppressed'
      and a.source_email_id = '10000000-0000-4000-8000-000000000001'
      and a.user_fingerprint ~ '^[0-9a-f]{64}$'
      and a.user_fingerprint <> '32000000-0000-4000-8000-000000000001'
  ),
  'provider remediation writes minimized source and delivery evidence'
);
select extensions.is(
  (
    select count(*)::bigint
    from public.cloud_email_suppression_resolution_audit
    where source_event_id = 'evt_provider_good_suppressed'
  ),
  1::bigint,
  'the provider suppression source is audited exactly once'
);
select extensions.throws_ok(
  $$
    select email_private.norva_resolve_provider_email_suppression(
      '32000000-0000-4000-8000-000000000001',
      'provider-good@example.invalid',
      '10000000-0000-4000-8000-000000000002',
      'Recipient explicitly requested transactional mail after Resend removal.',
      'ops:pgtap'
    )
  $$,
  'P0002',
  'no active suppression exists for the current address',
  'a serialized retry cannot create a second resolution'
);
select extensions.is(
  (
    select count(*)::bigint
    from public.cloud_email_suppression_resolution_audit
    where source_event_id = 'evt_provider_good_suppressed'
  ),
  1::bigint,
  'a failed retry leaves the append-only audit unchanged'
);

select extensions.throws_ok(
  $$
    select email_private.norva_resolve_provider_email_suppression(
      '32000000-0000-4000-8000-000000000002',
      'provider-stale@example.invalid',
      '10000000-0000-4000-8000-000000000004',
      'Recipient explicitly requested transactional mail after Resend removal.',
      'ops:pgtap'
    )
  $$,
  '22023',
  'delivery evidence must be fresh and cannot be future-dated',
  'delivery evidence older than 24 hours is rejected'
);
select extensions.ok(
  (select active from public.cloud_email_suppressions where email = 'provider-stale@example.invalid'),
  'stale proof leaves the suppression active'
);
select extensions.throws_ok(
  $$
    select email_private.norva_resolve_provider_email_suppression(
      '32000000-0000-4000-8000-000000000002',
      'provider-stale@example.invalid',
      '10000000-0000-4000-8000-000000000002',
      'Recipient explicitly requested transactional mail after Resend removal.',
      'ops:pgtap'
    )
  $$,
  '22023',
  'fresh delivered Resend evidence was not found for the current address',
  'delivery evidence for another recipient is rejected'
);
select extensions.throws_ok(
  $$
    select email_private.norva_resolve_provider_email_suppression(
      '32000000-0000-4000-8000-000000000003',
      'provider-complaint@example.invalid',
      '10000000-0000-4000-8000-000000000006',
      'Recipient explicitly requested transactional mail after Resend removal.',
      'ops:pgtap'
    )
  $$,
  '22023',
  'complaint suppressions cannot be resolved by provider remediation',
  'an observed complaint remains a hard block'
);
select extensions.throws_ok(
  $$
    select email_private.norva_resolve_provider_email_suppression(
      '32000000-0000-4000-8000-000000000004',
      'provider-bounce@example.invalid',
      '10000000-0000-4000-8000-000000000008',
      'Recipient explicitly requested transactional mail after Resend removal.',
      'ops:pgtap'
    )
  $$,
  '22023',
  'suppression is not a provider-level suppression',
  'the provider path cannot clear a permanent bounce'
);
select extensions.throws_ok(
  $$
    select email_private.norva_resolve_provider_email_suppression(
      '32000000-0000-4000-8000-000000000005',
      'provider-later-hard@example.invalid',
      '10000000-0000-4000-8000-000000000010',
      'Recipient explicitly requested transactional mail after Resend removal.',
      'ops:pgtap'
    )
  $$,
  '22023',
  'a newer hard delivery event prevents provider remediation',
  'a hard event newer than the delivered proof prevents resolution'
);
select extensions.throws_ok(
  $$
    select email_private.norva_resolve_provider_email_suppression(
      '32000000-0000-4000-8000-000000000006',
      'provider-unconfirmed@example.invalid',
      '10000000-0000-4000-8000-000000000002',
      'Recipient explicitly requested transactional mail after Resend removal.',
      'ops:pgtap'
    )
  $$,
  '22023',
  'expected address is not the current usable confirmed Auth address',
  'an unconfirmed Auth address cannot use provider remediation'
);

select extensions.lives_ok(
  $$
    select public.norva_record_resend_email_event(
      'evt_provider_good_reactivated',
      'email.suppressed',
      '10000000-0000-4000-8000-000000000012',
      now() - interval '1 minute',
      'Norva <support@norva.tv>',
      array['provider-good@example.invalid'],
      '{}'::jsonb,
      '{"reason":"provider"}'::jsonb
    )
  $$,
  'a later signed provider event can be ingested after remediation'
);

select extensions.ok(
  exists (
    select 1
    from public.cloud_email_suppressions s
    where s.email = 'provider-good@example.invalid'
      and s.active
      and s.resolved_at is null
      and s.source_event_id = 'evt_provider_good_reactivated'
      and s.provider_suppression_seen_at = now() - interval '1 minute'
  ),
  'a later provider event reactivates the safety block'
);
select extensions.is(
  (
    select count(*)::bigint
    from public.cloud_email_suppression_resolution_audit
    where source_event_id = 'evt_provider_good_suppressed'
  ),
  1::bigint,
  'reactivation never mutates or duplicates prior audit evidence'
);

insert into public.cloud_email_suppression_resolution_audit (
  id, user_fingerprint, source_event_id, source_email_id,
  suppression_reason, suppression_first_seen_at, suppression_last_seen_at,
  auth_email_confirmed_at, verification_method, verification_reference,
  verified_at, resolution_reason, operator_actor, resolved_at
)
values
  (
    '33000000-0000-4000-8000-000000000001', repeat('a', 64),
    'evt_retention_expired', '20000000-0000-4000-8000-000000000001',
    'permanent', now() - interval '410 days', now() - interval '409 days',
    now() - interval '500 days', 'verified_mailbox_reply',
    'support_ticket:30000000-0000-4000-8000-000000000001',
    now() - interval '408 days',
    'Expired audit fixture retained until the private retention path runs.',
    'ops:pgtap', now() - interval '401 days'
  ),
  (
    '33000000-0000-4000-8000-000000000002', repeat('b', 64),
    'evt_retention_recent', '20000000-0000-4000-8000-000000000002',
    'permanent', now() - interval '410 days', now() - interval '409 days',
    now() - interval '500 days', 'verified_mailbox_reply',
    'support_ticket:30000000-0000-4000-8000-000000000002',
    now() - interval '398 days',
    'Recent audit fixture must survive the private retention path.',
    'ops:pgtap', now() - interval '399 days'
  );

insert into public.cloud_email_delivery_events (
  event_id, event_type, provider_email_id, occurred_at, received_at,
  from_email, to_emails, tags, diagnostic_data
) values (
  'evt_retention_scrub', 'email.sent',
  '20000000-0000-4000-8000-000000000003',
  now() - interval '100 days', now() - interval '100 days',
  'Norva <support@norva.tv>', array['retention@example.invalid'],
  '{"app":"norva"}'::jsonb, '{"reason":"fixture"}'::jsonb
);

insert into public.cloud_email_delivery_status (
  provider_email_id, from_email, to_emails, tags,
  sent_at, latest_event_type, latest_event_at, latest_diagnostic_data
) values (
  '20000000-0000-4000-8000-000000000003',
  'Norva <support@norva.tv>', array['retention@example.invalid'],
  '{"app":"norva"}'::jsonb, now() - interval '100 days',
  'email.sent', now() - interval '100 days', '{"reason":"fixture"}'::jsonb
);

select extensions.throws_ok(
  $$
    delete from public.cloud_email_suppression_resolution_audit
    where source_event_id = 'evt_retention_expired'
  $$,
  '55000',
  'email suppression resolution audit is append-only',
  'even an expired audit cannot be deleted directly'
);
select extensions.lives_ok(
  $$ select public.norva_prune_resend_delivery_events() $$,
  'the public prune delegates expired audit retention without rollback'
);
select extensions.ok(
  not exists (
    select 1 from public.cloud_email_suppression_resolution_audit
    where source_event_id = 'evt_retention_expired'
  ),
  'private retention deletes only the audit older than 400 days'
);
select extensions.ok(
  exists (
    select 1 from public.cloud_email_suppression_resolution_audit
    where source_event_id = 'evt_retention_recent'
  ),
  'private retention preserves an audit newer than 400 days'
);
select extensions.ok(
  exists (
    select 1 from public.cloud_email_delivery_events
    where event_id = 'evt_retention_scrub'
      and from_email is null
      and cardinality(to_emails) = 0
      and diagnostic_data = '{}'::jsonb
  ),
  'the public prune still scrubs 90-day event PII'
);
select extensions.ok(
  exists (
    select 1 from public.cloud_email_delivery_status
    where provider_email_id = '20000000-0000-4000-8000-000000000003'
      and from_email is null
      and cardinality(to_emails) = 0
      and latest_diagnostic_data = '{}'::jsonb
  ),
  'the public prune still scrubs 90-day status PII'
);

select extensions.ok(
  not exists (
    select 1
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = 'cloud_email_suppression_resolution_audit'
      and c.column_name in ('email', 'user_id')
  ),
  'provider remediation adds no raw address or Auth UUID to the audit'
);

select * from extensions.finish();
rollback;
