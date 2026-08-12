begin;

-- Provider liveness is transport state, not generic row freshness. A dedicated
-- nullable timestamp lets the Edge function prove that the native player sent
-- its first pulse before the short entitlement lease expired, then maintain a
-- bounded chain without extending expires_at.
alter table public.cloud_playback_sessions
  add column if not exists native_heartbeat_at timestamptz;

comment on column public.cloud_playback_sessions.native_heartbeat_at is
  'Service-owned native player liveness pulse; never an entitlement lease.';

-- This table used to expose a broad authenticated UPDATE grant. Besides being
-- unused by shipped clients (all mutations go through service-role Edge
-- functions), that grant would let a caller forge every input to the heartbeat
-- policy, including the new liveness timestamp. Keep authenticated SELECT for
-- Realtime/read compatibility, but make all session mutation server-only.
revoke update on table public.cloud_playback_sessions from public, anon, authenticated;
drop policy if exists "cloud_playback_sessions_update_own"
  on public.cloud_playback_sessions;

-- Reassert the only writer role explicitly for drift-safe restores.
grant update on table public.cloud_playback_sessions to service_role;

commit;
