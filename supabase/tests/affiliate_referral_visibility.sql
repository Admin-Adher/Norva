begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(29);

select extensions.ok(
  to_regprocedure(
    'affiliate_private.partners_service_referral_visibility(uuid,integer,text)'
  ) is not null,
  'the private referral visibility projection exists'
);

select extensions.ok(
  to_regprocedure(
    'public.partners_service_referral_visibility(uuid,integer,text)'
  ) is not null,
  'the service-role pagination shim exists'
);

select extensions.is(
  (
    select pg_catalog.pg_get_userbyid(routine.proowner)
    from pg_catalog.pg_proc routine
    where routine.oid = to_regprocedure(
      'affiliate_private.partners_service_referral_visibility(uuid,integer,text)'
    )
  ),
  'supabase_admin',
  'the referral visibility projection retains the migration owner'
);

select extensions.is(
  (
    select pg_catalog.pg_get_userbyid(routine.proowner)
    from pg_catalog.pg_proc routine
    where routine.oid = to_regprocedure(
      'public.partners_service_referral_visibility(uuid,integer,text)'
    )
  ),
  'supabase_admin',
  'the pagination shim retains the migration owner'
);

select extensions.ok(
  (
    select routine.prosecdef
      and routine.provolatile = 's'::"char"
      and 'search_path=""' = any(
        coalesce(routine.proconfig, '{}'::text[])
      )
    from pg_catalog.pg_proc routine
    where routine.oid = to_regprocedure(
      'affiliate_private.partners_service_referral_visibility(uuid,integer,text)'
    )
  ),
  'the private projection is stable, security-definer and path-pinned'
);

select extensions.ok(
  (
    select not routine.prosecdef
      and routine.provolatile = 's'::"char"
      and 'search_path=""' = any(
        coalesce(routine.proconfig, '{}'::text[])
      )
    from pg_catalog.pg_proc routine
    where routine.oid = to_regprocedure(
      'public.partners_service_referral_visibility(uuid,integer,text)'
    )
  ),
  'the public pagination shim is stable, invoker-rights and path-pinned'
);

select extensions.ok(
  not has_function_privilege(
    'anon',
    'affiliate_private.partners_service_referral_visibility(uuid,integer,text)',
    'EXECUTE'
  ),
  'anon cannot enumerate a member referral list'
);

select extensions.ok(
  not has_function_privilege(
    'authenticated',
    'affiliate_private.partners_service_referral_visibility(uuid,integer,text)',
    'EXECUTE'
  ),
  'authenticated clients cannot call the private projection directly'
);

select extensions.ok(
  has_function_privilege(
    'service_role',
    'affiliate_private.partners_service_referral_visibility(uuid,integer,text)',
    'EXECUTE'
  ),
  'service_role can project referrals for the authenticated account boundary'
);

select extensions.ok(
  not has_function_privilege(
    'anon',
    'public.partners_service_referral_visibility(uuid,integer,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.partners_service_referral_visibility(uuid,integer,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.partners_service_referral_visibility(uuid,integer,text)',
    'EXECUTE'
  ),
  'only service_role can cross the exposed pagination shim'
);

select extensions.ok(
  not has_function_privilege(
    'anon',
    'public.partners_service_dashboard_v2(uuid,integer,text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.partners_service_dashboard_v2(uuid,integer,text,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.partners_service_dashboard_v2(uuid,integer,text,text)',
    'EXECUTE'
  ),
  'the public dashboard shim remains service-role only'
);

select extensions.ok(
  position(
    'auth.users'
    in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
      'affiliate_private.partners_service_referral_visibility(uuid,integer,text)'
    )))
  ) > 0
  and position(
    'referred_user.email'
    in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
      'affiliate_private.partners_service_referral_visibility(uuid,integer,text)'
    )))
  ) > 0
  and position(
    '''masked_email'''
    in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
      'affiliate_private.partners_service_referral_visibility(uuid,integer,text)'
    )))
  ) > 0
  and position(
    '''referred_user_id'''
    in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
      'affiliate_private.partners_service_referral_visibility(uuid,integer,text)'
    )))
  ) = 0,
  'the private projection derives only a masked e-mail and never serializes a referred user identifier'
);

select extensions.ok(
  position(
    'limit p_limit + 1'
    in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
      'affiliate_private.partners_service_referral_visibility(uuid,integer,text)'
    )))
  ) > 0
  and position(
    'extensions.digest'
    in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
      'affiliate_private.partners_service_referral_visibility(uuid,integer,text)'
    )))
  ) > 0,
  'the projection is bounded and exposes only opaque referral keys'
);

select extensions.throws_ok(
  $$
    select affiliate_private.partners_service_referral_visibility(
      null::uuid,
      20,
      null
    )
  $$,
  '22023',
  'invalid Partners referral visibility request',
  'a missing authenticated user boundary fails closed'
);

select extensions.throws_ok(
  $$
    select affiliate_private.partners_service_referral_visibility(
      '41000000-0000-4000-8000-000000000099',
      51,
      null
    )
  $$,
  '22023',
  'invalid Partners referral visibility request',
  'an oversized page fails closed'
);

select extensions.throws_ok(
  $$
    select affiliate_private.partners_service_referral_visibility(
      '41000000-0000-4000-8000-000000000099',
      20,
      'raw-account-id'
    )
  $$,
  '22023',
  'invalid Partners referral visibility request',
  'a non-opaque continuation cursor fails closed'
);

select extensions.is(
  affiliate_private.partners_service_referral_visibility(
    '41000000-0000-4000-8000-000000000099',
    20,
    null
  ),
  '{"total":0,"items":[],"next_cursor":null}'::jsonb,
  'an account with no Partners membership receives an exact empty projection'
);

-- The fixture deliberately bypasses lifecycle triggers while retaining every
-- relational and CHECK constraint. These tests exercise only the read model;
-- lifecycle transition coverage remains in affiliate_p0.sql.
set local session_replication_role = replica;

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
    '41000000-0000-4000-8000-000000000001',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'visibility-referrer@example.invalid',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '41000000-0000-4000-8000-000000000002',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'first.friend@example.invalid',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '41000000-0000-4000-8000-000000000003',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'hefex15454@careney.com',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '41000000-0000-4000-8000-000000000004',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    null,
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  );

insert into affiliate_private.affiliate_program_versions (
  id,
  version_key,
  status,
  commission_rate_bps,
  attribution_window_days,
  maturation_days,
  payout_thresholds,
  terms_version,
  disclosure_version
)
values (
  '42000000-0000-4000-8000-000000000001',
  'referral-visibility-pgtap-v1',
  'draft',
  2000,
  30,
  45,
  '{"USD":1000}'::jsonb,
  'partners-terms-v1',
  'partners-disclosure-v1'
);

insert into affiliate_private.affiliate_accounts (
  id,
  user_id,
  user_pseudonym,
  status,
  program_version_id
)
values (
  '43000000-0000-4000-8000-000000000001',
  '41000000-0000-4000-8000-000000000001',
  repeat('a', 64),
  'invited',
  '42000000-0000-4000-8000-000000000001'
);

insert into affiliate_private.affiliate_links (
  id,
  account_id,
  public_code
)
values (
  '44000000-0000-4000-8000-000000000001',
  '43000000-0000-4000-8000-000000000001',
  'ReferralVisibilityPgTapCode00000'
);

insert into affiliate_private.affiliate_link_claims (
  id,
  claim_hash,
  link_id,
  referrer_account_id,
  program_version_id,
  commission_rate_bps,
  attribution_window_days,
  network_hash,
  user_agent_hash,
  issued_at,
  expires_at
)
values
  (
    '45000000-0000-4000-8000-000000000001',
    repeat('b', 64),
    '44000000-0000-4000-8000-000000000001',
    '43000000-0000-4000-8000-000000000001',
    '42000000-0000-4000-8000-000000000001',
    2000,
    30,
    repeat('c', 64),
    repeat('d', 64),
    now() - interval '3 days',
    now() + interval '27 days'
  ),
  (
    '45000000-0000-4000-8000-000000000002',
    repeat('e', 64),
    '44000000-0000-4000-8000-000000000001',
    '43000000-0000-4000-8000-000000000001',
    '42000000-0000-4000-8000-000000000001',
    2000,
    30,
    repeat('f', 64),
    repeat('0', 64),
    now() - interval '2 days',
    now() + interval '28 days'
  ),
  (
    '45000000-0000-4000-8000-000000000003',
    repeat('1', 64),
    '44000000-0000-4000-8000-000000000001',
    '43000000-0000-4000-8000-000000000001',
    '42000000-0000-4000-8000-000000000001',
    2000,
    30,
    repeat('2', 64),
    repeat('3', 64),
    now() - interval '1 day',
    now() + interval '29 days'
  );

insert into affiliate_private.affiliate_attributions (
  id,
  referred_user_id,
  referrer_account_id,
  link_id,
  claim_id,
  program_version_id,
  commission_rate_bps,
  attribution_window_days,
  status,
  attributed_at,
  created_at
)
values
  (
    '46000000-0000-4000-8000-000000000001',
    '41000000-0000-4000-8000-000000000002',
    '43000000-0000-4000-8000-000000000001',
    '44000000-0000-4000-8000-000000000001',
    '45000000-0000-4000-8000-000000000001',
    '42000000-0000-4000-8000-000000000001',
    2000,
    30,
    'attributed',
    now() - interval '3 days',
    now() - interval '3 days'
  ),
  (
    '46000000-0000-4000-8000-000000000002',
    '41000000-0000-4000-8000-000000000003',
    '43000000-0000-4000-8000-000000000001',
    '44000000-0000-4000-8000-000000000001',
    '45000000-0000-4000-8000-000000000002',
    '42000000-0000-4000-8000-000000000001',
    2000,
    30,
    'attributed',
    now() - interval '2 days',
    now() - interval '2 days'
  ),
  (
    '46000000-0000-4000-8000-000000000003',
    '41000000-0000-4000-8000-000000000004',
    '43000000-0000-4000-8000-000000000001',
    '44000000-0000-4000-8000-000000000001',
    '45000000-0000-4000-8000-000000000003',
    '42000000-0000-4000-8000-000000000001',
    2000,
    30,
    'held',
    now() - interval '1 day',
    now() - interval '1 day'
  );

insert into affiliate_private.affiliate_financial_facts (
  id,
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
  tax_minor,
  eligible_minor,
  occurred_at
)
values (
  '47000000-0000-4000-8000-000000000001',
  encode(extensions.digest('visibility-payment', 'sha256'), 'hex'),
  '41000000-0000-4000-8000-000000000003',
  '46000000-0000-4000-8000-000000000002',
  'web',
  'capture',
  'production',
  'complete',
  'USD',
  2,
  5000,
  0,
  5000,
  now() - interval '1 day 12 hours'
);

set local session_replication_role = origin;

create temporary table referral_visibility_test_result (
  page_name text primary key,
  payload jsonb not null
) on commit drop;

insert into referral_visibility_test_result (page_name, payload)
select
  'first',
  affiliate_private.partners_service_referral_visibility(
    '41000000-0000-4000-8000-000000000001',
    2,
    null
  );

insert into referral_visibility_test_result (page_name, payload)
select
  'second',
  affiliate_private.partners_service_referral_visibility(
    '41000000-0000-4000-8000-000000000001',
    2,
    'referral_00000000000000000002'
  );

select extensions.is(
  (
    select (payload ->> 'total')::integer
    from referral_visibility_test_result
    where page_name = 'first'
  ),
  3,
  'the projection counts every referred account'
);

select extensions.is(
  (
    select jsonb_array_length(payload -> 'items')
    from referral_visibility_test_result
    where page_name = 'first'
  ),
  2,
  'the first page respects its requested page size'
);

select extensions.ok(
  not exists (
    select 1
    from referral_visibility_test_result result
    cross join lateral jsonb_array_elements(
      result.payload -> 'items'
    ) item
    where (
      select count(*)
      from jsonb_object_keys(item) key_name
    ) <> 7
      or exists (
        select 1
        from jsonb_object_keys(item) key_name
        where key_name not in (
          'key',
          'label_number',
          'masked_email',
          'status',
          'attributed_at',
          'first_eligible_payment_at',
          'next_maturation_at'
        )
      )
  ),
  'each referral item has the exact public contract'
);

select extensions.is(
  (
    select jsonb_agg((item ->> 'label_number')::integer order by ordinal)
    from referral_visibility_test_result result
    cross join lateral jsonb_array_elements(result.payload -> 'items')
      with ordinality page(item, ordinal)
    where result.page_name = 'first'
  ),
  '[3,2]'::jsonb,
  'the first page is newest-first with stable display numbers'
);

select extensions.is(
  (
    select jsonb_agg(item ->> 'status' order by ordinal)
    from referral_visibility_test_result result
    cross join lateral jsonb_array_elements(result.payload -> 'items')
      with ordinality page(item, ordinal)
    where result.page_name = 'first'
  ),
  '["held","payment_recorded"]'::jsonb,
  'the first page exposes held and payment progress without identity'
);

select extensions.is(
  (
    select jsonb_agg(item -> 'masked_email' order by ordinal)
    from referral_visibility_test_result result
    cross join lateral jsonb_array_elements(result.payload -> 'items')
      with ordinality page(item, ordinal)
    where result.page_name = 'first'
  ),
  '[null,"he••••54@ca••••ey.com"]'::jsonb,
  'the recognition hint is strictly masked and absent when Auth has no e-mail'
);

select extensions.ok(
  (
      select count(distinct item ->> 'key') = 3
      and bool_and((item ->> 'key') ~ '^ref_[0-9a-f]{24}$')
      and bool_and(
        item ->> 'masked_email' is null
        or item ->> 'masked_email'
          ~ '^[^@]*••[^@]*@[^.]*••[^.]*\.[a-z0-9-]{2,63}$'
      )
      and string_agg(result.payload::text, '')
        not like '%hefex15454@careney.com%'
      and string_agg(result.payload::text, '')
        not like '%first.friend@example.invalid%'
      and string_agg(result.payload::text, '') not like '%41000000-%'
      and string_agg(result.payload::text, '') not like '%46000000-%'
    from referral_visibility_test_result result
    cross join lateral jsonb_array_elements(result.payload -> 'items') item
  ),
  'opaque keys are unique and the payload contains no full fixture identity'
);

select extensions.ok(
  (
    select
      payload -> 'items' -> 0 -> 'first_eligible_payment_at' = 'null'::jsonb
      and payload -> 'items' -> 1 ->> 'first_eligible_payment_at' is not null
    from referral_visibility_test_result
    where page_name = 'first'
  ),
  'only the eligible payment on the first page has a payment date'
);

select extensions.is(
  (
    select payload ->> 'next_cursor'
    from referral_visibility_test_result
    where page_name = 'first'
  ),
  'referral_00000000000000000002',
  'the continuation cursor is opaque and bound to the last emitted display number'
);

select extensions.is(
  (
    select jsonb_agg((item ->> 'label_number')::integer order by ordinal)
    from referral_visibility_test_result result
    cross join lateral jsonb_array_elements(result.payload -> 'items')
      with ordinality page(item, ordinal)
    where result.page_name = 'second'
  ),
  '[1]'::jsonb,
  'the next page continues without repeating an earlier referral'
);

select extensions.ok(
  (
    select
      payload -> 'items' -> 0 ->> 'status' = 'signed_up'
      and payload -> 'items' -> 0 ->> 'masked_email'
        = 'fi••••nd@ex••••le.invalid'
      and payload -> 'items' -> 0 -> 'first_eligible_payment_at' = 'null'::jsonb
      and payload -> 'next_cursor' = 'null'::jsonb
    from referral_visibility_test_result
    where page_name = 'second'
  ),
  'the final page exposes sign-up progress and terminates pagination'
);

select extensions.is(
  (
    select count(distinct item ->> 'label_number')::integer
    from referral_visibility_test_result result
    cross join lateral jsonb_array_elements(result.payload -> 'items') item
  ),
  3,
  'following every continuation yields the complete referral list exactly once'
);

select * from extensions.finish();
rollback;
