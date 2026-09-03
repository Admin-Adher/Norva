\set ON_ERROR_STOP on

-- This gate is deliberately read-only. It proves that the lifecycle schema is
-- installed in its fail-closed state before any Edge restart or audience test.
begin transaction read only;

do $gate$
declare
  v_missing text[];
  v_invalid text[];
begin
  select array_agg(name order by name) into v_missing
  from unnest(array[
    'public.behavioral_lifecycle_runtime',
    'public.behavioral_lifecycle_journeys',
    'public.behavioral_lifecycle_steps',
    'public.behavioral_lifecycle_user_state',
    'public.behavioral_lifecycle_outbox',
    'public.behavioral_lifecycle_experiment_versions',
    'public.behavioral_lifecycle_delivery_events',
    'public.behavioral_lifecycle_funnel_events',
    'public.behavioral_lifecycle_import_readiness',
    'public.behavioral_lifecycle_admin_audit'
  ]::text[]) as required(name)
  where to_regclass(name) is null;
  if coalesce(cardinality(v_missing), 0) <> 0 then
    raise exception 'lifecycle readiness: missing relations: %', v_missing;
  end if;

  select array_agg(signature order by signature) into v_missing
  from unnest(array[
    'public.norva_capture_behavioral_source_attempt(uuid,text,text,text,text,text,uuid)',
    'public.norva_behavioral_lifecycle_tick(integer,integer)',
    'public.norva_claim_behavioral_deliveries(text,integer,integer)',
    'public.norva_authorize_behavioral_push(uuid,uuid)',
    'public.norva_complete_behavioral_push(uuid,uuid,integer,integer,integer,boolean,text)',
    'public.norva_enqueue_behavioral_email(uuid,uuid,text,text,text,text,text,text,jsonb,jsonb)',
    'public.norva_fail_behavioral_email_enqueue(uuid,uuid,text)',
    'public.norva_authorize_behavioral_email_enqueue(uuid,uuid)',
    'public.norva_record_behavioral_delivery_event(uuid,uuid,text)',
    'public.admin_behavioral_lifecycle_overview(integer)',
    'public.admin_record_behavioral_import_readiness(text,text,text,text,boolean,boolean,boolean,boolean,boolean,text)',
    'public.admin_update_behavioral_lifecycle_runtime(boolean,text,text,text)',
    'public.admin_update_behavioral_lifecycle_journey(text,text,integer,integer,text[],text,integer,integer,integer,integer,integer,integer,text,text,text,integer,numeric)',
    'public.admin_update_behavioral_lifecycle_step(text,text,text,integer,text,text,text,text,integer,boolean,boolean,boolean,text)',
    'public.admin_retry_behavioral_lifecycle_delivery(uuid,text,text)'
  ]::text[]) as required(signature)
  where to_regprocedure(signature) is null;
  if coalesce(cardinality(v_missing), 0) <> 0 then
    raise exception 'lifecycle readiness: missing RPCs: %', v_missing;
  end if;

  if to_regprocedure(
       'public.norva_behavioral_step_copy_safe(text,text,text,text,text,boolean)'
     ) is null then
    raise exception 'lifecycle readiness: outbound-copy gate is missing';
  end if;
  if has_function_privilege(
       'anon',
       'public.norva_behavioral_step_copy_safe(text,text,text,text,text,boolean)',
       'EXECUTE'
     ) or has_function_privilege(
       'authenticated',
       'public.norva_behavioral_step_copy_safe(text,text,text,text,text,boolean)',
       'EXECUTE'
     ) or not has_function_privilege(
       'service_role',
       'public.norva_behavioral_step_copy_safe(text,text,text,text,text,boolean)',
       'EXECUTE'
     ) then
    raise exception 'lifecycle readiness: outbound-copy gate grants drifted';
  end if;

  select array_agg(table_name || ':' || constraint_name order by table_name)
    into v_missing
  from (values
    ('behavioral_lifecycle_steps', 'behavioral_lifecycle_steps_safe_copy_check'),
    ('behavioral_lifecycle_outbox', 'behavioral_lifecycle_outbox_safe_copy_check')
  ) as required(table_name, constraint_name)
  where not exists (
    select 1
    from pg_catalog.pg_constraint con
    join pg_catalog.pg_class rel on rel.oid = con.conrelid
    join pg_catalog.pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = required.table_name
      and con.conname = required.constraint_name
      and con.contype = 'c'
      and con.convalidated
  );
  if coalesce(cardinality(v_missing), 0) <> 0 then
    raise exception 'lifecycle readiness: outbound-copy constraints missing: %', v_missing;
  end if;

  select array_agg(format('%I.%I', n.nspname, c.relname) order by c.relname)
    into v_invalid
  from unnest(array[
    'public.behavioral_lifecycle_runtime',
    'public.behavioral_lifecycle_journeys',
    'public.behavioral_lifecycle_steps',
    'public.behavioral_lifecycle_user_state',
    'public.behavioral_lifecycle_outbox',
    'public.behavioral_lifecycle_experiment_versions',
    'public.behavioral_lifecycle_delivery_events',
    'public.behavioral_lifecycle_funnel_events',
    'public.behavioral_lifecycle_import_readiness',
    'public.behavioral_lifecycle_admin_audit'
  ]::text[]) as required(name)
  join pg_class c on c.oid = to_regclass(required.name)
  join pg_namespace n on n.oid = c.relnamespace
  where not c.relrowsecurity;
  if coalesce(cardinality(v_invalid), 0) <> 0 then
    raise exception 'lifecycle readiness: RLS disabled: %', v_invalid;
  end if;

  select array_agg(
    role_name || ':' || relation_name || ':' || privilege_name
    order by role_name, relation_name, privilege_name
  ) into v_invalid
  from unnest(array['anon', 'authenticated']::text[]) as roles(role_name)
  cross join unnest(array[
    'public.behavioral_lifecycle_runtime',
    'public.behavioral_lifecycle_journeys',
    'public.behavioral_lifecycle_steps',
    'public.behavioral_lifecycle_user_state',
    'public.behavioral_lifecycle_outbox',
    'public.behavioral_lifecycle_experiment_versions',
    'public.behavioral_lifecycle_delivery_events',
    'public.behavioral_lifecycle_funnel_events',
    'public.behavioral_lifecycle_import_readiness',
    'public.behavioral_lifecycle_admin_audit'
  ]::text[]) as relations(relation_name)
  cross join unnest(array[
    'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
  ]::text[]) as privileges(privilege_name)
  where has_table_privilege(role_name, relation_name, privilege_name);
  if coalesce(cardinality(v_invalid), 0) <> 0 then
    raise exception 'lifecycle readiness: browser table privilege exposed: %', v_invalid;
  end if;

  select array_agg(relation_name order by relation_name) into v_missing
  from unnest(array[
    'public.behavioral_lifecycle_runtime',
    'public.behavioral_lifecycle_journeys',
    'public.behavioral_lifecycle_steps',
    'public.behavioral_lifecycle_user_state',
    'public.behavioral_lifecycle_outbox',
    'public.behavioral_lifecycle_experiment_versions',
    'public.behavioral_lifecycle_delivery_events',
    'public.behavioral_lifecycle_funnel_events',
    'public.behavioral_lifecycle_import_readiness',
    'public.behavioral_lifecycle_admin_audit'
  ]::text[]) as relations(relation_name)
  where not has_table_privilege('service_role', relation_name, 'SELECT');
  if coalesce(cardinality(v_missing), 0) <> 0 then
    raise exception 'lifecycle readiness: service role cannot read: %', v_missing;
  end if;

  if not has_table_privilege(
       'service_role', 'public.behavioral_lifecycle_import_readiness', 'INSERT'
     ) or has_table_privilege(
       'service_role', 'public.behavioral_lifecycle_import_readiness', 'UPDATE'
     ) or has_table_privilege(
       'service_role', 'public.behavioral_lifecycle_import_readiness', 'DELETE'
     ) or has_table_privilege(
       'service_role', 'public.behavioral_lifecycle_import_readiness', 'TRUNCATE'
     ) or has_table_privilege(
       'service_role', 'public.behavioral_lifecycle_import_readiness', 'REFERENCES'
     ) or has_table_privilege(
       'service_role', 'public.behavioral_lifecycle_import_readiness', 'TRIGGER'
     ) then
    raise exception 'lifecycle readiness: import attestation is not append-only';
  end if;

  select array_agg(signature order by signature) into v_missing
  from unnest(array[
    'public.norva_capture_behavioral_source_attempt(uuid,text,text,text,text,text,uuid)',
    'public.norva_behavioral_lifecycle_tick(integer,integer)',
    'public.norva_claim_behavioral_deliveries(text,integer,integer)',
    'public.norva_authorize_behavioral_push(uuid,uuid)',
    'public.norva_complete_behavioral_push(uuid,uuid,integer,integer,integer,boolean,text)',
    'public.norva_enqueue_behavioral_email(uuid,uuid,text,text,text,text,text,text,jsonb,jsonb)',
    'public.norva_fail_behavioral_email_enqueue(uuid,uuid,text)',
    'public.norva_authorize_behavioral_email_enqueue(uuid,uuid)',
    'public.norva_record_behavioral_delivery_event(uuid,uuid,text)',
    'public.admin_behavioral_lifecycle_overview(integer)',
    'public.admin_record_behavioral_import_readiness(text,text,text,text,boolean,boolean,boolean,boolean,boolean,text)',
    'public.admin_update_behavioral_lifecycle_runtime(boolean,text,text,text)',
    'public.admin_update_behavioral_lifecycle_journey(text,text,integer,integer,text[],text,integer,integer,integer,integer,integer,integer,text,text,text,integer,numeric)',
    'public.admin_update_behavioral_lifecycle_step(text,text,text,integer,text,text,text,text,integer,boolean,boolean,boolean,text)',
    'public.admin_retry_behavioral_lifecycle_delivery(uuid,text,text)'
  ]::text[]) as functions(signature)
  where not has_function_privilege('service_role', signature, 'EXECUTE');
  if coalesce(cardinality(v_missing), 0) <> 0 then
    raise exception 'lifecycle readiness: service role cannot execute: %', v_missing;
  end if;

  select array_agg(
    format('%I.%I:%I', schema_name, table_name, trigger_name)
    order by schema_name, table_name, trigger_name
  ) into v_missing
  from (values
    ('public', 'behavioral_lifecycle_outbox', 'behavioral_lifecycle_outbox_funnel_log'),
    ('public', 'behavioral_lifecycle_outbox', 'behavioral_lifecycle_outbox_state_log'),
    ('auth', 'users', 'norva_capture_behavioral_signup_after_insert'),
    ('public', 'cloud_signup_attribution', 'norva_sync_behavioral_signup_context_change'),
    ('public', 'cloud_profiles', 'norva_sync_behavioral_profile_context_change'),
    ('public', 'cloud_sources', 'norva_sync_behavioral_source_state_change'),
    ('public', 'cloud_playback_events', 'norva_sync_behavioral_playback_state_insert'),
    ('public', 'cloud_watch_history', 'norva_sync_behavioral_resume_state_change'),
    ('public', 'cloud_content_events', 'norva_sync_behavioral_new_content_state_insert'),
    ('public', 'cloud_entitlement_projection', 'norva_sync_behavioral_entitlement_state_change'),
    ('public', 'cloud_marketing_email_preferences', 'norva_sync_behavioral_marketing_preference_change'),
    ('public', 'cloud_branded_email_outbox', 'norva_sync_behavioral_email_state_change')
  ) as required(schema_name, table_name, trigger_name)
  where not exists (
    select 1
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = required.schema_name
      and c.relname = required.table_name
      and t.tgname = required.trigger_name
      and not t.tgisinternal
  );
  if coalesce(cardinality(v_missing), 0) <> 0 then
    raise exception 'lifecycle readiness: missing triggers: %', v_missing;
  end if;

  if not exists (
    select 1
    from public.behavioral_lifecycle_runtime
    where singleton and emergency_stop and audience_mode = 'internal_test'
  ) or (select count(*) from public.behavioral_lifecycle_runtime) <> 1 then
    raise exception 'lifecycle readiness: runtime is not uniquely stopped in internal_test mode';
  end if;

  if (select array_agg(journey_key order by journey_key)
      from public.behavioral_lifecycle_journeys) is distinct from array[
        'catalog_ready_no_first_play', 'continue_watching',
        'import_unresolved', 'no_source'
      ]::text[] then
    raise exception 'lifecycle readiness: the four reviewed journeys are not exact';
  end if;
  if exists (
    select 1 from public.behavioral_lifecycle_journeys
    where status <> 'draft'
       or rollout_percent <> 0
       or holdout_percent <> 10
       or country_allowlist is distinct from array['IN', 'BD']::text[]
       or experiment_variable <> 'baseline'
       or activated_at is not null
       or activated_by is not null
  ) then
    raise exception 'lifecycle readiness: a journey is not in the reviewed fail-closed seed state';
  end if;

  if (select count(*) from public.behavioral_lifecycle_steps) <> 11 then
    raise exception 'lifecycle readiness: expected exactly eleven reviewed steps';
  end if;
  if exists (
    select 1
    from public.behavioral_lifecycle_steps st
    where not public.norva_behavioral_step_copy_safe(
      st.journey_key, st.title, st.body, st.cta_label,
      st.deep_link, st.requires_new_content
    )
  ) then
    raise exception 'lifecycle readiness: reviewed outbound copy is unsafe';
  end if;
  if exists (
    select 1
    from (values
      ('no_source', 'context_help', 1, 'in_app', 15, 'Connect your TV service', 'Add your M3U link or Xtream details to build your catalogue.', 'Connect a source', '/app.html#settings/sources', 259200, false),
      ('no_source', 'day_one_push', 2, 'push', 1440, 'Your Norva catalogue is one step away', 'Connect your M3U link or Xtream details to start watching.', 'Connect a source', '/app.html#settings/sources', 172800, false),
      ('no_source', 'day_three_email', 3, 'email', 4320, 'Need help connecting your TV service?', 'Open the source screen and use the M3U link or Xtream details supplied by your TV service.', 'Open source setup', '/app.html#settings/sources', 259200, false),
      ('import_unresolved', 'error_help', 1, 'in_app', 0, 'Let’s fix this connection', 'Review the source format and try again from the same import screen.', 'Review source', '/app.html#settings/sources', 86400, false),
      ('import_unresolved', 'two_hour_push', 2, 'push', 120, 'Your source still needs attention', 'Return to Norva to review the M3U or Xtream details and retry safely.', 'Review source', '/app.html#settings/sources', 86400, false),
      ('import_unresolved', 'day_one_email', 3, 'email', 1440, 'How to finish your Norva import', 'Choose M3U when you received a playlist link, or Xtream when you received a server address, username and password.', 'Finish the import', '/app.html#settings/sources', 172800, false),
      ('catalog_ready_no_first_play', 'ready_in_app', 1, 'in_app', 0, 'Your catalogue is ready', 'Open Norva and choose something to watch.', 'Browse the catalogue', '/app.html#home', 86400, false),
      ('catalog_ready_no_first_play', 'four_hour_push', 2, 'push', 240, 'Your catalogue is ready', 'Open Norva and choose something from your catalogue.', 'Start watching', '/app.html#home', 86400, false),
      ('catalog_ready_no_first_play', 'day_two_push', 3, 'push', 2880, 'Ready for your first watch?', 'Open your Norva catalogue and start on any screen.', 'Start watching', '/app.html#home', 86400, false),
      ('continue_watching', 'two_day_push', 1, 'push', 2880, 'Continue where you left off', 'Your progress is saved. Open Norva to keep watching.', 'Continue watching', '/app.html#home/resume', 86400, false),
      ('continue_watching', 'new_content_week_push', 2, 'push', 10080, 'New content is waiting', 'Your catalogue has changed since your last watch. See what is new.', 'Open Norva', '/app.html#home', 86400, true)
    ) as expected(
      journey_key, step_key, ordinal, channel, delay_minutes, title, body,
      cta_label, deep_link, ttl_seconds, requires_new_content
    )
    left join public.behavioral_lifecycle_steps actual
      on actual.journey_key = expected.journey_key
     and actual.step_key = expected.step_key
    where actual.journey_key is null
       or actual.ordinal <> expected.ordinal
       or actual.channel <> expected.channel
       or actual.delay_minutes <> expected.delay_minutes
       or actual.title <> expected.title
       or actual.body <> expected.body
       or actual.cta_label <> expected.cta_label
       or actual.deep_link <> expected.deep_link
       or actual.ttl_seconds <> expected.ttl_seconds
       or actual.requires_new_content <> expected.requires_new_content
       or not actual.enabled
       or actual.is_marketing
       or actual.collapse_key <> 'lifecycle-' || replace(expected.journey_key, '_', '-')
  ) then
    raise exception 'lifecycle readiness: reviewed step configuration drifted';
  end if;

  if exists (select 1 from public.behavioral_lifecycle_experiment_versions)
     or exists (select 1 from public.behavioral_lifecycle_outbox)
     or exists (select 1 from public.behavioral_lifecycle_delivery_events)
     or exists (select 1 from public.behavioral_lifecycle_funnel_events)
     or exists (
       select 1 from public.cloud_content_events
       where kind = 'behavioral_lifecycle'
     ) then
    raise exception 'lifecycle readiness: pre-activation message or experiment backlog is not empty';
  end if;
end
$gate$;

select jsonb_build_object(
  'status', 'BEHAVIORAL_LIFECYCLE_PRE_ACTIVATION_READY',
  'relations', 10,
  'rpcs', 15,
  'triggers', 12,
  'journeys', (select count(*) from public.behavioral_lifecycle_journeys),
  'steps', (select count(*) from public.behavioral_lifecycle_steps),
  'projected_accounts', (select count(*) from public.behavioral_lifecycle_user_state),
  'emergency_stop', (
    select emergency_stop from public.behavioral_lifecycle_runtime where singleton
  ),
  'audience_mode', (
    select audience_mode from public.behavioral_lifecycle_runtime where singleton
  )
) as readiness;

rollback;
