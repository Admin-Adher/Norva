begin;

create table if not exists public.cloud_source_finalize_leases (
  source_id uuid primary key references public.cloud_sources(id) on delete cascade,
  user_id uuid not null,
  lease_token uuid not null,
  lease_until timestamptz not null,
  updated_at timestamptz not null default statement_timestamp(),
  check (lease_until > updated_at)
);

alter table public.cloud_source_finalize_leases enable row level security;
revoke all on table public.cloud_source_finalize_leases from public, anon, authenticated, service_role;

create or replace function public.norva_claim_source_finalize_lease(
  p_source_id uuid, p_user_id uuid, p_lease_token uuid, p_ttl_seconds integer default 240
) returns boolean
language plpgsql security definer set search_path = ''
as $function$
declare v_claimed boolean := false; v_until timestamptz;
begin
  if p_lease_token is null or p_ttl_seconds not between 30 and 900 then return false; end if;
  v_until := statement_timestamp() + make_interval(secs => p_ttl_seconds);
  insert into public.cloud_source_finalize_leases as lease(source_id,user_id,lease_token,lease_until,updated_at)
  select p_source_id,p_user_id,p_lease_token,v_until,statement_timestamp()
  where exists (select 1 from public.cloud_sources source where source.id=p_source_id and source.user_id=p_user_id and source.deleted_at is null and source.enabled)
  on conflict (source_id) do update set
    user_id=excluded.user_id, lease_token=excluded.lease_token,
    lease_until=excluded.lease_until, updated_at=excluded.updated_at
  where lease.lease_until <= statement_timestamp()
  returning true into v_claimed;
  return coalesce(v_claimed,false);
end
$function$;

create or replace function public.norva_renew_source_finalize_lease(
  p_source_id uuid, p_user_id uuid, p_lease_token uuid, p_ttl_seconds integer default 240
) returns boolean
language plpgsql security definer set search_path = ''
as $function$
declare v_claimed boolean := false;
begin
  if p_lease_token is null or p_ttl_seconds not between 30 and 900 then return false; end if;
  update public.cloud_source_finalize_leases lease set
    lease_until=statement_timestamp()+make_interval(secs=>p_ttl_seconds), updated_at=statement_timestamp()
  where lease.source_id=p_source_id and lease.user_id=p_user_id and lease.lease_token=p_lease_token
  returning true into v_claimed;
  return coalesce(v_claimed,false);
end
$function$;

create or replace function public.norva_release_source_finalize_lease(
  p_source_id uuid, p_user_id uuid, p_lease_token uuid
) returns boolean
language plpgsql security definer set search_path = ''
as $function$
declare v_released boolean := false;
begin
  delete from public.cloud_source_finalize_leases lease
  where lease.source_id=p_source_id and lease.user_id=p_user_id and lease.lease_token=p_lease_token
  returning true into v_released;
  return coalesce(v_released,false);
end
$function$;

revoke all on function public.norva_claim_source_finalize_lease(uuid,uuid,uuid,integer) from public,anon,authenticated;
revoke all on function public.norva_renew_source_finalize_lease(uuid,uuid,uuid,integer) from public,anon,authenticated;
revoke all on function public.norva_release_source_finalize_lease(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.norva_claim_source_finalize_lease(uuid,uuid,uuid,integer) to service_role;
grant execute on function public.norva_renew_source_finalize_lease(uuid,uuid,uuid,integer) to service_role;
grant execute on function public.norva_release_source_finalize_lease(uuid,uuid,uuid) to service_role;

comment on table public.cloud_source_finalize_leases is 'Durable CAS owner for one catalogue finalizer per source; config_hint lease is observability only.';

commit;
