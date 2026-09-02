begin;

-- A ready object must publish the exact logical playlist name. The object bytes
-- remain global; no tenant or provider coordinate enters this identity.
alter table public.media_cache_objects
  add column root_playlist text;

update public.media_cache_objects
   set root_playlist = 'index.m3u8'
 where state <> 'staging'
   and root_playlist is null;

alter table public.media_cache_objects
  drop constraint media_cache_objects_ready_check;
alter table public.media_cache_objects
  add constraint media_cache_objects_root_playlist_check check (
    root_playlist is null
    or (
      length(root_playlist) between 1 and 1024
      and root_playlist ~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$'
      and root_playlist !~ '(^|/)\.{1,2}(/|$)'
      and root_playlist !~ '//'
    )
  );
alter table public.media_cache_objects
  add constraint media_cache_objects_ready_check check (
    (state = 'staging' and ready_at is null and manifest_sha256 is null and root_playlist is null)
    or (
      state in ('ready', 'quarantined', 'deleting')
      and ready_at is not null
      and manifest_sha256 is not null
      and root_playlist is not null
      and total_bytes is not null
      and file_count is not null
    )
  );

-- A movie binds to its exact active media item and variant. An episode has no
-- cloud_media_items row, so it binds to the exact active parent variant plus
-- the episode external id proven by the generation-aware membership registry.
alter table public.media_cache_bindings
  add column external_id text;

update public.media_cache_bindings binding
   set external_id = item.external_id
  from public.cloud_media_items item
 where item.id = binding.media_item_id
   and binding.external_id is null;

-- Never guess when a historical binding has more than one possible variant.
-- Only an unambiguous exact candidate may be backfilled; the guard below
-- aborts the migration instead of silently granting the wrong title variant.
update public.media_cache_bindings binding
   set variant_id = candidate.variant_id
  from (
    select variant.user_id, variant.source_id, variant.media_item_id,
           min(variant.id::text)::uuid as variant_id
      from public.cloud_title_variants variant
     group by variant.user_id, variant.source_id, variant.media_item_id
    having count(*) = 1
  ) candidate
 where binding.variant_id is null
   and candidate.media_item_id = binding.media_item_id
   and candidate.user_id = binding.user_id
   and candidate.source_id = binding.source_id;

do $guard$
begin
  if exists (
    select 1 from public.media_cache_bindings
     where external_id is null or variant_id is null
  ) then
    raise exception 'media cache binding backfill is incomplete' using errcode = '55000';
  end if;
end
$guard$;

alter table public.media_cache_bindings
  alter column external_id set not null,
  alter column variant_id set not null,
  alter column media_item_id drop not null;
alter table public.media_cache_bindings
  drop constraint media_cache_bindings_authority_unique;
alter table public.media_cache_bindings
  add constraint media_cache_bindings_external_id_check check (
    length(btrim(external_id)) between 1 and 512
    and external_id !~ '[[:cntrl:]]'
  ),
  add constraint media_cache_bindings_exact_kind_check check (
    (item_type = 'movie' and media_item_id is not null)
    or (item_type = 'episode' and media_item_id is null)
  ),
  add constraint media_cache_bindings_authority_unique unique (
    user_id,
    source_id,
    item_type,
    external_id,
    variant_id,
    target_url_sha256
  );

create index media_cache_bindings_episode_authority_idx
  on public.media_cache_bindings (
    user_id, source_id, external_id, variant_id, target_url_sha256
  )
  where item_type = 'episode' and state = 'active';

drop function public.norva_register_ready_media_cache_object(
  text, text, bigint, text, text, text, bigint, text, text, text, text, bigint, integer, integer
);

create function public.norva_register_ready_media_cache_object(
  p_object_key text,
  p_content_sha256 text,
  p_file_size_bytes bigint,
  p_video_profile_sha256 text,
  p_audio_topology_sha256 text,
  p_subtitle_topology_sha256 text,
  p_duration_milliseconds bigint,
  p_pipeline_build text,
  p_segmenter_build text,
  p_storage_backend text,
  p_root_playlist text,
  p_manifest_sha256 text,
  p_total_bytes bigint,
  p_file_count integer,
  p_ttl_seconds integer
) returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_prefix text;
  v_registered boolean := false;
begin
  if p_object_key is null or p_object_key !~ '^[0-9a-f]{64}$'
     or p_content_sha256 is null or p_content_sha256 !~ '^[0-9a-f]{64}$'
     or p_video_profile_sha256 is null or p_video_profile_sha256 !~ '^[0-9a-f]{64}$'
     or p_audio_topology_sha256 is null or p_audio_topology_sha256 !~ '^[0-9a-f]{64}$'
     or p_subtitle_topology_sha256 is null or p_subtitle_topology_sha256 !~ '^[0-9a-f]{64}$'
     or p_manifest_sha256 is null or p_manifest_sha256 !~ '^[0-9a-f]{64}$'
     or p_file_size_bytes <= 0
     or p_duration_milliseconds <= 0
     or p_total_bytes <= 0
     or p_file_count not between 1 and 20000
     or p_ttl_seconds not between 300 and 7776000
     or p_storage_backend not in ('local', 'r2')
     or length(btrim(coalesce(p_pipeline_build, ''))) not between 1 and 256
     or length(btrim(coalesce(p_segmenter_build, ''))) not between 1 and 256
     or length(coalesce(p_root_playlist, '')) not between 1 and 1024
     or p_root_playlist !~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$'
     or p_root_playlist ~ '(^|/)\.{1,2}(/|$)'
     or p_root_playlist ~ '//' then
    return false;
  end if;

  v_prefix := 'media-cache/v1/' || substr(p_object_key, 1, 2) || '/' || p_object_key || '/';
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_object_key, 864691128455135232::bigint)
  );

  insert into public.media_cache_objects (
    object_key, content_sha256, file_size_bytes,
    video_profile_sha256, audio_topology_sha256, subtitle_topology_sha256,
    duration_milliseconds, pipeline_build, segmenter_build,
    state, storage_backend, object_prefix, root_playlist, manifest_sha256,
    total_bytes, file_count, created_at, ready_at, expires_at
  ) values (
    p_object_key, p_content_sha256, p_file_size_bytes,
    p_video_profile_sha256, p_audio_topology_sha256, p_subtitle_topology_sha256,
    p_duration_milliseconds, btrim(p_pipeline_build), btrim(p_segmenter_build),
    'ready', p_storage_backend, v_prefix, p_root_playlist, p_manifest_sha256,
    p_total_bytes, p_file_count, v_now, v_now,
    v_now + make_interval(secs => p_ttl_seconds)
  )
  on conflict (object_key) do update
     set expires_at = greatest(public.media_cache_objects.expires_at, excluded.expires_at)
   where public.media_cache_objects.content_sha256 = excluded.content_sha256
     and public.media_cache_objects.file_size_bytes = excluded.file_size_bytes
     and public.media_cache_objects.video_profile_sha256 = excluded.video_profile_sha256
     and public.media_cache_objects.audio_topology_sha256 = excluded.audio_topology_sha256
     and public.media_cache_objects.subtitle_topology_sha256 = excluded.subtitle_topology_sha256
     and public.media_cache_objects.duration_milliseconds = excluded.duration_milliseconds
     and public.media_cache_objects.pipeline_build = excluded.pipeline_build
     and public.media_cache_objects.segmenter_build = excluded.segmenter_build
     and public.media_cache_objects.storage_backend = excluded.storage_backend
     and public.media_cache_objects.object_prefix = excluded.object_prefix
     and public.media_cache_objects.root_playlist = excluded.root_playlist
     and public.media_cache_objects.manifest_sha256 = excluded.manifest_sha256
     and public.media_cache_objects.total_bytes = excluded.total_bytes
     and public.media_cache_objects.file_count = excluded.file_count
     and public.media_cache_objects.state = 'ready'
  returning true into v_registered;

  return coalesce(v_registered, false);
end
$function$;

create or replace function public.norva_bind_media_cache_object(
  p_object_key text,
  p_user_id uuid,
  p_source_id uuid,
  p_item_type text,
  p_external_id text,
  p_target_url_sha256 text,
  p_variant_id uuid default null
) returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_media_item_id uuid;
  v_variant_id uuid;
  v_binding_id uuid;
begin
  if p_object_key is null or p_object_key !~ '^[0-9a-f]{64}$'
     or p_user_id is null
     or p_source_id is null
     or p_item_type not in ('movie', 'episode')
     or length(btrim(coalesce(p_external_id, ''))) not between 1 and 512
     or p_target_url_sha256 is null or p_target_url_sha256 !~ '^[0-9a-f]{64}$'
     or p_variant_id is null then
    return null;
  end if;

  if not exists (
    select 1 from public.media_cache_objects object
     where object.object_key = p_object_key
       and object.state = 'ready'
       and object.quarantined_at is null
       and object.expires_at > v_now
  ) then return null; end if;

  if p_item_type = 'movie' then
    select item.id, variant.id
      into v_media_item_id, v_variant_id
      from public.cloud_media_items item
      join public.cloud_sources source
        on source.id = item.source_id and source.user_id = item.user_id
      join public.cloud_source_catalog_heads head
        on head.source_id = item.source_id
       and head.user_id = item.user_id
       and head.active_generation_id = item.generation_id
      join public.cloud_title_variants variant
        on variant.id = p_variant_id
       and variant.user_id = item.user_id
       and variant.source_id = item.source_id
       and variant.generation_id = item.generation_id
       and variant.media_item_id = item.id
       and variant.item_type = 'movie'
       and variant.external_id = item.external_id
     where item.user_id = p_user_id
       and item.source_id = p_source_id
       and item.item_type = 'movie'
       and item.external_id = btrim(p_external_id)
       and item.available
       and source.enabled
       and source.deleted_at is null
       and source.sync_status <> 'disabled'
     limit 1;
  else
    select coordinates.variant_id
      into v_variant_id
      from public.catalog_series_episode_coordinates_by_episode(
        p_user_id, p_source_id, btrim(p_external_id)
      ) coordinates
     where coordinates.variant_id = p_variant_id
     limit 1;
    v_media_item_id := null;
  end if;

  if v_variant_id is null or (p_item_type = 'movie' and v_media_item_id is null) then
    return null;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_user_id::text || ':' || p_source_id::text || ':' || p_item_type || ':' || btrim(p_external_id),
      864691128455135233::bigint
    )
  );

  insert into public.media_cache_bindings (
    object_key, user_id, source_id, media_item_id, variant_id,
    item_type, external_id, target_url_sha256,
    state, bound_at, revoked_at
  ) values (
    p_object_key, p_user_id, p_source_id, v_media_item_id, v_variant_id,
    p_item_type, btrim(p_external_id), p_target_url_sha256,
    'active', v_now, null
  )
  on conflict on constraint media_cache_bindings_authority_unique do update
     set object_key = excluded.object_key,
         media_item_id = excluded.media_item_id,
         state = 'active',
         bound_at = excluded.bound_at,
         revoked_at = null
  returning id into v_binding_id;

  return v_binding_id;
end
$function$;

drop function public.norva_authorize_media_cache_object(
  text, uuid, uuid, text, text, text, uuid
);

create function public.norva_authorize_media_cache_object(
  p_object_key text,
  p_user_id uuid,
  p_source_id uuid,
  p_item_type text,
  p_external_id text,
  p_target_url_sha256 text,
  p_variant_id uuid default null
) returns table (
  binding_id uuid,
  object_key text,
  storage_backend text,
  object_prefix text,
  root_playlist text,
  manifest_sha256 text,
  expires_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
begin
  if p_object_key is null or p_object_key !~ '^[0-9a-f]{64}$'
     or p_user_id is null
     or p_source_id is null
     or p_item_type not in ('movie', 'episode')
     or length(btrim(coalesce(p_external_id, ''))) not between 1 and 512
     or p_target_url_sha256 is null or p_target_url_sha256 !~ '^[0-9a-f]{64}$'
     or p_variant_id is null then
    return;
  end if;

  return query
  with authorized as (
    select binding.id, object.object_key, object.storage_backend,
           object.object_prefix, object.root_playlist, object.manifest_sha256,
           object.expires_at
      from public.media_cache_bindings binding
      join public.media_cache_objects object on object.object_key = binding.object_key
      join public.cloud_sources source
        on source.id = binding.source_id and source.user_id = binding.user_id
     where binding.object_key = p_object_key
       and binding.user_id = p_user_id
       and binding.source_id = p_source_id
       and binding.item_type = p_item_type
       and binding.external_id = btrim(p_external_id)
       and binding.target_url_sha256 = p_target_url_sha256
       and binding.variant_id = p_variant_id
       and binding.state = 'active'
       and source.enabled
       and source.deleted_at is null
       and source.sync_status <> 'disabled'
       and object.state = 'ready'
       and object.quarantined_at is null
       and object.expires_at > v_now
       and (
         (
           p_item_type = 'movie'
           and binding.media_item_id is not null
           and exists (
             select 1
               from public.cloud_media_items item
               join public.cloud_source_catalog_heads head
                 on head.user_id = item.user_id
                and head.source_id = item.source_id
                and head.active_generation_id = item.generation_id
               join public.cloud_title_variants variant
                 on variant.id = binding.variant_id
                and variant.user_id = item.user_id
                and variant.source_id = item.source_id
                and variant.generation_id = item.generation_id
                and variant.media_item_id = item.id
                and variant.item_type = 'movie'
                and variant.external_id = item.external_id
              where item.id = binding.media_item_id
                and item.user_id = binding.user_id
                and item.source_id = binding.source_id
                and item.item_type = 'movie'
                and item.external_id = binding.external_id
                and item.available
           )
         )
         or (
           p_item_type = 'episode'
           and binding.media_item_id is null
           and exists (
             select 1
               from public.catalog_series_episode_coordinates_by_episode(
                 binding.user_id, binding.source_id, binding.external_id
               ) coordinates
              where coordinates.variant_id = binding.variant_id
           )
         )
       )
     limit 1
  ), touched as (
    update public.media_cache_bindings binding
       set last_authorized_at = v_now
      from authorized
     where binding.id = authorized.id
    returning authorized.id, authorized.object_key, authorized.storage_backend,
              authorized.object_prefix, authorized.root_playlist,
              authorized.manifest_sha256, authorized.expires_at
  )
  select touched.id, touched.object_key, touched.storage_backend,
         touched.object_prefix, touched.root_playlist,
         touched.manifest_sha256, touched.expires_at
    from touched;

  update public.media_cache_objects object
     set last_accessed_at = v_now,
         popularity_count = object.popularity_count + 1
   where object.object_key = p_object_key
     and exists (
       select 1 from public.media_cache_bindings binding
        where binding.object_key = object.object_key
          and binding.user_id = p_user_id
          and binding.source_id = p_source_id
          and binding.item_type = p_item_type
          and binding.external_id = btrim(p_external_id)
          and binding.target_url_sha256 = p_target_url_sha256
          and binding.variant_id = p_variant_id
          and binding.state = 'active'
          and binding.last_authorized_at = v_now
     );
end
$function$;

create table public.media_cache_playback_grants (
  playback_session_id uuid primary key
    references public.cloud_playback_sessions(id) on delete cascade,
  binding_id uuid not null
    references public.media_cache_bindings(id) on delete cascade,
  object_key text not null
    references public.media_cache_objects(object_key) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  issued_at timestamptz not null default clock_timestamp(),
  last_authorized_at timestamptz not null default clock_timestamp(),
  last_ticket_expires_at timestamptz not null,
  hard_expires_at timestamptz not null,
  revoked_at timestamptz,
  constraint media_cache_playback_grants_time_check check (
    last_ticket_expires_at > last_authorized_at
    and hard_expires_at >= last_ticket_expires_at
    and (revoked_at is null or revoked_at >= issued_at)
  )
);

create index media_cache_playback_grants_active_idx
  on public.media_cache_playback_grants (user_id, hard_expires_at)
  where revoked_at is null;

alter table public.media_cache_playback_grants enable row level security;
alter table public.media_cache_playback_grants force row level security;
revoke all on table public.media_cache_playback_grants from public, anon, authenticated;
grant select, insert, update, delete on table public.media_cache_playback_grants to service_role;

create function public.norva_authorize_media_cache_playback(
  p_playback_session_id uuid,
  p_user_id uuid,
  p_object_key text,
  p_ticket_ttl_seconds integer default 90
) returns table (
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
  v_session public.cloud_playback_sessions%rowtype;
  v_binding public.media_cache_bindings%rowtype;
  v_authorized record;
  v_binding_ids uuid[];
  v_item_type text;
  v_hard_expires_at timestamptz;
  v_ticket_expires_at timestamptz;
begin
  if p_playback_session_id is null or p_user_id is null
     or p_object_key is null or p_object_key !~ '^[0-9a-f]{64}$'
     or p_ticket_ttl_seconds not between 30 and 300 then
    return;
  end if;

  select session.* into v_session
    from public.cloud_playback_sessions session
   where session.id = p_playback_session_id
     and session.user_id = p_user_id;
  if not found
     or v_session.status not in ('pending', 'ready')
     or v_session.superseded_at is not null
     or v_session.expires_at <= v_now
     or v_session.source_id is null
     or v_session.target_url_hash is null
     or v_session.target_url_hash !~ '^[0-9a-f]{64}$' then
    return;
  end if;

  v_item_type := case
    when v_session.item_type = 'movie' then 'movie'
    when v_session.item_type in ('series', 'episode') then 'episode'
    else null
  end;
  if v_item_type is null then return; end if;

  select array_agg(binding.id order by binding.id)
    into v_binding_ids
    from public.media_cache_bindings binding
   where binding.object_key = p_object_key
     and binding.user_id = p_user_id
     and binding.source_id = v_session.source_id
     and binding.item_type = v_item_type
     and binding.external_id = v_session.item_id
     and binding.target_url_sha256 = v_session.target_url_hash
     and binding.state = 'active';
  if coalesce(cardinality(v_binding_ids), 0) <> 1 then return; end if;

  select binding.* into v_binding
    from public.media_cache_bindings binding
   where binding.id = v_binding_ids[1];

  select authorized.* into v_authorized
    from public.norva_authorize_media_cache_object(
      p_object_key,
      p_user_id,
      v_session.source_id,
      v_item_type,
      v_session.item_id,
      v_session.target_url_hash,
      v_binding.variant_id
    ) authorized;
  if not found or v_authorized.binding_id <> v_binding.id then return; end if;

  v_hard_expires_at := least(
    v_authorized.expires_at,
    v_session.created_at + interval '8 hours'
  );
  v_ticket_expires_at := least(
    v_hard_expires_at,
    v_now + make_interval(secs => p_ticket_ttl_seconds)
  );
  if v_ticket_expires_at <= v_now + interval '5 seconds' then return; end if;

  insert into public.media_cache_playback_grants (
    playback_session_id, binding_id, object_key, user_id,
    issued_at, last_authorized_at, last_ticket_expires_at,
    hard_expires_at, revoked_at
  ) values (
    p_playback_session_id, v_binding.id, p_object_key, p_user_id,
    v_now, v_now, v_ticket_expires_at, v_hard_expires_at, null
  )
  on conflict (playback_session_id) do update
     set binding_id = excluded.binding_id,
         object_key = excluded.object_key,
         user_id = excluded.user_id,
         last_authorized_at = excluded.last_authorized_at,
         last_ticket_expires_at = excluded.last_ticket_expires_at,
         hard_expires_at = excluded.hard_expires_at,
         revoked_at = null;

  return query select
    v_binding.id,
    v_authorized.object_key,
    v_authorized.storage_backend,
    v_authorized.object_prefix,
    v_authorized.root_playlist,
    v_authorized.manifest_sha256,
    v_ticket_expires_at,
    v_hard_expires_at;
end
$function$;

create function public.norva_revoke_media_cache_playback_grant(
  p_playback_session_id uuid,
  p_user_id uuid
) returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_revoked boolean := false;
begin
  if p_playback_session_id is null or p_user_id is null then return false; end if;
  update public.media_cache_playback_grants grant_row
     set revoked_at = coalesce(grant_row.revoked_at, clock_timestamp())
   where grant_row.playback_session_id = p_playback_session_id
     and grant_row.user_id = p_user_id
  returning true into v_revoked;
  return coalesce(v_revoked, false);
end
$function$;

create function public.norva_revoke_media_cache_grant_on_session_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.status in ('failed', 'expired') or new.superseded_at is not null then
    update public.media_cache_playback_grants
       set revoked_at = coalesce(revoked_at, clock_timestamp())
     where playback_session_id = new.id
       and revoked_at is null;
  end if;
  return new;
end
$function$;

create trigger media_cache_playback_grant_session_state_trg
after update of status, superseded_at on public.cloud_playback_sessions
for each row execute function public.norva_revoke_media_cache_grant_on_session_state();

revoke all on function public.norva_register_ready_media_cache_object(
  text, text, bigint, text, text, text, bigint, text, text, text, text, text, bigint, integer, integer
) from public, anon, authenticated;
revoke all on function public.norva_bind_media_cache_object(
  text, uuid, uuid, text, text, text, uuid
) from public, anon, authenticated;
revoke all on function public.norva_authorize_media_cache_object(
  text, uuid, uuid, text, text, text, uuid
) from public, anon, authenticated;
revoke all on function public.norva_authorize_media_cache_playback(uuid, uuid, text, integer)
  from public, anon, authenticated;
revoke all on function public.norva_revoke_media_cache_playback_grant(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.norva_revoke_media_cache_grant_on_session_state()
  from public, anon, authenticated;

grant execute on function public.norva_register_ready_media_cache_object(
  text, text, bigint, text, text, text, bigint, text, text, text, text, text, bigint, integer, integer
) to service_role;
grant execute on function public.norva_bind_media_cache_object(
  text, uuid, uuid, text, text, text, uuid
) to service_role;
grant execute on function public.norva_authorize_media_cache_object(
  text, uuid, uuid, text, text, text, uuid
) to service_role;
grant execute on function public.norva_authorize_media_cache_playback(uuid, uuid, text, integer)
  to service_role;
grant execute on function public.norva_revoke_media_cache_playback_grant(uuid, uuid)
  to service_role;

comment on table public.media_cache_playback_grants is
  'Server-only renewable authorization from one active playback session to one exact cache binding; never a public object ACL.';

notify pgrst, 'reload schema';

commit;
