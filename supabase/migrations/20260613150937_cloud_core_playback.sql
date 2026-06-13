-- Norva Cloud Core + Playback foundation
--
-- This migration moves the ecosystem from a local-hub-only registry toward a
-- cloud-first product model. Public clients can own and sync their account
-- data through RLS; sensitive playback material remains mediated by server
-- code and short-lived signed sessions.

create extension if not exists pgcrypto;

create or replace function public.norva_set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke execute on function public.norva_set_updated_at() from public, anon, authenticated;

create table if not exists public.cloud_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  avatar_url text,
  locale text default 'fr-FR',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.cloud_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_type text not null default 'unknown'
    check (device_type in ('web', 'mobile', 'tv', 'desktop', 'hub', 'relay', 'gateway', 'unknown')),
  device_name text not null default 'Norva Device',
  platform text,
  app_version text,
  public_key text,
  capabilities jsonb not null default '{}'::jsonb,
  trusted boolean not null default false,
  revoked boolean not null default false,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.cloud_sources (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_type text not null
    check (source_type in ('xtream', 'm3u', 'epg', 'jellyfin', 'plex', 'local', 'custom')),
  display_name text not null,
  config_ciphertext text,
  config_hint jsonb not null default '{}'::jsonb,
  sync_status text not null default 'idle'
    check (sync_status in ('idle', 'syncing', 'ready', 'error', 'disabled')),
  sync_error text,
  catalog_version integer not null default 1,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.cloud_media_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_id uuid not null references public.cloud_sources(id) on delete cascade,
  item_type text not null
    check (item_type in ('live', 'movie', 'series', 'season', 'episode', 'category', 'other')),
  external_id text not null,
  parent_external_id text,
  title text not null,
  subtitle text,
  poster_url text,
  backdrop_url text,
  metadata jsonb not null default '{}'::jsonb,
  playback_hint jsonb not null default '{}'::jsonb,
  available boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_id, item_type, external_id)
);

create table if not exists public.cloud_favorites (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_id uuid not null references public.cloud_sources(id) on delete cascade,
  item_type text not null,
  item_id text not null,
  item_name text,
  item_meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (user_id, source_id, item_type, item_id)
);

create table if not exists public.cloud_watch_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_id uuid references public.cloud_sources(id) on delete set null,
  item_type text not null,
  item_id text not null,
  parent_item_id text,
  item_name text,
  progress_seconds integer not null default 0 check (progress_seconds >= 0),
  duration_seconds integer not null default 0 check (duration_seconds >= 0),
  completed boolean not null default false,
  data jsonb not null default '{}'::jsonb,
  watched_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, source_id, item_type, item_id)
);

create table if not exists public.cloud_pairing_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  approved_device_id uuid references public.cloud_devices(id) on delete set null,
  code text not null unique,
  device_type text not null default 'unknown',
  device_name text,
  device_public_key text,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'denied', 'expired')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  approved_at timestamptz
);

create table if not exists public.cloud_cast_commands (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_device_id uuid references public.cloud_devices(id) on delete set null,
  target_device_id uuid references public.cloud_devices(id) on delete cascade,
  command text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'queued'
    check (status in ('queued', 'delivered', 'acknowledged', 'failed', 'expired')),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  delivered_at timestamptz,
  acknowledged_at timestamptz
);

create table if not exists public.cloud_playback_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_id uuid references public.cloud_sources(id) on delete set null,
  device_id uuid references public.cloud_devices(id) on delete set null,
  item_type text not null,
  item_id text not null,
  mode text not null default 'direct'
    check (mode in ('direct', 'relay', 'transcode')),
  status text not null default 'ready'
    check (status in ('pending', 'ready', 'failed', 'expired')),
  target_url_hash text,
  stream_mime text,
  playback_hint jsonb not null default '{}'::jsonb,
  error_code text,
  error_message text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.cloud_relay_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  playback_session_id uuid not null references public.cloud_playback_sessions(id) on delete cascade,
  token_hash text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table if not exists public.media_gateways (
  id uuid primary key default gen_random_uuid(),
  gateway_name text not null,
  region text,
  base_url text not null,
  status text not null default 'offline'
    check (status in ('online', 'degraded', 'offline', 'maintenance')),
  capabilities jsonb not null default '{}'::jsonb,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.cloud_gateway_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  playback_session_id uuid not null references public.cloud_playback_sessions(id) on delete cascade,
  gateway_id uuid references public.media_gateways(id) on delete set null,
  external_session_id text,
  mode text not null default 'remux' check (mode in ('remux', 'transcode')),
  status text not null default 'pending'
    check (status in ('pending', 'starting', 'ready', 'failed', 'ended', 'expired')),
  hls_url text,
  error_message text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_cloud_devices_user on public.cloud_devices(user_id, revoked);
create index if not exists idx_cloud_sources_user on public.cloud_sources(user_id, sync_status);
create index if not exists idx_cloud_media_items_source on public.cloud_media_items(source_id, item_type, external_id);
create index if not exists idx_cloud_media_items_user_type on public.cloud_media_items(user_id, item_type);
create index if not exists idx_cloud_favorites_user on public.cloud_favorites(user_id, created_at desc);
create index if not exists idx_cloud_watch_history_user on public.cloud_watch_history(user_id, updated_at desc);
create index if not exists idx_cloud_pairing_code on public.cloud_pairing_sessions(code, expires_at);
create index if not exists idx_cloud_cast_target on public.cloud_cast_commands(target_device_id, status, created_at desc);
create index if not exists idx_cloud_playback_user on public.cloud_playback_sessions(user_id, expires_at desc);
create index if not exists idx_cloud_relay_tokens_session on public.cloud_relay_tokens(playback_session_id, expires_at);
create index if not exists idx_cloud_gateway_sessions_playback on public.cloud_gateway_sessions(playback_session_id, status);

drop trigger if exists trg_cloud_profiles_updated_at on public.cloud_profiles;
create trigger trg_cloud_profiles_updated_at
before update on public.cloud_profiles
for each row execute function public.norva_set_updated_at();

drop trigger if exists trg_cloud_devices_updated_at on public.cloud_devices;
create trigger trg_cloud_devices_updated_at
before update on public.cloud_devices
for each row execute function public.norva_set_updated_at();

drop trigger if exists trg_cloud_sources_updated_at on public.cloud_sources;
create trigger trg_cloud_sources_updated_at
before update on public.cloud_sources
for each row execute function public.norva_set_updated_at();

drop trigger if exists trg_cloud_media_items_updated_at on public.cloud_media_items;
create trigger trg_cloud_media_items_updated_at
before update on public.cloud_media_items
for each row execute function public.norva_set_updated_at();

drop trigger if exists trg_cloud_watch_history_updated_at on public.cloud_watch_history;
create trigger trg_cloud_watch_history_updated_at
before update on public.cloud_watch_history
for each row execute function public.norva_set_updated_at();

drop trigger if exists trg_cloud_playback_sessions_updated_at on public.cloud_playback_sessions;
create trigger trg_cloud_playback_sessions_updated_at
before update on public.cloud_playback_sessions
for each row execute function public.norva_set_updated_at();

drop trigger if exists trg_media_gateways_updated_at on public.media_gateways;
create trigger trg_media_gateways_updated_at
before update on public.media_gateways
for each row execute function public.norva_set_updated_at();

drop trigger if exists trg_cloud_gateway_sessions_updated_at on public.cloud_gateway_sessions;
create trigger trg_cloud_gateway_sessions_updated_at
before update on public.cloud_gateway_sessions
for each row execute function public.norva_set_updated_at();

alter table public.cloud_profiles enable row level security;
alter table public.cloud_devices enable row level security;
alter table public.cloud_sources enable row level security;
alter table public.cloud_media_items enable row level security;
alter table public.cloud_favorites enable row level security;
alter table public.cloud_watch_history enable row level security;
alter table public.cloud_pairing_sessions enable row level security;
alter table public.cloud_cast_commands enable row level security;
alter table public.cloud_playback_sessions enable row level security;
alter table public.cloud_relay_tokens enable row level security;
alter table public.media_gateways enable row level security;
alter table public.cloud_gateway_sessions enable row level security;

drop policy if exists "cloud_profiles_select_own" on public.cloud_profiles;
create policy "cloud_profiles_select_own"
on public.cloud_profiles for select to authenticated
using (id = auth.uid());

drop policy if exists "cloud_profiles_insert_own" on public.cloud_profiles;
create policy "cloud_profiles_insert_own"
on public.cloud_profiles for insert to authenticated
with check (id = auth.uid());

drop policy if exists "cloud_profiles_update_own" on public.cloud_profiles;
create policy "cloud_profiles_update_own"
on public.cloud_profiles for update to authenticated
using (id = auth.uid())
with check (id = auth.uid());

drop policy if exists "cloud_devices_owner_all" on public.cloud_devices;
create policy "cloud_devices_owner_all"
on public.cloud_devices for all to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists "cloud_sources_owner_all" on public.cloud_sources;
create policy "cloud_sources_owner_all"
on public.cloud_sources for all to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists "cloud_media_items_owner_all" on public.cloud_media_items;
create policy "cloud_media_items_owner_all"
on public.cloud_media_items for all to authenticated
using (user_id = auth.uid())
with check (
  user_id = auth.uid()
  and exists (
    select 1 from public.cloud_sources s
    where s.id = source_id and s.user_id = auth.uid()
  )
);

drop policy if exists "cloud_favorites_owner_all" on public.cloud_favorites;
create policy "cloud_favorites_owner_all"
on public.cloud_favorites for all to authenticated
using (user_id = auth.uid())
with check (
  user_id = auth.uid()
  and exists (
    select 1 from public.cloud_sources s
    where s.id = source_id and s.user_id = auth.uid()
  )
);

drop policy if exists "cloud_watch_history_owner_all" on public.cloud_watch_history;
create policy "cloud_watch_history_owner_all"
on public.cloud_watch_history for all to authenticated
using (user_id = auth.uid())
with check (
  user_id = auth.uid()
  and (
    source_id is null
    or exists (
      select 1 from public.cloud_sources s
      where s.id = source_id and s.user_id = auth.uid()
    )
  )
);

drop policy if exists "cloud_pairing_sessions_select_own" on public.cloud_pairing_sessions;
create policy "cloud_pairing_sessions_select_own"
on public.cloud_pairing_sessions for select to authenticated
using (user_id = auth.uid());

drop policy if exists "cloud_pairing_sessions_update_own" on public.cloud_pairing_sessions;
create policy "cloud_pairing_sessions_update_own"
on public.cloud_pairing_sessions for update to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists "cloud_cast_commands_owner_all" on public.cloud_cast_commands;
create policy "cloud_cast_commands_owner_all"
on public.cloud_cast_commands for all to authenticated
using (user_id = auth.uid())
with check (
  user_id = auth.uid()
  and (
    source_device_id is null
    or exists (
      select 1 from public.cloud_devices d
      where d.id = source_device_id and d.user_id = auth.uid()
    )
  )
  and (
    target_device_id is null
    or exists (
      select 1 from public.cloud_devices d
      where d.id = target_device_id and d.user_id = auth.uid()
    )
  )
);

drop policy if exists "cloud_playback_sessions_select_own" on public.cloud_playback_sessions;
create policy "cloud_playback_sessions_select_own"
on public.cloud_playback_sessions for select to authenticated
using (user_id = auth.uid());

drop policy if exists "cloud_playback_sessions_update_own" on public.cloud_playback_sessions;
create policy "cloud_playback_sessions_update_own"
on public.cloud_playback_sessions for update to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists "cloud_relay_tokens_select_own" on public.cloud_relay_tokens;
create policy "cloud_relay_tokens_select_own"
on public.cloud_relay_tokens for select to authenticated
using (user_id = auth.uid());

drop policy if exists "cloud_gateway_sessions_select_own" on public.cloud_gateway_sessions;
create policy "cloud_gateway_sessions_select_own"
on public.cloud_gateway_sessions for select to authenticated
using (user_id = auth.uid());

drop policy if exists "cloud_gateway_sessions_update_own" on public.cloud_gateway_sessions;
create policy "cloud_gateway_sessions_update_own"
on public.cloud_gateway_sessions for update to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

-- media_gateways intentionally has no authenticated policy. Gateway selection
-- is mediated by Norva Cloud API so internal routing and capacity data do not
-- become a direct public API surface.

revoke all on table
  public.cloud_profiles,
  public.cloud_devices,
  public.cloud_sources,
  public.cloud_media_items,
  public.cloud_favorites,
  public.cloud_watch_history,
  public.cloud_pairing_sessions,
  public.cloud_cast_commands,
  public.cloud_playback_sessions,
  public.cloud_relay_tokens,
  public.media_gateways,
  public.cloud_gateway_sessions
from anon, authenticated, service_role;

grant select, insert, update on table public.cloud_profiles to authenticated;
grant select, insert, update, delete on table public.cloud_devices to authenticated;
grant select, insert, update, delete on table public.cloud_sources to authenticated;
grant select, insert, update, delete on table public.cloud_media_items to authenticated;
grant select, insert, update, delete on table public.cloud_favorites to authenticated;
grant select, insert, update, delete on table public.cloud_watch_history to authenticated;
grant select, update on table public.cloud_pairing_sessions to authenticated;
grant select, insert, update, delete on table public.cloud_cast_commands to authenticated;
grant select, update on table public.cloud_playback_sessions to authenticated;
grant select on table public.cloud_relay_tokens to authenticated;
grant select, update on table public.cloud_gateway_sessions to authenticated;

grant select, insert, update, delete on table
  public.cloud_profiles,
  public.cloud_devices,
  public.cloud_sources,
  public.cloud_media_items,
  public.cloud_favorites,
  public.cloud_watch_history,
  public.cloud_pairing_sessions,
  public.cloud_cast_commands,
  public.cloud_playback_sessions,
  public.cloud_relay_tokens,
  public.media_gateways,
  public.cloud_gateway_sessions
to service_role;

alter table public.cloud_pairing_sessions replica identity full;
alter table public.cloud_cast_commands replica identity full;
alter table public.cloud_playback_sessions replica identity full;
alter table public.cloud_gateway_sessions replica identity full;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'cloud_pairing_sessions'
    ) then
      alter publication supabase_realtime add table public.cloud_pairing_sessions;
    end if;

    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'cloud_cast_commands'
    ) then
      alter publication supabase_realtime add table public.cloud_cast_commands;
    end if;

    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'cloud_playback_sessions'
    ) then
      alter publication supabase_realtime add table public.cloud_playback_sessions;
    end if;

    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'cloud_gateway_sessions'
    ) then
      alter publication supabase_realtime add table public.cloud_gateway_sessions;
    end if;
  end if;
end $$;
