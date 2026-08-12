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
  if to_regclass('public.cloud_access_grants') is null
    or not (
      select relation.relrowsecurity
      from pg_catalog.pg_class relation
      where relation.oid = 'public.cloud_access_grants'::regclass
    )
    or pg_catalog.pg_get_userbyid((
      select relation.relowner
      from pg_catalog.pg_class relation
      where relation.oid = 'public.cloud_access_grants'::regclass
    )) <> current_user
    or has_table_privilege('anon', 'public.cloud_access_grants', 'SELECT')
    or has_table_privilege(
      'authenticated', 'public.cloud_access_grants', 'SELECT'
    )
    or not has_table_privilege(
      'service_role', 'public.cloud_access_grants', 'SELECT'
    )
    or has_table_privilege(
      'service_role',
      'public.cloud_access_grants',
      'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
    )
  then
    raise exception 'restored cloud access grants lost owner, RLS or exact ACL';
  end if;
  if to_regclass(
      'affiliate_private.affiliate_approval_packages'
    ) is null
    or to_regclass(
      'affiliate_private.affiliate_release_gate_approval_bindings'
    ) is null
    or to_regclass(
      'affiliate_private.affiliate_deployment_manifests'
    ) is null
    or to_regclass(
      'affiliate_private.affiliate_deployment_manifest_bindings'
    ) is null
  then
    raise exception 'restore omitted the Partners approval registry';
  end if;
  if not (
      select relation.relrowsecurity
      from pg_catalog.pg_class relation
      where relation.oid =
        'affiliate_private.affiliate_approval_packages'::regclass
    )
    or not (
      select relation.relrowsecurity
      from pg_catalog.pg_class relation
      where relation.oid =
        'affiliate_private.affiliate_release_gate_approval_bindings'::regclass
    )
    or not (
      select relation.relrowsecurity
      from pg_catalog.pg_class relation
      where relation.oid =
        'affiliate_private.affiliate_deployment_manifests'::regclass
    )
  then
    raise exception 'restored Partners approval registry without RLS';
  end if;
  if not exists (
      select 1
      from pg_catalog.pg_trigger trigger_row
      where trigger_row.tgrelid =
          'affiliate_private.affiliate_approval_packages'::regclass
        and trigger_row.tgname = 'affiliate_approval_packages_append_only'
        and trigger_row.tgfoid = to_regprocedure(
          'affiliate_private.reject_partners_approval_package_mutation()'
        )
        and trigger_row.tgenabled = 'O'
        and not trigger_row.tgisinternal
    )
    or not exists (
      select 1
      from pg_catalog.pg_trigger trigger_row
      where trigger_row.tgrelid =
          'affiliate_private.affiliate_release_gate_approval_bindings'::regclass
        and trigger_row.tgname =
          'affiliate_release_gate_approval_bindings_guard'
        and trigger_row.tgfoid = to_regprocedure(
          'affiliate_private.guard_partners_approval_binding_mutation()'
        )
        and trigger_row.tgenabled = 'O'
        and not trigger_row.tgisinternal
    )
    or not exists (
      select 1
      from pg_catalog.pg_trigger trigger_row
      where trigger_row.tgrelid =
          'affiliate_private.affiliate_deployment_manifests'::regclass
        and trigger_row.tgname =
          'affiliate_deployment_manifests_append_only'
        and trigger_row.tgfoid = to_regprocedure(
          'affiliate_private.reject_partners_deployment_manifest_mutation()'
        )
        and trigger_row.tgenabled = 'O'
        and not trigger_row.tgisinternal
    )
    or not exists (
      select 1
      from pg_catalog.pg_trigger trigger_row
      where trigger_row.tgrelid =
          'affiliate_private.affiliate_pilot_allowlist'::regclass
        and trigger_row.tgname = 'affiliate_pilot_allowlist_limit'
        and trigger_row.tgfoid = to_regprocedure(
          'affiliate_private.guard_partners_pilot_allowlist_limit()'
        )
        and trigger_row.tgenabled = 'O'
        and not trigger_row.tgisinternal
    )
  then
    raise exception 'restored Partners approval registry without guards';
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
    'affiliate_biometric_consent_attestations',
    'affiliate_didit_purge_outbox',
    'affiliate_didit_purge_events',
    'affiliate_didit_purge_worker_state',
    'affiliate_biometric_consent_withdrawals',
    'affiliate_kyc_human_review_requests',
    'affiliate_deployment_manifests',
    'affiliate_deployment_manifest_bindings',
    'affiliate_approval_packages',
    'affiliate_release_gate_approval_bindings',
    'affiliate_access_credit_catalog',
    'affiliate_access_credit_quotes',
    'affiliate_access_credit_redemptions',
    'affiliate_web_tax_policies',
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

  if not exists (
    select 1
    from information_schema.columns column_row
    where column_row.table_schema = 'affiliate_private'
      and column_row.table_name = 'affiliate_didit_certification_events'
      and column_row.column_name = 'provider_delivered_at'
      and column_row.data_type = 'timestamp with time zone'
      and column_row.is_nullable = 'YES'
  ) or not exists (
    select 1
    from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid =
      'affiliate_private.affiliate_didit_certification_events'::regclass
      and constraint_row.conname =
        'affiliate_didit_certification_events_delivery'
      and constraint_row.contype = 'c'
      and constraint_row.convalidated
      and position(
        'provider_delivered_at'
        in pg_catalog.pg_get_constraintdef(constraint_row.oid)
      ) > 0
      and position(
        'provider_event_created_at'
        in pg_catalog.pg_get_constraintdef(constraint_row.oid)
      ) > 0
      and position(
        '00:05:00'
        in pg_catalog.pg_get_constraintdef(constraint_row.oid)
      ) > 0
  ) then
    raise exception 'restore omitted bounded Didit delivery-time evidence';
  end if;

  select string_agg(
    expected.schema_name || '.' || expected.relation_name,
    ', ' order by expected.schema_name, expected.relation_name
  )
  into v_missing
  from (values
    ('affiliate_private'::text, 'affiliate_access_credit_catalog'::text),
    ('affiliate_private', 'affiliate_access_credit_quotes'),
    ('affiliate_private', 'affiliate_access_credit_redemptions'),
    ('affiliate_private', 'affiliate_web_tax_policies'),
    ('public', 'cloud_access_grants')
  ) expected(schema_name, relation_name)
  left join pg_catalog.pg_namespace namespace
    on namespace.nspname = expected.schema_name
  left join pg_catalog.pg_class relation
    on relation.relnamespace = namespace.oid
    and relation.relname = expected.relation_name
    and relation.relkind in ('r', 'p')
  where relation.oid is null
    or pg_catalog.pg_get_userbyid(relation.relowner) <> current_user
    or not relation.relrowsecurity;
  if v_missing is not null then
    raise exception
      'frictionless relations lost controlled owner or RLS: %',
      v_missing;
  end if;

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
  v_expected record;
  v_unexpected text;
  v_definition text;
begin
  foreach v_signature in array array[
    'public.partners_service_dashboard(uuid,integer,text,text)',
    'public.partners_service_referral_claim(uuid,text,text)',
    'public.partners_service_kyc_binding_recover(integer)',
    'public.admin_partners_kyc_certification_preflight()',
    'public.admin_partners_kyc_certification_prepare(text,text,boolean,text,text,text)',
    'public.admin_partners_kyc_certification_resume()',
    'public.admin_partners_kyc_certification_status()',
    'public.admin_partners_deployment_manifest_register(text,text,text,text,jsonb,text)',
    'public.admin_partners_release_gate_approve(text,text,jsonb,jsonb,text,text,text,text,timestamp with time zone,text)',
    'public.partners_service_kyc_certification_create_claim(text)',
    'public.partners_service_kyc_certification_binding_match(text,text)',
    'public.partners_service_kyc_certification_session_record(text,text,text,integer,text,text,text,integer)',
    'public.partners_service_kyc_prepare_v2(uuid,text,text,text,boolean,text)',
    'public.partners_service_kyc_session_record_v3(uuid,text,text,text,integer,text,timestamp with time zone,text,text,text,integer,text)',
    'public.partners_service_kyc_webhook_apply_and_enqueue_purge(text,text,text,integer,text,timestamp with time zone,integer,text,boolean,boolean,boolean,text,text,text,text)',
    'public.partners_service_kyc_certification_webhook_apply_purge(text,text,text,integer,text,timestamp with time zone,integer,text,boolean,boolean,boolean,text,text,text,text)',
    'public.partners_service_didit_cert_review_apply_purge(text,text,text,integer,text,timestamp with time zone,timestamp with time zone,integer,text,boolean,boolean,boolean,text,text,text,text)',
    'public.partners_service_didit_purge_claim(integer,integer)',
    'public.partners_service_didit_purge_complete(bigint,uuid,text)',
    'public.partners_service_didit_purge_fail(bigint,uuid,text,integer,boolean,integer)',
    'public.partners_service_didit_purge_heartbeat(text,integer,integer,integer,integer)',
    'public.partners_service_didit_purge_status()',
    'public.partners_service_didit_purge_orphans(text,integer)',
    'public.partners_service_didit_purge_recover(text,text,text)',
    'public.partners_service_kyc_rights_get(uuid)',
    'public.partners_service_biometric_consent_withdraw(uuid,text)',
    'public.partners_service_kyc_human_review_request(uuid,text,text)',
    'public.admin_partners_kyc_human_review_queue(integer,integer,text)',
    'public.admin_partners_kyc_human_review_locator(text,text,text)',
    'public.admin_partners_kyc_human_review_decide(text,text,text,timestamp with time zone,text,text)',
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
       or v_signature like 'public.partners_service_didit_purge_%'
       or v_signature like 'public.partners_service_didit_cert_%'
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
      or v_signature like 'public.admin_partners_kyc_human_review_%'
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

  for v_expected in
    select *
    from (values
      ('affiliate_private.validate_affiliate_member_transition()', true, 'v', 'owner'),
      ('affiliate_private.guard_affiliate_member_active_links()', false, 'v', 'owner'),
      ('affiliate_private.guard_affiliate_auth_user_transition()', true, 'v', 'owner'),
      ('affiliate_private.validate_affiliate_link_transition()', false, 'v', 'owner'),
      ('affiliate_private.partners_service_member_write_reserve(uuid,text,text,text)', true, 'v', 'service_role'),
      ('affiliate_private.partners_account_deletion_ready(uuid)', true, 's', 'owner'),
      ('affiliate_private.partners_access_credit_balances(uuid)', true, 's', 'owner'),
      ('affiliate_private.partners_fx_source_amount_ceil(bigint,bigint,bigint)', false, 'i', 'owner'),
      ('affiliate_private.partners_access_credit_offer(uuid,integer)', true, 'v', 'owner'),
      ('affiliate_private.partners_account_balances(uuid)', true, 's', 'owner'),
      ('affiliate_private.partners_cash_readiness(uuid)', true, 's', 'owner'),
      ('affiliate_private.partners_service_join_v2(uuid,boolean,boolean,text)', true, 'v', 'service_role'),
      ('affiliate_private.partners_service_access_grants_reconcile(uuid)', true, 'v', 'service_role'),
      ('affiliate_private.reconcile_access_grants_after_projection()', true, 'v', 'owner'),
      ('affiliate_private.partners_service_access_credit_status(uuid)', true, 'v', 'service_role'),
      ('affiliate_private.partners_service_access_credit_quote(uuid,integer,text)', true, 'v', 'service_role'),
      ('affiliate_private.partners_service_access_credit_redeem(uuid,text,text)', true, 'v', 'service_role'),
      ('affiliate_private.partners_service_bootstrap_v2(uuid)', true, 's', 'service_role'),
      ('affiliate_private.partners_service_dashboard_v2(uuid,integer,text,text)', true, 'v', 'service_role'),
      ('affiliate_private.partners_service_referral_visibility(uuid,integer,text)', true, 's', 'service_role'),
      ('public.partners_service_referral_visibility(uuid,integer,text)', false, 's', 'service_role'),
      ('public.partners_service_bootstrap_v2(uuid)', false, 's', 'service_role'),
      ('public.partners_service_dashboard_v2(uuid,integer,text,text)', false, 'v', 'service_role'),
      ('public.partners_service_join_v2(uuid,boolean,boolean,text)', false, 'v', 'service_role'),
      ('public.partners_service_access_credit_quote(uuid,integer,text)', false, 'v', 'service_role'),
      ('public.partners_service_access_credit_redeem(uuid,text,text)', false, 'v', 'service_role'),
      ('public.partners_service_access_grants_reconcile(uuid)', false, 'v', 'service_role'),
      ('public.partners_service_access_credit_status(uuid)', false, 'v', 'service_role'),
      ('affiliate_private.partners_assert_kyc_cash_eligibility(uuid)', true, 'v', 'owner'),
      ('affiliate_private.partners_service_payout_country_bind(uuid,text,text)', true, 'v', 'service_role'),
      ('public.partners_service_payout_country_bind(uuid,text,text)', false, 'v', 'service_role'),
      ('affiliate_private.partners_service_rotate_link(uuid,text)', true, 'v', 'service_role'),
      ('public.partners_service_rotate_link(uuid,text)', false, 'v', 'service_role'),
      ('affiliate_private.partners_service_payout_profile_get(uuid)', true, 's', 'service_role'),
      ('public.partners_service_payout_profile_get(uuid)', false, 's', 'service_role'),
      ('affiliate_private.partners_service_fiscal_profile_self_attest(uuid,text,text,boolean,text)', true, 'v', 'service_role'),
      ('affiliate_private.partners_service_payout_onboarding_request(uuid,text,boolean,text)', true, 'v', 'service_role'),
      ('affiliate_private.admin_partners_revolut_manual_batch_prepare(text,text,text)', true, 'v', 'authenticated'),
      ('affiliate_private.partners_worker_web_tax_resolve(uuid,text,text,text,integer,bigint,text,timestamptz)', true, 'v', 'owner'),
      ('public.partners_worker_web_tax_resolve(uuid,text,text,text,integer,bigint,text,timestamptz)', true, 'v', 'service_role'),
      ('affiliate_private.is_managed_partners_flag(text)', false, 'i', 'owner'),
      ('affiliate_private.partners_require_control_access(text,text,boolean)', true, 's', 'owner'),
      ('public.admin_partners_control(text,text,boolean,text,uuid,text,text,timestamptz)', true, 'v', 'authenticated'),
      ('affiliate_private.admin_partners_program_activate_pre_aal2_20260802(text,text,text)', true, 'v', 'owner'),
      ('affiliate_private.admin_partners_program_activate(text,text,text)', true, 'v', 'authenticated'),
      ('affiliate_private.admin_partners_kyc_certification_preflight()', true, 's', 'authenticated'),
      ('public.admin_partners_kyc_certification_preflight()', false, 's', 'authenticated'),
      ('affiliate_private.partners_didit_cert_review_apply_purge(text,text,text,integer,text,timestamptz,timestamptz,integer,text,boolean,boolean,boolean,text,text,text,text)', true, 'v', 'service_role'),
      ('public.partners_service_didit_cert_review_apply_purge(text,text,text,integer,text,timestamptz,timestamptz,integer,text,boolean,boolean,boolean,text,text,text,text)', false, 'v', 'service_role')
    ) expected(signature, security_definer, volatility, access_role)
  loop
    if to_regprocedure(v_expected.signature) is null then
      raise exception 'restore omitted frictionless routine %',
        v_expected.signature;
    end if;
    if not exists (
      select 1
      from pg_catalog.pg_proc routine
      where routine.oid = to_regprocedure(v_expected.signature)
        and pg_catalog.pg_get_userbyid(routine.proowner) = current_user
        and routine.prosecdef = v_expected.security_definer
        and routine.provolatile = v_expected.volatility::"char"
        and 'search_path=""' = any(coalesce(routine.proconfig, '{}'::text[]))
    ) then
      raise exception 'frictionless routine metadata drifted: %',
        v_expected.signature;
    end if;
    if has_function_privilege('anon', v_expected.signature, 'EXECUTE')
      or (
        has_function_privilege(
          'authenticated', v_expected.signature, 'EXECUTE'
        ) <> (v_expected.access_role = 'authenticated')
      )
      or (
        has_function_privilege(
          'service_role', v_expected.signature, 'EXECUTE'
        ) <> (v_expected.access_role = 'service_role')
      )
    then
      raise exception 'frictionless routine ACL drifted: %',
        v_expected.signature;
    end if;
  end loop;

  if position(
      'partners_service_referral_visibility'
      in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
        'public.partners_service_dashboard_v2(uuid,integer,text,text)'
      )))
    ) = 0
    or position(
      '''referrals'''
      in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
        'public.partners_service_dashboard_v2(uuid,integer,text,text)'
      )))
    ) = 0
  then
    raise exception
      'restored Partners dashboard omitted the referral visibility projection';
  end if;

  if position(
      'p_limit > 50'
      in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
        'affiliate_private.partners_service_referral_visibility(uuid,integer,text)'
      )))
    ) = 0
    or position(
      'limit p_limit + 1'
      in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
        'affiliate_private.partners_service_referral_visibility(uuid,integer,text)'
      )))
    ) = 0
    or position(
      '''next_cursor'''
      in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
        'affiliate_private.partners_service_referral_visibility(uuid,integer,text)'
      )))
    ) = 0
    or position(
      'extensions.digest'
      in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
        'affiliate_private.partners_service_referral_visibility(uuid,integer,text)'
      )))
    ) = 0
    or position(
      'auth.users'
      in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
        'affiliate_private.partners_service_referral_visibility(uuid,integer,text)'
      )))
    ) = 0
    or position(
      'referred_user.email'
      in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
        'affiliate_private.partners_service_referral_visibility(uuid,integer,text)'
      )))
    ) = 0
    or position(
      '''masked_email'''
      in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
        'affiliate_private.partners_service_referral_visibility(uuid,integer,text)'
      )))
    ) = 0
    or regexp_count(
      lower(pg_catalog.pg_get_functiondef(to_regprocedure(
        'affiliate_private.partners_service_referral_visibility(uuid,integer,text)'
      ))),
      'and attribution\.referred_user_id is not null'
    ) <> 3
    or position(
      'where numbered.referred_user_id is not null'
      in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
        'affiliate_private.partners_service_referral_visibility(uuid,integer,text)'
      )))
    ) > 0
    or position(
      'repeat(''•'', 4)'
      in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
        'affiliate_private.partners_service_referral_visibility(uuid,integer,text)'
      )))
    ) = 0
    or position(
      '''referred_user_id'''
      in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
        'affiliate_private.partners_service_referral_visibility(uuid,integer,text)'
      )))
    ) > 0
  then
    raise exception
      'restored Partners referral projection lost its masked-email privacy boundary';
  end if;

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
    'public.partners_service_kyc_prepare(uuid,text,text,boolean,text)',
    'affiliate_private.partners_service_kyc_prepare(uuid,text,text,boolean,text)',
    'public.partners_service_kyc_session_record(uuid,text,text,text,integer,text,timestamp with time zone,text)',
    'public.partners_service_kyc_session_record(uuid,text,text,text,integer,text,timestamp with time zone,text,text,text,integer)',
    'affiliate_private.partners_service_kyc_session_record(uuid,text,text,text,integer,text,timestamp with time zone,text)',
    'affiliate_private.partners_service_kyc_session_record(uuid,text,text,text,integer,text,timestamp with time zone,text,text,text,integer)',
    'public.partners_service_kyc_session_record_v2(uuid,text,text,text,integer,text,timestamp with time zone,text,text,text,integer)',
    'affiliate_private.partners_service_kyc_session_record_v2(uuid,text,text,text,integer,text,timestamp with time zone,text,text,text,integer)',
    'public.partners_service_kyc_webhook_apply(text,text,text,integer,text,timestamp with time zone,integer,text,boolean,boolean,boolean,text,text,text)',
    'affiliate_private.partners_service_kyc_webhook_apply(text,text,text,integer,text,timestamp with time zone,integer,text,boolean,boolean,boolean,text,text,text)',
    'public.partners_service_kyc_certification_webhook_apply(text,text,text,integer,text,timestamp with time zone,integer,text,boolean,boolean,boolean,text,text,text)',
    'affiliate_private.partners_service_kyc_certification_webhook_apply(text,text,text,integer,text,timestamp with time zone,integer,text,boolean,boolean,boolean,text,text,text)'
  ]
  loop
    if has_function_privilege('service_role', v_signature, 'EXECUTE') then
      raise exception
        'legacy non-biometric KYC service routine remains callable: %',
        v_signature;
    end if;
  end loop;

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
        'restored sensitive Partners Admin mutation lost AAL2: %',
        v_signature;
    end if;
  end loop;

  foreach v_signature in array array[
    'affiliate_private.partners_service_kyc_certification_create_claim(text)',
    'affiliate_private.partners_service_kyc_certification_binding_match(text,text)',
    'affiliate_private.partners_service_kyc_certification_session_record(text,text,text,integer,text,text,text,integer)',
    'affiliate_private.partners_service_kyc_prepare_v2(uuid,text,text,text,boolean,text)',
    'affiliate_private.partners_service_kyc_session_record_v3(uuid,text,text,text,integer,text,timestamp with time zone,text,text,text,integer,text)',
    'affiliate_private.partners_service_kyc_webhook_apply_and_enqueue_purge(text,text,text,integer,text,timestamp with time zone,integer,text,boolean,boolean,boolean,text,text,text,text)',
    'affiliate_private.partners_service_kyc_certification_webhook_apply_and_enqueue_purge(text,text,text,integer,text,timestamp with time zone,integer,text,boolean,boolean,boolean,text,text,text,text)',
    'affiliate_private.partners_service_didit_purge_claim(integer,integer)',
    'affiliate_private.partners_service_didit_purge_complete(bigint,uuid,text)',
    'affiliate_private.partners_service_didit_purge_fail(bigint,uuid,text,integer,boolean,integer)',
    'affiliate_private.partners_service_didit_purge_heartbeat(text,integer,integer,integer,integer)',
    'affiliate_private.partners_service_didit_purge_status()',
    'affiliate_private.partners_service_didit_purge_orphans(text,integer)',
    'affiliate_private.partners_service_didit_purge_recover(text,text,text)',
    'affiliate_private.partners_service_kyc_rights_get(uuid)',
    'affiliate_private.partners_service_biometric_consent_withdraw(uuid,text)',
    'affiliate_private.partners_service_kyc_human_review_request(uuid,text,text)',
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
    'affiliate_private.partners_service_kyc_certification_webhook_apply_and_enqueue_pu(text,text,text,integer,text,timestamp with time zone,integer,text,boolean,boolean,boolean,text,text,text,text)'::regprocedure
  );
  if position('data.updated:%' in lower(v_definition)) = 0
    or position('v_session.status <> ''in_review''' in lower(v_definition)) = 0
    or position(
      'p_event_created_at <= v_session.last_event_created_at'
      in lower(v_definition)
    ) = 0
    or position(
      'didit certification review update is not admissible'
      in lower(v_definition)
    ) = 0
  then
    raise exception
      'restored Didit certification wrapper lost its fail-closed manual-review continuation';
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
    or position(
      'partners_release_gate_approval_is_current' in lower(v_definition)
    ) = 0
    or position('and gate.satisfied' in lower(v_definition)) > 0
  then
    raise exception
      'restored Didit certification pre-gate assertion lost current approval evidence or atomic row locks';
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
      'affiliate_private.guard_partners_release_gate_activation_aal2()'
    ) is null
  then
    raise exception
      'restore omitted the Partners release-gate AAL2 guard';
  end if;
  v_definition := pg_catalog.pg_get_functiondef(
    'affiliate_private.guard_partners_release_gate_activation_aal2()'::regprocedure
  );
  if position('old.satisfied is false' in lower(v_definition)) = 0
    or position('new.satisfied is true' in lower(v_definition)) = 0
    or position('partners_require_aal2' in lower(v_definition)) = 0
    or position('auth.uid() is not null' in lower(v_definition)) = 0
  then
    raise exception
      'restored Partners release-gate guard lost its false-to-true authenticated AAL2 contract';
  end if;
  if has_function_privilege(
      'anon',
      'affiliate_private.guard_partners_release_gate_activation_aal2()',
      'EXECUTE'
    )
    or has_function_privilege(
      'authenticated',
      'affiliate_private.guard_partners_release_gate_activation_aal2()',
      'EXECUTE'
    )
    or has_function_privilege(
      'service_role',
      'affiliate_private.guard_partners_release_gate_activation_aal2()',
      'EXECUTE'
    )
  then
    raise exception
      'restored Partners release-gate AAL2 guard became API-callable';
  end if;
  if not exists (
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
      and not trigger_row.tgisinternal
  ) then
    raise exception
      'restore omitted the enabled before-update Partners release-gate AAL2 trigger';
  end if;
  if not exists (
    select 1
    from pg_catalog.pg_trigger trigger_row
    where trigger_row.tgrelid =
        'affiliate_private.affiliate_release_gates'::regclass
      and trigger_row.tgname = 'affiliate_release_gates_approval_required'
      and trigger_row.tgfoid = to_regprocedure(
        'affiliate_private.guard_partners_release_gate_approval()'
      )
      and trigger_row.tgenabled = 'O'
      and not trigger_row.tgisinternal
  ) then
    raise exception
      'restore omitted the immutable approval-package release-gate guard';
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
    'affiliate_private.admin_partners_kyc_certification_preflight()'::regprocedure
  );
  if position(
      'partners_require_didit_certification_observer' in lower(v_definition)
    ) = 0
    or position(
      'partners_release_gate_approval_is_current' in lower(v_definition)
    ) = 0
    or position('and gate.satisfied' in lower(v_definition)) > 0
    or position('privacy_approved' in lower(v_definition)) = 0
    or position(
      'individual_verification_coverage_confirmed' in lower(v_definition)
    ) = 0
    or position('partners_enabled' in lower(v_definition)) = 0
    or position('partners_payouts_live' in lower(v_definition)) = 0
    or position('partners_tv_relay_enabled' in lower(v_definition)) = 0
    or position('partners_revolut_api_enabled' in lower(v_definition)) = 0
    or position('interval ''10 minutes''' in lower(v_definition)) = 0
  then
    raise exception
      'restored Didit certification preflight lost current approval evidence or its fail-closed readiness contract';
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
    'affiliate_private.partners_service_kyc_prepare_v2_pre_withdrawal_20260804(uuid,text,text,text,boolean,text)'::regprocedure
  );
  if position('partners-biometric-consent-v1' in lower(v_definition)) = 0
    or position(
      'affiliate_biometric_consent_attestations' in lower(v_definition)
    ) = 0
  then
    raise exception
      'restored KYC prepare v2 implementation lost explicit versioned biometric consent';
  end if;

  v_definition := pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_kyc_prepare_v2(uuid,text,text,text,boolean,text)'::regprocedure
  );
  if position(
      'affiliate_biometric_consent_withdrawals' in lower(v_definition)
    ) = 0
    or position(
      'partners_service_kyc_prepare_v2_pre_withdrawal_20260804'
      in lower(v_definition)
    ) = 0
  then
    raise exception
      'restored KYC prepare v2 lost withdrawal enforcement or guarded delegation';
  end if;

  v_definition := pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_biometric_consent_withdraw(uuid,text)'::regprocedure
  );
  if position('status = ''superseded''' in lower(v_definition)) = 0
    or position('kyc_biometric_consent_withdrawn' in lower(v_definition)) = 0
    or position('affiliate_biometric_consent_attestations' in lower(v_definition)) = 0
  then
    raise exception
      'restored biometric-consent withdrawal lost its pending-session stop or audit';
  end if;

  v_definition := pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_kyc_human_review_locator(text,text,text)'::regprocedure
  );
  if position(
      'partners_require_capability(''risk'')' in lower(v_definition)
    ) = 0
    or position('partners_require_aal2' in lower(v_definition)) = 0
    or position('lookup:' in lower(v_definition)) = 0
    or position(
      'kyc_human_review_locator_accessed' in lower(v_definition)
    ) = 0
  then
    raise exception
      'restored KYC human-review locator lost Risk, AAL2, confirmation or audit';
  end if;

  v_definition := pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_kyc_human_review_queue(integer,integer,text)'::regprocedure
  );
  if position('partners_require_capability(''risk'')' in lower(v_definition)) = 0
    or position('partners_public_account_id' in lower(v_definition)) = 0
  then
    raise exception
      'restored KYC human-review queue lost Risk authorization or pseudonymization';
  end if;

  v_definition := pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_kyc_human_review_decide(text,text,text,timestamp with time zone,text,text)'::regprocedure
  );
  if position(
      'partners_require_capability(''risk'')' in lower(v_definition)
    ) = 0
    or position('partners_require_aal2' in lower(v_definition)) = 0
    or position('p_evidence_sha256' in lower(v_definition)) = 0
    or position(
      'admin_partners_kyc_human_review_decide_pre_reverification_grant_20260804'
      in lower(v_definition)
    ) = 0
    or position(
      'kyc_human_review_reverification_granted' in lower(v_definition)
    ) = 0
  then
    raise exception
      'restored KYC human-review decision lost Risk, AAL2, evidence or atomic grant audit';
  end if;

  v_definition := pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_kyc_human_review_decide_pre_reverification_grant_20260804(text,text,text,timestamp with time zone,text,text)'::regprocedure
  );
  if position(
      'partners_require_capability(''risk'')' in lower(v_definition)
    ) = 0
    or position('partners_require_aal2' in lower(v_definition)) = 0
    or position('p_evidence_sha256' in lower(v_definition)) = 0
    or position('kyc_human_review_resolved' in lower(v_definition)) = 0
  then
    raise exception
      'restored inner KYC human-review decision lost Risk, AAL2, evidence or resolution audit';
  end if;

  v_definition := pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_kyc_session_record_v3(uuid,text,text,text,integer,text,timestamp with time zone,text,text,text,integer,text)'::regprocedure
  );
  if position(
      'partners_service_kyc_session_record_v3_pre_withdrawal_20260804'
      in lower(v_definition)
    ) = 0
    or position('pg_advisory_xact_lock' in lower(v_definition)) = 0
    or position('p_provider_session_envelope' in lower(v_definition)) = 0
    or position('partners_didit_purge_activate_staged' in lower(v_definition)) = 0
  then
    raise exception
      'restored active KYC session recorder lost withdrawal serialization or purge activation';
  end if;

  v_definition := pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_kyc_session_record_v3_pre_withdrawal_20260804(uuid,text,text,text,integer,text,timestamp with time zone,text,text,text,integer,text)'::regprocedure
  );
  if position('partners_service_kyc_session_record_v2' in lower(v_definition)) = 0
    or position('partners_didit_purge_stage_member' in lower(v_definition)) = 0
    or position('p_provider_session_envelope' in lower(v_definition)) = 0
    or position('p_provider_environment' in lower(v_definition)) = 0
  then
    raise exception
      'restored active KYC session recorder lost consent-bound purge staging';
  end if;

  v_definition := pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_kyc_session_record_v2(uuid,text,text,text,integer,text,timestamp with time zone,text,text,text,integer)'::regprocedure
  );
  if position(
      'affiliate_biometric_consent_attestations' in lower(v_definition)
    ) = 0
    or position('p_provider_environment' in lower(v_definition)) = 0
    or position('p_provider_config_fingerprint' in lower(v_definition)) = 0
    or position('p_provider_session_ttl_seconds' in lower(v_definition)) = 0
  then
    raise exception
      'restored inner KYC consent recorder lost consent or exact provider binding';
  end if;

  v_definition := pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_didit_purge_complete(bigint,uuid,text)'::regprocedure
  );
  if position('p_result not in (''deleted'', ''already_deleted'')' in lower(v_definition)) = 0
    or position('provider_session_envelope = null' in lower(v_definition)) = 0
    or position('partners_didit_purge_sync_source' in lower(v_definition)) = 0
    or position('partners_service_activation_reconcile' in lower(v_definition)) = 0
  then
    raise exception
      'restored Didit purge completion lost idempotent proof or data minimization';
  end if;

  v_definition := pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_didit_purge_orphans(text,integer)'::regprocedure
  );
  if position('p_limit not between 1 and 5' in lower(v_definition)) = 0
    or position('provider_purge_status = ''purge_pending''' in lower(v_definition)) = 0
    or position('affiliate_didit_session_registry' in lower(v_definition)) = 0
    or position('affiliate_didit_purge_outbox' in lower(v_definition)) = 0
  then
    raise exception
      'restored Didit purge orphan discovery lost its bounded exact-binding contract';
  end if;

  v_definition := pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_didit_purge_recover(text,text,text)'::regprocedure
  );
  if position('partners_didit_purge_enqueue' in lower(v_definition)) = 0
    or position('p_provider_session_envelope' in lower(v_definition)) = 0
    or position('p_provider_environment' in lower(v_definition)) = 0
  then
    raise exception
      'restored Didit purge orphan recovery bypasses the authoritative enqueue contract';
  end if;

  v_definition := pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_didit_purge_status()'::regprocedure
  );
  if position('programme_certification' in lower(v_definition)) > 0
    or position(
      '''certification''::text as session_purpose' in lower(v_definition)
    ) = 0
  then
    raise exception
      'restored Didit purge status uses a non-canonical certification purpose';
  end if;

  v_definition := pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_approval_package_is_current(uuid,text,text)'::regprocedure
  );
  if position('partners_didit_purge_coverage_ready' in lower(v_definition)) = 0
    or position(
      'individual_verification_coverage_confirmed' in lower(v_definition)
    ) = 0
  then
    raise exception
      'restored verification coverage approval ignores provider deletion proof';
  end if;

  v_definition := pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_approval_package_is_current(uuid,text)'::regprocedure
  );
  if position(
      'partners_approval_package_is_current(' in lower(v_definition)
    ) = 0
    or position('''production''' in lower(v_definition)) = 0
  then
    raise exception
      'restored approval compatibility wrapper lost production-scoped delegation';
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
            'affiliate_private.admin_partners_kyc_certification_preflight()',
            'affiliate_private.admin_partners_kyc_certification_prepare(text,text,boolean,text,text,text)',
            'affiliate_private.admin_partners_kyc_certification_resume()',
            'affiliate_private.admin_partners_kyc_certification_status()',
            'affiliate_private.admin_partners_deployment_manifest_register(text,text,text,text,jsonb,text)',
            'affiliate_private.admin_partners_release_gate_approve(text,text,jsonb,jsonb,text,text,text,text,timestamp with time zone,text)',
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
            'affiliate_private.admin_partners_revolut_payout_status_approval_registry()',
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
            'affiliate_private.admin_partners_kyc_human_review_queue(integer,integer,text)',
            'affiliate_private.admin_partners_kyc_human_review_locator(text,text,text)',
            'affiliate_private.admin_partners_kyc_human_review_decide(text,text,text,timestamp with time zone,text,text)',
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
  if (
    select count(*)
    from affiliate_private.affiliate_pilot_allowlist allowlist_row
    where allowlist_row.status = 'active'
      and (
        allowlist_row.expires_at is null
        or allowlist_row.expires_at > statement_timestamp()
      )
  ) > 50 then
    raise exception
      'restored Partners pilot exceeds the 50-member privacy boundary';
  end if;

  if (
    select count(*)
    from public.admin_feature_flags flag
    where flag.key = any(array[
      'partners_enabled', 'partners_invite_only',
      'partners_cash_pilot_allowlist_only', 'partners_earnings_enabled',
      'partners_credit_redemptions_enabled', 'partners_shadow_mode',
      'partners_payouts_live', 'partners_tv_relay_enabled',
      'partners_revolut_api_enabled'
    ]::text[])
      and affiliate_private.is_managed_partners_flag(flag.key)
  ) <> 9
    or affiliate_private.is_managed_partners_flag(
      'partners_unreviewed_sentinel'
    )
  then
    raise exception 'restore omitted or widened the nine managed Partners flags';
  end if;

  if not exists (
      select 1
      from affiliate_private.affiliate_release_gates gate
      where gate.gate_key = 'membership_privacy_approved'
    )
    or affiliate_private.partners_approval_required_document_keys(
      'membership_privacy_approved'
    ) <> array[
      'approval_record', 'deployment_proof', 'membership_privacy_notice',
      'membership_records_of_processing', 'membership_minimization_review'
    ]::text[]
    or affiliate_private.partners_approval_required_document_keys(
      'legal_and_tax_approved'
    ) <> array[
      'approval_record', 'deployment_proof', 'legal_tax_review',
      'owner_risk_acceptance', 'partners_terms', 'partners_disclosure',
      'tax_operating_policy'
    ]::text[]
  then
    raise exception 'restore omitted a Partners approval evidence contract';
  end if;

  if exists (
      select 1
      from public.admin_feature_flags flag
      where flag.key in (
        'partners_earnings_enabled',
        'partners_credit_redemptions_enabled'
      )
        and flag.enabled
        and not exists (
          select 1
          from public.admin_feature_flags membership_flag
          where membership_flag.key = 'partners_enabled'
            and membership_flag.enabled
        )
    )
    or exists (
      select 1
      from public.admin_feature_flags flag
      where flag.key = 'partners_cash_pilot_allowlist_only'
        and not flag.enabled
        and not affiliate_private.release_gates_satisfied(
          array['general_release_approved']::text[]
        )
    )
  then
    raise exception 'restored Partners feature state bypasses release dependencies';
  end if;

  if position(
      'partners_invite_only'
      in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
        'affiliate_private.partners_service_join_v2(uuid,boolean,boolean,text)'
      )))
    ) > 0
    or position(
      'partners_assert_kyc_cash_eligibility'
      in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
        'affiliate_private.partners_service_kyc_prepare_v2(uuid,text,text,text,boolean,text)'
      )))
    ) = 0
    or position(
      'partners_assert_kyc_cash_eligibility'
      in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
        'affiliate_private.partners_service_fiscal_profile_self_attest(uuid,text,text,boolean,text)'
      )))
    ) = 0
    or position(
      'partners_assert_kyc_cash_eligibility'
      in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
        'affiliate_private.partners_service_payout_onboarding_request(uuid,text,boolean,text)'
      )))
    ) = 0
    or position(
      'partners_cash_pilot_allowlist_only'
      in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
        'affiliate_private.admin_partners_revolut_manual_batch_prepare(text,text,text)'
      )))
    ) = 0
    or position(
      'membership_privacy_approved'
      in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
        'affiliate_private.guard_partners_program_approved_scope()'
      )))
    ) = 0
    or position(
      'membership_privacy_approved'
      in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
        'affiliate_private.admin_partners_program_activate_pre_aal2_20260802(text,text,text)'
      )))
    ) = 0
    or position(
      'partners_require_aal2'
      in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
        'affiliate_private.admin_partners_program_activate(text,text,text)'
      )))
    ) = 0
    or position(
      'admin_partners_program_activate_pre_aal2_20260802'
      in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
        'affiliate_private.admin_partners_program_activate(text,text,text)'
      )))
    ) = 0
  then
    raise exception 'restored frictionless membership or guarded cash contract drifted';
  end if;

  for v_expected in
    select *
    from (
      values
        (
          'affiliate_accounts_member_validate_transition',
          'affiliate_accounts',
          'validate_affiliate_member_transition',
          false
        ),
        (
          'affiliate_accounts_member_active_link_guard',
          'affiliate_accounts',
          'guard_affiliate_member_active_links',
          false
        ),
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
          'affiliate_biometric_consent_append_only',
          'affiliate_biometric_consent_attestations',
          'reject_partners_append_only_mutation',
          false
        ),
        (
          'affiliate_biometric_withdrawal_append_only',
          'affiliate_biometric_consent_withdrawals',
          'reject_partners_append_only_mutation',
          false
        ),
        (
          'affiliate_kyc_human_review_guard',
          'affiliate_kyc_human_review_requests',
          'guard_partners_kyc_human_review_mutation',
          false
        ),
        (
          'affiliate_didit_purge_events_append_only',
          'affiliate_didit_purge_events',
          'reject_partners_append_only_mutation',
          false
        ),
        (
          'affiliate_didit_purge_outbox_managed',
          'affiliate_didit_purge_outbox',
          'guard_didit_purge_managed_mutation',
          false
        ),
        (
          'affiliate_didit_purge_worker_state_managed',
          'affiliate_didit_purge_worker_state',
          'guard_didit_purge_managed_mutation',
          false
        ),
        (
          'affiliate_kyc_sessions_00_mark_purge_pending',
          'affiliate_kyc_sessions',
          'mark_member_didit_purge_pending',
          false
        ),
        (
          'affiliate_didit_certification_00_mark_purge_pending',
          'affiliate_didit_certification_sessions',
          'mark_certification_didit_purge_pending',
          false
        ),
        (
          'affiliate_accounts_00_didit_purge_guard',
          'affiliate_accounts',
          'guard_account_activation_until_didit_purged',
          false
        ),
        (
          'affiliate_events_00_didit_purge_activation_guard',
          'affiliate_events',
          'guard_didit_purge_activation_audit',
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

  if (
    select count(*)
    from pg_catalog.pg_trigger trigger_row
    join pg_catalog.pg_proc routine on routine.oid = trigger_row.tgfoid
    join pg_catalog.pg_namespace routine_namespace
      on routine_namespace.oid = routine.pronamespace
    where trigger_row.tgrelid =
        'public.cloud_entitlement_projection'::regclass
      and trigger_row.tgname in (
        'cloud_entitlement_projection_access_grants_insert',
        'cloud_entitlement_projection_access_grants_update'
      )
      and trigger_row.tgenabled = 'O'
      and not trigger_row.tgisinternal
      and routine_namespace.nspname = 'affiliate_private'
      and routine.proname = 'reconcile_access_grants_after_projection'
      and trigger_row.tgtype = case trigger_row.tgname
        when 'cloud_entitlement_projection_access_grants_insert' then 5
        else 17
      end
  ) <> 2 then
    raise exception
      'restore omitted or rewired the two access-grant projection triggers';
  end if;

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
        'affiliate_didit_certification_sessions_binding'
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

  select count(*)
  into v_bad_entries
  from (
    select session.id
    from affiliate_private.affiliate_kyc_sessions session
    where session.provider_session_hash is not null
      and session.status <> 'pending'
      and session.provider_purge_status = 'not_required'

    union all

    select session.id
    from affiliate_private.affiliate_didit_certification_sessions session
    where session.provider_session_hash is not null
      and session.status in ('approved', 'declined', 'expired', 'quarantined')
      and session.provider_purge_status = 'not_required'
  ) unresolved_terminal_source;
  if v_bad_entries <> 0 then
    raise exception
      'restored Didit state contains % terminal sessions without deletion disposition',
      v_bad_entries;
  end if;

  select count(*)
  into v_bad_entries
  from affiliate_private.affiliate_didit_purge_outbox outbox
  left join affiliate_private.affiliate_didit_session_registry registry
    on registry.provider_session_hash = outbox.provider_session_hash
  where registry.provider_session_hash is null
    or (
      outbox.status = 'succeeded'
      and (
        outbox.provider_session_envelope is not null
        or outbox.purged_at is null
      )
    );
  if v_bad_entries <> 0 then
    raise exception
      'restored Didit purge outbox contains % orphaned or non-minimized rows',
      v_bad_entries;
  end if;

  if not exists (
    select 1
    from affiliate_private.affiliate_didit_purge_worker_state worker
    where worker.worker_name = 'didit_purge'
  ) then
    raise exception 'restore omitted the Didit purge worker state singleton';
  end if;

  select count(*)
  into v_bad_entries
  from affiliate_private.affiliate_biometric_consent_withdrawals withdrawal
  where not exists (
    select 1
    from affiliate_private.affiliate_biometric_consent_attestations consent
    where consent.account_id = withdrawal.account_id
      and consent.biometric_consent_version =
        withdrawal.biometric_consent_version
      and consent.consented_at <= withdrawal.withdrawn_at
  );
  if v_bad_entries <> 0 then
    raise exception
      'restored biometric-consent withdrawals contain % ungrounded rows',
      v_bad_entries;
  end if;

  select count(*)
  into v_bad_entries
  from affiliate_private.affiliate_kyc_human_review_requests review
  join affiliate_private.affiliate_kyc_sessions session
    on session.id = review.session_id
  where session.account_id <> review.account_id;
  if v_bad_entries <> 0 then
    raise exception
      'restored KYC human-review queue contains % cross-account rows',
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

  if not exists (
      select 1
      from affiliate_private.affiliate_access_credit_catalog catalog
      where catalog.catalog_key = 'acc_p0_usd_plus_month_v1'
        and catalog.status = 'active'
        and catalog.plan_code = 'plus'
        and catalog.currency = 'USD'
        and catalog.currency_exponent = 2
        and catalog.unit_amount_minor = 499
        and catalog.unit_duration_days = 30
        and catalog.minimum_months = 1
        and catalog.maximum_months = 12
    )
    or not exists (
      select 1
      from pg_catalog.pg_index index_row
      where index_row.indexrelid = to_regclass(
        'affiliate_private.affiliate_access_credit_catalog_one_active_idx'
      )
        and index_row.indisunique
        and index_row.indisvalid
        and index_row.indisready
    )
    or not exists (
      select 1
      from pg_catalog.pg_constraint constraint_row
      where constraint_row.conrelid =
        'affiliate_private.affiliate_commission_entries'::regclass
        and constraint_row.conname = 'affiliate_commission_entries_kind'
        and constraint_row.convalidated
        and pg_catalog.pg_get_constraintdef(constraint_row.oid)
          like '%access_credit_redemption%'
    )
    or not exists (
      select 1
      from pg_catalog.pg_constraint constraint_row
      where constraint_row.conrelid =
        'affiliate_private.affiliate_commission_postings'::regclass
        and constraint_row.conname = 'affiliate_commission_postings_account'
        and constraint_row.convalidated
        and pg_catalog.pg_get_constraintdef(constraint_row.oid)
          like '%partner_access_credit_clearing%'
    )
    or not exists (
      select 1
      from information_schema.columns column_row
      where column_row.table_schema = 'affiliate_private'
        and column_row.table_name = 'affiliate_access_credit_quotes'
        and column_row.column_name = 'reference_total_amount_minor'
        and column_row.is_nullable = 'NO'
    )
    or not exists (
      select 1
      from information_schema.columns column_row
      where column_row.table_schema = 'affiliate_private'
        and column_row.table_name = 'affiliate_access_credit_redemptions'
        and column_row.column_name = 'reference_amount_minor'
        and column_row.is_nullable = 'NO'
    )
    or position(
      'affiliate_fx_rate_snapshots'
      in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
        'affiliate_private.partners_access_credit_offer(uuid,integer)'
      )))
    ) = 0
    or position(
      'partners_cash_readiness'
      in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
        'affiliate_private.partners_service_access_credit_redeem(uuid,text,text)'
      )))
    ) > 0
  then
    raise exception 'restore omitted the exact multi-currency access-credit contract';
  end if;

  if not exists (
      select 1
      from affiliate_private.affiliate_web_tax_policies policy
      where policy.policy_key = 'wtp_fr_usd_owner_v1'
        and policy.status = 'active'
        and policy.country_code = 'FR'
        and policy.currency = 'USD'
        and policy.currency_exponent = 2
        and policy.calculation_mode = 'gross_is_net'
        and policy.tax_rate_bps = 0
        and policy.approved_by_role = 'accountable_owner'
        and not policy.external_review
        and policy.effective_until <=
          policy.effective_from + interval '90 days'
    )
    or has_function_privilege(
      'anon',
      'public.partners_worker_web_tax_resolve(uuid,text,text,text,integer,bigint,text,timestamptz)',
      'EXECUTE'
    )
    or has_function_privilege(
      'authenticated',
      'public.partners_worker_web_tax_resolve(uuid,text,text,text,integer,bigint,text,timestamptz)',
      'EXECUTE'
    )
    or not has_function_privilege(
      'service_role',
      'public.partners_worker_web_tax_resolve(uuid,text,text,text,integer,bigint,text,timestamptz)',
      'EXECUTE'
    )
    or position(
      'financial_fact_unavailable'
      in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
        'affiliate_private.partners_worker_web_tax_resolve(uuid,text,text,text,integer,bigint,text,timestamptz)'
      )))
    ) = 0
  then
    raise exception 'restore omitted the fail-closed Web tax contract';
  end if;

  select count(*)
  into v_bad_entries
  from affiliate_private.affiliate_accounts account
  left join auth.users cloud_user on cloud_user.id = account.user_id
  left join affiliate_private.affiliate_program_versions program
    on program.id = account.member_program_version_id
  where account.member_status = 'active'
    and (
      cloud_user.id is null
      or cloud_user.email_confirmed_at is null
      or program.id is null
      or program.status <> 'active'
      or program.account_type <> 'individual'
      or program.commission_rate_bps <> 2000
      or program.attribution_window_days <> 30
      or program.maturation_days <> 45
      or account.member_terms_version_accepted
        is distinct from program.terms_version
      or account.member_disclosure_version_accepted
        is distinct from program.disclosure_version
    );
  if v_bad_entries > 0 then
    raise exception
      'restored membership contains % invalid active members',
      v_bad_entries;
  end if;

  select count(*)
  into v_bad_entries
  from affiliate_private.affiliate_links link
  join affiliate_private.affiliate_accounts account
    on account.id = link.account_id
  where link.status = 'active'
    and account.member_status <> 'active';
  if v_bad_entries > 0 then
    raise exception
      'restored membership contains % active links for inactive members',
      v_bad_entries;
  end if;

  select count(*)
  into v_bad_entries
  from affiliate_private.affiliate_access_credit_redemptions redemption
  join affiliate_private.affiliate_access_credit_quotes quote
    on quote.id = redemption.quote_id
  join affiliate_private.affiliate_accounts account
    on account.id = redemption.account_id
  join affiliate_private.affiliate_commission_entries entry
    on entry.id = redemption.ledger_entry_id
  join public.cloud_access_grants grant_row
    on grant_row.redemption_id = redemption.id
  where quote.account_id <> redemption.account_id
    or quote.status <> 'redeemed'
    or quote.currency <> redemption.currency
    or quote.currency_exponent <> redemption.currency_exponent
    or quote.months <> redemption.months
    or quote.total_amount_minor <> redemption.amount_minor
    or quote.reference_currency <> redemption.reference_currency
    or quote.reference_currency_exponent <>
      redemption.reference_currency_exponent
    or quote.reference_total_amount_minor <> redemption.reference_amount_minor
    or quote.fx_rate_snapshot_id is distinct from redemption.fx_rate_snapshot_id
    or quote.duration_days <> redemption.duration_days
    or entry.account_id <> redemption.account_id
    or entry.entry_kind <> 'access_credit_redemption'
    or entry.currency <> redemption.currency
    or entry.currency_exponent <> redemption.currency_exponent
    or entry.amount_minor <> redemption.amount_minor
    or grant_row.plan_code <> redemption.plan_code
    or grant_row.duration_seconds <> redemption.duration_days::bigint * 86400
    or grant_row.user_pseudonym <> account.user_pseudonym
    or (
      grant_row.user_id is not null
      and grant_row.user_id is distinct from account.user_id
    );
  if v_bad_entries > 0 then
    raise exception
      'restored access-credit mapping contains % inconsistent grants',
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
