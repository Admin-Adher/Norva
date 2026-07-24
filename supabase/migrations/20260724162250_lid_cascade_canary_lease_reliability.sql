-- Bounded renewal and monitoring contract for the LID cascade canary.
--
-- This migration deliberately does not enable rollout flags or increase the
-- canary cohort. It only renews an already-valid canary deployment when its
-- lease is expired or within the final 24 hours. Every renewal is append-only
-- and the renewal RPC is callable by service_role only.

begin;

create table if not exists public.audio_lid_cascade_lease_audit (
  renewal_id bigint generated always as identity primary key,
  policy_version text not null
    check (policy_version = 'lid-cascade-v1'),
  action text not null
    check (action = 'renew-canary-lease'),
  reason text not null
    check (
      char_length(btrim(reason)) between 8 and 240
      and reason !~ '[[:cntrl:]]'
    ),
  actor_kind text not null
    check (actor_kind in ('service_role', 'database-owner')),
  previous_expires_at timestamptz,
  new_expires_at timestamptz not null,
  lease_days smallint not null
    check (lease_days = 7),
  canary_bps integer not null
    check (canary_bps between 1 and 1000),
  daily_cap integer not null
    check (daily_cap between 1 and 100),
  renewed_at timestamptz not null,
  constraint audio_lid_cascade_lease_audit_window_ck
    check (new_expires_at = renewed_at + interval '7 days')
);

create index if not exists audio_lid_cascade_lease_audit_renewed_idx
  on public.audio_lid_cascade_lease_audit (renewed_at desc);

create or replace function public.reject_audio_lid_cascade_lease_audit_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  raise exception 'audio_lid_cascade_lease_audit is append-only'
    using errcode = '55000';
end
$function$;

revoke all on function public.reject_audio_lid_cascade_lease_audit_mutation()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_audio_lid_cascade_lease_audit_immutable
  on public.audio_lid_cascade_lease_audit;
create trigger trg_audio_lid_cascade_lease_audit_immutable
before update or delete on public.audio_lid_cascade_lease_audit
for each row execute function public.reject_audio_lid_cascade_lease_audit_mutation();

alter table public.audio_lid_cascade_lease_audit enable row level security;
revoke all on table public.audio_lid_cascade_lease_audit
  from public, anon, authenticated, service_role;
grant select on table public.audio_lid_cascade_lease_audit to service_role;

create or replace function public.audio_lid_cascade_lease_health()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_policy public.audio_lid_cascade_policy%rowtype;
  v_policy_found boolean := false;
  v_audio_enabled boolean := false;
  v_shadow_enabled boolean := false;
  v_canary_enabled boolean := false;
  v_primary_enabled boolean := false;
  v_tagged_enabled boolean := false;
  v_detect_shadow_enabled boolean := false;
  v_detect_primary_enabled boolean := false;
  v_stage_count integer := 0;
  v_state text := 'inactive';
  v_seconds_remaining bigint;
  v_last_renewed_at timestamptz;
begin
  select policy.*
    into v_policy
  from public.audio_lid_cascade_policy policy
  where policy.singleton;
  v_policy_found := found;

  select
    coalesce(bool_or(flag.enabled) filter (
      where flag.key = 'audio_lid_enabled'
    ), false),
    coalesce(bool_or(flag.enabled) filter (
      where flag.key = 'lid_cascade_shadow_enabled'
    ), false),
    coalesce(bool_or(flag.enabled) filter (
      where flag.key = 'lid_cascade_canary_enabled'
    ), false),
    coalesce(bool_or(flag.enabled) filter (
      where flag.key = 'lid_cascade_primary_enabled'
    ), false),
    coalesce(bool_or(flag.enabled) filter (
      where flag.key = 'lid_cascade_tagged_writes_enabled'
    ), false),
    coalesce(bool_or(flag.enabled) filter (
      where flag.key = 'lid_detect_only_shadow_enabled'
    ), false),
    coalesce(bool_or(flag.enabled) filter (
      where flag.key = 'lid_detect_only_production_enabled'
    ), false)
    into
      v_audio_enabled,
      v_shadow_enabled,
      v_canary_enabled,
      v_primary_enabled,
      v_tagged_enabled,
      v_detect_shadow_enabled,
      v_detect_primary_enabled
  from public.admin_feature_flags flag
  where flag.key in (
    'audio_lid_enabled',
    'lid_cascade_shadow_enabled',
    'lid_cascade_canary_enabled',
    'lid_cascade_primary_enabled',
    'lid_cascade_tagged_writes_enabled',
    'lid_detect_only_shadow_enabled',
    'lid_detect_only_production_enabled'
  );

  v_stage_count :=
    v_shadow_enabled::integer
    + v_canary_enabled::integer
    + v_primary_enabled::integer;

  select max(audit.renewed_at)
    into v_last_renewed_at
  from public.audio_lid_cascade_lease_audit audit;

  if not v_policy_found then
    v_state := 'conflict';
  elsif v_stage_count = 0
        and not v_tagged_enabled
        and not v_detect_shadow_enabled
        and not v_detect_primary_enabled then
    v_state := 'inactive';
  elsif not v_audio_enabled
        or v_stage_count <> 1
        or not v_canary_enabled
        or v_shadow_enabled
        or v_primary_enabled
        or v_tagged_enabled
        or v_detect_shadow_enabled
        or v_detect_primary_enabled
        or v_policy.policy_version is distinct from 'lid-cascade-v1'
        or coalesce(btrim(v_policy.rollout_seed), '') = ''
        or v_policy.canary_bps not between 1 and 1000
        or v_policy.daily_cap not between 1 and 100 then
    v_state := 'conflict';
  elsif v_policy.expires_at is null or v_policy.expires_at <= v_now then
    v_state := 'expired';
  elsif v_policy.expires_at <= v_now + interval '24 hours' then
    v_state := 'expiring';
  else
    v_state := 'active';
  end if;

  v_seconds_remaining := case
    when v_policy.expires_at is null then null
    else floor(extract(epoch from (v_policy.expires_at - v_now)))::bigint
  end;

  return jsonb_build_object(
    'state', v_state,
    'policyVersion', v_policy.policy_version,
    'rolloutMode', case when v_canary_enabled then 'canary' else null end,
    'canaryBps', v_policy.canary_bps,
    'dailyCap', v_policy.daily_cap,
    'expiresAt', v_policy.expires_at,
    'secondsRemaining', v_seconds_remaining,
    'lastRenewedAt', v_last_renewed_at,
    'checkedAt', v_now
  );
end
$function$;

revoke all on function public.audio_lid_cascade_lease_health()
  from public, anon, authenticated;
grant execute on function public.audio_lid_cascade_lease_health()
  to service_role;

create or replace function public.renew_audio_lid_cascade_canary(
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_reason text := btrim(coalesce(p_reason, ''));
  v_policy public.audio_lid_cascade_policy%rowtype;
  v_audio_enabled boolean := false;
  v_shadow_enabled boolean := false;
  v_canary_enabled boolean := false;
  v_primary_enabled boolean := false;
  v_tagged_enabled boolean := false;
  v_detect_shadow_enabled boolean := false;
  v_detect_primary_enabled boolean := false;
  v_stage_count integer := 0;
  v_new_expires_at timestamptz;
  v_actor_kind text;
  v_renewal_id bigint;
begin
  if char_length(v_reason) not between 8 and 240
     or v_reason ~ '[[:cntrl:]]' then
    raise exception 'A bounded, printable renewal reason is required'
      using errcode = '22023';
  end if;

  -- Serialize operator renewals without holding a table-wide lock.
  perform pg_advisory_xact_lock(hashtext('norva:lid-cascade-canary-lease'));

  select policy.*
    into v_policy
  from public.audio_lid_cascade_policy policy
  where policy.singleton
  for update;

  if not found
     or v_policy.policy_version is distinct from 'lid-cascade-v1'
     or coalesce(btrim(v_policy.rollout_seed), '') = ''
     or v_policy.canary_bps not between 1 and 1000
     or v_policy.daily_cap not between 1 and 100 then
    raise exception 'LID canary policy is missing or outside safe bounds'
      using errcode = '55000';
  end if;

  select
    coalesce(bool_or(flag.enabled) filter (
      where flag.key = 'audio_lid_enabled'
    ), false),
    coalesce(bool_or(flag.enabled) filter (
      where flag.key = 'lid_cascade_shadow_enabled'
    ), false),
    coalesce(bool_or(flag.enabled) filter (
      where flag.key = 'lid_cascade_canary_enabled'
    ), false),
    coalesce(bool_or(flag.enabled) filter (
      where flag.key = 'lid_cascade_primary_enabled'
    ), false),
    coalesce(bool_or(flag.enabled) filter (
      where flag.key = 'lid_cascade_tagged_writes_enabled'
    ), false),
    coalesce(bool_or(flag.enabled) filter (
      where flag.key = 'lid_detect_only_shadow_enabled'
    ), false),
    coalesce(bool_or(flag.enabled) filter (
      where flag.key = 'lid_detect_only_production_enabled'
    ), false)
    into
      v_audio_enabled,
      v_shadow_enabled,
      v_canary_enabled,
      v_primary_enabled,
      v_tagged_enabled,
      v_detect_shadow_enabled,
      v_detect_primary_enabled
  from public.admin_feature_flags flag
  where flag.key in (
    'audio_lid_enabled',
    'lid_cascade_shadow_enabled',
    'lid_cascade_canary_enabled',
    'lid_cascade_primary_enabled',
    'lid_cascade_tagged_writes_enabled',
    'lid_detect_only_shadow_enabled',
    'lid_detect_only_production_enabled'
  );

  v_stage_count :=
    v_shadow_enabled::integer
    + v_canary_enabled::integer
    + v_primary_enabled::integer;

  if not v_audio_enabled
     or v_stage_count <> 1
     or not v_canary_enabled
     or v_shadow_enabled
     or v_primary_enabled
     or v_tagged_enabled
     or v_detect_shadow_enabled
     or v_detect_primary_enabled then
    raise exception 'Conflicting LID rollout flags; canary lease not renewed'
      using errcode = '55000';
  end if;

  -- A healthy lease cannot be rolled forward continuously. Operators may
  -- renew only after the 24-hour warning starts (or after expiry).
  if v_policy.expires_at is not null
     and v_policy.expires_at > v_now + interval '24 hours' then
    raise exception 'LID canary lease is not yet within its renewal window'
      using errcode = '55000';
  end if;

  v_new_expires_at := v_now + interval '7 days';
  v_actor_kind := case
    when nullif(current_setting('request.jwt.claim.role', true), '') = 'service_role'
      then 'service_role'
    else 'database-owner'
  end;

  update public.audio_lid_cascade_policy
     set expires_at = v_new_expires_at,
         updated_at = v_now
   where singleton;

  insert into public.audio_lid_cascade_lease_audit(
    policy_version,
    action,
    reason,
    actor_kind,
    previous_expires_at,
    new_expires_at,
    lease_days,
    canary_bps,
    daily_cap,
    renewed_at
  ) values (
    v_policy.policy_version,
    'renew-canary-lease',
    v_reason,
    v_actor_kind,
    v_policy.expires_at,
    v_new_expires_at,
    7,
    v_policy.canary_bps,
    v_policy.daily_cap,
    v_now
  )
  returning renewal_id into v_renewal_id;

  return jsonb_build_object(
    'renewed', true,
    'renewalId', v_renewal_id,
    'policyVersion', v_policy.policy_version,
    'previousExpiresAt', v_policy.expires_at,
    'expiresAt', v_new_expires_at,
    'leaseDays', 7
  );
end
$function$;

revoke all on function public.renew_audio_lid_cascade_canary(text)
  from public, anon, authenticated;
grant execute on function public.renew_audio_lid_cascade_canary(text)
  to service_role;

-- Reactivate only a canary that is already configured safely. Fresh/staging
-- installations with rollout flags disabled stay disabled.
do $block$
declare
  v_health jsonb;
begin
  v_health := public.audio_lid_cascade_lease_health();
  if v_health->>'state' in ('expired', 'expiring') then
    perform public.renew_audio_lid_cascade_canary(
      'initial safe seven-day renewal from migration 20260724162250'
    );
  end if;
end
$block$;

notify pgrst, 'reload schema';

commit;
