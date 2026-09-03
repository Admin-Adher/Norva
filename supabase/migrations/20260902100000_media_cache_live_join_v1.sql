begin;

-- The producer row remains the only owner of the provider socket and FFmpeg.
-- Every joined viewer gets a separate cloud playback row plus an opaque,
-- individually revocable Gateway attachment. No provider credential, URL or
-- Gateway bearer is copied into this coordination metadata.
alter table public.cloud_gateway_sessions
  add column media_cache_live_joinable_at timestamptz,
  add column media_cache_primary_attached boolean,
  add column media_cache_live_attachment_id uuid,
  add column media_cache_live_producer_gateway_row_id uuid
    references public.cloud_gateway_sessions(id) on delete set null,
  add column media_cache_live_work_fingerprint text,
  add column media_cache_live_attachment_state text;

alter table public.cloud_gateway_sessions
  add constraint cloud_gateway_sessions_media_cache_primary_viewer_check check (
    media_cache_primary_attached is null
    or media_cache_lease_token is not null
  ),
  add constraint cloud_gateway_sessions_media_cache_live_attachment_check check (
    (
      pg_catalog.num_nonnulls(
        media_cache_live_attachment_id,
        media_cache_live_producer_gateway_row_id,
        media_cache_live_work_fingerprint,
        media_cache_live_attachment_state
      ) = 0
    )
    or
    (
      pg_catalog.num_nonnulls(
        media_cache_live_attachment_id,
        media_cache_live_producer_gateway_row_id,
        media_cache_live_work_fingerprint,
        media_cache_live_attachment_state
      ) = 4
      and media_cache_live_work_fingerprint ~ '^[0-9a-f]{64}$'
      and media_cache_live_attachment_state in ('pending', 'active', 'releasing', 'revoked', 'failed')
      and media_cache_lease_token is null
    )
  );

create unique index cloud_gateway_sessions_media_cache_live_attachment_unique
  on public.cloud_gateway_sessions (media_cache_live_attachment_id)
  where media_cache_live_attachment_id is not null;

create index cloud_gateway_sessions_media_cache_live_producer_idx
  on public.cloud_gateway_sessions (
    media_cache_work_fingerprint,
    status,
    media_cache_live_joinable_at
  )
  where media_cache_lease_token is not null;

create index cloud_gateway_sessions_media_cache_live_active_idx
  on public.cloud_gateway_sessions (
    media_cache_live_producer_gateway_row_id,
    media_cache_live_attachment_state,
    expires_at
  )
  where media_cache_live_attachment_id is not null;

create function public.norva_claim_media_cache_live_playback(
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
  p_concurrent_limit integer
) returns table (
  join_candidate boolean,
  capacity_exceeded boolean,
  current_streams integer,
  new_session_id uuid,
  superseded_session_ids uuid[],
  attachment_id uuid,
  producer_gateway_row_id uuid,
  producer_playback_session_id uuid,
  producer_external_session_id text,
  producer_gateway_id uuid,
  producer_mode text,
  producer_expires_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_cache_item_type text;
  v_variant_ids uuid[];
  v_lease public.media_cache_producer_leases%rowtype;
  v_producer public.cloud_gateway_sessions%rowtype;
  v_attachment_id uuid := gen_random_uuid();
  v_superseded uuid[] := '{}'::uuid[];
  v_current_streams integer := 0;
begin
  if p_work_fingerprint is null or p_work_fingerprint !~ '^[0-9a-f]{64}$'
     or p_session_id is null or p_user_id is null or p_source_id is null
     or p_item_type not in ('movie', 'series', 'episode')
     or length(btrim(coalesce(p_item_id, ''))) not between 1 and 512
     or p_target_url_hash is null or p_target_url_hash !~ '^[0-9a-f]{64}$'
     or p_expires_at is null or p_expires_at <= v_now
     or p_expires_at > v_now + interval '8 hours'
     or p_concurrent_limit not between 1 and 64 then
    raise exception 'invalid media cache live playback claim' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_work_fingerprint, 864691128455135234::bigint)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('media-cache-user:' || p_user_id::text, 0)
  );
  v_now := clock_timestamp();
  if p_expires_at <= v_now then
    raise exception 'invalid media cache live playback claim' using errcode = '22023';
  end if;

  perform public.norva_assert_source_catalog_visible_locked(p_source_id, p_user_id);
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

  select lease.* into v_lease
    from public.media_cache_producer_leases lease
   where lease.work_fingerprint = p_work_fingerprint
     and lease.stage = 'producing'
     and lease.expires_at > v_now
     and not lease.preempt_requested
   for update;
  if not found then return; end if;

  select gateway.* into v_producer
    from public.cloud_gateway_sessions gateway
   where gateway.media_cache_work_fingerprint = p_work_fingerprint
     and gateway.media_cache_lease_token = v_lease.lease_token
     and gateway.status = 'ready'
     and gateway.media_cache_live_joinable_at is not null
     and gateway.expires_at > v_now
   limit 1
   for update;
  if not found or nullif(v_producer.external_session_id, '') is null then return; end if;

  select coalesce(array_agg(session.id order by session.created_at), '{}'::uuid[])
    into v_superseded
    from public.cloud_playback_sessions session
   where session.user_id = p_user_id
     and session.status in ('pending', 'ready')
     and session.superseded_at is null
     and session.id <> v_producer.playback_session_id
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
      true, true, v_current_streams, null::uuid, '{}'::uuid[], null::uuid,
      v_producer.id, v_producer.playback_session_id,
      v_producer.external_session_id, v_producer.gateway_id,
      v_producer.mode, v_producer.expires_at;
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
    'transcode', 'pending', p_target_url_hash, null,
    coalesce(nullif(btrim(p_stream_mime), ''), 'application/vnd.apple.mpegurl'),
    coalesce(p_playback_hint, '{}'::jsonb) || '{"__norvaMediaCacheLiveJoinV1":true}'::jsonb,
    least(p_expires_at, v_producer.expires_at)
  );

  insert into public.cloud_gateway_sessions (
    user_id,
    playback_session_id,
    gateway_id,
    external_session_id,
    mode,
    status,
    hls_url,
    expires_at,
    media_cache_live_attachment_id,
    media_cache_live_producer_gateway_row_id,
    media_cache_live_work_fingerprint,
    media_cache_live_attachment_state
  ) values (
    p_user_id,
    p_session_id,
    v_producer.gateway_id,
    v_producer.external_session_id,
    v_producer.mode,
    'pending',
    null,
    least(p_expires_at, v_producer.expires_at),
    v_attachment_id,
    v_producer.id,
    p_work_fingerprint,
    'pending'
  );

  return query select
    true, false, v_current_streams, p_session_id, v_superseded, v_attachment_id,
    v_producer.id, v_producer.playback_session_id,
    v_producer.external_session_id, v_producer.gateway_id,
    v_producer.mode, least(p_expires_at, v_producer.expires_at);
end
$function$;

create function public.norva_activate_media_cache_live_playback(
  p_session_id uuid,
  p_user_id uuid,
  p_attachment_id uuid,
  p_hls_url text
) returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_attachment public.cloud_gateway_sessions%rowtype;
  v_producer public.cloud_gateway_sessions%rowtype;
  v_transferred boolean := false;
begin
  if p_session_id is null or p_user_id is null or p_attachment_id is null
     or length(coalesce(p_hls_url, '')) not between 16 and 8192
     or p_hls_url !~ '^https?://' then return false; end if;

  select gateway.* into v_attachment
    from public.cloud_gateway_sessions gateway
   where gateway.playback_session_id = p_session_id
     and gateway.user_id = p_user_id
     and gateway.media_cache_live_attachment_id = p_attachment_id
     and gateway.media_cache_live_attachment_state in ('pending', 'active')
     and gateway.status in ('pending', 'ready')
     and gateway.expires_at > v_now
   limit 1
   for update;
  if not found then return false; end if;
  -- PostgREST can lose a response after PostgreSQL committed. A retry must
  -- acknowledge that exact activation without consuming a second follower.
  if v_attachment.media_cache_live_attachment_state = 'active' then
    return v_attachment.status = 'ready'
      and v_attachment.hls_url = p_hls_url
      and exists (
        select 1 from public.cloud_playback_sessions session
         where session.id = p_session_id
           and session.user_id = p_user_id
           and session.status = 'ready'
           and session.expires_at > v_now
      );
  end if;
  if v_attachment.status <> 'pending' then return false; end if;
  if not exists (
    select 1 from public.cloud_playback_sessions session
     where session.id = p_session_id
       and session.user_id = p_user_id
       and session.status = 'pending'
       and session.expires_at > v_now
  ) then return false; end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      v_attachment.media_cache_live_work_fingerprint,
      864691128455135234::bigint
    )
  );
  select gateway.* into v_producer
    from public.cloud_gateway_sessions gateway
   where gateway.id = v_attachment.media_cache_live_producer_gateway_row_id
     and gateway.media_cache_work_fingerprint = v_attachment.media_cache_live_work_fingerprint
     and gateway.status = 'ready'
     and gateway.media_cache_live_joinable_at is not null
     and gateway.expires_at > v_now
   limit 1;
  if not found then return false; end if;

  update public.media_cache_producer_leases lease
     set follower_count = greatest(0, lease.follower_count - 1),
         background_continuation = false,
         heartbeat_at = v_now
   where lease.work_fingerprint = v_attachment.media_cache_live_work_fingerprint
     and lease.lease_token = v_producer.media_cache_lease_token
     and lease.stage = 'producing'
     and lease.follower_count > 0
     and lease.expires_at > v_now
     and not lease.preempt_requested
  returning true into v_transferred;
  if not coalesce(v_transferred, false) then return false; end if;

  update public.cloud_gateway_sessions gateway
     set status = 'ready',
         hls_url = p_hls_url,
         media_cache_live_attachment_state = 'active',
         updated_at = v_now
   where gateway.id = v_attachment.id;
  update public.cloud_playback_sessions session
     set status = 'ready', updated_at = v_now
   where session.id = p_session_id
     and session.user_id = p_user_id
     and session.status = 'pending';
  return true;
end
$function$;

create function public.norva_rollback_media_cache_live_playback(
  p_session_id uuid,
  p_user_id uuid,
  p_attachment_id uuid
) returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_deleted boolean := false;
begin
  if p_session_id is null or p_user_id is null or p_attachment_id is null then return false; end if;
  delete from public.cloud_playback_sessions session
   where session.id = p_session_id
     and session.user_id = p_user_id
     and session.status = 'pending'
     and exists (
       select 1 from public.cloud_gateway_sessions gateway
        where gateway.playback_session_id = session.id
          and gateway.media_cache_live_attachment_id = p_attachment_id
          and gateway.media_cache_live_attachment_state = 'pending'
     )
  returning true into v_deleted;
  return coalesce(v_deleted, false);
end
$function$;

-- Primary departure preserves the producer when either a joined viewer or a
-- registered waiter still needs it. Joined viewers keep the producer in the
-- foreground class; only waiter-only demand becomes preemptable continuation.
create or replace function public.norva_request_media_cache_continuation_for_gateway(
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
  v_lease public.media_cache_producer_leases%rowtype;
  v_active_attachments integer := 0;
  v_preserved boolean := false;
begin
  if p_playback_session_id is null or p_gateway_session_id is null
     or p_ttl_seconds not between 30 and 300 then return false; end if;
  select gateway.* into v_gateway
    from public.cloud_gateway_sessions gateway
   where gateway.playback_session_id = p_playback_session_id
     and gateway.external_session_id = p_gateway_session_id::text
     and gateway.status in ('pending', 'starting', 'ready')
     and gateway.media_cache_lease_token is not null
   limit 1
   for update;
  if not found then return false; end if;

  update public.cloud_gateway_sessions
     set media_cache_primary_attached = false, updated_at = v_now
   where id = v_gateway.id;
  select count(*)::integer into v_active_attachments
    from public.cloud_gateway_sessions attachment
   where attachment.media_cache_live_producer_gateway_row_id = v_gateway.id
     and attachment.media_cache_live_attachment_state = 'active'
     and attachment.status = 'ready'
     and attachment.expires_at > v_now;

  select lease.* into v_lease
    from public.media_cache_producer_leases lease
   where lease.work_fingerprint = v_gateway.media_cache_work_fingerprint
     and lease.lease_token = v_gateway.media_cache_lease_token
     and lease.expires_at > v_now
     and not lease.preempt_requested
   for update;
  if not found then return v_active_attachments > 0; end if;

  update public.media_cache_producer_leases lease
     set background_continuation = (v_active_attachments = 0),
         heartbeat_at = v_now,
         expires_at = v_now + pg_catalog.make_interval(secs => p_ttl_seconds)
   where lease.work_fingerprint = v_gateway.media_cache_work_fingerprint
     and lease.lease_token = v_gateway.media_cache_lease_token
     and (v_active_attachments > 0 or lease.follower_count > 0)
  returning true into v_preserved;
  return coalesce(v_preserved, false);
end
$function$;

create function public.norva_request_media_cache_continuation_for_live_attachment(
  p_playback_session_id uuid,
  p_attachment_id uuid,
  p_ttl_seconds integer default 120
) returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_attachment public.cloud_gateway_sessions%rowtype;
  v_producer public.cloud_gateway_sessions%rowtype;
  v_other_active integer := 0;
  v_requested boolean := false;
begin
  if p_playback_session_id is null or p_attachment_id is null
     or p_ttl_seconds not between 30 and 300 then return false; end if;
  select gateway.* into v_attachment
    from public.cloud_gateway_sessions gateway
   where gateway.playback_session_id = p_playback_session_id
     and gateway.media_cache_live_attachment_id = p_attachment_id
     and gateway.media_cache_live_attachment_state in ('active', 'releasing')
     and gateway.status = 'ready'
   limit 1
   for update;
  if not found then return false; end if;
  select gateway.* into v_producer
    from public.cloud_gateway_sessions gateway
   where gateway.id = v_attachment.media_cache_live_producer_gateway_row_id
   limit 1
   for update;
  if not found or v_producer.media_cache_primary_attached is distinct from false then return false; end if;
  if v_attachment.media_cache_live_attachment_state = 'active' then
    update public.cloud_gateway_sessions gateway
       set media_cache_live_attachment_state = 'releasing', updated_at = v_now
     where gateway.id = v_attachment.id;
  end if;
  select count(*)::integer into v_other_active
    from public.cloud_gateway_sessions candidate
   where candidate.media_cache_live_producer_gateway_row_id = v_producer.id
     and candidate.media_cache_live_attachment_id <> p_attachment_id
     and candidate.media_cache_live_attachment_state = 'active'
     and candidate.status = 'ready'
     and candidate.expires_at > v_now;
  if v_other_active > 0 then return false; end if;

  update public.media_cache_producer_leases lease
     set background_continuation = true,
         heartbeat_at = v_now,
         expires_at = v_now + pg_catalog.make_interval(secs => p_ttl_seconds)
   where lease.work_fingerprint = v_attachment.media_cache_live_work_fingerprint
     and lease.lease_token = v_producer.media_cache_lease_token
     and lease.follower_count > 0
     and lease.expires_at > v_now
     and not lease.preempt_requested
  returning true into v_requested;
  return coalesce(v_requested, false);
end
$function$;

create function public.norva_finalize_media_cache_live_attachment_release(
  p_playback_session_id uuid,
  p_user_id uuid,
  p_attachment_id uuid
) returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_released boolean := false;
begin
  if p_playback_session_id is null or p_user_id is null or p_attachment_id is null then return false; end if;
  update public.cloud_gateway_sessions gateway
     set status = 'expired',
         expires_at = least(gateway.expires_at, v_now),
         media_cache_live_attachment_state = 'revoked',
         updated_at = v_now
   where gateway.playback_session_id = p_playback_session_id
     and gateway.user_id = p_user_id
     and gateway.media_cache_live_attachment_id = p_attachment_id
     and gateway.media_cache_live_attachment_state in ('active', 'pending', 'releasing')
  returning true into v_released;
  if not coalesce(v_released, false) then return false; end if;
  update public.cloud_playback_sessions session
     set status = 'expired',
         expires_at = least(session.expires_at, v_now),
         updated_at = v_now
   where session.id = p_playback_session_id
     and session.user_id = p_user_id;
  return true;
end
$function$;

revoke all on function public.norva_claim_media_cache_live_playback(
  text, uuid, uuid, uuid, uuid, text, text, text, text, jsonb, timestamptz, integer
) from public, anon, authenticated;
revoke all on function public.norva_activate_media_cache_live_playback(uuid, uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.norva_rollback_media_cache_live_playback(uuid, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.norva_request_media_cache_continuation_for_live_attachment(uuid, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.norva_finalize_media_cache_live_attachment_release(uuid, uuid, uuid)
  from public, anon, authenticated;

grant execute on function public.norva_claim_media_cache_live_playback(
  text, uuid, uuid, uuid, uuid, text, text, text, text, jsonb, timestamptz, integer
) to service_role;
grant execute on function public.norva_activate_media_cache_live_playback(uuid, uuid, uuid, text)
  to service_role;
grant execute on function public.norva_rollback_media_cache_live_playback(uuid, uuid, uuid)
  to service_role;
grant execute on function public.norva_request_media_cache_continuation_for_live_attachment(uuid, uuid, integer)
  to service_role;
grant execute on function public.norva_finalize_media_cache_live_attachment_release(uuid, uuid, uuid)
  to service_role;

comment on column public.cloud_gateway_sessions.media_cache_live_joinable_at is
  'Server-only candidate marker; Gateway still revalidates exact topology and HLS continuity before issuing a per-viewer token.';
comment on column public.cloud_gateway_sessions.media_cache_live_attachment_id is
  'Opaque per-viewer attachment identity. Its bearer remains only in the trusted Gateway response.';

notify pgrst, 'reload schema';

commit;
