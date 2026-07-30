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

  foreach v_name in array array[
    'affiliate_accounts',
    'affiliate_links',
    'affiliate_events',
    'affiliate_kyc_sessions',
    'affiliate_link_claims',
    'affiliate_attributions',
    'affiliate_financial_facts',
    'affiliate_financial_fact_observations',
    'affiliate_financial_fact_conflicts',
    'affiliate_commission_entries',
    'affiliate_commission_postings',
    'affiliate_payout_cycles',
    'affiliate_payout_items',
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
      values ('anon'::text), ('authenticated'::text)
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
      values ('anon'::text), ('authenticated'::text)
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
begin
  foreach v_signature in array array[
    'public.partners_service_dashboard(uuid,integer,text,text)',
    'public.partners_service_referral_claim(uuid,text,text)',
    'public.partners_worker_shadow_reconcile(text,timestamp with time zone,timestamp with time zone,boolean)',
    'public.admin_partners_analytics(integer)',
    'public.admin_partners_monitoring()'
  ]
  loop
    if to_regprocedure(v_signature) is null then
      raise exception 'restore omitted routine %', v_signature;
    end if;
  end loop;

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
            'affiliate_private.admin_partners_capabilities()',
            'affiliate_private.admin_partners_capability_set(uuid,text,boolean,text)',
            'affiliate_private.admin_partners_program_create(text,jsonb,text,text,timestamp with time zone,text)',
            'affiliate_private.admin_partners_program_activate(text,text,text)',
            'affiliate_private.admin_partners_country_policy_create(text,text,text,integer,text[],timestamp with time zone,text)',
            'affiliate_private.admin_partners_kyc_attempt_policy_set(text,text,text,integer,integer,integer,text,text)',
            'affiliate_private.admin_partners_country_mapping_set(text,text,text,text)',
            'affiliate_private.admin_partners_currency_set(text,integer,text,text)',
            'affiliate_private.admin_partners_payout_provider_set(text,text,text,text,text)',
            'affiliate_private.admin_partners_country_policy_set_available(text,text,text,boolean,text,text)',
            'affiliate_private.admin_partners_fiscal_review(uuid,text,text,text,text,text,text)',
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
  v_trigger text;
  v_bad_entries bigint;
begin
  foreach v_trigger in array array[
    'affiliate_events_append_only',
    'affiliate_financial_facts_append_only',
    'affiliate_financial_fact_observations_append_only',
    'affiliate_financial_fact_conflicts_append_only',
    'affiliate_financial_fact_lineage_links_append_only',
    'affiliate_commission_entries_append_only',
    'affiliate_commission_postings_append_only',
    'affiliate_commission_entry_balance_on_entry',
    'affiliate_commission_entry_balance_on_posting'
  ]
  loop
    if not exists (
      select 1
      from pg_catalog.pg_trigger t
      where t.tgname = v_trigger
        and not t.tgisinternal
        and t.tgenabled <> 'D'
    ) then
      raise exception 'restore omitted or disabled trigger %', v_trigger;
    end if;
  end loop;

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
  'commission_entries', (
    select count(*) from affiliate_private.affiliate_commission_entries
  ),
  'payout_cycles', (
    select count(*) from affiliate_private.affiliate_payout_cycles
  )
) as partners_restore_verification;

commit;
