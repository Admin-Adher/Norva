-- Norva Cloud device sessions
--
-- Devices paired through Norva Cloud need their own durable token so they can
-- poll commands and heartbeat without keeping a user access token on TV/web
-- screens. Only hashes are stored server-side.

alter table public.cloud_pairing_sessions
  add column if not exists pairing_secret_hash text,
  add column if not exists platform text,
  add column if not exists app_version text,
  add column if not exists device_capabilities jsonb not null default '{}'::jsonb;

alter table public.cloud_devices
  add column if not exists device_token_hash text,
  add column if not exists device_token_issued_at timestamptz;

create index if not exists idx_cloud_devices_token_hash
  on public.cloud_devices(device_token_hash)
  where device_token_hash is not null and revoked = false;

create index if not exists idx_cloud_pairing_secret_hash
  on public.cloud_pairing_sessions(pairing_secret_hash)
  where pairing_secret_hash is not null;
