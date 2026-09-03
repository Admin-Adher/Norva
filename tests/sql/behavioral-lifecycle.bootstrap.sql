-- Local-only prerequisite schema for behavioral-lifecycle integration tests.
--
-- This is deliberately not a production migration. It models only the mature
-- Norva objects consumed by 20260903180000_behavioral_lifecycle_engine_v1.sql
-- so that PostgreSQL can compile and execute the new migration in isolation.
-- Never apply this fixture to staging or production.

\set ON_ERROR_STOP on

create extension if not exists pgcrypto;
create extension if not exists dblink;
create schema if not exists auth;

do $roles$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end
$roles$;

create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp()
);

create or replace function auth.uid()
returns uuid
language sql
stable
as $function$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$function$;

create or replace function auth.jwt()
returns jsonb
language sql
stable
as $function$
  select case
    when nullif(current_setting('request.jwt.claims', true), '') is not null
      then current_setting('request.jwt.claims', true)::jsonb
    else jsonb_strip_nulls(jsonb_build_object(
      'sub', nullif(current_setting('request.jwt.claim.sub', true), ''),
      'role', nullif(current_setting('request.jwt.claim.role', true), '')
    ))
  end
$function$;

create table public.admin_internal_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade
);

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select coalesce(current_setting('norva.test_is_admin', true), '') = 'true'
    or exists (
      select 1 from public.admin_internal_accounts a where a.user_id = auth.uid()
    )
$function$;

create table public.cloud_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  locale text default 'fr-FR',
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create table public.cloud_signup_attribution (
  user_id uuid primary key references auth.users(id) on delete cascade,
  signed_up_at timestamptz not null,
  signup_platform text not null default 'unknown',
  country_code text,
  updated_at timestamptz not null default clock_timestamp()
);

create table public.cloud_sources (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_type text not null,
  display_name text not null default 'Fixture source',
  sync_status text not null default 'idle',
  sync_error text,
  enabled boolean not null default true,
  deleted_at timestamptz,
  last_synced_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create table public.cloud_watch_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_id uuid references public.cloud_sources(id) on delete set null,
  item_type text not null default 'movie',
  item_id text not null default 'fixture-item',
  progress_seconds integer not null default 0,
  duration_seconds integer not null default 0,
  completed boolean not null default false,
  watched_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create table public.cloud_playback_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_id uuid references public.cloud_sources(id) on delete set null,
  item_type text not null default 'movie',
  item_id text not null default 'fixture-item',
  event_type text not null,
  created_at timestamptz not null default clock_timestamp()
);

create table public.cloud_content_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_id uuid references public.cloud_sources(id) on delete set null,
  kind text not null default 'new_content',
  summary text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp(),
  seen_at timestamptz
);

create table public.cloud_entitlement_projection (
  user_id uuid primary key references auth.users(id) on delete cascade,
  provider text not null default 'system',
  plan_code text not null default 'trial',
  bill_period text,
  status text not null default 'trialing',
  last_event_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create table public.cloud_marketing_email_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  marketing_email_opt_in boolean not null default false,
  opted_in_at timestamptz,
  opted_in_source text,
  unsubscribed_at timestamptz,
  unsubscribed_source text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create or replace function public.norva_marketing_email_allowed(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select exists (
    select 1
    from public.cloud_marketing_email_preferences p
    where p.user_id = p_user_id
      and p.marketing_email_opt_in
      and p.opted_in_at is not null
      and nullif(btrim(p.opted_in_source), '') is not null
      and p.unsubscribed_at is null
      and not exists (
        select 1 from public.admin_internal_accounts a where a.user_id = p_user_id
      )
  )
$function$;

create table public.cloud_push_tokens (
  token text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  platform text not null default 'android',
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  last_seen_at timestamptz not null default clock_timestamp()
);

create table public.cloud_revolut_customers (
  user_id uuid primary key references auth.users(id) on delete cascade,
  period text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create table public.marketing_push_log (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null,
  audience text not null default 'all',
  sent_count integer not null default 0,
  fail_count integer not null default 0,
  dead_count integer not null default 0,
  actor text,
  created_at timestamptz not null default clock_timestamp()
);

create table public.cloud_branded_email_outbox (
  id uuid primary key,
  delivery_key text not null unique,
  dedupe_key text unique,
  user_id uuid references auth.users(id) on delete set null,
  flow text not null,
  state text not null default 'pending'
    check (state in ('pending', 'processing', 'sent', 'canceled', 'dead_letter')),
  is_marketing boolean not null default false,
  recipient_email text,
  request_from text not null,
  request_reply_to text,
  request_subject text,
  request_html text,
  request_text text,
  request_tags jsonb not null default '[]'::jsonb,
  request_headers jsonb not null default '{}'::jsonb,
  marker_kind text,
  marker_reference text,
  marker_stage smallint,
  attempt_count integer not null default 0,
  next_attempt_at timestamptz not null default clock_timestamp(),
  last_attempt_at timestamptz,
  lease_token uuid,
  lease_expires_at timestamptz,
  transport_started_at timestamptz,
  resend_email_id text,
  resend_response jsonb,
  last_http_status integer,
  last_error text,
  sent_at timestamptz,
  dead_lettered_at timestamptz,
  payload_scrubbed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create or replace function public.norva_enqueue_lifecycle_email(
  p_user_id uuid,
  p_flow text,
  p_dedupe_key text,
  p_recipient_email text,
  p_request_from text,
  p_request_reply_to text,
  p_request_subject text,
  p_request_html text,
  p_request_text text,
  p_request_tags jsonb,
  p_request_headers jsonb default '{}'::jsonb,
  p_marketing boolean default false,
  p_marker_kind text default null,
  p_marker_reference text default null,
  p_marker_stage smallint default null
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_id uuid := gen_random_uuid();
  v_existing public.cloud_branded_email_outbox%rowtype;
begin
  insert into public.cloud_branded_email_outbox (
    id, delivery_key, dedupe_key, user_id, flow, state, is_marketing,
    recipient_email, request_from, request_reply_to, request_subject,
    request_html, request_text, request_tags, request_headers,
    marker_kind, marker_reference, marker_stage
  ) values (
    v_id, 'norva-branded-' || v_id::text, p_dedupe_key, p_user_id,
    p_flow, 'pending', p_marketing, p_recipient_email, p_request_from,
    p_request_reply_to, p_request_subject, p_request_html, p_request_text,
    p_request_tags, coalesce(p_request_headers, '{}'::jsonb), p_marker_kind,
    p_marker_reference, p_marker_stage
  )
  on conflict (dedupe_key) do nothing
  returning * into v_existing;

  if not found then
    select * into strict v_existing
    from public.cloud_branded_email_outbox
    where dedupe_key = p_dedupe_key;
  end if;

  return jsonb_build_object(
    'id', v_existing.id,
    'state', v_existing.state,
    'deduped', v_existing.id <> v_id
  );
end
$function$;

create or replace function public.authorize_branded_email_delivery(
  p_id uuid,
  p_delivery_key text,
  p_lease_token uuid
) returns boolean
language sql
security definer
set search_path = pg_catalog, public
as $function$
  select exists (
    select 1
    from public.cloud_branded_email_outbox o
    where o.id = p_id
      and o.delivery_key = p_delivery_key
      and o.state = 'processing'
      and o.lease_token = p_lease_token
  )
$function$;

grant usage on schema auth, public to anon, authenticated, service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
grant execute on all functions in schema public to service_role;
