-- Norva VOD title projection.
--
-- Raw provider rows remain in cloud_media_items. These tables are rebuildable
-- projections used by the public catalog contract: one logical title with one
-- or more provider variants.

create table if not exists public.cloud_titles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  item_type text not null check (item_type in ('movie', 'series')),
  identity_key text not null,
  identity_source text not null check (identity_source in ('provider_tmdb', 'provider_imdb', 'normalized')),
  provider_tmdb_id text,
  provider_imdb_id text,
  match_status text not null default 'provider_unverified'
    check (match_status in ('provider_unverified', 'provider_verified', 'matched', 'weak', 'unmatched', 'manual')),
  title text not null,
  original_title text,
  release_year integer,
  poster_url text,
  backdrop_url text,
  metadata jsonb not null default '{}'::jsonb,
  default_variant_id uuid,
  variant_count integer not null default 0 check (variant_count >= 0),
  last_observed_ttff_ms integer,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, item_type, identity_key)
);

create table if not exists public.cloud_title_variants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title_id uuid not null references public.cloud_titles(id) on delete cascade,
  source_id uuid not null references public.cloud_sources(id) on delete cascade,
  media_item_id uuid references public.cloud_media_items(id) on delete cascade,
  item_type text not null check (item_type in ('movie', 'series')),
  external_id text not null,
  raw_title text not null,
  label text,
  language text,
  quality text,
  resolution text,
  container_extension text,
  poster_url text,
  playback_hint jsonb not null default '{}'::jsonb,
  codec_profile jsonb not null default '{}'::jsonb,
  compatibility_tier text not null default 'unknown'
    check (compatibility_tier in ('direct', 'remux', 'audio_transcode', 'video_transcode', 'unknown')),
  playback_cost_score integer not null default 500,
  last_observed_ttff_ms integer,
  observed_success_rate numeric(5,4),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_id, item_type, external_id)
);

create table if not exists public.cloud_title_overrides (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_id uuid references public.cloud_sources(id) on delete cascade,
  item_type text not null check (item_type in ('movie', 'series')),
  external_id text,
  identity_key text,
  title_patch jsonb not null default '{}'::jsonb,
  variant_patch jsonb not null default '{}'::jsonb,
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (external_id is not null or identity_key is not null)
);

create index if not exists idx_cloud_titles_user_type_updated
  on public.cloud_titles(user_id, item_type, synced_at desc);
create index if not exists idx_cloud_titles_tmdb
  on public.cloud_titles(user_id, item_type, provider_tmdb_id)
  where provider_tmdb_id is not null;
create index if not exists idx_cloud_title_variants_title_cost
  on public.cloud_title_variants(title_id, playback_cost_score asc, last_observed_ttff_ms asc nulls last);
create index if not exists idx_cloud_title_variants_media_item
  on public.cloud_title_variants(media_item_id)
  where media_item_id is not null;

create or replace function public.refresh_cloud_title_rollup(target_title_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  best_variant_id uuid;
  best_ttff integer;
  variant_total integer;
begin
  if target_title_id is null then
    return;
  end if;

  select v.id, v.last_observed_ttff_ms
    into best_variant_id, best_ttff
  from public.cloud_title_variants v
  where v.title_id = target_title_id
  order by
    v.playback_cost_score asc,
    v.last_observed_ttff_ms asc nulls last,
    v.created_at desc
  limit 1;

  select count(*)::integer
    into variant_total
  from public.cloud_title_variants v
  where v.title_id = target_title_id;

  update public.cloud_titles
  set
    default_variant_id = best_variant_id,
    variant_count = coalesce(variant_total, 0),
    last_observed_ttff_ms = best_ttff,
    updated_at = now()
  where id = target_title_id;
end;
$$;

create or replace function public.refresh_cloud_title_rollup_trigger()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    perform public.refresh_cloud_title_rollup(old.title_id);
    return old;
  end if;

  perform public.refresh_cloud_title_rollup(new.title_id);
  if tg_op = 'UPDATE' and old.title_id is distinct from new.title_id then
    perform public.refresh_cloud_title_rollup(old.title_id);
  end if;
  return new;
end;
$$;

alter table public.cloud_titles enable row level security;
alter table public.cloud_title_variants enable row level security;
alter table public.cloud_title_overrides enable row level security;

drop policy if exists "cloud_titles_owner_select" on public.cloud_titles;
create policy "cloud_titles_owner_select"
on public.cloud_titles for select to authenticated
using (auth.uid() = user_id);

drop policy if exists "cloud_title_variants_owner_select" on public.cloud_title_variants;
create policy "cloud_title_variants_owner_select"
on public.cloud_title_variants for select to authenticated
using (auth.uid() = user_id);

drop policy if exists "cloud_title_overrides_owner_all" on public.cloud_title_overrides;
create policy "cloud_title_overrides_owner_all"
on public.cloud_title_overrides for all to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

grant select on table public.cloud_titles to authenticated;
grant select on table public.cloud_title_variants to authenticated;
grant select, insert, update, delete on table public.cloud_title_overrides to authenticated;
grant all on table public.cloud_titles to service_role;
grant all on table public.cloud_title_variants to service_role;
grant all on table public.cloud_title_overrides to service_role;

drop trigger if exists trg_cloud_titles_updated_at on public.cloud_titles;
create trigger trg_cloud_titles_updated_at
before update on public.cloud_titles
for each row execute function public.norva_set_updated_at();

drop trigger if exists trg_cloud_title_variants_updated_at on public.cloud_title_variants;
create trigger trg_cloud_title_variants_updated_at
before update on public.cloud_title_variants
for each row execute function public.norva_set_updated_at();

drop trigger if exists trg_cloud_title_variants_rollup on public.cloud_title_variants;
create trigger trg_cloud_title_variants_rollup
after insert or update or delete on public.cloud_title_variants
for each row execute function public.refresh_cloud_title_rollup_trigger();

drop trigger if exists trg_cloud_title_overrides_updated_at on public.cloud_title_overrides;
create trigger trg_cloud_title_overrides_updated_at
before update on public.cloud_title_overrides
for each row execute function public.norva_set_updated_at();
