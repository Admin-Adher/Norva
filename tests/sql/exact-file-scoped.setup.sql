create table public.admin_feature_flags(key text primary key,enabled boolean);
create function public.catalog_language_capture_pipeline_enabled() returns boolean language sql as $$select false$$;
create table public.provider_account_language_validation_leases(provider_account_hash text primary key,lease_owner text,expires_at timestamptz);
create table public.provider_file_probe_leases(identity_key text,lease_owner text,expires_at timestamptz);
create table public.cloud_playback_sessions(provider_account_hash text,status text,expires_at timestamptz);
create table public.cloud_catalog_visible_title_variants(user_id uuid,source_id uuid,item_type text,external_id text);
create table public.catalog_source_provider_identities(user_id uuid,source_id uuid,identity_id uuid,verified_at timestamptz);
create table public.catalog_file_audio_validation_jobs(requested_by uuid,source_id uuid,identity_key text,item_type text,external_id text,state text,lease_expires_at timestamptz,quarantined_at timestamptz);
