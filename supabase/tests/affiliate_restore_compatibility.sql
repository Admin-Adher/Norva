begin;

create extension if not exists pgtap with schema extensions;

select extensions.plan(20);

-- One immutable catalogue keeps all ten pending migrations under the same
-- existence, ownership, security, volatility and ACL assertions without
-- creating any object in the restored database.
set local norva.partners_restore_expected_routines = '[
  {"signature":"affiliate_private.partners_actor_is_live_admin(text)","security_definer":true,"volatility":"s","access_role":"owner"},
  {"signature":"affiliate_private.partners_has_capability(text)","security_definer":true,"volatility":"s","access_role":"owner"},
  {"signature":"affiliate_private.partners_can_manage_capabilities()","security_definer":true,"volatility":"s","access_role":"owner"},
  {"signature":"affiliate_private.partners_is_release_manager()","security_definer":true,"volatility":"s","access_role":"owner"},
  {"signature":"affiliate_private.partners_require_aal2(text)","security_definer":true,"volatility":"s","access_role":"owner"},
  {"signature":"affiliate_private.guard_partners_release_gate_activation_aal2()","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.partners_admin_operator_key(uuid)","security_definer":false,"volatility":"i","access_role":"owner"},
  {"signature":"affiliate_private.admin_partners_capability_operators()","security_definer":true,"volatility":"s","access_role":"authenticated"},
  {"signature":"affiliate_private.admin_partners_capability_set_by_operator_key(text,text,boolean,text)","security_definer":true,"volatility":"v","access_role":"authenticated"},
  {"signature":"affiliate_private.admin_partners_capability_set(uuid,text,boolean,text)","security_definer":true,"volatility":"v","access_role":"authenticated"},
  {"signature":"public.admin_partners_capability_operators()","security_definer":false,"volatility":"s","access_role":"authenticated"},
  {"signature":"public.admin_partners_capability_set_by_operator_key(text,text,boolean,text)","security_definer":false,"volatility":"v","access_role":"authenticated"},
  {"signature":"affiliate_private.partners_access_decision_email_enqueue()","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.register_member_didit_session()","security_definer":false,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.guard_didit_certification_session_transition()","security_definer":false,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.partners_didit_certification_key_hash(text)","security_definer":false,"volatility":"i","access_role":"owner"},
  {"signature":"affiliate_private.partners_didit_certification_key(text,uuid)","security_definer":false,"volatility":"i","access_role":"owner"},
  {"signature":"affiliate_private.partners_didit_certification_public_reason(text)","security_definer":false,"volatility":"i","access_role":"owner"},
  {"signature":"affiliate_private.partners_didit_certification_operator_hash()","security_definer":true,"volatility":"s","access_role":"owner"},
  {"signature":"affiliate_private.partners_require_didit_certification_observer(text)","security_definer":true,"volatility":"s","access_role":"owner"},
  {"signature":"affiliate_private.partners_assert_didit_certification_pre_gate()","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.partners_require_didit_certification_operator(text)","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.admin_partners_kyc_certification_prepare(text,text,boolean,text,text,text)","security_definer":true,"volatility":"v","access_role":"authenticated"},
  {"signature":"affiliate_private.admin_partners_kyc_certification_resume()","security_definer":true,"volatility":"v","access_role":"authenticated"},
  {"signature":"affiliate_private.admin_partners_kyc_certification_status()","security_definer":true,"volatility":"v","access_role":"authenticated"},
  {"signature":"affiliate_private.partners_service_kyc_certification_create_claim(text)","security_definer":true,"volatility":"v","access_role":"service_role"},
  {"signature":"affiliate_private.partners_service_kyc_certification_binding_match(text,text)","security_definer":true,"volatility":"v","access_role":"service_role"},
  {"signature":"affiliate_private.partners_service_kyc_certification_session_record(text,text,text,integer,text,text,text,integer)","security_definer":true,"volatility":"v","access_role":"service_role"},
  {"signature":"affiliate_private.partners_service_kyc_certification_webhook_apply(text,text,text,integer,text,timestamptz,integer,text,boolean,boolean,boolean,text,text,text)","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"public.admin_partners_kyc_certification_prepare(text,text,boolean,text,text,text)","security_definer":false,"volatility":"v","access_role":"authenticated"},
  {"signature":"public.admin_partners_kyc_certification_resume()","security_definer":false,"volatility":"v","access_role":"authenticated"},
  {"signature":"public.admin_partners_kyc_certification_status()","security_definer":false,"volatility":"v","access_role":"authenticated"},
  {"signature":"public.partners_service_kyc_certification_create_claim(text)","security_definer":false,"volatility":"v","access_role":"service_role"},
  {"signature":"public.partners_service_kyc_certification_binding_match(text,text)","security_definer":false,"volatility":"v","access_role":"service_role"},
  {"signature":"public.partners_service_kyc_certification_session_record(text,text,text,integer,text,text,text,integer)","security_definer":false,"volatility":"v","access_role":"service_role"},
  {"signature":"public.partners_service_kyc_certification_webhook_apply(text,text,text,integer,text,timestamptz,integer,text,boolean,boolean,boolean,text,text,text)","security_definer":false,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.valid_partners_approval_document_hashes(jsonb)","security_definer":false,"volatility":"i","access_role":"owner"},
  {"signature":"affiliate_private.valid_partners_approval_jurisdiction_scope(jsonb)","security_definer":false,"volatility":"i","access_role":"owner"},
  {"signature":"affiliate_private.partners_approval_required_document_keys(text)","security_definer":false,"volatility":"i","access_role":"owner"},
  {"signature":"affiliate_private.partners_approval_package_sha256(text,integer,text,text,jsonb,jsonb,text,text,text,text,text,text,timestamptz,timestamptz,text)","security_definer":false,"volatility":"i","access_role":"owner"},
  {"signature":"affiliate_private.partners_deployment_manifest_sha256(text,integer,text,text,text,jsonb,text,timestamptz,text)","security_definer":false,"volatility":"i","access_role":"owner"},
  {"signature":"affiliate_private.guard_partners_deployment_manifest_insert()","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.reject_partners_deployment_manifest_mutation()","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.guard_partners_deployment_manifest_binding()","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.guard_partners_approval_package_insert()","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.reject_partners_approval_package_mutation()","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.guard_partners_approval_binding_mutation()","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.partners_program_approval_snapshot_sha256(uuid)","security_definer":true,"volatility":"s","access_role":"owner"},
  {"signature":"affiliate_private.partners_country_policy_approval_snapshot_sha256(uuid)","security_definer":true,"volatility":"s","access_role":"owner"},
  {"signature":"affiliate_private.partners_approval_package_is_current(uuid,text)","security_definer":true,"volatility":"s","access_role":"owner"},
  {"signature":"affiliate_private.partners_approval_package_is_current(uuid,text,text)","security_definer":true,"volatility":"s","access_role":"owner"},
  {"signature":"affiliate_private.partners_release_gate_approval_is_current(text)","security_definer":true,"volatility":"s","access_role":"owner"},
  {"signature":"affiliate_private.release_gates_satisfied(text[])","security_definer":true,"volatility":"s","access_role":"owner"},
  {"signature":"affiliate_private.partners_approval_gate_covers_policy(text,uuid,text,text)","security_definer":true,"volatility":"s","access_role":"owner"},
  {"signature":"affiliate_private.admin_partners_deployment_manifest_register(text,text,text,text,jsonb,text)","security_definer":true,"volatility":"v","access_role":"authenticated"},
  {"signature":"public.admin_partners_deployment_manifest_register(text,text,text,text,jsonb,text)","security_definer":false,"volatility":"v","access_role":"authenticated"},
  {"signature":"affiliate_private.admin_partners_release_gate_approve(text,text,jsonb,jsonb,text,text,text,text,timestamptz,text)","security_definer":true,"volatility":"v","access_role":"authenticated"},
  {"signature":"public.admin_partners_release_gate_approve(text,text,jsonb,jsonb,text,text,text,text,timestamptz,text)","security_definer":false,"volatility":"v","access_role":"authenticated"},
  {"signature":"affiliate_private.guard_partners_release_gate_approval()","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.clear_partners_release_gate_approval()","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.guard_partners_program_approved_scope()","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.guard_partners_country_policy_approved_scope()","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.guard_partners_pilot_allowlist_limit()","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.admin_partners_configuration_pre_approval_registry_20260804()","security_definer":true,"volatility":"s","access_role":"owner"},
  {"signature":"affiliate_private.admin_partners_configuration()","security_definer":true,"volatility":"s","access_role":"authenticated"},
  {"signature":"public.admin_partners_configuration()","security_definer":false,"volatility":"s","access_role":"authenticated"},
  {"signature":"affiliate_private.admin_partners_revolut_payout_status()","security_definer":true,"volatility":"s","access_role":"owner"},
  {"signature":"affiliate_private.admin_partners_revolut_payout_status_approval_registry()","security_definer":true,"volatility":"s","access_role":"authenticated"},
  {"signature":"public.admin_partners_revolut_payout_status()","security_definer":false,"volatility":"s","access_role":"authenticated"},
  {"signature":"affiliate_private.partners_service_kyc_prepare_v2(uuid,text,text,text,boolean,text)","security_definer":true,"volatility":"v","access_role":"service_role"},
  {"signature":"public.partners_service_kyc_prepare_v2(uuid,text,text,text,boolean,text)","security_definer":false,"volatility":"v","access_role":"service_role"},
  {"signature":"affiliate_private.partners_service_kyc_session_record_v2(uuid,text,text,text,integer,text,timestamptz,text,text,text,integer)","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"public.partners_service_kyc_session_record_v2(uuid,text,text,text,integer,text,timestamptz,text,text,text,integer)","security_definer":false,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.guard_didit_purge_managed_mutation()","security_definer":false,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.mark_member_didit_purge_pending()","security_definer":false,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.mark_certification_didit_purge_pending()","security_definer":false,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.guard_account_activation_until_didit_purged()","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.guard_didit_purge_activation_audit()","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.partners_didit_purge_public_status(text)","security_definer":false,"volatility":"i","access_role":"owner"},
  {"signature":"affiliate_private.partners_didit_purge_sync_source(text,text,timestamptz)","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.partners_didit_purge_stage_member(text,text,text)","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.partners_didit_purge_activate_staged(text,text)","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.partners_service_kyc_session_record_v3(uuid,text,text,text,integer,text,timestamptz,text,text,text,integer,text)","security_definer":true,"volatility":"v","access_role":"service_role"},
  {"signature":"public.partners_service_kyc_session_record_v3(uuid,text,text,text,integer,text,timestamptz,text,text,text,integer,text)","security_definer":false,"volatility":"v","access_role":"service_role"},
  {"signature":"affiliate_private.partners_didit_purge_enqueue(text,text,text)","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.partners_service_kyc_webhook_apply_and_enqueue_purge(text,text,text,integer,text,timestamptz,integer,text,boolean,boolean,boolean,text,text,text,text)","security_definer":true,"volatility":"v","access_role":"service_role"},
  {"signature":"affiliate_private.partners_service_kyc_certification_webhook_apply_and_enqueue_purge(text,text,text,integer,text,timestamptz,integer,text,boolean,boolean,boolean,text,text,text,text)","security_definer":true,"volatility":"v","access_role":"service_role"},
  {"signature":"public.partners_service_kyc_webhook_apply_and_enqueue_purge(text,text,text,integer,text,timestamptz,integer,text,boolean,boolean,boolean,text,text,text,text)","security_definer":false,"volatility":"v","access_role":"service_role"},
  {"signature":"public.partners_service_kyc_certification_webhook_apply_and_enqueue_purge(text,text,text,integer,text,timestamptz,integer,text,boolean,boolean,boolean,text,text,text,text)","security_definer":false,"volatility":"v","access_role":"service_role"},
  {"signature":"affiliate_private.partners_service_didit_purge_claim(integer,integer)","security_definer":true,"volatility":"v","access_role":"service_role"},
  {"signature":"affiliate_private.partners_service_didit_purge_complete(bigint,uuid,text)","security_definer":true,"volatility":"v","access_role":"service_role"},
  {"signature":"affiliate_private.partners_service_didit_purge_fail(bigint,uuid,text,integer,boolean,integer)","security_definer":true,"volatility":"v","access_role":"service_role"},
  {"signature":"affiliate_private.partners_service_didit_purge_heartbeat(text,integer,integer,integer,integer)","security_definer":true,"volatility":"v","access_role":"service_role"},
  {"signature":"affiliate_private.partners_service_didit_purge_status()","security_definer":true,"volatility":"s","access_role":"service_role"},
  {"signature":"public.partners_service_didit_purge_claim(integer,integer)","security_definer":false,"volatility":"v","access_role":"service_role"},
  {"signature":"public.partners_service_didit_purge_complete(bigint,uuid,text)","security_definer":false,"volatility":"v","access_role":"service_role"},
  {"signature":"public.partners_service_didit_purge_fail(bigint,uuid,text,integer,boolean,integer)","security_definer":false,"volatility":"v","access_role":"service_role"},
  {"signature":"public.partners_service_didit_purge_heartbeat(text,integer,integer,integer,integer)","security_definer":false,"volatility":"v","access_role":"service_role"},
  {"signature":"public.partners_service_didit_purge_status()","security_definer":false,"volatility":"s","access_role":"service_role"},
  {"signature":"affiliate_private.partners_didit_purge_coverage_ready()","security_definer":true,"volatility":"s","access_role":"owner"},
  {"signature":"affiliate_private.partners_service_kyc_prepare_v2_pre_withdrawal_20260804(uuid,text,text,text,boolean,text)","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.partners_service_kyc_session_record_v3_pre_withdrawal_20260804(uuid,text,text,text,integer,text,timestamptz,text,text,text,integer,text)","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.guard_partners_kyc_human_review_mutation()","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.partners_kyc_rights_snapshot(uuid)","security_definer":true,"volatility":"s","access_role":"owner"},
  {"signature":"affiliate_private.partners_service_kyc_rights_get(uuid)","security_definer":true,"volatility":"s","access_role":"service_role"},
  {"signature":"public.partners_service_kyc_rights_get(uuid)","security_definer":false,"volatility":"s","access_role":"service_role"},
  {"signature":"affiliate_private.partners_service_biometric_consent_withdraw(uuid,text)","security_definer":true,"volatility":"v","access_role":"service_role"},
  {"signature":"public.partners_service_biometric_consent_withdraw(uuid,text)","security_definer":false,"volatility":"v","access_role":"service_role"},
  {"signature":"affiliate_private.partners_service_kyc_human_review_request(uuid,text,text)","security_definer":true,"volatility":"v","access_role":"service_role"},
  {"signature":"public.partners_service_kyc_human_review_request(uuid,text,text)","security_definer":false,"volatility":"v","access_role":"service_role"},
  {"signature":"affiliate_private.admin_partners_kyc_human_review_queue(integer,integer,text)","security_definer":true,"volatility":"s","access_role":"authenticated"},
  {"signature":"public.admin_partners_kyc_human_review_queue(integer,integer,text)","security_definer":false,"volatility":"s","access_role":"authenticated"},
  {"signature":"affiliate_private.admin_partners_kyc_human_review_locator(text,text,text)","security_definer":true,"volatility":"v","access_role":"authenticated"},
  {"signature":"public.admin_partners_kyc_human_review_locator(text,text,text)","security_definer":false,"volatility":"v","access_role":"authenticated"},
  {"signature":"affiliate_private.admin_partners_kyc_human_review_decide(text,text,text,timestamptz,text,text)","security_definer":true,"volatility":"v","access_role":"authenticated"},
  {"signature":"public.admin_partners_kyc_human_review_decide(text,text,text,timestamptz,text,text)","security_definer":false,"volatility":"v","access_role":"authenticated"},
  {"signature":"affiliate_private.guard_kyc_reverification_grant_mutation()","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.partners_service_kyc_prepare_reverification_once_v2(uuid,text,text,text,boolean,text)","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.admin_partners_kyc_human_review_decide_pre_reverification_grant_20260804(text,text,text,timestamptz,text,text)","security_definer":true,"volatility":"v","access_role":"owner"}
]';

select extensions.is(
  (
    with expected as (
      select *
      from pg_catalog.jsonb_to_recordset(
        current_setting('norva.partners_restore_expected_routines')::jsonb
      ) as routine(
        signature text,
        security_definer boolean,
        volatility text,
        access_role text
      )
    )
    select count(*)
    from expected
    where to_regprocedure(expected.signature) is not null
  ),
  119::bigint,
  'the restored candidate exposes every routine from all ten pending migrations'
);

select extensions.is(
  (
    with expected as (
      select *
      from pg_catalog.jsonb_to_recordset(
        current_setting('norva.partners_restore_expected_routines')::jsonb
      ) as routine(
        signature text,
        security_definer boolean,
        volatility text,
        access_role text
      )
    )
    select count(*)
    from expected
    join pg_catalog.pg_proc routine
      on routine.oid = to_regprocedure(expected.signature)
    where pg_catalog.pg_get_userbyid(routine.proowner) = current_user
  ),
  110::bigint,
  'every migrated routine retains the controlled migration executor owner'
);

select extensions.ok(
  (
    with expected as (
      select *
      from pg_catalog.jsonb_to_recordset(
        current_setting('norva.partners_restore_expected_routines')::jsonb
      ) as routine(
        signature text,
        security_definer boolean,
        volatility text,
        access_role text
      )
    )
    select count(*) = 110
      and bool_and(routine.prosecdef = expected.security_definer)
    from expected
    join pg_catalog.pg_proc routine
      on routine.oid = to_regprocedure(expected.signature)
  ),
  'privileged implementations and public invoker shims preserve their security modes'
);

select extensions.ok(
  (
    with expected as (
      select *
      from pg_catalog.jsonb_to_recordset(
        current_setting('norva.partners_restore_expected_routines')::jsonb
      ) as routine(
        signature text,
        security_definer boolean,
        volatility text,
        access_role text
      )
    )
    select count(*) = 110
      and bool_and(
        'search_path=""' = any(coalesce(routine.proconfig, '{}'::text[]))
      )
    from expected
    join pg_catalog.pg_proc routine
      on routine.oid = to_regprocedure(expected.signature)
  ),
  'every migrated routine pins an empty search_path'
);

select extensions.ok(
  (
    with expected as (
      select *
      from pg_catalog.jsonb_to_recordset(
        current_setting('norva.partners_restore_expected_routines')::jsonb
      ) as routine(
        signature text,
        security_definer boolean,
        volatility text,
        access_role text
      )
    )
    select count(*) = 110
      and bool_and(routine.provolatile = expected.volatility::"char")
    from expected
    join pg_catalog.pg_proc routine
      on routine.oid = to_regprocedure(expected.signature)
  ),
  'restored authorization reads and mutations retain their reviewed volatility'
);

select extensions.ok(
  not exists (
    with expected as (
      select *
      from pg_catalog.jsonb_to_recordset(
        current_setting('norva.partners_restore_expected_routines')::jsonb
      ) as routine(
        signature text,
        security_definer boolean,
        volatility text,
        access_role text
      )
    )
    select 1
    from expected
    join pg_catalog.pg_proc routine
      on routine.oid = to_regprocedure(expected.signature)
    cross join lateral pg_catalog.aclexplode(
      coalesce(
        routine.proacl,
        pg_catalog.acldefault('f', routine.proowner)
      )
    ) acl
    where acl.grantee = 0
      and acl.privilege_type = 'EXECUTE'
  ),
  'none of the migrated routines inherits PUBLIC execution'
);

select extensions.ok(
  (
    with allowed as (
      select *
      from pg_catalog.jsonb_to_recordset(
        current_setting('norva.partners_restore_expected_routines')::jsonb
      ) as routine(
        signature text,
        security_definer boolean,
        volatility text,
        access_role text
      )
      where access_role <> 'owner'
    )
    select count(*) = 55
      and bool_and(
        pg_catalog.has_function_privilege(
          allowed.access_role,
          to_regprocedure(allowed.signature),
          'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
          'anon',
          to_regprocedure(allowed.signature),
          'EXECUTE'
        )
        and (
          pg_catalog.has_function_privilege(
            'authenticated',
            to_regprocedure(allowed.signature),
            'EXECUTE'
          ) = (allowed.access_role = 'authenticated')
        )
        and (
          pg_catalog.has_function_privilege(
            'service_role',
            to_regprocedure(allowed.signature),
            'EXECUTE'
          ) = (allowed.access_role = 'service_role')
        )
      )
    from allowed
  ),
  'authenticated Admin and service-only Didit RPCs retain their exact API roles'
);

select extensions.ok(
  (
    with owner_only as (
      select *
      from pg_catalog.jsonb_to_recordset(
        current_setting('norva.partners_restore_expected_routines')::jsonb
      ) as routine(
        signature text,
        security_definer boolean,
        volatility text,
        access_role text
      )
      where access_role = 'owner'
    )
    select count(*) = 64
      and bool_and(
        not pg_catalog.has_function_privilege(
          'anon',
          to_regprocedure(owner_only.signature),
          'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
          'authenticated',
          to_regprocedure(owner_only.signature),
          'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
          'service_role',
          to_regprocedure(owner_only.signature),
          'EXECUTE'
        )
      )
    from owner_only
  ),
  'private predicates, helpers and trigger functions remain owner-only'
);

select extensions.ok(
  position(
    'select affiliate_private.admin_partners_capability_operators()'
    in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
      'public.admin_partners_capability_operators()'
    )))
  ) > 0
  and position(
    'select affiliate_private.admin_partners_capability_set_by_operator_key('
    in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
      'public.admin_partners_capability_set_by_operator_key(text,text,boolean,text)'
    )))
  ) > 0,
  'public capability RPCs remain thin invoker shims over guarded implementations'
);

select extensions.ok(
  position(
    'norva-partners-capability-operator:v1:'
    in pg_catalog.pg_get_functiondef(to_regprocedure(
      'affiliate_private.partners_admin_operator_key(uuid)'
    ))
  ) > 0
  and position(
    '''sha256'''
    in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
      'affiliate_private.partners_admin_operator_key(uuid)'
    )))
  ) > 0,
  'operator identifiers remain domain-separated opaque SHA-256 keys'
);

select extensions.ok(
  exists (
    select 1
    from pg_catalog.pg_trigger trigger_row
    where trigger_row.tgrelid =
        'affiliate_private.affiliate_access_requests'::regclass
      and trigger_row.tgname = 'partners_access_decision_email_enqueue'
      and trigger_row.tgfoid = to_regprocedure(
        'affiliate_private.partners_access_decision_email_enqueue()'
      )
      and trigger_row.tgenabled = 'O'
      and trigger_row.tgtype = 17
      and trigger_row.tgattr::text = (
        select attribute_row.attnum::text
        from pg_catalog.pg_attribute attribute_row
        where attribute_row.attrelid = trigger_row.tgrelid
          and attribute_row.attname = 'status'
          and not attribute_row.attisdropped
      )
      and not trigger_row.tgisinternal
  ),
  'the access-decision email trigger is enabled on the restored request table'
);

select extensions.ok(
  exists (
    select 1
    from pg_catalog.pg_trigger trigger_row
    where trigger_row.tgrelid =
        'affiliate_private.affiliate_release_gates'::regclass
      and trigger_row.tgname = 'affiliate_release_gates_activation_aal2'
      and trigger_row.tgfoid = to_regprocedure(
        'affiliate_private.guard_partners_release_gate_activation_aal2()'
      )
      and trigger_row.tgenabled = 'O'
      and trigger_row.tgtype = 19
      and trigger_row.tgattr::text = (
        select attribute_row.attnum::text
        from pg_catalog.pg_attribute attribute_row
        where attribute_row.attrelid = trigger_row.tgrelid
          and attribute_row.attname = 'satisfied'
          and not attribute_row.attisdropped
      )
      and not trigger_row.tgisinternal
  ),
  'release-gate activation is guarded by the restored before-update AAL2 trigger'
);

select extensions.ok(
  exists (
    select 1
    from pg_catalog.pg_trigger trigger_row
    where trigger_row.tgrelid =
        'affiliate_private.affiliate_access_requests'::regclass
      and trigger_row.tgname = 'partners_access_decision_email_enqueue'
      and position(
        'after update of status'
        in lower(pg_catalog.pg_get_triggerdef(trigger_row.oid))
      ) > 0
      and position(
        'old.status = ''requested'''
        in lower(pg_catalog.pg_get_triggerdef(trigger_row.oid))
      ) > 0
      and position(
        'new.status'
        in lower(pg_catalog.pg_get_triggerdef(trigger_row.oid))
      ) > 0
      and position(
        'approved'
        in lower(pg_catalog.pg_get_triggerdef(trigger_row.oid))
      ) > 0
      and position(
        'declined'
        in lower(pg_catalog.pg_get_triggerdef(trigger_row.oid))
      ) > 0
  ),
  'only requested-to-final access transitions enqueue a decision email'
);

select extensions.ok(
  position(
    'partners_access_decision:'
    in pg_catalog.pg_get_functiondef(to_regprocedure(
      'affiliate_private.partners_access_decision_email_enqueue()'
    ))
  ) > 0
  and position(
    'norva_enqueue_branded_email'
    in pg_catalog.pg_get_functiondef(to_regprocedure(
      'affiliate_private.partners_access_decision_email_enqueue()'
    ))
  ) > 0
  and position(
    'cloud_branded_email_outbox'
    in pg_catalog.pg_get_functiondef(to_regprocedure(
      'affiliate_private.partners_access_decision_email_enqueue()'
    ))
  ) > 0
  and position(
    'delivery_key = ''norva-branded-'''
    in pg_catalog.pg_get_functiondef(to_regprocedure(
      'affiliate_private.partners_access_decision_email_enqueue()'
    ))
  ) > 0
  and position(
    'Partners access decision email mismatch'
    in pg_catalog.pg_get_functiondef(to_regprocedure(
      'affiliate_private.partners_access_decision_email_enqueue()'
    ))
  ) > 0,
  'decision emails retain their transactional dedupe and frozen-envelope checks'
);

select extensions.ok(
  not exists (
    select 1
    from affiliate_private.affiliate_kyc_sessions session
    where session.status = 'pending'
      and session.provider_environment = 'legacy_unbound'
  ),
  'restored KYC data contains no unprovable pending legacy session'
);

select extensions.ok(
  not exists (
    select entry.id
    from affiliate_private.affiliate_commission_entries entry
    left join affiliate_private.affiliate_commission_postings posting
      on posting.entry_id = entry.id
      and posting.currency = entry.currency
    group by entry.id, entry.amount_minor
    having count(posting.id) < 2
      or coalesce(sum(posting.amount_minor) filter (
        where posting.direction = 'debit'
      ), 0) <> coalesce(sum(posting.amount_minor) filter (
        where posting.direction = 'credit'
      ), 0)
      or coalesce(sum(posting.amount_minor) filter (
        where posting.direction = 'debit'
      ), 0) <> entry.amount_minor
  ),
  'restored commission entries remain fully balanced regardless of row count'
);

select extensions.ok(
  to_regclass('affiliate_private.affiliate_approval_packages') is not null
  and to_regclass(
    'affiliate_private.affiliate_release_gate_approval_bindings'
  ) is not null
  and to_regclass(
    'affiliate_private.affiliate_deployment_manifests'
  ) is not null
  and to_regclass(
    'affiliate_private.affiliate_deployment_manifest_bindings'
  ) is not null
  and (
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
  and (
    select relation.relrowsecurity
    from pg_catalog.pg_class relation
    where relation.oid =
      'affiliate_private.affiliate_deployment_manifests'::regclass
  )
  and not has_table_privilege(
    'authenticated',
    'affiliate_private.affiliate_approval_packages',
    'SELECT'
  )
  and exists (
    select 1
    from pg_catalog.pg_trigger trigger_row
    where trigger_row.tgrelid =
        'affiliate_private.affiliate_approval_packages'::regclass
      and trigger_row.tgname = 'affiliate_approval_packages_append_only'
      and trigger_row.tgenabled = 'O'
      and not trigger_row.tgisinternal
  )
  and exists (
    select 1
    from pg_catalog.pg_trigger trigger_row
    where trigger_row.tgrelid =
        'affiliate_private.affiliate_deployment_manifests'::regclass
      and trigger_row.tgname =
        'affiliate_deployment_manifests_append_only'
      and trigger_row.tgenabled = 'O'
      and not trigger_row.tgisinternal
  )
  and exists (
    select 1
    from pg_catalog.pg_trigger trigger_row
    where trigger_row.tgrelid =
        'affiliate_private.affiliate_pilot_allowlist'::regclass
      and trigger_row.tgname = 'affiliate_pilot_allowlist_limit'
      and trigger_row.tgenabled = 'O'
      and not trigger_row.tgisinternal
  )
  and (
    select count(*)
    from affiliate_private.affiliate_pilot_allowlist allowlist_row
    where allowlist_row.status = 'active'
      and (
        allowlist_row.expires_at is null
        or allowlist_row.expires_at > statement_timestamp()
      )
  ) <= 50,
  'restored manifests, approvals and the transactional pilot cap remain guarded'
);

select extensions.ok(
  to_regclass(
    'affiliate_private.affiliate_biometric_consent_attestations'
  ) is not null
  and (
    select relation.relrowsecurity
    from pg_catalog.pg_class relation
    where relation.oid =
      'affiliate_private.affiliate_biometric_consent_attestations'::regclass
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
  )
  and exists (
    select 1
    from pg_catalog.pg_trigger trigger_row
    where trigger_row.tgrelid =
        'affiliate_private.affiliate_biometric_consent_attestations'::regclass
      and trigger_row.tgname = 'affiliate_biometric_consent_append_only'
      and trigger_row.tgenabled = 'O'
      and not trigger_row.tgisinternal
  )
  and position(
    'partners-biometric-consent-v1'
    in pg_catalog.pg_get_functiondef(to_regprocedure(
      'affiliate_private.partners_service_kyc_prepare_v2_pre_withdrawal_20260804(uuid,text,text,text,boolean,text)'
    ))
  ) > 0
  and position(
    'affiliate_biometric_consent_attestations'
    in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
      'affiliate_private.partners_service_kyc_prepare_v2_pre_withdrawal_20260804(uuid,text,text,text,boolean,text)'
    )))
  ) > 0
  and not has_function_privilege(
    'service_role',
    'public.partners_service_kyc_prepare(uuid,text,text,boolean,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'affiliate_private.partners_service_kyc_prepare(uuid,text,text,boolean,text)',
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
  )
  and not has_function_privilege(
    'service_role',
    'affiliate_private.partners_service_kyc_session_record(uuid,text,text,text,integer,text,timestamptz,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'affiliate_private.partners_service_kyc_session_record(uuid,text,text,text,integer,text,timestamptz,text,text,text,integer)',
    'EXECUTE'
  )
  and (
    select count(*) = 3
      and bool_and(relation.relrowsecurity)
    from unnest(array[
      'affiliate_private.affiliate_biometric_consent_withdrawals',
      'affiliate_private.affiliate_kyc_human_review_requests',
      'affiliate_private.affiliate_kyc_reverification_grants'
    ]) relation_name
    join pg_catalog.pg_class relation
      on relation.oid = to_regclass(relation_name)
  )
  and not has_table_privilege(
    'authenticated',
    'affiliate_private.affiliate_biometric_consent_withdrawals',
    'SELECT'
  )
  and not has_table_privilege(
    'service_role',
    'affiliate_private.affiliate_kyc_human_review_requests',
    'SELECT'
  )
  and not has_table_privilege(
    'service_role',
    'affiliate_private.affiliate_kyc_reverification_grants',
    'SELECT'
  )
  and exists (
    select 1
    from pg_catalog.pg_trigger trigger_row
    where trigger_row.tgrelid =
        'affiliate_private.affiliate_biometric_consent_withdrawals'::regclass
      and trigger_row.tgname = 'affiliate_biometric_withdrawal_append_only'
      and trigger_row.tgfoid = to_regprocedure(
        'affiliate_private.reject_partners_append_only_mutation()'
      )
      and trigger_row.tgenabled = 'O'
      and not trigger_row.tgisinternal
  )
  and exists (
    select 1
    from pg_catalog.pg_trigger trigger_row
    where trigger_row.tgrelid =
        'affiliate_private.affiliate_kyc_reverification_grants'::regclass
      and trigger_row.tgname = 'affiliate_kyc_reverification_grant_guard'
      and trigger_row.tgfoid = to_regprocedure(
        'affiliate_private.guard_kyc_reverification_grant_mutation()'
      )
      and trigger_row.tgenabled = 'O'
      and not trigger_row.tgisinternal
  )
  and exists (
    select 1
    from pg_catalog.pg_trigger trigger_row
    where trigger_row.tgrelid =
        'affiliate_private.affiliate_kyc_human_review_requests'::regclass
      and trigger_row.tgname = 'affiliate_kyc_human_review_guard'
      and trigger_row.tgfoid = to_regprocedure(
        'affiliate_private.guard_partners_kyc_human_review_mutation()'
      )
      and trigger_row.tgenabled = 'O'
      and not trigger_row.tgisinternal
  )
  and position(
    'affiliate_biometric_consent_withdrawals'
    in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
      'affiliate_private.partners_service_kyc_prepare_v2(uuid,text,text,text,boolean,text)'
    )))
  ) > 0
  and position(
    'partners_service_kyc_prepare_v2_pre_withdrawal_20260804'
    in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
      'affiliate_private.partners_service_kyc_prepare_v2(uuid,text,text,text,boolean,text)'
    )))
  ) > 0
  and position(
    'partners_require_capability(''risk'')'
    in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
      'affiliate_private.admin_partners_kyc_human_review_queue(integer,integer,text)'
    )))
  ) > 0
  and position(
    'partners_require_aal2'
    in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
      'affiliate_private.admin_partners_kyc_human_review_decide(text,text,text,timestamptz,text,text)'
    )))
  ) > 0
  and not has_function_privilege(
    'service_role',
    'affiliate_private.partners_service_kyc_prepare_reverification_once_v2(uuid,text,text,text,boolean,text)',
    'EXECUTE'
  )
  and position(
    'affiliate_kyc_reverification_grants'
    in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
      'affiliate_private.partners_service_kyc_prepare_v2(uuid,text,text,text,boolean,text)'
    )))
  ) > 0,
  'biometric consent, withdrawal and one-shot human review remain private, guarded and bound to KYC'
);

select extensions.ok(
  (
    select count(*) = 3
      and bool_and(relation.relrowsecurity)
    from unnest(array[
      'affiliate_private.affiliate_didit_purge_outbox',
      'affiliate_private.affiliate_didit_purge_events',
      'affiliate_private.affiliate_didit_purge_worker_state'
    ]) relation_name
    join pg_catalog.pg_class relation
      on relation.oid = to_regclass(relation_name)
  )
  and not has_table_privilege(
    'authenticated',
    'affiliate_private.affiliate_didit_purge_outbox',
    'SELECT'
  )
  and not has_table_privilege(
    'service_role',
    'affiliate_private.affiliate_didit_purge_outbox',
    'SELECT'
  )
  and exists (
    select 1
    from pg_catalog.pg_trigger trigger_row
    where trigger_row.tgrelid =
        'affiliate_private.affiliate_didit_purge_outbox'::regclass
      and trigger_row.tgname = 'affiliate_didit_purge_outbox_managed'
      and trigger_row.tgenabled = 'O'
      and not trigger_row.tgisinternal
  )
  and exists (
    select 1
    from pg_catalog.pg_trigger trigger_row
    where trigger_row.tgrelid =
        'affiliate_private.affiliate_didit_purge_events'::regclass
      and trigger_row.tgname = 'affiliate_didit_purge_events_append_only'
      and trigger_row.tgenabled = 'O'
      and not trigger_row.tgisinternal
  )
  and not exists (
    select 1
    from affiliate_private.affiliate_kyc_sessions session
    where session.provider_session_hash is not null
      and session.status <> 'pending'
      and session.provider_purge_status = 'not_required'
  )
  and not exists (
    select 1
    from affiliate_private.affiliate_didit_certification_sessions session
    where session.provider_session_hash is not null
      and session.status in ('approved', 'declined', 'expired', 'quarantined')
      and session.provider_purge_status = 'not_required'
  ),
  'durable provider deletion state remains private, guarded and terminal-session complete'
);

select extensions.ok(
  position(
    'partners_release_gate_approval_is_current'
    in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
      'affiliate_private.partners_assert_didit_certification_pre_gate()'
    )))
  ) > 0
  and position(
    'and gate.satisfied'
    in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
      'affiliate_private.partners_assert_didit_certification_pre_gate()'
    )))
  ) = 0
  and position(
    'admin_partners_revolut_payout_status_approval_registry'
    in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
      'public.admin_partners_revolut_payout_status()'
    )))
  ) > 0
  and position(
    'partners_didit_purge_coverage_ready'
    in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
      'affiliate_private.partners_approval_package_is_current(uuid,text)'
    )))
  ) > 0,
  'restored Didit, purge and Revolut consumers use effective approval evidence'
);

select * from extensions.finish();

rollback;
