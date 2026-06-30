-- Registry mapping a provider FINGERPRINT (providerKey — URL-independent, detects mirrors) to a human
-- name. Powers the future ADMIN DASHBOARD. SURVIVES source/account deletion (e.g. AtlasPro/apdxes.xyz),
-- so historical providers keep an identity even after their source is removed (their probe caches live
-- on, keyed by providerKey). Active rows are auto-derivable from cloud_sources and should be auto-upserted
-- by the sync engine when it computes providerKey (TODO: wire in _shared/xtream-sync.ts after the engine
-- dedup — see docs/SYNC-ENGINE-DEDUP.md). Deleted/historical rows are labeled manually as durable product
-- knowledge and seeded below.
create table if not exists public.catalog_provider_identities (
  provider_key text primary key,
  display_name text not null,
  status text not null default 'active' check (status in ('active','deleted')),
  notes text,
  first_seen timestamptz,
  last_seen timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.catalog_provider_identities is
  'providerKey (fingerprint) -> human provider name. Admin-dashboard source of truth; survives source deletion.';

alter table public.catalog_provider_identities enable row level security;
revoke all on table public.catalog_provider_identities from anon, authenticated;
grant all on table public.catalog_provider_identities to service_role;

-- Durable labels for DELETED/historical providers (probe caches persist, keyed by providerKey). Active
-- providers are seeded live from cloud_sources (env-specific) + kept current by the engine hook (TODO).
insert into public.catalog_provider_identities (provider_key, display_name, status, notes, last_seen) values
  ('x:f5be3bb7a67f79041f4e5174', 'AtlasPro', 'deleted',
   'apdxes.xyz. Removed ~2026-06-27 after endpoint_abuse rate-limiting on player_api.php. 24,965 cached probes retained — a re-add (any URL) inherits them instantly.', '2026-06-27'),
  ('x:93d4de80882a2a475524545a', 'Unidentified provider', 'deleted',
   'Deleted; cache orphan. ~4,215 cached probes; last probed 2026-06-30. Name TBD.', '2026-06-30'),
  ('x:2cb272cba2117a8ffe1d8b33', 'Unidentified provider', 'deleted',
   'Deleted; cache orphan. ~1,991 cached probes; last probed 2026-06-29. Name TBD.', '2026-06-29'),
  ('x:65e5aaaf9fabb424ea1f5557', 'Unidentified provider', 'deleted',
   'Deleted; cache orphan. ~1,100 cached probes; last probed 2026-06-30. Name TBD.', '2026-06-30'),
  ('fun-fun2026.lol', 'Unidentified provider (legacy host)', 'deleted',
   'Legacy plaintext host key (pre-providerKey scheme); 22 cached probes. Name TBD.', '2026-06-30')
on conflict (provider_key) do update set
  display_name = excluded.display_name, status = excluded.status, notes = excluded.notes, updated_at = now();
