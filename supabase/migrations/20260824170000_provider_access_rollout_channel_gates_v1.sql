begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

-- Rollout membership and delivery-channel readiness are independent gates.
-- Entering a cohort enables only the durable Provider Access core and its
-- in-app surface. Automatic provider calls, email and push remain OFF until an
-- operator records a separate readiness decision. Every stage change resets
-- those external channels, so a larger cohort can never inherit an approval
-- made for a smaller observation window.
create table public.cloud_provider_access_rollout_channel_events (
  id bigint generated always as identity primary key,
  rollout_revision bigint not null check (rollout_revision > 0),
  stage text not null check (stage in (
    'internal','1_percent','5_percent','20_percent','50_percent','100_percent'
  )),
  auto_detection_enabled boolean not null,
  email_enabled boolean not null,
  push_enabled boolean not null,
  readiness_reference text not null
    check (length(btrim(readiness_reference)) between 12 and 1000),
  actor text not null check (length(btrim(actor)) between 3 and 200),
  created_at timestamptz not null default clock_timestamp()
);

alter table public.cloud_provider_access_rollout_channel_events enable row level security;
revoke all on table public.cloud_provider_access_rollout_channel_events
  from public, anon, authenticated, service_role;
grant select, insert on table public.cloud_provider_access_rollout_channel_events
  to service_role;

create or replace function public.norva_set_provider_access_rollout_stage(
  p_expected_revision bigint,
  p_stage text,
  p_approval_note text,
  p_actor text
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_rollout public.cloud_provider_access_rollout%rowtype;
  v_next_rank integer;
  v_current_rank integer;
  v_basis_points integer;
  v_enable_core boolean;
begin
  perform public.norva_provider_access_service_role_required();
  if p_expected_revision is null
     or p_stage not in ('off','internal','1_percent','5_percent','20_percent','50_percent','100_percent')
     or length(btrim(coalesce(p_approval_note,''))) not between 12 and 1000
     or length(btrim(coalesce(p_actor,''))) not between 3 and 200 then
    raise exception 'invalid rollout transition' using errcode='22023';
  end if;

  select * into strict v_rollout
  from public.cloud_provider_access_rollout
  where singleton
  for update;
  if v_rollout.revision <> p_expected_revision then
    raise exception 'stale rollout revision' using errcode='40001', detail='reason=stale';
  end if;

  v_current_rank := array_position(
    array['off','internal','1_percent','5_percent','20_percent','50_percent','100_percent'],
    v_rollout.stage
  );
  v_next_rank := array_position(
    array['off','internal','1_percent','5_percent','20_percent','50_percent','100_percent'],
    p_stage
  );
  if v_next_rank > v_current_rank + 1 then
    raise exception 'rollout stage cannot be skipped'
      using errcode='55000', detail='reason=stage_skip';
  end if;
  if v_next_rank > v_current_rank then
    if v_rollout.legal_policy_approved_at is null
       or v_rollout.operational_approved_at is null then
      raise exception 'rollout approvals are incomplete'
        using errcode='55000', detail='reason=approval_missing';
    end if;
    perform public.norva_assert_provider_access_rollout_safe();
  end if;

  v_basis_points := case p_stage
    when '1_percent' then 100
    when '5_percent' then 500
    when '20_percent' then 2000
    when '50_percent' then 5000
    when '100_percent' then 10000
    else 0
  end;
  v_enable_core := p_stage <> 'off';

  update public.cloud_provider_access_rollout
  set revision=revision+1,
      stage=p_stage,
      cohort_basis_points=v_basis_points,
      last_approval_note=btrim(p_approval_note),
      updated_at=clock_timestamp(),
      updated_by=btrim(p_actor)
  where singleton and revision=p_expected_revision
  returning * into strict v_rollout;

  -- Core and in-app are cohort-scoped together. External effects are reset on
  -- every stage transition and require norva_set_provider_access_rollout_channels.
  update public.admin_feature_flags
  set enabled = case
        when key in (
          'provider_access_auto_detection_v1_enabled',
          'provider_access_email_v1_enabled',
          'provider_access_push_v1_enabled'
        ) then false
        else v_enable_core
      end,
      updated_at=clock_timestamp(),
      updated_by=btrim(p_actor)
  where key in (
    'provider_access_v1_enabled','provider_access_auto_detection_v1_enabled',
    'provider_access_notifications_v1_enabled','provider_access_email_v1_enabled',
    'provider_access_push_v1_enabled','provider_access_in_app_v1_enabled',
    'provider_access_visibility_v1_enabled','provider_credential_transition_v1_enabled',
    'provider_replacement_v1_enabled'
  );

  insert into public.cloud_provider_access_rollout_events(
    previous_revision,revision,previous_stage,stage,cohort_basis_points,
    approval_note,actor
  ) values (
    p_expected_revision,v_rollout.revision,
    (array['off','internal','1_percent','5_percent','20_percent','50_percent','100_percent'])[v_current_rank],
    p_stage,v_basis_points,btrim(p_approval_note),btrim(p_actor)
  );

  return jsonb_build_object(
    'revision',v_rollout.revision,
    'stage',p_stage,
    'cohortBasisPoints',v_basis_points,
    'externalChannelsReset',true
  );
end
$function$;

create or replace function public.norva_set_provider_access_rollout_channels(
  p_expected_revision bigint,
  p_auto_detection_enabled boolean,
  p_email_enabled boolean,
  p_push_enabled boolean,
  p_readiness_reference text,
  p_actor text
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_rollout public.cloud_provider_access_rollout%rowtype;
begin
  perform public.norva_provider_access_service_role_required();
  if p_expected_revision is null
     or p_auto_detection_enabled is null
     or p_email_enabled is null
     or p_push_enabled is null
     or length(btrim(coalesce(p_readiness_reference,''))) not between 12 and 1000
     or length(btrim(coalesce(p_actor,''))) not between 3 and 200 then
    raise exception 'invalid rollout channel decision' using errcode='22023';
  end if;

  select * into strict v_rollout
  from public.cloud_provider_access_rollout
  where singleton
  for update;
  if v_rollout.revision <> p_expected_revision then
    raise exception 'stale rollout revision' using errcode='40001', detail='reason=stale';
  end if;
  if v_rollout.stage = 'off' then
    raise exception 'rollout channels require an active cohort'
      using errcode='55000', detail='reason=rollout_off';
  end if;
  if v_rollout.legal_policy_approved_at is null
     or v_rollout.operational_approved_at is null then
    raise exception 'rollout approvals are incomplete'
      using errcode='55000', detail='reason=approval_missing';
  end if;
  perform public.norva_assert_provider_access_rollout_safe();

  update public.cloud_provider_access_rollout
  set revision=revision+1,
      updated_at=clock_timestamp(),
      updated_by=btrim(p_actor)
  where singleton and revision=p_expected_revision
  returning * into strict v_rollout;

  update public.admin_feature_flags
  set enabled = case key
        when 'provider_access_auto_detection_v1_enabled' then p_auto_detection_enabled
        when 'provider_access_email_v1_enabled' then p_email_enabled
        when 'provider_access_push_v1_enabled' then p_push_enabled
      end,
      updated_at=clock_timestamp(),
      updated_by=btrim(p_actor)
  where key in (
    'provider_access_auto_detection_v1_enabled',
    'provider_access_email_v1_enabled',
    'provider_access_push_v1_enabled'
  );

  insert into public.cloud_provider_access_rollout_channel_events(
    rollout_revision,stage,auto_detection_enabled,email_enabled,push_enabled,
    readiness_reference,actor
  ) values (
    v_rollout.revision,v_rollout.stage,p_auto_detection_enabled,p_email_enabled,
    p_push_enabled,btrim(p_readiness_reference),btrim(p_actor)
  );

  return jsonb_build_object(
    'revision',v_rollout.revision,
    'stage',v_rollout.stage,
    'autoDetectionEnabled',p_auto_detection_enabled,
    'emailEnabled',p_email_enabled,
    'pushEnabled',p_push_enabled
  );
end
$function$;

revoke all on function public.norva_set_provider_access_rollout_channels(
  bigint,boolean,boolean,boolean,text,text
) from public, anon, authenticated;
grant execute on function public.norva_set_provider_access_rollout_channels(
  bigint,boolean,boolean,boolean,text,text
) to service_role;

comment on function public.norva_set_provider_access_rollout_channels(
  bigint,boolean,boolean,boolean,text,text
) is 'CAS-gated external Provider Access channel approval; each rollout stage transition resets these channels OFF.';

-- Installation on an already dormant production database must remain dormant.
update public.admin_feature_flags
set enabled=false,
    updated_at=clock_timestamp(),
    updated_by='provider-access-rollout-channel-gates-v1-install'
where key in (
  'provider_access_auto_detection_v1_enabled',
  'provider_access_email_v1_enabled',
  'provider_access_push_v1_enabled'
);

commit;
