begin;

create extension if not exists pgtap with schema extensions;
select extensions.no_plan();

select extensions.ok(
  to_regclass(
    'affiliate_private.affiliate_approval_packages'
  ) is not null
  and to_regclass(
    'affiliate_private.affiliate_release_gate_approval_bindings'
  ) is not null
  and to_regclass(
    'affiliate_private.affiliate_deployment_manifests'
  ) is not null
  and to_regclass(
    'affiliate_private.affiliate_deployment_manifest_bindings'
  ) is not null,
  'immutable deployment manifests, approval packages and bindings exist'
);

select extensions.ok(
  (
    select relation.relrowsecurity
    from pg_catalog.pg_class relation
    where relation.oid =
      'affiliate_private.affiliate_approval_packages'::regclass
  )
  and (
    select relation.relrowsecurity
    from pg_catalog.pg_class relation
    where relation.oid =
      'affiliate_private.affiliate_release_gate_approval_bindings'::regclass
  )
  and not has_table_privilege(
    'authenticated',
    'affiliate_private.affiliate_approval_packages',
    'SELECT'
  )
  and not has_table_privilege(
    'service_role',
    'affiliate_private.affiliate_approval_packages',
    'SELECT'
  )
  and not has_table_privilege(
    'authenticated',
    'affiliate_private.affiliate_deployment_manifests',
    'SELECT'
  ),
  'approval evidence is RLS-protected and unavailable through API roles'
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
) values (
  '60000000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated',
  'authenticated',
  'partners-approval-admin@example.invalid',
  '',
  now(),
  '{
    "provider":"email",
    "providers":["email"],
    "role":"admin",
    "partners_release_manager":true
  }'::jsonb,
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
) values (
  '60000000-0000-4000-8000-000000000002',
  '60000000-0000-4000-8000-000000000001',
  'Partners approval registry test',
  'totp',
  'verified',
  now(),
  now(),
  'partners-approval-test-secret'
);

insert into affiliate_private.affiliate_admin_capabilities (
  user_id,
  capability,
  enabled,
  granted_by_pseudonym,
  justification
) values
  (
    '60000000-0000-4000-8000-000000000001',
    'support',
    true,
    repeat('a', 64),
    'Approval registry integration Support fixture.'
  ),
  (
    '60000000-0000-4000-8000-000000000001',
    'risk',
    true,
    repeat('a', 64),
    'Approval registry integration Risk fixture.'
  ),
  (
    '60000000-0000-4000-8000-000000000001',
    'finance',
    true,
    repeat('a', 64),
    'Approval registry integration Finance fixture.'
  );

insert into affiliate_private.affiliate_program_versions (
  version_key,
  status,
  commission_rate_bps,
  attribution_window_days,
  maturation_days,
  payout_thresholds,
  terms_version,
  disclosure_version,
  effective_from
) values (
  'approval-registry-test-v1',
  'draft',
  2000,
  30,
  45,
  '{"USD":1000}'::jsonb,
  'partners-terms-test-v1',
  'partners-disclosure-test-v1',
  now() - interval '1 minute'
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
  'FR',
  false,
  18,
  true,
  'identity_age_country_capacity',
  'didit',
  array['USD']::text[],
  program.terms_version,
  program.disclosure_version,
  now() - interval '1 minute'
from affiliate_private.affiliate_program_versions program
where program.version_key = 'approval-registry-test-v1';

set local role authenticated;
set local request.jwt.claims =
  '{
    "sub":"60000000-0000-4000-8000-000000000001",
    "role":"authenticated",
    "aal":"aal1",
    "app_metadata":{
      "role":"admin",
      "partners_release_manager":true
    }
  }';

select extensions.throws_ok(
  $$
    select public.admin_partners_release_gate_approve(
      'privacy_approved',
      'approval-registry-test-v1',
      '[{"country_code":"FR"}]'::jsonb,
      jsonb_build_object(
        'approval_record', repeat('1', 64),
        'deployment_proof', repeat('b', 64),
        'dpia', repeat('3', 64),
        'gdpr_self_assessment', repeat('4', 64),
        'biometric_consent', repeat('d', 64),
        'privacy_notice', repeat('5', 64),
        'records_of_processing', repeat('6', 64)
      ),
      repeat('a', 40),
      'production',
      'approval-registry-test-deployment',
      repeat('b', 64),
      now() + interval '30 days',
      'AAL1 must never register a privacy approval package.'
    )
  $$,
  '42501',
  'Partners approval package registration requires AAL2',
  'approval package registration fails closed at AAL1'
);

select extensions.throws_ok(
  $$
    select public.admin_partners_control(
      'set_gate',
      'membership_privacy_approved',
      true,
      'AAL1 must not approve the public membership privacy gate.'
    )
  $$,
  '42501',
  'Risk Partners approval requires AAL2',
  'membership privacy approval fails closed at AAL1'
);

select extensions.throws_ok(
  $$
    select public.admin_partners_control(
      'set_gate',
      'privacy_approved',
      true,
      'AAL1 must not approve the biometric cash privacy gate.'
    )
  $$,
  '42501',
  'Risk Partners approval requires AAL2',
  'biometric cash privacy approval fails closed at AAL1'
);

set local request.jwt.claims =
  '{
    "sub":"60000000-0000-4000-8000-000000000001",
    "role":"authenticated",
    "aal":"aal2",
    "app_metadata":{
      "role":"admin",
      "partners_release_manager":true
    }
  }';

select extensions.throws_ok(
  $$
    select public.admin_partners_deployment_manifest_register(
      'production', repeat('a', 40),
      'approval-registry-zero-proof', repeat('0', 64),
      jsonb_build_object('deployment_proof', repeat('0', 64)),
      'A placeholder proof must never become release evidence.'
    )
  $$,
  '22023',
  'invalid Partners deployment manifest',
  'an all-zero evidence hash is rejected server-side'
);

select extensions.throws_ok(
  $$
    select public.admin_partners_deployment_manifest_register(
      'production', repeat('a', 40),
      'approval-registry-duplicate-proof', repeat('b', 64),
      jsonb_build_object(
        'deployment_proof', repeat('b', 64),
        'approval_record', repeat('b', 64)
      ),
      'Duplicated evidence hashes must never be accepted.'
    )
  $$,
  '22023',
  'invalid Partners deployment manifest',
  'duplicated evidence hashes are rejected server-side'
);

select extensions.throws_ok(
  $$
    select public.admin_partners_deployment_manifest_register(
      'production', repeat('a', 40),
      'approval-registry-mismatched-proof', repeat('b', 64),
      jsonb_build_object('deployment_proof', repeat('2', 64)),
      'The canonical deployment proof must match its dedicated field.'
    )
  $$,
  '22023',
  'invalid Partners deployment manifest',
  'the deployment_proof document must match the canonical deployment hash'
);

select extensions.is(
  public.admin_partners_deployment_manifest_register(
    'production',
    repeat('a', 40),
    'approval-registry-test-deployment',
    repeat('b', 64),
    jsonb_build_object(
      'approval_record', repeat('1', 64),
      'deployment_proof', repeat('b', 64),
      'dpia', repeat('3', 64),
      'gdpr_self_assessment', repeat('4', 64),
      'biometric_consent', repeat('d', 64),
      'privacy_notice', repeat('5', 64),
      'records_of_processing', repeat('6', 64),
      'legal_tax_review', repeat('7', 64),
      'partners_terms', repeat('8', 64),
      'country_policy_review', repeat('9', 64),
      'payout_corridor_review', repeat('c', 64)
    ),
    'Register the exact preproduction approval test deployment.'
  ) ->> 'action',
  'deployment_manifest_registered',
  'AAL2 release manager registers the authoritative deployment manifest'
);

select extensions.is(
  public.admin_partners_deployment_manifest_register(
    'production',
    repeat('a', 40),
    'approval-registry-test-deployment',
    repeat('b', 64),
    jsonb_build_object(
      'approval_record', repeat('1', 64),
      'deployment_proof', repeat('b', 64),
      'dpia', repeat('3', 64),
      'gdpr_self_assessment', repeat('4', 64),
      'biometric_consent', repeat('d', 64),
      'privacy_notice', repeat('5', 64),
      'records_of_processing', repeat('6', 64),
      'legal_tax_review', repeat('7', 64),
      'partners_terms', repeat('8', 64),
      'country_policy_review', repeat('9', 64),
      'payout_corridor_review', repeat('c', 64)
    ),
    'Idempotent retry of the exact preproduction deployment.'
  ) ->> 'action',
  'deployment_manifest_unchanged',
  'an exact deployment-manifest retry is an idempotent no-op'
);

select extensions.throws_ok(
  $$
    select public.admin_partners_release_gate_approve(
      'privacy_approved',
      'approval-registry-test-v1',
      '[{"country_code":"FR"}]'::jsonb,
      jsonb_build_object(
        'approval_record', repeat('1', 64),
        'deployment_proof', repeat('b', 64),
        'gdpr_self_assessment', repeat('4', 64),
        'biometric_consent', repeat('d', 64),
        'privacy_notice', repeat('5', 64),
        'records_of_processing', repeat('6', 64)
      ),
      repeat('a', 40),
      'production',
      'approval-registry-test-deployment',
      repeat('b', 64),
      now() + interval '30 days',
      'An incomplete privacy package must be rejected.'
    )
  $$,
  '22023',
  'Partners approval package is missing required evidence: dpia',
  'privacy approval cannot omit the DPIA evidence hash'
);

select extensions.throws_ok(
  $$
    select public.admin_partners_release_gate_approve(
      'privacy_approved',
      'approval-registry-test-v1',
      '[{"country_code":"FR"}]'::jsonb,
      jsonb_build_object(
        'approval_record', repeat('1', 64),
        'deployment_proof', repeat('2', 64),
        'dpia', repeat('3', 64),
        'gdpr_self_assessment', repeat('4', 64),
        'biometric_consent', repeat('d', 64),
        'privacy_notice', repeat('5', 64),
        'records_of_processing', repeat('6', 64)
      ),
      repeat('a', 40),
      'production',
      'approval-registry-test-deployment',
      repeat('b', 64),
      now() + interval '30 days',
      'A package cannot substitute a different deployment proof.'
    )
  $$,
  '22023',
  'invalid Partners approval package',
  'gate approval enforces the canonical deployment proof server-side'
);

select extensions.is(
  public.admin_partners_release_gate_approve(
    'privacy_approved',
    'approval-registry-test-v1',
    '[{"country_code":"FR"}]'::jsonb,
    jsonb_build_object(
      'approval_record', repeat('1', 64),
      'deployment_proof', repeat('b', 64),
      'dpia', repeat('3', 64),
      'gdpr_self_assessment', repeat('4', 64),
      'biometric_consent', repeat('d', 64),
      'privacy_notice', repeat('5', 64),
      'records_of_processing', repeat('6', 64)
    ),
    repeat('a', 40),
    'production',
    'approval-registry-test-deployment',
    repeat('b', 64),
    now() + interval '30 days',
    'Documented France pilot privacy approval package.'
  ) ->> 'satisfied',
  'true',
  'Risk plus AAL2 can atomically register and bind privacy evidence'
);

select extensions.ok(
  affiliate_private.release_gates_satisfied(
    array['privacy_approved']::text[]
  ),
  'a bound package makes its exact release gate effective'
);

select extensions.ok(
  exists (
    select 1
    from affiliate_private.affiliate_release_gates gate
    where gate.gate_key = 'membership_privacy_approved'
      and not gate.satisfied
  )
  and affiliate_private.partners_approval_required_document_keys(
    'membership_privacy_approved'
  ) @> array[
    'approval_record',
    'deployment_proof',
    'gdpr_self_assessment',
    'privacy_notice',
    'records_of_processing'
  ]::text[]
  and not (
    affiliate_private.partners_approval_required_document_keys(
      'membership_privacy_approved'
    ) && array['dpia', 'biometric_consent']::text[]
  )
  and not affiliate_private.release_gates_satisfied(
    array['membership_privacy_approved']::text[]
  ),
  'membership privacy starts false and requires public-membership evidence without Didit artifacts'
);

select extensions.throws_ok(
  $$
    update affiliate_private.affiliate_approval_packages
    set expires_at = expires_at + interval '1 day'
    where gate_key = 'privacy_approved'
  $$,
  '55000',
  'Partners approval packages are append-only',
  'approval package evidence cannot be rewritten'
);

select extensions.is(
  public.admin_partners_release_gate_approve(
    'legal_and_tax_approved',
    'approval-registry-test-v1',
    '[{"country_code":"FR"}]'::jsonb,
    jsonb_build_object(
      'approval_record', repeat('1', 64),
      'deployment_proof', repeat('b', 64),
      'legal_tax_review', repeat('7', 64),
      'partners_terms', repeat('8', 64)
    ),
    repeat('a', 40),
    'production',
    'approval-registry-test-deployment',
    repeat('b', 64),
    now() + interval '30 days',
    'Documented France pilot legal and tax approval package.'
  ) ->> 'satisfied',
  'true',
  'Finance plus AAL2 can bind legal and tax evidence'
);

select extensions.throws_ok(
  $$
    select public.admin_partners_program_activate(
      'approval-registry-test-v1',
      'ACTIVATE:approval-registry-test-v1',
      'Membership privacy approval is deliberately still absent.'
    )
  $$,
  'P0001',
  'program legal gates are incomplete',
  'legal and Didit privacy evidence cannot activate public membership without its own privacy gate'
);

select extensions.is(
  public.admin_partners_release_gate_approve(
    'membership_privacy_approved',
    'approval-registry-test-v1',
    '[{"country_code":"FR"}]'::jsonb,
    jsonb_build_object(
      'approval_record', repeat('1', 64),
      'deployment_proof', repeat('b', 64),
      'gdpr_self_assessment', repeat('4', 64),
      'privacy_notice', repeat('5', 64),
      'records_of_processing', repeat('6', 64)
    ),
    repeat('a', 40),
    'production',
    'approval-registry-test-deployment',
    repeat('b', 64),
    now() + interval '30 days',
    'Documented public membership privacy self-assessment package.'
  ) ->> 'satisfied',
  'true',
  'Risk plus AAL2 binds the independent public-membership privacy package'
);

select extensions.ok(
  affiliate_private.release_gates_satisfied(
    array['membership_privacy_approved']::text[]
  )
  and affiliate_private.release_gates_satisfied(
    array['privacy_approved']::text[]
  )
  and lower(pg_get_functiondef(
    'affiliate_private.guard_partners_program_approved_scope()'::regprocedure
  )) like '%membership_privacy_approved%'
  and lower(pg_get_functiondef(
    'affiliate_private.guard_partners_program_approved_scope()'::regprocedure
  )) not like '%binding.gate_key = ''privacy_approved''%'
  and lower(pg_get_functiondef(
    'affiliate_private.guard_partners_country_policy_approved_scope()'::regprocedure
  )) like '%privacy_approved%'
  and lower(pg_get_functiondef(
    'affiliate_private.guard_partners_country_policy_approved_scope()'::regprocedure
  )) not like '%membership_privacy_approved%',
  'programme membership and country-policy Didit privacy scopes remain independent'
);

select extensions.is(
  public.admin_partners_release_gate_approve(
    'country_policy_approved',
    'approval-registry-test-v1',
    '[{"country_code":"FR"}]'::jsonb,
    jsonb_build_object(
      'approval_record', repeat('1', 64),
      'deployment_proof', repeat('b', 64),
      'country_policy_review', repeat('9', 64),
      'payout_corridor_review', repeat('c', 64)
    ),
    repeat('a', 40),
    'production',
    'approval-registry-test-deployment',
    repeat('b', 64),
    now() + interval '30 days',
    'Documented France pilot country policy approval package.'
  ) ->> 'satisfied',
  'true',
  'Risk plus AAL2 can bind exact country-policy evidence'
);

select extensions.is(
  public.admin_partners_program_activate(
    'approval-registry-test-v1',
    'ACTIVATE:approval-registry-test-v1',
    'Activate the programme after legal and membership privacy approval.'
  ) ->> 'action',
  'program_activated',
  'legal plus membership privacy activates the programme without requiring Didit privacy'
);

reset role;

update affiliate_private.affiliate_country_policies policy
set individual_available = true
from affiliate_private.affiliate_program_versions program
where program.id = policy.program_version_id
  and program.version_key = 'approval-registry-test-v1'
  and policy.country_code = 'FR';

select extensions.ok(
  exists (
    select 1
    from affiliate_private.affiliate_country_policies policy
    join affiliate_private.affiliate_program_versions program
      on program.id = policy.program_version_id
    where program.version_key = 'approval-registry-test-v1'
      and policy.country_code = 'FR'
      and policy.individual_available
  ),
  'an exact legal, privacy and country scope can become available'
);

select extensions.throws_ok(
  $$
    update affiliate_private.affiliate_country_policies policy
    set minimum_age = 21
    from affiliate_private.affiliate_program_versions program
    where program.id = policy.program_version_id
      and program.version_key = 'approval-registry-test-v1'
      and policy.country_code = 'FR'
  $$,
  '55000',
  'revoke scoped Partners release gates before changing the country policy',
  'a substantive country-policy change requires new versioned evidence'
);

set local role authenticated;
set local request.jwt.claims =
  '{
    "sub":"60000000-0000-4000-8000-000000000001",
    "role":"authenticated",
    "aal":"aal2",
    "app_metadata":{
      "role":"admin",
      "partners_release_manager":true
    }
  }';

select extensions.is(
  public.admin_partners_control(
    'set_flag',
    'partners_enabled',
    true,
    'Open public membership only after its legal and privacy packages.'
  ) ->> 'enabled',
  'true',
  'public membership can be enabled after legal plus membership privacy approval'
);

select extensions.throws_ok(
  $$
    select public.admin_partners_control(
      'set_gate',
      'membership_privacy_approved',
      false,
      'Attempt to revoke membership privacy while membership remains live.'
    )
  $$,
  '55000',
  'disable dependent Partners flags first',
  'membership privacy cannot be revoked while public membership is enabled'
);

select extensions.is(
  public.admin_partners_control(
    'set_flag',
    'partners_enabled',
    false,
    'Close public membership before revoking its privacy approval.'
  ) ->> 'enabled',
  'false',
  'the membership kill switch can be closed before privacy revocation'
);

select extensions.is(
  public.admin_partners_control(
    'set_gate',
    'membership_privacy_approved',
    false,
    'Revoke membership privacy after the public membership kill switch.'
  ) ->> 'satisfied',
  'false',
  'membership privacy can be revoked after its dependent feature is closed'
);

select extensions.ok(
  affiliate_private.release_gates_satisfied(
    array['privacy_approved']::text[]
  )
  and not affiliate_private.release_gates_satisfied(
    array['membership_privacy_approved']::text[]
  ),
  'revoking membership privacy leaves the biometric Didit privacy gate untouched'
);

select extensions.ok(
  (
    public.admin_partners_configuration()
      -> 'release_gates'
      @> '[{
        "key":"privacy_approved",
        "satisfied":true,
        "recorded_satisfied":true,
        "approval_status":"current"
      }]'::jsonb
  )
  and exists (
    select 1
    from jsonb_array_elements(
      public.admin_partners_configuration() -> 'release_gates'
    ) gate(item)
    where gate.item ->> 'key' = 'privacy_approved'
      and gate.item -> 'approval_provenance' ->> 'package_sha256'
        ~ '^[0-9a-f]{64}$'
      and gate.item -> 'approval_provenance'
        ->> 'deployment_manifest_sha256' ~ '^[0-9a-f]{64}$'
  )
  and exists (
    select 1
    from jsonb_array_elements(
      public.admin_partners_configuration() -> 'deployment_manifests'
    ) deployment(item)
    where deployment.item ->> 'deployment_environment' = 'production'
      and deployment.item ->> 'manifest_sha256' ~ '^[0-9a-f]{64}$'
      and deployment.item ->> 'source_commit_sha' = repeat('a', 40)
  )
  and not (
    public.admin_partners_configuration()::text
      like '%approved_by_pseudonym%'
  )
  and not (
    public.admin_partners_configuration()::text
      like '%justification%'
  )
  and not (
    public.admin_partners_configuration()::text
      like '%registered_by_pseudonym%'
  )
  and not (
    public.admin_partners_configuration()::text
      like '%document_hashes%'
  ),
  'Admin configuration exposes current sanitized provenance only'
);

select extensions.ok(
  lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_assert_didit_certification_pre_gate()'::regprocedure
  )) like '%partners_release_gate_approval_is_current%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_assert_didit_certification_pre_gate()'::regprocedure
  )) not like '%and gate.satisfied%'
  and lower(pg_catalog.pg_get_functiondef(
    'public.admin_partners_revolut_payout_status()'::regprocedure
  )) like '%admin_partners_revolut_payout_status_approval_registry%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_payout_status_approval_registry()'::regprocedure
  )) like '%partners_release_gate_approval_is_current%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_payout_status_approval_registry()'::regprocedure
  )) like '%api_adapter_recorded_verified%'
  and not has_function_privilege(
    'authenticated',
    'affiliate_private.admin_partners_revolut_payout_status()',
    'EXECUTE'
  ),
  'Didit and Revolut Admin consumers use effective approval evidence'
);

select extensions.is(
  public.admin_partners_deployment_manifest_register(
    'preproduction',
    repeat('a', 40),
    'approval-registry-preproduction-certification',
    repeat('e', 64),
    jsonb_build_object(
      'approval_record', repeat('1', 64),
      'deployment_proof', repeat('e', 64),
      'dpia', repeat('3', 64),
      'gdpr_self_assessment', repeat('4', 64),
      'biometric_consent', repeat('d', 64),
      'privacy_notice', repeat('5', 64),
      'records_of_processing', repeat('6', 64),
      'legal_tax_review', repeat('7', 64),
      'partners_terms', repeat('8', 64),
      'country_policy_review', repeat('9', 64),
      'payout_corridor_review', repeat('c', 64)
    ),
    'Register bounded preproduction evidence for Didit certification only.'
  ) ->> 'action',
  'deployment_manifest_registered',
  'preproduction evidence can be registered independently'
);

select extensions.is(
  public.admin_partners_release_gate_approve(
    'privacy_approved',
    'approval-registry-test-v1',
    '[{"country_code":"FR"}]'::jsonb,
    jsonb_build_object(
      'approval_record', repeat('1', 64),
      'deployment_proof', repeat('e', 64),
      'dpia', repeat('3', 64),
      'gdpr_self_assessment', repeat('4', 64),
      'biometric_consent', repeat('d', 64),
      'privacy_notice', repeat('5', 64),
      'records_of_processing', repeat('6', 64)
    ),
    repeat('a', 40),
    'preproduction',
    'approval-registry-preproduction-certification',
    repeat('e', 64),
    now() + interval '30 days',
    'Bind preproduction privacy evidence for supervised Didit certification.'
  ) ->> 'effective',
  'true',
  'the approval is effective inside its explicit preproduction context'
);

select extensions.ok(
  affiliate_private.partners_release_gate_approval_is_current(
    'privacy_approved',
    'preproduction'
  )
  and not affiliate_private.partners_release_gate_approval_is_current(
    'privacy_approved'
  )
  and not affiliate_private.release_gates_satisfied(
    array['privacy_approved']::text[]
  ),
  'preproduction evidence never authorizes a production release gate'
);

select extensions.lives_ok(
  $$
    select affiliate_private.partners_assert_didit_certification_pre_gate()
  $$,
  'the supervised Didit certification pre-gate consumes only preproduction privacy evidence'
);

select extensions.is(
  public.admin_partners_control(
    'set_gate',
    'privacy_approved',
    false,
    'Revoke the privacy approval registry integration fixture.'
  ) ->> 'satisfied',
  'false',
  'the existing audited control can revoke a packaged gate'
);

reset role;

select extensions.ok(
  not exists (
    select 1
    from affiliate_private.affiliate_release_gate_approval_bindings binding
    where binding.gate_key = 'privacy_approved'
  )
  and not affiliate_private.release_gates_satisfied(
    array['privacy_approved']::text[]
  ),
  'gate revocation removes only the active binding and fails closed'
);

set local role authenticated;
set local request.jwt.claims =
  '{
    "sub":"60000000-0000-4000-8000-000000000001",
    "role":"authenticated",
    "aal":"aal2",
    "app_metadata":{
      "role":"admin",
      "partners_release_manager":true
    }
  }';

select extensions.throws_ok(
  $$
    select public.admin_partners_control(
      'set_gate',
      'privacy_approved',
      true,
      'Legacy boolean activation without evidence must fail closed.'
    )
  $$,
  '55000',
  'Partners release gate requires a current immutable approval package',
  'the legacy boolean-only activation path can no longer approve a gate'
);

select extensions.is(
  public.admin_partners_deployment_manifest_register(
    'production',
    repeat('a', 40),
    'approval-registry-test-deployment-v2',
    repeat('f', 64),
    jsonb_build_object(
      'approval_record', repeat('1', 64),
      'deployment_proof', repeat('f', 64),
      'dpia', repeat('3', 64),
      'gdpr_self_assessment', repeat('4', 64),
      'biometric_consent', repeat('d', 64),
      'privacy_notice', repeat('5', 64),
      'records_of_processing', repeat('6', 64),
      'legal_tax_review', repeat('7', 64),
      'partners_terms', repeat('8', 64),
      'country_policy_review', repeat('9', 64),
      'payout_corridor_review', repeat('c', 64)
    ),
    'Register a changed deployment to prove automatic invalidation.'
  ) ->> 'action',
  'deployment_manifest_registered',
  'a materially changed deployment creates the next manifest version'
);

select extensions.ok(
  not affiliate_private.release_gates_satisfied(
    array['legal_and_tax_approved']::text[]
  ),
  'a new current deployment manifest invalidates packages for the prior build'
);

reset role;

update affiliate_private.affiliate_pilot_allowlist
set status = 'revoked';

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
select
  (
    '61000000-0000-4000-8000-' || lpad(series.n::text, 12, '0')
  )::uuid,
  '00000000-0000-0000-0000-000000000000'::uuid,
  'authenticated',
  'authenticated',
  'approval-pilot-' || series.n || '@example.invalid',
  '',
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb,
  now(),
  now()
from generate_series(1, 51) series(n);

insert into affiliate_private.affiliate_pilot_allowlist (
  user_id,
  status,
  country_code,
  added_by_pseudonym
)
select
  (
    '61000000-0000-4000-8000-' || lpad(series.n::text, 12, '0')
  )::uuid,
  'active',
  'FR',
  repeat('6', 64)
from generate_series(1, 50) series(n);

select extensions.throws_ok(
  $$
    insert into affiliate_private.affiliate_pilot_allowlist (
      user_id,
      status,
      country_code,
      added_by_pseudonym
    ) values (
      '61000000-0000-4000-8000-000000000051',
      'active',
      'FR',
      repeat('6', 64)
    )
  $$,
  '54000',
  'Partners pilot allowlist is limited to 50 active members',
  'the database rejects a fifty-first active pilot member'
);

update affiliate_private.affiliate_pilot_allowlist
set status = 'revoked'
where user_id = '61000000-0000-4000-8000-000000000001';

select extensions.lives_ok(
  $$
    insert into affiliate_private.affiliate_pilot_allowlist (
      user_id,
      status,
      country_code,
      added_by_pseudonym
    ) values (
      '61000000-0000-4000-8000-000000000051',
      'active',
      'FR',
      repeat('6', 64)
    )
  $$,
  'a revoked slot can be reassigned without exceeding the cap'
);

select * from extensions.finish();
rollback;
