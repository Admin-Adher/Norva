begin;

create extension if not exists pgtap with schema extensions;
select extensions.no_plan();

select extensions.ok(
  not has_function_privilege(
    'anon',
    'public.start_automatic_catalog_file_audio_validation_job(uuid,uuid,uuid,text,text,text,integer[],jsonb,text,timestamptz,bigint,jsonb,boolean)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.start_automatic_catalog_file_audio_validation_job(uuid,uuid,uuid,text,text,text,integer[],jsonb,text,timestamptz,bigint,jsonb,boolean)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.start_automatic_catalog_file_audio_validation_job(uuid,uuid,uuid,text,text,text,integer[],jsonb,text,timestamptz,bigint,jsonb,boolean)',
    'EXECUTE'
  ),
  'automatic strict enqueue is service-role only'
);

select extensions.ok(
  not has_function_privilege(
    'anon',
    'public.finalize_catalog_file_audio_validation_job(uuid,text,text,timestamptz,bigint,integer[])',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.finalize_catalog_file_audio_validation_job(uuid,text,text,timestamptz,bigint,integer[])',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.finalize_catalog_file_audio_validation_job(uuid,text,text,timestamptz,bigint,integer[])',
    'EXECUTE'
  ),
  'strict finalization remains service-role only'
);

select extensions.ok(
  not has_function_privilege(
    'anon',
    'public.fail_catalog_file_audio_validation_job(uuid,text,text,boolean,timestamptz)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.fail_catalog_file_audio_validation_job(uuid,text,text,boolean,timestamptz)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.fail_catalog_file_audio_validation_job(uuid,text,text,boolean,timestamptz)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.norva_quarantine_audio_validation_provider_no_progress(uuid,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.norva_quarantine_audio_validation_provider_no_progress(uuid,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.norva_quarantine_audio_validation_provider_no_progress(uuid,text)',
    'EXECUTE'
  ),
  'episode-safe retry and quarantine transitions remain service-role only'
);

select extensions.ok(
  position(
    'delete from public.provider_account_language_validation_leases'
    in pg_get_functiondef(
      'public.norva_quarantine_audio_validation_provider_no_progress(uuid,text)'::regprocedure
    )
  ) = 0
  and position(
    'delete from public.provider_file_probe_leases'
    in pg_get_functiondef(
      'public.norva_quarantine_audio_validation_provider_no_progress(uuid,text)'::regprocedure
    )
  ) = 0,
  'quarantine cannot bypass provider drain by deleting transport leases'
);

select extensions.ok(
  not has_function_privilege(
    'anon',
    'public.persist_catalog_audio_lid_outcome(uuid,text,text,text,integer,timestamptz,text,text,integer,text,text,text,double precision,text,integer,integer,integer,jsonb,timestamptz)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.persist_catalog_audio_lid_outcome(uuid,text,text,text,integer,timestamptz,text,text,integer,text,text,text,double precision,text,integer,integer,integer,jsonb,timestamptz)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.persist_catalog_audio_lid_outcome(uuid,text,text,text,integer,timestamptz,text,text,integer,text,text,text,double precision,text,integer,integer,integer,jsonb,timestamptz)',
    'EXECUTE'
  ),
  'provisional cascade evidence RPC is service-role only'
);

select extensions.ok(
  position(
    'cloud_source_catalog_heads'
    in pg_get_functiondef(
      'public.start_automatic_catalog_file_audio_validation_job(uuid,uuid,uuid,text,text,text,integer[],jsonb,text,timestamptz,bigint,jsonb,boolean)'::regprocedure
    )
  ) > 0
  and position(
    'active_generation_id'
    in pg_get_functiondef(
      'public.start_automatic_catalog_file_audio_validation_job(uuid,uuid,uuid,text,text,text,integer[],jsonb,text,timestamptz,bigint,jsonb,boolean)'::regprocedure
    )
  ) > 0
  and position(
    'v_active_count >= 2'
    in pg_get_functiondef(
      'public.start_automatic_catalog_file_audio_validation_job(uuid,uuid,uuid,text,text,text,integer[],jsonb,text,timestamptz,bigint,jsonb,boolean)'::regprocedure
    )
  ) > 0
  and position(
    'v_starts_24h >= 20'
    in pg_get_functiondef(
      'public.start_automatic_catalog_file_audio_validation_job(uuid,uuid,uuid,text,text,text,integer[],jsonb,text,timestamptz,bigint,jsonb,boolean)'::regprocedure
    )
  ) > 0,
  'automatic enqueue is fenced to the active catalogue generation and tenant quotas'
);

select extensions.ok(
  position(
    'catalog_series_episode_memberships'
    in pg_get_functiondef(
      'public.start_automatic_catalog_file_audio_validation_job(uuid,uuid,uuid,text,text,text,integer[],jsonb,text,timestamptz,bigint,jsonb,boolean)'::regprocedure
    )
  ) > 0
  and position(
    'catalog_source_provider_identities'
    in pg_get_functiondef(
      'public.start_automatic_catalog_file_audio_validation_job(uuid,uuid,uuid,text,text,text,integer[],jsonb,text,timestamptz,bigint,jsonb,boolean)'::regprocedure
    )
  ) > 0,
  'automatic episode enqueue rebinds membership and provider identity'
);

select extensions.ok(
  position(
    'from public.cloud_sources source'
    in pg_get_functiondef(
      'public.finalize_catalog_file_audio_validation_job(uuid,text,text,timestamptz,bigint,integer[])'::regprocedure
    )
  ) > 0
  and position(
    'from public.cloud_source_catalog_heads head'
    in pg_get_functiondef(
      'public.finalize_catalog_file_audio_validation_job(uuid,text,text,timestamptz,bigint,integer[])'::regprocedure
    )
  ) > 0
  and position(
    'from public.catalog_source_provider_identities identity'
    in pg_get_functiondef(
      'public.finalize_catalog_file_audio_validation_job(uuid,text,text,timestamptz,bigint,integer[])'::regprocedure
    )
  ) > 0
  and position(
    'v_active_generation_id'
    in pg_get_functiondef(
      'public.finalize_catalog_file_audio_validation_job(uuid,text,text,timestamptz,bigint,integer[])'::regprocedure
    )
  ) > 0
  and position(
    'from public.cloud_title_variants parent_variant'
    in pg_get_functiondef(
      'public.finalize_catalog_file_audio_validation_job(uuid,text,text,timestamptz,bigint,integer[])'::regprocedure
    )
  ) > 0
  and position(
    'for share;'
    in pg_get_functiondef(
      'public.finalize_catalog_file_audio_validation_job(uuid,text,text,timestamptz,bigint,integer[])'::regprocedure
    )
  ) > 0,
  'strict finalization holds source, active head, identity and parent bindings through publication'
);

select extensions.ok(
  position(
    'p_provider_drain_attested is not true'
    in pg_get_functiondef(
      'public.start_automatic_catalog_file_audio_validation_job(uuid,uuid,uuid,text,text,text,integer[],jsonb,text,timestamptz,bigint,jsonb,boolean)'::regprocedure
    )
  ) > 0
  and position(
    'source.sync_status = ''ready'''
    in pg_get_functiondef(
      'public.start_automatic_catalog_file_audio_validation_job(uuid,uuid,uuid,text,text,text,integer[],jsonb,text,timestamptz,bigint,jsonb,boolean)'::regprocedure
    )
  ) > 0,
  'automatic episode enqueue requires drain attestation and a ready active source'
);

select extensions.ok(
  position(
    'case when p_status = ''detected'' then ''pending'''
    in pg_get_functiondef(
      'public.persist_catalog_audio_lid_outcome(uuid,text,text,text,integer,timestamptz,text,text,integer,text,text,text,double precision,text,integer,integer,integer,jsonb,timestamptz)'::regprocedure
    )
  ) > 0
  and position(
    'v_route, v_status, null, null'
    in pg_get_functiondef(
      'public.persist_catalog_audio_lid_outcome(uuid,text,text,text,integer,timestamptz,text,text,integer,text,text,text,double precision,text,integer,integer,integer,jsonb,timestamptz)'::regprocedure
    )
  ) > 0
  and position(
    'when p_status = ''detected'' then ''pending-disagreement'''
    in pg_get_functiondef(
      'public.persist_catalog_audio_lid_outcome(uuid,text,text,text,integer,timestamptz,text,text,integer,text,text,text,double precision,text,integer,integer,integer,jsonb,timestamptz)'::regprocedure
    )
  ) > 0
  and position(
    '''provisionalRoute'''
    in pg_get_functiondef(
      'public.persist_catalog_audio_lid_outcome(uuid,text,text,text,integer,timestamptz,text,text,integer,text,text,text,double precision,text,integer,integer,integer,jsonb,timestamptz)'::regprocedure
    )
  ) > 0
  and position(
    'p_confidence is null'
    in pg_get_functiondef(
      'public.persist_catalog_audio_lid_outcome(uuid,text,text,text,integer,timestamptz,text,text,integer,text,text,text,double precision,text,integer,integer,integer,jsonb,timestamptz)'::regprocedure
    )
  ) > 0,
  'provisional cascade evidence cannot publish an exact language'
);

select * from extensions.finish();
rollback;
