begin;

create extension if not exists pgtap with schema extensions;

select extensions.plan(40);

select extensions.ok(
  to_regclass('affiliate_private.affiliate_access_requests') is not null,
  'the private access request table exists'
);
select extensions.ok(
  exists (
    select 1
    from pg_trigger trigger_row
    join pg_class class_row on class_row.oid = trigger_row.tgrelid
    join pg_namespace namespace_row on namespace_row.oid = class_row.relnamespace
    where namespace_row.nspname = 'affiliate_private'
      and class_row.relname = 'affiliate_access_requests'
      and trigger_row.tgname = 'partners_access_decision_email_enqueue'
      and not trigger_row.tgisinternal
  ),
  'the final access-decision transition owns one email trigger'
);
select extensions.ok(
  not has_function_privilege(
    'anon',
    'affiliate_private.partners_access_decision_email_enqueue()',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'affiliate_private.partners_access_decision_email_enqueue()',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'affiliate_private.partners_access_decision_email_enqueue()',
    'EXECUTE'
  ),
  'no API role can execute the private notification trigger directly'
);
select extensions.ok(
  (
    select class_row.relrowsecurity
    from pg_class class_row
    join pg_namespace namespace_row
      on namespace_row.oid = class_row.relnamespace
    where namespace_row.nspname = 'affiliate_private'
      and class_row.relname = 'affiliate_access_requests'
  ),
  'the access request table has RLS enabled'
);
select extensions.ok(
  not has_table_privilege(
    'authenticated',
    'affiliate_private.affiliate_access_requests',
    'SELECT'
  ),
  'authenticated clients cannot read private access requests directly'
);
select extensions.ok(
  not has_table_privilege(
    'service_role',
    'affiliate_private.affiliate_access_requests',
    'SELECT'
  ),
  'the Edge service role reaches access requests only through RPCs'
);
select extensions.ok(
  not has_function_privilege(
    'anon',
    'public.partners_service_access_request_get(uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.partners_service_access_request_get(uuid)',
    'EXECUTE'
  ),
  'browser roles cannot bypass the member access-request Edge boundary'
);
select extensions.ok(
  has_function_privilege(
    'service_role',
    'public.partners_service_access_request_get(uuid)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.partners_service_access_request_submit(uuid,text,text,text)',
    'EXECUTE'
  ),
  'service_role can execute only the sanitized member access-request RPCs'
);
select extensions.ok(
  not has_function_privilege(
    'anon',
    'public.admin_partners_access_request_decide(uuid,text,timestamp with time zone,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'authenticated',
    'public.admin_partners_access_request_decide(uuid,text,timestamp with time zone,text)',
    'EXECUTE'
  ),
  'only authenticated Admin sessions can reach the guarded decision shim'
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
    '21000000-0000-4000-8000-000000000001',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'access-admin@example.invalid',
    '',
    now(),
    '{"provider":"email","providers":["email"],"role":"admin"}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '21000000-0000-4000-8000-000000000002',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'access-member@example.invalid',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '21000000-0000-4000-8000-000000000003',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'access-decline@example.invalid',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '21000000-0000-4000-8000-000000000004',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'access-unconfirmed@example.invalid',
    '',
    null,
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '21000000-0000-4000-8000-000000000005',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'access-existing@example.invalid',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '21000000-0000-4000-8000-000000000006',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'access-support@example.invalid',
    '',
    now(),
    '{"provider":"email","providers":["email"],"role":"admin"}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '21000000-0000-4000-8000-000000000007',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'access-admin-no-capability@example.invalid',
    '',
    now(),
    '{"provider":"email","providers":["email"],"role":"admin"}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  );

insert into auth.mfa_factors (
  id,
  user_id,
  friendly_name,
  factor_type,
  status,
  created_at,
  updated_at,
  secret
)
values (
  '22000000-0000-4000-8000-000000000001',
  '21000000-0000-4000-8000-000000000001',
  'Partners access-request Risk actor',
  'totp',
  'verified',
  now(),
  now(),
  'partners-access-request-test-secret'
);

insert into affiliate_private.affiliate_admin_capabilities (
  user_id,
  capability,
  enabled,
  granted_by_pseudonym,
  justification
)
values
  (
    '21000000-0000-4000-8000-000000000001',
    'support',
    true,
    repeat('a', 64),
    'Access request pgTAP Support fixture.'
  ),
  (
    '21000000-0000-4000-8000-000000000001',
    'risk',
    true,
    repeat('a', 64),
    'Access request pgTAP Risk fixture.'
  ),
  (
    '21000000-0000-4000-8000-000000000006',
    'support',
    true,
    repeat('a', 64),
    'Access request pgTAP isolated Support fixture.'
  );

insert into affiliate_private.affiliate_accounts (
  user_id,
  user_pseudonym,
  account_type,
  status
)
values (
  '21000000-0000-4000-8000-000000000005',
  repeat('b', 64),
  'individual',
  'invited'
);

set local role service_role;

select extensions.is(
  public.partners_service_access_request_get(
    '21000000-0000-4000-8000-000000000002'
  ) #>> '{request,exists}',
  'false',
  'a member with no request gets the exact empty state'
);
select extensions.is(
  public.partners_service_access_request_submit(
    '21000000-0000-4000-8000-000000000002',
    'US',
    null,
    'access.request.000000000001'
  ) ->> 'action',
  'access_requested',
  'a confirmed member can request pilot access while release stays closed'
);
select extensions.is(
  public.partners_service_access_request_submit(
    '21000000-0000-4000-8000-000000000002',
    'US',
    null,
    'access.request.000000000001'
  ) ->> 'replayed',
  'true',
  'an exact retry replays the stored response'
);
select extensions.throws_ok(
  $$
    select public.partners_service_access_request_submit(
      '21000000-0000-4000-8000-000000000002',
      'CA',
      null,
      'access.request.000000000001'
    )
  $$,
  'P0003',
  'idempotency key was reused with another request',
  'an idempotency key cannot be reused for another jurisdiction'
);
select extensions.throws_ok(
  $$
    select public.partners_service_access_request_submit(
      '21000000-0000-4000-8000-000000000002',
      'US',
      null,
      'access.request.000000000002'
    )
  $$,
  'P0008',
  'access request rate limit exceeded',
  'a distinct-key burst is rate limited without creating another request'
);
select extensions.throws_ok(
  $$
    select public.partners_service_access_request_submit(
      '21000000-0000-4000-8000-000000000004',
      'US',
      null,
      'access.request.000000000004'
    )
  $$,
  'P0001',
  'a confirmed user account is required',
  'an unconfirmed user cannot request access'
);
select extensions.throws_ok(
  $$
    select public.partners_service_access_request_submit(
      '21000000-0000-4000-8000-000000000005',
      'US',
      null,
      'access.request.000000000005'
    )
  $$,
  'P0001',
  'an open Partners account already exists',
  'an existing partner cannot create a separate access request'
);
select public.partners_service_access_request_submit(
  '21000000-0000-4000-8000-000000000003',
  'CA',
  null,
  'access.request.000000000003'
);

reset role;

select extensions.is(
  (
    select count(*)::bigint
    from affiliate_private.affiliate_access_requests
    where user_id = '21000000-0000-4000-8000-000000000002'
  ),
  1::bigint,
  'request idempotency creates exactly one private row'
);
select extensions.ok(
  exists (
    select 1
    from affiliate_private.affiliate_events event_row
    where event_row.aggregate_type = 'access_request'
      and event_row.action = 'access_request_submitted'
  ),
  'a submitted request appends a sanitized audit event'
);
select extensions.ok(
  not exists (
    select 1
    from affiliate_private.affiliate_accounts account
    where account.user_id in (
      '21000000-0000-4000-8000-000000000002',
      '21000000-0000-4000-8000-000000000003'
    )
  ),
  'access requests never create affiliate accounts'
);
select extensions.ok(
  not exists (
    select 1
    from affiliate_private.affiliate_pilot_allowlist allowlist_row
    where allowlist_row.user_id in (
      '21000000-0000-4000-8000-000000000002',
      '21000000-0000-4000-8000-000000000003'
    )
  ),
  'member requests never self-authorize the pilot allowlist'
);
select extensions.ok(
  not exists (
    select 1
    from public.admin_feature_flags flag
    where flag.key like 'partners_%'
      and flag.enabled
      and flag.key <> 'partners_cash_pilot_allowlist_only'
  )
  and exists (
    select 1
    from public.admin_feature_flags flag
    where flag.key = 'partners_cash_pilot_allowlist_only'
      and flag.enabled
  )
  and not exists (
    select 1
    from affiliate_private.affiliate_release_gates gate
    where gate.satisfied
  ),
  'request submission leaves every activating flag and gate closed while cash stays restricted'
);

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"21000000-0000-4000-8000-000000000007","role":"authenticated","aal":"aal2","app_metadata":{"role":"admin"}}';

select extensions.throws_ok(
  $$
    select public.admin_partners_access_requests(
      25,
      0,
      'requested',
      null
    )
  $$,
  '42501',
  'Partners Support or Risk capability is required',
  'an Admin without a Partners capability cannot read the queue'
);

set local request.jwt.claims =
  '{"sub":"21000000-0000-4000-8000-000000000006","role":"authenticated","aal":"aal1","app_metadata":{"role":"admin"}}';

select extensions.is(
  public.admin_partners_access_requests(
    25,
    0,
    'requested',
    'access-member@example.invalid'
  ) ->> 'total',
  '1',
  'Support can find a pending request by email without exposing it verbatim'
);
select extensions.ok(
  public.admin_partners_access_requests(
    25,
    0,
    'requested',
    'access-member@example.invalid'
  )::text not like '%access-member@example.invalid%',
  'the Admin list returns only a masked email'
);

set local request.jwt.claims =
  '{"sub":"21000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1","app_metadata":{"role":"admin"}}';
select extensions.throws_ok(
  $$
    select public.admin_partners_access_request_decide(
      (
        public.admin_partners_access_requests(
          1,
          0,
          'requested',
          'access-member@example.invalid'
        ) #>> '{items,0,request_id}'
      )::uuid,
      'approve',
      now() + interval '7 days',
      'Approve the supervised Partners access-request fixture.'
    )
  $$,
  '42501',
  'Partners access request decision requires AAL2',
  'Risk cannot decide a request from an AAL1 session'
);

reset role;

select public.norva_enqueue_branded_email(
  'access-member@example.invalid',
  'Your Norva Partners access is approved',
  'Welcome to Norva Partners',
  'Your early-access request has been approved. Open Norva Partners to review the current programme conditions. Approval does not create a partner account, start identity verification or enable payouts; those steps become available only when your pilot cohort opens.',
  'Open Norva Partners',
  'https://norva.tv/app#partners',
  'Norva never asks you to pay to join Partners. If you did not request access, contact support@norva.tv.',
  'partners_access_approved',
  'partners_access_decision:' || (
    select request_row.id::text
    from affiliate_private.affiliate_access_requests request_row
    where request_row.user_id = '21000000-0000-4000-8000-000000000002'
  ),
  '21000000-0000-4000-8000-000000000002'
);

update public.cloud_branded_email_outbox outbox_row
set next_attempt_at = 'infinity'::timestamptz
where outbox_row.dedupe_key = 'partners_access_decision:' || (
  select request_row.id::text
  from affiliate_private.affiliate_access_requests request_row
  where request_row.user_id = '21000000-0000-4000-8000-000000000002'
);

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"21000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2","app_metadata":{"role":"admin"}}';

select extensions.throws_ok(
  $$
    select public.admin_partners_access_request_decide(
      (
        public.admin_partners_access_requests(
          1,
          0,
          'requested',
          'access-member@example.invalid'
        ) #>> '{items,0,request_id}'
      )::uuid,
      'approve',
      now() + interval '7 days',
      'Reject a deferred transactional outbox collision.'
    )
  $$,
  'P0001',
  'Partners access decision email mismatch',
  'a same-identity outbox row that is not worker-claimable aborts approval'
);

reset role;

select extensions.ok(
  exists (
    select 1
    from affiliate_private.affiliate_access_requests request_row
    where request_row.user_id = '21000000-0000-4000-8000-000000000002'
      and request_row.status = 'requested'
  )
  and not exists (
    select 1
    from affiliate_private.affiliate_pilot_allowlist allowlist_row
    where allowlist_row.user_id = '21000000-0000-4000-8000-000000000002'
  )
  and not exists (
    select 1
    from affiliate_private.affiliate_events event_row
    where event_row.aggregate_type = 'access_request'
      and event_row.action = 'access_request_decided'
      and event_row.aggregate_key = (
        select request_row.id::text
        from affiliate_private.affiliate_access_requests request_row
        where request_row.user_id = '21000000-0000-4000-8000-000000000002'
      )
  ),
  'an email envelope conflict rolls back approval, allowlist and decision audit'
);

delete from public.cloud_branded_email_outbox outbox_row
where outbox_row.dedupe_key = 'partners_access_decision:' || (
  select request_row.id::text
  from affiliate_private.affiliate_access_requests request_row
  where request_row.user_id = '21000000-0000-4000-8000-000000000002'
);

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"21000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2","app_metadata":{"role":"admin"}}';

select extensions.is(
  public.admin_partners_access_request_decide(
    (
      public.admin_partners_access_requests(
        1,
        0,
        'requested',
        'access-member@example.invalid'
      ) #>> '{items,0,request_id}'
    )::uuid,
    'approve',
    now() + interval '7 days',
    'Approve the supervised Partners access-request fixture.'
  ) ->> 'status',
  'approved',
  'Risk with AAL2 can approve a request'
);
select extensions.is(
  public.admin_partners_access_request_decide(
    (
      public.admin_partners_access_requests(
        1,
        0,
        'approved',
        'access-member@example.invalid'
      ) #>> '{items,0,request_id}'
    )::uuid,
    'approve',
    now() + interval '7 days',
    'Replay the supervised Partners access-request decision.'
  ) ->> 'changed',
  'false',
  'repeating the same decision is idempotent'
);

select extensions.is(
  public.admin_partners_access_request_decide(
    (
      public.admin_partners_access_requests(
        1,
        0,
        'requested',
        'access-decline@example.invalid'
      ) #>> '{items,0,request_id}'
    )::uuid,
    'decline',
    null,
    'Decline the supervised Partners access-request fixture.'
  ) ->> 'status',
  'declined',
  'Risk with AAL2 can decline a request'
);

reset role;

select extensions.ok(
  exists (
    select 1
    from affiliate_private.affiliate_pilot_allowlist allowlist_row
    where allowlist_row.user_id = '21000000-0000-4000-8000-000000000002'
      and allowlist_row.status = 'active'
  ),
  'approval atomically creates the audited pilot allowlist entry'
);
select extensions.ok(
  not exists (
    select 1
    from affiliate_private.affiliate_pilot_allowlist allowlist_row
    where allowlist_row.user_id = '21000000-0000-4000-8000-000000000003'
  ),
  'declining a request never creates an allowlist entry'
);
select extensions.ok(
  exists (
    select 1
    from affiliate_private.affiliate_events event_row
    where event_row.aggregate_type = 'access_request'
      and event_row.action = 'access_request_decided'
      and event_row.actor_type = 'admin'
  ),
  'Admin decisions append a distinct access-request audit event'
);
select extensions.is(
  (
    select count(*)::bigint
    from public.cloud_branded_email_outbox outbox_row
    where outbox_row.flow in (
      'partners_access_approved',
      'partners_access_declined'
    )
  ),
  2::bigint,
  'approval and decline each enqueue one transactional email'
);
select extensions.is(
  (
    select count(*)::bigint
    from public.cloud_branded_email_outbox outbox_row
    where outbox_row.dedupe_key = 'partners_access_decision:' || (
      select request_row.id::text
      from affiliate_private.affiliate_access_requests request_row
      where request_row.user_id = '21000000-0000-4000-8000-000000000002'
    )
  ),
  1::bigint,
  'replaying an approval does not duplicate its email'
);
select extensions.ok(
  exists (
    select 1
    from public.cloud_branded_email_outbox outbox_row
    where outbox_row.flow = 'partners_access_approved'
      and outbox_row.user_id = '21000000-0000-4000-8000-000000000002'
      and outbox_row.recipient_email = 'access-member@example.invalid'
      and outbox_row.state = 'pending'
      and outbox_row.request_html like '%https://norva.tv/app#partners%'
  )
  and exists (
    select 1
    from public.cloud_branded_email_outbox outbox_row
    where outbox_row.flow = 'partners_access_declined'
      and outbox_row.user_id = '21000000-0000-4000-8000-000000000003'
      and outbox_row.recipient_email = 'access-decline@example.invalid'
      and outbox_row.state = 'pending'
  ),
  'decision emails target the current confirmed user and the Partners route'
);
select extensions.ok(
  not exists (
    select 1
    from public.cloud_branded_email_outbox outbox_row
    where outbox_row.flow in (
      'partners_access_approved',
      'partners_access_declined'
    )
      and (
        outbox_row.request_html ilike '%supervised Partners access-request fixture%'
        or outbox_row.request_text ilike '%supervised Partners access-request fixture%'
      )
  ),
  'internal Admin justification is never exposed in user email copy'
);
select extensions.ok(
  not exists (
    select 1
    from public.cloud_branded_email_outbox outbox_row
    where outbox_row.flow in (
      'partners_access_approved',
      'partners_access_declined'
    )
      and (
        outbox_row.is_marketing
        or outbox_row.marker_kind is not null
        or outbox_row.request_from <> 'Norva <support@norva.tv>'
        or outbox_row.request_reply_to <> 'support@norva.tv'
        or concat(
          outbox_row.request_html,
          outbox_row.request_text,
          outbox_row.request_tags::text
        ) ilike any (array[
          '%access-admin@example.invalid%',
          '%21000000-0000-4000-8000-000000000001%',
          '%supervised Partners access-request fixture%'
        ])
      )
  ),
  'decision emails remain transactional and contain no Admin identity or rationale'
);

delete from public.cloud_branded_email_outbox outbox_row
where outbox_row.dedupe_key = 'partners_access_decision:' || (
  select request_row.id::text
  from affiliate_private.affiliate_access_requests request_row
  where request_row.user_id = '21000000-0000-4000-8000-000000000002'
);

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"21000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2","app_metadata":{"role":"admin"}}';

select public.admin_partners_access_request_decide(
  (
    public.admin_partners_access_requests(
      1,
      0,
      'approved',
      'access-member@example.invalid'
    ) #>> '{items,0,request_id}'
  )::uuid,
  'approve',
  now() + interval '7 days',
  'Replay after simulated outbox retention without sending again.'
);

reset role;

select extensions.ok(
  not exists (
    select 1
    from public.cloud_branded_email_outbox outbox_row
    where outbox_row.dedupe_key = 'partners_access_decision:' || (
      select request_row.id::text
      from affiliate_private.affiliate_access_requests request_row
      where request_row.user_id = '21000000-0000-4000-8000-000000000002'
    )
  ),
  'a replay cannot resend an approval after the outbox retention window'
);
select extensions.ok(
  not exists (
    select 1
    from public.admin_feature_flags flag
    where flag.key like 'partners_%'
      and flag.enabled
      and flag.key <> 'partners_cash_pilot_allowlist_only'
  )
  and exists (
    select 1
    from public.admin_feature_flags flag
    where flag.key = 'partners_cash_pilot_allowlist_only'
      and flag.enabled
  ),
  'approval leaves all activating programme and payout flags disabled'
);

select * from extensions.finish();

rollback;
