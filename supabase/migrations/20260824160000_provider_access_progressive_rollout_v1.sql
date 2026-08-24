-- Phase 16: durable, explicit and fail-closed Provider Access rollout.
-- Installing this migration activates no product behaviour: the singleton is
-- inserted at OFF and every Provider Access flag is forced OFF.

begin;

create table public.cloud_provider_access_rollout (
  singleton boolean primary key default true check (singleton),
  revision bigint not null default 1 check (revision > 0),
  stage text not null default 'off' check (stage in (
    'off','internal','1_percent','5_percent','20_percent','50_percent','100_percent'
  )),
  cohort_basis_points integer not null default 0 check (
    cohort_basis_points in (0,100,500,2000,5000,10000)
  ),
  legal_policy_reference text check (
    legal_policy_reference is null or length(btrim(legal_policy_reference)) between 8 and 500
  ),
  legal_policy_approved_at timestamptz,
  operational_reference text check (
    operational_reference is null or length(btrim(operational_reference)) between 8 and 500
  ),
  operational_approved_at timestamptz,
  last_approval_note text check (
    last_approval_note is null or length(btrim(last_approval_note)) between 12 and 1000
  ),
  updated_at timestamptz not null default now(),
  updated_by text not null default 'migration:provider_access_progressive_rollout_v1',
  constraint cloud_provider_access_rollout_stage_percent_ck check (
    (stage in ('off','internal') and cohort_basis_points = 0)
    or (stage = '1_percent' and cohort_basis_points = 100)
    or (stage = '5_percent' and cohort_basis_points = 500)
    or (stage = '20_percent' and cohort_basis_points = 2000)
    or (stage = '50_percent' and cohort_basis_points = 5000)
    or (stage = '100_percent' and cohort_basis_points = 10000)
  ),
  constraint cloud_provider_access_rollout_legal_pair_ck check (
    (legal_policy_reference is null) = (legal_policy_approved_at is null)
  ),
  constraint cloud_provider_access_rollout_operational_pair_ck check (
    (operational_reference is null) = (operational_approved_at is null)
  )
);

create table public.cloud_provider_access_rollout_internal_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  reason text not null check (length(btrim(reason)) between 8 and 500),
  added_at timestamptz not null default now(),
  added_by text not null
);

create table public.cloud_provider_access_rollout_events (
  id bigint generated always as identity primary key,
  previous_revision bigint not null,
  revision bigint not null unique,
  previous_stage text not null,
  stage text not null,
  cohort_basis_points integer not null,
  approval_note text not null,
  actor text not null,
  created_at timestamptz not null default now()
);

alter table public.cloud_provider_access_rollout enable row level security;
alter table public.cloud_provider_access_rollout_internal_users enable row level security;
alter table public.cloud_provider_access_rollout_events enable row level security;
revoke all on table public.cloud_provider_access_rollout,
  public.cloud_provider_access_rollout_internal_users,
  public.cloud_provider_access_rollout_events
  from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.cloud_provider_access_rollout,
  public.cloud_provider_access_rollout_internal_users,
  public.cloud_provider_access_rollout_events to service_role;

insert into public.cloud_provider_access_rollout(singleton)
values (true)
on conflict (singleton) do nothing;

update public.admin_feature_flags
set enabled = false,
    updated_at = now(),
    updated_by = 'migration:provider_access_progressive_rollout_v1'
where key in (
  'provider_access_v1_enabled',
  'provider_access_auto_detection_v1_enabled',
  'provider_access_notifications_v1_enabled',
  'provider_access_email_v1_enabled',
  'provider_access_push_v1_enabled',
  'provider_access_in_app_v1_enabled',
  'provider_access_visibility_v1_enabled',
  'provider_credential_transition_v1_enabled',
  'provider_replacement_v1_enabled'
);

create or replace function public.norva_provider_access_rollout_eligible_internal(
  p_user_id uuid
) returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce((
    select case rollout.stage
      when 'off' then false
      when 'internal' then exists (
        select 1 from public.cloud_provider_access_rollout_internal_users member
        where member.user_id = p_user_id
      )
      when '100_percent' then true
      else (
        (
          get_byte(extensions.digest(
            convert_to('provider-access-rollout:v1:' || p_user_id::text, 'UTF8'),
            'sha256'
          ), 0)::bigint * 16777216
          + get_byte(extensions.digest(
            convert_to('provider-access-rollout:v1:' || p_user_id::text, 'UTF8'),
            'sha256'
          ), 1)::bigint * 65536
          + get_byte(extensions.digest(
            convert_to('provider-access-rollout:v1:' || p_user_id::text, 'UTF8'),
            'sha256'
          ), 2)::bigint * 256
          + get_byte(extensions.digest(
            convert_to('provider-access-rollout:v1:' || p_user_id::text, 'UTF8'),
            'sha256'
          ), 3)::bigint
        ) % 10000 < rollout.cohort_basis_points
      )
    end
    from public.cloud_provider_access_rollout rollout
    where rollout.singleton
  ), false);
$function$;

revoke all on function public.norva_provider_access_rollout_eligible_internal(uuid)
  from public, anon, authenticated;
grant execute on function public.norva_provider_access_rollout_eligible_internal(uuid)
  to service_role;

create or replace function public.norva_provider_access_rollout_status(
  p_user_id uuid
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_role text := coalesce(nullif(auth.jwt() ->> 'role',''), nullif(current_setting('request.jwt.claim.role',true),''), nullif(current_setting('role',true),'none'), '');
  v_rollout public.cloud_provider_access_rollout%rowtype;
begin
  if p_user_id is null or not (v_role = 'service_role' or auth.uid() = p_user_id) then
    raise exception 'rollout status forbidden' using errcode = '42501';
  end if;
  select * into strict v_rollout from public.cloud_provider_access_rollout where singleton;
  return jsonb_build_object(
    'contractVersion', 'provider-access-rollout.norva/v1',
    'revision', v_rollout.revision,
    'stage', v_rollout.stage,
    'eligible', public.norva_provider_access_rollout_eligible_internal(p_user_id)
  );
end
$function$;

revoke all on function public.norva_provider_access_rollout_status(uuid) from public, anon;
grant execute on function public.norva_provider_access_rollout_status(uuid) to authenticated, service_role;

create or replace function public.norva_configure_provider_access_rollout_gates(
  p_expected_revision bigint,
  p_legal_policy_reference text,
  p_operational_reference text,
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
     or length(btrim(coalesce(p_legal_policy_reference,''))) not between 8 and 500
     or length(btrim(coalesce(p_operational_reference,''))) not between 8 and 500
     or length(btrim(coalesce(p_actor,''))) not between 3 and 200 then
    raise exception 'invalid rollout gate approval' using errcode='22023';
  end if;
  update public.cloud_provider_access_rollout
  set revision = revision + 1,
      legal_policy_reference = btrim(p_legal_policy_reference),
      legal_policy_approved_at = clock_timestamp(),
      operational_reference = btrim(p_operational_reference),
      operational_approved_at = clock_timestamp(),
      updated_at = clock_timestamp(),
      updated_by = btrim(p_actor)
  where singleton and revision = p_expected_revision
  returning * into v_rollout;
  if not found then
    raise exception 'stale rollout revision' using errcode='40001', detail='reason=stale';
  end if;
  return jsonb_build_object('revision',v_rollout.revision,'stage',v_rollout.stage,'gatesApproved',true);
end
$function$;

create or replace function public.norva_set_provider_access_rollout_internal_user(
  p_user_id uuid,
  p_enabled boolean,
  p_reason text,
  p_actor text
) returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform public.norva_provider_access_service_role_required();
  if p_user_id is null or p_enabled is null
     or length(btrim(coalesce(p_reason,''))) not between 8 and 500
     or length(btrim(coalesce(p_actor,''))) not between 3 and 200 then
    raise exception 'invalid internal rollout member' using errcode='22023';
  end if;
  if p_enabled then
    insert into public.cloud_provider_access_rollout_internal_users(user_id,reason,added_by)
    values (p_user_id,btrim(p_reason),btrim(p_actor))
    on conflict (user_id) do update set reason=excluded.reason,added_at=now(),added_by=excluded.added_by;
  else
    delete from public.cloud_provider_access_rollout_internal_users where user_id=p_user_id;
  end if;
  return p_enabled;
end
$function$;

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
  v_enable boolean;
begin
  perform public.norva_provider_access_service_role_required();
  if p_expected_revision is null
     or p_stage not in ('off','internal','1_percent','5_percent','20_percent','50_percent','100_percent')
     or length(btrim(coalesce(p_approval_note,''))) not between 12 and 1000
     or length(btrim(coalesce(p_actor,''))) not between 3 and 200 then
    raise exception 'invalid rollout transition' using errcode='22023';
  end if;

  select * into strict v_rollout from public.cloud_provider_access_rollout where singleton for update;
  if v_rollout.revision <> p_expected_revision then
    raise exception 'stale rollout revision' using errcode='40001', detail='reason=stale';
  end if;
  v_current_rank := array_position(array['off','internal','1_percent','5_percent','20_percent','50_percent','100_percent'],v_rollout.stage);
  v_next_rank := array_position(array['off','internal','1_percent','5_percent','20_percent','50_percent','100_percent'],p_stage);
  if v_next_rank > v_current_rank + 1 then
    raise exception 'rollout stage cannot be skipped' using errcode='55000', detail='reason=stage_skip';
  end if;
  if v_next_rank > v_current_rank then
    if v_rollout.legal_policy_approved_at is null or v_rollout.operational_approved_at is null then
      raise exception 'rollout approvals are incomplete' using errcode='55000', detail='reason=approval_missing';
    end if;
    perform public.norva_assert_provider_access_rollout_safe();
  end if;
  v_basis_points := case p_stage when '1_percent' then 100 when '5_percent' then 500
    when '20_percent' then 2000 when '50_percent' then 5000 when '100_percent' then 10000 else 0 end;
  v_enable := p_stage <> 'off';

  update public.cloud_provider_access_rollout
  set revision=revision+1,stage=p_stage,cohort_basis_points=v_basis_points,
      last_approval_note=btrim(p_approval_note),updated_at=clock_timestamp(),updated_by=btrim(p_actor)
  where singleton and revision=p_expected_revision
  returning * into strict v_rollout;

  update public.admin_feature_flags
  set enabled=v_enable,updated_at=clock_timestamp(),updated_by=btrim(p_actor)
  where key in (
    'provider_access_v1_enabled','provider_access_auto_detection_v1_enabled',
    'provider_access_notifications_v1_enabled','provider_access_email_v1_enabled',
    'provider_access_push_v1_enabled','provider_access_in_app_v1_enabled',
    'provider_access_visibility_v1_enabled','provider_credential_transition_v1_enabled',
    'provider_replacement_v1_enabled'
  );

  insert into public.cloud_provider_access_rollout_events(
    previous_revision,revision,previous_stage,stage,cohort_basis_points,approval_note,actor
  ) values (
    p_expected_revision,v_rollout.revision,
    (array['off','internal','1_percent','5_percent','20_percent','50_percent','100_percent'])[v_current_rank],
    p_stage,v_basis_points,btrim(p_approval_note),btrim(p_actor)
  );
  return jsonb_build_object('revision',v_rollout.revision,'stage',p_stage,'cohortBasisPoints',v_basis_points);
end
$function$;

create or replace function public.norva_provider_access_rollout_insert_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if not public.norva_provider_access_rollout_eligible_internal(new.user_id) then
    return null;
  end if;
  return new;
end
$function$;

create trigger trg_provider_access_check_rollout_guard
before insert on public.cloud_provider_access_check_jobs
for each row execute function public.norva_provider_access_rollout_insert_guard();
create trigger trg_provider_access_notification_rollout_guard
before insert on public.cloud_provider_access_notifications
for each row execute function public.norva_provider_access_rollout_insert_guard();

-- Visibility remains strict for staging/replacement lifecycle state, while an
-- access-expiry hide applies only to the explicitly selected rollout cohort.
create or replace function public.norva_source_catalog_visible_internal(
  p_source_id uuid,
  p_user_id uuid
) returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  with feature_gate as (
    select
      coalesce(bool_or(flag.enabled) filter (where flag.key='provider_access_v1_enabled'),false) as access_enabled,
      coalesce(bool_or(flag.enabled) filter (where flag.key='provider_access_visibility_v1_enabled'),false) as visibility_enabled,
      coalesce(bool_or(flag.enabled),false) as any_enabled
    from public.admin_feature_flags flag
    where flag.key in (
      'provider_access_v1_enabled','provider_access_auto_detection_v1_enabled',
      'provider_access_notifications_v1_enabled','provider_access_visibility_v1_enabled',
      'provider_credential_transition_v1_enabled','provider_replacement_v1_enabled'
    )
  ), rollout_gate as (
    select public.norva_provider_access_rollout_eligible_internal(p_user_id) as eligible
  )
  select p_source_id is not null and p_user_id is not null and exists (
    select 1
    from public.cloud_sources source
    left join public.cloud_source_lifecycle lifecycle on lifecycle.source_id=source.id and lifecycle.user_id=source.user_id
    left join public.cloud_source_provider_access access on access.source_id=source.id and access.user_id=source.user_id
    left join public.cloud_user_catalog_visibility_epochs epoch on epoch.user_id=source.user_id
    cross join feature_gate gate cross join rollout_gate rollout
    where source.id=p_source_id and source.user_id=p_user_id and source.enabled and source.deleted_at is null
      and ((lifecycle.source_id is null and not gate.any_enabled)
        or (lifecycle.lifecycle_state='active' and lifecycle.catalog_visibility='visible'))
      and ((access.source_id is null and not gate.any_enabled)
        or (access.source_id is not null and (
          not (gate.access_enabled and gate.visibility_enabled and rollout.eligible)
          or (access.provider_access_status not in ('expired_confirmed','access_unavailable_confirmed')
            and (access.provider_access_status<>'restoring' or access.provider_access_hidden_at is null
              or access.provider_access_restored_at>=access.provider_access_hidden_at))
        )))
      and (epoch.user_id is not null or not gate.any_enabled)
  );
$function$;

revoke all on function public.norva_configure_provider_access_rollout_gates(bigint,text,text,text),
  public.norva_set_provider_access_rollout_internal_user(uuid,boolean,text,text),
  public.norva_set_provider_access_rollout_stage(bigint,text,text,text),
  public.norva_provider_access_rollout_insert_guard()
  from public, anon, authenticated;
grant execute on function public.norva_configure_provider_access_rollout_gates(bigint,text,text,text),
  public.norva_set_provider_access_rollout_internal_user(uuid,boolean,text,text),
  public.norva_set_provider_access_rollout_stage(bigint,text,text,text)
  to service_role;

comment on table public.cloud_provider_access_rollout is
  'Phase 16 singleton; every upward rollout transition is explicit, sequential, CAS-guarded and audited.';
comment on function public.norva_provider_access_rollout_eligible_internal(uuid) is
  'Deterministic server-only Provider Access cohort predicate; internal membership and user UUIDs are never exposed.';

commit;
