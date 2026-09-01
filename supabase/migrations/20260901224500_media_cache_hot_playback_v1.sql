begin;

-- A ready shared object is claimed without touching the provider-account lock.
-- The caller supplies only the already server-resolved playback coordinates and
-- the entitlement limit. Object/binding authority is derived again inside this
-- transaction, under a per-user advisory lock, before a cache-only session and
-- its renewable grant become visible together.
create function public.norva_claim_media_cache_playback(
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
  v_cache_item_type text;
  v_binding_ids uuid[];
  v_binding public.media_cache_bindings%rowtype;
  v_authorized record;
  v_grant record;
  v_superseded uuid[] := '{}'::uuid[];
  v_current_streams integer := 0;
begin
  if p_session_id is null or p_user_id is null or p_source_id is null
     or p_item_type not in ('movie', 'series', 'episode')
     or length(btrim(coalesce(p_item_id, ''))) not between 1 and 512
     or p_target_url_hash is null or p_target_url_hash !~ '^[0-9a-f]{64}$'
     or p_expires_at is null or p_expires_at <= v_now
     or p_expires_at > v_now + interval '8 hours'
     or p_ticket_ttl_seconds not between 30 and 300
     or p_concurrent_limit not between 1 and 64 then
    raise exception 'invalid media cache playback claim' using errcode = '22023';
  end if;

  v_cache_item_type := case
    when p_item_type = 'movie' then 'movie'
    else 'episode'
  end;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('media-cache-user:' || p_user_id::text, 0)
  );
  v_now := clock_timestamp();
  if p_expires_at <= v_now then
    raise exception 'invalid media cache playback claim' using errcode = '22023';
  end if;

  select array_agg(binding.id order by binding.id)
    into v_binding_ids
    from public.media_cache_bindings binding
   where binding.user_id = p_user_id
     and binding.source_id = p_source_id
     and binding.item_type = v_cache_item_type
     and binding.external_id = btrim(p_item_id)
     and binding.target_url_sha256 = p_target_url_hash
     and binding.state = 'active';
  if coalesce(cardinality(v_binding_ids), 0) <> 1 then return; end if;

  select binding.* into v_binding
    from public.media_cache_bindings binding
   where binding.id = v_binding_ids[1];

  select authorized.* into v_authorized
    from public.norva_authorize_media_cache_object(
      v_binding.object_key,
      p_user_id,
      p_source_id,
      v_cache_item_type,
      p_item_id,
      p_target_url_hash,
      v_binding.variant_id
    ) authorized;
  if not found or v_authorized.binding_id <> v_binding.id then return; end if;

  -- A real device replaces its own prior playback. Browser sessions without a
  -- durable device id replace only the same exact item; independent tabs may
  -- otherwise coexist up to the account entitlement.
  select coalesce(array_agg(session.id order by session.created_at), '{}'::uuid[])
    into v_superseded
    from public.cloud_playback_sessions session
   where session.user_id = p_user_id
     and session.status in ('pending', 'ready')
     and session.superseded_at is null
     and (
       (p_device_id is not null and session.device_id = p_device_id)
       or (
         p_device_id is null
         and session.device_id is null
         and session.source_id = p_source_id
         and session.item_type = p_item_type
         and session.item_id = p_item_id
       )
     );

  select count(*)::integer
    into v_current_streams
    from public.cloud_playback_sessions session
   where session.user_id = p_user_id
     and session.status in ('pending', 'ready')
     and session.superseded_at is null
     and session.expires_at > v_now
     and not (session.id = any(v_superseded));

  if v_current_streams >= p_concurrent_limit then
    return query select
      true, true, v_current_streams, null::uuid, '{}'::uuid[],
      v_authorized.binding_id, v_authorized.object_key,
      v_authorized.storage_backend, v_authorized.object_prefix,
      v_authorized.root_playlist, v_authorized.manifest_sha256,
      null::timestamptz, null::timestamptz;
    return;
  end if;

  update public.cloud_playback_sessions session
     set status = 'expired',
         expires_at = least(session.expires_at, v_now),
         superseded_at = v_now,
         updated_at = v_now
   where session.id = any(v_superseded);

  insert into public.cloud_playback_sessions (
    id, user_id, source_id, device_id, item_type, item_id, mode, status,
    target_url_hash, provider_account_hash, stream_mime, playback_hint, expires_at
  ) values (
    p_session_id, p_user_id, p_source_id, p_device_id, p_item_type, p_item_id,
    'direct', 'ready', p_target_url_hash, null,
    coalesce(nullif(btrim(p_stream_mime), ''), 'application/vnd.apple.mpegurl'),
    coalesce(p_playback_hint, '{}'::jsonb), p_expires_at
  );

  select grant_row.* into v_grant
    from public.norva_authorize_media_cache_playback(
      p_session_id,
      p_user_id,
      v_authorized.object_key,
      p_ticket_ttl_seconds
    ) grant_row;
  if not found
     or v_grant.binding_id <> v_authorized.binding_id
     or v_grant.object_key <> v_authorized.object_key then
    raise exception 'media cache playback grant could not be committed' using errcode = '55000';
  end if;

  return query select
    true, false, v_current_streams, p_session_id, v_superseded,
    v_grant.binding_id, v_grant.object_key, v_grant.storage_backend,
    v_grant.object_prefix, v_grant.root_playlist, v_grant.manifest_sha256,
    v_grant.ticket_expires_at, v_grant.hard_expires_at;
end
$function$;

revoke all on function public.norva_claim_media_cache_playback(
  uuid, uuid, uuid, uuid, text, text, text, text, jsonb,
  timestamptz, integer, integer
) from public, anon, authenticated;
grant execute on function public.norva_claim_media_cache_playback(
  uuid, uuid, uuid, uuid, text, text, text, text, jsonb,
  timestamptz, integer, integer
) to service_role;

comment on function public.norva_claim_media_cache_playback(
  uuid, uuid, uuid, uuid, text, text, text, text, jsonb,
  timestamptz, integer, integer
) is 'Atomically claims an authorized ready shared HLS object without provider affinity, enforcing per-user capacity and issuing its first renewable grant.';

notify pgrst, 'reload schema';

commit;
