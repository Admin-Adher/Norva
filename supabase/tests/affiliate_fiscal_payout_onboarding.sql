begin;

create extension if not exists pgtap with schema extensions;
select extensions.no_plan();

-- Private surface and grants -------------------------------------------------

select extensions.ok(
  to_regclass(
    'affiliate_private.affiliate_payout_onboarding_requests'
  ) is not null
  and to_regclass(
    'affiliate_private.affiliate_payout_onboarding_transitions'
  ) is not null,
  'private payout onboarding state and transition evidence exist'
);
select extensions.ok(
  (
    select relation.relrowsecurity
    from pg_catalog.pg_class relation
    where relation.oid =
      'affiliate_private.affiliate_payout_onboarding_requests'::regclass
  )
  and (
    select relation.relrowsecurity
    from pg_catalog.pg_class relation
    where relation.oid =
      'affiliate_private.affiliate_payout_onboarding_transitions'::regclass
  ),
  'RLS is enabled on both private payout onboarding tables'
);
select extensions.ok(
  not has_table_privilege(
    'authenticated',
    'affiliate_private.affiliate_payout_onboarding_requests',
    'SELECT'
  )
  and not has_table_privilege(
    'service_role',
    'affiliate_private.affiliate_payout_onboarding_requests',
    'SELECT'
  )
  and not has_table_privilege(
    'authenticated',
    'affiliate_private.affiliate_payout_onboarding_transitions',
    'SELECT'
  ),
  'clients and Edge cannot bypass the narrow RPC boundary'
);
select extensions.ok(
  has_function_privilege(
    'service_role',
    'public.partners_service_fiscal_profile_get(uuid)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.partners_service_fiscal_profile_self_attest(uuid,text,text,boolean,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.partners_service_payout_onboarding_get(uuid)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.partners_service_payout_onboarding_request(uuid,text,boolean,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.partners_service_activation_reconcile(uuid)',
    'EXECUTE'
  ),
  'service role has the sanitized member and activation-reconcile RPC entry points'
);
select extensions.ok(
  not has_function_privilege(
    'authenticated',
    'public.partners_service_fiscal_profile_self_attest(uuid,text,text,boolean,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.partners_service_payout_onboarding_request(uuid,text,boolean,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.partners_service_activation_reconcile(uuid)',
    'EXECUTE'
  ),
  'browser roles cannot bypass JWT verification in the Edge function'
);
select extensions.ok(
  not has_function_privilege(
    'service_role',
    'public.partners_service_payout_profile_set(uuid,text,text,text,text,text)',
    'EXECUTE'
  ),
  'the service-role Edge cannot call the legacy payout-profile setter'
);
select extensions.ok(
  has_function_privilege(
    'authenticated',
    'public.admin_partners_payout_onboarding_requests(integer,integer,text,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'authenticated',
    'public.admin_partners_fiscal_profiles(integer,integer,text,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'authenticated',
    'public.admin_partners_fiscal_review_by_public_id(text,text,text,text,text,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'authenticated',
    'public.admin_partners_revolut_beneficiary_binding_authorize_by_request(text,text,text,text,integer,text,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'authenticated',
    'public.admin_partners_payout_onboarding_contact(text,text,uuid)',
    'EXECUTE'
  )
  and has_function_privilege(
    'authenticated',
    'public.admin_partners_payout_onboarding_request_decide(text,text,text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.admin_partners_payout_onboarding_request_decide(text,text,text,text)',
    'EXECUTE'
  ),
  'only authenticated Admin sessions can enter the Finance queue boundary'
);
select extensions.ok(
  not has_function_privilege(
    'authenticated',
    'public.admin_partners_fiscal_review(uuid,text,text,text,text,text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.admin_partners_revolut_beneficiary_binding_authorize(uuid,text,text,text,text,integer,text,text)',
    'EXECUTE'
  ),
  'legacy account-UUID fiscal and beneficiary entrypoints are closed'
);

-- Fiscal invariants ----------------------------------------------------------

select extensions.ok(
  lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_activation_reconcile(uuid)'::regprocedure
  )) like '%pg_advisory_xact_lock%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_activation_reconcile(uuid)'::regprocedure
  )) like '%for update%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_activation_reconcile(uuid)'::regprocedure
  )) like '%release_gates_satisfied%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_activation_reconcile(uuid)'::regprocedure
  )) like '%account.status = ''pending_verification''%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_activation_reconcile(uuid)'::regprocedure
  )) like '%''account_activated''%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_activation_reconcile(uuid)'::regprocedure
  )) not like '%idempotency_key%',
  'activation reconcile is state-idempotent and revalidates the live release boundary'
);
select extensions.ok(
  lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_fiscal_profile_self_attest(uuid,text,text,boolean,text)'::regprocedure
  )) like '%v_declaration <> ''partners-tax-self-certification-v1''%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_fiscal_profile_self_attest(uuid,text,text,boolean,text)'::regprocedure
  )) like '%p_declaration_accepted is distinct from true%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_fiscal_profile_self_attest(uuid,text,text,boolean,text)'::regprocedure
  )) like '%status = ''pending''%',
  'self-attestation accepts only the fixed declaration and writes pending, never verified'
);
select extensions.ok(
  lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_fiscal_profile_self_attest(uuid,text,text,boolean,text)'::regprocedure
  )) like '%v_account.country_code is distinct from v_country%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_fiscal_profile_self_attest(uuid,text,text,boolean,text)'::regprocedure
  )) not like '%tax_identifier%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_fiscal_profile_self_attest(uuid,text,text,boolean,text)'::regprocedure
  )) not like '%tax_id%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_fiscal_profile_self_attest(uuid,text,text,boolean,text)'::regprocedure
  )) not like '%p_status%',
  'fiscal country is account-bound and no raw tax/status input exists'
);
select extensions.ok(
  lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_fiscal_review(uuid,text,text,text,text,text,text)'::regprocedure
  )) like '%partners_require_capability(''support'')%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_fiscal_review(uuid,text,text,text,text,text,text)'::regprocedure
  )) like '%partners_require_capability(''finance'')%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_fiscal_review(uuid,text,text,text,text,text,text)'::regprocedure
  )) like '%partners_require_aal2(%',
  'only the existing Support plus Finance AAL2 review can mark fiscal status authoritative'
);
select extensions.ok(
  lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_fiscal_profiles(integer,integer,text,text)'::regprocedure
  )) like '%partners_require_capability(''support'')%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_fiscal_profiles(integer,integer,text,text)'::regprocedure
  )) like '%partners_require_capability(''finance'')%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_fiscal_profiles(integer,integer,text,text)'::regprocedure
  )) like '%partners_require_aal2(%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_fiscal_profiles(integer,integer,text,text)'::regprocedure
  )) not like '%users.email%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_fiscal_profiles(integer,integer,text,text)'::regprocedure
  )) not like '%verification_reference%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_fiscal_profiles(integer,integer,text,text)'::regprocedure
  )) not like '%tax_form_type%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_fiscal_profiles(integer,integer,text,text)'::regprocedure
  )) not like '%''account_id''%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_fiscal_profiles(integer,integer,text,text)'::regprocedure
  )) like '%''partner_key''%',
  'the fiscal queue is AAL2 and exposes only the public partner key and review timestamps'
);
select extensions.ok(
  exists (
    select 1
    from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid =
      'affiliate_private.affiliate_fiscal_profiles'::regclass
      and constraint_row.conname =
        'affiliate_fiscal_profiles_self_attestation'
      and constraint_row.convalidated
      and lower(pg_catalog.pg_get_constraintdef(constraint_row.oid))
        like '%status <> ''verified''%'
      and lower(pg_catalog.pg_get_constraintdef(constraint_row.oid))
        like '%partners-tax-self-certification-v1%'
      and lower(pg_catalog.pg_get_constraintdef(constraint_row.oid))
        like '%self_attested_at is not null%'
  ),
  'the validated table constraint rejects verified without fixed self-attestation'
);
select extensions.is(
  (
    select count(*)::bigint
    from affiliate_private.affiliate_fiscal_profiles profile
    where profile.status = 'verified'
      and (
        profile.declaration_version is distinct from
          'partners-tax-self-certification-v1'
        or profile.self_attested_at is null
      )
  ),
  0::bigint,
  'the upgrade leaves no legacy verified row without an attestation'
);
select extensions.ok(
  lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_fiscal_profile_record(uuid,text,text,text,text,text)'::regprocedure
  )) like '%direct service fiscal verification is forbidden%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_fiscal_profile_record(uuid,text,text,text,text,text)'::regprocedure
  )) like '%pending fiscal self-attestation is required%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_fiscal_profile_record(uuid,text,text,text,text,text)'::regprocedure
  )) not like '%insert into affiliate_private.affiliate_fiscal_profiles%',
  'the legacy service recorder cannot create or directly verify a fiscal profile'
);

-- Idempotency and concurrency ------------------------------------------------

select extensions.ok(
  lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_fiscal_profile_self_attest(uuid,text,text,boolean,text)'::regprocedure
  )) like '%pg_advisory_xact_lock%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_fiscal_profile_self_attest(uuid,text,text,boolean,text)'::regprocedure
  )) like '%partners_replayed_response%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_fiscal_profile_self_attest(uuid,text,text,boolean,text)'::regprocedure
  )) like '%partners_store_response%',
  'fiscal self-attestation serializes per user and stores exact idempotent responses'
);
select extensions.ok(
  lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_payout_onboarding_request(uuid,text,boolean,text)'::regprocedure
  )) like '%pg_advisory_xact_lock%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_payout_onboarding_request(uuid,text,boolean,text)'::regprocedure
  )) like '%partners_replayed_response%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_payout_onboarding_request(uuid,text,boolean,text)'::regprocedure
  )) like '%partners_store_response%',
  'payout onboarding serializes per user and stores exact idempotent responses'
);
select extensions.ok(
  lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_fiscal_profile_self_attest(uuid,text,text,boolean,text)'::regprocedure
  )) not like '%partners_enforce_fiscal_onboarding_write_limit%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_payout_onboarding_request(uuid,text,boolean,text)'::regprocedure
  )) not like '%partners_enforce_fiscal_onboarding_write_limit%',
  'member mutations do not double-charge the separate durable Edge reservation'
);
select extensions.ok(
  exists (
    select 1
    from pg_catalog.pg_index index_row
    join pg_catalog.pg_class index_relation
      on index_relation.oid = index_row.indexrelid
    join pg_catalog.pg_namespace namespace_row
      on namespace_row.oid = index_relation.relnamespace
    where namespace_row.nspname = 'affiliate_private'
      and index_relation.relname =
        'affiliate_payout_onboarding_one_open_idx'
      and index_row.indisunique
      and lower(pg_catalog.pg_get_expr(
        index_row.indpred,
        index_row.indrelid
      )) like '%pending%'
      and lower(pg_catalog.pg_get_expr(
        index_row.indpred,
        index_row.indrelid
      )) like '%in_progress%'
  ),
  'a partial unique index is the database backstop for one concurrent open request'
);

-- Revision and completion semantics ----------------------------------------

select extensions.ok(
  not exists (
    select 1
    from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid =
      'affiliate_private.affiliate_payout_onboarding_requests'::regclass
      and constraint_row.contype = 'u'
      and pg_catalog.pg_get_constraintdef(constraint_row.oid)
        = 'UNIQUE (account_id, currency)'
  )
  and exists (
    select 1
    from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid =
      'affiliate_private.affiliate_payout_onboarding_requests'::regclass
      and constraint_row.contype = 'u'
      and pg_catalog.pg_get_constraintdef(constraint_row.oid)
        = 'UNIQUE (account_id, currency, revision)'
  ),
  'terminal requests can be superseded by an immutable new revision'
);
select extensions.ok(
  lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_payout_onboarding_request(uuid,text,boolean,text)'::regprocedure
  )) like '%v_request.status = ''completed''%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_payout_onboarding_request(uuid,text,boolean,text)'::regprocedure
  )) like '%not v_binding_ready%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_payout_onboarding_request(uuid,text,boolean,text)'::regprocedure
  )) like '%v_next_revision%',
  'a completed request gets a new revision only after its active binding/profile is gone'
);
select extensions.ok(
  lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_payout_onboarding_request(uuid,text,boolean,text)'::regprocedure
  )) like '%execution_adapter = ''revolut_manual''%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_payout_onboarding_request(uuid,text,boolean,text)'::regprocedure
  )) like '%route.status = ''active''%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_payout_onboarding_request(uuid,text,boolean,text)'::regprocedure
  )) like '%route.country_code = v_account.country_code%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_payout_onboarding_request(uuid,text,boolean,text)'::regprocedure
  )) like '%route.currency = v_currency%',
  'member requests require the exact active manual country/currency corridor'
);
select extensions.ok(
  lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_payout_account_evidence_is_current(affiliate_private.affiliate_accounts,affiliate_private.affiliate_program_versions,affiliate_private.affiliate_country_policies)'::regprocedure
  )) like '%p_program.status = ''active''%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_payout_account_evidence_is_current(affiliate_private.affiliate_accounts,affiliate_private.affiliate_program_versions,affiliate_private.affiliate_country_policies)'::regprocedure
  )) like '%p_program.effective_until > now()%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_payout_account_evidence_is_current(affiliate_private.affiliate_accounts,affiliate_private.affiliate_program_versions,affiliate_private.affiliate_country_policies)'::regprocedure
  )) like '%p_policy.individual_available%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_payout_account_evidence_is_current(affiliate_private.affiliate_accounts,affiliate_private.affiliate_program_versions,affiliate_private.affiliate_country_policies)'::regprocedure
  )) like '%p_account.terms_version_accepted = p_policy.terms_version%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_payout_account_evidence_is_current(affiliate_private.affiliate_accounts,affiliate_private.affiliate_program_versions,affiliate_private.affiliate_country_policies)'::regprocedure
  )) like '%p_account.verification_provider = p_policy.verification_provider%',
  'account, current P0 program and current policy evidence are centralized fail-closed'
);
select extensions.ok(
  lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_payout_onboarding_allowed_currencies(affiliate_private.affiliate_accounts)'::regprocedure
  )) like '%partners_payout_account_evidence_is_current%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_payout_onboarding_allowed_currencies(affiliate_private.affiliate_accounts)'::regprocedure
  )) like '%fiscal_profile.status = ''verified''%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_payout_onboarding_allowed_currencies(affiliate_private.affiliate_accounts)'::regprocedure
  )) like '%route.execution_adapter = ''revolut_manual''%',
  'allowed currencies disappear when current eligibility, fiscal evidence or manual route lapses'
);
select extensions.ok(
  lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_payout_onboarding_reconfiguration_required(affiliate_private.affiliate_accounts,affiliate_private.affiliate_payout_onboarding_requests)'::regprocedure
  )) like '%partners_payout_onboarding_allowed_currencies%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_payout_onboarding_reconfiguration_required(affiliate_private.affiliate_accounts,affiliate_private.affiliate_payout_onboarding_requests)'::regprocedure
  )) like '%profile.status = ''active''%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_payout_onboarding_reconfiguration_required(affiliate_private.affiliate_accounts,affiliate_private.affiliate_payout_onboarding_requests)'::regprocedure
  )) like '%binding.status = ''active''%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_payout_onboarding_get(uuid)'::regprocedure
  )) like '%partners_payout_onboarding_reconfiguration_required%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_payout_onboarding_requests(integer,integer,text,text)'::regprocedure
  )) like '%partners_payout_onboarding_reconfiguration_required%',
  'member and Finance derive completed reconfiguration from one fail-closed helper'
);
select extensions.ok(
  lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_payout_onboarding_request(uuid,text,boolean,text)'::regprocedure
  )) not like '%iban%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_payout_onboarding_request(uuid,text,boolean,text)'::regprocedure
  )) not like '%beneficiary_token%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_payout_onboarding_request(uuid,text,boolean,text)'::regprocedure
  )) not like '%display_masked%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_payout_onboarding_request(uuid,text,boolean,text)'::regprocedure
  )) not like '%p_provider%',
  'public payout onboarding has no bank, beneficiary, mask or provider input'
);
select extensions.ok(
  lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_payout_onboarding_requests(integer,integer,text,text)'::regprocedure
  )) like '%partners_require_capability(''finance'')%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_payout_onboarding_requests(integer,integer,text,text)'::regprocedure
  )) like '%partners_require_aal2(%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_payout_onboarding_request_decide(text,text,text,text)'::regprocedure
  )) like '%partners_require_capability(''finance'')%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_payout_onboarding_request_decide(text,text,text,text)'::regprocedure
  )) like '%partners_require_aal2(%',
  'queue reads and decisions require Admin Finance plus AAL2 inside the RPCs'
);
select extensions.ok(
  lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_payout_onboarding_request_decide(text,text,text,text)'::regprocedure
  )) like '%for share of profile, binding%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_payout_onboarding_request_decide(text,text,text,text)'::regprocedure
  )) like '%if not found then%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_payout_onboarding_request_decide(text,text,text,text)'::regprocedure
  )) like '%active verified revolut binding and profile are required%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_payout_onboarding_request_decide(text,text,text,text)'::regprocedure
  )) like '%profile.provider = ''revolut''%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_payout_onboarding_request_decide(text,text,text,text)'::regprocedure
  )) like '%profile.status = ''active''%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_payout_onboarding_request_decide(text,text,text,text)'::regprocedure
  )) like '%binding.status = ''active''%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_payout_onboarding_request_decide(text,text,text,text)'::regprocedure
  )) like '%profile.revolut_binding_id%',
  'completion is impossible without the active maker-checker binding and matching profile'
);
select extensions.ok(
  lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_payout_onboarding_request_decide(text,text,text,text)'::regprocedure
  )) like '%partners_payout_account_evidence_is_current%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_payout_onboarding_request_decide(text,text,text,text)'::regprocedure
  )) like '%fiscal_profile.status = ''verified''%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_payout_onboarding_request_decide(text,text,text,text)'::regprocedure
  )) like '%route.execution_adapter = ''revolut_manual''%'
  and position(
    'payout-approval-configuration' in lower(pg_catalog.pg_get_functiondef(
      'affiliate_private.admin_partners_payout_onboarding_request_decide(text,text,text,text)'::regprocedure
    ))
  ) < position(
    'select request_row.account_id' in lower(pg_catalog.pg_get_functiondef(
      'affiliate_private.admin_partners_payout_onboarding_request_decide(text,text,text,text)'::regprocedure
    ))
  )
  and position(
    'select request_row.account_id' in lower(pg_catalog.pg_get_functiondef(
      'affiliate_private.admin_partners_payout_onboarding_request_decide(text,text,text,text)'::regprocedure
    ))
  ) < position(
    'for share' in lower(pg_catalog.pg_get_functiondef(
      'affiliate_private.admin_partners_payout_onboarding_request_decide(text,text,text,text)'::regprocedure
    ))
  )
  and position(
    'for share' in lower(pg_catalog.pg_get_functiondef(
      'affiliate_private.admin_partners_payout_onboarding_request_decide(text,text,text,text)'::regprocedure
    ))
  ) < position(
    'for update' in lower(pg_catalog.pg_get_functiondef(
      'affiliate_private.admin_partners_payout_onboarding_request_decide(text,text,text,text)'::regprocedure
    ))
  ),
  'completion revalidates evidence and Admin uses account-before-request locking'
);
select extensions.ok(
  position(
    'payout-approval-configuration' in lower(pg_catalog.pg_get_functiondef(
      'affiliate_private.partners_service_payout_onboarding_request(uuid,text,boolean,text)'::regprocedure
    ))
  ) < position(
    'select account.*' in lower(pg_catalog.pg_get_functiondef(
      'affiliate_private.partners_service_payout_onboarding_request(uuid,text,boolean,text)'::regprocedure
    ))
  )
  and position(
    'payout-approval-configuration' in lower(pg_catalog.pg_get_functiondef(
      'affiliate_private.admin_partners_revolut_beneficiary_binding_authorize_by_request(text,text,text,text,integer,text,text)'::regprocedure
    ))
  ) < position(
    'select account.*' in lower(pg_catalog.pg_get_functiondef(
      'affiliate_private.admin_partners_revolut_beneficiary_binding_authorize_by_request(text,text,text,text,integer,text,text)'::regprocedure
    ))
  ),
  'member, Admin completion and beneficiary authorization share global-before-account locking'
);
select extensions.ok(
  lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_beneficiary_binding_authorize_by_request(text,text,text,text,integer,text,text)'::regprocedure
  )) like '%request_row.status = ''in_progress''%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_beneficiary_binding_authorize_by_request(text,text,text,text,integer,text,text)'::regprocedure
  )) like '%request_row.contact_consent%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_beneficiary_binding_authorize_by_request(text,text,text,text,integer,text,text)'::regprocedure
  )) like '%request_key=%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_beneficiary_binding_authorize_by_request(text,text,text,text,integer,text,text)'::regprocedure
  )) like '%beneficiary authorization response is unsafe%',
  'beneficiary authorization resolves an active consented request and strips the account UUID from its payload'
);
select extensions.ok(
  lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_payout_onboarding_contact(text,text,uuid)'::regprocedure
  )) like '%partners_payout_onboarding%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_payout_onboarding_contact(text,text,uuid)'::regprocedure
  )) like '%norva_freeze_support_email%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_payout_onboarding_contact(text,text,uuid)'::regprocedure
  )) like '%verified_account_email%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_payout_onboarding_contact(text,text,uuid)'::regprocedure
  )) like '%secure_setup_invitation%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_payout_onboarding_contact(text,text,uuid)'::regprocedure
  )) like '%never send bank details, tax identifiers%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_payout_onboarding_contact(text,text,uuid)'::regprocedure
  )) not like '%p_body%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_payout_onboarding_contact(text,text,uuid)'::regprocedure
  )) not like '%''recipient_email''%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_payout_onboarding_contact(text,text,uuid)'::regprocedure
  )) not like '%''user_id''%',
  'payout contact reuses the audited support outbox without returning email or user UUID'
);
select extensions.ok(
  position(
    'payout-approval-configuration' in lower(pg_catalog.pg_get_functiondef(
      'affiliate_private.admin_partners_payout_onboarding_contact(text,text,uuid)'::regprocedure
    ))
  ) < position(
    'select account.*' in lower(pg_catalog.pg_get_functiondef(
      'affiliate_private.admin_partners_payout_onboarding_contact(text,text,uuid)'::regprocedure
    ))
  )
  and position(
    'select account.*' in lower(pg_catalog.pg_get_functiondef(
      'affiliate_private.admin_partners_payout_onboarding_contact(text,text,uuid)'::regprocedure
    ))
  ) < position(
    'for update' in lower(pg_catalog.pg_get_functiondef(
      'affiliate_private.admin_partners_payout_onboarding_contact(text,text,uuid)'::regprocedure
    ))
  )
  and position(
    '''norva:partners:payout-contact:'' || v_request.request_key' in
      lower(pg_catalog.pg_get_functiondef(
        'affiliate_private.admin_partners_payout_onboarding_contact(text,text,uuid)'::regprocedure
      ))
  ) < position(
    '''support-request:'' || p_idempotency_key::text' in
      lower(pg_catalog.pg_get_functiondef(
        'affiliate_private.admin_partners_payout_onboarding_contact(text,text,uuid)'::regprocedure
      ))
  )
  and position(
    '''support-request:'' || p_idempotency_key::text' in
      lower(pg_catalog.pg_get_functiondef(
        'affiliate_private.admin_partners_payout_onboarding_contact(text,text,uuid)'::regprocedure
      ))
  ) < position(
    'payout onboarding contact rate limit exceeded' in
      lower(pg_catalog.pg_get_functiondef(
        'affiliate_private.admin_partners_payout_onboarding_contact(text,text,uuid)'::regprocedure
      ))
  ),
  'payout contact serializes global, account, request and idempotency before quota evaluation'
);
select extensions.ok(
  exists (
    select 1
    from pg_catalog.pg_trigger trigger_row
    where trigger_row.tgrelid =
      'affiliate_private.affiliate_payout_onboarding_transitions'::regclass
      and trigger_row.tgname =
        'affiliate_payout_onboarding_transitions_append_only'
      and not trigger_row.tgisinternal
  ),
  'every onboarding transition remains append-only and auditable'
);
select extensions.ok(
  lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.guard_payout_onboarding_request_transition()'::regprocedure
  )) not like '%old.status = ''rejected'' and new.status = ''pending''%',
  'a rejected request can reopen only as a new immutable revision'
);
select extensions.ok(
  lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_detail_by_public_id(text)'::regprocedure
  )) like '%^prt_[0-9a-f]{24}$%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_detail_by_public_id(text)'::regprocedure
  )) not like '%''account_id'', v_account.id%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_detail_by_public_id(text)'::regprocedure
  )) like '%''account_public_id'', v_public_id%',
  'Finance can open a partner detail by public key without exposing an internal UUID'
);

-- Direct-RPC bypass fixtures -------------------------------------------------

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
    '22000000-0000-4000-8000-000000000001',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'fiscal-member@example.invalid',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '22000000-0000-4000-8000-000000000002',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'fiscal-admin@example.invalid',
    '',
    now(),
    '{"provider":"email","providers":["email"],"role":"admin"}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '22000000-0000-4000-8000-000000000004',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'activation-reconcile@example.invalid',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
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
  '23000000-0000-4000-8000-000000000002',
  '22000000-0000-4000-8000-000000000002',
  'Partners fiscal Finance actor',
  'totp',
  'verified',
  now(),
  now(),
  'partners-fiscal-test-secret'
);

insert into affiliate_private.affiliate_program_versions (
  version_key,
  account_type,
  status,
  commission_rate_bps,
  attribution_window_days,
  maturation_days,
  payout_thresholds,
  terms_version,
  disclosure_version,
  effective_from
)
values (
  'fiscal-payout-pgtap-v1',
  'individual',
  'active',
  2000,
  30,
  45,
  '{"USD":1000}'::jsonb,
  'partners-pgtap-v1',
  'partners-disclosure-pgtap-v1',
  now() - interval '1 day'
);

insert into affiliate_private.affiliate_country_policies (
  program_version_id,
  country_code,
  individual_available,
  minimum_age,
  capacity_required,
  verification_level,
  verification_provider,
  payout_currencies,
  terms_version,
  disclosure_version,
  effective_from
)
select
  program.id,
  'US',
  false,
  18,
  true,
  'identity_age_country_capacity',
  'didit',
  array['USD']::text[],
  'partners-pgtap-v1',
  'partners-disclosure-pgtap-v1',
  now() - interval '1 day'
from affiliate_private.affiliate_program_versions program
where program.version_key = 'fiscal-payout-pgtap-v1';

insert into affiliate_private.affiliate_accounts (
  user_id,
  user_pseudonym,
  account_type,
  status,
  program_version_id,
  country_policy_id,
  country_code,
  verification_status,
  verification_provider,
  verification_reference,
  age_verified,
  capacity_verified,
  contract_status,
  terms_version_accepted,
  contract_accepted_at,
  disclosure_version_accepted,
  disclosure_accepted_at
)
select
  '22000000-0000-4000-8000-000000000001',
  repeat('b', 64),
  'individual',
  'pending_verification',
  program.id,
  policy.id,
  'US',
  'verified',
  'didit',
  repeat('1', 64),
  true,
  true,
  'accepted',
  'partners-pgtap-v1',
  now() - interval '1 hour',
  'partners-disclosure-pgtap-v1',
  now() - interval '1 hour'
from affiliate_private.affiliate_program_versions program
join affiliate_private.affiliate_country_policies policy
  on policy.program_version_id = program.id
  and policy.country_code = 'US'
where program.version_key = 'fiscal-payout-pgtap-v1';

-- A signed KYC result can be persisted while the release master gate is
-- closed. Reconcile must leave that verified account pending, then activate it
-- exactly once after the same authoritative release boundary opens.
insert into affiliate_private.affiliate_accounts (
  user_id,
  user_pseudonym,
  account_type,
  status,
  program_version_id,
  country_policy_id,
  country_code,
  verification_status,
  verification_provider,
  verification_reference,
  age_verified,
  capacity_verified,
  contract_status,
  terms_version_accepted,
  contract_accepted_at,
  disclosure_version_accepted,
  disclosure_accepted_at
)
select
  '22000000-0000-4000-8000-000000000004',
  repeat('4', 64),
  'individual',
  'pending_verification',
  program.id,
  policy.id,
  'US',
  'verified',
  'didit',
  repeat('4', 64),
  true,
  true,
  'accepted',
  'partners-pgtap-v1',
  now() - interval '1 hour',
  'partners-disclosure-pgtap-v1',
  now() - interval '1 hour'
from affiliate_private.affiliate_program_versions program
join affiliate_private.affiliate_country_policies policy
  on policy.program_version_id = program.id
  and policy.country_code = 'US'
where program.version_key = 'fiscal-payout-pgtap-v1';

insert into affiliate_private.affiliate_pilot_allowlist (
  user_id,
  status,
  country_code,
  added_by_pseudonym
)
values (
  '22000000-0000-4000-8000-000000000004',
  'active',
  'US',
  repeat('4', 64)
);

-- Activation is intentionally deferred until Didit deletion is proven. These
-- two already-verified fixture accounts therefore need the same canonical,
-- purged member-session evidence required from production webhook processing.
select set_config('norva.didit.environment', 'live', true);
select set_config(
  'norva.didit.config_fingerprint',
  repeat('6', 64),
  true
);
insert into affiliate_private.affiliate_kyc_sessions (
  account_id,
  provider,
  provider_session_hash,
  provider_workflow_hash,
  provider_workflow_version,
  provider_status,
  status,
  consent_version,
  age_over_minimum,
  country_policy_match,
  identity_checks_approved,
  capacity_attested,
  last_event_created_at,
  verified_at,
  expires_at,
  created_at,
  updated_at,
  provider_purge_status,
  provider_purge_requested_at,
  provider_purged_at
)
select
  account.id,
  'didit',
  account.verification_reference,
  case account.user_id
    when '22000000-0000-4000-8000-000000000001'::uuid
      then repeat('2', 64)
    else repeat('5', 64)
  end,
  1,
  'approved',
  'pending',
  'partners-biometric-consent-v1',
  true,
  true,
  true,
  true,
  statement_timestamp() - interval '40 seconds',
  statement_timestamp() - interval '30 seconds',
  statement_timestamp() + interval '59 minutes',
  statement_timestamp() - interval '1 minute',
  statement_timestamp() - interval '10 seconds',
  'purged',
  statement_timestamp() - interval '20 seconds',
  statement_timestamp() - interval '10 seconds'
from affiliate_private.affiliate_accounts account
where account.user_id in (
  '22000000-0000-4000-8000-000000000001',
  '22000000-0000-4000-8000-000000000004'
);
update affiliate_private.affiliate_kyc_sessions session
set status = 'verified'
where session.account_id in (
  select account.id
  from affiliate_private.affiliate_accounts account
  where account.user_id in (
    '22000000-0000-4000-8000-000000000001',
    '22000000-0000-4000-8000-000000000004'
  )
);

-- The coverage gate used by this fiscal fixture must be backed by a completed
-- live Didit certification and its canonical provider-deletion proof.
insert into affiliate_private.affiliate_didit_certification_sessions (
  certification_key_hash,
  operator_hash,
  idempotency_key_hash,
  request_hash,
  confirmation_hash,
  justification_hash,
  consent_version,
  capacity_attested,
  provider_session_hash,
  provider_workflow_hash,
  provider_workflow_version,
  provider_environment,
  provider_config_fingerprint,
  provider_status,
  provider_create_dispatched_at,
  status,
  id_check_approved,
  liveness_approved,
  face_match_approved,
  age_over_minimum,
  jurisdiction_result_present,
  verified,
  last_event_created_at,
  verified_at,
  expires_at,
  created_at,
  updated_at,
  provider_purge_status,
  provider_purge_requested_at,
  provider_purged_at
) values (
  encode(extensions.digest('fiscal:certification:key', 'sha256'), 'hex'),
  encode(extensions.digest('fiscal:certification:operator', 'sha256'), 'hex'),
  encode(extensions.digest('fiscal:certification:idempotency', 'sha256'), 'hex'),
  encode(extensions.digest('fiscal:certification:request', 'sha256'), 'hex'),
  encode(extensions.digest('fiscal:certification:confirmation', 'sha256'), 'hex'),
  encode(extensions.digest('fiscal:certification:justification', 'sha256'), 'hex'),
  'partners-didit-certification-v1',
  true,
  encode(extensions.digest('fiscal:certification:session', 'sha256'), 'hex'),
  encode(extensions.digest('fiscal:certification:workflow', 'sha256'), 'hex'),
  1,
  'live',
  encode(extensions.digest('fiscal:certification:config', 'sha256'), 'hex'),
  'approved',
  statement_timestamp() - interval '50 seconds',
  'approved',
  true,
  true,
  true,
  true,
  true,
  true,
  statement_timestamp() - interval '40 seconds',
  statement_timestamp() - interval '30 seconds',
  statement_timestamp() + interval '59 minutes',
  statement_timestamp() - interval '1 minute',
  statement_timestamp() - interval '10 seconds',
  'purged',
  statement_timestamp() - interval '20 seconds',
  statement_timestamp() - interval '10 seconds'
);

do $approval_fixture$
declare
  v_gate text;
  v_program affiliate_private.affiliate_program_versions%rowtype;
  v_policy affiliate_private.affiliate_country_policies%rowtype;
  v_package_id uuid;
  v_package_hash text;
  v_manifest_id uuid;
  v_manifest_hash text;
  v_manifest_version integer;
  v_manifest_documents jsonb;
  v_documents jsonb;
  v_scope jsonb;
  v_approved_at timestamptz := statement_timestamp();
  v_expires_at timestamptz := statement_timestamp() + interval '30 days';
begin
  v_manifest_documents := jsonb_build_object(
    'approval_record', repeat('1', 64),
    'deployment_proof', repeat('2', 64),
    'legal_tax_review', repeat('3', 64),
    'partners_terms', repeat('4', 64),
    'dpia', repeat('5', 64),
    'gdpr_self_assessment', repeat('6', 64),
    'biometric_consent', repeat('f', 64),
    'privacy_notice', repeat('7', 64),
    'records_of_processing', repeat('8', 64),
    'kyc_certification', repeat('9', 64),
    'payout_coverage_review', repeat('a', 64),
    'country_policy_review', repeat('b', 64),
    'payout_corridor_review', repeat('c', 64)
  );

  select program.*
  into strict v_program
  from affiliate_private.affiliate_program_versions program
  where program.version_key = 'fiscal-payout-pgtap-v1';

  select policy.*
  into strict v_policy
  from affiliate_private.affiliate_country_policies policy
  where policy.program_version_id = v_program.id
    and policy.country_code = 'US'
    and policy.subdivision_code is null;

  select coalesce(max(manifest.manifest_version), 0) + 1
  into v_manifest_version
  from affiliate_private.affiliate_deployment_manifests manifest
  where manifest.deployment_environment = 'production';

  v_manifest_hash :=
    affiliate_private.partners_deployment_manifest_sha256(
      'production',
      v_manifest_version,
      repeat('d', 40),
      'fiscal-payout-pgtap-deployment',
      repeat('e', 64),
      v_manifest_documents,
      repeat('4', 64),
      v_approved_at,
      'Fiscal payout pgTAP deployment manifest fixture.'
    );

  perform set_config('norva.partners_approval_control', 'deployment', true);
  insert into affiliate_private.affiliate_deployment_manifests (
    deployment_environment,
    manifest_version,
    source_commit_sha,
    deployment_key,
    deployment_evidence_sha256,
    document_hashes,
    manifest_sha256,
    registered_by_pseudonym,
    registered_at,
    justification
  ) values (
    'production',
    v_manifest_version,
    repeat('d', 40),
    'fiscal-payout-pgtap-deployment',
    repeat('e', 64),
    v_manifest_documents,
    v_manifest_hash,
    repeat('4', 64),
    v_approved_at,
    'Fiscal payout pgTAP deployment manifest fixture.'
  ) returning id into v_manifest_id;

  insert into affiliate_private.affiliate_deployment_manifest_bindings (
    deployment_environment,
    deployment_manifest_id,
    bound_by_pseudonym,
    bound_at
  ) values (
    'production',
    v_manifest_id,
    repeat('4', 64),
    v_approved_at
  )
  on conflict (deployment_environment) do update
  set
    deployment_manifest_id = excluded.deployment_manifest_id,
    bound_by_pseudonym = excluded.bound_by_pseudonym,
    bound_at = excluded.bound_at;

  perform set_config('norva.partners_approval_control', 'approve', true);
  foreach v_gate in array array[
    'legal_and_tax_approved',
    'privacy_approved',
    'individual_verification_coverage_confirmed',
    'individual_payout_coverage_confirmed',
    'country_policy_approved'
  ]::text[]
  loop
    v_documents := jsonb_build_object(
      'approval_record', repeat('1', 64),
      'deployment_proof', repeat('2', 64)
    ) || case v_gate
      when 'legal_and_tax_approved' then jsonb_build_object(
        'legal_tax_review', repeat('3', 64),
        'partners_terms', repeat('4', 64)
      )
      when 'privacy_approved' then jsonb_build_object(
        'dpia', repeat('5', 64),
        'gdpr_self_assessment', repeat('6', 64),
        'biometric_consent', repeat('f', 64),
        'privacy_notice', repeat('7', 64),
        'records_of_processing', repeat('8', 64)
      )
      when 'individual_verification_coverage_confirmed' then
        jsonb_build_object('kyc_certification', repeat('9', 64))
      when 'individual_payout_coverage_confirmed' then
        jsonb_build_object('payout_coverage_review', repeat('a', 64))
      when 'country_policy_approved' then jsonb_build_object(
        'country_policy_review', repeat('b', 64),
        'payout_corridor_review', repeat('c', 64)
      )
    end;
    v_scope := jsonb_build_array(jsonb_build_object(
      'country_code', v_policy.country_code,
      'subdivision_code', v_policy.subdivision_code,
      'policy_snapshot_sha256',
        affiliate_private.partners_country_policy_approval_snapshot_sha256(
          v_policy.id
        )
    ));
    v_package_hash := affiliate_private.partners_approval_package_sha256(
      v_gate,
      1,
      v_program.version_key,
      affiliate_private.partners_program_approval_snapshot_sha256(
        v_program.id
      ),
      v_scope,
      v_documents,
      repeat('d', 40),
      'production',
      'fiscal-payout-pgtap-deployment',
      repeat('e', 64),
      v_manifest_hash,
      repeat('4', 64),
      v_approved_at,
      v_expires_at,
      'Fiscal payout pgTAP immutable approval fixture.'
    );

    insert into affiliate_private.affiliate_approval_packages (
      gate_key,
      package_version,
      program_version_id,
      deployment_manifest_id,
      program_version_key,
      program_snapshot_sha256,
      jurisdiction_scope,
      document_hashes,
      source_commit_sha,
      deployment_environment,
      deployment_key,
      deployment_evidence_sha256,
      deployment_manifest_sha256,
      package_sha256,
      approved_by_pseudonym,
      approved_at,
      expires_at,
      justification
    ) values (
      v_gate,
      1,
      v_program.id,
      v_manifest_id,
      v_program.version_key,
      affiliate_private.partners_program_approval_snapshot_sha256(
        v_program.id
      ),
      v_scope,
      v_documents,
      repeat('d', 40),
      'production',
      'fiscal-payout-pgtap-deployment',
      repeat('e', 64),
      v_manifest_hash,
      v_package_hash,
      repeat('4', 64),
      v_approved_at,
      v_expires_at,
      'Fiscal payout pgTAP immutable approval fixture.'
    ) returning id into v_package_id;

    insert into
      affiliate_private.affiliate_release_gate_approval_bindings (
      gate_key,
      approval_package_id,
      bound_by_pseudonym,
      bound_at
    )
    values (v_gate, v_package_id, repeat('4', 64), v_approved_at);
  end loop;

  update affiliate_private.affiliate_release_gates gate
  set
    satisfied = true,
    satisfied_at = now(),
    updated_by_pseudonym = repeat('4', 64),
    updated_at = now()
  where gate.gate_key = any (array[
    'legal_and_tax_approved',
    'privacy_approved',
    'individual_verification_coverage_confirmed',
    'individual_payout_coverage_confirmed',
    'country_policy_approved'
  ]::text[]);

  update affiliate_private.affiliate_country_policies policy
  set individual_available = true
  where policy.id = v_policy.id;

  update affiliate_private.affiliate_accounts account
  set status = 'active', updated_at = now()
  where account.user_id = '22000000-0000-4000-8000-000000000001';
end;
$approval_fixture$;

select set_config(
  'norva.partners_control',
  'admin_partners_control',
  true
);
update public.admin_feature_flags flag
set
  enabled = case
    when flag.key = 'partners_invite_only' then true
    else false
  end,
  updated_at = now(),
  updated_by = 'activation-reconcile-pgtap'
where flag.key in ('partners_enabled', 'partners_invite_only');

set local role service_role;
select extensions.ok(
  (
    select
      response ->> 'changed' = 'false'
      and response #>> '{account,status}' = 'pending_verification'
      and response #>> '{account,verification_status}' = 'verified'
      and response ->> 'next_action' = 'activate_account'
    from (
      select public.partners_service_activation_reconcile(
        '22000000-0000-4000-8000-000000000004'
      ) as response
    ) reconciled
  ),
  'verified KYC evidence remains pending while the release master gate is closed'
);
reset role;

update public.admin_feature_flags flag
set
  enabled = true,
  updated_at = now(),
  updated_by = 'activation-reconcile-pgtap'
where flag.key = 'partners_enabled';

set local role service_role;
select extensions.ok(
  (
    select
      response ->> 'changed' = 'true'
      and response #>> '{account,status}' = 'active'
      and response ->> 'next_action' = 'share_link'
    from (
      select public.partners_service_activation_reconcile(
        '22000000-0000-4000-8000-000000000004'
      ) as response
    ) reconciled
  ),
  'opening the live release boundary activates the verified pending account'
);
select extensions.ok(
  (
    select
      response ->> 'changed' = 'false'
      and response #>> '{account,status}' = 'active'
      and response ->> 'next_action' = 'share_link'
    from (
      select public.partners_service_activation_reconcile(
        '22000000-0000-4000-8000-000000000004'
      ) as response
    ) replayed
  ),
  'an activation reconcile retry is an intrinsically idempotent no-op'
);
reset role;

select extensions.is(
  (
    select count(*)::bigint
    from affiliate_private.affiliate_events event_row
    join affiliate_private.affiliate_accounts account
      on event_row.aggregate_type = 'account'
      and event_row.aggregate_key = account.id::text
    where account.user_id = '22000000-0000-4000-8000-000000000004'
      and event_row.action = 'account_activated'
  ),
  1::bigint,
  'activation reconciliation emits exactly one account_activated event'
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
  '22000000-0000-4000-8000-000000000005',
  '00000000-0000-0000-0000-000000000000',
  'authenticated',
  'authenticated',
  'activation-contract-drift@example.invalid',
  '',
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb,
  now(),
  now()
);
insert into affiliate_private.affiliate_accounts (
  user_id,
  user_pseudonym,
  account_type,
  status,
  program_version_id,
  country_policy_id,
  country_code,
  verification_status,
  verification_provider,
  verification_reference,
  age_verified,
  capacity_verified,
  contract_status,
  terms_version_accepted,
  contract_accepted_at,
  disclosure_version_accepted,
  disclosure_accepted_at
)
select
  '22000000-0000-4000-8000-000000000005',
  repeat('5', 64),
  'individual',
  'pending_verification',
  program.id,
  policy.id,
  'US',
  'verified',
  'didit',
  'didit-activation-contract-drift-reference',
  true,
  true,
  'accepted',
  'partners-stale-terms-v1',
  now() - interval '1 hour',
  'partners-stale-disclosure-v1',
  now() - interval '1 hour'
from affiliate_private.affiliate_program_versions program
join affiliate_private.affiliate_country_policies policy
  on policy.program_version_id = program.id
  and policy.country_code = 'US'
where program.version_key = 'fiscal-payout-pgtap-v1';
insert into affiliate_private.affiliate_pilot_allowlist (
  user_id,
  status,
  country_code,
  added_by_pseudonym
)
values (
  '22000000-0000-4000-8000-000000000005',
  'active',
  'US',
  repeat('5', 64)
);

set local role service_role;
select extensions.ok(
  (
    select
      response ->> 'changed' = 'false'
      and response #>> '{account,status}' = 'pending_verification'
      and response ->> 'next_action' = 'accept_terms'
    from (
      select public.partners_service_activation_reconcile(
        '22000000-0000-4000-8000-000000000005'
      ) as response
    ) reconciled
  ),
  'current policy version drift fails closed and returns accept_terms'
);
reset role;
select extensions.is(
  (
    select count(*)::bigint
    from affiliate_private.affiliate_events event_row
    join affiliate_private.affiliate_accounts account
      on event_row.aggregate_type = 'account'
      and event_row.aggregate_key = account.id::text
    where account.user_id = '22000000-0000-4000-8000-000000000005'
      and event_row.action = 'account_activated'
  ),
  0::bigint,
  'policy version drift never emits a false activation event'
);

insert into affiliate_private.affiliate_currency_metadata (
  currency_code,
  exponent,
  status,
  configured_by_pseudonym,
  justification
)
values (
  'USD',
  2,
  'active',
  repeat('c', 64),
  'Enable the USD pgTAP payout onboarding fixture.'
);

insert into affiliate_private.affiliate_payout_provider_configs (
  provider,
  country_code,
  currency,
  status,
  execution_adapter,
  configured_by_pseudonym,
  justification
)
values (
  'revolut',
  'US',
  'USD',
  'active',
  'revolut_manual',
  repeat('c', 64),
  'Enable the supervised manual Revolut pgTAP corridor.'
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
    '22000000-0000-4000-8000-000000000002',
    'support',
    true,
    repeat('d', 64),
    'Fiscal review Support capability pgTAP fixture.'
  ),
  (
    '22000000-0000-4000-8000-000000000002',
    'finance',
    true,
    repeat('d', 64),
    'Fiscal review Finance capability pgTAP fixture.'
  );

set local role service_role;

select extensions.throws_ok(
  $$
    select public.partners_service_payout_onboarding_request(
      '22000000-0000-4000-8000-000000000001',
      'USD',
      true,
      'payout.onboarding.00000001'
    )
  $$,
  'P0001',
  'verified fiscal profile is required',
  'a direct service RPC cannot bypass the verified fiscal prerequisite'
);

select extensions.is(
  public.partners_service_fiscal_profile_self_attest(
    '22000000-0000-4000-8000-000000000001',
    'US',
    'partners-tax-self-certification-v1',
    true,
    'fiscal.attestation.00000001'
  ) #>> '{fiscal_profile,status}',
  'pending',
  'member self-attestation creates only a pending fiscal profile'
);
select extensions.is(
  public.partners_service_fiscal_profile_self_attest(
    '22000000-0000-4000-8000-000000000001',
    'US',
    'partners-tax-self-certification-v1',
    true,
    'fiscal.attestation.00000001'
  ) ->> 'replayed',
  'true',
  'an exact fiscal retry replays the stored response'
);

select extensions.throws_ok(
  $$
    select public.partners_service_fiscal_profile_record(
      '22000000-0000-4000-8000-000000000001',
      'norva_tax_review',
      repeat('e', 64),
      'US',
      'W9',
      'verified'
    )
  $$,
  'P0001',
  'direct service fiscal verification is forbidden',
  'the legacy service RPC cannot bypass Finance review'
);

reset role;
insert into affiliate_private.affiliate_member_write_reservations (
  operation,
  user_id,
  idempotency_key,
  request_hash,
  reserved_at,
  last_seen_at
)
select
  'fiscal_profile_self_attestation',
  '22000000-0000-4000-8000-000000000001',
  case
    when series.value = 0 then 'fiscal.attestation.00000001'
    else 'fiscal.throttle.' || lpad(series.value::text, 8, '0')
  end,
  repeat('9', 64),
  now(),
  now()
from generate_series(0, 7) as series(value);

set local role service_role;
select extensions.is(
  public.partners_service_fiscal_profile_self_attest(
    '22000000-0000-4000-8000-000000000001',
    'US',
    'partners-tax-self-certification-v1',
    true,
    'fiscal.attestation.00000001'
  ) ->> 'replayed',
  'true',
  'an exact fiscal replay remains available after the new-key quota is full'
);
select extensions.throws_ok(
  $$
    select public.partners_service_member_write_reserve(
      '22000000-0000-4000-8000-000000000001',
      'fiscal_profile_self_attestation',
      'fiscal.attestation.00000002',
      repeat('8', 64)
    )
  $$,
  'P0008',
  'Partners fiscal or payout onboarding rate limit exceeded',
  'the ninth distinct fiscal key in 24 hours is rate limited'
);

select extensions.throws_ok(
  $$
    select public.partners_service_payout_onboarding_request(
      '22000000-0000-4000-8000-000000000001',
      'USD',
      true,
      'payout.onboarding.00000002'
    )
  $$,
  'P0001',
  'verified fiscal profile is required',
  'a pending self-attestation still cannot bypass Finance review'
);

reset role;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"22000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2","app_metadata":{"role":"admin"}}';

select extensions.is(
  public.admin_partners_fiscal_profiles(
    25,
    0,
    'pending',
    null
  ) #>> '{items,0,status}',
  'pending',
  'a member self-attestation is immediately discoverable in the fiscal queue'
);
select extensions.ok(
  left(
    public.admin_partners_fiscal_profiles(
      25,
      0,
      'pending',
      null
    ) #>> '{items,0,partner_key}',
    4
  ) = 'prt_',
  'the fiscal queue uses a public partner key instead of an account UUID'
);
select extensions.is(
  public.admin_partners_fiscal_review_by_public_id(
    public.admin_partners_fiscal_profiles(
      25,
      0,
      'pending',
      null
    ) #>> '{items,0,partner_key}',
    'verified',
    'norva_tax_review',
    repeat('e', 64),
    'W9',
    'Approve the fixed self-attestation pgTAP fixture.'
  ) ->> 'status',
  'verified',
  'Support plus Finance AAL2 can verify an existing self-attestation'
);

reset role;
set local role service_role;
select extensions.is(
  public.partners_service_fiscal_profile_get(
    '22000000-0000-4000-8000-000000000001'
  ) #>> '{fiscal_profile,status}',
  'verified',
  'the reviewed fiscal status is immediately visible to the member'
);
select extensions.ok(
  public.partners_service_payout_onboarding_get(
    '22000000-0000-4000-8000-000000000001'
  ) -> 'allowed_currencies' @> '["USD"]'::jsonb,
  'the reviewed fiscal state unlocks the exact current manual currency'
);
reset role;

-- A separate active account without self-attestation proves Admin cannot
-- insert a verified fiscal record directly.
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
  '22000000-0000-4000-8000-000000000003',
  '00000000-0000-0000-0000-000000000000',
  'authenticated',
  'authenticated',
  'fiscal-missing@example.invalid',
  '',
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb,
  now(),
  now()
);
insert into affiliate_private.affiliate_accounts (
  user_id,
  user_pseudonym,
  account_type,
  status,
  program_version_id,
  country_policy_id,
  country_code,
  verification_status,
  verification_provider,
  verification_reference,
  age_verified,
  capacity_verified,
  contract_status,
  terms_version_accepted,
  contract_accepted_at,
  disclosure_version_accepted,
  disclosure_accepted_at
)
select
  '22000000-0000-4000-8000-000000000003',
  repeat('f', 64),
  'individual',
  'active',
  program.id,
  policy.id,
  'US',
  'verified',
  'didit',
  'didit-fiscal-missing-reference',
  true,
  true,
  'accepted',
  'partners-pgtap-v1',
  now() - interval '1 hour',
  'partners-disclosure-pgtap-v1',
  now() - interval '1 hour'
from affiliate_private.affiliate_program_versions program
join affiliate_private.affiliate_country_policies policy
  on policy.program_version_id = program.id
  and policy.country_code = 'US'
where program.version_key = 'fiscal-payout-pgtap-v1';

select set_config(
  'test.missing_fiscal_partner_key',
  (
    select affiliate_private.partners_public_account_id(account)
    from affiliate_private.affiliate_accounts account
    where account.user_id = '22000000-0000-4000-8000-000000000003'
  ),
  true
);

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"22000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2","app_metadata":{"role":"admin"}}';

select extensions.throws_ok(
  $$
    select public.admin_partners_fiscal_review_by_public_id(
      current_setting('test.missing_fiscal_partner_key'),
      'verified',
      'norva_tax_review',
      repeat('a', 64),
      'W9',
      'Attempt to bypass the missing self-attestation fixture.'
    )
  $$,
  'P0001',
  'pending fiscal self-attestation is required',
  'Finance cannot insert verified fiscal status without user self-attestation'
);

reset role;
select extensions.throws_ok(
  $$
    insert into affiliate_private.affiliate_fiscal_profiles (
      account_id,
      residence_country_code,
      status,
      verification_provider,
      verification_reference_hash,
      reviewed_at
    )
    select
      account.id,
      'US',
      'verified',
      'norva_tax_review',
      repeat('a', 64),
      now()
    from affiliate_private.affiliate_accounts account
    where account.user_id =
      '22000000-0000-4000-8000-000000000003'
  $$,
  '23514',
  'new row for relation "affiliate_fiscal_profiles" violates check constraint "affiliate_fiscal_profiles_self_attestation"',
  'the table constraint blocks verified even from a privileged direct insert'
);

insert into affiliate_private.affiliate_fiscal_profiles (
  account_id,
  residence_country_code,
  status,
  verification_provider,
  verification_reference_hash,
  reviewed_at
)
select
  account.id,
  'US',
  'expired',
  'legacy_tax_review',
  repeat('a', 64),
  now() - interval '1 day'
from affiliate_private.affiliate_accounts account
where account.user_id =
  '22000000-0000-4000-8000-000000000003';

set local role service_role;
select extensions.is(
  public.partners_service_fiscal_profile_get(
    '22000000-0000-4000-8000-000000000003'
  ) #>> '{fiscal_profile,status}',
  'expired',
  'a legacy profile without synthetic consent is exposed as expired recovery'
);
select extensions.is(
  public.partners_service_fiscal_profile_self_attest(
    '22000000-0000-4000-8000-000000000003',
    'US',
    'partners-tax-self-certification-v1',
    true,
    'fiscal.recovery.00000001'
  ) #>> '{fiscal_profile,status}',
  'pending',
  'the member can recover an expired legacy profile by explicitly attesting'
);

reset role;
insert into affiliate_private.affiliate_service_idempotency (
  operation,
  user_id,
  idempotency_key,
  request_hash,
  response,
  created_at
)
values (
  'payout_onboarding',
  '22000000-0000-4000-8000-000000000003',
  'payout.retention.00000001',
  repeat('8', 64),
  '{"schema_version":1}'::jsonb,
  now() - interval '31 days'
);
set local role service_role;
select public.partners_service_member_write_reserve(
  '22000000-0000-4000-8000-000000000003',
  'payout_onboarding',
  'payout.retention.reserve.00000001',
  repeat('9', 64)
);
reset role;
select extensions.is(
  (
    select count(*)::bigint
    from affiliate_private.affiliate_service_idempotency request_row
    where request_row.operation = 'payout_onboarding'
      and request_row.user_id =
        '22000000-0000-4000-8000-000000000003'
      and request_row.created_at < now() - interval '30 days'
  ),
  0::bigint,
  'durable reservation also removes completed idempotency older than 30 days'
);

set local role service_role;

select extensions.is(
  public.partners_service_payout_onboarding_request(
    '22000000-0000-4000-8000-000000000001',
    'USD',
    true,
    'payout.onboarding.00000003'
  ) #>> '{payout_onboarding,status}',
  'pending',
  'verified fiscal review unlocks the exact active manual corridor'
);
select extensions.is(
  public.partners_service_payout_onboarding_request(
    '22000000-0000-4000-8000-000000000001',
    'USD',
    true,
    'payout.onboarding.00000003'
  ) ->> 'replayed',
  'true',
  'an exact payout onboarding retry replays the stored response'
);

reset role;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"22000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1","app_metadata":{"role":"admin"}}';

select extensions.throws_ok(
  $$
    select public.admin_partners_payout_onboarding_requests(
      25,
      0,
      'pending',
      null
    )
  $$,
  '42501',
  'Partners payout onboarding queue requires AAL2',
  'Finance cannot read the payout onboarding queue at AAL1'
);

set local request.jwt.claims =
  '{"sub":"22000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2","app_metadata":{"role":"admin"}}';

select extensions.is(
  public.admin_partners_payout_onboarding_request_decide(
    public.admin_partners_payout_onboarding_requests(
      1,
      0,
      'pending',
      null
    ) #>> '{items,0,request_key}',
    'start',
    null,
    'Start the manual payout onboarding pgTAP review.'
  ) ->> 'status',
  'in_progress',
  'Finance AAL2 can start a pending onboarding review'
);

select extensions.ok(
  (
    select
      auth_result ->> 'request_key' =
        public.admin_partners_payout_onboarding_requests(
          1,
          0,
          'in_progress',
          null
        ) #>> '{items,0,request_key}'
      and auth_result ->> 'attestation_payload'
        like '%request_key=por_%'
      and auth_result ->> 'attestation_payload'
        not like '%account_id=%'
      and auth_result ? 'binding_ticket'
    from (
      select
        public.admin_partners_revolut_beneficiary_binding_authorize_by_request(
          public.admin_partners_payout_onboarding_requests(
            1,
            0,
            'in_progress',
            null
          ) #>> '{items,0,request_key}',
          '33000000-0000-4000-8000-000000000001',
          '33000000-0000-4000-8000-000000000002',
          'USD account ****4242',
          1,
          repeat('6', 64),
          'Authorize the sanitized request-key beneficiary fixture.'
        ) as auth_result
    ) result
  ),
  'beneficiary authorization uses request_key and returns no account UUID payload'
);

select extensions.ok(
  (
    select
      contact ->> 'action' = 'payout_onboarding_contact_sent'
      and contact ->> 'changed' = 'true'
      and contact ->> 'channel' = 'verified_account_email'
      and contact ->> 'delivery_state' = 'ready'
      and contact ? 'partner_key'
      and not contact ? 'recipient_email'
      and not contact ? 'user_id'
    from (
      select public.admin_partners_payout_onboarding_contact(
        public.admin_partners_payout_onboarding_requests(
          1,
          0,
          'in_progress',
          null
        ) #>> '{items,0,request_key}',
        'secure_setup_invitation',
        '44000000-0000-4000-8000-000000000001'
      ) as contact
    ) result
  ),
  'Finance can contact the partner through the verified support-email outbox'
);

select extensions.is(
  public.admin_partners_payout_onboarding_contact(
    public.admin_partners_payout_onboarding_requests(
      1,
      0,
      'in_progress',
      null
    ) #>> '{items,0,request_key}',
    'secure_setup_invitation',
    '44000000-0000-4000-8000-000000000001'
  ) ->> 'changed',
  'false',
  'an exact payout-contact retry is idempotent before rate limiting'
);
select extensions.throws_ok(
  format(
    'select public.admin_partners_payout_onboarding_contact(%L, %L, %L::uuid)',
    public.admin_partners_payout_onboarding_requests(
      1,
      0,
      'in_progress',
      null
    ) #>> '{items,0,request_key}',
    'setup_follow_up',
    '44000000-0000-4000-8000-000000000002'
  ),
  'P0008',
  'payout onboarding contact rate limit exceeded',
  'a concurrent distinct key for the same request is serialized behind the request quota'
);

reset role;
select extensions.ok(
  exists (
    select 1
    from public.cloud_support_tickets ticket
    join public.cloud_support_messages message
      on message.ticket_id = ticket.id
    join public.cloud_support_email_outbox outbox
      on outbox.message_id = message.id
      and outbox.direction = 'support_to_user'
    where ticket.channel = 'partners_payout_onboarding'
      and message.request_id =
        '44000000-0000-4000-8000-000000000001'
      and outbox.state = 'ready'
  ),
  'the payout contact is durably linked to the existing support ticket and outbox'
);
update affiliate_private.affiliate_accounts account
set status = 'held', updated_at = now()
where account.user_id = '22000000-0000-4000-8000-000000000001';
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"22000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2","app_metadata":{"role":"admin"}}';
select extensions.throws_ok(
  $$
    select public.admin_partners_payout_onboarding_request_decide(
      public.admin_partners_payout_onboarding_requests(
        1,
        0,
        'in_progress',
        null
      ) #>> '{items,0,request_key}',
      'complete',
      null,
      'Reject completion while the Partner account is held.'
    )
  $$,
  'P0001',
  'payout onboarding eligibility is no longer valid',
  'completion revalidates that the account is still active'
);
reset role;
update affiliate_private.affiliate_accounts account
set status = 'active', updated_at = now()
where account.user_id = '22000000-0000-4000-8000-000000000001';

update affiliate_private.affiliate_fiscal_profiles fiscal_profile
set status = 'expired', updated_at = now()
from affiliate_private.affiliate_accounts account
where account.id = fiscal_profile.account_id
  and account.user_id = '22000000-0000-4000-8000-000000000001';
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"22000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2","app_metadata":{"role":"admin"}}';
select extensions.throws_ok(
  $$
    select public.admin_partners_payout_onboarding_request_decide(
      public.admin_partners_payout_onboarding_requests(
        1,
        0,
        'in_progress',
        null
      ) #>> '{items,0,request_key}',
      'complete',
      null,
      'Reject completion while fiscal verification is expired.'
    )
  $$,
  'P0001',
  'payout onboarding eligibility is no longer valid',
  'completion revalidates current fiscal verification and attestation'
);
reset role;
update affiliate_private.affiliate_fiscal_profiles fiscal_profile
set status = 'verified', updated_at = now()
from affiliate_private.affiliate_accounts account
where account.id = fiscal_profile.account_id
  and account.user_id = '22000000-0000-4000-8000-000000000001';

update affiliate_private.affiliate_payout_provider_configs route
set status = 'disabled', updated_at = now()
where route.provider = 'revolut'
  and route.country_code = 'US'
  and route.currency = 'USD';
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"22000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2","app_metadata":{"role":"admin"}}';
select extensions.throws_ok(
  $$
    select public.admin_partners_payout_onboarding_request_decide(
      public.admin_partners_payout_onboarding_requests(
        1,
        0,
        'in_progress',
        null
      ) #>> '{items,0,request_key}',
      'complete',
      null,
      'Reject completion while the manual payout route is disabled.'
    )
  $$,
  'P0001',
  'payout onboarding eligibility is no longer valid',
  'completion revalidates that the manual corridor is still active'
);
reset role;
update affiliate_private.affiliate_payout_provider_configs route
set execution_adapter = 'revolut_api', updated_at = now()
where route.provider = 'revolut'
  and route.country_code = 'US'
  and route.currency = 'USD';
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"22000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2","app_metadata":{"role":"admin"}}';
select extensions.throws_ok(
  $$
    select public.admin_partners_payout_onboarding_request_decide(
      public.admin_partners_payout_onboarding_requests(
        1,
        0,
        'in_progress',
        null
      ) #>> '{items,0,request_key}',
      'complete',
      null,
      'Reject completion for an API-configured payout corridor.'
    )
  $$,
  'P0001',
  'payout onboarding eligibility is no longer valid',
  'completion never accepts a Revolut API corridor in the manual flow'
);
reset role;
update affiliate_private.affiliate_payout_provider_configs route
set execution_adapter = 'revolut_manual', status = 'active', updated_at = now()
where route.provider = 'revolut'
  and route.country_code = 'US'
  and route.currency = 'USD';
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"22000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2","app_metadata":{"role":"admin"}}';

select extensions.throws_ok(
  $$
    select public.admin_partners_payout_onboarding_request_decide(
      public.admin_partners_payout_onboarding_requests(
        1,
        0,
        'in_progress',
        null
      ) #>> '{items,0,request_key}',
      'complete',
      null,
      'Attempt completion without a verified beneficiary binding.'
    )
  $$,
  'P0001',
  'active verified Revolut binding and profile are required',
  'Finance cannot complete onboarding without maker-checker binding/profile'
);

select extensions.is(
  public.admin_partners_payout_onboarding_request_decide(
    public.admin_partners_payout_onboarding_requests(
      1,
      0,
      'in_progress',
      null
    ) #>> '{items,0,request_key}',
    'reject',
    'beneficiary_setup_required',
    'Reject the incomplete beneficiary setup pgTAP fixture.'
  ) ->> 'status',
  'rejected',
  'Finance AAL2 can reject an incomplete onboarding request'
);

reset role;
select extensions.throws_ok(
  $$
    update affiliate_private.affiliate_payout_onboarding_requests request_row
    set status = 'pending', reason_code = null, rejected_at = null
    where request_row.status = 'rejected'
      and request_row.account_id = (
        select account.id
        from affiliate_private.affiliate_accounts account
        where account.user_id =
          '22000000-0000-4000-8000-000000000001'
      )
  $$,
  '55000',
  'invalid payout onboarding transition',
  'a rejected request cannot be reopened inside the same revision'
);

set local role service_role;

select extensions.is(
  public.partners_service_payout_onboarding_request(
    '22000000-0000-4000-8000-000000000001',
    'USD',
    true,
    'payout.onboarding.00000004'
  ) #>> '{payout_onboarding,status}',
  'pending',
  'a rejected terminal request can be resubmitted as a new revision'
);
reset role;
select extensions.is(
  (
    select max(request_row.revision)
    from affiliate_private.affiliate_payout_onboarding_requests request_row
    join affiliate_private.affiliate_accounts account
      on account.id = request_row.account_id
    where account.user_id =
      '22000000-0000-4000-8000-000000000001'
      and request_row.currency = 'USD'
  ),
  2,
  'resubmission increments the immutable request revision'
);
select extensions.is(
  (
    select count(*)::integer
    from affiliate_private.affiliate_payout_onboarding_requests request_row
    join affiliate_private.affiliate_accounts account
      on account.id = request_row.account_id
    where account.user_id =
      '22000000-0000-4000-8000-000000000001'
      and request_row.currency = 'USD'
  ),
  2,
  'rejected evidence is retained instead of being overwritten'
);

-- Completed onboarding remains immutable evidence, while its live readiness
-- is derived from the current route, fiscal/contract and beneficiary state.
-- Build a fully linked verified binding/profile fixture from the ticket that
-- the audited Admin authorization above already created.
update affiliate_private.affiliate_revolut_beneficiary_binding_tickets ticket
set consumed_at = greatest(
  ticket.created_at,
  least(now(), ticket.expires_at)
)
where ticket.id = (
  select candidate.id
  from affiliate_private.affiliate_revolut_beneficiary_binding_tickets candidate
  join affiliate_private.affiliate_accounts account
    on account.id = candidate.account_id
  where account.user_id = '22000000-0000-4000-8000-000000000001'
    and candidate.currency = 'USD'
  order by candidate.created_at desc, candidate.id
  limit 1
)
  and ticket.consumed_at is null;

insert into affiliate_private.affiliate_revolut_beneficiary_bindings (
  account_id,
  currency,
  binding_version,
  beneficiary_token_ref,
  beneficiary_payment_method_ref,
  destination_masked,
  beneficiary_fingerprint_hmac,
  mapping_attestation_hmac,
  fingerprint_key_version,
  mapping_evidence_hash,
  authorization_ticket_id,
  status,
  proposed_by_pseudonym,
  verified_by_pseudonym,
  proposal_justification,
  verification_justification,
  proposed_at,
  verified_at
)
select
  ticket.account_id,
  ticket.currency,
  1,
  ticket.beneficiary_token_ref,
  ticket.beneficiary_payment_method_ref,
  ticket.destination_masked,
  repeat('1', 64),
  repeat('2', 64),
  ticket.fingerprint_key_version,
  ticket.mapping_evidence_hash,
  ticket.id,
  'active',
  repeat('3', 64),
  repeat('4', 64),
  'Create the stateful completed-onboarding binding fixture.',
  'Verify the stateful completed-onboarding binding fixture.',
  ticket.created_at,
  greatest(ticket.created_at, least(now(), ticket.expires_at))
from affiliate_private.affiliate_revolut_beneficiary_binding_tickets ticket
join affiliate_private.affiliate_accounts account
  on account.id = ticket.account_id
where account.user_id = '22000000-0000-4000-8000-000000000001'
  and ticket.currency = 'USD'
order by ticket.created_at desc, ticket.id
limit 1;

insert into affiliate_private.affiliate_payout_profiles (
  account_id,
  provider,
  beneficiary_token_ref,
  beneficiary_payment_method_ref,
  display_masked,
  currency,
  status,
  revolut_binding_id,
  revolut_binding_version,
  updated_at
)
select
  binding.account_id,
  'revolut',
  binding.beneficiary_token_ref,
  binding.beneficiary_payment_method_ref,
  binding.destination_masked,
  binding.currency,
  'active',
  binding.id,
  binding.binding_version,
  now()
from affiliate_private.affiliate_revolut_beneficiary_bindings binding
join affiliate_private.affiliate_accounts account
  on account.id = binding.account_id
where account.user_id = '22000000-0000-4000-8000-000000000001'
  and binding.currency = 'USD'
  and binding.status = 'active';

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"22000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2","app_metadata":{"role":"admin"}}';
select extensions.is(
  public.admin_partners_payout_onboarding_request_decide(
    public.admin_partners_payout_onboarding_requests(
      1,
      0,
      'pending',
      null
    ) #>> '{items,0,request_key}',
    'start',
    null,
    'Start the completed reconfiguration state fixture.'
  ) ->> 'status',
  'in_progress',
  'Finance starts the stateful completed-onboarding fixture'
);
select extensions.is(
  public.admin_partners_payout_onboarding_request_decide(
    public.admin_partners_payout_onboarding_requests(
      1,
      0,
      'in_progress',
      null
    ) #>> '{items,0,request_key}',
    'complete',
    null,
    'Complete the current and fully verified payout setup fixture.'
  ) ->> 'status',
  'completed',
  'Finance completes the fixture only with current route and evidence'
);
select extensions.is(
  public.admin_partners_payout_onboarding_requests(
    1,
    0,
    'completed',
    null
  ) #>> '{items,0,reconfiguration_required}',
  'false',
  'Finance sees no reconfiguration while every dependency is current'
);
reset role;

set local role service_role;
select extensions.ok(
  (
    select
      response #>> '{payout_onboarding,status}' = 'completed'
      and response #>> '{payout_onboarding,reconfiguration_required}' = 'false'
      and response -> 'allowed_currencies' = '["USD"]'::jsonb
    from (
      select public.partners_service_payout_onboarding_get(
        '22000000-0000-4000-8000-000000000001'
      ) as response
    ) loaded
  ),
  'member sees completed while route, fiscal, contract and binding are current'
);
reset role;

update affiliate_private.affiliate_payout_provider_configs route
set status = 'disabled', updated_at = now()
where route.provider = 'revolut'
  and route.country_code = 'US'
  and route.currency = 'USD';
set local role service_role;
select extensions.ok(
  (
    select
      response #>> '{payout_onboarding,status}' = 'completed'
      and response #>> '{payout_onboarding,reconfiguration_required}' = 'true'
      and response -> 'allowed_currencies' = '[]'::jsonb
    from (
      select public.partners_service_payout_onboarding_get(
        '22000000-0000-4000-8000-000000000001'
      ) as response
    ) loaded
  ),
  'a disabled route makes completed onboarding require reconfiguration'
);
reset role;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"22000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2","app_metadata":{"role":"admin"}}';
select extensions.is(
  public.admin_partners_payout_onboarding_requests(
    1,
    0,
    'completed',
    null
  ) #>> '{items,0,reconfiguration_required}',
  'true',
  'Finance sees the same route-driven reconfiguration state'
);
reset role;
update affiliate_private.affiliate_payout_provider_configs route
set status = 'active', updated_at = now()
where route.provider = 'revolut'
  and route.country_code = 'US'
  and route.currency = 'USD';

update affiliate_private.affiliate_fiscal_profiles fiscal_profile
set status = 'expired', updated_at = now()
from affiliate_private.affiliate_accounts account
where account.id = fiscal_profile.account_id
  and account.user_id = '22000000-0000-4000-8000-000000000001';
set local role service_role;
select extensions.ok(
  (
    select
      response #>> '{payout_onboarding,reconfiguration_required}' = 'true'
      and response -> 'allowed_currencies' = '[]'::jsonb
    from (
      select public.partners_service_payout_onboarding_get(
        '22000000-0000-4000-8000-000000000001'
      ) as response
    ) loaded
  ),
  'expired fiscal evidence makes completed onboarding require reconfiguration'
);
reset role;
update affiliate_private.affiliate_fiscal_profiles fiscal_profile
set status = 'verified', updated_at = now()
from affiliate_private.affiliate_accounts account
where account.id = fiscal_profile.account_id
  and account.user_id = '22000000-0000-4000-8000-000000000001';

-- Active-account guards prevent persisted stale acceptances. Exercise the
-- exact current-currency helper with a drifted copy of the real account row to
-- prove a policy terms/disclosure revision fails closed as well.
select extensions.ok(
  (
    select
      affiliate_private
        .partners_payout_onboarding_reconfiguration_required(
          pg_catalog.jsonb_populate_record(
            account,
            '{"terms_version_accepted":"partners-stale-terms-v2","disclosure_version_accepted":"partners-stale-disclosure-v2"}'::jsonb
          ),
          request_row
        )
      and affiliate_private.partners_payout_onboarding_allowed_currencies(
        pg_catalog.jsonb_populate_record(
          account,
          '{"terms_version_accepted":"partners-stale-terms-v2","disclosure_version_accepted":"partners-stale-disclosure-v2"}'::jsonb
        )
      ) = '[]'::jsonb
    from affiliate_private.affiliate_accounts account
    join lateral (
      select candidate.*
      from affiliate_private.affiliate_payout_onboarding_requests candidate
      where candidate.account_id = account.id
        and candidate.currency = 'USD'
      order by candidate.revision desc
      limit 1
    ) request_row on true
    where account.user_id = '22000000-0000-4000-8000-000000000001'
  ),
  'terms or disclosure policy drift removes the currency and requires reconfiguration'
);

update affiliate_private.affiliate_payout_profiles profile
set status = 'disabled', updated_at = now()
from affiliate_private.affiliate_accounts account
where account.id = profile.account_id
  and account.user_id = '22000000-0000-4000-8000-000000000001'
  and profile.currency = 'USD';
set local role service_role;
select extensions.ok(
  (
    select
      response #>> '{payout_onboarding,reconfiguration_required}' = 'true'
      and response -> 'allowed_currencies' = '["USD"]'::jsonb
    from (
      select public.partners_service_payout_onboarding_get(
        '22000000-0000-4000-8000-000000000001'
      ) as response
    ) loaded
  ),
  'an inactive payout profile requires reconfiguration even while USD is allowed'
);
reset role;
update affiliate_private.affiliate_payout_profiles profile
set
  status = 'active',
  revolut_binding_id = binding.id,
  revolut_binding_version = binding.binding_version,
  updated_at = now()
from affiliate_private.affiliate_revolut_beneficiary_bindings binding
where binding.account_id = profile.account_id
  and binding.currency = profile.currency
  and binding.status = 'active'
  and profile.account_id = (
    select account.id
    from affiliate_private.affiliate_accounts account
    where account.user_id = '22000000-0000-4000-8000-000000000001'
  )
  and profile.currency = 'USD';

update affiliate_private.affiliate_revolut_beneficiary_bindings binding
set
  status = 'revoked',
  revoked_by_pseudonym = repeat('5', 64),
  revocation_justification =
    'Revoke the binding to exercise stateful reconfiguration detection.',
  revoked_at = now()
where binding.account_id = (
  select account.id
  from affiliate_private.affiliate_accounts account
  where account.user_id = '22000000-0000-4000-8000-000000000001'
)
  and binding.currency = 'USD'
  and binding.status = 'active';
set local role service_role;
select extensions.ok(
  (
    select
      response #>> '{payout_onboarding,reconfiguration_required}' = 'true'
      and response -> 'allowed_currencies' = '["USD"]'::jsonb
    from (
      select public.partners_service_payout_onboarding_get(
        '22000000-0000-4000-8000-000000000001'
      ) as response
    ) loaded
  ),
  'a revoked binding requires reconfiguration even while USD is allowed'
);
reset role;

insert into affiliate_private.affiliate_member_write_reservations (
  operation,
  user_id,
  idempotency_key,
  request_hash,
  reserved_at,
  last_seen_at
)
select
  'payout_onboarding',
  '22000000-0000-4000-8000-000000000001',
  case series.value
    when 1 then 'payout.onboarding.00000003'
    when 2 then 'payout.onboarding.00000004'
    else 'payout.throttle.' || lpad(series.value::text, 8, '0')
  end,
  repeat('7', 64),
  now(),
  now()
from generate_series(1, 8) as series(value);

set local role service_role;
select extensions.is(
  public.partners_service_payout_onboarding_request(
    '22000000-0000-4000-8000-000000000001',
    'USD',
    true,
    'payout.onboarding.00000004'
  ) ->> 'replayed',
  'true',
  'an exact payout replay remains available after the new-key quota is full'
);
select extensions.throws_ok(
  $$
    select public.partners_service_member_write_reserve(
      '22000000-0000-4000-8000-000000000001',
      'payout_onboarding',
      'payout.onboarding.00000005',
      repeat('6', 64)
    )
  $$,
  'P0008',
  'Partners fiscal or payout onboarding rate limit exceeded',
  'the ninth distinct payout-onboarding key in 24 hours is rate limited'
);
reset role;

select * from extensions.finish();
rollback;
