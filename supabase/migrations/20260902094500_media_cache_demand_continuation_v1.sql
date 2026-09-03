begin;

-- A producer becomes preemptable only after the foreground viewer has asked
-- Edge to close its session and at least one follower is still waiting. This
-- flag prevents a new playback from ever preempting another active viewer.
alter table public.media_cache_producer_leases
  add column background_continuation boolean not null default false;

create index media_cache_producer_leases_background_account_idx
  on public.media_cache_producer_leases (account_fingerprint, expires_at)
  where background_continuation;

create function public.norva_request_media_cache_continuation_for_gateway(
  p_playback_session_id uuid,
  p_gateway_session_id uuid,
  p_ttl_seconds integer default 120
) returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_gateway public.cloud_gateway_sessions%rowtype;
  v_requested boolean := false;
begin
  if p_playback_session_id is null or p_gateway_session_id is null
     or p_ttl_seconds not between 30 and 300 then return false; end if;

  select gateway.* into v_gateway
    from public.cloud_gateway_sessions gateway
   where gateway.playback_session_id = p_playback_session_id
     and gateway.external_session_id = p_gateway_session_id::text
     and gateway.status in ('pending', 'starting', 'ready')
   limit 1;
  if not found or v_gateway.media_cache_lease_token is null then return false; end if;

  update public.media_cache_producer_leases lease
     set background_continuation = true,
         heartbeat_at = v_now,
         expires_at = v_now + pg_catalog.make_interval(secs => p_ttl_seconds)
   where lease.work_fingerprint = v_gateway.media_cache_work_fingerprint
     and lease.account_fingerprint = v_gateway.media_cache_account_fingerprint
     and lease.lease_token = v_gateway.media_cache_lease_token
     and lease.owner_instance_fingerprint = v_gateway.media_cache_owner_instance_fingerprint
     and lease.expires_at > v_now
     and not lease.preempt_requested
     and lease.follower_count > 0
  returning true into v_requested;
  return coalesce(v_requested, false);
end
$function$;

create function public.norva_pulse_media_cache_continuation_for_gateway(
  p_playback_session_id uuid,
  p_gateway_session_id uuid,
  p_stage text,
  p_ttl_seconds integer default 120
) returns text
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_gateway public.cloud_gateway_sessions%rowtype;
  v_renewed boolean := false;
  v_lease public.media_cache_producer_leases%rowtype;
begin
  if p_playback_session_id is null or p_gateway_session_id is null
     or p_stage not in ('probing', 'producing', 'uploading', 'finalizing')
     or p_ttl_seconds not between 30 and 300 then return 'invalid'; end if;

  select gateway.* into v_gateway
    from public.cloud_gateway_sessions gateway
   where gateway.playback_session_id = p_playback_session_id
     and gateway.external_session_id = p_gateway_session_id::text
     and gateway.status <> 'failed'
   limit 1;
  if not found or v_gateway.media_cache_lease_token is null then return 'missing'; end if;

  update public.media_cache_producer_leases lease
     set stage = p_stage,
         heartbeat_at = v_now,
         expires_at = v_now + pg_catalog.make_interval(secs => p_ttl_seconds)
   where lease.work_fingerprint = v_gateway.media_cache_work_fingerprint
     and lease.account_fingerprint = v_gateway.media_cache_account_fingerprint
     and lease.lease_token = v_gateway.media_cache_lease_token
     and lease.owner_instance_fingerprint = v_gateway.media_cache_owner_instance_fingerprint
     and lease.background_continuation
     and lease.follower_count > 0
     and lease.expires_at > v_now
     and not lease.preempt_requested
  returning true into v_renewed;
  if coalesce(v_renewed, false) then return 'renewed'; end if;

  select lease.* into v_lease
    from public.media_cache_producer_leases lease
   where lease.work_fingerprint = v_gateway.media_cache_work_fingerprint
     and lease.lease_token = v_gateway.media_cache_lease_token
   limit 1;
  if not found then return 'missing'; end if;
  if v_lease.preempt_requested then return 'preempted'; end if;
  if v_lease.background_continuation and v_lease.follower_count <= 0 then return 'idle'; end if;
  return 'expired';
end
$function$;

-- Only detached work is preempted. Foreground producer leases are deliberately
-- excluded even when they belong to the same provider account.
create function public.norva_preempt_background_media_cache_producers(
  p_account_fingerprint text,
  p_except_work_fingerprint text default null
) returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_count integer := 0;
begin
  if p_account_fingerprint is null or p_account_fingerprint !~ '^[0-9a-f]{64}$'
     or (p_except_work_fingerprint is not null
       and p_except_work_fingerprint !~ '^[0-9a-f]{64}$') then return 0; end if;
  update public.media_cache_producer_leases lease
     set preempt_requested = true,
         heartbeat_at = clock_timestamp()
   where lease.account_fingerprint = p_account_fingerprint
     and lease.background_continuation
     and lease.expires_at > clock_timestamp()
     and not lease.preempt_requested
     and (p_except_work_fingerprint is null
       or lease.work_fingerprint <> p_except_work_fingerprint);
  get diagnostics v_count = row_count;
  return v_count;
end
$function$;

create function public.norva_count_background_media_cache_producers(
  p_account_fingerprint text,
  p_except_work_fingerprint text default null
) returns integer
language sql
volatile
security definer
set search_path = ''
as $function$
  select case
    when p_account_fingerprint is null
      or p_account_fingerprint !~ '^[0-9a-f]{64}$'
      or (p_except_work_fingerprint is not null
        and p_except_work_fingerprint !~ '^[0-9a-f]{64}$')
      then 0
    else (
      select count(*)::integer
        from public.media_cache_producer_leases lease
       where lease.account_fingerprint = p_account_fingerprint
         and lease.background_continuation
         and lease.expires_at > clock_timestamp()
         -- Upload/finalization no longer owns the provider socket or FFmpeg.
         -- It remains preempt-requested above, but must not delay the next
         -- foreground connection while its private R2 request unwinds.
         and lease.stage in ('probing', 'producing')
         and (p_except_work_fingerprint is null
           or lease.work_fingerprint <> p_except_work_fingerprint)
    )
  end
$function$;

-- When the final waiting viewer leaves, the next bounded continuation pulse
-- must stop instead of filling an unrequested catalogue asset.
create or replace function public.norva_leave_media_cache_follower(
  p_work_fingerprint text
) returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_left boolean := false;
begin
  if p_work_fingerprint is null or p_work_fingerprint !~ '^[0-9a-f]{64}$' then return false; end if;
  update public.media_cache_producer_leases lease
     set follower_count = greatest(0, lease.follower_count - 1),
         preempt_requested = lease.preempt_requested
           or (lease.background_continuation and lease.follower_count = 1),
         heartbeat_at = case
           when lease.background_continuation and lease.follower_count = 1
             then clock_timestamp()
           else lease.heartbeat_at
         end
   where lease.work_fingerprint = p_work_fingerprint
     and lease.follower_count > 0
  returning true into v_left;
  return coalesce(v_left, false);
end
$function$;

revoke all on function public.norva_request_media_cache_continuation_for_gateway(uuid, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.norva_pulse_media_cache_continuation_for_gateway(uuid, uuid, text, integer)
  from public, anon, authenticated;
revoke all on function public.norva_preempt_background_media_cache_producers(text, text)
  from public, anon, authenticated;
revoke all on function public.norva_count_background_media_cache_producers(text, text)
  from public, anon, authenticated;

grant execute on function public.norva_request_media_cache_continuation_for_gateway(uuid, uuid, integer)
  to service_role;
grant execute on function public.norva_pulse_media_cache_continuation_for_gateway(uuid, uuid, text, integer)
  to service_role;
grant execute on function public.norva_preempt_background_media_cache_producers(text, text)
  to service_role;
grant execute on function public.norva_count_background_media_cache_producers(text, text)
  to service_role;

comment on column public.media_cache_producer_leases.background_continuation is
  'True only after the foreground viewer left and server-side follower demand authorized bounded, preemptable completion.';

notify pgrst, 'reload schema';

commit;
