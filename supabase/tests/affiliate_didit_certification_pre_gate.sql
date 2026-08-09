begin;

create extension if not exists pgtap with schema extensions;

select extensions.plan(76);

set local norva.partners_test_purge_envelope =
  'v1.v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

select extensions.ok(
  (
    select bool_and(class_row.relrowsecurity)
    from pg_class class_row
    join pg_namespace namespace_row
      on namespace_row.oid = class_row.relnamespace
    where namespace_row.nspname = 'affiliate_private'
      and class_row.relname in (
        'affiliate_didit_session_registry',
        'affiliate_didit_certification_sessions',
        'affiliate_didit_certification_events'
      )
  ),
  'every private Didit certification table has RLS enabled'
);
select extensions.ok(
  not exists (
    select 1
    from information_schema.columns column_row
    where column_row.table_schema = 'affiliate_private'
      and column_row.table_name in (
        'affiliate_didit_certification_sessions',
        'affiliate_didit_certification_events'
      )
      and column_row.column_name in (
        'account_id',
        'user_id',
        'provider_session_id',
        'provider_event_id',
        'payload',
        'date_of_birth',
        'document_country_iso3',
        'name',
        'document'
      )
  ),
  'certification persistence has no account, raw provider or identity columns'
);
select extensions.ok(
  not exists (
    select 1
    from pg_constraint constraint_row
    where constraint_row.conrelid in (
      'affiliate_private.affiliate_didit_certification_sessions'::regclass,
      'affiliate_private.affiliate_didit_certification_events'::regclass
    )
      and constraint_row.confrelid =
        'affiliate_private.affiliate_accounts'::regclass
  ),
  'the pre-gate certification path has no affiliate account foreign key'
);
select extensions.ok(
  not exists (
    select 1
    from affiliate_private.affiliate_kyc_sessions member_session
    left join affiliate_private.affiliate_didit_session_registry registry
      on registry.provider_session_hash =
        member_session.provider_session_hash
      and registry.session_purpose = 'member_kyc'
      and registry.source_record_id = member_session.id
    where registry.provider_session_hash is null
  ),
  'every existing member KYC session was backfilled into the purpose registry'
);
select extensions.ok(
  exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid =
        'affiliate_private.affiliate_kyc_sessions'::regclass
      and trigger_row.tgname =
        'affiliate_kyc_sessions_register_didit_purpose'
      and not trigger_row.tgisinternal
      -- PostgreSQL tgtype bitmask: ROW (1) + INSERT (4), with no BEFORE bit.
      and trigger_row.tgtype = 5
  ),
  'future member KYC sessions are registered after insert'
);
select extensions.ok(
  has_function_privilege(
    'authenticated',
    'public.admin_partners_kyc_certification_prepare(text,text,boolean,text,text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.admin_partners_kyc_certification_prepare(text,text,boolean,text,text,text)',
    'EXECUTE'
  ),
  'only authenticated callers can reach the user-JWT prepare shim'
);
select extensions.ok(
  has_function_privilege(
    'authenticated',
    'public.admin_partners_kyc_certification_preflight()',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.admin_partners_kyc_certification_preflight()',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'public.admin_partners_kyc_certification_preflight()',
    'EXECUTE'
  ),
  'only authenticated callers can reach the read-only certification preflight'
);
select extensions.ok(
  has_function_privilege(
    'authenticated',
    'public.admin_partners_kyc_certification_resume()',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.admin_partners_kyc_certification_resume()',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'public.admin_partners_kyc_certification_resume()',
    'EXECUTE'
  ),
  'only authenticated callers can reach the resumable-key shim'
);
select extensions.ok(
  not has_function_privilege(
    'anon',
    'affiliate_private.partners_didit_certification_key(text,uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'affiliate_private.partners_didit_certification_key(text,uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'affiliate_private.partners_didit_certification_key(text,uuid)',
    'EXECUTE'
  ),
  'the deterministic certification-key helper remains private'
);
select extensions.ok(
  has_function_privilege(
    'service_role',
    'public.partners_service_kyc_certification_create_claim(text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.partners_service_kyc_certification_create_claim(text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.partners_service_kyc_certification_create_claim(text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'affiliate_private.partners_service_kyc_certification_create_claim(text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'affiliate_private.partners_service_kyc_certification_create_claim(text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'affiliate_private.partners_service_kyc_certification_create_claim(text)',
    'EXECUTE'
  ),
  'only service_role can acquire the durable provider-create claim'
);
select extensions.ok(
  has_function_privilege(
    'service_role',
    'public.partners_service_kyc_certification_binding_match(text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.partners_service_kyc_certification_binding_match(text,text)',
    'EXECUTE'
  ),
  'only service_role can match a pending certification binding'
);
select extensions.ok(
  has_function_privilege(
    'service_role',
    'public.partners_service_kyc_certification_session_record(text,text,text,integer,text,text,text,integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.partners_service_kyc_certification_session_record(text,text,text,integer,text,text,text,integer)',
    'EXECUTE'
  ),
  'only service_role can bind a provider certification session'
);
select extensions.ok(
  not has_function_privilege(
    'service_role',
    'public.partners_service_kyc_certification_webhook_apply(text,text,text,integer,text,timestamptz,integer,text,boolean,boolean,boolean,text,text,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.partners_service_kyc_certification_webhook_apply_and_enqueue_purge(text,text,text,integer,text,timestamptz,integer,text,boolean,boolean,boolean,text,text,text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.partners_service_kyc_certification_webhook_apply_and_enqueue_purge(text,text,text,integer,text,timestamptz,integer,text,boolean,boolean,boolean,text,text,text,text)',
    'EXECUTE'
  ),
  'only service_role can apply an atomic certification webhook with purge'
);
select extensions.ok(
  (
    select procedure_row.pronargs = 6
      and pg_get_function_identity_arguments(procedure_row.oid)
        not ilike '%uuid%'
    from pg_proc procedure_row
    join pg_namespace namespace_row
      on namespace_row.oid = procedure_row.pronamespace
    where namespace_row.nspname = 'public'
      and procedure_row.proname =
        'admin_partners_kyc_certification_prepare'
  ),
  'the prepare signature makes a third-party subject impossible'
);
select extensions.ok(
  not exists (
    select 1
    from (
      values
        ('environment_mismatch', 'provider_environment_mismatch'),
        ('config_fingerprint_mismatch', 'provider_config_mismatch'),
        ('workflow_mismatch', 'provider_workflow_mismatch'),
        ('workflow_version_mismatch', 'provider_workflow_mismatch'),
        ('approved_checks_incomplete', 'approved_checks_incomplete'),
        ('event_before_session', 'stale_event'),
        ('stale_event', 'stale_event'),
        ('cross_purpose_session_conflict', 'binding_conflict'),
        ('session_binding_conflict', 'binding_conflict'),
        ('event_replay_conflict', 'binding_conflict')
    ) as expected(internal_reason, public_reason)
    where affiliate_private.partners_didit_certification_public_reason(
        expected.internal_reason
      ) <> expected.public_reason
      or expected.public_reason not in (
        'provider_environment_mismatch',
        'provider_config_mismatch',
        'provider_workflow_mismatch',
        'approved_checks_incomplete',
        'stale_event',
        'binding_conflict'
      )
  ),
  'every internal observation maps into the closed public reason enum'
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
    '31000000-0000-4000-8000-000000000001',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'didit-risk-one@example.invalid',
    '',
    now(),
    '{"provider":"email","providers":["email"],"role":"admin","partners_release_manager":true}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '31000000-0000-4000-8000-000000000002',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'didit-risk-two@example.invalid',
    '',
    now(),
    '{"provider":"email","providers":["email"],"role":"admin"}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '31000000-0000-4000-8000-000000000003',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'didit-normal@example.invalid',
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
values
  (
    '32000000-0000-4000-8000-000000000001',
    '31000000-0000-4000-8000-000000000001',
    'Didit certification Risk one',
    'totp',
    'verified',
    now(),
    now(),
    'didit-certification-risk-one'
  ),
  (
    '32000000-0000-4000-8000-000000000002',
    '31000000-0000-4000-8000-000000000002',
    'Didit certification Risk two',
    'totp',
    'verified',
    now(),
    now(),
    'didit-certification-risk-two'
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
    '31000000-0000-4000-8000-000000000001',
    'risk',
    true,
    repeat('a', 64),
    'Pre-gate Didit certification pgTAP Risk fixture one.'
  ),
  (
    '31000000-0000-4000-8000-000000000002',
    'risk',
    true,
    repeat('b', 64),
    'Pre-gate Didit certification pgTAP Risk fixture two.'
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
  'p0-didit-certification-test-v1',
  'individual',
  'draft',
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
where program.version_key = 'p0-didit-certification-test-v1';

create or replace function pg_temp.didit_certification_approval_documents(
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
    when 'privacy_approved' then jsonb_build_object(
      'dpia', repeat('3', 64),
      'gdpr_self_assessment', repeat('4', 64),
      'biometric_consent', repeat('f', 64),
      'privacy_notice', repeat('5', 64),
      'records_of_processing', repeat('6', 64)
    )
    when 'individual_verification_coverage_confirmed' then
      jsonb_build_object('kyc_certification', repeat('9', 64))
    else '{}'::jsonb
  end;
$fixture$;

create or replace function pg_temp.didit_certification_deployment_documents()
returns jsonb
language sql
immutable
as $fixture$
  select pg_temp.didit_certification_approval_documents(
    'privacy_approved'
  ) || pg_temp.didit_certification_approval_documents(
    'individual_verification_coverage_confirmed'
  );
$fixture$;

do $approval_jwt$
begin
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', '31000000-0000-4000-8000-000000000001',
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
set local role authenticated;
do $privacy_approval$
begin
  perform public.admin_partners_deployment_manifest_register(
    'preproduction',
    repeat('a', 40),
    'didit-certification-test-deployment',
    repeat('2', 64),
    pg_temp.didit_certification_deployment_documents(),
    'Didit certification pgTAP immutable deployment manifest.'
  );
  perform public.admin_partners_release_gate_approve(
    'privacy_approved',
    'p0-didit-certification-test-v1',
    '[{"country_code":"FR"}]'::jsonb,
    pg_temp.didit_certification_approval_documents('privacy_approved'),
    repeat('a', 40),
    'preproduction',
    'didit-certification-test-deployment',
    repeat('2', 64),
    now() + interval '30 days',
    'Didit certification pgTAP immutable Privacy approval.'
  );
end;
$privacy_approval$;
reset role;

create temporary table didit_certification_state (
  operator_key text primary key,
  response jsonb,
  create_claim_response jsonb,
  create_claim_replay_response jsonb,
  event_created_at timestamptz
);
grant select, insert, update on table didit_certification_state
  to authenticated, service_role;

create temporary table didit_certification_snapshot as
select
  (select count(*) from affiliate_private.affiliate_accounts)
    as account_count,
  (select count(*) from affiliate_private.affiliate_links)
    as link_count,
  (select count(*) from affiliate_private.affiliate_commission_entries)
    as commission_count,
  (select count(*) from affiliate_private.affiliate_payout_items)
    as payout_item_count,
  (
    select jsonb_object_agg(flag.key, flag.enabled order by flag.key)
    from public.admin_feature_flags flag
    where flag.key like 'partners_%'
  ) as flags,
  (
    select jsonb_object_agg(
      gate.gate_key,
      gate.satisfied
      order by gate.gate_key
    )
    from affiliate_private.affiliate_release_gates gate
  ) as gates;

insert into affiliate_private.affiliate_didit_session_registry (
  provider_session_hash,
  session_purpose,
  source_record_id
)
values (
  encode(
    extensions.digest(
      'norva:didit:session:v1:cross-purpose-session-0001',
      'sha256'
    ),
    'hex'
  ),
  'member_kyc',
  '33000000-0000-4000-8000-000000000001'
);
select extensions.throws_ok(
  $$
    insert into affiliate_private.affiliate_didit_session_registry (
      provider_session_hash,
      session_purpose,
      source_record_id
    )
    values (
      encode(
        extensions.digest(
          'norva:didit:session:v1:cross-purpose-session-0001',
          'sha256'
        ),
        'hex'
      ),
      'certification',
      '33000000-0000-4000-8000-000000000002'
    )
  $$,
  '23505',
  'duplicate key value violates unique constraint "affiliate_didit_session_registry_pkey"',
  'one Didit session hash cannot be registered for two purposes'
);

do $jwt$
begin
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', '31000000-0000-4000-8000-000000000001',
      'role', 'authenticated',
      'aal', 'aal1',
      'iat', floor(extract(epoch from clock_timestamp()))::bigint,
      'app_metadata', jsonb_build_object('role', 'admin')
    )::text,
    true
  );
end;
$jwt$;
set local role authenticated;
select extensions.ok(
  (
    select
      preflight ->> 'action' = 'kyc_certification_preflight'
      and (preflight ->> 'ready')::boolean is false
      and (preflight #>> '{requirements,privacy_approved}')::boolean
      and (preflight #>> '{requirements,coverage_open}')::boolean
      and not (preflight #>> '{requirements,aal2}')::boolean
      and not (preflight #>> '{requirements,fresh_aal2}')::boolean
      and (
        select count(*)
        from jsonb_object_keys(preflight -> 'requirements')
      ) = 8
    from (
      select public.admin_partners_kyc_certification_preflight() as preflight
    ) observed
  ),
  'AAL1 Risk can read exact prerequisites without opening the certification'
);
select extensions.throws_ok(
  $$
    select public.admin_partners_kyc_certification_prepare(
      'certification.risk1.aal1',
      'partners-didit-certification-v1',
      true,
      'fr',
      'CERTIFIER DIDIT',
      'Exercise the live Didit workflow before opening its release gate.'
    )
  $$,
  '42501',
  'Didit certification preparation requires AAL2',
  'Risk with an AAL1 JWT is denied'
);
select extensions.throws_ok(
  $$select public.admin_partners_kyc_certification_resume()$$,
  '42501',
  'Didit certification resume requires AAL2',
  'the resumable-key path independently requires AAL2'
);
reset role;

update auth.users
set raw_app_meta_data = raw_app_meta_data - 'role'
where id = '31000000-0000-4000-8000-000000000001';
do $jwt$
begin
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', '31000000-0000-4000-8000-000000000001',
      'role', 'authenticated',
      'aal', 'aal2',
      'iat', floor(extract(epoch from clock_timestamp()))::bigint,
      'app_metadata', jsonb_build_object('role', 'admin')
    )::text,
    true
  );
end;
$jwt$;
set local role authenticated;
select extensions.throws_ok(
  $$select public.admin_partners_kyc_certification_preflight()$$,
  '42501',
  'Partners Risk capability is required',
  'a normal account cannot observe the certification preflight'
);
select extensions.throws_ok(
  $$
    select public.admin_partners_kyc_certification_prepare(
      'certification.risk1.demoted',
      'partners-didit-certification-v1',
      true,
      'fr',
      'CERTIFIER DIDIT',
      'A stale Admin JWT must not survive live Auth-row demotion.'
    )
  $$,
  '42501',
  'Partners Risk capability is required',
  'a live Auth-row demotion revokes Risk despite a stale Admin JWT'
);
reset role;
update auth.users
set raw_app_meta_data = raw_app_meta_data || '{"role":"admin"}'::jsonb
where id = '31000000-0000-4000-8000-000000000001';

do $jwt$
begin
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', '31000000-0000-4000-8000-000000000003',
      'role', 'authenticated',
      'aal', 'aal2',
      'iat', floor(extract(epoch from clock_timestamp()))::bigint,
      'app_metadata', jsonb_build_object('role', 'admin')
    )::text,
    true
  );
end;
$jwt$;
set local role authenticated;
select extensions.throws_ok(
  $$
    select public.admin_partners_kyc_certification_prepare(
      'certification.normal.0001',
      'partners-didit-certification-v1',
      true,
      'fr',
      'CERTIFIER DIDIT',
      'A normal account must never start the isolated certification.'
    )
  $$,
  '42501',
  'Partners Risk capability is required',
  'a normal user is denied even with forged Admin and AAL2 claims'
);
reset role;

do $jwt$
begin
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', '31000000-0000-4000-8000-000000000001',
      'role', 'authenticated',
      'aal', 'aal2',
      'iat', floor(extract(epoch from clock_timestamp()))::bigint - 601,
      'app_metadata', jsonb_build_object('role', 'admin')
    )::text,
    true
  );
end;
$jwt$;
set local role authenticated;
select extensions.throws_ok(
  $$
    select public.admin_partners_kyc_certification_prepare(
      'certification.risk1.stale',
      'partners-didit-certification-v1',
      true,
      'fr',
      'CERTIFIER DIDIT',
      'A stale elevated token must not retain exceptional access.'
    )
  $$,
  '42501',
  'freshly issued JWT is required',
  'Risk with a JWT older than ten minutes is denied'
);
reset role;

do $jwt$
begin
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', '31000000-0000-4000-8000-000000000001',
      'role', 'authenticated',
      'aal', 'aal2',
      'iat', floor(extract(epoch from clock_timestamp()))::bigint,
      'app_metadata', jsonb_build_object('role', 'admin')
    )::text,
    true
  );
end;
$jwt$;
set local role authenticated;
select extensions.is(
  public.admin_partners_kyc_certification_preflight() ->> 'ready',
  'true',
  'fresh AAL2 Risk sees the database certification prerequisites as ready'
);
insert into didit_certification_state (operator_key, response)
select
  'risk1',
  public.admin_partners_kyc_certification_prepare(
    'certification.risk1.0001',
    'partners-didit-certification-v1',
    true,
    'fr',
    'CERTIFIER DIDIT',
    'Exercise the isolated live Didit workflow without opening any gate.'
  );
select extensions.is(
  (
    select response ->> 'action'
    from didit_certification_state
    where operator_key = 'risk1'
  ),
  'kyc_certification_reserved',
  'Risk with fresh AAL2 can reserve the isolated certification'
);
select extensions.ok(
  (
    select
      response #>> '{certification,key}' ~ '^kcf_[0-9a-f]{24}$'
      and response #>> '{certification,status}' = 'reserved'
      and (response #>> '{certification,expires_at}')::timestamptz
        > now()
      and (response #>> '{certification,expires_at}')::timestamptz
        <= now() + interval '2 hours'
    from didit_certification_state
    where operator_key = 'risk1'
  ),
  'the reservation returns only an opaque key and a maximum two-hour window'
);
select extensions.is(
  public.admin_partners_kyc_certification_resume()
    #>> '{certification,key}',
  (
    select response #>> '{certification,key}'
    from didit_certification_state
    where operator_key = 'risk1'
  ),
  'resume recomputes the exact opaque key returned by prepare'
);
select extensions.is(
  public.admin_partners_kyc_certification_prepare(
    'certification.risk1.0001',
    'partners-didit-certification-v1',
    true,
    'fr',
    'CERTIFIER DIDIT',
    'Exercise the isolated live Didit workflow without opening any gate.'
  ) ->> 'replayed',
  'true',
  'an exact prepare retry is idempotent'
);
select extensions.throws_ok(
  $$
    select public.admin_partners_kyc_certification_prepare(
      'certification.risk1.0002',
      'partners-didit-certification-v1',
      true,
      'fr',
      'CERTIFIER DIDIT',
      'A second simultaneous run must remain unavailable to this operator.'
    )
  $$,
  'P0004',
  'a Didit certification is already active',
  'one operator can have only one active certification run'
);
select extensions.throws_ok(
  $$
    select public.admin_partners_kyc_certification_prepare(
      'certification.risk1.0001',
      'partners-didit-certification-v1',
      true,
      'fr',
      'CERTIFIER DIDIT',
      'A changed request cannot reuse the accepted idempotency identity.'
    )
  $$,
  'P0003',
  'idempotency key was reused with a different request',
  'an idempotency key cannot be rebound to different consent material'
);
reset role;

set local role service_role;
select extensions.throws_ok(
  $$
    select public.partners_service_kyc_certification_webhook_apply_and_enqueue_purge(
      'cross-purpose-event-0001',
      'cross-purpose-session-0001',
      'didit-workflow-certification',
      1,
      'approved',
      now(),
      30,
      'FRA',
      true,
      true,
      true,
      repeat('1', 64),
      'live',
      repeat('a', 64),
      current_setting('norva.partners_test_purge_envelope')
    )
  $$,
  'P0006',
  'Didit certification session is unknown',
  'a member-purpose provider session falls through to the member webhook path'
);
select extensions.throws_ok(
  $$
    select public.partners_service_kyc_certification_session_record(
      (
        select response #>> '{certification,key}'
        from didit_certification_state
        where operator_key = 'risk1'
      ),
      'didit-certification-session-risk1',
      'didit-workflow-certification',
      1,
      'not_started',
      'live',
      repeat('a', 64),
      604800
    )
  $$,
  'P0004',
  'Didit certification create dispatch was not claimed',
  'a provider session cannot bind before the durable create claim'
);
update didit_certification_state state
set create_claim_response =
  public.partners_service_kyc_certification_create_claim(
    state.response #>> '{certification,key}'
  )
where state.operator_key = 'risk1';
reset role;
select extensions.ok(
  (
    select
      state.create_claim_response ->> 'action' =
        'kyc_certification_create_claimed'
      and state.create_claim_response ->> 'claimed' = 'true'
      and state.create_claim_response
        #>> '{certification,provider_create_dispatched_at}' is not null
      and (
        state.create_claim_response
          #>> '{certification,provider_create_dispatched_at}'
      )::timestamptz = session.provider_create_dispatched_at
      and session.status = 'reserved'
    from didit_certification_state state
    join affiliate_private.affiliate_didit_certification_sessions session
      on session.certification_key_hash =
        affiliate_private.partners_didit_certification_key_hash(
          state.response #>> '{certification,key}'
        )
    where state.operator_key = 'risk1'
  ),
  'the first create claim persists one non-null dispatch timestamp'
);
set local role service_role;
update didit_certification_state state
set create_claim_replay_response =
  public.partners_service_kyc_certification_create_claim(
    state.response #>> '{certification,key}'
  )
where state.operator_key = 'risk1';
reset role;
select extensions.ok(
  (
    select
      state.create_claim_replay_response ->> 'action' =
        'kyc_certification_create_claimed'
      and state.create_claim_replay_response ->> 'claimed' = 'false'
      and state.create_claim_replay_response
        #>> '{certification,provider_create_dispatched_at}' =
          state.create_claim_response
            #>> '{certification,provider_create_dispatched_at}'
      and (
        state.create_claim_replay_response
          #>> '{certification,provider_create_dispatched_at}'
      )::timestamptz = session.provider_create_dispatched_at
    from didit_certification_state state
    join affiliate_private.affiliate_didit_certification_sessions session
      on session.certification_key_hash =
        affiliate_private.partners_didit_certification_key_hash(
          state.response #>> '{certification,key}'
        )
    where state.operator_key = 'risk1'
  ),
  'a replay cannot replace the immutable provider-create dispatch timestamp'
);
set local role service_role;
select extensions.is(
  public.partners_service_kyc_certification_session_record(
    (
      select response #>> '{certification,key}'
      from didit_certification_state
      where operator_key = 'risk1'
    ),
    'didit-certification-session-risk1',
    'didit-workflow-certification',
    1,
    'not_started',
    'live',
    repeat('a', 64),
    604800
  ) #>> '{certification,status}',
  'pending',
  'the configured seven-day provider TTL binds to the local certification'
);
select extensions.is(
  public.partners_service_kyc_certification_binding_match(
    (
      select response #>> '{certification,key}'
      from didit_certification_state
      where operator_key = 'risk1'
    ),
    'didit-certification-session-risk1'
  ) #>> '{certification,status}',
  'pending',
  'the exact Didit list candidate can recover a pending hosted session'
);
select extensions.throws_ok(
  $$
    select public.partners_service_kyc_certification_binding_match(
      (
        select response #>> '{certification,key}'
        from didit_certification_state
        where operator_key = 'risk1'
      ),
      'didit-certification-session-other'
    )
  $$,
  'P0006',
  'Didit certification binding candidate does not match',
  'a non-matching Didit list candidate never becomes an identifier oracle'
);
select extensions.is(
  public.partners_service_kyc_certification_session_record(
    (
      select response #>> '{certification,key}'
      from didit_certification_state
      where operator_key = 'risk1'
    ),
    'didit-certification-session-risk1',
    'didit-workflow-certification',
    1,
    'not_started',
    'live',
    repeat('a', 64),
    604800
  ) ->> 'replayed',
  'true',
  'an exact hosted-session binding replays idempotently'
);
select extensions.ok(
  (
    select
      response ->> 'replayed' = 'true'
      and response #>> '{certification,status}' = 'in_review'
    from (
      select public.partners_service_kyc_certification_session_record(
        (
          select response #>> '{certification,key}'
          from didit_certification_state
          where operator_key = 'risk1'
        ),
        'didit-certification-session-risk1',
        'didit-workflow-certification',
        1,
        'in_review',
        'live',
        repeat('a', 64),
        604800
      ) as response
    ) evolved_replay
  ),
  'a stable hosted-session binding tolerates provider-status evolution without quarantine'
);
reset role;
select extensions.ok(
  exists (
    select 1
    from affiliate_private.affiliate_didit_certification_sessions session
    where session.provider_session_hash = encode(
        extensions.digest(
          'norva:didit:session:v1:didit-certification-session-risk1',
          'sha256'
        ),
        'hex'
      )
      and session.status = 'pending'
      and session.quarantine_reason is null
  ),
  'provider-status evolution leaves the stable certification binding intact'
);

set local role authenticated;
select extensions.is(
  public.admin_partners_kyc_certification_resume()
    #>> '{certification,key}',
  (
    select response #>> '{certification,key}'
    from didit_certification_state
    where operator_key = 'risk1'
  ),
  'a pending certification resumes with the same opaque key'
);
reset role;

update affiliate_private.affiliate_didit_certification_sessions session
set
  provider_status = 'in_review',
  status = 'in_review',
  updated_at = clock_timestamp()
where session.certification_key_hash =
  affiliate_private.partners_didit_certification_key_hash(
    (
      select response #>> '{certification,key}'
      from didit_certification_state
      where operator_key = 'risk1'
    )
  );

set local role authenticated;
select extensions.throws_ok(
  $$select public.admin_partners_kyc_certification_resume()$$,
  'P0004',
  'Didit certification is not resumable',
  'an in-review certification cannot expose a resumable key'
);
select extensions.throws_ok(
  $$
    select public.admin_partners_kyc_certification_prepare(
      'certification.risk1.0001',
      'partners-didit-certification-v1',
      true,
      'fr',
      'CERTIFIER DIDIT',
      'Exercise the isolated live Didit workflow without opening any gate.'
    )
  $$,
  'P0004',
  'Didit certification replay is unavailable',
  'prepare refuses to replay a non-resumable in-review status'
);
reset role;

select extensions.ok(
  exists (
    select 1
    from affiliate_private.affiliate_didit_certification_sessions session
    join affiliate_private.affiliate_didit_session_registry registry
      on registry.provider_session_hash = session.provider_session_hash
      and registry.session_purpose = 'certification'
      and registry.source_record_id = session.id
    where session.operator_hash = encode(
      extensions.digest(
        'norva:didit:certification-operator:v1:'
          || '31000000-0000-4000-8000-000000000001',
        'sha256'
      ),
      'hex'
    )
      and session.expires_at <= session.created_at + interval '2 hours'
  ),
  'the certification binding is registered cross-purpose and remains local-TTL bounded'
);

update didit_certification_state
set event_created_at = clock_timestamp()
where operator_key = 'risk1';
set local role service_role;
select extensions.is(
  public.partners_service_kyc_certification_webhook_apply_and_enqueue_purge(
    'didit-certification-event-risk1',
    'didit-certification-session-risk1',
    'didit-workflow-certification',
    1,
    'approved',
    (
      select event_created_at
      from didit_certification_state
      where operator_key = 'risk1'
    ),
    30,
    'FRA',
    true,
    true,
    true,
    repeat('2', 64),
    'live',
    repeat('b', 64),
    current_setting('norva.partners_test_purge_envelope')
  ) ->> 'action',
  'kyc_certification_result_quarantined',
  'a config-fingerprint mismatch is quarantined instead of promoted'
);
select extensions.is(
  public.partners_service_kyc_certification_webhook_apply_and_enqueue_purge(
    'didit-certification-event-risk1',
    'didit-certification-session-risk1',
    'didit-workflow-certification',
    1,
    'approved',
    (
      select event_created_at
      from didit_certification_state
      where operator_key = 'risk1'
    ),
    30,
    'FRA',
    true,
    true,
    true,
    repeat('2', 64),
    'live',
    repeat('b', 64),
    current_setting('norva.partners_test_purge_envelope')
  ) #>> '{certification,reason}',
  'provider_config_mismatch',
  'the quarantined response exposes only the bounded public reason enum'
);
reset role;
select extensions.ok(
  exists (
    select 1
    from affiliate_private.affiliate_didit_certification_sessions session
    join affiliate_private.affiliate_didit_certification_events event
      on event.certification_session_id = session.id
    where session.status = 'quarantined'
      and not session.verified
      and session.quarantine_reason = 'config_fingerprint_mismatch'
      and event.processing_outcome = 'quarantined'
      and event.bounded_reason = 'config_fingerprint_mismatch'
  ),
  'the mismatch is durably quarantined using hashes and bounded state only'
);

do $jwt$
begin
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', '31000000-0000-4000-8000-000000000002',
      'role', 'authenticated',
      'aal', 'aal2',
      'iat', floor(extract(epoch from clock_timestamp()))::bigint,
      'app_metadata', jsonb_build_object('role', 'admin')
    )::text,
    true
  );
end;
$jwt$;
set local role authenticated;
insert into didit_certification_state (operator_key, response)
select
  'risk2',
  public.admin_partners_kyc_certification_prepare(
    'certification.risk2.0001',
    'partners-didit-certification-v1',
    true,
    'fr',
    'CERTIFIER DIDIT',
    'Exercise the exact live approved workflow for immutable evidence.'
  );
select extensions.is(
  (
    select response #>> '{certification,status}'
    from didit_certification_state
    where operator_key = 'risk2'
  ),
  'reserved',
  'a second distinct Risk operator can reserve its own isolated run'
);
reset role;

set local role service_role;
do $claim$
begin
  perform public.partners_service_kyc_certification_create_claim(
    (
      select response #>> '{certification,key}'
      from didit_certification_state
      where operator_key = 'risk2'
    )
  );
end;
$claim$;
select extensions.is(
  public.partners_service_kyc_certification_session_record(
    (
      select response #>> '{certification,key}'
      from didit_certification_state
      where operator_key = 'risk2'
    ),
    'didit-certification-session-risk2',
    'didit-workflow-certification',
    1,
    'not_started',
    'live',
    repeat('c', 64),
    604800
  ) ->> 'action',
  'kyc_certification_session_recorded',
  'the second exact hosted session is recorded'
);
reset role;
update didit_certification_state
-- pgTAP executes the complete certification and provider purge in one
-- transaction.  The purge worker records its canonical deletion timestamp
-- with transaction_timestamp(); keep the authoritative approval event on the
-- same database clock so provider_purged_at >= verified_at remains a genuinely
-- current coverage proof inside this transactional fixture.
set event_created_at = transaction_timestamp()
where operator_key = 'risk2';

set local role service_role;
select extensions.is(
  public.partners_service_kyc_certification_webhook_apply_and_enqueue_purge(
    'didit-certification-event-risk2',
    'didit-certification-session-risk2',
    'didit-workflow-certification',
    1,
    'approved',
    (
      select event_created_at
      from didit_certification_state
      where operator_key = 'risk2'
    ),
    30,
    'FRA',
    true,
    true,
    true,
    repeat('3', 64),
    'live',
    repeat('c', 64),
    current_setting('norva.partners_test_purge_envelope')
  ) ->> 'action',
  'kyc_certification_result_applied',
  'an exact live approved decision is applied to certification only'
);
select extensions.is(
  public.partners_service_kyc_certification_webhook_apply_and_enqueue_purge(
    'didit-certification-event-risk2',
    'didit-certification-session-risk2',
    'didit-workflow-certification',
    1,
    'approved',
    (
      select event_created_at
      from didit_certification_state
      where operator_key = 'risk2'
    ),
    30,
    'FRA',
    true,
    true,
    true,
    repeat('3', 64),
    'live',
    repeat('c', 64),
    current_setting('norva.partners_test_purge_envelope')
  ) ->> 'replayed',
  'true',
  'the exact signed decision replays idempotently'
);
reset role;

select extensions.ok(
  exists (
    select 1
    from affiliate_private.affiliate_didit_certification_sessions session
    where session.status = 'approved'
      and session.provider_environment = 'live'
      and session.provider_workflow_version = 1
      and session.verified
      and session.id_check_approved
      and session.liveness_approved
      and session.face_match_approved
      and session.age_over_minimum
      and session.jurisdiction_result_present
  ),
  'successful live approval stores only the exact version, booleans and hashes'
);

do $jwt$
begin
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', '31000000-0000-4000-8000-000000000002',
      'role', 'authenticated',
      'aal', 'aal2',
      'iat', floor(extract(epoch from clock_timestamp()))::bigint,
      'app_metadata', jsonb_build_object('role', 'admin')
    )::text,
    true
  );
end;
$jwt$;
set local role authenticated;
select extensions.is(
  public.admin_partners_kyc_certification_status()
    #>> '{certification,status}',
  'approved',
  'status returns the authenticated Risk operator own latest result'
);
select extensions.is(
  public.admin_partners_kyc_certification_status()
    #>> '{certification,verified}',
  'true',
  'status exposes the authoritative live verification boolean'
);
select extensions.ok(
  (
    select
      response #>> '{certification,environment}' = 'live'
      and (response #>> '{certification,observed_at}')::timestamptz
        >= (response #>> '{certification,expires_at}')::timestamptz
          - interval '2 hours'
      and (response #> '{certification}') ? 'reason'
      and response #> '{certification,reason}' = 'null'::jsonb
    from (
      select public.admin_partners_kyc_certification_status() as response
    ) status_response
  ),
  'status exposes only bounded environment, timestamps and nullable reason'
);
select extensions.throws_ok(
  $$select public.admin_partners_kyc_certification_resume()$$,
  'P0004',
  'Didit certification is not resumable',
  'a terminal approved certification cannot expose a resumable key'
);
reset role;

-- A complete sandbox approval proves transport and workflow wiring only. It
-- must never become an authoritative verification, even with every check true.
set local role authenticated;
insert into didit_certification_state (operator_key, response)
select
  'risk2-sandbox',
  public.admin_partners_kyc_certification_prepare(
    'certification.risk2.sandbox.0001',
    'partners-didit-certification-v1',
    true,
    'fr',
    'CERTIFIER DIDIT',
    'Exercise the sandbox workflow as non-authoritative transport evidence.'
  );
select extensions.is(
  (
    select response #>> '{certification,status}'
    from didit_certification_state
    where operator_key = 'risk2-sandbox'
  ),
  'reserved',
  'Risk can reserve a sandbox proof after its completed live run'
);
reset role;

set local role service_role;
do $claim$
begin
  perform public.partners_service_kyc_certification_create_claim(
    (
      select response #>> '{certification,key}'
      from didit_certification_state
      where operator_key = 'risk2-sandbox'
    )
  );
end;
$claim$;
select extensions.is(
  public.partners_service_kyc_certification_session_record(
    (
      select response #>> '{certification,key}'
      from didit_certification_state
      where operator_key = 'risk2-sandbox'
    ),
    'didit-certification-session-risk2-sandbox',
    'didit-workflow-certification',
    1,
    'not_started',
    'sandbox',
    repeat('d', 64),
    2419200
  ) ->> 'action',
  'kyc_certification_session_recorded',
  'the maximum accepted provider TTL is still bound to the local reservation'
);
reset role;

update didit_certification_state
set event_created_at = clock_timestamp()
where operator_key = 'risk2-sandbox';
set local role service_role;
update didit_certification_state state
set response = public.partners_service_kyc_certification_webhook_apply_and_enqueue_purge(
  'didit-certification-event-risk2-sandbox',
  'didit-certification-session-risk2-sandbox',
  'didit-workflow-certification',
  1,
  'approved',
  state.event_created_at,
  30,
  'FRA',
  true,
  true,
  true,
  repeat('4', 64),
  'sandbox',
  repeat('d', 64),
  current_setting('norva.partners_test_purge_envelope')
)
where state.operator_key = 'risk2-sandbox';
select extensions.ok(
  (
    select
      response ->> 'action' = 'kyc_certification_result_applied'
      and response #>> '{certification,status}' = 'approved'
      and response #>> '{certification,verified}' = 'false'
      and not ((response #> '{certification}') ? 'reason')
    from didit_certification_state
    where operator_key = 'risk2-sandbox'
  ),
  'an applied sandbox approval is sanitized and remains non-authoritative'
);
reset role;
select extensions.ok(
  exists (
    select 1
    from affiliate_private.affiliate_didit_certification_sessions session
    join affiliate_private.affiliate_didit_certification_events event
      on event.certification_session_id = session.id
    where session.provider_environment = 'sandbox'
      and session.status = 'approved'
      and not session.verified
      and event.processing_outcome = 'applied'
      and not event.verified
  ),
  'sandbox approval persists only bounded non-authoritative evidence'
);

-- The signed event timestamp is also bounded by the local reservation. A
-- future-dated event within the accepted clock skew but after expires_at must
-- be ignored as stale even while the server clock is still before expires_at.
set local role authenticated;
insert into didit_certification_state (operator_key, response)
select
  'risk2-late',
  public.admin_partners_kyc_certification_prepare(
    'certification.risk2.late.0001',
    'partners-didit-certification-v1',
    true,
    'fr',
    'CERTIFIER DIDIT',
    'Prove that a signed decision after local expiry can never be approved.'
  );
select extensions.is(
  (
    select response #>> '{certification,status}'
    from didit_certification_state
    where operator_key = 'risk2-late'
  ),
  'reserved',
  'Risk can reserve an isolated late-event boundary proof'
);
reset role;

set local role service_role;
do $claim$
begin
  perform public.partners_service_kyc_certification_create_claim(
    (
      select response #>> '{certification,key}'
      from didit_certification_state
      where operator_key = 'risk2-late'
    )
  );
end;
$claim$;
select extensions.is(
  public.partners_service_kyc_certification_session_record(
    (
      select response #>> '{certification,key}'
      from didit_certification_state
      where operator_key = 'risk2-late'
    ),
    'didit-certification-session-risk2-late',
    'didit-workflow-certification',
    1,
    'not_started',
    'live',
    repeat('e', 64),
    3600
  ) ->> 'action',
  'kyc_certification_session_recorded',
  'the minimum accepted provider TTL binds to the late-event proof'
);
reset role;

update affiliate_private.affiliate_didit_certification_sessions session
set
  expires_at = clock_timestamp() + interval '4 minutes',
  updated_at = clock_timestamp()
from didit_certification_state state
where state.operator_key = 'risk2-late'
  and session.certification_key_hash =
    affiliate_private.partners_didit_certification_key_hash(
      state.response #>> '{certification,key}'
    );
update didit_certification_state state
set event_created_at = session.expires_at + interval '30 seconds'
from affiliate_private.affiliate_didit_certification_sessions session
where state.operator_key = 'risk2-late'
  and session.certification_key_hash =
    affiliate_private.partners_didit_certification_key_hash(
      state.response #>> '{certification,key}'
    );
select extensions.ok(
  (
    select
      session.expires_at > clock_timestamp()
      and state.event_created_at > session.expires_at
      and state.event_created_at <= clock_timestamp() + interval '5 minutes'
    from didit_certification_state state
    join affiliate_private.affiliate_didit_certification_sessions session
      on session.certification_key_hash =
        affiliate_private.partners_didit_certification_key_hash(
          state.response #>> '{certification,key}'
        )
    where state.operator_key = 'risk2-late'
  ),
  'the late-event fixture is after local expiry while the server clock is before it'
);

set local role service_role;
update didit_certification_state state
set response = public.partners_service_kyc_certification_webhook_apply_and_enqueue_purge(
  'didit-certification-event-risk2-late',
  'didit-certification-session-risk2-late',
  'didit-workflow-certification',
  1,
  'approved',
  state.event_created_at,
  30,
  'FRA',
  true,
  true,
  true,
  repeat('5', 64),
  'live',
  repeat('e', 64),
  current_setting('norva.partners_test_purge_envelope')
)
where state.operator_key = 'risk2-late';
select extensions.ok(
  (
    select
      response ->> 'action' = 'kyc_certification_result_applied'
      and response #>> '{certification,status}' = 'expired'
      and response #>> '{certification,verified}' = 'false'
      and not ((response #> '{certification}') ? 'reason')
    from didit_certification_state
    where operator_key = 'risk2-late'
  ),
  'a post-expiry decision returns only an expired non-authoritative state'
);
reset role;
select extensions.ok(
  exists (
    select 1
    from affiliate_private.affiliate_didit_certification_sessions session
    join affiliate_private.affiliate_didit_certification_events event
      on event.certification_session_id = session.id
    where session.provider_session_hash = encode(
        extensions.digest(
          'norva:didit:session:v1:didit-certification-session-risk2-late',
          'sha256'
        ),
        'hex'
      )
      and session.status = 'expired'
      and not session.verified
      and event.provider_event_created_at > session.expires_at
      and event.processing_outcome = 'ignored'
      and event.bounded_reason = 'stale_event'
      and not event.verified
  ),
  'a post-expiry approved event is durably ignored as stale and never verifies'
);

-- Preparation is rechecked after the remote Didit call. A Privacy gate change
-- in that network window rejects the service binding and leaves no proof.
do $jwt$
begin
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', '31000000-0000-4000-8000-000000000001',
      'role', 'authenticated',
      'aal', 'aal2',
      'iat', floor(extract(epoch from clock_timestamp()))::bigint,
      'app_metadata', jsonb_build_object('role', 'admin')
    )::text,
    true
  );
end;
$jwt$;
set local role authenticated;
insert into didit_certification_state (operator_key, response)
select
  'risk1-gate-race',
  public.admin_partners_kyc_certification_prepare(
    'certification.risk1.gate-race.0001',
    'partners-didit-certification-v1',
    true,
    'fr',
    'CERTIFIER DIDIT',
    'Prove that a live-path change aborts post-provider session binding.'
  );
select extensions.is(
  (
    select response #>> '{certification,status}'
    from didit_certification_state
    where operator_key = 'risk1-gate-race'
  ),
  'reserved',
  'Risk can reserve the exact gate-race test session'
);
reset role;

set local role service_role;
do $claim$
begin
  perform public.partners_service_kyc_certification_create_claim(
    (
      select response #>> '{certification,key}'
      from didit_certification_state
      where operator_key = 'risk1-gate-race'
    )
  );
end;
$claim$;
reset role;

set local role authenticated;
do $revoke_privacy$
begin
  perform public.admin_partners_control(
    'set_gate',
    'privacy_approved',
    false,
    'Pre-gate Didit pgTAP revokes Privacy approval after provider dispatch.'
  );
end;
$revoke_privacy$;
reset role;
set local role service_role;
select extensions.throws_ok(
  $$
    select public.partners_service_kyc_certification_session_record(
      (
        select response #>> '{certification,key}'
        from didit_certification_state
        where operator_key = 'risk1-gate-race'
      ),
      'didit-certification-session-gate-race',
      'didit-certification-workflow-v1',
      1,
      'not_started',
      'live',
      repeat('d', 64),
      604800
    )
  $$,
  'P0001',
  'Privacy approval is required for Didit certification',
  'service binding rechecks Privacy approval after the remote provider call'
);
reset role;
set local role authenticated;
do $restore_privacy$
begin
  perform public.admin_partners_release_gate_approve(
    'privacy_approved',
    'p0-didit-certification-test-v1',
    '[{"country_code":"FR"}]'::jsonb,
    pg_temp.didit_certification_approval_documents('privacy_approved'),
    repeat('a', 40),
    'preproduction',
    'didit-certification-test-deployment',
    repeat('2', 64),
    now() + interval '30 days',
    'Pre-gate Didit pgTAP restores immutable Privacy approval after the race.'
  );
end;
$restore_privacy$;
reset role;

set local role service_role;
select extensions.is(
  public.partners_service_kyc_certification_session_record(
    (
      select response #>> '{certification,key}'
      from didit_certification_state
      where operator_key = 'risk1-gate-race'
    ),
    'cross-purpose-session-0001',
    'didit-certification-workflow-v1',
    1,
    'not_started',
    'live',
    repeat('d', 64),
    604800
  ) #>> '{certification,status}',
  'quarantined',
  'a member-purpose Didit session cannot bind to a certification reservation'
);
reset role;
select extensions.ok(
  exists (
    select 1
    from affiliate_private.affiliate_didit_session_registry registry
    where registry.provider_session_hash = encode(
        extensions.digest(
          'norva:didit:session:v1:cross-purpose-session-0001',
          'sha256'
        ),
        'hex'
      )
      and registry.session_purpose = 'member_kyc'
  )
  and exists (
    select 1
    from affiliate_private.affiliate_didit_certification_sessions session
    where session.operator_hash = encode(
        extensions.digest(
          'norva:didit:certification-operator:v1:'
            || '31000000-0000-4000-8000-000000000001',
          'sha256'
        ),
        'hex'
      )
      and session.status = 'quarantined'
      and session.quarantine_reason = 'cross_purpose_session_conflict'
  ),
  'cross-purpose quarantine preserves the original member registry ownership'
);

-- Read-only observation remains available after the pre-gate phase closes.
set local role service_role;
do $complete_certification_purge$
declare
  v_claim record;
begin
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
$complete_certification_purge$;
reset role;
set local role authenticated;
do $close_pre_gate$
begin
  perform public.admin_partners_release_gate_approve(
    'individual_verification_coverage_confirmed',
    'p0-didit-certification-test-v1',
    '[{"country_code":"FR"}]'::jsonb,
    pg_temp.didit_certification_approval_documents(
      'individual_verification_coverage_confirmed'
    ),
    repeat('a', 40),
    'preproduction',
    'didit-certification-test-deployment',
    repeat('2', 64),
    now() + interval '30 days',
    'Didit certification pgTAP closes the pre-gate with immutable evidence.'
  );
end;
$close_pre_gate$;
select extensions.is(
  public.admin_partners_kyc_certification_status() ->> 'action',
  'kyc_certification_status',
  'Risk can still observe its bounded proof after the coverage gate closes'
);
do $reopen_pre_gate$
begin
  perform public.admin_partners_control(
    'set_gate',
    'individual_verification_coverage_confirmed',
    false,
    'Didit certification pgTAP restores the initial pre-gate state.'
  );
end;
$reopen_pre_gate$;
reset role;

select extensions.is(
  (
    select row(
      (select count(*) from affiliate_private.affiliate_accounts),
      (select count(*) from affiliate_private.affiliate_links),
      (select count(*)
        from affiliate_private.affiliate_commission_entries),
      (select count(*) from affiliate_private.affiliate_payout_items)
    )::text
    from didit_certification_snapshot snapshot
  ),
  (
    select row(
      snapshot.account_count,
      snapshot.link_count,
      snapshot.commission_count,
      snapshot.payout_item_count
    )::text
    from didit_certification_snapshot snapshot
  ),
  'certification never creates or mutates account, link, commission or payout rows'
);
select extensions.is(
  (
    select jsonb_object_agg(flag.key, flag.enabled order by flag.key)
    from public.admin_feature_flags flag
    where flag.key like 'partners_%'
  ),
  (
    select snapshot.flags
    from didit_certification_snapshot snapshot
  ),
  'certification leaves every Partners feature flag unchanged'
);
select extensions.is(
  (
    select jsonb_object_agg(
      gate.gate_key,
      gate.satisfied
      order by gate.gate_key
    )
    from affiliate_private.affiliate_release_gates gate
  ),
  (
    select snapshot.gates
    from didit_certification_snapshot snapshot
  ),
  'certification never promotes or otherwise mutates any release gate'
);
select extensions.ok(
  exists (
    select 1
    from affiliate_private.affiliate_release_gates gate
    where gate.gate_key = 'individual_verification_coverage_confirmed'
      and not gate.satisfied
  ),
  'successful live certification still leaves verification coverage unconfirmed'
);
select extensions.ok(
  not exists (
    select 1
    from affiliate_private.affiliate_didit_certification_sessions session
    where session.expires_at > session.created_at + interval '2 hours'
  ),
  'no certification session can outlive the local two-hour ceiling'
);
select extensions.ok(
  not exists (
    select 1
    from information_schema.columns column_row
    where column_row.table_schema = 'affiliate_private'
      and column_row.table_name =
        'affiliate_didit_certification_events'
      and column_row.data_type in ('json', 'jsonb', 'bytea')
  ),
  'certification observations cannot persist a provider payload or document blob'
);

select * from extensions.finish();
rollback;
