begin;

-- The binary/HLS object is global and immutable. Catalog authority lives only
-- in media_cache_bindings; no provider label, title, TMDB id, raw URL or
-- credential is allowed into the object identity.
create table public.media_cache_objects (
  object_key text primary key,
  content_sha256 text not null,
  file_size_bytes bigint not null,
  video_profile_sha256 text not null,
  audio_topology_sha256 text not null,
  subtitle_topology_sha256 text not null,
  duration_milliseconds bigint not null,
  pipeline_build text not null,
  segmenter_build text not null,
  state text not null default 'staging',
  storage_backend text not null default 'r2',
  object_prefix text not null,
  manifest_sha256 text,
  total_bytes bigint,
  file_count integer,
  popularity_count bigint not null default 0,
  created_at timestamptz not null default clock_timestamp(),
  ready_at timestamptz,
  last_accessed_at timestamptz,
  expires_at timestamptz not null,
  quarantined_at timestamptz,
  constraint media_cache_objects_digest_check check (
    object_key ~ '^[0-9a-f]{64}$'
    and content_sha256 ~ '^[0-9a-f]{64}$'
    and video_profile_sha256 ~ '^[0-9a-f]{64}$'
    and audio_topology_sha256 ~ '^[0-9a-f]{64}$'
    and subtitle_topology_sha256 ~ '^[0-9a-f]{64}$'
    and (manifest_sha256 is null or manifest_sha256 ~ '^[0-9a-f]{64}$')
  ),
  constraint media_cache_objects_size_check check (
    file_size_bytes > 0
    and duration_milliseconds > 0
    and (total_bytes is null or total_bytes > 0)
    and (file_count is null or file_count between 1 and 20000)
    and popularity_count >= 0
  ),
  constraint media_cache_objects_build_check check (
    length(pipeline_build) between 1 and 256
    and pipeline_build !~ '[[:cntrl:]]'
    and length(segmenter_build) between 1 and 256
    and segmenter_build !~ '[[:cntrl:]]'
  ),
  constraint media_cache_objects_state_check check (
    state in ('staging', 'ready', 'quarantined', 'deleting')
  ),
  constraint media_cache_objects_backend_check check (
    storage_backend in ('local', 'r2')
    and object_prefix ~ '^media-cache/v1/[0-9a-f]{2}/[0-9a-f]{64}/$'
  ),
  constraint media_cache_objects_ready_check check (
    (state = 'staging' and ready_at is null and manifest_sha256 is null)
    or (
      state in ('ready', 'quarantined', 'deleting')
      and ready_at is not null
      and manifest_sha256 is not null
      and total_bytes is not null
      and file_count is not null
    )
  ),
  constraint media_cache_objects_time_check check (
    expires_at > created_at
    and (quarantined_at is null or state in ('quarantined', 'deleting'))
  ),
  constraint media_cache_objects_exact_identity_unique unique (
    content_sha256,
    file_size_bytes,
    video_profile_sha256,
    audio_topology_sha256,
    subtitle_topology_sha256,
    duration_milliseconds,
    pipeline_build,
    segmenter_build
  )
);

create index media_cache_objects_eviction_idx
  on public.media_cache_objects (
    state,
    popularity_count asc,
    last_accessed_at asc nulls first,
    expires_at asc
  );

create table public.media_cache_bindings (
  id uuid primary key default gen_random_uuid(),
  object_key text not null references public.media_cache_objects(object_key) on delete restrict,
  user_id uuid not null references auth.users(id) on delete cascade,
  source_id uuid not null references public.cloud_sources(id) on delete cascade,
  media_item_id uuid not null references public.cloud_media_items(id) on delete cascade,
  variant_id uuid references public.cloud_title_variants(id) on delete cascade,
  item_type text not null,
  target_url_sha256 text not null,
  state text not null default 'active',
  bound_at timestamptz not null default clock_timestamp(),
  last_authorized_at timestamptz,
  revoked_at timestamptz,
  constraint media_cache_bindings_item_type_check check (item_type in ('movie', 'episode')),
  constraint media_cache_bindings_url_digest_check check (target_url_sha256 ~ '^[0-9a-f]{64}$'),
  constraint media_cache_bindings_state_check check (state in ('active', 'revoked')),
  constraint media_cache_bindings_revocation_check check (
    (state = 'active' and revoked_at is null)
    or (state = 'revoked' and revoked_at is not null)
  ),
  constraint media_cache_bindings_authority_unique unique nulls not distinct (
    user_id,
    source_id,
    media_item_id,
    variant_id,
    item_type,
    target_url_sha256
  )
);

create index media_cache_bindings_object_active_idx
  on public.media_cache_bindings (object_key, state);

create index media_cache_bindings_source_active_idx
  on public.media_cache_bindings (source_id, state, media_item_id);

alter table public.media_cache_objects enable row level security;
alter table public.media_cache_objects force row level security;
alter table public.media_cache_bindings enable row level security;
alter table public.media_cache_bindings force row level security;

revoke all on table public.media_cache_objects from public, anon, authenticated;
revoke all on table public.media_cache_bindings from public, anon, authenticated;

grant select, insert, update, delete on table public.media_cache_objects to service_role;
grant select, insert, update, delete on table public.media_cache_bindings to service_role;

-- Called only after every immutable asset has been uploaded. The authenticated
-- manifest is deliberately the last publication event.
create or replace function public.norva_register_ready_media_cache_object(
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
     or length(btrim(coalesce(p_segmenter_build, ''))) not between 1 and 256 then
    return false;
  end if;

  v_prefix := 'media-cache/v1/' || substr(p_object_key, 1, 2) || '/' || p_object_key || '/';
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_object_key, 864691128455135232::bigint)
  );

  insert into public.media_cache_objects (
    object_key,
    content_sha256,
    file_size_bytes,
    video_profile_sha256,
    audio_topology_sha256,
    subtitle_topology_sha256,
    duration_milliseconds,
    pipeline_build,
    segmenter_build,
    state,
    storage_backend,
    object_prefix,
    manifest_sha256,
    total_bytes,
    file_count,
    created_at,
    ready_at,
    expires_at
  ) values (
    p_object_key,
    p_content_sha256,
    p_file_size_bytes,
    p_video_profile_sha256,
    p_audio_topology_sha256,
    p_subtitle_topology_sha256,
    p_duration_milliseconds,
    btrim(p_pipeline_build),
    btrim(p_segmenter_build),
    'ready',
    p_storage_backend,
    v_prefix,
    p_manifest_sha256,
    p_total_bytes,
    p_file_count,
    v_now,
    v_now,
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
  v_binding_id uuid;
begin
  if p_object_key is null or p_object_key !~ '^[0-9a-f]{64}$'
     or p_user_id is null
     or p_source_id is null
     or p_item_type not in ('movie', 'episode')
     or length(btrim(coalesce(p_external_id, ''))) not between 1 and 512
     or p_target_url_sha256 is null or p_target_url_sha256 !~ '^[0-9a-f]{64}$' then
    return null;
  end if;

  if not exists (
    select 1
      from public.media_cache_objects object
     where object.object_key = p_object_key
       and object.state = 'ready'
       and object.quarantined_at is null
       and object.expires_at > v_now
  ) then
    return null;
  end if;

  select item.id
    into v_media_item_id
    from public.cloud_media_items item
    join public.cloud_sources source
      on source.id = item.source_id
     and source.user_id = item.user_id
   where item.user_id = p_user_id
     and item.source_id = p_source_id
     and item.item_type = p_item_type
     and item.external_id = btrim(p_external_id)
     and item.available
     and source.user_id = p_user_id
     and source.enabled
     and source.deleted_at is null
     and source.sync_status <> 'disabled'
   limit 1;

  if v_media_item_id is null then return null; end if;

  if p_variant_id is not null and not exists (
    select 1
      from public.cloud_title_variants variant
     where variant.id = p_variant_id
       and variant.user_id = p_user_id
       and variant.source_id = p_source_id
       and variant.media_item_id = v_media_item_id
       and variant.external_id = btrim(p_external_id)
  ) then
    return null;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_user_id::text || ':' || p_source_id::text || ':' || v_media_item_id::text,
      864691128455135233::bigint
    )
  );

  insert into public.media_cache_bindings (
    object_key,
    user_id,
    source_id,
    media_item_id,
    variant_id,
    item_type,
    target_url_sha256,
    state,
    bound_at,
    revoked_at
  ) values (
    p_object_key,
    p_user_id,
    p_source_id,
    v_media_item_id,
    p_variant_id,
    p_item_type,
    p_target_url_sha256,
    'active',
    v_now,
    null
  )
  on conflict on constraint media_cache_bindings_authority_unique do update
     set object_key = excluded.object_key,
         state = 'active',
         bound_at = excluded.bound_at,
         revoked_at = null
  returning id into v_binding_id;

  return v_binding_id;
end
$function$;

create or replace function public.norva_authorize_media_cache_object(
  p_object_key text,
  p_user_id uuid,
  p_source_id uuid,
  p_item_type text,
  p_external_id text,
  p_target_url_sha256 text,
  p_variant_id uuid default null
) returns table (
  object_key text,
  storage_backend text,
  object_prefix text,
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
     or p_target_url_sha256 is null or p_target_url_sha256 !~ '^[0-9a-f]{64}$' then
    return;
  end if;

  return query
  with authorized as (
    select binding.id, object.object_key, object.storage_backend,
           object.object_prefix, object.manifest_sha256, object.expires_at
      from public.media_cache_bindings binding
      join public.media_cache_objects object
        on object.object_key = binding.object_key
      join public.cloud_sources source
        on source.id = binding.source_id
       and source.user_id = binding.user_id
      join public.cloud_media_items item
        on item.id = binding.media_item_id
       and item.user_id = binding.user_id
       and item.source_id = binding.source_id
     where binding.object_key = p_object_key
       and binding.user_id = p_user_id
       and binding.source_id = p_source_id
       and binding.item_type = p_item_type
       and binding.target_url_sha256 = p_target_url_sha256
       and binding.variant_id is not distinct from p_variant_id
       and binding.state = 'active'
       and item.item_type = p_item_type
       and item.external_id = btrim(p_external_id)
       and item.available
       and source.enabled
       and source.deleted_at is null
       and source.sync_status <> 'disabled'
       and object.state = 'ready'
       and object.quarantined_at is null
       and object.expires_at > v_now
       and (
         p_variant_id is null
         or exists (
           select 1
             from public.cloud_title_variants variant
            where variant.id = p_variant_id
              and variant.user_id = p_user_id
              and variant.source_id = p_source_id
              and variant.media_item_id = item.id
              and variant.external_id = item.external_id
         )
       )
     limit 1
  ), touched as (
    update public.media_cache_bindings binding
       set last_authorized_at = v_now
      from authorized
     where binding.id = authorized.id
    returning authorized.object_key,
              authorized.storage_backend,
              authorized.object_prefix,
              authorized.manifest_sha256,
              authorized.expires_at
  )
  select touched.object_key,
         touched.storage_backend,
         touched.object_prefix,
         touched.manifest_sha256,
         touched.expires_at
    from touched;

  update public.media_cache_objects object
     set last_accessed_at = v_now,
         popularity_count = object.popularity_count + 1
   where object.object_key = p_object_key
     and exists (
       select 1
         from public.media_cache_bindings binding
        where binding.object_key = object.object_key
          and binding.user_id = p_user_id
          and binding.source_id = p_source_id
          and binding.item_type = p_item_type
          and binding.target_url_sha256 = p_target_url_sha256
          and binding.variant_id is not distinct from p_variant_id
          and binding.state = 'active'
          and binding.last_authorized_at = v_now
     );
end
$function$;

create or replace function public.norva_revoke_media_cache_bindings(
  p_user_id uuid,
  p_source_id uuid,
  p_media_item_id uuid default null
) returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_count integer := 0;
begin
  if p_user_id is null or p_source_id is null then return 0; end if;
  update public.media_cache_bindings
     set state = 'revoked',
         revoked_at = clock_timestamp()
   where user_id = p_user_id
     and source_id = p_source_id
     and (p_media_item_id is null or media_item_id = p_media_item_id)
     and state = 'active';
  get diagnostics v_count = row_count;
  return v_count;
end
$function$;

create or replace function public.norva_revoke_media_cache_bindings_on_source_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if (not new.enabled or new.deleted_at is not null or new.sync_status = 'disabled')
     and (
       old.enabled is distinct from new.enabled
       or old.deleted_at is distinct from new.deleted_at
       or old.sync_status is distinct from new.sync_status
     ) then
    update public.media_cache_bindings
       set state = 'revoked',
           revoked_at = clock_timestamp()
     where user_id = new.user_id
       and source_id = new.id
       and state = 'active';
  end if;
  return new;
end
$function$;

drop trigger if exists media_cache_bindings_source_state_trg on public.cloud_sources;
create trigger media_cache_bindings_source_state_trg
after update of enabled, deleted_at, sync_status on public.cloud_sources
for each row execute function public.norva_revoke_media_cache_bindings_on_source_state();

revoke all on function public.norva_register_ready_media_cache_object(
  text, text, bigint, text, text, text, bigint, text, text, text, text, bigint, integer, integer
) from public, anon, authenticated;
revoke all on function public.norva_bind_media_cache_object(
  text, uuid, uuid, text, text, text, uuid
) from public, anon, authenticated;
revoke all on function public.norva_authorize_media_cache_object(
  text, uuid, uuid, text, text, text, uuid
) from public, anon, authenticated;
revoke all on function public.norva_revoke_media_cache_bindings(uuid, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.norva_revoke_media_cache_bindings_on_source_state()
  from public, anon, authenticated;

grant execute on function public.norva_register_ready_media_cache_object(
  text, text, bigint, text, text, text, bigint, text, text, text, text, bigint, integer, integer
) to service_role;
grant execute on function public.norva_bind_media_cache_object(
  text, uuid, uuid, text, text, text, uuid
) to service_role;
grant execute on function public.norva_authorize_media_cache_object(
  text, uuid, uuid, text, text, text, uuid
) to service_role;
grant execute on function public.norva_revoke_media_cache_bindings(uuid, uuid, uuid)
  to service_role;

comment on table public.media_cache_objects is
  'Global immutable HLS objects keyed only by complete content bytes and exact output topology; never by tenant or provider metadata.';
comment on table public.media_cache_bindings is
  'Server-only authorization bindings from current user/source/media authority to one global object.';

notify pgrst, 'reload schema';

commit;
