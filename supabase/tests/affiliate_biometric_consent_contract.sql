begin;

create extension if not exists pgtap with schema extensions;
select extensions.no_plan();

select extensions.has_table(
  'affiliate_private',
  'affiliate_biometric_consent_attestations',
  'dedicated biometric-consent evidence exists'
);

select extensions.ok(
  (
    select relation.relrowsecurity
    from pg_catalog.pg_class relation
    where relation.oid =
      'affiliate_private.affiliate_biometric_consent_attestations'::regclass
  )
  and not has_table_privilege(
    'anon',
    'affiliate_private.affiliate_biometric_consent_attestations',
    'SELECT'
  )
  and not has_table_privilege(
    'authenticated',
    'affiliate_private.affiliate_biometric_consent_attestations',
    'SELECT'
  )
  and not has_table_privilege(
    'service_role',
    'affiliate_private.affiliate_biometric_consent_attestations',
    'SELECT'
  ),
  'biometric consent evidence is private and RLS protected'
);

select extensions.ok(
  exists (
    select 1
    from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid =
      'affiliate_private.affiliate_biometric_consent_attestations'::regclass
      and constraint_row.conname =
        'affiliate_biometric_consent_version'
      and pg_get_constraintdef(constraint_row.oid)
        like '%partners-biometric-consent-v1%'
  ),
  'the biometric consent contract has an explicit immutable version'
);

select extensions.ok(
  exists (
    select 1
    from pg_catalog.pg_trigger trigger_row
    where trigger_row.tgrelid =
      'affiliate_private.affiliate_biometric_consent_attestations'::regclass
      and trigger_row.tgname =
        'affiliate_biometric_consent_append_only'
      and not trigger_row.tgisinternal
  ),
  'biometric consent evidence is append-only'
);

select extensions.ok(
  has_function_privilege(
    'service_role',
    'public.partners_service_kyc_prepare_v2(uuid,text,text,text,boolean,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.partners_service_kyc_prepare_v2(uuid,text,text,text,boolean,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.partners_service_kyc_prepare_v2(uuid,text,text,text,boolean,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'public.partners_service_kyc_prepare(uuid,text,text,boolean,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.partners_service_kyc_session_record_v2(uuid,text,text,text,integer,text,timestamptz,text,text,text,integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'public.partners_service_kyc_session_record(uuid,text,text,text,integer,text,timestamptz,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'public.partners_service_kyc_session_record(uuid,text,text,text,integer,text,timestamptz,text,text,text,integer)',
    'EXECUTE'
  ),
  'only the Edge service role can prepare v2 consent and cannot bypass through v1'
);

select extensions.throws_ok(
  $$
    select affiliate_private.partners_service_kyc_prepare_v2(
      extensions.gen_random_uuid(),
      'norva.kyc.invalid.0001',
      'partners-disclosure-v1',
      'partners-biometric-consent-v0',
      true,
      'fr'
    )
  $$,
  '22023',
  'invalid versioned biometric consent',
  'an obsolete biometric consent version fails before any KYC mutation'
);

select extensions.throws_ok(
  $$
    select affiliate_private.partners_service_kyc_session_record_v2(
      extensions.gen_random_uuid(),
      'norva.kyc.record.0001',
      'provider-session-opaque',
      'provider-workflow-opaque',
      1,
      'not_started',
      now() + interval '1 hour',
      'kyr_000000000000000000000000',
      'live',
      repeat('1', 64),
      3600
    )
  $$,
  'P0001',
  'versioned biometric consent is required',
  'a provider session cannot be recorded without linked biometric consent'
);

select * from extensions.finish();
rollback;
