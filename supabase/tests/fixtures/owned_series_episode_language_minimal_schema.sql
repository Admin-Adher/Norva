-- MINIMAL HARNESS ONLY: production schema/trigger verification is a separate gate.
-- Never import this into a Norva database. The runner uses a network-isolated,
-- disposable Postgres and loads the real dependency functions from migrations.
do $$ begin
  if current_database()<>'norva_series_episode_projection_test_20260914' then
    raise exception 'Episode harness requires its dedicated disposable database';
  end if;
  if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
  if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
end $$;
create table public.cloud_sources(id uuid primary key,user_id uuid,enabled boolean default true);
create view public.cloud_catalog_visible_sources as select * from public.cloud_sources where enabled;
create table public.cloud_source_catalog_heads(source_id uuid primary key,user_id uuid,active_generation_id uuid);
create table public.cloud_titles(id uuid primary key,user_id uuid,item_type text);
create table public.cloud_media_items(id uuid primary key,user_id uuid,source_id uuid,generation_id uuid,
  item_type text,external_id text,parent_external_id text,available boolean default true,
  metadata jsonb default '{}',playback_hint jsonb default '{}');
create table public.cloud_title_variants(id uuid primary key,user_id uuid,source_id uuid,generation_id uuid,
  title_id uuid,media_item_id uuid,item_type text,external_id text,metadata jsonb default '{}');
create view public.cloud_catalog_visible_title_variants as
  select v.* from public.cloud_title_variants v
  join public.cloud_catalog_visible_sources s on s.id=v.source_id and s.user_id=v.user_id
  join public.cloud_source_catalog_heads h on h.source_id=v.source_id and h.user_id=v.user_id
  where v.generation_id=h.active_generation_id;
create table public.cloud_title_file_language_observations(user_id uuid,title_id uuid,variant_id uuid,
  file_external_id text,audio_languages text[],audio_observed boolean default true,
  audio_verified_at timestamptz,audio_verification jsonb default '{}',
  primary key(user_id,variant_id,file_external_id));
create table public.catalog_series_episode_memberships(user_id uuid,source_id uuid,generation_id uuid,
  provider_identity_id uuid,parent_title_id uuid,parent_variant_id uuid,parent_series_id text,
  parent_item_type text default 'series',episode_id text);
create table public.catalog_source_provider_identities(user_id uuid,source_id uuid primary key,
  identity_id uuid,verified_at timestamptz default now());
create table public.catalog_file_tracks(server_host text,item_type text,external_id text,
  audio_tracks jsonb default '[]',audio_probed_at timestamptz,audio_lang_verified_at timestamptz,
  audio_lang_verification jsonb default '{}',observed_profile_fingerprint text,
  observed_profile_probed_at timestamptz,observed_profile_snapshot jsonb,
  primary key(server_host,item_type,external_id));
create table public.cloud_catalog_provider_language_hints(variant_id uuid primary key,user_id uuid,
  title_id uuid,source_id uuid,item_type text,language text);
