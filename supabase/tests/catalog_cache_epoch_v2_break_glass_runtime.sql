begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';

create temporary table cache_epoch_waiver_runtime_ctx(
  rollout_revision bigint not null,
  global_epoch_before bigint not null,
  installed_at timestamptz not null
) on commit drop;
grant select on cache_epoch_waiver_runtime_ctx to service_role;

insert into cache_epoch_waiver_runtime_ctx
select cohort.revision, epoch.global_epoch, cache.installed_at
from public.cloud_provider_access_rollout cohort
cross join public.cloud_global_catalog_visibility_epoch epoch
cross join public.cloud_catalog_cache_epoch_v2_rollout cache
where cohort.singleton and epoch.singleton and cache.singleton;

do $assert_preconditions$
begin
  if to_regclass('public.cloud_catalog_cache_epoch_v2_waivers') is null
     or to_regprocedure(
       'public.norva_waive_catalog_cache_epoch_v2_observation(text,text,bigint,text,text,text,text)'
     ) is null then
    raise exception 'waiver objects missing';
  end if;
  if has_table_privilege('anon','public.cloud_catalog_cache_epoch_v2_waivers','SELECT')
     or has_table_privilege('authenticated','public.cloud_catalog_cache_epoch_v2_waivers','SELECT')
     or has_table_privilege('service_role','public.cloud_catalog_cache_epoch_v2_waivers','SELECT') then
    raise exception 'waiver table ACL drift';
  end if;
  if (select phase <> 'installed' from public.cloud_catalog_cache_epoch_v2_rollout where singleton)
     or (select stage <> 'off' or cohort_basis_points <> 0
         from public.cloud_provider_access_rollout where singleton)
     or exists(select 1 from public.admin_feature_flags where key like 'provider_%_enabled' and enabled)
     or exists(select 1 from public.cloud_catalog_cache_epoch_v2_waivers) then
    raise exception 'unsafe initial waiver runtime state';
  end if;
end
$assert_preconditions$;
select 'BREAK_GLASS_RUNTIME_PRECONDITIONS_PASS' as proof;

set local role service_role;
do $assert_normal_gate$
begin
  begin
    perform public.norva_complete_catalog_cache_epoch_v2_rollout(
      'catalog-cache-epoch-v2',
      '23c0fa2cdaf09c08d9de4378d1a82f0f631ce71d6f955a0bdbb2c786b8ff98d3'
    );
    raise exception 'normal completion unexpectedly succeeded';
  exception when sqlstate '55000' then
    if sqlerrm <> 'catalog cache epoch v2 observation window is incomplete' then
      raise;
    end if;
  end;
end
$assert_normal_gate$;
select 'BREAK_GLASS_NORMAL_GATE_STILL_REFUSES_PASS' as proof;

do $assert_bad_confirmation$
begin
  begin
    perform public.norva_waive_catalog_cache_epoch_v2_observation(
      'catalog-cache-epoch-v2',
      '23c0fa2cdaf09c08d9de4378d1a82f0f631ce71d6f955a0bdbb2c786b8ff98d3',
      (select rollout_revision from cache_epoch_waiver_runtime_ctx),
      'NORVA-CACHE-EPOCH-V2-WAIVER-RUNTIME-20260825',
      'Owner accepts the shortened incompatible-cache observation window for this isolated runtime proof.',
      'runtime-break-glass',
      'WRONG_CONFIRMATION'
    );
    raise exception 'invalid confirmation unexpectedly succeeded';
  exception when sqlstate '22023' then
    if sqlerrm <> 'invalid catalog cache epoch v2 waiver request' then
      raise;
    end if;
  end;
end
$assert_bad_confirmation$;
select 'BREAK_GLASS_BAD_CONFIRMATION_REFUSED_PASS' as proof;

do $assert_stale_revision$
begin
  begin
    perform public.norva_waive_catalog_cache_epoch_v2_observation(
      'catalog-cache-epoch-v2',
      '23c0fa2cdaf09c08d9de4378d1a82f0f631ce71d6f955a0bdbb2c786b8ff98d3',
      (select rollout_revision + 1 from cache_epoch_waiver_runtime_ctx),
      'NORVA-CACHE-EPOCH-V2-WAIVER-RUNTIME-20260825',
      'Owner accepts the shortened incompatible-cache observation window for this isolated runtime proof.',
      'runtime-break-glass',
      'WAIVE_CACHE_EPOCH_V2_OBSERVATION_FOR_AD_LAUNCH'
    );
    raise exception 'stale revision unexpectedly succeeded';
  exception when sqlstate '40001' then
    if sqlerrm <> 'stale rollout revision' then
      raise;
    end if;
  end;
end
$assert_stale_revision$;
select 'BREAK_GLASS_STALE_REVISION_REFUSED_PASS' as proof;

create temporary table cache_epoch_waiver_runtime_result(payload jsonb) on commit drop;
insert into cache_epoch_waiver_runtime_result(payload)
select public.norva_waive_catalog_cache_epoch_v2_observation(
  'catalog-cache-epoch-v2',
  '23c0fa2cdaf09c08d9de4378d1a82f0f631ce71d6f955a0bdbb2c786b8ff98d3',
  (select rollout_revision from cache_epoch_waiver_runtime_ctx),
  'NORVA-CACHE-EPOCH-V2-WAIVER-RUNTIME-20260825',
  'Owner accepts the shortened incompatible-cache observation window for this isolated runtime proof.',
  'runtime-break-glass',
  'WAIVE_CACHE_EPOCH_V2_OBSERVATION_FOR_AD_LAUNCH'
);

reset role;
do $assert_completion$
begin
  if (select payload->>'phase' <> 'COMPLETE'
             or payload->>'completionMode' <> 'BREAK_GLASS_WAIVER'
             or (payload->>'idempotentReplay')::boolean
      from cache_epoch_waiver_runtime_result) then
    raise exception 'unexpected waiver completion payload';
  end if;
  if (select phase <> 'complete'
             or manifest_sha256 <> '23c0fa2cdaf09c08d9de4378d1a82f0f631ce71d6f955a0bdbb2c786b8ff98d3'
             or completed_at is null
      from public.cloud_catalog_cache_epoch_v2_rollout where singleton) then
    raise exception 'cache rollout completion drift';
  end if;
  if (select installed_at <> (select installed_at from cache_epoch_waiver_runtime_ctx)
             or normal_not_before <> (select installed_at + interval '7 days' from cache_epoch_waiver_runtime_ctx)
             or waived_at >= normal_not_before
             or global_epoch_after <> global_epoch_before + 1
      from public.cloud_catalog_cache_epoch_v2_waivers where singleton) then
    raise exception 'waiver audit evidence drift';
  end if;
  if (select global_epoch <> (select global_epoch_before + 1 from cache_epoch_waiver_runtime_ctx)
      from public.cloud_global_catalog_visibility_epoch where singleton) then
    raise exception 'global epoch did not bump exactly once';
  end if;
  if exists(select 1 from public.admin_feature_flags where key like 'provider_%_enabled' and enabled) then
    raise exception 'waiver unexpectedly enabled Provider Access';
  end if;
end
$assert_completion$;
select 'BREAK_GLASS_EXACT_COMPLETION_PASS' as proof;

set local role service_role;
do $assert_replay$
declare
  v_payload jsonb;
begin
  v_payload := public.norva_waive_catalog_cache_epoch_v2_observation(
    'catalog-cache-epoch-v2',
    '23c0fa2cdaf09c08d9de4378d1a82f0f631ce71d6f955a0bdbb2c786b8ff98d3',
    (select rollout_revision from cache_epoch_waiver_runtime_ctx),
    'NORVA-CACHE-EPOCH-V2-WAIVER-RUNTIME-20260825',
    'Owner accepts the shortened incompatible-cache observation window for this isolated runtime proof.',
    'runtime-break-glass',
    'WAIVE_CACHE_EPOCH_V2_OBSERVATION_FOR_AD_LAUNCH'
  );
  if not (v_payload->>'idempotentReplay')::boolean then
    raise exception 'exact replay was not idempotent';
  end if;
end
$assert_replay$;
reset role;
do $assert_replay_epoch$
begin
  if (select global_epoch <> (select global_epoch_before + 1 from cache_epoch_waiver_runtime_ctx)
      from public.cloud_global_catalog_visibility_epoch where singleton) then
    raise exception 'idempotent replay bumped epoch again';
  end if;
end
$assert_replay_epoch$;
select 'BREAK_GLASS_IDEMPOTENT_REPLAY_PASS' as proof;

do $assert_immutability$
begin
  begin
    update public.cloud_catalog_cache_epoch_v2_waivers set actor=actor where singleton;
    raise exception 'waiver evidence update unexpectedly succeeded';
  exception when sqlstate '55000' then
    if sqlerrm <> 'catalog cache epoch v2 waiver evidence is immutable' then
      raise;
    end if;
  end;
  begin
    delete from public.cloud_catalog_cache_epoch_v2_waivers where singleton;
    raise exception 'waiver evidence delete unexpectedly succeeded';
  exception when sqlstate '55000' then
    if sqlerrm <> 'catalog cache epoch v2 waiver evidence is immutable' then
      raise;
    end if;
  end;
end
$assert_immutability$;
select 'BREAK_GLASS_IMMUTABLE_EVIDENCE_PASS' as proof;

select json_build_object(
  'cachePhase',(select phase from public.cloud_catalog_cache_epoch_v2_rollout where singleton),
  'rolloutStage',(select stage from public.cloud_provider_access_rollout where singleton),
  'rolloutRevision',(select revision from public.cloud_provider_access_rollout where singleton),
  'enabledFlags',(select count(*) from public.admin_feature_flags where key like 'provider_%_enabled' and enabled),
  'waiverRows',(select count(*) from public.cloud_catalog_cache_epoch_v2_waivers),
  'globalEpoch',(select global_epoch from public.cloud_global_catalog_visibility_epoch where singleton)
) as transactional_snapshot;

rollback;
select 'BREAK_GLASS_RUNTIME_ROLLBACK_PASS' as proof;
