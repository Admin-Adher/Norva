begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

-- Global cache invalidation is distinct from the account epoch used by the
-- physical catalogue write fence. Account mutations advance only their account
-- epoch; global policy changes advance only this singleton. Edge combines both
-- values into one opaque cache token without serializing unrelated accounts.
create table public.cloud_global_catalog_visibility_epoch (
  singleton boolean primary key default true check (singleton),
  global_epoch bigint not null default 1
    check (global_epoch >= 1 and global_epoch < 9223372036854775807),
  updated_at timestamptz not null default now()
);

insert into public.cloud_global_catalog_visibility_epoch(singleton,global_epoch)
values (true,1)
on conflict (singleton) do nothing;

alter table public.cloud_global_catalog_visibility_epoch enable row level security;
alter table public.cloud_global_catalog_visibility_epoch force row level security;
revoke all on table public.cloud_global_catalog_visibility_epoch
  from public,anon,authenticated,service_role;

create table public.cloud_catalog_cache_epoch_v2_rollout (
  singleton boolean primary key default true check (singleton),
  contract text not null default 'catalog-cache-epoch-v2'
    check (contract='catalog-cache-epoch-v2'),
  phase text not null default 'installed'
    check (phase in ('installed','complete')),
  manifest_sha256 text,
  installed_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  check (manifest_sha256 is null or manifest_sha256 ~ '^[0-9a-f]{64}$'),
  check (
    (phase='installed' and manifest_sha256 is null and completed_at is null)
    or
    (phase='complete' and manifest_sha256 is not null and completed_at is not null)
  )
);

insert into public.cloud_catalog_cache_epoch_v2_rollout(singleton)
values (true)
on conflict (singleton) do nothing;

alter table public.cloud_catalog_cache_epoch_v2_rollout enable row level security;
alter table public.cloud_catalog_cache_epoch_v2_rollout force row level security;
revoke all on table public.cloud_catalog_cache_epoch_v2_rollout
  from public,anon,authenticated,service_role;

create or replace function public.norva_bump_global_catalog_visibility_epoch()
returns bigint
language sql
volatile
security definer
set search_path=''
as $function$
  update public.cloud_global_catalog_visibility_epoch epoch
  set global_epoch=epoch.global_epoch+1,
      updated_at=clock_timestamp()
  where epoch.singleton
  returning epoch.global_epoch
$function$;

revoke all on function public.norva_bump_global_catalog_visibility_epoch()
  from public,anon,authenticated,service_role;

create or replace function public.norva_catalog_cache_epoch_v2(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $function$
declare
  v_sql_role text:=nullif(current_setting('role',true),'none');
  v_user_epoch bigint;
  v_global_epoch bigint;
begin
  if p_user_id is null then return null; end if;
  if coalesce(v_sql_role,'')<>'service_role'
     and not (
       coalesce(v_sql_role,'') in ('','postgres','supabase_admin')
       and session_user in ('postgres','supabase_admin')
     )
     and auth.uid() is distinct from p_user_id then
    return null;
  end if;
  select epoch.global_epoch into strict v_global_epoch
  from public.cloud_global_catalog_visibility_epoch epoch
  where epoch.singleton;
  select coalesce(epoch.visibility_epoch,1) into v_user_epoch
  from (select 1) baseline
  left join public.cloud_user_catalog_visibility_epochs epoch
    on epoch.user_id=p_user_id;
  return jsonb_build_object(
    'contract','catalog-cache-epoch-v2',
    'globalEpoch',v_global_epoch,
    'userEpoch',v_user_epoch,
    'cacheEpoch','v2.'||v_global_epoch::text||'.'||v_user_epoch::text
  );
end
$function$;

revoke all on function public.norva_catalog_cache_epoch_v2(uuid)
  from public,anon;
grant execute on function public.norva_catalog_cache_epoch_v2(uuid)
  to authenticated,service_role;

create or replace function public.norva_complete_catalog_cache_epoch_v2_rollout(
  p_contract text,
  p_manifest_sha256 text
) returns jsonb
language plpgsql
volatile
security definer
set search_path=''
as $function$
declare
  v_role text:=coalesce(nullif(current_setting('role',true),'none'),'');
  v_rollout public.cloud_catalog_cache_epoch_v2_rollout%rowtype;
begin
  if v_role<>'service_role'
     and not (
       v_role in ('','postgres','supabase_admin')
       and session_user in ('postgres','supabase_admin')
     ) then
    raise exception 'service role required' using errcode='42501';
  end if;
  if p_contract is distinct from 'catalog-cache-epoch-v2'
     or p_manifest_sha256 is distinct from
       '23c0fa2cdaf09c08d9de4378d1a82f0f631ce71d6f955a0bdbb2c786b8ff98d3' then
    raise exception 'catalog cache epoch v2 manifest mismatch'
      using errcode='22023';
  end if;
  select rollout.* into strict v_rollout
  from public.cloud_catalog_cache_epoch_v2_rollout rollout
  where rollout.singleton
  for update;
  if v_rollout.phase='complete' then
    if v_rollout.contract is distinct from p_contract
       or v_rollout.manifest_sha256 is distinct from p_manifest_sha256 then
      raise exception 'catalog cache epoch v2 completion is immutable'
        using errcode='22023';
    end if;
  else
    update public.cloud_catalog_cache_epoch_v2_rollout rollout
    set phase='complete',
        manifest_sha256=p_manifest_sha256,
        completed_at=clock_timestamp(),
        updated_at=clock_timestamp()
    where rollout.singleton
    returning rollout.* into strict v_rollout;
    perform public.norva_bump_global_catalog_visibility_epoch();
  end if;
  return jsonb_build_object(
    'contract',v_rollout.contract,
    'phase',upper(v_rollout.phase),
    'manifestSha256',v_rollout.manifest_sha256,
    'completedAt',v_rollout.completed_at
  );
end
$function$;

revoke all on function public.norva_complete_catalog_cache_epoch_v2_rollout(text,text)
  from public,anon,authenticated;
grant execute on function public.norva_complete_catalog_cache_epoch_v2_rollout(text,text)
  to service_role;

-- This function already owns the historical AFTER UPDATE trigger. Replacing
-- its body keeps the trigger topology stable while atomically guarding the
-- visibility flag and invalidating all caches for global policy changes.
lock table public.admin_feature_flags in share row exclusive mode;

create or replace function public.norva_provider_access_flag_visibility_changed()
returns trigger
language plpgsql
security definer
set search_path=''
as $function$
begin
  if new.key='provider_access_visibility_v1_enabled'
     and new.enabled
     and not coalesce(old.enabled,false)
     and not exists(
       select 1 from public.cloud_catalog_cache_epoch_v2_rollout rollout
       where rollout.singleton and rollout.phase='complete'
         and rollout.contract='catalog-cache-epoch-v2'
         and rollout.manifest_sha256=
           '23c0fa2cdaf09c08d9de4378d1a82f0f631ce71d6f955a0bdbb2c786b8ff98d3'
         and rollout.completed_at is not null
     ) then
    raise exception 'provider access visibility flags require global cache epoch v2'
      using errcode='55000',detail='reason=global_visibility_epoch_v2_required';
  end if;
  if new.key in ('provider_access_v1_enabled','provider_access_visibility_v1_enabled')
     and new.enabled is distinct from old.enabled then
    perform public.norva_bump_global_catalog_visibility_epoch();
  end if;
  return new;
end
$function$;

revoke all on function public.norva_provider_access_flag_visibility_changed()
from public,anon,authenticated,service_role;

do $postcondition$
begin
  if (select count(*)<>1 from public.cloud_global_catalog_visibility_epoch where singleton)
     or (select count(*)<>1 or bool_or(phase<>'installed' or completed_at is not null)
         from public.cloud_catalog_cache_epoch_v2_rollout where singleton)
     or not public.norva_provider_access_foundation_trigger_is_exact(
       'public.admin_feature_flags','trg_provider_access_flag_visibility_epoch',
       'public.norva_provider_access_flag_visibility_changed()'::regprocedure,17)
     or coalesce((select enabled from public.admin_feature_flags
                  where key='provider_access_visibility_v1_enabled'),true) then
    raise exception 'catalog cache epoch v2 installation drift' using errcode='55000';
  end if;
end
$postcondition$;

commit;
