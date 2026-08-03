begin;

create extension if not exists pgtap with schema extensions;

select extensions.plan(15);

select extensions.is(
  (
    with expected(signature) as (
      values
        ('affiliate_private.partners_actor_is_live_admin(text)'),
        ('affiliate_private.partners_has_capability(text)'),
        ('affiliate_private.partners_can_manage_capabilities()'),
        ('affiliate_private.partners_is_release_manager()'),
        ('affiliate_private.partners_require_aal2(text)'),
        ('affiliate_private.partners_admin_operator_key(uuid)'),
        ('affiliate_private.admin_partners_capability_operators()'),
        ('affiliate_private.admin_partners_capability_set_by_operator_key(text,text,boolean,text)'),
        ('affiliate_private.admin_partners_capability_set(uuid,text,boolean,text)'),
        ('public.admin_partners_capability_operators()'),
        ('public.admin_partners_capability_set_by_operator_key(text,text,boolean,text)'),
        ('affiliate_private.partners_access_decision_email_enqueue()')
    )
    select count(*)
    from expected
    where to_regprocedure(expected.signature) is not null
  ),
  12::bigint,
  'the restored candidate exposes every routine from both pending migrations'
);

select extensions.is(
  (
    with expected(signature) as (
      values
        ('affiliate_private.partners_actor_is_live_admin(text)'),
        ('affiliate_private.partners_has_capability(text)'),
        ('affiliate_private.partners_can_manage_capabilities()'),
        ('affiliate_private.partners_is_release_manager()'),
        ('affiliate_private.partners_require_aal2(text)'),
        ('affiliate_private.partners_admin_operator_key(uuid)'),
        ('affiliate_private.admin_partners_capability_operators()'),
        ('affiliate_private.admin_partners_capability_set_by_operator_key(text,text,boolean,text)'),
        ('affiliate_private.admin_partners_capability_set(uuid,text,boolean,text)'),
        ('public.admin_partners_capability_operators()'),
        ('public.admin_partners_capability_set_by_operator_key(text,text,boolean,text)'),
        ('affiliate_private.partners_access_decision_email_enqueue()')
    )
    select count(*)
    from expected
    join pg_catalog.pg_proc routine
      on routine.oid = to_regprocedure(expected.signature)
    where pg_catalog.pg_get_userbyid(routine.proowner) = 'supabase_admin'
  ),
  12::bigint,
  'every migrated routine retains the controlled supabase_admin owner'
);

select extensions.ok(
  (
    with expected(signature, security_definer) as (
      values
        ('affiliate_private.partners_actor_is_live_admin(text)', true),
        ('affiliate_private.partners_has_capability(text)', true),
        ('affiliate_private.partners_can_manage_capabilities()', true),
        ('affiliate_private.partners_is_release_manager()', true),
        ('affiliate_private.partners_require_aal2(text)', true),
        ('affiliate_private.partners_admin_operator_key(uuid)', false),
        ('affiliate_private.admin_partners_capability_operators()', true),
        ('affiliate_private.admin_partners_capability_set_by_operator_key(text,text,boolean,text)', true),
        ('affiliate_private.admin_partners_capability_set(uuid,text,boolean,text)', true),
        ('public.admin_partners_capability_operators()', false),
        ('public.admin_partners_capability_set_by_operator_key(text,text,boolean,text)', false),
        ('affiliate_private.partners_access_decision_email_enqueue()', true)
    )
    select count(*) = 12
      and bool_and(routine.prosecdef = expected.security_definer)
    from expected
    join pg_catalog.pg_proc routine
      on routine.oid = to_regprocedure(expected.signature)
  ),
  'privileged implementations and public invoker shims preserve their security modes'
);

select extensions.ok(
  (
    with expected(signature) as (
      values
        ('affiliate_private.partners_actor_is_live_admin(text)'),
        ('affiliate_private.partners_has_capability(text)'),
        ('affiliate_private.partners_can_manage_capabilities()'),
        ('affiliate_private.partners_is_release_manager()'),
        ('affiliate_private.partners_require_aal2(text)'),
        ('affiliate_private.partners_admin_operator_key(uuid)'),
        ('affiliate_private.admin_partners_capability_operators()'),
        ('affiliate_private.admin_partners_capability_set_by_operator_key(text,text,boolean,text)'),
        ('affiliate_private.admin_partners_capability_set(uuid,text,boolean,text)'),
        ('public.admin_partners_capability_operators()'),
        ('public.admin_partners_capability_set_by_operator_key(text,text,boolean,text)'),
        ('affiliate_private.partners_access_decision_email_enqueue()')
    )
    select count(*) = 12
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
    with expected(signature, volatility) as (
      values
        ('affiliate_private.partners_actor_is_live_admin(text)', 's'::"char"),
        ('affiliate_private.partners_has_capability(text)', 's'::"char"),
        ('affiliate_private.partners_can_manage_capabilities()', 's'::"char"),
        ('affiliate_private.partners_is_release_manager()', 's'::"char"),
        ('affiliate_private.partners_require_aal2(text)', 's'::"char"),
        ('affiliate_private.partners_admin_operator_key(uuid)', 'i'::"char"),
        ('affiliate_private.admin_partners_capability_operators()', 's'::"char"),
        ('affiliate_private.admin_partners_capability_set_by_operator_key(text,text,boolean,text)', 'v'::"char"),
        ('affiliate_private.admin_partners_capability_set(uuid,text,boolean,text)', 'v'::"char"),
        ('public.admin_partners_capability_operators()', 's'::"char"),
        ('public.admin_partners_capability_set_by_operator_key(text,text,boolean,text)', 'v'::"char"),
        ('affiliate_private.partners_access_decision_email_enqueue()', 'v'::"char")
    )
    select count(*) = 12
      and bool_and(routine.provolatile = expected.volatility)
    from expected
    join pg_catalog.pg_proc routine
      on routine.oid = to_regprocedure(expected.signature)
  ),
  'restored authorization reads and mutations retain their reviewed volatility'
);

select extensions.ok(
  not exists (
    with expected(signature) as (
      values
        ('affiliate_private.partners_actor_is_live_admin(text)'),
        ('affiliate_private.partners_has_capability(text)'),
        ('affiliate_private.partners_can_manage_capabilities()'),
        ('affiliate_private.partners_is_release_manager()'),
        ('affiliate_private.partners_require_aal2(text)'),
        ('affiliate_private.partners_admin_operator_key(uuid)'),
        ('affiliate_private.admin_partners_capability_operators()'),
        ('affiliate_private.admin_partners_capability_set_by_operator_key(text,text,boolean,text)'),
        ('affiliate_private.admin_partners_capability_set(uuid,text,boolean,text)'),
        ('public.admin_partners_capability_operators()'),
        ('public.admin_partners_capability_set_by_operator_key(text,text,boolean,text)'),
        ('affiliate_private.partners_access_decision_email_enqueue()')
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
    with allowed(signature) as (
      values
        ('affiliate_private.admin_partners_capability_operators()'),
        ('affiliate_private.admin_partners_capability_set_by_operator_key(text,text,boolean,text)'),
        ('affiliate_private.admin_partners_capability_set(uuid,text,boolean,text)'),
        ('public.admin_partners_capability_operators()'),
        ('public.admin_partners_capability_set_by_operator_key(text,text,boolean,text)')
    )
    select count(*) = 5
      and bool_and(
        pg_catalog.has_function_privilege(
          'authenticated',
          to_regprocedure(allowed.signature),
          'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
          'anon',
          to_regprocedure(allowed.signature),
          'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
          'service_role',
          to_regprocedure(allowed.signature),
          'EXECUTE'
        )
      )
    from allowed
  ),
  'only authenticated Admin calls can enter the audited capability mutations'
);

select extensions.ok(
  (
    with owner_only(signature) as (
      values
        ('affiliate_private.partners_actor_is_live_admin(text)'),
        ('affiliate_private.partners_has_capability(text)'),
        ('affiliate_private.partners_can_manage_capabilities()'),
        ('affiliate_private.partners_is_release_manager()'),
        ('affiliate_private.partners_require_aal2(text)'),
        ('affiliate_private.partners_admin_operator_key(uuid)'),
        ('affiliate_private.partners_access_decision_email_enqueue()')
    )
    select count(*) = 7
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
  'private predicates, opaque-key helper and email trigger remain owner-only'
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
