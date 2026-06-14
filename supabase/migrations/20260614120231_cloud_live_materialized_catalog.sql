-- Materialized live catalog.
--
-- Norva keeps the raw provider catalog in cloud_media_items, then prepares a
-- stable product contract at sync time: logical channels + variants. Clients
-- should consume this through Edge Functions, but RLS still protects the tables
-- if they are exposed through the Data API.

create table if not exists public.cloud_live_logical_channels (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_id uuid not null references public.cloud_sources(id) on delete cascade,
  logical_id text not null,
  logical_key text not null,
  title text not null,
  lcn integer,
  section text not null default 'other',
  category_id text not null default 'uncategorized',
  category_name text not null default 'Uncategorized',
  poster_url text,
  stream_icon text,
  default_stream_id text,
  variant_count integer not null default 0 check (variant_count >= 0),
  default_variant jsonb not null default '{}'::jsonb,
  variant_preview jsonb not null default '[]'::jsonb,
  playback_hint jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_id, logical_id)
);

create table if not exists public.cloud_live_variants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_id uuid not null references public.cloud_sources(id) on delete cascade,
  logical_channel_id uuid not null references public.cloud_live_logical_channels(id) on delete cascade,
  logical_id text not null,
  media_item_id uuid references public.cloud_media_items(id) on delete cascade,
  stream_id text not null,
  external_id text not null,
  label text not null default 'HD',
  rank integer not null default 2,
  health_rank integer not null default 1,
  title text not null,
  raw_title text,
  category_id text,
  category_name text,
  poster_url text,
  stream_icon text,
  playback_hint jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  container_extension text,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_id, logical_id, stream_id, label)
);

create index if not exists idx_cloud_live_logical_user_source
on public.cloud_live_logical_channels(user_id, source_id, section, lcn, title);

create index if not exists idx_cloud_live_logical_category
on public.cloud_live_logical_channels(user_id, source_id, category_id);

create index if not exists idx_cloud_live_variants_logical
on public.cloud_live_variants(logical_channel_id, rank, health_rank);

create index if not exists idx_cloud_live_variants_stream
on public.cloud_live_variants(user_id, source_id, stream_id);

drop trigger if exists trg_cloud_live_logical_channels_updated_at on public.cloud_live_logical_channels;
create trigger trg_cloud_live_logical_channels_updated_at
before update on public.cloud_live_logical_channels
for each row execute function public.norva_set_updated_at();

drop trigger if exists trg_cloud_live_variants_updated_at on public.cloud_live_variants;
create trigger trg_cloud_live_variants_updated_at
before update on public.cloud_live_variants
for each row execute function public.norva_set_updated_at();

alter table public.cloud_live_logical_channels enable row level security;
alter table public.cloud_live_variants enable row level security;

drop policy if exists "cloud_live_logical_channels_select_own" on public.cloud_live_logical_channels;
create policy "cloud_live_logical_channels_select_own"
on public.cloud_live_logical_channels for select to authenticated
using (user_id = auth.uid());

drop policy if exists "cloud_live_variants_select_own" on public.cloud_live_variants;
create policy "cloud_live_variants_select_own"
on public.cloud_live_variants for select to authenticated
using (user_id = auth.uid());

revoke all on table
  public.cloud_live_logical_channels,
  public.cloud_live_variants
from anon, authenticated, service_role;

grant select on table
  public.cloud_live_logical_channels,
  public.cloud_live_variants
to authenticated;

grant select, insert, update, delete on table
  public.cloud_live_logical_channels,
  public.cloud_live_variants
to service_role;
