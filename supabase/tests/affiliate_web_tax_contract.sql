begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(10);

select extensions.has_table(
  'affiliate_private',
  'affiliate_web_tax_policies',
  'versioned Web tax policy registry exists'
);

select extensions.ok(
  (
    select relation.relrowsecurity
    from pg_class relation
    where relation.oid =
      'affiliate_private.affiliate_web_tax_policies'::regclass
  )
  and not has_table_privilege(
    'service_role',
    'affiliate_private.affiliate_web_tax_policies',
    'SELECT'
  ),
  'private tax policies have RLS and no direct service-role table access'
);

select extensions.ok(
  exists (
    select 1
    from affiliate_private.affiliate_web_tax_policies policy
    where policy.policy_key = 'wtp_fr_usd_owner_v1'
      and policy.status = 'active'
      and policy.country_code = 'FR'
      and policy.currency = 'USD'
      and policy.currency_exponent = 2
      and policy.calculation_mode = 'gross_is_net'
      and policy.tax_rate_bps = 0
      and policy.approved_by_role = 'accountable_owner'
      and not policy.external_review
      and policy.effective_until <= policy.effective_from + interval '90 days'
  ),
  'P0 French Web policy records the bounded internal owner decision exactly'
);

select extensions.ok(
  has_function_privilege(
    'service_role',
    'public.partners_worker_web_tax_resolve(uuid,text,text,text,integer,bigint,text,timestamptz)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.partners_worker_web_tax_resolve(uuid,text,text,text,integer,bigint,text,timestamptz)',
    'EXECUTE'
  ),
  'only the service boundary can resolve authoritative Web tax components'
);

select extensions.ok(
  position(
    'tax_policy_unavailable'
    in pg_get_functiondef(
      'affiliate_private.partners_worker_web_tax_resolve(uuid,text,text,text,integer,bigint,text,timestamptz)'::regprocedure
    )
  ) > 0
  and position(
    'reversal_exceeds_origin'
    in pg_get_functiondef(
      'affiliate_private.partners_worker_web_tax_resolve(uuid,text,text,text,integer,bigint,text,timestamptz)'::regprocedure
    )
  ) > 0,
  'the resolver explicitly fails closed for unsupported policy and over-reversal'
);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
) values
  (
    'f5000000-0000-4000-8000-000000000001',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'web-tax-fr@example.invalid', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
    now(), now()
  ),
  (
    'f5000000-0000-4000-8000-000000000002',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'web-tax-de@example.invalid', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
    now(), now()
  );

insert into public.cloud_revolut_customers (user_id, card_country)
values
  ('f5000000-0000-4000-8000-000000000001', 'FR'),
  ('f5000000-0000-4000-8000-000000000002', 'DE');

select extensions.is(
  affiliate_private.partners_worker_web_tax_resolve(
    'f5000000-0000-4000-8000-000000000001',
    'capture', 'production', 'USD', 2, 499, null,
    '2026-08-05T12:00:00Z'::timestamptz
  ) #>> '{status}',
  'complete',
  'French USD capture resolves under the active exact policy'
);

select extensions.ok(
  (
    select result #>> '{financial,gross_minor}' = '499'
      and result #>> '{financial,tax_minor}' = '0'
      and result #>> '{financial,eligible_minor}' = '499'
      and result #>> '{policy,policy_key}' = 'wtp_fr_usd_owner_v1'
    from (
      select affiliate_private.partners_worker_web_tax_resolve(
        'f5000000-0000-4000-8000-000000000001',
        'renewal', 'production', 'USD', 2, 499, null,
        '2026-08-05T12:01:00Z'::timestamptz
      ) result
    ) resolved
  ),
  'complete Web facts expose exact gross, tax, eligible and policy evidence'
);

select extensions.is(
  affiliate_private.partners_worker_web_tax_resolve(
    'f5000000-0000-4000-8000-000000000002',
    'capture', 'production', 'USD', 2, 499, null,
    '2026-08-05T12:00:00Z'::timestamptz
  ) #>> '{reason}',
  'tax_policy_unavailable',
  'an unsupported country remains incomplete instead of receiving synthetic tax'
);

insert into affiliate_private.affiliate_financial_facts (
  transaction_hash, parent_transaction_hash, referred_user_id,
  attribution_id, rail, event_type, environment, facts_status,
  currency, currency_exponent, gross_minor, discount_minor,
  tax_minor, eligible_minor, occurred_at
) values (
  repeat('a', 64), null,
  'f5000000-0000-4000-8000-000000000001', null,
  'web', 'capture', 'production', 'complete',
  'USD', 2, 499, 0, 0, 499, '2026-08-05T12:00:00Z'
);

select extensions.ok(
  (
    select result #>> '{status}' = 'complete'
      and result #>> '{financial,gross_minor}' = '200'
      and result #>> '{financial,tax_minor}' = '0'
      and result #>> '{financial,eligible_minor}' = '200'
      and result #>> '{policy,calculation_mode}' =
        'origin_proportional_allocation'
    from (
      select affiliate_private.partners_worker_web_tax_resolve(
        'f5000000-0000-4000-8000-000000000001',
        'refund', 'production', 'USD', 2, 200, repeat('a', 64),
        '2026-08-05T12:02:00Z'::timestamptz
      ) result
    ) resolved
  ),
  'refund components derive deterministically from the complete origin fact'
);

select extensions.throws_ok(
  $$
    select affiliate_private.partners_worker_web_tax_resolve(
      'f5000000-0000-4000-8000-000000000001',
      'capture', 'invalid', 'USD', 2, 499, null, now()
    )
  $$,
  '22023',
  'invalid Web tax resolution request',
  'invalid environment is rejected before any monetary calculation'
);

select * from extensions.finish();
rollback;
