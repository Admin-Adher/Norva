begin;
set local lock_timeout='3s';
set local statement_timeout='45s';
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select extensions.plan(13);

select extensions.has_function(
  'public','norva_install_provider_access_notification_cron',array[]::text[],
  'notification cron has an explicit installer'
);
select extensions.has_function(
  'public','norva_remove_provider_access_crons',array[]::text[],
  'Provider Access crons have an explicit emergency removal RPC'
);
select extensions.is(
  (select count(*)::integer from cron.job
   where jobname='norva-provider-access-notifications'),
  0,'migration installation remains dormant'
);

set local role service_role;
select extensions.throws_ok(
  $$select public.norva_install_provider_access_notification_cron()$$,
  '55000',null,'OFF refuses notification cron installation'
);
reset role;

update public.cloud_provider_access_foundation_rollout
set phase='complete',completed_at=coalesce(completed_at,clock_timestamp()),updated_at=clock_timestamp()
where singleton;
update public.cloud_source_provider_account_affinity_rollout
set phase='complete',completed_at=coalesce(completed_at,clock_timestamp()),updated_at=clock_timestamp()
where singleton;
alter table public.provider_account_activity
  validate constraint provider_account_activity_opaque_key_ck;
update public.cloud_catalog_cache_epoch_v2_rollout
set installed_at=installed_at-interval '8 days'
where singleton and phase='installed';
select vault.create_secret(
  'provider-access-notification-cron-fixture',
  'norva_cron_shared_secret',
  'rollback-scoped Provider Access cron proof'
)
where not exists (
  select 1 from vault.decrypted_secrets
  where name='norva_cron_shared_secret' and decrypted_secret <> ''
);

set local role service_role;
select public.norva_complete_catalog_cache_epoch_v2_rollout(
  'catalog-cache-epoch-v2',
  '23c0fa2cdaf09c08d9de4378d1a82f0f631ce71d6f955a0bdbb2c786b8ff98d3'
);
select public.norva_configure_provider_access_rollout_gates(
  1,'legal-policy:notification-cron-proof','ops-proof:notification-cron-proof','cron-proof-service'
);
select public.norva_register_active_catalog_refresh_worker(
  'phase16-cron-proof-worker',
  'credential-transition-worker-v3-active-catalog-refresh',
  'active-catalog-refresh-checkpoint-prune-v1'
);
select public.norva_set_provider_access_rollout_stage(
  2,'internal','Explicit rollback-scoped notification cron proof.','cron-proof-service'
);
select extensions.is(
  (public.norva_install_provider_access_notification_cron()->>'installed')::boolean,
  true,'active cache-safe internal cohort can install the cron'
);
reset role;

select extensions.is(
  (select count(*)::integer from cron.job
   where jobname='norva-provider-access-notifications'),
  1,'exactly one notification cron exists'
);
select extensions.is(
  (select schedule from cron.job
   where jobname='norva-provider-access-notifications'),
  '* * * * *','notification cron runs on the bounded minutely schedule'
);
select extensions.ok(
  (select command like '%provider-access-notify/cron/drain%'
      and command like '%provider_access_notifications_v1_enabled%'
      and command like '%norva_cron_shared_secret%'
      and command like '%timeout_milliseconds := 180000%'
   from cron.job where jobname='norva-provider-access-notifications'),
  'cron command binds the endpoint, OFF check, secret and timeout'
);

set local role service_role;
select public.norva_install_provider_access_notification_cron();
reset role;
select extensions.is(
  (select count(*)::integer from cron.job
   where jobname='norva-provider-access-notifications'),
  1,'installer replay remains single-job idempotent'
);

set local role service_role;
select public.norva_set_provider_access_rollout_stage(
  3,'off','Emergency OFF must make the retained cron command inert.','cron-proof-service'
);
reset role;
select extensions.is(
  (select count(*)::integer from public.admin_feature_flags
   where key='provider_access_notifications_v1_enabled' and enabled),
  0,'OFF disables notification authority before cron removal'
);

set local role service_role;
select extensions.is(
  (public.norva_remove_provider_access_crons()->>'count')::integer,
  1,'emergency removal deletes the one Provider Access cron'
);
reset role;
select extensions.is(
  (select count(*)::integer from cron.job
   where jobname in ('norva-provider-access-notifications','norva-provider-access-checks')),
  0,'no Provider Access network cron remains'
);

set local role service_role;
select extensions.is(
  (public.norva_remove_provider_access_crons()->>'count')::integer,
  0,'emergency removal replay is an idempotent no-op'
);
reset role;

select * from extensions.finish();
rollback;
