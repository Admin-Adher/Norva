-- Service-only identity for the existing Hetzner VAAPI Gateway. The bearer
-- token and account allowlist remain in cloud_runtime_config; this row only
-- gives cloud_gateway_sessions a durable route identity for exact cleanup.
insert into public.media_gateways (
  id,
  gateway_name,
  region,
  base_url,
  status,
  capabilities
) values (
  'a7250ec1-171b-4bcf-ad7d-41bac56130ec'::uuid,
  'hetzner-vaapi-canary',
  'hel1',
  'http://norva-media-gateway:8080',
  'maintenance',
  jsonb_build_object(
    'protocol', 1,
    'private', true,
    'canary', true,
    'video_encoder', 'vaapi'
  )
)
on conflict (id) do nothing;

revoke all on table public.media_gateways from anon, authenticated;
grant select, insert, update, delete on table public.media_gateways to service_role;
