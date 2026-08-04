begin;

create extension if not exists pgtap with schema extensions;
select extensions.no_plan();

select extensions.ok(
  to_regclass(
    'affiliate_private.affiliate_member_write_reservations'
  ) is not null
  and (
    select relation.relrowsecurity
    from pg_catalog.pg_class relation
    where relation.oid =
      'affiliate_private.affiliate_member_write_reservations'::regclass
  ),
  'member write reservations are private and protected by RLS'
);

select extensions.ok(
  not has_table_privilege(
    'service_role',
    'affiliate_private.affiliate_member_write_reservations',
    'SELECT'
  )
  and not has_table_privilege(
    'authenticated',
    'affiliate_private.affiliate_member_write_reservations',
    'SELECT'
  )
  and not has_table_privilege(
    'anon',
    'affiliate_private.affiliate_member_write_reservations',
    'SELECT'
  ),
  'no API role can read the durable reservation ledger directly'
);

select extensions.ok(
  has_function_privilege(
    'service_role',
    'public.partners_service_member_write_reserve(uuid,text,text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.partners_service_member_write_reserve(uuid,text,text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.partners_service_member_write_reserve(uuid,text,text,text)',
    'EXECUTE'
  ),
  'only the JWT-verifying service-role Edge can reserve member writes'
);

select extensions.ok(
  lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_member_write_reserve(uuid,text,text,text)'::regprocedure
  )) like '%norva:partners:member-write:%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_member_write_reserve(uuid,text,text,text)'::regprocedure
  )) like '%p_user_id::text%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_member_write_reserve(uuid,text,text,text)'::regprocedure
  )) like '%v_operation%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_member_write_reserve(uuid,text,text,text)'::regprocedure
  )) like '%interval ''24 hours''%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_member_write_reserve(uuid,text,text,text)'::regprocedure
  )) like '%v_limit constant integer := 8%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_member_write_reserve(uuid,text,text,text)'::regprocedure
  )) like '%errcode = ''p0008''%',
  'reservation serializes user plus operation and enforces a rolling daily counter'
);

select extensions.ok(
  lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_member_write_reserve(uuid,text,text,text)'::regprocedure
  )) like '%when ''membership_join'' then 4%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_member_write_reserve(uuid,text,text,text)'::regprocedure
  )) like '%when ''link_rotation'' then 4%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_member_write_reserve(uuid,text,text,text)'::regprocedure
  )) like '%when ''payout_country_bind'' then 8%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_member_write_reserve(uuid,text,text,text)'::regprocedure
  )) like '%when ''access_credit_quote'' then 24%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_member_write_reserve(uuid,text,text,text)'::regprocedure
  )) like '%when ''access_credit_redeem'' then 12%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_member_write_reserve(uuid,text,text,text)'::regprocedure
  )) like '%interval ''30 days''%',
  'frictionless member writes have explicit quotas and bounded local retention'
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
  '23000000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated',
  'authenticated',
  'member-write-limit@example.invalid',
  '',
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb,
  now(),
  now()
);

set local role service_role;

select extensions.is(
  public.partners_service_member_write_reserve(
    '23000000-0000-4000-8000-000000000001',
    'fiscal_profile_self_attestation',
    'fiscal.limit.00000001',
    repeat('a', 64)
  ),
  jsonb_build_object(
    'schema_version', 1,
    'action', 'member_write_reserved',
    'operation', 'fiscal_profile_self_attestation',
    'replayed', false,
    'limit', 8,
    'used', 1,
    'remaining', 7,
    'window_seconds', 86400
  ),
  'the first distinct fiscal key reserves one durable counter slot'
);

select extensions.is(
  public.partners_service_member_write_reserve(
    '23000000-0000-4000-8000-000000000001',
    'fiscal_profile_self_attestation',
    'fiscal.limit.00000001',
    repeat('a', 64)
  ) ->> 'replayed',
  'true',
  'an exact retry replays without consuming another slot'
);

select extensions.throws_ok(
  $$
    select public.partners_service_member_write_reserve(
      '23000000-0000-4000-8000-000000000001',
      'fiscal_profile_self_attestation',
      'fiscal.limit.00000001',
      repeat('b', 64)
    )
  $$,
  'P0003',
  'idempotency key was reused with another request',
  'a replay key cannot be repurposed for another normalized request'
);

select extensions.is(
  (
    select count(*)
    from generate_series(2, 8) series(value)
    where public.partners_service_member_write_reserve(
      '23000000-0000-4000-8000-000000000001',
      'fiscal_profile_self_attestation',
      'fiscal.limit.' || lpad(series.value::text, 8, '0'),
      repeat(to_hex(series.value), 64 / length(to_hex(series.value)))
    ) ->> 'action' = 'member_write_reserved'
  ),
  7::bigint,
  'seven further distinct fiscal keys fill the daily quota'
);

select extensions.throws_ok(
  $$
    select public.partners_service_member_write_reserve(
      '23000000-0000-4000-8000-000000000001',
      'fiscal_profile_self_attestation',
      'fiscal.limit.00000009',
      repeat('9', 64)
    )
  $$,
  'P0008',
  'Partners fiscal or payout onboarding rate limit exceeded',
  'the ninth distinct fiscal key is rejected for Edge mapping to HTTP 429'
);

select extensions.is(
  public.partners_service_member_write_reserve(
    '23000000-0000-4000-8000-000000000001',
    'fiscal_profile_self_attestation',
    'fiscal.limit.00000001',
    repeat('a', 64)
  ) ->> 'replayed',
  'true',
  'an exact replay remains available after the distinct-key quota is full'
);

select extensions.is(
  public.partners_service_member_write_reserve(
    '23000000-0000-4000-8000-000000000001',
    'payout_onboarding',
    'payout.limit.00000001',
    repeat('c', 64)
  ) ->> 'used',
  '1',
  'payout onboarding has an independent per-operation counter'
);

select extensions.is(
  public.partners_service_member_write_reserve(
    '23000000-0000-4000-8000-000000000001',
    'link_rotation',
    'link.limit.00000001',
    repeat('d', 64)
  ) ->> 'limit',
  '4',
  'link rotation publishes its exact four-per-day contract'
);

select extensions.is(
  (
    select count(*)
    from generate_series(2, 4) series(value)
    where public.partners_service_member_write_reserve(
      '23000000-0000-4000-8000-000000000001',
      'link_rotation',
      'link.limit.' || lpad(series.value::text, 8, '0'),
      repeat(substr(md5(series.value::text), 1, 1), 64)
    ) ->> 'action' = 'member_write_reserved'
  ),
  3::bigint,
  'three further link keys fill the independent daily quota'
);

select extensions.throws_ok(
  $$
    select public.partners_service_member_write_reserve(
      '23000000-0000-4000-8000-000000000001',
      'link_rotation',
      'link.limit.00000005',
      repeat('e', 64)
    )
  $$,
  'P0008',
  'Partners member write rate limit exceeded',
  'the fifth link rotation is rejected for Edge mapping to HTTP 429'
);

select extensions.is(
  public.partners_service_member_write_reserve(
    '23000000-0000-4000-8000-000000000001',
    'link_rotation',
    'link.limit.00000001',
    repeat('d', 64)
  ) ->> 'replayed',
  'true',
  'an exact link replay remains available after the quota is full'
);

select extensions.throws_ok(
  $$
    select public.partners_service_fiscal_profile_self_attest(
      '23000000-0000-4000-8000-000000000001',
      'FR',
      'partners-tax-self-certification-v1',
      true,
      'fiscal.limit.00000001'
    )
  $$,
  'P1001',
  'Partners membership is required for KYC',
  'cash onboarding rejects a non-member after the separate reservation'
);

reset role;

select extensions.is(
  (
    select count(*)
    from affiliate_private.affiliate_member_write_reservations reservation
    where reservation.user_id =
      '23000000-0000-4000-8000-000000000001'
      and reservation.operation = 'fiscal_profile_self_attestation'
  ),
  8::bigint,
  'invalid account state does not roll back the separately reserved Edge quota'
);

select * from extensions.finish();
rollback;
