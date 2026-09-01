begin;

create table public.media_cache_work_results (
  work_fingerprint text primary key,
  object_key text not null references public.media_cache_objects(object_key) on delete cascade,
  ready_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  constraint media_cache_work_results_fingerprint_check
    check (work_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint media_cache_work_results_expiry_check
    check (expires_at > ready_at)
);

create index media_cache_work_results_expiry_idx
  on public.media_cache_work_results (expires_at);

create table public.media_cache_producer_leases (
  work_fingerprint text primary key,
  account_fingerprint text not null,
  lease_token uuid not null unique,
  owner_instance_fingerprint text not null,
  stage text not null default 'probing',
  preempt_requested boolean not null default false,
  follower_count integer not null default 0,
  acquired_at timestamptz not null default clock_timestamp(),
  heartbeat_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  constraint media_cache_producer_leases_fingerprint_check check (
    work_fingerprint ~ '^[0-9a-f]{64}$'
    and account_fingerprint ~ '^[0-9a-f]{64}$'
    and owner_instance_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  constraint media_cache_producer_leases_stage_check check (
    stage in ('probing', 'producing', 'uploading', 'finalizing')
  ),
  constraint media_cache_producer_leases_followers_check
    check (follower_count between 0 and 1000000),
  constraint media_cache_producer_leases_expiry_check
    check (expires_at > acquired_at)
);

create index media_cache_producer_leases_account_idx
  on public.media_cache_producer_leases (account_fingerprint, expires_at);

create index media_cache_producer_leases_expiry_idx
  on public.media_cache_producer_leases (expires_at);

alter table public.media_cache_work_results enable row level security;
alter table public.media_cache_work_results force row level security;
alter table public.media_cache_producer_leases enable row level security;
alter table public.media_cache_producer_leases force row level security;

revoke all on table public.media_cache_work_results from public, anon, authenticated;
revoke all on table public.media_cache_producer_leases from public, anon, authenticated;
grant select, insert, update, delete on table public.media_cache_work_results to service_role;
grant select, insert, update, delete on table public.media_cache_producer_leases to service_role;

create or replace function public.norva_claim_media_cache_producer(
  p_work_fingerprint text,
  p_account_fingerprint text,
  p_owner_instance_fingerprint text,
  p_ttl_seconds integer default 120
) returns table (
  claim_role text,
  lease_token uuid,
  object_key text,
  lease_expires_at timestamptz,
  preempt_requested boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_token uuid := gen_random_uuid();
  v_ready_object text;
  v_existing public.media_cache_producer_leases%rowtype;
begin
  if p_work_fingerprint is null or p_work_fingerprint !~ '^[0-9a-f]{64}$'
     or p_account_fingerprint is null or p_account_fingerprint !~ '^[0-9a-f]{64}$'
     or p_owner_instance_fingerprint is null or p_owner_instance_fingerprint !~ '^[0-9a-f]{64}$'
     or p_ttl_seconds is null
     or p_ttl_seconds not between 30 and 300 then
    return;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_work_fingerprint, 864691128455135234::bigint)
  );

  select result.object_key
    into v_ready_object
    from public.media_cache_work_results result
    join public.media_cache_objects object on object.object_key = result.object_key
   where result.work_fingerprint = p_work_fingerprint
     and result.expires_at > v_now
     and object.state = 'ready'
     and object.quarantined_at is null
     and object.expires_at > v_now
   limit 1;

  if v_ready_object is not null then
    return query select 'ready'::text, null::uuid, v_ready_object, null::timestamptz, false;
    return;
  end if;

  delete from public.media_cache_work_results
   where work_fingerprint = p_work_fingerprint
     and expires_at <= v_now;
  delete from public.media_cache_producer_leases
   where work_fingerprint = p_work_fingerprint
     and expires_at <= v_now;

  insert into public.media_cache_producer_leases (
    work_fingerprint,
    account_fingerprint,
    lease_token,
    owner_instance_fingerprint,
    stage,
    preempt_requested,
    follower_count,
    acquired_at,
    heartbeat_at,
    expires_at
  ) values (
    p_work_fingerprint,
    p_account_fingerprint,
    v_token,
    p_owner_instance_fingerprint,
    'probing',
    false,
    0,
    v_now,
    v_now,
    v_now + make_interval(secs => p_ttl_seconds)
  )
  on conflict (work_fingerprint) do nothing;

  if found then
    return query select 'leader'::text, v_token, null::text,
      v_now + make_interval(secs => p_ttl_seconds), false;
    return;
  end if;

  update public.media_cache_producer_leases lease
     set follower_count = least(1000000, lease.follower_count + 1)
   where lease.work_fingerprint = p_work_fingerprint
  returning lease.* into v_existing;

  if v_existing.work_fingerprint is not null then
    return query select 'follower'::text, null::uuid, null::text,
      v_existing.expires_at, v_existing.preempt_requested;
  end if;
end
$function$;

create or replace function public.norva_renew_media_cache_producer(
  p_work_fingerprint text,
  p_lease_token uuid,
  p_owner_instance_fingerprint text,
  p_stage text,
  p_ttl_seconds integer default 120
) returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_renewed boolean := false;
begin
  if p_work_fingerprint is null or p_work_fingerprint !~ '^[0-9a-f]{64}$'
     or p_lease_token is null
     or p_owner_instance_fingerprint is null or p_owner_instance_fingerprint !~ '^[0-9a-f]{64}$'
     or p_stage is null
     or p_stage not in ('probing', 'producing', 'uploading', 'finalizing')
     or p_ttl_seconds is null
     or p_ttl_seconds not between 30 and 300 then
    return false;
  end if;
  update public.media_cache_producer_leases
     set stage = p_stage,
         heartbeat_at = v_now,
         expires_at = v_now + make_interval(secs => p_ttl_seconds)
   where work_fingerprint = p_work_fingerprint
     and lease_token = p_lease_token
     and owner_instance_fingerprint = p_owner_instance_fingerprint
     and expires_at > v_now
     and not preempt_requested
  returning true into v_renewed;
  return coalesce(v_renewed, false);
end
$function$;

create or replace function public.norva_resolve_media_cache_work(
  p_work_fingerprint text
) returns table (
  work_state text,
  object_key text,
  producer_stage text,
  lease_expires_at timestamptz,
  preempt_requested boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
begin
  if p_work_fingerprint is null or p_work_fingerprint !~ '^[0-9a-f]{64}$' then return; end if;
  return query
  select 'ready'::text, result.object_key, null::text, null::timestamptz, false
    from public.media_cache_work_results result
    join public.media_cache_objects object on object.object_key = result.object_key
   where result.work_fingerprint = p_work_fingerprint
     and result.expires_at > v_now
     and object.state = 'ready'
     and object.quarantined_at is null
     and object.expires_at > v_now
  union all
  select 'producing'::text, null::text, lease.stage, lease.expires_at, lease.preempt_requested
    from public.media_cache_producer_leases lease
   where lease.work_fingerprint = p_work_fingerprint
     and lease.expires_at > v_now
     and not exists (
       select 1 from public.media_cache_work_results result
        where result.work_fingerprint = p_work_fingerprint
          and result.expires_at > v_now
     )
  limit 1;
end
$function$;

create or replace function public.norva_preempt_media_cache_producers(
  p_account_fingerprint text
) returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_count integer := 0;
begin
  if p_account_fingerprint is null or p_account_fingerprint !~ '^[0-9a-f]{64}$' then return 0; end if;
  update public.media_cache_producer_leases
     set preempt_requested = true,
         heartbeat_at = clock_timestamp()
   where account_fingerprint = p_account_fingerprint
     and expires_at > clock_timestamp()
     and not preempt_requested;
  get diagnostics v_count = row_count;
  return v_count;
end
$function$;

create or replace function public.norva_complete_media_cache_producer(
  p_work_fingerprint text,
  p_lease_token uuid,
  p_owner_instance_fingerprint text,
  p_object_key text
) returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_object_expiry timestamptz;
begin
  if p_work_fingerprint is null or p_work_fingerprint !~ '^[0-9a-f]{64}$'
     or p_lease_token is null
     or p_owner_instance_fingerprint is null or p_owner_instance_fingerprint !~ '^[0-9a-f]{64}$'
     or p_object_key is null or p_object_key !~ '^[0-9a-f]{64}$' then
    return false;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_work_fingerprint, 864691128455135234::bigint)
  );
  if not exists (
    select 1 from public.media_cache_producer_leases lease
     where lease.work_fingerprint = p_work_fingerprint
       and lease.lease_token = p_lease_token
       and lease.owner_instance_fingerprint = p_owner_instance_fingerprint
       and lease.expires_at > v_now
       and not lease.preempt_requested
  ) then return false; end if;

  select object.expires_at into v_object_expiry
    from public.media_cache_objects object
   where object.object_key = p_object_key
     and object.state = 'ready'
     and object.quarantined_at is null
     and object.expires_at > v_now;
  if v_object_expiry is null then return false; end if;

  insert into public.media_cache_work_results (work_fingerprint, object_key, ready_at, expires_at)
  values (p_work_fingerprint, p_object_key, v_now, v_object_expiry)
  on conflict (work_fingerprint) do update
     set object_key = excluded.object_key,
         ready_at = excluded.ready_at,
         expires_at = excluded.expires_at;

  delete from public.media_cache_producer_leases
   where work_fingerprint = p_work_fingerprint
     and lease_token = p_lease_token
     and owner_instance_fingerprint = p_owner_instance_fingerprint;
  return found;
end
$function$;

create or replace function public.norva_abandon_media_cache_producer(
  p_work_fingerprint text,
  p_lease_token uuid,
  p_owner_instance_fingerprint text
) returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_deleted boolean := false;
begin
  if p_work_fingerprint is null or p_work_fingerprint !~ '^[0-9a-f]{64}$'
     or p_lease_token is null
     or p_owner_instance_fingerprint is null or p_owner_instance_fingerprint !~ '^[0-9a-f]{64}$' then
    return false;
  end if;
  delete from public.media_cache_producer_leases
   where work_fingerprint = p_work_fingerprint
     and lease_token = p_lease_token
     and owner_instance_fingerprint = p_owner_instance_fingerprint
  returning true into v_deleted;
  return coalesce(v_deleted, false);
end
$function$;

revoke all on function public.norva_claim_media_cache_producer(text, text, text, integer)
  from public, anon, authenticated;
revoke all on function public.norva_renew_media_cache_producer(text, uuid, text, text, integer)
  from public, anon, authenticated;
revoke all on function public.norva_resolve_media_cache_work(text)
  from public, anon, authenticated;
revoke all on function public.norva_preempt_media_cache_producers(text)
  from public, anon, authenticated;
revoke all on function public.norva_complete_media_cache_producer(text, uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.norva_abandon_media_cache_producer(text, uuid, text)
  from public, anon, authenticated;

grant execute on function public.norva_claim_media_cache_producer(text, text, text, integer)
  to service_role;
grant execute on function public.norva_renew_media_cache_producer(text, uuid, text, text, integer)
  to service_role;
grant execute on function public.norva_resolve_media_cache_work(text)
  to service_role;
grant execute on function public.norva_preempt_media_cache_producers(text)
  to service_role;
grant execute on function public.norva_complete_media_cache_producer(text, uuid, text, text)
  to service_role;
grant execute on function public.norva_abandon_media_cache_producer(text, uuid, text)
  to service_role;

comment on table public.media_cache_producer_leases is
  'Distributed singleflight lease keyed only by HMAC work and account fingerprints; one provider/FFmpeg producer may have many followers.';
comment on table public.media_cache_work_results is
  'Short server-only mapping from an HMAC work identity to one ready immutable global media object.';

notify pgrst, 'reload schema';

commit;
