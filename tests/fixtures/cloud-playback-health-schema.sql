-- Minimal disposable-database prerequisites. Never run against production.
create schema auth;
create table auth.users(id uuid primary key);
create table public.cloud_sources(id uuid primary key, user_id uuid references auth.users(id));
create table public.cloud_source_lifecycle(source_id uuid primary key, user_id uuid,
 config_revision bigint, lifecycle_state text, catalog_visibility text);
create table public.cloud_playback_sessions(id uuid primary key, user_id uuid, source_id uuid,
 device_id uuid, item_type text, item_id text, created_at timestamptz default now());
create table public.cloud_playback_events(id uuid primary key default gen_random_uuid(),
 user_id uuid, device_id uuid, playback_session_id uuid, event_type text, error_code text, error_message text);
