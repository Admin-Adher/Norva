\set ON_ERROR_STOP on

begin;
set transaction read only;

do $partners_restore_structure$
declare
  v_name text;
  v_missing text;
begin
  if to_regnamespace('affiliate_private') is null then
    raise exception 'restore omitted schema affiliate_private';
  end if;
  if to_regclass('public.cloud_revenuecat_transfer_events') is null then
    raise exception 'restore omitted public.cloud_revenuecat_transfer_events';
  end if;
  if not (
    select c.relrowsecurity
    from pg_catalog.pg_class c
    where c.oid = 'public.cloud_revenuecat_transfer_events'::regclass
  ) then
    raise exception
      'restored cloud_revenuecat_transfer_events without RLS';
  end if;
  if has_table_privilege(
    'anon',
    'public.cloud_revenuecat_transfer_events',
    'SELECT'
  ) or has_table_privilege(
    'authenticated',
    'public.cloud_revenuecat_transfer_events',
    'SELECT'
  ) then
    raise exception
      'RevenueCat TRANSFER inbox became client-readable';
  end if;

  foreach v_name in array array[
    'affiliate_accounts',
    'affiliate_links',
    'affiliate_events',
    'affiliate_kyc_sessions',
    'affiliate_kyc_webhook_events',
    'affiliate_didit_session_registry',
    'affiliate_didit_certification_sessions',
    'affiliate_didit_certification_events',
    'affiliate_link_claims',
    'affiliate_attributions',
    'affiliate_financial_facts',
    'affiliate_financial_fact_observations',
    'affiliate_financial_fact_conflicts',
    'affiliate_revolut_dispute_won_jobs',
    'affiliate_revolut_dispute_won_conflicts',
    'affiliate_commission_entries',
    'affiliate_commission_postings',
    'affiliate_payout_cycles',
    'affiliate_payout_items',
    'affiliate_revolut_reference_allocations',
    'affiliate_revolut_beneficiary_bindings',
    'affiliate_revolut_beneficiary_binding_tickets',
    'affiliate_revolut_beneficiary_revocations',
    'affiliate_revolut_manual_batches',
    'affiliate_revolut_payout_executions',
    'affiliate_revolut_api_worker_lease',
    'affiliate_revolut_payout_events',
    'affiliate_revolut_statement_tickets',
    'affiliate_revolut_statement_imports',
    'affiliate_revolut_statement_rows',
    'affiliate_revolut_manual_reviews',
    'affiliate_revolut_manual_decisions',
    'affiliate_revolut_manual_cancellations',
    'affiliate_revolut_manual_unmapped_requests',
    'affiliate_revolut_manual_unmapped_releases',
    'affiliate_revolut_return_observations',
    'affiliate_revolut_return_reviews',
    'affiliate_revolut_return_decisions',
    'affiliate_revolut_late_completion_observations',
    'affiliate_revolut_late_completion_reviews',
    'affiliate_revolut_late_completion_decisions',
    'affiliate_revolut_reconciliation_incidents',
    'affiliate_revolut_reconciliation_incident_reviews',
    'affiliate_revolut_transaction_aliases',
    'affiliate_revolut_reconciliation_incident_decisions',
    'affiliate_worker_heartbeats'
  ]
  loop
    if to_regclass('affiliate_private.' || v_name) is null then
      raise exception 'restore omitted affiliate_private.%', v_name;
    end if;
  end loop;

  select string_agg(c.relname, ', ' order by c.relname)
  into v_missing
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'affiliate_private'
    and c.relkind in ('r', 'p')
    and not c.relrowsecurity;

  if v_missing is not null then
    raise exception
      'restored affiliate_private tables without RLS: %',
      v_missing;
  end if;

  -- `authenticated` intentionally has schema USAGE so the explicitly
  -- allowlisted SECURITY DEFINER admin shims can resolve their private
  -- implementation. USAGE alone does not grant table or sequence access.
  if pg_catalog.has_schema_privilege(
    'anon',
    'affiliate_private',
    'USAGE'
  ) then
    raise exception
      'affiliate_private schema became usable by anon';
  end if;
  if not pg_catalog.has_schema_privilege(
      'authenticated',
      'affiliate_private',
      'USAGE'
    )
    or not pg_catalog.has_schema_privilege(
      'service_role',
      'affiliate_private',
      'USAGE'
    )
  then
    raise exception
      'affiliate_private schema lost required authenticated or service_role USAGE';
  end if;

  select string_agg(
    role_name || ':' || object_name,
    ', '
    order by role_name, object_name
  )
  into v_missing
  from (
    select
      roles.role_name,
      format('%I.%I', n.nspname, c.relname) as object_name
    from (
      values
        ('anon'::text),
        ('authenticated'::text),
        ('service_role'::text)
    ) roles(role_name)
    join pg_catalog.pg_class c
      on c.relkind in ('r', 'p', 'v', 'm', 'f')
    join pg_catalog.pg_namespace n
      on n.oid = c.relnamespace
      and n.nspname = 'affiliate_private'
    where pg_catalog.has_table_privilege(
      roles.role_name,
      c.oid,
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
    )
  ) exposed_tables;

  if v_missing is not null then
    raise exception
      'API roles gained direct affiliate_private table privileges: %',
      v_missing;
  end if;

  select string_agg(
    role_name || ':' || object_name,
    ', '
    order by role_name, object_name
  )
  into v_missing
  from (
    select
      roles.role_name,
      format('%I.%I', n.nspname, c.relname) as object_name
    from (
      values
        ('anon'::text),
        ('authenticated'::text),
        ('service_role'::text)
    ) roles(role_name)
    join pg_catalog.pg_class c
      on c.relkind = 'S'
    join pg_catalog.pg_namespace n
      on n.oid = c.relnamespace
      and n.nspname = 'affiliate_private'
    where pg_catalog.has_sequence_privilege(
      roles.role_name,
      c.oid,
      'USAGE,SELECT,UPDATE'
    )
  ) exposed_sequences;

  if v_missing is not null then
    raise exception
      'API roles gained direct affiliate_private sequence privileges: %',
      v_missing;
  end if;
end;
$partners_restore_structure$;

do $partners_restore_routines$
declare
  v_signature text;
  v_unexpected text;
  v_definition text;
begin
  foreach v_signature in array array[
    'public.partners_service_dashboard(uuid,integer,text,text)',
    'public.partners_service_referral_claim(uuid,text,text)',
    'public.partners_service_kyc_session_record(uuid,text,text,text,integer,text,timestamp with time zone,text,text,text,integer)',
    'public.partners_service_kyc_webhook_apply(text,text,text,integer,text,timestamp with time zone,integer,text,boolean,boolean,boolean,text,text,text)',
    'public.partners_service_kyc_binding_recover(integer)',
    'public.admin_partners_kyc_certification_prepare(text,text,boolean,text,text,text)',
    'public.admin_partners_kyc_certification_resume()',
    'public.admin_partners_kyc_certification_status()',
    'public.partners_service_kyc_certification_create_claim(text)',
    'public.partners_service_kyc_certification_binding_match(text,text)',
    'public.partners_service_kyc_certification_session_record(text,text,text,integer,text,text,text,integer)',
    'public.partners_service_kyc_certification_webhook_apply(text,text,text,integer,text,timestamp with time zone,integer,text,boolean,boolean,boolean,text,text,text)',
    'public.partners_worker_shadow_reconcile(text,timestamp with time zone,timestamp with time zone,boolean)',
    'public.admin_partners_payout_route_set(text,text,text,text,text,text)',
    'public.admin_partners_revolut_profile_set(uuid,text,text,text,text,text,text)',
    'public.admin_partners_revolut_profile_hold(uuid,text,text,text,text)',
    'public.admin_partners_revolut_profile_status(uuid)',
    'public.admin_partners_revolut_beneficiary_binding_authorize(uuid,text,text,text,text,integer,text,text)',
    'public.partners_service_revolut_beneficiary_binding_propose(text,text,text)',
    'public.admin_partners_revolut_beneficiary_binding_verify(text,text,text)',
    'public.admin_partners_revolut_beneficiary_binding_reject(text,text,text)',
    'public.admin_partners_revolut_beneficiary_binding_revoke(text,text,text)',
    'public.admin_partners_revolut_manual_batch_prepare(text,text,text)',
    'public.admin_partners_revolut_manual_batch_payload(text)',
    'public.admin_partners_revolut_manual_batch_mark_exported(text,text,text,text,text)',
    'public.admin_partners_revolut_manual_batch_export(text,text,text)',
    'public.admin_partners_revolut_manual_batch_mark_submitted(text,jsonb,text,text)',
    'public.admin_partners_revolut_statement_ingest(text,date,date,text,jsonb)',
    'public.admin_partners_revolut_statement_authorize()',
    'public.admin_partners_revolut_statement_context()',
    'public.admin_partners_revolut_reconciliation_review(text,text,text)',
    'public.admin_partners_revolut_reconciliation_decide(text,text,text,text)',
    'public.admin_partners_revolut_payout_status()',
    'public.admin_partners_revolut_manual_batches(integer,integer,text)',
    'public.admin_partners_revolut_reconciliation_queue(integer,integer,text)',
    'public.partners_service_revolut_statement_ingest(text,date,date,text,jsonb,text,text)',
    'public.admin_partners_revolut_manual_control_reject(text,text,text)',
    'public.admin_partners_revolut_manual_controls_queue(integer,integer,text)',
    'public.admin_partners_revolut_manual_batch_cancel(text,text,text,timestamp with time zone,text,text)',
    'public.admin_partners_revolut_manual_batch_release_unmapped(text,jsonb,text,timestamp with time zone,text,text)',
    'public.admin_partners_revolut_reconciliation_incident_review(text,text,text,text,timestamp with time zone,text,text)',
    'public.admin_partners_revolut_reconciliation_incident_decide(text,text,text,timestamp with time zone,text,text)',
    'public.admin_partners_revolut_reconciliation_incidents(integer,integer,text)',
    'public.admin_partners_revolut_return_review(text,text,text,text)',
    'public.admin_partners_revolut_return_decide(text,text,text,text)',
    'public.admin_partners_revolut_return_queue(integer,integer,text)',
    'public.admin_partners_revolut_late_completion_review(text,text,text,text)',
    'public.admin_partners_revolut_late_completion_decide(text,text,text,text)',
    'public.admin_partners_revolut_late_completion_queue(integer,integer,text)',
    'public.partners_worker_revolut_global_lease_acquire(text,text,integer)',
    'public.partners_worker_revolut_global_lease_renew(text,text,bigint,integer)',
    'public.partners_worker_revolut_global_lease_release(text,text,bigint)',
    'public.partners_worker_revolut_payout_lease(text,text,bigint,integer,integer)',
    'public.partners_worker_revolut_payout_retry(text,text,text,bigint,text,boolean)',
    'public.partners_worker_revolut_payout_observe(text,text,text,text,timestamp with time zone,text,text,bigint)',
    'public.admin_partners_analytics(integer)',
    'public.admin_partners_monitoring()',
    'public.record_revenuecat_entitlement_transfer(text,timestamp with time zone,text,text,uuid,uuid[],integer,integer,text,text,boolean,boolean)',
    'public.apply_revenuecat_entitlement_transfer(text,timestamp with time zone,text,text,uuid,uuid[],integer,integer,text,text,jsonb)',
    'public.revenuecat_transfer_retry_jobs_lease(text,text,integer,integer)',
    'public.revenuecat_transfer_retry_job_complete(text,text,text,text,integer)',
    'public.revenuecat_transfer_retry_job_defer(text,text,text,text,integer)',
    'public.revenuecat_transfer_partner_jobs_lease(text,text,integer,integer)',
    'public.revenuecat_transfer_partner_job_complete(text,text,text,text,text)',
    'public.partners_worker_revolut_dispute_won_enqueue(text,text,text,text,uuid,text,bigint,timestamp with time zone)',
    'public.partners_worker_revolut_dispute_won_jobs_lease(text,text,integer,integer)',
    'public.partners_worker_revolut_dispute_won_job_complete(text,text,text,text,text)'
  ]
  loop
    if to_regprocedure(v_signature) is null then
      raise exception 'restore omitted routine %', v_signature;
    end if;
    if v_signature like 'public.%revenuecat_transfer%'
       or v_signature like 'public.%revenuecat_entitlement_transfer%'
       or v_signature like 'public.partners_service_kyc_%'
       or v_signature like
         'public.partners_worker_revolut_dispute_won_%'
       or v_signature like
         'public.partners_service_revolut_statement_%'
       or v_signature =
         'public.partners_service_revolut_beneficiary_binding_propose(text,text,text)'
       or v_signature like
         'public.partners_worker_revolut_global_%'
       or v_signature like
         'public.partners_worker_revolut_payout_%' then
      if has_function_privilege('anon', v_signature, 'EXECUTE')
         or has_function_privilege('authenticated', v_signature, 'EXECUTE')
         or not has_function_privilege('service_role', v_signature, 'EXECUTE')
      then
        raise exception
          'invalid service-only Partners routine privileges for %',
          v_signature;
      end if;
    elsif v_signature = any (array[
      'public.admin_partners_revolut_profile_set(uuid,text,text,text,text,text,text)',
      'public.admin_partners_revolut_beneficiary_binding_authorize(uuid,text,text,text,text,integer,text,text)',
      'public.admin_partners_revolut_manual_batch_payload(text)',
      'public.admin_partners_revolut_manual_batch_mark_exported(text,text,text,text,text)',
      'public.admin_partners_revolut_statement_ingest(text,date,date,text,jsonb)'
    ]::text[])
    then
      if has_function_privilege('anon', v_signature, 'EXECUTE')
         or has_function_privilege(
           'authenticated',
           v_signature,
           'EXECUTE'
         )
         or has_function_privilege('service_role', v_signature, 'EXECUTE')
      then
        raise exception
          'retired split/manual Revolut routine remains callable: %',
          v_signature;
      end if;
    elsif v_signature like 'public.admin_partners_revolut_%'
      or v_signature like 'public.admin_partners_payout_route_%'
      or v_signature like 'public.admin_partners_kyc_certification_%'
    then
      if has_function_privilege('anon', v_signature, 'EXECUTE')
         or not has_function_privilege(
           'authenticated',
           v_signature,
           'EXECUTE'
         )
         or has_function_privilege('service_role', v_signature, 'EXECUTE')
      then
        raise exception
          'invalid Partners Finance admin privileges for %',
          v_signature;
      end if;
    end if;
  end loop;

  if has_function_privilege(
      'service_role',
      'public.partners_service_kyc_session_record(uuid,text,text,text,integer,text,timestamp with time zone,text)',
      'EXECUTE'
    )
    or has_function_privilege(
      'service_role',
      'public.partners_service_kyc_webhook_apply(text,text,text,integer,text,timestamp with time zone,integer,text,boolean,boolean,boolean,text)',
      'EXECUTE'
    )
  then
    raise exception
      'restored pre-binding Didit service overload remains callable';
  end if;

  foreach v_signature in array array[
    'affiliate_private.admin_partners_payout_route_set(text,text,text,text,text,text)',
    'affiliate_private.admin_partners_revolut_profile_set(uuid,text,text,text,text,text,text)',
    'affiliate_private.admin_partners_revolut_profile_hold(uuid,text,text,text,text)',
    'affiliate_private.admin_partners_revolut_profile_status(uuid)',
    'affiliate_private.admin_partners_revolut_beneficiary_binding_authorize(uuid,text,text,text,text,integer,text,text)',
    'affiliate_private.admin_partners_revolut_beneficiary_binding_verify(text,text,text)',
    'affiliate_private.admin_partners_revolut_beneficiary_binding_reject(text,text,text)',
    'affiliate_private.admin_partners_revolut_beneficiary_binding_revoke(text,text,text)',
    'affiliate_private.admin_partners_revolut_manual_batch_prepare(text,text,text)',
    'affiliate_private.admin_partners_revolut_manual_batch_mark_exported(text,text,text,text,text)',
    'affiliate_private.admin_partners_revolut_manual_batch_export(text,text,text)',
    'affiliate_private.admin_partners_revolut_manual_batch_mark_submitted(text,jsonb,text,text)',
    'affiliate_private.admin_partners_revolut_statement_authorize()',
    'affiliate_private.admin_partners_revolut_statement_context()',
    'affiliate_private.admin_partners_revolut_reconciliation_review(text,text,text)',
    'affiliate_private.admin_partners_revolut_reconciliation_decide(text,text,text,text)',
    'affiliate_private.admin_partners_revolut_manual_control_reject(text,text,text)',
    'affiliate_private.admin_partners_revolut_manual_controls_queue(integer,integer,text)',
    'affiliate_private.admin_partners_revolut_manual_batch_cancel(text,text,text,timestamp with time zone,text,text)',
    'affiliate_private.admin_partners_revolut_manual_batch_release_unmapped(text,jsonb,text,timestamp with time zone,text,text)',
    'affiliate_private.admin_partners_revolut_reconciliation_incident_review(text,text,text,text,timestamp with time zone,text,text)',
    'affiliate_private.admin_partners_revolut_reconciliation_incident_decide(text,text,text,timestamp with time zone,text,text)',
    'affiliate_private.admin_partners_revolut_reconciliation_incidents(integer,integer,text)',
    'affiliate_private.admin_partners_revolut_return_review(text,text,text,text)',
    'affiliate_private.admin_partners_revolut_return_decide(text,text,text,text)',
    'affiliate_private.admin_partners_revolut_return_queue(integer,integer,text)',
    'affiliate_private.admin_partners_revolut_late_completion_review(text,text,text,text)',
    'affiliate_private.admin_partners_revolut_late_completion_decide(text,text,text,text)',
    'affiliate_private.admin_partners_revolut_late_completion_queue(integer,integer,text)'
  ]
  loop
    if position(
        'auth.jwt()' in lower(pg_get_functiondef(v_signature::regprocedure))
      ) = 0
      or position(
        '''aal2''' in lower(pg_get_functiondef(v_signature::regprocedure))
      ) = 0
    then
      raise exception
        'restored Revolut manual Finance mutation lost AAL2: %',
        v_signature;
    end if;
  end loop;

  foreach v_signature in array array[
    'affiliate_private.partners_service_kyc_certification_create_claim(text)',
    'affiliate_private.partners_service_kyc_certification_binding_match(text,text)',
    'affiliate_private.partners_service_kyc_certification_session_record(text,text,text,integer,text,text,text,integer)',
    'affiliate_private.partners_service_kyc_certification_webhook_apply(text,text,text,integer,text,timestamp with time zone,integer,text,boolean,boolean,boolean,text,text,text)',
    'affiliate_private.partners_service_revolut_beneficiary_binding_propose(text,text,text)',
    'affiliate_private.partners_service_revolut_statement_ingest(text,date,date,text,jsonb,text,text)',
    'affiliate_private.partners_worker_revolut_global_lease_acquire(text,text,integer)',
    'affiliate_private.partners_worker_revolut_global_lease_renew(text,text,bigint,integer)',
    'affiliate_private.partners_worker_revolut_global_lease_release(text,text,bigint)',
    'affiliate_private.partners_worker_revolut_payout_lease(text,text,bigint,integer,integer)',
    'affiliate_private.partners_worker_revolut_payout_retry(text,text,text,bigint,text,boolean)',
    'affiliate_private.partners_worker_revolut_payout_observe(text,text,text,text,timestamp with time zone,text,text,bigint)'
  ]
  loop
    if has_function_privilege('anon', v_signature, 'EXECUTE')
      or has_function_privilege('authenticated', v_signature, 'EXECUTE')
      or not has_function_privilege('service_role', v_signature, 'EXECUTE')
    then
      raise exception
        'invalid private Partners service routine privileges for %',
        v_signature;
    end if;
  end loop;

  v_definition := pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_kyc_certification_create_claim(text)'::regprocedure
  );
  if position(
      'partners_assert_didit_certification_pre_gate' in lower(v_definition)
    ) = 0
    or position('for update' in lower(v_definition)) = 0
    or position('provider_create_dispatched_at' in lower(v_definition)) = 0
    or position('kyc_certification_create_claimed' in lower(v_definition)) = 0
  then
    raise exception
      'restored Didit certification create claim lost its one-way locked contract';
  end if;

  v_definition := pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_kyc_certification_binding_match(text,text)'::regprocedure
  );
  if position(
      'partners_assert_didit_certification_pre_gate' in lower(v_definition)
    ) = 0
    or position('provider_session_hash' in lower(v_definition)) = 0
    or position('v_session.status <> ''pending''' in lower(v_definition)) = 0
    or position('kyc_certification_binding_matched' in lower(v_definition)) = 0
  then
    raise exception
      'restored Didit certification binding matcher lost its fail-closed hash contract';
  end if;

  v_definition := pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_kyc_certification_session_record(text,text,text,integer,text,text,text,integer)'::regprocedure
  );
  if position(
      'partners_assert_didit_certification_pre_gate' in lower(v_definition)
    ) = 0
    or position(
      'provider_create_dispatched_at is null' in lower(v_definition)
    ) = 0
  then
    raise exception
      'restored Didit certification session recorder lost its claim or post-provider pre-gate recheck';
  end if;

  v_definition := pg_catalog.pg_get_functiondef(
    'affiliate_private.guard_didit_certification_session_transition()'::regprocedure
  );
  if position(
      'provider dispatch is immutable' in lower(v_definition)
    ) = 0
    or position('old.status <> ''reserved''' in lower(v_definition)) = 0
    or position('new.status <> ''reserved''' in lower(v_definition)) = 0
    or position('new.provider_session_hash is not null' in lower(v_definition)) = 0
  then
    raise exception
      'restored Didit certification transition guard lost dispatch immutability';
  end if;

  v_definition := pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_assert_didit_certification_pre_gate()'::regprocedure
  );
  if position('for share' in lower(v_definition)) = 0
    or position('privacy_approved' in lower(v_definition)) = 0
    or position('partners_enabled' in lower(v_definition)) = 0
  then
    raise exception
      'restored Didit certification pre-gate assertion lost its atomic row locks';
  end if;

  v_definition := pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_require_didit_certification_operator(text)'::regprocedure
  );
  if position('partners_require_didit_certification_observer' in lower(v_definition)) = 0
    or position('partners_require_aal2' in lower(v_definition)) = 0
    or position('auth.jwt() ->> ''iat''' in lower(v_definition)) = 0
    or position('10 minutes' in lower(v_definition)) = 0
    or position('partners_assert_didit_certification_pre_gate' in lower(v_definition)) = 0
  then
    raise exception
      'restored Didit certification operator lost live Admin/Risk, AAL2, fresh-JWT or pre-gate enforcement';
  end if;

  if to_regprocedure(
      'affiliate_private.partners_didit_certification_key(text,uuid)'
    ) is null
  then
    raise exception
      'restore omitted the deterministic Didit certification key helper';
  end if;
  if has_function_privilege(
      'anon',
      'affiliate_private.partners_didit_certification_key(text,uuid)',
      'EXECUTE'
    )
    or has_function_privilege(
      'authenticated',
      'affiliate_private.partners_didit_certification_key(text,uuid)',
      'EXECUTE'
    )
    or has_function_privilege(
      'service_role',
      'affiliate_private.partners_didit_certification_key(text,uuid)',
      'EXECUTE'
    )
  then
    raise exception
      'restored deterministic Didit certification key helper became API-callable';
  end if;
  v_definition := pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_didit_certification_key(text,uuid)'::regprocedure
  );
  if position('p_operator_hash' in lower(v_definition)) = 0
    or position('p_session_id' in lower(v_definition)) = 0
    or position(
      'norva:didit:certification-key-material:v2' in lower(v_definition)
    ) = 0
  then
    raise exception
      'restored deterministic Didit certification key lost immutable reservation identity';
  end if;

  v_definition := pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_kyc_certification_prepare(text,text,boolean,text,text,text)'::regprocedure
  );
  if position('partners_didit_certification_key' in lower(v_definition)) = 0
    or position('v_existing.id' in lower(v_definition)) = 0
    or position(
      'v_existing.status not in (''reserved'', ''pending'')'
      in lower(v_definition)
    ) = 0
  then
    raise exception
      'restored Didit certification prepare lost deterministic or resumable replay enforcement';
  end if;

  if to_regprocedure(
      'affiliate_private.admin_partners_kyc_certification_resume()'
    ) is null
  then
    raise exception
      'restore omitted the private Didit certification resume routine';
  end if;
  if has_function_privilege(
      'anon',
      'affiliate_private.admin_partners_kyc_certification_resume()',
      'EXECUTE'
    )
    or not has_function_privilege(
      'authenticated',
      'affiliate_private.admin_partners_kyc_certification_resume()',
      'EXECUTE'
    )
    or has_function_privilege(
      'service_role',
      'affiliate_private.admin_partners_kyc_certification_resume()',
      'EXECUTE'
    )
  then
    raise exception
      'restored private Didit certification resume has invalid privileges';
  end if;
  v_definition := pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_kyc_certification_resume()'::regprocedure
  );
  if position(
      'partners_require_didit_certification_operator' in lower(v_definition)
    ) = 0
    or position('partners_didit_certification_key' in lower(v_definition)) = 0
    or position('''reserved'', ''pending''' in lower(v_definition)) = 0
  then
    raise exception
      'restored Didit certification resume lost its guarded resumable-state contract';
  end if;

  v_definition := pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_kyc_certification_status()'::regprocedure
  );
  if position(
      'partners_require_didit_certification_observer' in lower(v_definition)
    ) = 0
    or position('provider_environment' in lower(v_definition)) = 0
    or position(
      'partners_didit_certification_public_reason' in lower(v_definition)
    ) = 0
  then
    raise exception
      'restored Didit certification status lost its bounded live-observer contract';
  end if;

  v_definition := pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_revolut_beneficiary_binding_propose(text,text,text)'::regprocedure
  );
  if position('ticket_token_hash' in lower(v_definition)) = 0
    or position('authorization_ticket_id' in lower(v_definition)) = 0
    or position('mapping_attestation_hmac' in lower(v_definition)) = 0
    or position('consumed_at' in lower(v_definition)) = 0
    or position('expires_at' in lower(v_definition)) = 0
  then
    raise exception
      'restored beneficiary proposal lost its AAL2-minted one-use ticket boundary';
  end if;

  v_definition := pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_statement_ingest(text,date,date,text,jsonb)'::regprocedure
  );
  if position(
      'direct statement ingestion is disabled' in lower(v_definition)
    ) = 0
    or position('0a000' in lower(v_definition)) = 0
    or has_function_privilege(
      'anon',
      'affiliate_private.admin_partners_revolut_statement_ingest(text,date,date,text,jsonb)',
      'EXECUTE'
    )
    or has_function_privilege(
      'authenticated',
      'affiliate_private.admin_partners_revolut_statement_ingest(text,date,date,text,jsonb)',
      'EXECUTE'
    )
    or has_function_privilege(
      'service_role',
      'affiliate_private.admin_partners_revolut_statement_ingest(text,date,date,text,jsonb)',
      'EXECUTE'
    )
  then
    raise exception
      'restored direct statement ingestion is not fully retired';
  end if;

  v_definition := pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_ops_alert_snapshot_pre_revolut_basic()'::regprocedure
  );
  if position('revenuecat_transfer' in lower(v_definition)) = 0
    or position(
      'chargeback_reversal_dead_letter' in lower(v_definition)
    ) = 0
    or position(
      'revenuecat_transfer_dead_letter' in lower(v_definition)
    ) = 0
    or position(
      'kyc_provider_binding_quarantined_recent' in lower(v_definition)
    ) = 0
    or position(
      'kyc_legacy_binding_quarantined_recent' in lower(v_definition)
    ) = 0
    or position(
      'kyc_binding_recovery_overdue' in lower(v_definition)
    ) = 0
    or position('worker_heartbeat_missing' in lower(v_definition)) = 0
  then
    raise exception
      'restored cumulative Partners Ops snapshot is incomplete';
  end if;
  v_definition := pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_ops_alert_snapshot()'::regprocedure
  );
  if position(
      'partners_ops_alert_snapshot_pre_revolut_basic' in lower(v_definition)
    ) = 0
    or position('revolut_manual_action_required' in lower(v_definition)) = 0
    or position(
      'worker_item ->> ''worker'' <> ''payout'''
      in lower(v_definition)
    ) = 0
  then
    raise exception
      'restored Basic/manual alert snapshot lost its inactive-rail filter';
  end if;
  v_definition := pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_payout_status()'::regprocedure
  );
  if position('api_adapter_verified' in lower(v_definition)) = 0
    or position('manual_statement_pending' in lower(v_definition)) = 0
    or position(
      'statement_matched_review_pending' in lower(v_definition)
    ) = 0
    or position(
      'review.target_execution_id = execution.id' in lower(v_definition)
    ) = 0
    or position(
      'decision.action <> ''quarantine''' in lower(v_definition)
    ) = 0
  then
    raise exception
      'restored Revolut payout status conflates API readiness or manual incidents';
  end if;

  v_definition := pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_analytics(integer)'::regprocedure
  );
  if position(
      'admin_partners_analytics_pre_didit_binding' in lower(v_definition)
    ) = 0
    or position(
      'event.processing_outcome = ''verified''' in lower(v_definition)
    ) = 0
    or position(
      'event.provider_environment = ''live''' in lower(v_definition)
    ) = 0
    or position(
      'event.provider_config_fingerprint =' in lower(v_definition)
    ) = 0
    or position(
      'session.provider_config_fingerprint' in lower(v_definition)
    ) = 0
    or position(
      'event.provider_event_at = session.verified_at' in lower(v_definition)
    ) = 0
  then
    raise exception
      'restored Partners analytics lost authoritative Didit causality';
  end if;

  select string_agg(
    exposed.role_name || ':' || exposed.signature,
    ', '
    order by exposed.role_name, exposed.signature
  )
  into v_unexpected
  from (
    select
      roles.role_name,
      p.oid,
      format(
        '%I.%I(%s)',
        n.nspname,
        p.proname,
        pg_catalog.pg_get_function_identity_arguments(p.oid)
      ) as signature
    from (
      values ('anon'::text), ('authenticated'::text)
    ) roles(role_name)
    join pg_catalog.pg_proc p on true
    join pg_catalog.pg_namespace n
      on n.oid = p.pronamespace
      and n.nspname = 'affiliate_private'
    where pg_catalog.has_function_privilege(
      roles.role_name,
      p.oid,
      'EXECUTE'
    )
      and (
        roles.role_name = 'anon'
        or not exists (
          select 1
          from unnest(array[
            'affiliate_private.admin_partners_overview()',
            'affiliate_private.admin_partners_accounts(integer,integer,text,text)',
            'affiliate_private.admin_partners_detail(uuid)',
            'affiliate_private.admin_partners_detail_by_public_id(text)',
            'affiliate_private.admin_partners_capabilities()',
            'affiliate_private.admin_partners_capability_operators()',
            'affiliate_private.admin_partners_capability_set(uuid,text,boolean,text)',
            'affiliate_private.admin_partners_capability_set_by_operator_key(text,text,boolean,text)',
            'affiliate_private.admin_partners_access_requests(integer,integer,text,text)',
            'affiliate_private.admin_partners_access_request_decide(uuid,text,timestamp with time zone,text)',
            'affiliate_private.admin_partners_program_create(text,jsonb,text,text,timestamp with time zone,text)',
            'affiliate_private.admin_partners_program_activate(text,text,text)',
            'affiliate_private.admin_partners_country_policy_create(text,text,text,integer,text[],timestamp with time zone,text)',
            'affiliate_private.admin_partners_kyc_attempt_policy_set(text,text,text,integer,integer,integer,text,text)',
            'affiliate_private.admin_partners_kyc_certification_prepare(text,text,boolean,text,text,text)',
            'affiliate_private.admin_partners_kyc_certification_resume()',
            'affiliate_private.admin_partners_kyc_certification_status()',
            'affiliate_private.admin_partners_country_mapping_set(text,text,text,text)',
            'affiliate_private.admin_partners_currency_set(text,integer,text,text)',
            'affiliate_private.admin_partners_payout_provider_set(text,text,text,text,text)',
            'affiliate_private.admin_partners_payout_route_set(text,text,text,text,text,text)',
            'affiliate_private.admin_partners_revolut_profile_hold(uuid,text,text,text,text)',
            'affiliate_private.admin_partners_revolut_profile_status(uuid)',
            'affiliate_private.admin_partners_revolut_beneficiary_binding_authorize(uuid,text,text,text,text,integer,text,text)',
            'affiliate_private.admin_partners_revolut_beneficiary_binding_authorize_by_request(text,text,text,text,integer,text,text)',
            'affiliate_private.admin_partners_revolut_beneficiary_binding_verify(text,text,text)',
            'affiliate_private.admin_partners_revolut_beneficiary_binding_reject(text,text,text)',
            'affiliate_private.admin_partners_revolut_beneficiary_binding_revoke(text,text,text)',
            'affiliate_private.admin_partners_revolut_manual_batch_prepare(text,text,text)',
            'affiliate_private.admin_partners_revolut_manual_batch_export(text,text,text)',
            'affiliate_private.admin_partners_revolut_manual_batch_mark_submitted(text,jsonb,text,text)',
            'affiliate_private.admin_partners_revolut_statement_authorize()',
            'affiliate_private.admin_partners_revolut_statement_context()',
            'affiliate_private.admin_partners_revolut_reconciliation_review(text,text,text)',
            'affiliate_private.admin_partners_revolut_reconciliation_decide(text,text,text,text)',
            'affiliate_private.admin_partners_revolut_payout_status()',
            'affiliate_private.admin_partners_revolut_manual_batches(integer,integer,text)',
            'affiliate_private.admin_partners_revolut_reconciliation_queue(integer,integer,text)',
            'affiliate_private.admin_partners_revolut_manual_control_reject(text,text,text)',
            'affiliate_private.admin_partners_revolut_manual_controls_queue(integer,integer,text)',
            'affiliate_private.admin_partners_revolut_manual_batch_cancel(text,text,text,timestamp with time zone,text,text)',
            'affiliate_private.admin_partners_revolut_manual_batch_release_unmapped(text,jsonb,text,timestamp with time zone,text,text)',
            'affiliate_private.admin_partners_revolut_reconciliation_incident_review(text,text,text,text,timestamp with time zone,text,text)',
            'affiliate_private.admin_partners_revolut_reconciliation_incident_decide(text,text,text,timestamp with time zone,text,text)',
            'affiliate_private.admin_partners_revolut_reconciliation_incidents(integer,integer,text)',
            'affiliate_private.admin_partners_revolut_return_review(text,text,text,text)',
            'affiliate_private.admin_partners_revolut_return_decide(text,text,text,text)',
            'affiliate_private.admin_partners_revolut_return_queue(integer,integer,text)',
            'affiliate_private.admin_partners_revolut_late_completion_review(text,text,text,text)',
            'affiliate_private.admin_partners_revolut_late_completion_decide(text,text,text,text)',
            'affiliate_private.admin_partners_revolut_late_completion_queue(integer,integer,text)',
            'affiliate_private.admin_partners_country_policy_set_available(text,text,text,boolean,text,text)',
            'affiliate_private.admin_partners_fiscal_review(uuid,text,text,text,text,text,text)',
            'affiliate_private.admin_partners_fiscal_review_by_public_id(text,text,text,text,text,text)',
            'affiliate_private.admin_partners_fiscal_profiles(integer,integer,text,text)',
            'affiliate_private.admin_partners_payout_onboarding_requests(integer,integer,text,text)',
            'affiliate_private.admin_partners_payout_onboarding_request_decide(text,text,text,text)',
            'affiliate_private.admin_partners_payout_onboarding_contact(text,text,uuid)',
            'affiliate_private.admin_partners_account_action(text,text,text,text)',
            'affiliate_private.admin_partners_job_retry(text,text,text,text)',
            'affiliate_private.admin_partners_commission_reverse(text,text,text)',
            'affiliate_private.admin_partners_payout_cycle_create(date,date,text,boolean,text,text)',
            'affiliate_private.admin_partners_payout_cycle_approve(text,text,text)',
            'affiliate_private.admin_partners_risk_queue(integer,integer,text)',
            'affiliate_private.admin_partners_finance_overview()',
            'affiliate_private.admin_partners_payout_cycles(integer,integer,text)',
            'affiliate_private.admin_partners_kyc_quota()',
            'affiliate_private.admin_partners_analytics(integer)',
            'affiliate_private.admin_partners_monitoring()',
            'affiliate_private.admin_partners_configuration()'
          ]) allowed(signature)
          where to_regprocedure(allowed.signature) = p.oid
        )
      )
  ) exposed;

  if v_unexpected is not null then
    raise exception
      'unexpected private Partners EXECUTE privilege: %',
      v_unexpected;
  end if;
end;
$partners_restore_routines$;

do $partners_restore_invariants$
declare
  v_expected record;
  v_bad_entries bigint;
begin
  for v_expected in
    select *
    from (
      values
        (
          'affiliate_kyc_sessions_register_didit_purpose',
          'affiliate_kyc_sessions',
          'register_member_didit_session',
          false
        ),
        (
          'affiliate_didit_session_registry_append_only',
          'affiliate_didit_session_registry',
          'reject_partners_append_only_mutation',
          false
        ),
        (
          'affiliate_didit_certification_events_append_only',
          'affiliate_didit_certification_events',
          'reject_partners_append_only_mutation',
          false
        ),
        (
          'affiliate_didit_certification_sessions_validate',
          'affiliate_didit_certification_sessions',
          'guard_didit_certification_session_transition',
          false
        ),
        (
          'affiliate_kyc_sessions_00_bind_environment',
          'affiliate_kyc_sessions',
          'bind_kyc_session_environment',
          false
        ),
        (
          'affiliate_kyc_sessions_validate',
          'affiliate_kyc_sessions',
          'guard_kyc_session_transition',
          false
        ),
        (
          'affiliate_kyc_webhook_events_00_bind_environment',
          'affiliate_kyc_webhook_events',
          'bind_kyc_webhook_event_environment',
          false
        ),
        (
          'affiliate_kyc_webhook_events_append_only',
          'affiliate_kyc_webhook_events',
          'reject_partners_append_only_mutation',
          false
        ),
        (
          'affiliate_events_append_only',
          'affiliate_events',
          'reject_affiliate_event_mutation',
          false
        ),
        (
          'affiliate_financial_facts_append_only',
          'affiliate_financial_facts',
          'reject_partners_finance_mutation',
          false
        ),
        (
          'affiliate_financial_fact_observations_append_only',
          'affiliate_financial_fact_observations',
          'reject_partners_finance_mutation',
          false
        ),
        (
          'affiliate_financial_fact_conflicts_append_only',
          'affiliate_financial_fact_conflicts',
          'reject_partners_finance_mutation',
          false
        ),
        (
          'affiliate_financial_fact_lineage_links_append_only',
          'affiliate_financial_fact_lineage_links',
          'reject_partners_finance_mutation',
          false
        ),
        (
          'affiliate_commission_entries_append_only',
          'affiliate_commission_entries',
          'reject_partners_finance_mutation',
          false
        ),
        (
          'affiliate_commission_postings_append_only',
          'affiliate_commission_postings',
          'reject_partners_finance_mutation',
          false
        ),
        (
          'affiliate_commission_entry_balance_on_entry',
          'affiliate_commission_entries',
          'assert_commission_entry_balanced',
          true
        ),
        (
          'affiliate_commission_entry_balance_on_posting',
          'affiliate_commission_postings',
          'assert_commission_entry_balanced',
          true
        ),
        (
          'affiliate_revolut_dispute_won_conflicts_append_only',
          'affiliate_revolut_dispute_won_conflicts',
          'reject_partners_finance_mutation',
          false
        ),
        (
          'affiliate_payout_settlement_semantics',
          'affiliate_commission_entries',
          'assert_payout_settlement_semantics',
          true
        ),
        (
          'affiliate_payout_provider_revolut_route_guard',
          'affiliate_payout_provider_configs',
          'guard_revolut_payout_route',
          false
        ),
        (
          'affiliate_payout_items_execution_snapshot_guard',
          'affiliate_payout_items',
          'guard_payout_item_execution_snapshot',
          false
        ),
        (
          'affiliate_revolut_payout_events_append_only',
          'affiliate_revolut_payout_events',
          'reject_revolut_evidence_mutation',
          false
        ),
        (
          'affiliate_revolut_statement_rows_append_only',
          'affiliate_revolut_statement_rows',
          'reject_revolut_evidence_mutation',
          false
        ),
        (
          'affiliate_revolut_manual_reviews_append_only',
          'affiliate_revolut_manual_reviews',
          'reject_revolut_evidence_mutation',
          false
        ),
        (
          'affiliate_revolut_manual_decisions_append_only',
          'affiliate_revolut_manual_decisions',
          'reject_revolut_evidence_mutation',
          false
        ),
        (
          'affiliate_revolut_statement_import_transition_guard',
          'affiliate_revolut_statement_imports',
          'guard_revolut_statement_import_transition',
          false
        ),
        (
          'affiliate_revolut_statement_import_delete_guard',
          'affiliate_revolut_statement_imports',
          'reject_revolut_evidence_mutation',
          false
        ),
        (
          'affiliate_revolut_manual_batch_transition_guard',
          'affiliate_revolut_manual_batches',
          'guard_revolut_manual_batch_transition',
          false
        ),
        (
          'affiliate_revolut_manual_decision_guard',
          'affiliate_revolut_manual_decisions',
          'guard_revolut_manual_decision',
          false
        ),
        (
          'affiliate_partners_settled_payout_item_guard',
          'affiliate_payout_items',
          'guard_partners_settled_payout_item',
          false
        ),
        (
          'affiliate_partners_settled_payout_cycle_guard',
          'affiliate_payout_cycles',
          'guard_partners_settled_payout_cycle',
          false
        ),
        (
          'affiliate_payout_cycles_live_promotion_aal2',
          'affiliate_payout_cycles',
          'guard_partners_payout_live_promotion_aal2',
          false
        ),
        (
          'affiliate_commission_entries_open_account_guard',
          'affiliate_commission_entries',
          'guard_commission_entry_open_account',
          false
        ),
        (
          'affiliate_payout_profiles_binding_and_hold_guard',
          'affiliate_payout_profiles',
          'guard_payout_profile_binding_and_hold',
          false
        ),
        (
          'affiliate_revolut_statement_row_incident_capture',
          'affiliate_revolut_statement_rows',
          'capture_revolut_reconciliation_incident',
          false
        ),
        (
          'affiliate_revolut_reconciliation_incidents_append_only',
          'affiliate_revolut_reconciliation_incidents',
          'reject_revolut_evidence_mutation',
          false
        ),
        (
          'affiliate_revolut_reconciliation_incident_reviews_append_only',
          'affiliate_revolut_reconciliation_incident_reviews',
          'reject_revolut_evidence_mutation',
          false
        ),
        (
          'affiliate_revolut_transaction_aliases_append_only',
          'affiliate_revolut_transaction_aliases',
          'reject_revolut_evidence_mutation',
          false
        ),
        (
          'affiliate_revolut_reconciliation_decisions_append_only',
          'affiliate_revolut_reconciliation_incident_decisions',
          'reject_revolut_evidence_mutation',
          false
        ),
        (
          'affiliate_revolut_return_observations_append_only',
          'affiliate_revolut_return_observations',
          'reject_revolut_evidence_mutation',
          false
        ),
        (
          'affiliate_revolut_return_reviews_append_only',
          'affiliate_revolut_return_reviews',
          'reject_revolut_evidence_mutation',
          false
        ),
        (
          'affiliate_revolut_return_decisions_append_only',
          'affiliate_revolut_return_decisions',
          'reject_revolut_evidence_mutation',
          false
        ),
        (
          'affiliate_revolut_late_completion_observations_append_only',
          'affiliate_revolut_late_completion_observations',
          'reject_revolut_evidence_mutation',
          false
        ),
        (
          'affiliate_revolut_late_completion_reviews_append_only',
          'affiliate_revolut_late_completion_reviews',
          'reject_revolut_evidence_mutation',
          false
        ),
        (
          'affiliate_revolut_late_completion_decisions_append_only',
          'affiliate_revolut_late_completion_decisions',
          'reject_revolut_evidence_mutation',
          false
        )
    ) expected(
      trigger_name,
      table_name,
      function_name,
      must_be_deferrable
    )
  loop
    if not exists (
      select 1
      from pg_catalog.pg_trigger t
      join pg_catalog.pg_class relation
        on relation.oid = t.tgrelid
      join pg_catalog.pg_namespace relation_namespace
        on relation_namespace.oid = relation.relnamespace
      join pg_catalog.pg_proc routine
        on routine.oid = t.tgfoid
      join pg_catalog.pg_namespace routine_namespace
        on routine_namespace.oid = routine.pronamespace
      where t.tgname = v_expected.trigger_name
        and relation_namespace.nspname = 'affiliate_private'
        and relation.relname = v_expected.table_name
        and routine_namespace.nspname = 'affiliate_private'
        and routine.proname = v_expected.function_name
        and not t.tgisinternal
        and t.tgenabled <> 'D'
        and (
          not v_expected.must_be_deferrable
          or (
            t.tgdeferrable
            and t.tginitdeferred
          )
        )
    ) then
      raise exception
        'restore omitted, disabled or rewired trigger %.% -> %',
        v_expected.table_name,
        v_expected.trigger_name,
        v_expected.function_name;
    end if;
  end loop;

  if not exists (
    select 1
    from pg_catalog.pg_trigger trigger_row
    where trigger_row.tgrelid =
        'affiliate_private.affiliate_kyc_sessions'::regclass
      and trigger_row.tgname =
        'affiliate_kyc_sessions_register_didit_purpose'
      and not trigger_row.tgisinternal
      -- PostgreSQL tgtype bitmask: ROW (1) + INSERT (4), no BEFORE bit.
      and trigger_row.tgtype = 5
  ) then
    raise exception
      'member Didit purpose trigger is not exactly AFTER INSERT FOR EACH ROW';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_attribute attribute_info
    where attribute_info.attrelid =
        'affiliate_private.affiliate_didit_certification_sessions'::regclass
      and attribute_info.attname = 'provider_create_dispatched_at'
      and attribute_info.attnum > 0
      and not attribute_info.attisdropped
  ) then
    raise exception
      'restored Didit certification sessions lost the provider dispatch claim';
  end if;
  if not exists (
    select 1
    from pg_catalog.pg_constraint constraint_info
    where constraint_info.conrelid =
        'affiliate_private.affiliate_didit_certification_sessions'::regclass
      and constraint_info.conname =
        'affiliate_didit_certification_sessions_provider_binding'
      and constraint_info.contype = 'c'
      and constraint_info.convalidated
      and position(
        'provider_create_dispatched_at is not null' in lower(
          pg_catalog.pg_get_constraintdef(constraint_info.oid)
        )
      ) > 0
  ) then
    raise exception
      'restored Didit certification binding constraint lost the provider dispatch claim';
  end if;

  select count(*)
  into v_bad_entries
  from affiliate_private.affiliate_didit_certification_sessions
  where provider_session_hash is not null
    and provider_create_dispatched_at is null;
  if v_bad_entries <> 0 then
    raise exception
      'restored Didit certification bindings contain % unclaimed provider dispatches',
      v_bad_entries;
  end if;

  select count(*)
  into v_bad_entries
  from (
    select member_session.id
    from affiliate_private.affiliate_kyc_sessions member_session
    left join affiliate_private.affiliate_didit_session_registry registry
      on registry.session_purpose = 'member_kyc'
      and registry.source_record_id = member_session.id
      and registry.provider_session_hash =
        member_session.provider_session_hash
    where registry.provider_session_hash is null

    union all

    select registry.source_record_id
    from affiliate_private.affiliate_didit_session_registry registry
    left join affiliate_private.affiliate_kyc_sessions member_session
      on member_session.id = registry.source_record_id
      and member_session.provider_session_hash =
        registry.provider_session_hash
    where registry.session_purpose = 'member_kyc'
      and member_session.id is null

    union all

    select certification_session.id
    from affiliate_private.affiliate_didit_certification_sessions
      certification_session
    left join affiliate_private.affiliate_didit_session_registry registry
      on registry.session_purpose = 'certification'
      and registry.source_record_id = certification_session.id
      and registry.provider_session_hash =
        certification_session.provider_session_hash
    where certification_session.provider_session_hash is not null
      and registry.provider_session_hash is null

    union all

    select registry.source_record_id
    from affiliate_private.affiliate_didit_session_registry registry
    left join affiliate_private.affiliate_didit_certification_sessions
      certification_session
      on certification_session.id = registry.source_record_id
      and certification_session.provider_session_hash =
        registry.provider_session_hash
    where registry.session_purpose = 'certification'
      and certification_session.id is null
  ) didit_registry_inconsistency;

  if v_bad_entries <> 0 then
    raise exception
      'restored Didit purpose registry is inconsistent with % source sessions',
      v_bad_entries;
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint constraint_info
    where constraint_info.conrelid =
        'affiliate_private.affiliate_payout_provider_configs'::regclass
      and constraint_info.conname =
        'affiliate_payout_provider_configs_pilot_adapter'
      and constraint_info.contype = 'c'
      and constraint_info.convalidated
      and pg_catalog.pg_get_constraintdef(constraint_info.oid)
        like
          '%status <> ''active''%provider = ''revolut''%'
          || 'execution_adapter%revolut_manual%revolut_api%'
  )
    or not exists (
      select 1
      from pg_catalog.pg_constraint constraint_info
      where constraint_info.conrelid =
          'affiliate_private.affiliate_payout_provider_configs'::regclass
        and constraint_info.conname =
          'affiliate_payout_provider_configs_execution_adapter'
        and constraint_info.contype = 'c'
        and constraint_info.convalidated
        and pg_catalog.pg_get_constraintdef(constraint_info.oid)
          like '%provider = ''revolut''%revolut_manual%revolut_api%'
  )
    or not exists (
      select 1
      from pg_catalog.pg_index index_info
      where index_info.indexrelid = to_regclass(
          'affiliate_private.'
          || 'affiliate_payout_provider_configs_active_route_idx'
        )
        and index_info.indisunique
        and pg_catalog.pg_get_indexdef(index_info.indexrelid)
          like '%(country_code, currency)%'
        and pg_catalog.pg_get_expr(
          index_info.indpred,
          index_info.indrelid
        ) like '%status = ''active''%'
    )
  then
    raise exception
      'restore omitted the Revolut payout provider, adapter or route lock';
  end if;

  if exists (
    select 1
    from affiliate_private.affiliate_payout_provider_configs config
    where config.status = 'active'
      and (
        config.provider <> 'revolut'
        or config.execution_adapter <> 'revolut_manual'
      )
  )
    or exists (
      select 1
      from affiliate_private.affiliate_payout_provider_configs config
      where config.status = 'active'
      group by config.country_code, config.currency
      having count(*) > 1
    )
  then
    raise exception
      'restored payout provider configurations violate Revolut Basic/manual';
  end if;

  if not exists (
    select 1
    from public.admin_feature_flags flag
    where flag.key = 'partners_revolut_api_enabled'
      and not flag.enabled
  )
    or exists (
      select 1
      from affiliate_private.affiliate_revolut_api_worker_lease lease
      where lease.worker_id is not null
        or lease.lease_token_hash is not null
        or lease.leased_until is not null
    )
    or exists (
      select 1
      from affiliate_private.affiliate_revolut_payout_executions execution
      where execution.adapter = 'revolut_api'
        and execution.job_status = 'leased'
    )
  then
    raise exception
      'restored Revolut API rail is not fail-closed';
  end if;
  if exists (
    select 1
    from cron.job
    where active
      and jobname in (
        'norva-partners-payout',
        'norva-partners-revolut-api'
      )
  ) then
    raise exception
      'restored Basic/manual payout mode still has an automated payout cron';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_trigger trigger_info
    join pg_catalog.pg_proc routine
      on routine.oid = trigger_info.tgfoid
    join pg_catalog.pg_namespace routine_namespace
      on routine_namespace.oid = routine.pronamespace
    where trigger_info.tgrelid = 'public.admin_feature_flags'::regclass
      and trigger_info.tgname = 'admin_feature_flags_revolut_api_guard'
      and not trigger_info.tgisinternal
      and trigger_info.tgenabled <> 'D'
      and routine_namespace.nspname = 'affiliate_private'
      and routine.proname = 'guard_revolut_api_feature_flag'
  ) then
    raise exception
      'restore omitted the Revolut API feature-flag guard';
  end if;

  if (
    select count(*)
    from pg_catalog.pg_constraint constraint_info
    where constraint_info.connamespace =
        'affiliate_private'::regnamespace
      and constraint_info.convalidated
      and constraint_info.conname in (
        'affiliate_payout_items_execution_snapshot',
        'affiliate_revolut_payout_executions_adapter',
        'affiliate_revolut_payout_executions_reference',
        'affiliate_revolut_payout_executions_money',
        'affiliate_revolut_statement_rows_reference',
        'affiliate_revolut_statement_rows_money',
        'affiliate_revolut_manual_decisions_value'
      )
  ) <> 7
    or not exists (
      select 1
      from pg_catalog.pg_index index_info
      where index_info.indexrelid = to_regclass(
          'affiliate_private.affiliate_payout_items_reference_idx'
        )
        and index_info.indisunique
    )
    or not exists (
      select 1
      from pg_catalog.pg_index index_info
      join pg_catalog.pg_class indexed_table
        on indexed_table.oid = index_info.indrelid
      join pg_catalog.pg_namespace indexed_namespace
        on indexed_namespace.oid = indexed_table.relnamespace
      where indexed_namespace.nspname = 'affiliate_private'
        and indexed_table.relname = 'affiliate_revolut_payout_executions'
        and index_info.indisunique
        and pg_catalog.pg_get_indexdef(index_info.indexrelid)
          like '%(payout_reference)%'
    )
  then
    raise exception
      'restore omitted Revolut exact-money or unique-reference constraints';
  end if;

  if exists (
    select 1
    from affiliate_private.affiliate_revolut_payout_executions execution
    where execution.payout_reference !~ '^NORVA-[A-F0-9]{12}$'
  )
    or exists (
      select 1
      from affiliate_private.affiliate_payout_items item
      where item.payout_reference is not null
        and item.payout_reference !~ '^NORVA-[A-F0-9]{12}$'
    )
    or exists (
      select 1
      from affiliate_private.affiliate_revolut_statement_rows row
      where row.payout_reference !~ '^NORVA-[A-F0-9]{12}$'
    )
  then
    raise exception
      'restored Revolut data contains an invalid Norva payout reference';
  end if;

  if (
    select count(*)
    from pg_catalog.pg_constraint constraint_info
    where constraint_info.connamespace =
        'affiliate_private'::regnamespace
      and constraint_info.convalidated
      and constraint_info.conname in (
        'affiliate_revolut_dispute_won_jobs_key',
        'affiliate_revolut_dispute_won_jobs_hashes',
        'affiliate_revolut_dispute_won_jobs_currency',
        'affiliate_revolut_dispute_won_jobs_amount',
        'affiliate_revolut_dispute_won_jobs_status',
        'affiliate_revolut_dispute_won_jobs_worker',
        'affiliate_revolut_dispute_won_jobs_lease_hash',
        'affiliate_revolut_dispute_won_jobs_attempts',
        'affiliate_revolut_dispute_won_jobs_error',
        'affiliate_revolut_dispute_won_jobs_lease_state',
        'affiliate_revolut_dispute_won_jobs_completion',
        'affiliate_revolut_dispute_won_conflicts_hashes'
      )
  ) <> 12 then
    raise exception
      'restore omitted or left unvalidated DISPUTE_WON constraints';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint constraint_info
    where constraint_info.conrelid =
        'affiliate_private.affiliate_revolut_dispute_won_jobs'::regclass
      and constraint_info.contype = 'u'
      and pg_catalog.pg_get_constraintdef(constraint_info.oid)
        = 'UNIQUE (source_event_hash)'
  )
    or not exists (
      select 1
      from pg_catalog.pg_constraint constraint_info
      where constraint_info.conrelid =
          'affiliate_private.affiliate_revolut_dispute_won_conflicts'::regclass
        and constraint_info.contype = 'u'
        and pg_catalog.pg_get_constraintdef(constraint_info.oid)
          = 'UNIQUE (source_event_hash, payload_hash)'
    )
    or not exists (
      select 1
      from pg_catalog.pg_index index_metadata
      where index_metadata.indexrelid = to_regclass(
        'affiliate_private.affiliate_commission_entries_reinstatement_once_idx'
      )
        and index_metadata.indisunique
        and pg_catalog.pg_get_indexdef(index_metadata.indexrelid)
          like '%(related_entry_id)%'
        and pg_catalog.pg_get_expr(
          index_metadata.indpred,
          index_metadata.indrelid
        ) like '%entry_kind%'
        and pg_catalog.pg_get_expr(
          index_metadata.indpred,
          index_metadata.indrelid
        ) like '%reinstatement%'
    )
  then
    raise exception
      'restore omitted a DISPUTE_WON idempotency invariant';
  end if;

  select count(*)
  into v_bad_entries
  from affiliate_private.affiliate_revolut_dispute_won_jobs job
  where job.job_key !~ '^crw_[0-9a-f]{24}$'
    or job.source_event_hash !~ '^[0-9a-f]{64}$'
    or job.payload_hash !~ '^[0-9a-f]{64}$'
    or job.dispute_hash !~ '^[0-9a-f]{64}$'
    or job.parent_order_hash !~ '^[0-9a-f]{64}$'
    or job.currency !~ '^[A-Z]{3}$'
    or job.gross_minor not between 1 and 9007199254740991
    or job.attempts not between 0 and 72
    or (
      (job.status = 'leased') is distinct from (
        job.worker_id is not null
        and job.lease_token_hash is not null
        and job.leased_until is not null
      )
    )
    or (
      (job.status in ('succeeded', 'dead_letter')) is distinct from
        (job.completed_at is not null)
    );
  if v_bad_entries > 0 then
    raise exception
      'restored DISPUTE_WON queue contains % invalid jobs',
      v_bad_entries;
  end if;

  select count(*)
  into v_bad_entries
  from affiliate_private.affiliate_revolut_dispute_won_conflicts conflict
  left join affiliate_private.affiliate_revolut_dispute_won_jobs job
    on job.id = conflict.job_id
  where job.id is null
    or conflict.source_event_hash !~ '^[0-9a-f]{64}$'
    or conflict.payload_hash !~ '^[0-9a-f]{64}$';
  if v_bad_entries > 0 then
    raise exception
      'restored DISPUTE_WON audit contains % invalid conflicts',
      v_bad_entries;
  end if;

  select count(*)
  into v_bad_entries
  from affiliate_private.affiliate_financial_facts correction
  where correction.environment = 'production'
    and correction.rail = 'web'
    and correction.event_type = 'chargeback_reversal'
    and correction.facts_status = 'complete'
    and not exists (
      select 1
      from affiliate_private.affiliate_commission_entries reinstatement
      where reinstatement.fact_id = correction.id
        and reinstatement.entry_kind = 'reinstatement'
    );
  if v_bad_entries > 0 then
    raise exception
      'restored DISPUTE_WON ledger is missing % reinstatements',
      v_bad_entries;
  end if;

  select count(*)
  into v_bad_entries
  from affiliate_private.affiliate_commission_entries reinstatement
  left join affiliate_private.affiliate_financial_facts correction
    on correction.id = reinstatement.fact_id
  left join affiliate_private.affiliate_commission_entries reversal
    on reversal.id = reinstatement.related_entry_id
  left join affiliate_private.affiliate_commission_entries accrual
    on accrual.id = reversal.related_entry_id
  left join affiliate_private.affiliate_financial_facts loss
    on loss.id = reversal.fact_id
  where reinstatement.entry_kind = 'reinstatement'
    and (
      correction.id is null
      or correction.event_type <> 'chargeback_reversal'
      or correction.environment <> 'production'
      or correction.rail <> 'web'
      or correction.facts_status <> 'complete'
      or reversal.id is null
      or reversal.entry_kind <> 'reversal'
      or accrual.id is null
      or accrual.entry_kind <> 'accrual'
      or loss.id is null
      or loss.event_type <> 'chargeback'
      or reinstatement.account_id is distinct from reversal.account_id
      or reinstatement.attribution_id is distinct from
        reversal.attribution_id
      or reinstatement.currency is distinct from reversal.currency
      or reinstatement.currency_exponent is distinct from
        reversal.currency_exponent
      or reinstatement.amount_minor is distinct from reversal.amount_minor
    );
  if v_bad_entries > 0 then
    raise exception
      'restored DISPUTE_WON ledger contains % invalid reinstatements',
      v_bad_entries;
  end if;

  select count(*)
  into v_bad_entries
  from affiliate_private.affiliate_accounts account
  where account.status <> 'closed'
    and account.verification_provider = 'didit'
    and account.verification_status = 'verified'
    and not exists (
      select 1
      from affiliate_private.affiliate_kyc_sessions session
      where session.account_id = account.id
        and session.provider_session_hash =
          account.verification_reference
        and session.provider_environment = 'live'
        and session.provider_config_fingerprint ~ '^[0-9a-f]{64}$'
        and session.provider_config_fingerprint <> repeat('0', 64)
        and session.status = 'verified'
        and exists (
          select 1
          from affiliate_private.affiliate_kyc_webhook_events event
          where event.session_id = session.id
            and event.processing_outcome = 'verified'
            and event.provider_environment = 'live'
            and event.provider_config_fingerprint =
              session.provider_config_fingerprint
            and event.provider_event_at = session.verified_at
        )
    );
  if v_bad_entries > 0 then
    raise exception
      'restored Partners state trusts % Didit decisions without an exact live binding',
      v_bad_entries;
  end if;

  select count(*)
  into v_bad_entries
  from affiliate_private.affiliate_kyc_sessions session
  where session.status = 'pending'
    and session.provider_environment = 'legacy_unbound';
  if v_bad_entries > 0 then
    raise exception
      'restored Partners state contains % indefinitely blocking legacy KYC sessions',
      v_bad_entries;
  end if;

  select count(*)
  into v_bad_entries
  from affiliate_private.affiliate_kyc_webhook_events event
  join affiliate_private.affiliate_kyc_sessions session
    on session.id = event.session_id
  where (
      event.processing_outcome = 'verified'
      and event.provider_environment <> 'legacy_unbound'
      and (
        event.provider_environment <> 'live'
        or event.provider_environment <> session.provider_environment
        or event.provider_config_fingerprint
          <> session.provider_config_fingerprint
      )
    )
    or (
      event.processing_outcome = 'observed_sandbox'
      and (
        event.provider_environment <> 'sandbox'
        or event.decision_reason <> 'sandbox_non_authoritative'
        or session.provider_environment <> 'sandbox'
        or event.provider_config_fingerprint
          <> session.provider_config_fingerprint
      )
    )
    or (
      event.processing_outcome = 'quarantined'
      and not (
        (
          event.decision_reason = 'legacy_provider_binding'
          and session.provider_environment = 'legacy_unbound'
        )
        or (
          event.decision_reason = 'provider_environment_mismatch'
          and event.provider_environment <> session.provider_environment
        )
        or (
          event.decision_reason = 'provider_config_mismatch'
          and event.provider_environment = session.provider_environment
          and event.provider_config_fingerprint
            <> session.provider_config_fingerprint
        )
      )
    );
  if v_bad_entries > 0 then
    raise exception
      'restored Didit audit contains % invalid environment decisions',
      v_bad_entries;
  end if;

  select count(*)
  into v_bad_entries
  from (
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
  ) invalid;

  if v_bad_entries > 0 then
    raise exception
      'restored Partners ledger contains % unbalanced entries',
      v_bad_entries;
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_index index_metadata
    join pg_catalog.pg_class indexed_table
      on indexed_table.oid = index_metadata.indrelid
    join pg_catalog.pg_namespace indexed_namespace
      on indexed_namespace.oid = indexed_table.relnamespace
    where index_metadata.indexrelid = to_regclass(
      'affiliate_private.affiliate_payout_settlement_allocation_once_idx'
    )
      and indexed_namespace.nspname = 'affiliate_private'
      and indexed_table.relname = 'affiliate_commission_entries'
      and index_metadata.indisunique
      and pg_catalog.pg_get_indexdef(index_metadata.indexrelid)
        like '%(related_entry_id)%'
      and pg_catalog.pg_get_expr(
        index_metadata.indpred,
        index_metadata.indrelid
      ) like '%entry_kind%'
      and pg_catalog.pg_get_expr(
        index_metadata.indpred,
        index_metadata.indrelid
      ) like '%payout_settlement%'
  ) then
    raise exception
      'restore omitted or weakened the one-settlement-per-allocation invariant';
  end if;

  select count(*)
  into v_bad_entries
  from affiliate_private.affiliate_revolut_manual_decisions decision
  join affiliate_private.affiliate_revolut_statement_rows statement_row
    on statement_row.id = decision.statement_row_id
  left join affiliate_private.affiliate_revolut_manual_reviews review
    on review.id = decision.review_id
    and review.statement_row_id = decision.statement_row_id
    and review.execution_id = decision.execution_id
  join affiliate_private.affiliate_revolut_payout_executions execution
    on execution.id = decision.execution_id
    and statement_row.execution_id = execution.id
  join affiliate_private.affiliate_payout_items item
    on item.id = execution.payout_item_id
  join affiliate_private.affiliate_payout_cycles cycle
    on cycle.id = item.cycle_id
  left join affiliate_private.affiliate_commission_entries settlement
    on settlement.id = decision.settlement_entry_id
  where review.id is null
    or decision.decision_actor_pseudonym =
      review.review_actor_pseudonym
    or statement_row.payout_reference is distinct from
      execution.payout_reference
    or (
      decision.decision = 'confirmed'
      and (
        statement_row.match_status <> 'matched'
        or statement_row.discrepancy_code is not null
        or statement_row.provider_state <> 'COMPLETED'
        or statement_row.provider_transaction_hash is distinct from
          execution.provider_transaction_hash
        or statement_row.amount_minor is distinct from item.amount_minor
        or statement_row.currency is distinct from item.currency
        or execution.state <> 'paid'
        or execution.reconciliation_status <> 'confirmed'
        or execution.job_status <> 'settled'
        or item.status <> 'settled'
        or item.provider_transfer_hash is distinct from
          execution.provider_transaction_hash
        or settlement.id is null
        or settlement.entry_kind <> 'payout_settlement'
        or settlement.related_entry_id is distinct from
          item.allocation_entry_id
        or settlement.account_id is distinct from item.account_id
        or settlement.amount_minor is distinct from item.amount_minor
        or settlement.currency is distinct from item.currency
        or settlement.currency_exponent is distinct from
          cycle.currency_exponent
        or (
          select count(*)
          from affiliate_private.affiliate_commission_postings posting
          where posting.entry_id = settlement.id
            and posting.amount_minor = item.amount_minor
            and posting.currency = item.currency
            and (
              (
                posting.ledger_account = 'partner_payout_clearing'
                and posting.direction = 'debit'
              )
              or (
                posting.ledger_account = 'partner_cash_settled'
                and posting.direction = 'credit'
              )
            )
        ) <> 2
      )
    )
    or (
      decision.decision = 'quarantined'
      and (
        decision.settlement_entry_id is not null
        or execution.reconciliation_status <> 'exception'
        or execution.job_status <> 'exception'
      )
    );

  if v_bad_entries > 0 then
    raise exception
      'restored Revolut reconciliation contains % invalid decisions',
      v_bad_entries;
  end if;

  select count(*)
  into v_bad_entries
  from affiliate_private.affiliate_commission_entries settlement
  left join affiliate_private.affiliate_commission_entries allocation
    on allocation.id = settlement.related_entry_id
  where settlement.entry_kind = 'payout_settlement'
    and (
      allocation.id is null
      or allocation.entry_kind <> 'payout_allocation'
      or allocation.account_id is distinct from settlement.account_id
      or allocation.currency is distinct from settlement.currency
      or allocation.currency_exponent is distinct from
        settlement.currency_exponent
      or allocation.amount_minor is distinct from settlement.amount_minor
      or (
        select count(*)
        from affiliate_private.affiliate_commission_postings posting
        where posting.entry_id = settlement.id
      ) <> 2
      or (
        select count(*)
        from affiliate_private.affiliate_commission_postings posting
        where posting.entry_id = settlement.id
          and posting.currency = settlement.currency
          and posting.amount_minor = settlement.amount_minor
          and (
            (
              posting.ledger_account = 'partner_payout_clearing'
              and posting.direction = 'debit'
            )
            or (
              posting.ledger_account = 'partner_cash_settled'
              and posting.direction = 'credit'
            )
          )
      ) <> 2
    );

  if v_bad_entries > 0 then
    raise exception
      'restored Partners ledger contains % invalid payout settlements',
      v_bad_entries;
  end if;

  select count(*)
  into v_bad_entries
  from affiliate_private.affiliate_payout_cycles cycle
  where cycle.status = 'settled'
    and (
      not cycle.live_execution
      or cycle.settled_at is null
      or (
        select count(*)
        from affiliate_private.affiliate_payout_items item
        where item.cycle_id = cycle.id
      ) <> cycle.item_count
      or (
        select count(*)
        from affiliate_private.affiliate_payout_items item
        where item.cycle_id = cycle.id
          and item.status = 'settled'
      ) <> cycle.item_count
      or (
        select coalesce(sum(item.amount_minor), 0)
        from affiliate_private.affiliate_payout_items item
        where item.cycle_id = cycle.id
      ) <> cycle.total_minor
      or exists (
        select 1
        from affiliate_private.affiliate_payout_items item
        where item.cycle_id = cycle.id
          and not
            affiliate_private.partners_payout_item_has_confirmed_settlement(
              item.id,
              item.provider_transfer_hash
            )
      )
    );

  if v_bad_entries > 0 then
    raise exception
      'restored payout reconciliation contains % invalid settled cycles',
      v_bad_entries;
  end if;

end;
$partners_restore_invariants$;

select jsonb_build_object(
  'schema', 'affiliate_private',
  'verification', 'passed',
  'accounts', (
    select count(*) from affiliate_private.affiliate_accounts
  ),
  'events', (
    select count(*) from affiliate_private.affiliate_events
  ),
  'attributions', (
    select count(*) from affiliate_private.affiliate_attributions
  ),
  'financial_facts', (
    select count(*) from affiliate_private.affiliate_financial_facts
  ),
  'revolut_dispute_won_jobs', (
    select count(*)
    from affiliate_private.affiliate_revolut_dispute_won_jobs
  ),
  'revolut_dispute_won_conflicts', (
    select count(*)
    from affiliate_private.affiliate_revolut_dispute_won_conflicts
  ),
  'commission_entries', (
    select count(*) from affiliate_private.affiliate_commission_entries
  ),
  'payout_cycles', (
    select count(*) from affiliate_private.affiliate_payout_cycles
  ),
  'revolut_manual_batches', (
    select count(*)
    from affiliate_private.affiliate_revolut_manual_batches
  ),
  'revolut_payout_executions', (
    select count(*)
    from affiliate_private.affiliate_revolut_payout_executions
  ),
  'revolut_api_worker_leases', (
    select count(*)
    from affiliate_private.affiliate_revolut_api_worker_lease
  ),
  'revolut_payout_events', (
    select count(*)
    from affiliate_private.affiliate_revolut_payout_events
  ),
  'revolut_statement_imports', (
    select count(*)
    from affiliate_private.affiliate_revolut_statement_imports
  ),
  'revolut_statement_rows', (
    select count(*)
    from affiliate_private.affiliate_revolut_statement_rows
  ),
  'revolut_manual_reviews', (
    select count(*)
    from affiliate_private.affiliate_revolut_manual_reviews
  ),
  'revolut_manual_decisions', (
    select count(*)
    from affiliate_private.affiliate_revolut_manual_decisions
  )
) as partners_restore_verification;

commit;
