-- Isolated fixture: synthetic sources, no customer data or provider network.
create role anon;
create role authenticated;
create role service_role;
create function public.norva_credential_require_service_role() returns void language plpgsql as $$
begin if current_setting('request.jwt.claim.role',true) is distinct from 'service_role' then
 raise exception 'service role required' using errcode='42501'; end if; end $$;
create table public.cloud_sources(id uuid primary key,user_id uuid not null,source_type text default 'xtream');
create table public.cloud_catalog_visible_sources(id uuid primary key,user_id uuid not null);
create table public.cloud_source_catalog_heads(source_id uuid primary key,user_id uuid,active_generation_id uuid);
create table public.cloud_source_provider_account_affinities(source_id uuid primary key,user_id uuid,affinity_hash text,updated_at timestamptz);
create table public.catalog_source_provider_identities(source_id uuid primary key,user_id uuid,identity_id uuid,provider_key text,verified_at timestamptz);
create table public.catalog_generated_subtitles(id serial primary key,claimed_by uuid,provider_key text,status text,stage text,updated_at timestamptz,requested_at timestamptz,resolved_at timestamptz,enqueued_at timestamptz);
create index idx_gensubs_claimed_processing on public.catalog_generated_subtitles(claimed_by) where status='processing';
create index idx_gensubs_status on public.catalog_generated_subtitles(status) where status='processing';
set request.jwt.claim.role='service_role';
