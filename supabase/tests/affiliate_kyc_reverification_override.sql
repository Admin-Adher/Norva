begin;

create extension if not exists pgtap with schema extensions;
select extensions.no_plan();

select extensions.has_table(
  'affiliate_private',
  'affiliate_kyc_reverification_grants',
  'human review has a dedicated private one-shot grant registry'
);

select extensions.ok(
  (
    select relation.relrowsecurity
    from pg_catalog.pg_class relation
    where relation.oid =
      'affiliate_private.affiliate_kyc_reverification_grants'::regclass
  )
  and not has_table_privilege(
    'anon',
    'affiliate_private.affiliate_kyc_reverification_grants',
    'SELECT'
  )
  and not has_table_privilege(
    'authenticated',
    'affiliate_private.affiliate_kyc_reverification_grants',
    'SELECT'
  )
  and not has_table_privilege(
    'service_role',
    'affiliate_private.affiliate_kyc_reverification_grants',
    'SELECT'
  ),
  'one-shot grants are RLS protected and expose no direct data surface'
);

select extensions.ok(
  exists (
    select 1
    from pg_catalog.pg_index index_row
    where index_row.indexrelid = to_regclass(
      'affiliate_private.affiliate_kyc_reverification_one_available_idx'
    )
      and index_row.indisunique
      and pg_get_expr(index_row.indpred, index_row.indrelid)
        like '%consumed_at IS NULL%'
  )
  and exists (
    select 1
    from pg_catalog.pg_trigger trigger_row
    where trigger_row.tgrelid =
      'affiliate_private.affiliate_kyc_reverification_grants'::regclass
      and trigger_row.tgname = 'affiliate_kyc_reverification_grant_guard'
      and not trigger_row.tgisinternal
      and pg_get_triggerdef(trigger_row.oid) like
        '%BEFORE INSERT OR DELETE OR UPDATE%'
  ),
  'only one unconsumed right can exist per account and consumption is guarded'
);

select extensions.ok(
  not has_function_privilege(
    'service_role',
    'affiliate_private.partners_service_kyc_prepare_reverification_once_v2(uuid,text,text,text,boolean,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.partners_service_kyc_prepare_v2(uuid,text,text,text,boolean,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'public.partners_service_kyc_prepare(uuid,text,text,boolean,text)',
    'EXECUTE'
  ),
  'the override is owner-only and service traffic remains confined to v2'
);

select extensions.ok(
  pg_get_functiondef(
    'affiliate_private.admin_partners_kyc_human_review_decide(text,text,text,timestamptz,text,text)'::regprocedure
  ) like '%partners_require_capability(''risk'')%'
  and pg_get_functiondef(
    'affiliate_private.admin_partners_kyc_human_review_decide(text,text,text,timestamptz,text,text)'::regprocedure
  ) like '%partners_require_aal2%'
  and pg_get_functiondef(
    'affiliate_private.admin_partners_kyc_human_review_decide(text,text,text,timestamptz,text,text)'::regprocedure
  ) like '%affiliate_kyc_reverification_grants%'
  and pg_get_functiondef(
    'affiliate_private.partners_service_kyc_prepare_reverification_once_v2(uuid,text,text,text,boolean,text)'::regprocedure
  ) not like '%provider_session_id%'
  and pg_get_functiondef(
    'affiliate_private.partners_service_kyc_prepare_reverification_once_v2(uuid,text,text,text,boolean,text)'::regprocedure
  ) not like '%email%'
  and pg_get_functiondef(
    'affiliate_private.guard_kyc_reverification_grant_mutation()'::regprocedure
  ) like '%review.account_id = new.account_id%'
  and pg_get_functiondef(
    'affiliate_private.guard_kyc_reverification_grant_mutation()'::regprocedure
  ) like '%review.reviewed_by_pseudonym = new.issued_by_pseudonym%'
  ,
  'only Risk+AAL2 resolution issues a minimized re-verification right'
);

select extensions.ok(
  pg_get_functiondef(
    'affiliate_private.partners_service_biometric_consent_withdraw(uuid,text)'::regprocedure
  ) like '%outbox.session_purpose = ''member_kyc''%'
  and pg_get_functiondef(
    'affiliate_private.partners_service_biometric_consent_withdraw(uuid,text)'::regprocedure
  ) like '%outbox.source_record_id = v_session_id%',
  'withdrawal activates purge material only for the exact member KYC source record'
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
  '68000000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated',
  'authenticated',
  'kyc-reverification-fixture@example.invalid',
  '',
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb,
  now(),
  now()
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
  '68000000-0000-4000-8000-000000000002',
  '00000000-0000-0000-0000-000000000000',
  'authenticated',
  'authenticated',
  'kyc-risk-admin-fixture@example.invalid',
  '',
  now(),
  '{"provider":"email","providers":["email"],"role":"admin","partners_release_manager":true}'::jsonb,
  '{}'::jsonb,
  now(),
  now()
);

insert into affiliate_private.affiliate_admin_capabilities (
  user_id,
  capability,
  enabled,
  granted_by_pseudonym,
  justification
) values
  (
    '68000000-0000-4000-8000-000000000002',
    'risk',
    true,
    repeat('f', 64),
    'pgTAP Risk reviewer fixture capability.'
  ),
  (
    '68000000-0000-4000-8000-000000000002',
    'finance',
    true,
    repeat('f', 64),
    'pgTAP immutable Legal approval fixture capability.'
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
  '69000000-0000-4000-8000-000000000002',
  '68000000-0000-4000-8000-000000000002',
  'KYC re-verification pgTAP Risk reviewer',
  'totp',
  'verified',
  now(),
  now(),
  'kyc-reverification-pgtap-secret'
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
) values (
  'p0-reverification-test-v1',
  'individual',
  'active',
  2000,
  30,
  45,
  '{"USD":1000}'::jsonb,
  'partners-terms-v1',
  'partners-disclosure-v1',
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
  'partners-terms-v1',
  'partners-disclosure-v1',
  now() - interval '1 minute'
from affiliate_private.affiliate_program_versions program
where program.version_key = 'p0-reverification-test-v1';

create or replace function pg_temp.kyc_reverification_approval_documents(
  p_gate text
)
returns jsonb
language sql
immutable
as $fixture$
  select jsonb_build_object(
    'approval_record', repeat('1', 64),
    'deployment_proof', repeat('2', 64)
  ) || case p_gate
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
    when 'country_policy_approved' then jsonb_build_object(
      'country_policy_review', repeat('a', 64),
      'payout_corridor_review', repeat('b', 64)
    )
    else '{}'::jsonb
  end;
$fixture$;

create or replace function pg_temp.kyc_reverification_deployment_documents()
returns jsonb
language sql
immutable
as $fixture$
  select pg_temp.kyc_reverification_approval_documents(
    'legal_and_tax_approved'
  ) || pg_temp.kyc_reverification_approval_documents(
    'privacy_approved'
  ) || pg_temp.kyc_reverification_approval_documents(
    'individual_verification_coverage_confirmed'
  ) || pg_temp.kyc_reverification_approval_documents(
    'country_policy_approved'
  );
$fixture$;

set local role authenticated;
do $approval_jwt$
begin
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', '68000000-0000-4000-8000-000000000002',
      'role', 'authenticated',
      'aal', 'aal2',
      'iat', floor(extract(epoch from clock_timestamp()))::bigint,
      'app_metadata', jsonb_build_object(
        'role', 'admin',
        'partners_release_manager', true
      )
    )::text,
    true
  );
end;
$approval_jwt$;
do $privacy_approval$
begin
  perform public.admin_partners_deployment_manifest_register(
    'preproduction',
    repeat('c', 40),
    'kyc-reverification-test-deployment',
    repeat('2', 64),
    pg_temp.kyc_reverification_deployment_documents(),
    'KYC re-verification pgTAP immutable deployment manifest.'
  );
  perform public.admin_partners_release_gate_approve(
    'privacy_approved',
    'p0-reverification-test-v1',
    '[{"country_code":"FR"}]'::jsonb,
    pg_temp.kyc_reverification_approval_documents('privacy_approved'),
    repeat('c', 40),
    'preproduction',
    'kyc-reverification-test-deployment',
    repeat('2', 64),
    now() + interval '30 days',
    'KYC re-verification pgTAP immutable Privacy approval.'
  );
end;
$privacy_approval$;

create temporary table kyc_reverification_certification_state (
  certification_key text not null
) on commit drop;
grant select, insert on kyc_reverification_certification_state
  to authenticated, service_role;
insert into kyc_reverification_certification_state (certification_key)
select response #>> '{certification,key}'
from (
  select public.admin_partners_kyc_certification_prepare(
    'certification.kyc-reverification.0001',
    'partners-didit-certification-v1',
    true,
    'fr',
    'CERTIFIER DIDIT',
    'Certify the KYC re-verification immutable approval fixture.'
  ) as response
) prepared;
reset role;

set local role service_role;
do $certification_proof$
declare
  v_claim record;
begin
  perform public.partners_service_kyc_certification_create_claim(
    (select certification_key from kyc_reverification_certification_state)
  );
  perform public.partners_service_kyc_certification_session_record(
    (select certification_key from kyc_reverification_certification_state),
    'didit-certification-session-kyc-reverification',
    'didit-workflow-certification',
    1,
    'not_started',
    'live',
    repeat('d', 64),
    604800
  );
  perform public.partners_service_kyc_certification_webhook_apply_and_enqueue_purge(
    'didit-certification-event-kyc-reverification',
    'didit-certification-session-kyc-reverification',
    'didit-workflow-certification',
    1,
    'approved',
    -- This pgTAP fixture applies the signed decision and completes the purge
    -- in one transaction.  The purge completion RPC uses the transaction
    -- timestamp, so the approval event must use the same canonical clock for
    -- provider_purged_at >= verified_at to be a current immutable proof.
    transaction_timestamp(),
    30,
    'FRA',
    true,
    true,
    true,
    repeat('e', 64),
    'live',
    repeat('d', 64),
    'v1.v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  );
  for v_claim in
    select * from public.partners_service_didit_purge_claim(25, 300)
  loop
    perform public.partners_service_didit_purge_complete(
      v_claim.outbox_id,
      v_claim.lease_token,
      'deleted'
    );
  end loop;
end;
$certification_proof$;
reset role;

set local role authenticated;
do $remaining_approvals$
declare
  v_gate text;
begin
  perform public.admin_partners_deployment_manifest_register(
    'production',
    repeat('e', 40),
    'kyc-reverification-production-deployment',
    repeat('2', 64),
    pg_temp.kyc_reverification_deployment_documents(),
    'KYC re-verification pgTAP production deployment manifest.'
  );
  foreach v_gate in array array[
    'legal_and_tax_approved',
    'privacy_approved',
    'individual_verification_coverage_confirmed',
    'country_policy_approved'
  ]::text[]
  loop
    perform public.admin_partners_release_gate_approve(
      v_gate,
      'p0-reverification-test-v1',
      '[{"country_code":"FR"}]'::jsonb,
      pg_temp.kyc_reverification_approval_documents(v_gate),
      repeat('e', 40),
      'production',
      'kyc-reverification-production-deployment',
      repeat('2', 64),
      now() + interval '30 days',
      'KYC re-verification pgTAP immutable release approval.'
    );
  end loop;
end;
$remaining_approvals$;
reset role;

update affiliate_private.affiliate_country_policies policy
set individual_available = true
from affiliate_private.affiliate_program_versions program
where program.id = policy.program_version_id
  and program.version_key = 'p0-reverification-test-v1'
  and policy.country_code = 'FR';

insert into affiliate_private.affiliate_kyc_attempt_policies (
  country_policy_id,
  max_attempts,
  window_seconds,
  cooldown_seconds,
  status,
  configured_by_pseudonym,
  justification
)
select
  policy.id,
  1,
  86400,
  604800,
  'active',
  repeat('a', 64),
  'Re-verification one-shot pgTAP attempt policy.'
from affiliate_private.affiliate_country_policies policy
where policy.country_code = 'FR';

insert into affiliate_private.affiliate_accounts (
  user_id,
  user_pseudonym,
  status,
  program_version_id,
  country_policy_id,
  country_code,
  contract_status,
  terms_version_accepted,
  contract_accepted_at,
  disclosure_version_accepted,
  disclosure_accepted_at
)
select
  '68000000-0000-4000-8000-000000000001',
  repeat('b', 64),
  'pending_verification',
  program.id,
  policy.id,
  'FR',
  'accepted',
  'partners-terms-v1',
  now() - interval '1 minute',
  'partners-disclosure-v1',
  now() - interval '1 minute'
from affiliate_private.affiliate_program_versions program
join affiliate_private.affiliate_country_policies policy
  on policy.program_version_id = program.id
where program.version_key = 'p0-reverification-test-v1'
  and policy.country_code = 'FR';

-- The member-session binding trigger derives these values from the trusted
-- Edge runtime GUCs; supplied row values never bypass that boundary.
do $didit_binding_config$
begin
  perform set_config('norva.didit.environment', 'sandbox', true);
  perform set_config(
    'norva.didit.config_fingerprint',
    repeat('e', 64),
    true
  );
end;
$didit_binding_config$;
insert into affiliate_private.affiliate_kyc_sessions (
  account_id,
  provider,
  provider_session_hash,
  provider_workflow_hash,
  provider_workflow_version,
  provider_status,
  status,
  consent_version,
  capacity_attested,
  provider_environment,
  provider_config_fingerprint,
  created_at,
  updated_at
)
select
  account.id,
  'didit',
  repeat('c', 64),
  repeat('d', 64),
  1,
  'declined',
  'pending',
  'partners-disclosure-v1',
  true,
  'sandbox',
  repeat('e', 64),
  now() - interval '1 minute',
  now() - interval '1 minute'
from affiliate_private.affiliate_accounts account
where account.user_id = '68000000-0000-4000-8000-000000000001';

update affiliate_private.affiliate_kyc_sessions
set status = 'failed', updated_at = now()
where provider_session_hash = repeat('c', 64);

do $partners_control_config$
begin
  perform set_config(
    'norva.partners_control',
    'admin_partners_control',
    true
  );
end;
$partners_control_config$;
update public.admin_feature_flags
set enabled = true, updated_at = now(), updated_by = 'pgtap'
where key = 'partners_enabled';

set local role service_role;
select extensions.throws_ok(
  $$
    select public.partners_service_kyc_prepare_v2(
      '68000000-0000-4000-8000-000000000001',
      'kyc.reverify.limit.0001',
      'partners-disclosure-v1',
      'partners-biometric-consent-v1',
      true,
      'fr'
    )
  $$,
  'P0001',
  'KYC attempt policy denied this request',
  'ordinary v2 preparation still fails at max_attempts'
);
reset role;

update affiliate_private.affiliate_kyc_attempt_policies
set max_attempts = 20, updated_at = now()
where country_policy_id = (
  select account.country_policy_id
  from affiliate_private.affiliate_accounts account
  where account.user_id = '68000000-0000-4000-8000-000000000001'
);

set local role service_role;
select extensions.throws_ok(
  $$
    select public.partners_service_kyc_prepare_v2(
      '68000000-0000-4000-8000-000000000001',
      'kyc.reverify.cooldown.0001',
      'partners-disclosure-v1',
      'partners-biometric-consent-v1',
      true,
      'fr'
    )
  $$,
  'P0004',
  'KYC attempt cooldown is active',
  'ordinary v2 preparation still fails during terminal cooldown'
);
reset role;

update affiliate_private.affiliate_kyc_attempt_policies
set max_attempts = 1, updated_at = now()
where country_policy_id = (
  select account.country_policy_id
  from affiliate_private.affiliate_accounts account
  where account.user_id = '68000000-0000-4000-8000-000000000001'
);

do $review_request_config$
begin
  perform set_config(
    'norva.partners_kyc_review_control',
    'request',
    true
  );
end;
$review_request_config$;
insert into affiliate_private.affiliate_kyc_human_review_requests (
  review_key,
  account_id,
  session_id,
  idempotency_key,
  reason
)
select
  'khr_' || repeat('1', 24),
  account.id,
  session.id,
  'kyc.review.fixture.0001',
  'identity_result_contested'
from affiliate_private.affiliate_accounts account
join affiliate_private.affiliate_kyc_sessions session
  on session.account_id = account.id
where account.user_id = '68000000-0000-4000-8000-000000000001'
  and session.provider_session_hash = repeat('c', 64);

set local role authenticated;
do $aal1_claims$
begin
  perform set_config(
    'request.jwt.claims',
    '{"sub":"68000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1","app_metadata":{"role":"admin"}}',
    true
  );
end;
$aal1_claims$;
select extensions.throws_ok(
  $$
    select public.admin_partners_kyc_human_review_decide(
      'khr_' || repeat('1', 24),
      'start',
      '',
      null,
      'START:' || 'khr_' || repeat('1', 24),
      'Risk began the deterministic re-verification fixture.'
    )
  $$,
  '42501',
  'Partners KYC human-review decision requires AAL2',
  'Risk capability alone cannot issue a re-verification right at AAL1'
);
do $aal2_claims$
begin
  perform set_config(
    'request.jwt.claims',
    '{"sub":"68000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2","app_metadata":{"role":"admin"}}',
    true
  );
end;
$aal2_claims$;
select extensions.is(
  public.admin_partners_kyc_human_review_decide(
    'khr_' || repeat('1', 24),
    'start',
    '',
    null,
    'START:' || 'khr_' || repeat('1', 24),
    'Risk began the deterministic re-verification fixture.'
  ) ->> 'action',
  'kyc_human_review_started',
  'Risk+AAL2 can begin the audited review'
);
select extensions.is(
  public.admin_partners_kyc_human_review_decide(
    'khr_' || repeat('1', 24),
    'resolve_reverification',
    repeat('9', 64),
    now(),
    'RESOLVE-REVERIFY:' || 'khr_' || repeat('1', 24),
    'Risk approved one deterministic re-verification attempt.'
  ) #>> '{review,reverification_granted}',
  'true',
  'Risk+AAL2 resolution atomically issues one private re-verification right'
);
reset role;
do $clear_claims$
begin
  perform set_config('request.jwt.claims', '{}', true);
end;
$clear_claims$;

select extensions.throws_ok(
  $$
    update affiliate_private.affiliate_kyc_reverification_grants grant_row
    set
      consumed_at = now(),
      reservation_key_sha256 = repeat('d', 64)
    where grant_row.review_id = (
      select review.id
      from affiliate_private.affiliate_kyc_human_review_requests review
      where review.review_key = 'khr_' || repeat('1', 24)
    )
  $$,
  '55000',
  'KYC re-verification grant is immutable',
  'a direct mutation cannot consume the one-shot right without the owner control path'
);

set local role service_role;
select extensions.is(
  public.partners_service_kyc_prepare_v2(
    '68000000-0000-4000-8000-000000000001',
    'kyc.reverify.consume.0001',
    'partners-disclosure-v1',
    'partners-biometric-consent-v1',
    true,
    'fr'
  ) ->> 'action',
  'kyc_ready',
  'one reviewed right bypasses max_attempts and cooldown exactly once'
);
select extensions.is(
  public.partners_service_kyc_prepare_v2(
    '68000000-0000-4000-8000-000000000001',
    'kyc.reverify.consume.0001',
    'partners-disclosure-v1',
    'partners-biometric-consent-v1',
    true,
    'fr'
  ) ->> 'replayed',
  'true',
  'an idempotent replay does not spend another re-verification right'
);
reset role;

select extensions.is(
  (
    select count(*)::integer
    from affiliate_private.affiliate_kyc_reverification_grants grant_row
    where grant_row.consumed_at is not null
      and grant_row.reservation_key_sha256 ~ '^[0-9a-f]{64}$'
  ),
  1,
  'the reviewed right is consumed once and bound only to a reservation hash'
);
select extensions.ok(
  exists (
    select 1
    from affiliate_private.affiliate_events event
    where event.action = 'kyc_human_review_reverification_consumed'
      and (event.after_state ->> 'attempt_limit_overridden')::boolean
      and (event.after_state ->> 'cooldown_overridden')::boolean
      and event.after_state::text !~
        '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
  ),
  'consumption audit proves both narrow overrides without a UUID'
);

update affiliate_private.affiliate_kyc_session_reservations
set status = 'expired', updated_at = now()
where account_id = (
  select account.id
  from affiliate_private.affiliate_accounts account
  where account.user_id = '68000000-0000-4000-8000-000000000001'
)
  and status = 'reserved';

set local role service_role;
select extensions.throws_ok(
  $$
    select public.partners_service_kyc_prepare_v2(
      '68000000-0000-4000-8000-000000000001',
      'kyc.reverify.after.0001',
      'partners-disclosure-v1',
      'partners-biometric-consent-v1',
      true,
      'fr'
    )
  $$,
  'P0001',
  'KYC attempt policy denied this request',
  'a fresh request returns to the ordinary limit after one consumption'
);
reset role;

do $withdrawal_review_request_config$
begin
  perform set_config(
    'norva.partners_kyc_review_control',
    'request',
    true
  );
end;
$withdrawal_review_request_config$;
insert into affiliate_private.affiliate_kyc_human_review_requests (
  review_key,
  account_id,
  session_id,
  idempotency_key,
  reason
)
select
  'khr_' || repeat('2', 24),
  account.id,
  session.id,
  'kyc.review.fixture.0002',
  'verification_unavailable'
from affiliate_private.affiliate_accounts account
join affiliate_private.affiliate_kyc_sessions session
  on session.account_id = account.id
where account.user_id = '68000000-0000-4000-8000-000000000001'
  and session.provider_session_hash = repeat('c', 64);
do $withdrawal_review_admin_config$
begin
  perform set_config(
    'norva.partners_kyc_review_control',
    'admin',
    true
  );
end;
$withdrawal_review_admin_config$;
update affiliate_private.affiliate_kyc_human_review_requests
set
  status = 'in_review',
  review_started_at = now(),
  reviewed_by_pseudonym = repeat('f', 64),
  justification = 'Risk began the withdrawal precedence fixture.',
  updated_at = now()
where review_key = 'khr_' || repeat('2', 24);
update affiliate_private.affiliate_kyc_human_review_requests
set
  status = 'resolved',
  resolution = 'reverification_available',
  evidence_sha256 = repeat('8', 64),
  evidence_observed_at = now(),
  resolved_at = now(),
  justification = 'Risk approved the withdrawal precedence fixture.',
  updated_at = now()
where review_key = 'khr_' || repeat('2', 24);
insert into affiliate_private.affiliate_kyc_reverification_grants (
  review_id,
  account_id,
  issued_by_pseudonym
)
select review.id, review.account_id, repeat('f', 64)
from affiliate_private.affiliate_kyc_human_review_requests review
where review.review_key = 'khr_' || repeat('2', 24);

insert into affiliate_private.affiliate_kyc_session_reservations (
  account_id
)
select account.id
from affiliate_private.affiliate_accounts account
where account.user_id = '68000000-0000-4000-8000-000000000001';
insert into affiliate_private.affiliate_biometric_consent_attestations (
  account_id,
  idempotency_key,
  reservation_key,
  disclosure_version,
  biometric_consent_version
)
select
  reservation.account_id,
  'kyc.record.withdrawn.0001',
  reservation.reservation_key,
  'partners-disclosure-v1',
  'partners-biometric-consent-v1'
from affiliate_private.affiliate_kyc_session_reservations reservation
join affiliate_private.affiliate_accounts account
  on account.id = reservation.account_id
where account.user_id = '68000000-0000-4000-8000-000000000001'
  and reservation.status = 'reserved';

-- Resolve the two private sources while the fixture owner is active. Service
-- role exercises only the public RPC below and receives no direct grant on
-- either private relation.
create temporary table kyc_reverification_record_state (
  reservation_key text not null,
  consent_reservation_key text not null,
  constraint kyc_reverification_record_state_same_key
    check (reservation_key = consent_reservation_key)
) on commit drop;
grant select on table kyc_reverification_record_state to service_role;
insert into kyc_reverification_record_state (
  reservation_key,
  consent_reservation_key
)
select
  reservation.reservation_key,
  consent.reservation_key
from affiliate_private.affiliate_kyc_session_reservations reservation
join affiliate_private.affiliate_accounts account
  on account.id = reservation.account_id
join affiliate_private.affiliate_biometric_consent_attestations consent
  on consent.account_id = reservation.account_id
  and consent.reservation_key = reservation.reservation_key
where account.user_id = '68000000-0000-4000-8000-000000000001'
  and reservation.status = 'reserved'
  and consent.idempotency_key = 'kyc.record.withdrawn.0001';
insert into affiliate_private.affiliate_biometric_consent_withdrawals (
  account_id,
  idempotency_key,
  biometric_consent_version
)
select
  account.id,
  'kyc.withdraw.fixture.0001',
  'partners-biometric-consent-v1'
from affiliate_private.affiliate_accounts account
where account.user_id = '68000000-0000-4000-8000-000000000001';

set local role service_role;
select extensions.is(
  (
    select concat_ws(
      ':',
      recorded.response ->> 'session_disposition',
      recorded.response #>> '{kyc,status}'
    )
    from (
      select public.partners_service_kyc_session_record_v3(
        '68000000-0000-4000-8000-000000000001',
        'kyc.record.withdrawn.0001',
        'didit-withdrawal-race-session-0001',
        'didit-withdrawal-race-workflow',
        1,
        'not_started',
        null,
        (
          select state.reservation_key
          from kyc_reverification_record_state state
        ),
        'sandbox',
        repeat('7', 64),
        3600,
        'v1.k1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB'
      ) as response
    ) recorded
  ),
  'withdrawn:superseded',
  'a withdrawal-first record race is staged and superseded'
);
select extensions.is(
  (
    select concat_ws(
      ':',
      recorded.response ->> 'session_disposition',
      recorded.response #>> '{kyc,status}'
    )
    from (
      select public.partners_service_kyc_session_record_v3(
      '68000000-0000-4000-8000-000000000001',
      'kyc.record.withdrawn.0001',
      'didit-withdrawal-race-session-0001',
      'didit-withdrawal-race-workflow',
      1,
      'not_started',
      null,
      (
        select state.consent_reservation_key
        from kyc_reverification_record_state state
      ),
      'sandbox',
      repeat('7', 64),
      3600,
      'v1.k1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB'
      ) as response
    ) recorded
  ),
  'withdrawn:superseded',
  'a withdrawal-first record replay remains withdrawn and superseded'
);
select extensions.throws_ok(
  $$
    select public.partners_service_kyc_prepare_v2(
      '68000000-0000-4000-8000-000000000001',
      'kyc.reverify.withdrawn.0001',
      'partners-disclosure-v1',
      'partners-biometric-consent-v1',
      true,
      'fr'
    )
  $$,
  'P0001',
  'biometric consent was withdrawn',
  'withdrawal remains authoritative even when a reviewed right exists'
);
reset role;

select extensions.is(
  (
    select concat_ws(
      ':',
      session.status,
      session.provider_purge_status,
      outbox.status
    )
    from affiliate_private.affiliate_kyc_sessions session
    join affiliate_private.affiliate_didit_purge_outbox outbox
      on outbox.provider_session_hash = session.provider_session_hash
    where session.provider_session_hash = encode(
      extensions.digest(
        'norva:didit:session:v1:didit-withdrawal-race-session-0001',
        'sha256'
      ),
      'hex'
    )
  ),
  'superseded:purge_pending:pending',
  'withdrawal-first recording atomically activates the staged Didit purge'
);

select * from extensions.finish();
rollback;
