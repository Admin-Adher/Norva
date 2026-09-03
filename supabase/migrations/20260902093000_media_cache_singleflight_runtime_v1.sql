begin;

-- The opaque producer claim is attached only to the trusted Gateway session.
-- Browsers never receive the lease token or either HMAC fingerprint.
alter table public.cloud_gateway_sessions
  add column media_cache_work_fingerprint text,
  add column media_cache_account_fingerprint text,
  add column media_cache_lease_token uuid,
  add column media_cache_owner_instance_fingerprint text;

alter table public.cloud_gateway_sessions
  add constraint cloud_gateway_sessions_media_cache_producer_context_check check (
    (
      pg_catalog.num_nonnulls(
        media_cache_work_fingerprint,
        media_cache_account_fingerprint,
        media_cache_lease_token,
        media_cache_owner_instance_fingerprint
      ) = 0
    )
    or
    (
      pg_catalog.num_nonnulls(
        media_cache_work_fingerprint,
        media_cache_account_fingerprint,
        media_cache_lease_token,
        media_cache_owner_instance_fingerprint
      ) = 4
      and
      media_cache_work_fingerprint ~ '^[0-9a-f]{64}$'
      and media_cache_account_fingerprint ~ '^[0-9a-f]{64}$'
      and media_cache_owner_instance_fingerprint ~ '^[0-9a-f]{64}$'
    )
  );

create unique index cloud_gateway_sessions_media_cache_lease_unique
  on public.cloud_gateway_sessions (media_cache_lease_token)
  where media_cache_lease_token is not null;

-- A follower supplies only its server-resolved current catalogue coordinates
-- plus the server-only HMAC work identity. The immutable object is resolved
-- from the completed lease, and the exact current variant is derived again in
-- this transaction before binding and issuing the first private ticket.
create function public.norva_claim_ready_media_cache_work_playback(
  p_work_fingerprint text,
  p_session_id uuid,
  p_user_id uuid,
  p_source_id uuid,
  p_device_id uuid,
  p_item_type text,
  p_item_id text,
  p_target_url_hash text,
  p_stream_mime text,
  p_playback_hint jsonb,
  p_expires_at timestamptz,
  p_ticket_ttl_seconds integer,
  p_concurrent_limit integer
) returns table (
  cache_hit boolean,
  capacity_exceeded boolean,
  current_streams integer,
  new_session_id uuid,
  superseded_session_ids uuid[],
  binding_id uuid,
  object_key text,
  storage_backend text,
  object_prefix text,
  root_playlist text,
  manifest_sha256 text,
  ticket_expires_at timestamptz,
  hard_expires_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_object_key text;
  v_cache_item_type text;
  v_variant_ids uuid[];
  v_variant_id uuid;
  v_binding_id uuid;
begin
  if p_work_fingerprint is null or p_work_fingerprint !~ '^[0-9a-f]{64}$'
     or p_session_id is null or p_user_id is null or p_source_id is null
     or p_item_type not in ('movie', 'series', 'episode')
     or length(btrim(coalesce(p_item_id, ''))) not between 1 and 512
     or p_target_url_hash is null or p_target_url_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid ready media cache work claim' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_work_fingerprint, 864691128455135234::bigint)
  );
  select result.object_key
    into v_object_key
    from public.media_cache_work_results result
    join public.media_cache_objects object on object.object_key = result.object_key
   where result.work_fingerprint = p_work_fingerprint
     and result.expires_at > v_now
     and object.state = 'ready'
     and object.quarantined_at is null
     and object.expires_at > v_now
   limit 1;
  if v_object_key is null then return; end if;

  v_cache_item_type := case when p_item_type = 'movie' then 'movie' else 'episode' end;
  if v_cache_item_type = 'movie' then
    select array_agg(variant.id order by variant.id)
      into v_variant_ids
      from public.cloud_media_items item
      join public.cloud_source_catalog_heads head
        on head.user_id = item.user_id
       and head.source_id = item.source_id
       and head.active_generation_id = item.generation_id
      join public.cloud_title_variants variant
        on variant.user_id = item.user_id
       and variant.source_id = item.source_id
       and variant.generation_id = item.generation_id
       and variant.media_item_id = item.id
       and variant.item_type = 'movie'
       and variant.external_id = item.external_id
     where item.user_id = p_user_id
       and item.source_id = p_source_id
       and item.item_type = 'movie'
       and item.external_id = btrim(p_item_id)
       and item.available;
  else
    select array_agg(coordinates.variant_id order by coordinates.variant_id)
      into v_variant_ids
      from public.catalog_series_episode_coordinates_by_episode(
        p_user_id, p_source_id, p_item_id
      ) coordinates;
  end if;
  if coalesce(cardinality(v_variant_ids), 0) <> 1 then return; end if;
  v_variant_id := v_variant_ids[1];

  v_binding_id := public.norva_bind_media_cache_object(
    v_object_key,
    p_user_id,
    p_source_id,
    v_cache_item_type,
    p_item_id,
    p_target_url_hash,
    v_variant_id
  );
  if v_binding_id is null then return; end if;

  return query
  select claim.cache_hit, claim.capacity_exceeded, claim.current_streams,
         claim.new_session_id, claim.superseded_session_ids,
         claim.binding_id, claim.object_key, claim.storage_backend,
         claim.object_prefix, claim.root_playlist, claim.manifest_sha256,
         claim.ticket_expires_at, claim.hard_expires_at
    from public.norva_claim_media_cache_playback(
      p_session_id,
      p_user_id,
      p_source_id,
      p_device_id,
      p_item_type,
      p_item_id,
      p_target_url_hash,
      p_stream_mime,
      p_playback_hint,
      p_expires_at,
      p_ticket_ttl_seconds,
      p_concurrent_limit
    ) claim
   where claim.binding_id = v_binding_id
     and claim.object_key = v_object_key;
end
$function$;

create function public.norva_leave_media_cache_follower(
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
     set follower_count = greatest(0, lease.follower_count - 1)
   where lease.work_fingerprint = p_work_fingerprint
     and lease.follower_count > 0
  returning true into v_left;
  return coalesce(v_left, false);
end
$function$;

-- Gateway heartbeats name only their own two session ids and stage. Lease
-- authority remains in the service-only row written by norva-playback.
create function public.norva_pulse_media_cache_producer_for_gateway(
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
  v_gateway public.cloud_gateway_sessions%rowtype;
begin
  if p_playback_session_id is null or p_gateway_session_id is null
     or p_stage not in ('probing', 'producing', 'uploading', 'finalizing') then
    return 'invalid';
  end if;
  select gateway.* into v_gateway
    from public.cloud_gateway_sessions gateway
   where gateway.playback_session_id = p_playback_session_id
     and gateway.external_session_id = p_gateway_session_id::text
     and gateway.status <> 'failed'
   limit 1;
  if not found or v_gateway.media_cache_lease_token is null then return 'missing'; end if;
  if public.norva_renew_media_cache_producer(
    v_gateway.media_cache_work_fingerprint,
    v_gateway.media_cache_lease_token,
    v_gateway.media_cache_owner_instance_fingerprint,
    p_stage,
    p_ttl_seconds
  ) then return 'renewed'; end if;
  if exists (
    select 1 from public.media_cache_producer_leases lease
     where lease.work_fingerprint = v_gateway.media_cache_work_fingerprint
       and lease.lease_token = v_gateway.media_cache_lease_token
       and lease.preempt_requested
  ) then return 'preempted'; end if;
  return 'expired';
end
$function$;

create function public.norva_complete_media_cache_producer_for_gateway(
  p_playback_session_id uuid,
  p_gateway_session_id uuid,
  p_user_id uuid,
  p_object_key text
) returns text
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_gateway public.cloud_gateway_sessions%rowtype;
begin
  if p_playback_session_id is null or p_gateway_session_id is null or p_user_id is null
     or p_object_key is null or p_object_key !~ '^[0-9a-f]{64}$' then return 'invalid'; end if;
  select gateway.* into v_gateway
    from public.cloud_gateway_sessions gateway
   where gateway.playback_session_id = p_playback_session_id
     and gateway.external_session_id = p_gateway_session_id::text
     and gateway.user_id = p_user_id
     and gateway.status <> 'failed'
   limit 1;
  if not found or v_gateway.media_cache_lease_token is null then return 'not-coordinated'; end if;
  if public.norva_complete_media_cache_producer(
    v_gateway.media_cache_work_fingerprint,
    v_gateway.media_cache_lease_token,
    v_gateway.media_cache_owner_instance_fingerprint,
    p_object_key
  ) then return 'completed'; end if;
  if exists (
    select 1 from public.media_cache_work_results result
     where result.work_fingerprint = v_gateway.media_cache_work_fingerprint
       and result.object_key = p_object_key
       and result.expires_at > clock_timestamp()
  ) then return 'already-completed'; end if;
  return 'rejected';
end
$function$;

create function public.norva_abandon_media_cache_producer_for_gateway(
  p_playback_session_id uuid,
  p_gateway_session_id uuid
) returns text
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_gateway public.cloud_gateway_sessions%rowtype;
begin
  if p_playback_session_id is null or p_gateway_session_id is null then return 'invalid'; end if;
  select gateway.* into v_gateway
    from public.cloud_gateway_sessions gateway
   where gateway.playback_session_id = p_playback_session_id
     and gateway.external_session_id = p_gateway_session_id::text
   limit 1;
  if not found or v_gateway.media_cache_lease_token is null then return 'missing'; end if;
  if public.norva_abandon_media_cache_producer(
    v_gateway.media_cache_work_fingerprint,
    v_gateway.media_cache_lease_token,
    v_gateway.media_cache_owner_instance_fingerprint
  ) then return 'abandoned'; end if;
  if exists (
    select 1 from public.media_cache_work_results result
     where result.work_fingerprint = v_gateway.media_cache_work_fingerprint
       and result.expires_at > clock_timestamp()
  ) then return 'completed'; end if;
  return 'missing';
end
$function$;

revoke all on function public.norva_claim_ready_media_cache_work_playback(
  text, uuid, uuid, uuid, uuid, text, text, text, text, jsonb,
  timestamptz, integer, integer
) from public, anon, authenticated;
revoke all on function public.norva_leave_media_cache_follower(text)
  from public, anon, authenticated;
revoke all on function public.norva_pulse_media_cache_producer_for_gateway(uuid, uuid, text, integer)
  from public, anon, authenticated;
revoke all on function public.norva_complete_media_cache_producer_for_gateway(uuid, uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.norva_abandon_media_cache_producer_for_gateway(uuid, uuid)
  from public, anon, authenticated;

grant execute on function public.norva_claim_ready_media_cache_work_playback(
  text, uuid, uuid, uuid, uuid, text, text, text, text, jsonb,
  timestamptz, integer, integer
) to service_role;
grant execute on function public.norva_leave_media_cache_follower(text) to service_role;
grant execute on function public.norva_pulse_media_cache_producer_for_gateway(uuid, uuid, text, integer)
  to service_role;
grant execute on function public.norva_complete_media_cache_producer_for_gateway(uuid, uuid, uuid, text)
  to service_role;
grant execute on function public.norva_abandon_media_cache_producer_for_gateway(uuid, uuid)
  to service_role;

comment on function public.norva_claim_ready_media_cache_work_playback(
  text, uuid, uuid, uuid, uuid, text, text, text, text, jsonb,
  timestamptz, integer, integer
) is 'Atomically derives a current follower binding from a completed server-only work lease and claims private cache playback.';

notify pgrst, 'reload schema';

commit;
