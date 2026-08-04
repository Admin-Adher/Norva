begin;

create extension if not exists pgtap with schema extensions;
select extensions.no_plan();

select extensions.has_table(
  'affiliate_private',
  'affiliate_biometric_consent_withdrawals',
  'biometric-consent withdrawals have a dedicated registry'
);
select extensions.has_table(
  'affiliate_private',
  'affiliate_kyc_human_review_requests',
  'human-review requests have a dedicated registry'
);

select extensions.ok(
  (
    select relation.relrowsecurity
    from pg_catalog.pg_class relation
    where relation.oid =
      'affiliate_private.affiliate_biometric_consent_withdrawals'::regclass
  )
  and (
    select relation.relrowsecurity
    from pg_catalog.pg_class relation
    where relation.oid =
      'affiliate_private.affiliate_kyc_human_review_requests'::regclass
  )
  and not has_table_privilege(
    'anon',
    'affiliate_private.affiliate_biometric_consent_withdrawals',
    'SELECT'
  )
  and not has_table_privilege(
    'authenticated',
    'affiliate_private.affiliate_biometric_consent_withdrawals',
    'SELECT'
  )
  and not has_table_privilege(
    'service_role',
    'affiliate_private.affiliate_biometric_consent_withdrawals',
    'SELECT'
  )
  and not has_table_privilege(
    'authenticated',
    'affiliate_private.affiliate_kyc_human_review_requests',
    'SELECT'
  )
  and not has_table_privilege(
    'service_role',
    'affiliate_private.affiliate_kyc_human_review_requests',
    'SELECT'
  ),
  'privacy-rights registries are RLS protected and not exposed directly'
);

select extensions.ok(
  exists (
    select 1
    from pg_catalog.pg_trigger trigger_row
    where trigger_row.tgrelid =
      'affiliate_private.affiliate_biometric_consent_withdrawals'::regclass
      and trigger_row.tgname = 'affiliate_biometric_withdrawal_append_only'
      and not trigger_row.tgisinternal
  )
  and exists (
    select 1
    from pg_catalog.pg_trigger trigger_row
    where trigger_row.tgrelid =
      'affiliate_private.affiliate_kyc_human_review_requests'::regclass
      and trigger_row.tgname = 'affiliate_kyc_human_review_guard'
      and not trigger_row.tgisinternal
  ),
  'withdrawals are append-only and review transitions use the audited guard'
);

select extensions.ok(
  has_function_privilege(
    'service_role',
    'public.partners_service_kyc_rights_get(uuid)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.partners_service_biometric_consent_withdraw(uuid,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.partners_service_kyc_human_review_request(uuid,text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.partners_service_kyc_rights_get(uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.partners_service_biometric_consent_withdraw(uuid,text)',
    'EXECUTE'
  ),
  'only the Edge service role can execute member privacy-rights RPCs'
);

select extensions.ok(
  has_function_privilege(
    'authenticated',
    'public.admin_partners_kyc_human_review_queue(integer,integer,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'authenticated',
    'public.admin_partners_kyc_human_review_locator(text,text,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'authenticated',
    'public.admin_partners_kyc_human_review_decide(text,text,text,timestamptz,text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.admin_partners_kyc_human_review_queue(integer,integer,text)',
    'EXECUTE'
  ),
  'Admin review RPCs are authenticated surfaces with server capability checks'
);

select extensions.ok(
  pg_get_functiondef(
    'affiliate_private.partners_service_kyc_prepare_v2(uuid,text,text,text,boolean,text)'::regprocedure
  ) like '%affiliate_biometric_consent_withdrawals%'
  and pg_get_functiondef(
    'affiliate_private.admin_partners_kyc_human_review_locator(text,text,text)'::regprocedure
  ) like '%partners_require_aal2%'
  and pg_get_functiondef(
    'affiliate_private.admin_partners_kyc_human_review_decide(text,text,text,timestamptz,text,text)'::regprocedure
  ) like '%partners_require_aal2%'
  and pg_get_functiondef(
    'affiliate_private.admin_partners_kyc_human_review_queue(integer,integer,text)'::regprocedure
  ) not like '%provider_session_id%'
  and pg_get_functiondef(
    'affiliate_private.admin_partners_kyc_human_review_queue(integer,integer,text)'::regprocedure
  ) not like '%provider_payload%'
  and pg_get_functiondef(
    'affiliate_private.admin_partners_kyc_human_review_queue(integer,integer,text)'::regprocedure
  ) not like '%email%'
  and pg_get_functiondef(
    'affiliate_private.admin_partners_kyc_human_review_queue(integer,integer,text)'::regprocedure
  ) not like '%user_id%'
  ,
  'withdrawal blocks v2 preparation and Admin projections remain minimized'
);

select extensions.throws_ok(
  $$
    select public.partners_service_kyc_human_review_request(
      extensions.gen_random_uuid(),
      'raw_free_text_is_not_accepted',
      'norva.review.invalid.0001'
    )
  $$,
  '22023',
  'invalid KYC human-review request',
  'review reasons are closed enums rather than free-text provider payloads'
);

select * from extensions.finish();
rollback;
