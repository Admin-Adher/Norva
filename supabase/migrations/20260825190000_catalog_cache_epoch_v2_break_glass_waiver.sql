begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

-- Owner-authorized break-glass path for an explicitly accepted early launch.
-- The normal completion RPC remains unchanged and continues to enforce seven
-- full days. This separate path records the real deadline and the waiver; it
-- never backdates installed_at or weakens the normal contract.
create table public.cloud_catalog_cache_epoch_v2_waivers (
  singleton boolean primary key default true check (singleton),
  contract text not null check (contract = 'catalog-cache-epoch-v2'),
  manifest_sha256 text not null check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  rollout_revision bigint not null check (rollout_revision > 0),
  approval_reference text not null check (
    approval_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{11,119}$'
  ),
  risk_reason text not null check (
    length(btrim(risk_reason)) between 40 and 1000
    and position(chr(10) in risk_reason) = 0
    and position(chr(13) in risk_reason) = 0
  ),
  actor text not null check (
    length(btrim(actor)) between 3 and 200
    and position(chr(10) in actor) = 0
    and position(chr(13) in actor) = 0
  ),
  confirmation_contract text not null check (
    confirmation_contract = 'WAIVE_CACHE_EPOCH_V2_OBSERVATION_FOR_AD_LAUNCH'
  ),
  installed_at timestamptz not null,
  normal_not_before timestamptz not null,
  waived_at timestamptz not null default clock_timestamp(),
  global_epoch_before bigint not null check (global_epoch_before >= 1),
  global_epoch_after bigint not null check (
    global_epoch_after > 1 and global_epoch_after = global_epoch_before + 1
  ),
  check (normal_not_before = installed_at + interval '7 days'),
  check (waived_at < normal_not_before)
);

alter table public.cloud_catalog_cache_epoch_v2_waivers enable row level security;
alter table public.cloud_catalog_cache_epoch_v2_waivers force row level security;
revoke all on table public.cloud_catalog_cache_epoch_v2_waivers
  from public, anon, authenticated, service_role;

create or replace function public.norva_catalog_cache_epoch_v2_waiver_immutable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  raise exception 'catalog cache epoch v2 waiver evidence is immutable'
    using errcode = '55000', detail = 'reason=immutable_evidence';
end
$function$;

revoke all on function public.norva_catalog_cache_epoch_v2_waiver_immutable()
  from public, anon, authenticated, service_role;

create trigger trg_catalog_cache_epoch_v2_waiver_immutable
before update or delete on public.cloud_catalog_cache_epoch_v2_waivers
for each row execute function public.norva_catalog_cache_epoch_v2_waiver_immutable();

create or replace function public.norva_waive_catalog_cache_epoch_v2_observation(
  p_contract text,
  p_manifest_sha256 text,
  p_expected_rollout_revision bigint,
  p_approval_reference text,
  p_risk_reason text,
  p_actor text,
  p_confirmation text
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_cache public.cloud_catalog_cache_epoch_v2_rollout%rowtype;
  v_cohort public.cloud_provider_access_rollout%rowtype;
  v_existing public.cloud_catalog_cache_epoch_v2_waivers%rowtype;
  v_not_before timestamptz;
  v_waived_at timestamptz;
  v_epoch_before bigint;
  v_epoch_after bigint;
  v_enabled_flags integer;
  v_flag_count integer;
  v_provider_crons integer;
  v_safe jsonb;
begin
  perform public.norva_provider_access_service_role_required();

  if p_contract is distinct from 'catalog-cache-epoch-v2'
     or p_manifest_sha256 is distinct from
       '23c0fa2cdaf09c08d9de4378d1a82f0f631ce71d6f955a0bdbb2c786b8ff98d3'
     or p_expected_rollout_revision is null
     or p_approval_reference is null
     or p_approval_reference !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{11,119}$'
     or length(btrim(coalesce(p_risk_reason,''))) not between 40 and 1000
     or position(chr(10) in coalesce(p_risk_reason,'')) <> 0
     or position(chr(13) in coalesce(p_risk_reason,'')) <> 0
     or length(btrim(coalesce(p_actor,''))) not between 3 and 200
     or position(chr(10) in coalesce(p_actor,'')) <> 0
     or position(chr(13) in coalesce(p_actor,'')) <> 0
     or p_confirmation is distinct from
       'WAIVE_CACHE_EPOCH_V2_OBSERVATION_FOR_AD_LAUNCH' then
    raise exception 'invalid catalog cache epoch v2 waiver request'
      using errcode = '22023', detail = 'reason=invalid_waiver_contract';
  end if;

  -- Match the rollout state machine's lock order: cohort first, cache second.
  select cohort.* into strict v_cohort
  from public.cloud_provider_access_rollout cohort
  where cohort.singleton
  for update;

  if v_cohort.revision <> p_expected_rollout_revision then
    raise exception 'stale rollout revision'
      using errcode = '40001', detail = 'reason=stale';
  end if;
  if v_cohort.stage <> 'off' or v_cohort.cohort_basis_points <> 0 then
    raise exception 'cache waiver requires rollout off'
      using errcode = '55000', detail = 'reason=rollout_not_off';
  end if;

  select count(*), count(*) filter (where flag.enabled)
  into strict v_flag_count, v_enabled_flags
  from public.admin_feature_flags flag
  where flag.key in (
    'provider_access_v1_enabled','provider_access_auto_detection_v1_enabled',
    'provider_access_notifications_v1_enabled','provider_access_email_v1_enabled',
    'provider_access_push_v1_enabled','provider_access_in_app_v1_enabled',
    'provider_access_visibility_v1_enabled','provider_credential_transition_v1_enabled',
    'provider_replacement_v1_enabled'
  );
  if v_flag_count <> 9 or v_enabled_flags <> 0 then
    raise exception 'cache waiver requires all Provider Access flags off'
      using errcode = '55000', detail = 'reason=flags_not_off';
  end if;

  select count(*) into strict v_provider_crons
  from cron.job job
  where job.jobname in (
    'norva-provider-access-notifications','norva-provider-access-checks'
  );
  if v_provider_crons <> 0 then
    raise exception 'cache waiver requires Provider Access crons absent'
      using errcode = '55000', detail = 'reason=provider_crons_present';
  end if;

  v_safe := public.norva_assert_provider_access_rollout_safe();
  if coalesce(v_safe ->> 'safe','false') <> 'true' then
    raise exception 'cache waiver refused by Provider Access safety assertion'
      using errcode = '55000', detail = 'reason=p0_unsafe';
  end if;

  select cache.* into strict v_cache
  from public.cloud_catalog_cache_epoch_v2_rollout cache
  where cache.singleton
  for update;
  v_not_before := v_cache.installed_at + interval '7 days';

  select waiver.* into v_existing
  from public.cloud_catalog_cache_epoch_v2_waivers waiver
  where waiver.singleton;

  if v_cache.phase = 'complete' then
    if v_existing.singleton
       and v_existing.contract = p_contract
       and v_existing.manifest_sha256 = p_manifest_sha256
       and v_existing.rollout_revision = p_expected_rollout_revision
       and v_existing.approval_reference = p_approval_reference
       and v_existing.risk_reason = btrim(p_risk_reason)
       and v_existing.actor = btrim(p_actor)
       and v_existing.confirmation_contract = p_confirmation then
      return jsonb_build_object(
        'contract', v_cache.contract,
        'phase', upper(v_cache.phase),
        'completionMode', 'BREAK_GLASS_WAIVER',
        'approvalReference', v_existing.approval_reference,
        'normalNotBefore', v_existing.normal_not_before,
        'completedAt', v_cache.completed_at,
        'globalEpoch', v_existing.global_epoch_after,
        'idempotentReplay', true
      );
    end if;
    raise exception 'cache epoch v2 already completed outside this waiver'
      using errcode = '55000', detail = 'reason=completion_conflict';
  end if;

  if v_cache.phase <> 'installed' then
    raise exception 'unknown cache epoch v2 phase'
      using errcode = '55000', detail = 'reason=unknown_cache_phase';
  end if;
  if v_existing.singleton then
    raise exception 'cache waiver evidence exists before completion'
      using errcode = '55000', detail = 'reason=waiver_state_drift';
  end if;
  if clock_timestamp() >= v_not_before then
    raise exception 'cache observation window is already complete; use normal completion'
      using errcode = '55000', detail = 'reason=normal_completion_required';
  end if;

  select epoch.global_epoch into strict v_epoch_before
  from public.cloud_global_catalog_visibility_epoch epoch
  where epoch.singleton
  for update;
  v_waived_at := clock_timestamp();

  update public.cloud_catalog_cache_epoch_v2_rollout cache
  set phase = 'complete',
      manifest_sha256 = p_manifest_sha256,
      completed_at = v_waived_at,
      updated_at = v_waived_at
  where cache.singleton and cache.phase = 'installed'
  returning cache.* into strict v_cache;

  v_epoch_after := public.norva_bump_global_catalog_visibility_epoch();
  if v_epoch_after <> v_epoch_before + 1 then
    raise exception 'cache waiver global epoch bump drift'
      using errcode = '55000', detail = 'reason=epoch_bump_drift';
  end if;

  insert into public.cloud_catalog_cache_epoch_v2_waivers(
    singleton, contract, manifest_sha256, rollout_revision,
    approval_reference, risk_reason, actor, confirmation_contract,
    installed_at, normal_not_before, waived_at,
    global_epoch_before, global_epoch_after
  ) values (
    true, p_contract, p_manifest_sha256, p_expected_rollout_revision,
    p_approval_reference, btrim(p_risk_reason), btrim(p_actor), p_confirmation,
    v_cache.installed_at, v_not_before, v_waived_at,
    v_epoch_before, v_epoch_after
  );

  return jsonb_build_object(
    'contract', v_cache.contract,
    'phase', upper(v_cache.phase),
    'completionMode', 'BREAK_GLASS_WAIVER',
    'approvalReference', p_approval_reference,
    'normalNotBefore', v_not_before,
    'completedAt', v_cache.completed_at,
    'globalEpoch', v_epoch_after,
    'idempotentReplay', false
  );
end
$function$;

revoke all on function public.norva_waive_catalog_cache_epoch_v2_observation(
  text, text, bigint, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.norva_waive_catalog_cache_epoch_v2_observation(
  text, text, bigint, text, text, text, text
) to service_role;

comment on table public.cloud_catalog_cache_epoch_v2_waivers is
  'Immutable singleton evidence for the explicitly owner-authorized early cache epoch v2 production waiver.';
comment on function public.norva_waive_catalog_cache_epoch_v2_observation(
  text, text, bigint, text, text, text, text
) is
  'Break-glass completion path: preserves the real seven-day deadline, requires exact risk acceptance, rollout CAS and fail-closed safety checks, then performs one global epoch bump.';

do $postcondition$
begin
  if has_table_privilege('anon','public.cloud_catalog_cache_epoch_v2_waivers','SELECT')
     or has_table_privilege('authenticated','public.cloud_catalog_cache_epoch_v2_waivers','SELECT')
     or has_table_privilege('service_role','public.cloud_catalog_cache_epoch_v2_waivers','SELECT')
     or has_function_privilege(
       'anon',
       'public.norva_waive_catalog_cache_epoch_v2_observation(text,text,bigint,text,text,text,text)',
       'EXECUTE'
     )
     or has_function_privilege(
       'authenticated',
       'public.norva_waive_catalog_cache_epoch_v2_observation(text,text,bigint,text,text,text,text)',
       'EXECUTE'
     ) then
    raise exception 'cache epoch v2 waiver ACL drift'
      using errcode = '55000';
  end if;
end
$postcondition$;

commit;
