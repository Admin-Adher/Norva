begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public,extensions;
select extensions.plan(20);

-- The proof container may retain unrelated historical cleanup fixtures. Keep
-- them pending but outside this rollback-only test window so the global fair
-- worker can deterministically claim the source created below.
update public.cloud_source_replacement_cleanup_jobs
set available_at = clock_timestamp() + interval '1 day'
where state = 'pending';

-- reap_deleted_sources intentionally yields while any active import is marked
-- syncing. Neutralize unrelated clone fixtures inside this rollback-only
-- transaction so this proof exercises cleanup rather than the global defer.
update public.cloud_sources
set sync_status = 'ready'
where deleted_at is null and sync_status = 'syncing';

insert into auth.users(
  id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) values (
  '93200000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','source-delete@example.invalid','',now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb,now(),now()
);

insert into public.cloud_sources(
  id,user_id,source_type,display_name,config_ciphertext,config_hint,sync_status
) values (
  '93200000-0000-4000-8000-000000000101',
  '93200000-0000-4000-8000-000000000001',
  'xtream','source-delete-fixture','cipher-delete',
  '{"serverHost":"delete.example.invalid","username":"delete-user"}'::jsonb,
  'ready'
);

select extensions.ok(
  exists (
    select 1 from public.cloud_source_catalog_heads
    where source_id = '93200000-0000-4000-8000-000000000101'
  ) and exists (
    select 1 from public.cloud_source_catalog_generations
    where source_id = '93200000-0000-4000-8000-000000000101'
  ),
  'fixture starts with a durable Phase-3 catalog generation and head'
);

update public.cloud_sources
set deleted_at = clock_timestamp(),auto_refresh_next_at = null
where id = '93200000-0000-4000-8000-000000000101';

select extensions.ok(
  exists (
    select 1
    from public.cloud_source_replacement_cleanup_jobs
    where source_id = '93200000-0000-4000-8000-000000000101'
      and user_id = '93200000-0000-4000-8000-000000000001'
      and state = 'pending'
      and cleanup_kind = 'source_delete'
  ),
  'ordinary DELETE schedules one explicit source-delete cleanup job'
);

select extensions.ok(
  (select lifecycle_state = 'purge_pending'
      and catalog_visibility = 'hidden'
      and purge_after <= clock_timestamp()
   from public.cloud_source_lifecycle
   where source_id = '93200000-0000-4000-8000-000000000101'),
  'soft delete hides the source and publishes an immediately due tombstone'
);

select extensions.ok(
  not exists (
    select 1 from public.cloud_catalog_visible_sources
    where id = '93200000-0000-4000-8000-000000000101'
  ),
  'removed source is absent from the catalog before background cleanup'
);

select extensions.is(
  (public.norva_run_replacement_cleanup_batch(
    'source-delete-backoff-proof',
    200
  )->>'waitingForReaper')::boolean,
  true,
  'terminal cleanup yields while the bounded database reaper still owns payload deletion'
);

select extensions.ok(
  (select available_at >= clock_timestamp() + interval '9 minutes 50 seconds'
   from public.cloud_source_replacement_cleanup_jobs
   where source_id = '93200000-0000-4000-8000-000000000101'
     and cleanup_kind = 'source_delete'
     and state = 'pending'),
  'waiting cleanup retries at the ten-minute reaper cadence instead of every ten seconds'
);

call public.reap_deleted_sources();

-- The reaper and terminal worker deliberately have separate global budgets.
-- Advance only this fixture's durable retry timestamp between bounded calls to
-- simulate later cron ticks without sleeping inside the proof transaction.
do $drain$
declare
  v_attempt integer;
begin
  for v_attempt in 1..25 loop
    exit when exists (
      select 1
      from public.cloud_source_replacement_cleanup_jobs
      where source_id = '93200000-0000-4000-8000-000000000101'
        and cleanup_kind = 'source_delete'
        and state = 'completed'
    );
    update public.cloud_source_replacement_cleanup_jobs
    set available_at = clock_timestamp()
    where source_id = '93200000-0000-4000-8000-000000000101'
      and cleanup_kind = 'source_delete'
      and state = 'pending';
    call public.reap_deleted_sources();
  end loop;
end
$drain$;

select extensions.ok(
  (select state = 'completed'
      and completed_at is not null
      and cleanup_kind = 'source_delete'
   from public.cloud_source_replacement_cleanup_jobs
   where source_id = '93200000-0000-4000-8000-000000000101'
     and user_id = '93200000-0000-4000-8000-000000000001'),
  'bounded database reaper ticks converge without an Edge lease'
);

select extensions.ok(
  (select provider_deletion_pending and provider_deletion_epoch = 1
   from public.cloud_sources
   where id = '93200000-0000-4000-8000-000000000101'),
  'bounded reaper publishes the terminal deletion fence exactly once'
);

select extensions.ok(
  (select lifecycle_state = 'purged' and catalog_visibility = 'hidden'
   from public.cloud_source_lifecycle
   where source_id = '93200000-0000-4000-8000-000000000101'),
  'cleanup reaches the explicit hidden PURGED lifecycle state'
);

select extensions.ok(
  (select config_ciphertext is null
      and config_hint = '{}'::jsonb
      and display_name = 'Deleted source'
      and not enabled
      and sync_status = 'disabled'
   from public.cloud_sources
   where id = '93200000-0000-4000-8000-000000000101'),
  'terminal cleanup removes credentials and identifying source hints'
);

select extensions.ok(
  not exists (
    select 1 from public.cloud_source_provider_account_affinities
    where source_id = '93200000-0000-4000-8000-000000000101'
  ),
  'terminal cleanup removes provider account affinity material'
);

select extensions.ok(
  exists (
    select 1 from public.cloud_source_catalog_heads
    where source_id = '93200000-0000-4000-8000-000000000101'
  ) and exists (
    select 1 from public.cloud_source_catalog_generations
    where source_id = '93200000-0000-4000-8000-000000000101'
  ),
  'minimal generation proof graph is retained after payload purge'
);

call public.reap_deleted_sources();

select extensions.is(
  (select count(*)::integer
   from public.cloud_source_replacement_cleanup_jobs
   where source_id = '93200000-0000-4000-8000-000000000101'
     and cleanup_kind = 'source_delete'),
  1,
  'replay is idempotent and never schedules a second cleanup job'
);

select extensions.is(
  (select provider_deletion_epoch
   from public.cloud_sources
   where id = '93200000-0000-4000-8000-000000000101'),
  1::bigint,
  'replay never bumps the terminal deletion epoch again'
);

select extensions.ok(
  position(
    'norva_recover_source_delete_cleanups(100)'
    in pg_catalog.pg_get_functiondef(
      'public.reap_deleted_sources()'::regprocedure
    )
  ) > 0 and position(
    'norva_run_replacement_cleanup_batch(''source-reaper'',200)'
    in pg_catalog.pg_get_functiondef(
      'public.reap_deleted_sources()'::regprocedure
    )
  ) > 0,
  'reaper reconstructs jobs and runs exactly one bounded cleanup step'
);

select extensions.ok(
  position(
    'session_user not in (''postgres'',''supabase_admin'')'
    in pg_catalog.pg_get_functiondef(
      'public.norva_run_replacement_cleanup_batch(text,integer)'::regprocedure
    )
  ) > 0 and position(
    'norva_credential_require_service_role()'
    in pg_catalog.pg_get_functiondef(
      'public.norva_run_replacement_cleanup_batch(text,integer)'::regprocedure
    )
  ) > 0,
  'operator cron path is narrow and the public RPC remains service-role gated'
);

select extensions.ok(
  position(
    'or v_replacement_source_purge'
    in pg_catalog.pg_get_functiondef(
      'public.norva_catalog_generation_write_guard()'::regprocedure
    )
  ) > 0,
  'PURGING generations accept only the existing durable source-cleanup proof'
);

select extensions.ok(
  position(
    'join public.cloud_source_replacement_cleanup_jobs cleanup'
    in pg_catalog.pg_get_functiondef(
      'public.norva_catalog_generation_row_changed()'::regprocedure
    )
  ) > 0 and position(
    'current_setting(''norva.catalog_purge_source'', true)'
    in pg_catalog.pg_get_functiondef(
      'public.norva_catalog_generation_row_changed()'::regprocedure
    )
  ) > 0,
  'statement trigger rechecks the durable cleanup proof for each generation'
);

select extensions.ok(
  position(
    'old.enabled and not new.enabled'
    in pg_catalog.pg_get_functiondef(
      'public.norva_cloud_source_track_revision()'::regprocedure
    )
  ) > 0 and position(
    'old.provider_deletion_pending'
    in pg_catalog.pg_get_functiondef(
      'public.norva_cloud_source_track_revision()'::regprocedure
    )
  ) > 0,
  'terminal disable reuses the existing hidden-source epoch without a new bump'
);

select extensions.ok(
  not has_table_privilege(
    'authenticated',
    'public.cloud_source_replacement_cleanup_jobs',
    'SELECT'
  ) and not has_function_privilege(
    'authenticated',
    'public.norva_enqueue_source_delete_cleanup(uuid,uuid)',
    'EXECUTE'
  ),
  'cleanup queue and scheduler remain inaccessible to authenticated clients'
);

select * from extensions.finish();
rollback;
