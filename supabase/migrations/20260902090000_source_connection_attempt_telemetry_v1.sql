begin;

-- Privacy-minimal diagnostics for failed catalogue connections. The private
-- table deliberately has no user_id, URL, path, query string, User-Agent,
-- credential, IP address, or provider response payload.
create schema if not exists analytics_private;
revoke all on schema analytics_private from public, anon, authenticated, service_role;

create table analytics_private.source_connection_attempts (
  id uuid primary key default gen_random_uuid(),
  source_type text not null check (source_type in ('m3u', 'xtream')),
  domain_normalized text check (
    domain_normalized is null
    or (
      length(domain_normalized) between 1 and 253
      and domain_normalized = lower(domain_normalized)
      and domain_normalized !~ '[/?#@:]'
    )
  ),
  host_hash text check (host_hash is null or host_hash ~ '^[0-9a-f]{64}$'),
  path_shape text not null check (
    path_shape in ('root', 'get.php', 'player_api.php', '.m3u8', '.m3u', 'web_page', 'other', 'invalid')
  ),
  outcome text not null check (outcome in ('accepted', 'failed')),
  http_status smallint not null check (http_status between 100 and 599),
  failure_family text check (
    failure_family is null
    or failure_family in (
      'credentials', 'missing_credentials', 'endpoint_not_found', 'timeout', 'provider_busy',
      'rate_limited', 'playlist_format', 'invalid_input',
      'provider_unreachable', 'infrastructure', 'unknown'
    )
  ),
  platform text not null check (platform in ('web', 'mobile_android', 'android_tv', 'unknown')),
  country_code text check (country_code is null or country_code ~ '^[A-Z]{2}$'),
  app_version text check (
    app_version is null
    or app_version ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$'
  ),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '90 days'),
  constraint source_connection_attempt_outcome_ck check (
    (outcome = 'accepted' and http_status = 201 and failure_family is null)
    or (outcome = 'failed' and failure_family is not null)
  ),
  constraint source_connection_attempt_retention_ck check (expires_at > created_at)
);

comment on table analytics_private.source_connection_attempts is
  '90-day, identity-free source connection diagnostics. Never stores a URL, path, query, credentials, user_id, IP or raw User-Agent.';
comment on column analytics_private.source_connection_attempts.domain_normalized is
  'Readable registrable/root domain only; provider subdomains are removed.';
comment on column analytics_private.source_connection_attempts.host_hash is
  'SHA-256 of the normalized exact hostname without a port, used only to count repeated host groups.';
comment on column analytics_private.source_connection_attempts.country_code is
  'Country captured at account signup; not a location inferred from this request.';

alter table analytics_private.source_connection_attempts enable row level security;
revoke all on table analytics_private.source_connection_attempts from public, anon, authenticated, service_role;

create index source_connection_attempts_created_idx
  on analytics_private.source_connection_attempts (created_at desc);
create index source_connection_attempts_expiry_idx
  on analytics_private.source_connection_attempts (expires_at);
create index source_connection_attempts_domain_created_idx
  on analytics_private.source_connection_attempts (domain_normalized, created_at desc);
create index source_connection_attempts_country_platform_created_idx
  on analytics_private.source_connection_attempts (country_code, platform, created_at desc);
create index source_connection_attempts_host_created_idx
  on analytics_private.source_connection_attempts (host_hash, created_at desc)
  where host_hash is not null;

create or replace function public.norva_record_source_connection_attempt(
  p_user_id uuid,
  p_source_type text,
  p_domain_normalized text,
  p_host_hash text,
  p_path_shape text,
  p_outcome text,
  p_http_status integer,
  p_failure_family text,
  p_platform text,
  p_app_version text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_role text := coalesce(
    nullif(auth.jwt() ->> 'role', ''),
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('role', true), 'none'),
    ''
  );
  v_country_code text;
  v_signup_platform text;
  v_platform text;
  v_id uuid;
begin
  if v_role is distinct from 'service_role' then
    raise exception 'service_role required' using errcode = '42501';
  end if;

  -- Internal accounts are filtered before insertion because the stored row has
  -- intentionally no identity column that could be filtered later.
  if exists (
    select 1 from public.admin_internal_accounts i where i.user_id = p_user_id
  ) then
    return null;
  end if;

  select upper(nullif(btrim(a.country_code), '')), a.signup_platform
  into v_country_code, v_signup_platform
  from public.cloud_signup_attribution a
  where a.user_id = p_user_id;

  v_platform := lower(coalesce(nullif(btrim(p_platform), ''), 'unknown'));
  if v_platform not in ('web', 'mobile_android', 'android_tv', 'unknown') then
    v_platform := 'unknown';
  end if;
  if v_platform = 'unknown' and v_signup_platform in ('web', 'mobile_android') then
    v_platform := v_signup_platform;
  end if;

  insert into analytics_private.source_connection_attempts (
    source_type,
    domain_normalized,
    host_hash,
    path_shape,
    outcome,
    http_status,
    failure_family,
    platform,
    country_code,
    app_version
  ) values (
    lower(btrim(p_source_type)),
    nullif(lower(btrim(p_domain_normalized)), ''),
    nullif(lower(btrim(p_host_hash)), ''),
    lower(btrim(p_path_shape)),
    lower(btrim(p_outcome)),
    p_http_status,
    case when lower(btrim(p_outcome)) = 'accepted'
      then null
      else coalesce(nullif(lower(btrim(p_failure_family)), ''), 'unknown')
    end,
    v_platform,
    case when v_country_code ~ '^[A-Z]{2}$' then v_country_code else null end,
    case
      when p_app_version ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$' then p_app_version
      else null
    end
  ) returning id into v_id;

  return v_id;
end;
$function$;

comment on function public.norva_record_source_connection_attempt(
  uuid, text, text, text, text, text, integer, text, text, text
) is 'Service-only privacy boundary. Accepts no URL, URL path, query, credentials, IP, raw User-Agent or response body.';

revoke all on function public.norva_record_source_connection_attempt(
  uuid, text, text, text, text, text, integer, text, text, text
) from public, anon, authenticated;
grant execute on function public.norva_record_source_connection_attempt(
  uuid, text, text, text, text, text, integer, text, text, text
) to service_role;

create or replace function public.norva_prune_source_connection_attempts()
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_count integer;
begin
  delete from analytics_private.source_connection_attempts where expires_at <= now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;

revoke all on function public.norva_prune_source_connection_attempts() from public, anon, authenticated;
grant execute on function public.norva_prune_source_connection_attempts() to service_role;

-- Retention is part of the privacy contract. Fail closed if the production
-- database cannot schedule deletion instead of accumulating rows silently.
do $schedule$
declare
  v_job_id bigint;
begin
  if pg_catalog.to_regprocedure('cron.schedule(text,text,text)') is null then
    raise exception 'pg_cron is required for source connection attempt retention'
      using errcode = '55000';
  end if;

  select jobid into v_job_id from cron.job
  where jobname = 'norva-source-connection-attempts-prune';
  if v_job_id is not null then
    perform cron.unschedule(v_job_id);
  end if;

  perform cron.schedule(
    'norva-source-connection-attempts-prune',
    '17 3 * * *',
    'select public.norva_prune_source_connection_attempts();'
  );
end;
$schedule$;

notify pgrst, 'reload schema';

commit;
