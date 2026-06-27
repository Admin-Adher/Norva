-- Phase 2 (dedup-plan.md) — the remaining provider-global foundation tables.
-- Twins of cloud_title_variants / cloud_live_logical_channels / cloud_live_variants,
-- re-keyed off the provider identity instead of (user_id, source_id) so a
-- provider's stream catalogue is stored ONCE per host instead of once per user.
-- All columns kept here are provider-derived (identical for every user of a host);
-- per-user links (user_id/source_id/title_id/…) and per-user playback observations
-- (cost score, success rate, ttff) are intentionally dropped — those stay on the
-- thin per-user tables. Additive, RLS service-only, nothing reads them yet.

-- VOD stream variants — one provider file = one row. Same key shape as
-- catalog_file_tracks (server_host, item_type, external_id).
create table if not exists public.catalog_title_variants (
  server_host         text not null,
  item_type           text not null,
  external_id         text not null,
  raw_title           text,
  label               text,
  language            text,
  quality             text,
  resolution          text,
  container_extension text,
  poster_url          text,
  playback_hint       jsonb not null default '{}'::jsonb,
  codec_profile       jsonb not null default '{}'::jsonb,
  compatibility_tier  text,
  metadata            jsonb not null default '{}'::jsonb,
  updated_at          timestamptz not null default now(),
  primary key (server_host, item_type, external_id)
);
alter table public.catalog_title_variants enable row level security;
revoke all on public.catalog_title_variants from anon, authenticated;

-- Live channel lineup — one logical channel per provider host.
create table if not exists public.catalog_live_logical_channels (
  server_host       text not null,
  logical_id        text not null,
  logical_key       text,
  title             text,
  lcn               integer,
  section           text,
  category_id       text,
  category_name     text,
  poster_url        text,
  stream_icon       text,
  default_stream_id text,
  variant_count     integer not null default 0,
  default_variant   jsonb not null default '{}'::jsonb,
  variant_preview   jsonb not null default '[]'::jsonb,
  playback_hint     jsonb not null default '{}'::jsonb,
  metadata          jsonb not null default '{}'::jsonb,
  updated_at        timestamptz not null default now(),
  primary key (server_host, logical_id)
);
alter table public.catalog_live_logical_channels enable row level security;
revoke all on public.catalog_live_logical_channels from anon, authenticated;
create index if not exists idx_catllc_section on public.catalog_live_logical_channels (server_host, section, lcn nulls last);

-- Live stream variants — keyed the same way cloud_live_variants conflicts
-- (logical_id, stream_id, label) but scoped to the provider host.
create table if not exists public.catalog_live_variants (
  server_host         text not null,
  logical_id          text not null,
  stream_id           text not null,
  label               text not null default 'HD',
  external_id         text,
  rank                integer not null default 2,
  health_rank         integer not null default 1,
  title               text,
  raw_title           text,
  category_id         text,
  category_name       text,
  poster_url          text,
  stream_icon         text,
  playback_hint       jsonb not null default '{}'::jsonb,
  metadata            jsonb not null default '{}'::jsonb,
  container_extension text,
  updated_at          timestamptz not null default now(),
  primary key (server_host, logical_id, stream_id, label)
);
alter table public.catalog_live_variants enable row level security;
revoke all on public.catalog_live_variants from anon, authenticated;
