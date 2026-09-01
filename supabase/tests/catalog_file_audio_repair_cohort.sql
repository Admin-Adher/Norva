begin;

create extension if not exists pgtap with schema extensions;
select extensions.no_plan();

select extensions.ok(
  (select relrowsecurity and relforcerowsecurity
   from pg_catalog.pg_class
   where oid = 'public.catalog_file_audio_repair_cohorts'::regclass)
  and (select relrowsecurity and relforcerowsecurity
       from pg_catalog.pg_class
       where oid = 'public.catalog_file_audio_repair_items'::regclass),
  'repair cohort header and items have enabled and forced RLS'
);

select extensions.ok(
  not has_table_privilege('anon', 'public.catalog_file_audio_repair_cohorts', 'SELECT')
  and not has_table_privilege('authenticated', 'public.catalog_file_audio_repair_cohorts', 'SELECT')
  and not has_table_privilege('service_role', 'public.catalog_file_audio_repair_cohorts', 'SELECT')
  and not has_table_privilege('anon', 'public.catalog_file_audio_repair_items', 'SELECT')
  and not has_table_privilege('authenticated', 'public.catalog_file_audio_repair_items', 'SELECT')
  and not has_table_privilege('service_role', 'public.catalog_file_audio_repair_items', 'SELECT'),
  'repair manifests have no direct API table access'
);

select extensions.ok(
  not has_function_privilege(
    'anon', 'public.catalog_file_audio_repair_pending(uuid,uuid)', 'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated', 'public.catalog_file_audio_repair_pending(uuid,uuid)', 'EXECUTE'
  )
  and has_function_privilege(
    'service_role', 'public.catalog_file_audio_repair_pending(uuid,uuid)', 'EXECUTE'
  )
  and not has_function_privilege(
    'anon', 'public.catalog_file_audio_repair_candidates(uuid,uuid,integer)', 'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated', 'public.catalog_file_audio_repair_candidates(uuid,uuid,integer)', 'EXECUTE'
  )
  and has_function_privilege(
    'service_role', 'public.catalog_file_audio_repair_candidates(uuid,uuid,integer)', 'EXECUTE'
  )
  and not has_function_privilege(
    'anon', 'public.norva_start_catalog_file_audio_repair_attempt(uuid,uuid,uuid,uuid)', 'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated', 'public.norva_start_catalog_file_audio_repair_attempt(uuid,uuid,uuid,uuid)', 'EXECUTE'
  )
  and has_function_privilege(
    'service_role', 'public.norva_start_catalog_file_audio_repair_attempt(uuid,uuid,uuid,uuid)', 'EXECUTE'
  )
  and not has_function_privilege(
    'anon', 'public.norva_defer_catalog_file_audio_repair_candidate(uuid,uuid,uuid,uuid,text,integer)', 'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated', 'public.norva_defer_catalog_file_audio_repair_candidate(uuid,uuid,uuid,uuid,text,integer)', 'EXECUTE'
  )
  and has_function_privilege(
    'service_role', 'public.norva_defer_catalog_file_audio_repair_candidate(uuid,uuid,uuid,uuid,text,integer)', 'EXECUTE'
  ),
  'repair selector and exact-token transitions are executable only by service_role'
);

select extensions.ok(
  position(
    'cloud_catalog_visible_title_variants'
    in lower(pg_get_functiondef(
      'public.catalog_file_audio_repair_candidates(uuid,uuid,integer)'::regprocedure
    ))
  ) > 0
  and position(
    'provider_identity_id'
    in lower(pg_get_functiondef(
      'public.catalog_file_audio_repair_candidates(uuid,uuid,integer)'::regprocedure
    ))
  ) > 0
  and position(
    'least(4'
    in lower(pg_get_functiondef(
      'public.catalog_file_audio_repair_candidates(uuid,uuid,integer)'::regprocedure
    ))
  ) > 0,
  'repair candidates revalidate visibility, provider identity and four-item bound'
);

select extensions.ok(
  (select provolatile = 'v'
   from pg_catalog.pg_proc
   where oid = 'public.catalog_file_audio_repair_candidates(uuid,uuid,integer)'::regprocedure)
  and position(
    'for update of item skip locked'
    in lower(pg_get_functiondef(
      'public.catalog_file_audio_repair_candidates(uuid,uuid,integer)'::regprocedure
    ))
  ) > 0
  and position(
    'lease_token = gen_random_uuid()'
    in lower(pg_get_functiondef(
      'public.catalog_file_audio_repair_candidates(uuid,uuid,integer)'::regprocedure
    ))
  ) > 0
  and position(
    'attempt_count = item.attempt_count + 1'
    in lower(pg_get_functiondef(
      'public.catalog_file_audio_repair_candidates(uuid,uuid,integer)'::regprocedure
    ))
  ) = 0
  and position(
    'repair_lease_token uuid'
    in lower(pg_get_functiondef(
      'public.catalog_file_audio_repair_candidates(uuid,uuid,integer)'::regprocedure
    ))
  ) > 0,
  'repair candidate RPC atomically reserves an opaque lease without consuming attempt budget'
);

select extensions.ok(
  (select count(*) = 7
   from information_schema.columns
   where table_schema = 'public'
     and table_name = 'catalog_file_audio_repair_items'
     and column_name in (
       'attempt_count', 'lease_until', 'next_attempt_at',
       'last_attempt_at', 'quarantined_at',
       'lease_token', 'lease_attempt_started'
     ))
  and position('pending' in lower(pg_get_constraintdef((
    select oid from pg_constraint
    where conrelid = 'public.catalog_file_audio_repair_items'::regclass
      and conname = 'catalog_file_audio_repair_items_state_ck'
  )))) > 0
  and position('leased' in lower(pg_get_constraintdef((
    select oid from pg_constraint
    where conrelid = 'public.catalog_file_audio_repair_items'::regclass
      and conname = 'catalog_file_audio_repair_items_state_ck'
  )))) > 0
  and position('completed' in lower(pg_get_constraintdef((
    select oid from pg_constraint
    where conrelid = 'public.catalog_file_audio_repair_items'::regclass
      and conname = 'catalog_file_audio_repair_items_state_ck'
  )))) > 0
  and position('quarantined' in lower(pg_get_constraintdef((
    select oid from pg_constraint
    where conrelid = 'public.catalog_file_audio_repair_items'::regclass
      and conname = 'catalog_file_audio_repair_items_state_ck'
  )))) > 0
  and position('lease_token is null' in lower(pg_get_constraintdef((
    select oid from pg_constraint
    where conrelid = 'public.catalog_file_audio_repair_items'::regclass
      and conname = 'catalog_file_audio_repair_items_attempt_shape_ck'
  )))) > 0
  and position('not lease_attempt_started' in lower(pg_get_constraintdef((
    select oid from pg_constraint
    where conrelid = 'public.catalog_file_audio_repair_items'::regclass
      and conname = 'catalog_file_audio_repair_items_attempt_shape_ck'
  )))) > 0,
  'repair items expose the durable claim and quarantine state machine'
);

select extensions.ok(
  position(
    'attempt_count = item.attempt_count + 1'
    in lower(pg_get_functiondef(
      'public.norva_start_catalog_file_audio_repair_attempt(uuid,uuid,uuid,uuid)'::regprocedure
    ))
  ) > 0
  and position(
    'item.lease_token = p_lease_token'
    in lower(pg_get_functiondef(
      'public.norva_start_catalog_file_audio_repair_attempt(uuid,uuid,uuid,uuid)'::regprocedure
    ))
  ) > 0
  and position(
    'not item.lease_attempt_started'
    in lower(pg_get_functiondef(
      'public.norva_start_catalog_file_audio_repair_attempt(uuid,uuid,uuid,uuid)'::regprocedure
    ))
  ) > 0
  and position(
    'cloud_catalog_visible_title_variants'
    in lower(pg_get_functiondef(
      'public.norva_start_catalog_file_audio_repair_attempt(uuid,uuid,uuid,uuid)'::regprocedure
    ))
  ) > 0,
  'only the exact unstarted token consumes one attempt after lifecycle revalidation'
);

select extensions.ok(
  position(
    'item.lease_token = p_lease_token'
    in lower(pg_get_functiondef(
      'public.norva_defer_catalog_file_audio_repair_candidate(uuid,uuid,uuid,uuid,text,integer)'::regprocedure
    ))
  ) > 0
  and position(
    'not item.lease_attempt_started'
    in lower(pg_get_functiondef(
      'public.norva_defer_catalog_file_audio_repair_candidate(uuid,uuid,uuid,uuid,text,integer)'::regprocedure
    ))
  ) > 0
  and position(
    'attempt_count = item.attempt_count + 1'
    in lower(pg_get_functiondef(
      'public.norva_defer_catalog_file_audio_repair_candidate(uuid,uuid,uuid,uuid,text,integer)'::regprocedure
    ))
  ) = 0,
  'an exact unstarted token can be deferred without consuming history'
);

select extensions.ok(
  not has_function_privilege(
    'anon',
    'public.norva_cancel_catalog_file_audio_repair_pre_spawn_attempt(uuid,uuid,uuid,uuid,text,integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.norva_cancel_catalog_file_audio_repair_pre_spawn_attempt(uuid,uuid,uuid,uuid,text,integer)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.norva_cancel_catalog_file_audio_repair_pre_spawn_attempt(uuid,uuid,uuid,uuid,text,integer)',
    'EXECUTE'
  )
  and position(
    'item.lease_token = p_lease_token'
    in lower(pg_get_functiondef(
      'public.norva_cancel_catalog_file_audio_repair_pre_spawn_attempt(uuid,uuid,uuid,uuid,text,integer)'::regprocedure
    ))
  ) > 0
  and position(
    'item.lease_attempt_started'
    in lower(pg_get_functiondef(
      'public.norva_cancel_catalog_file_audio_repair_pre_spawn_attempt(uuid,uuid,uuid,uuid,text,integer)'::regprocedure
    ))
  ) > 0
  and position(
    'attempt_count = greatest(0, item.attempt_count - 1)'
    in lower(pg_get_functiondef(
      'public.norva_cancel_catalog_file_audio_repair_pre_spawn_attempt(uuid,uuid,uuid,uuid,text,integer)'::regprocedure
    ))
  ) > 0
  and position(
    'state = ''pending'''
    in lower(pg_get_functiondef(
      'public.norva_cancel_catalog_file_audio_repair_pre_spawn_attempt(uuid,uuid,uuid,uuid,text,integer)'::regprocedure
    ))
  ) > 0,
  'only service_role can restore the exact started token after typed pre-spawn backpressure'
);

select extensions.ok(
  position('lease-expired-before-provider-io' in lower(pg_get_functiondef(
    'public.catalog_file_audio_repair_candidates(uuid,uuid,integer)'::regprocedure
  ))) > 0
  and position('lease-expired-after-provider-attempt' in lower(pg_get_functiondef(
    'public.catalog_file_audio_repair_candidates(uuid,uuid,integer)'::regprocedure
  ))) > 0
  and position('item.lease_attempt_started and item.attempt_count >= 4'
    in lower(pg_get_functiondef(
      'public.catalog_file_audio_repair_candidates(uuid,uuid,integer)'::regprocedure
    ))) > 0,
  'expiry distinguishes reservation loss from a real provider attempt'
);

select extensions.ok(
  exists (
    select 1 from pg_constraint
    where conrelid = 'public.catalog_file_audio_repair_cohorts'::regclass
      and conname = 'catalog_file_audio_repair_cohorts_source_fk'
      and confdeltype = 'c'
  )
  and exists (
    select 1 from pg_trigger
    where tgrelid = 'public.cloud_source_catalog_heads'::regclass
      and tgname = 'trg_cancel_file_audio_repair_on_head_update'
      and not tgisinternal
  )
  and exists (
    select 1 from pg_trigger
    where tgrelid = 'public.catalog_source_provider_identities'::regclass
      and tgname = 'trg_cancel_file_audio_repair_on_identity_update'
      and not tgisinternal
  ),
  'source deletion cascades and head/identity drift cancel active cohorts'
);

select extensions.ok(
  position(
    'new.audio_observed is true'
    in lower(pg_get_functiondef(
      'public.norva_complete_catalog_file_audio_repair()'::regprocedure
    ))
  ) > 0
  and position(
    'subtitle_observed'
    in lower(pg_get_functiondef(
      'public.norva_complete_catalog_file_audio_repair()'::regprocedure
    ))
  ) = 0
  and position(
    'audio_verified_at'
    in lower(pg_get_functiondef(
      'public.norva_complete_catalog_file_audio_repair()'::regprocedure
    ))
  ) = 0,
  'raw exact audio completion is independent from subtitles and strict LID'
);

select * from extensions.finish();
rollback;
