-- Disposable Phase 3 proof bootstrap only.  This fills the version gap between
-- the pinned postgres image init scripts and the reference proof stack.  It is
-- not a Norva production migration.
create extension if not exists dblink;

alter table auth.users add column if not exists email_confirmed_at timestamptz;
alter table auth.users add column if not exists phone_confirmed_at timestamptz;
alter table auth.users add column if not exists banned_until timestamptz;
alter table auth.users add column if not exists deleted_at timestamptz;
alter table auth.users add column if not exists is_sso_user boolean;
alter table auth.users add column if not exists is_anonymous boolean;
alter table auth.users alter column is_sso_user set default false;
alter table auth.users alter column is_anonymous set default false;
update auth.users set is_sso_user = false where is_sso_user is null;
update auth.users set is_anonymous = false where is_anonymous is null;
alter table auth.users alter column is_sso_user set not null;
alter table auth.users alter column is_anonymous set not null;

create or replace function auth.jwt()
returns jsonb
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb,
    '{}'::jsonb
  );
$$;

create table if not exists storage.buckets (
  id text primary key,
  name text not null unique,
  owner uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text not null references storage.buckets(id),
  name text not null,
  owner uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_accessed_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  unique (bucket_id, name)
);

alter table storage.buckets enable row level security;
alter table storage.objects enable row level security;

create table if not exists auth.mfa_factors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  friendly_name text,
  factor_type text not null,
  status text not null,
  secret text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
