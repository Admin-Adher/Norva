begin;

create extension if not exists pgtap with schema extensions;

select extensions.plan(15);

-- One immutable catalogue keeps all three pending migrations under the same
-- existence, ownership, security, volatility and ACL assertions without
-- creating any object in the restored database.
set local norva.partners_restore_expected_routines = '[
  {"signature":"affiliate_private.partners_actor_is_live_admin(text)","security_definer":true,"volatility":"s","access_role":"owner"},
  {"signature":"affiliate_private.partners_has_capability(text)","security_definer":true,"volatility":"s","access_role":"owner"},
  {"signature":"affiliate_private.partners_can_manage_capabilities()","security_definer":true,"volatility":"s","access_role":"owner"},
  {"signature":"affiliate_private.partners_is_release_manager()","security_definer":true,"volatility":"s","access_role":"owner"},
  {"signature":"affiliate_private.partners_require_aal2(text)","security_definer":true,"volatility":"s","access_role":"owner"},
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
  {"signature":"affiliate_private.partners_service_kyc_certification_webhook_apply(text,text,text,integer,text,timestamptz,integer,text,boolean,boolean,boolean,text,text,text)","security_definer":true,"volatility":"v","access_role":"service_role"},
  {"signature":"public.admin_partners_kyc_certification_prepare(text,text,boolean,text,text,text)","security_definer":false,"volatility":"v","access_role":"authenticated"},
  {"signature":"public.admin_partners_kyc_certification_resume()","security_definer":false,"volatility":"v","access_role":"authenticated"},
  {"signature":"public.admin_partners_kyc_certification_status()","security_definer":false,"volatility":"v","access_role":"authenticated"},
  {"signature":"public.partners_service_kyc_certification_create_claim(text)","security_definer":false,"volatility":"v","access_role":"service_role"},
  {"signature":"public.partners_service_kyc_certification_binding_match(text,text)","security_definer":false,"volatility":"v","access_role":"service_role"},
  {"signature":"public.partners_service_kyc_certification_session_record(text,text,text,integer,text,text,text,integer)","security_definer":false,"volatility":"v","access_role":"service_role"},
  {"signature":"public.partners_service_kyc_certification_webhook_apply(text,text,text,integer,text,timestamptz,integer,text,boolean,boolean,boolean,text,text,text)","security_definer":false,"volatility":"v","access_role":"service_role"}
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
  35::bigint,
  'the restored candidate exposes every routine from all three pending migrations'
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
  35::bigint,
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
    select count(*) = 35
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
    select count(*) = 35
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
    select count(*) = 35
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
    select count(*) = 19
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
    select count(*) = 16
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

select * from extensions.finish();

rollback;
