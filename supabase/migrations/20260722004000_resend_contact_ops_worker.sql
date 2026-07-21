-- Resend contact projection v3: private host worker, minimized properties and
-- mutually-exclusive subscription lifecycle cohorts.
--
-- The public Edge runtime no longer owns Contacts/Segments.  This migration
-- retires its pg_net wake-up, gives the private worker durable health state and
-- removes raw Norva UUIDs / exact activity timestamps from the Resend copy.

insert into public.cloud_resend_taxonomy(kind, slug, display_name, active) values
  ('segment', 'cancel-scheduled', 'Norva · Cancel scheduled', true)
on conflict (kind, slug) do update set
  display_name = excluded.display_name,
  active = excluded.active,
  updated_at = clock_timestamp();

-- Repair mojibake from older shell/SQL encodings while this taxonomy is being
-- versioned.  These are labels only; stable slugs remain the source of truth.
update public.cloud_resend_taxonomy t
set display_name = v.display_name,
    updated_at = clock_timestamp()
from (values
  ('internal-pilots', 'Norva · Internal & pilots'),
  ('onboarding', 'Norva · Onboarding'),
  ('trialing', 'Norva · Trialing'),
  ('active-subscribers', 'Norva · Active subscribers'),
  ('cancel-scheduled', 'Norva · Cancel scheduled'),
  ('payment-recovery', 'Norva · Payment recovery'),
  ('churned', 'Norva · Churned'),
  ('blocked-suppressed', 'Norva · Blocked / suppressed'),
  ('catalog-ready', 'Norva · Catalog ready')
) as v(slug, display_name)
where t.kind = 'segment' and t.slug = v.slug;

alter table public.cloud_resend_audience_outbox
  alter column projection_version set default 3,
  drop constraint if exists cloud_resend_outbox_segment_slugs,
  add constraint cloud_resend_outbox_segment_slugs check (
    desired_segment_slugs <@ array[
      'internal-pilots', 'onboarding', 'trialing', 'active-subscribers',
      'cancel-scheduled', 'payment-recovery', 'churned',
      'blocked-suppressed', 'catalog-ready'
    ]::text[]
  );

-- Consent evidence and current sending eligibility are separate facts.  Keep
-- the immutable opt-in ledger intact, but fail closed for identities that are
-- not confirmed, are currently banned, have a terminal access block or are on
-- the local deliverability suppression list.
create or replace function public.norva_marketing_email_allowed(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, auth
as $function$
  select exists (
    select 1
    from public.cloud_marketing_email_preferences p
    join auth.users u on u.id = p.user_id
    left join public.cloud_entitlement_projection e on e.user_id = p.user_id
    where p.user_id = p_user_id
      and p.marketing_email_opt_in is true
      and p.opted_in_at is not null
      and nullif(btrim(p.opted_in_source), '') is not null
      and p.unsubscribed_at is null
      and u.email_confirmed_at is not null
      and u.deleted_at is null
      and (u.banned_until is null or u.banned_until <= clock_timestamp())
      and coalesce(e.status, 'none') not in ('revoked', 'refunded', 'fraud', 'blocked')
      and not exists (
        select 1 from public.admin_internal_accounts a where a.user_id = p_user_id
      )
      and not exists (
        select 1
        from public.cloud_email_suppressions s
        where s.email = lower(btrim(coalesce(u.email, '')))
          and s.active
      )
  );
$function$;

revoke all on function public.norva_marketing_email_allowed(uuid)
  from public, anon, authenticated;
grant execute on function public.norva_marketing_email_allowed(uuid)
  to service_role;

-- Confirmation and administrative disablement change effective eligibility
-- even when the address itself is unchanged. Project them immediately instead
-- of waiting for the 24-hour safety reconcile.
drop trigger if exists norva_resend_auth_contact_updated_trg on auth.users;
create trigger norva_resend_auth_contact_updated_trg
  after update of email, raw_user_meta_data, email_confirmed_at, banned_until, deleted_at
  on auth.users
  for each row execute function public.norva_enqueue_auth_email_change_to_resend();

create or replace function public.norva_resend_contact_projection(
  p_user_id uuid,
  p_email text
) returns table(
  contact_properties jsonb,
  desired_segment_slugs text[],
  desired_topic_subscription text,
  is_current_address boolean
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, auth, extensions
as $function$
declare
  v_user jsonb;
  v_entitlement jsonb;
  v_profile jsonb;
  v_internal boolean := false;
  v_delivery_suppressed boolean := false;
  v_source_count integer := 0;
  v_ready_count integer := 0;
  v_syncing_count integer := 0;
  v_error_count integer := 0;
  v_enabled_count integer := 0;
  v_first_play_at timestamptz;
  v_device_seen_at timestamptz;
  v_last_active_at timestamptz;
  v_account_class text;
  v_identity_state text;
  v_entitlement_state text;
  v_onboarding_stage text;
  v_catalog_health text;
  v_engagement_stage text;
  v_signup_cohort text;
  v_locale text;
  v_country_code text;
  v_segments text[] := '{}'::text[];
begin
  select to_jsonb(u) into v_user from auth.users u where u.id = p_user_id;
  is_current_address := v_user is not null
    and lower(btrim(coalesce(p_email, ''))) = lower(btrim(coalesce(v_user->>'email', '')));

  if not is_current_address then
    -- A stale/deleted address is retained only long enough to force an opt-out
    -- and remove Norva memberships.  No stable user key leaves Norva for it.
    contact_properties := jsonb_build_object(
      'norva_contact_key', 'removed',
      'account_class', 'removed',
      'identity_state', 'removed',
      'entitlement_state', 'none',
      'plan', 'none',
      'billing_provider', 'none',
      'onboarding_stage', 'none',
      'catalog_health', 'none',
      'source_count', 0,
      'ready_source_count', 0,
      'engagement_stage', 'never_played',
      'signup_cohort', 'unknown',
      'locale', 'unknown',
      'country_code', 'unknown'
    );
    desired_segment_slugs := '{}'::text[];
    desired_topic_subscription := 'opt_out';
    return next;
    return;
  end if;

  select exists(select 1 from public.admin_internal_accounts a where a.user_id = p_user_id)
    into v_internal;
  select exists(
    select 1 from public.cloud_email_suppressions s
    where s.email = lower(btrim(coalesce(p_email, '')))
      and s.active
  ) into v_delivery_suppressed;
  select to_jsonb(p) into v_entitlement
    from public.cloud_entitlement_projection p where p.user_id = p_user_id;
  select to_jsonb(p) into v_profile
    from public.cloud_profiles p where p.id = p_user_id;

  select count(*)::integer,
         count(*) filter (where s.sync_status = 'ready' and coalesce(s.enabled, true))::integer,
         count(*) filter (where s.sync_status = 'syncing' and coalesce(s.enabled, true))::integer,
         count(*) filter (where s.sync_status = 'error' and coalesce(s.enabled, true))::integer,
         count(*) filter (where coalesce(s.enabled, true))::integer
    into v_source_count, v_ready_count, v_syncing_count, v_error_count, v_enabled_count
  from public.cloud_sources s
  where s.user_id = p_user_id and s.deleted_at is null;

  select max(coalesce(w.watched_at, w.updated_at)) into v_first_play_at
  from public.cloud_watch_history w
  where w.user_id = p_user_id and (w.progress_seconds > 0 or w.completed);
  select max(d.last_seen_at) into v_device_seen_at
  from public.cloud_devices d where d.user_id = p_user_id and not d.revoked;
  select max(t.ts) into v_last_active_at
  from (values (
      case when nullif(v_user->>'last_sign_in_at', '') is null then null
           else (v_user->>'last_sign_in_at')::timestamptz end
    ), (v_device_seen_at), (v_first_play_at)) as t(ts);

  v_account_class := case when v_internal then 'internal' else 'customer' end;
  v_identity_state := case
    when nullif(v_user->>'deleted_at', '') is not null then 'disabled'
    when nullif(v_user->>'banned_until', '') is not null
      and (v_user->>'banned_until')::timestamptz > clock_timestamp() then 'disabled'
    when nullif(v_user->>'email_confirmed_at', '') is not null then 'email_verified'
    else 'created'
  end;
  v_entitlement_state := case coalesce(v_entitlement->>'status', '')
    when 'trialing' then 'trialing'
    when 'active' then 'active'
    when 'cancelled_at_period_end' then 'cancel_scheduled'
    when 'grace' then 'grace'
    when 'past_due' then 'past_due'
    when 'expired' then 'expired'
    when 'revoked' then 'blocked'
    when 'refunded' then 'blocked'
    when 'fraud' then 'blocked'
    else 'none'
  end;
  v_onboarding_stage := case
    when v_first_play_at is not null then 'first_play'
    when v_ready_count > 0 then 'catalog_ready'
    when v_syncing_count > 0 then 'catalog_syncing'
    when v_source_count > 0 then 'source_added'
    else 'no_source'
  end;
  v_catalog_health := case
    when v_source_count = 0 then 'none'
    when v_enabled_count = 0 then 'disabled'
    when v_ready_count > 0 then 'ready'
    when v_syncing_count > 0 then 'syncing'
    when v_error_count > 0 then 'error'
    else 'none'
  end;
  -- This bounded cohort is the only activity timing exported.  The exact
  -- last-sign-in/device/play timestamps remain inside Norva.
  v_engagement_stage := case
    when v_last_active_at is null then 'never_played'
    when v_last_active_at >= clock_timestamp() - interval '7 days' then 'active_7d'
    when v_last_active_at >= clock_timestamp() - interval '30 days' then 'active_30d'
    when v_last_active_at >= clock_timestamp() - interval '90 days' then 'dormant_31_90d'
    else 'dormant_90d_plus'
  end;
  v_signup_cohort := case
    when nullif(v_user->>'created_at', '') is null then 'unknown'
    else to_char((v_user->>'created_at')::timestamptz at time zone 'UTC', 'YYYY-MM')
  end;
  v_locale := coalesce(nullif(lower(left(btrim(v_profile->>'locale'), 35)), ''), 'unknown');
  v_country_code := case
    when btrim(coalesce(v_entitlement->>'country_code', '')) ~ '^[A-Za-z]{2}$'
      then upper(btrim(v_entitlement->>'country_code'))
    else 'unknown'
  end;

  if v_internal then
    v_segments := array_append(v_segments, 'internal-pilots');
    if v_identity_state = 'disabled' or v_delivery_suppressed or v_entitlement_state = 'blocked' then
      v_segments := array_append(v_segments, 'blocked-suppressed');
    end if;
  else
    -- Suppression is an operational delivery state, not a change to consent.
    -- Keep these contacts observable in one remediation cohort but out of all
    -- activation, lifecycle and catalog-ready campaigns.
    if v_identity_state = 'disabled' or v_delivery_suppressed or v_entitlement_state = 'blocked' then
      v_segments := array_append(v_segments, 'blocked-suppressed');
    else
      if v_entitlement_state in ('none', 'trialing', 'active')
         and v_onboarding_stage in ('no_source', 'source_added', 'catalog_syncing') then
        v_segments := array_append(v_segments, 'onboarding');
      end if;
      if v_entitlement_state = 'trialing' then
        v_segments := array_append(v_segments, 'trialing');
      elsif v_entitlement_state = 'active' then
        v_segments := array_append(v_segments, 'active-subscribers');
      elsif v_entitlement_state = 'cancel_scheduled' then
        v_segments := array_append(v_segments, 'cancel-scheduled');
      elsif v_entitlement_state in ('grace', 'past_due') then
        v_segments := array_append(v_segments, 'payment-recovery');
      elsif v_entitlement_state = 'expired' then
        v_segments := array_append(v_segments, 'churned');
      end if;
      if v_ready_count > 0 then
        v_segments := array_append(v_segments, 'catalog-ready');
      end if;
    end if;
  end if;

  contact_properties := jsonb_build_object(
    -- SHA-256 over a random UUID is a stable pseudonym, not an anonymous id.
    -- It supports Resend-side dedup/debug without publishing the Auth UUID.
    'norva_contact_key', encode(digest('norva-resend-contact:v3:' || p_user_id::text, 'sha256'), 'hex'),
    'account_class', v_account_class,
    'identity_state', v_identity_state,
    'entitlement_state', v_entitlement_state,
    'plan', coalesce(nullif(left(v_entitlement->>'plan_code', 80), ''), 'none'),
    'billing_provider', coalesce(nullif(left(v_entitlement->>'provider', 40), ''), 'none'),
    'onboarding_stage', v_onboarding_stage,
    'catalog_health', v_catalog_health,
    'source_count', v_source_count,
    'ready_source_count', v_ready_count,
    'engagement_stage', v_engagement_stage,
    'signup_cohort', v_signup_cohort,
    'locale', v_locale,
    'country_code', v_country_code
  );
  desired_segment_slugs := v_segments;
  desired_topic_subscription := case
    when public.norva_marketing_email_allowed(p_user_id) then 'opt_in'
    else 'opt_out'
  end;
  return next;
end;
$function$;

revoke all on function public.norva_resend_contact_projection(uuid, text)
  from public, anon, authenticated;
grant execute on function public.norva_resend_contact_projection(uuid, text)
  to service_role;

-- Preserve the public signature used by existing auth/consent/catalog triggers,
-- while making unchanged 24-hour refreshes true no-ops for external delivery.
create or replace function public.norva_enqueue_resend_audience_contact(
  p_email text,
  p_unsubscribed boolean,
  p_first_name text default null,
  p_user_id uuid default null
) returns bigint
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_revision bigint;
  v_projection record;
  v_unsubscribed boolean;
  v_first_name text;
  v_properties jsonb;
  v_segments text[];
  v_topic text;
begin
  if length(v_email) not between 3 and 320 or position('@' in v_email) <= 1 then
    return null;
  end if;

  select * into v_projection
  from public.norva_resend_contact_projection(p_user_id, v_email);
  v_unsubscribed := coalesce(p_unsubscribed, true)
    or not coalesce(v_projection.is_current_address, false);
  v_first_name := nullif(left(split_part(btrim(coalesce(p_first_name, '')), ' ', 1), 160), '');
  v_properties := coalesce(v_projection.contact_properties, '{}'::jsonb);
  v_segments := coalesce(v_projection.desired_segment_slugs, '{}'::text[]);
  v_topic := coalesce(v_projection.desired_topic_subscription, 'opt_out');

  -- Row-lock an unchanged projection and only refresh its local staleness clock.
  update public.cloud_resend_audience_outbox o
  set projection_refreshed_at = clock_timestamp()
  where o.email = v_email
    and o.user_id is not distinct from p_user_id
    and o.desired_unsubscribed is not distinct from v_unsubscribed
    and o.first_name is not distinct from v_first_name
    and o.contact_properties is not distinct from v_properties
    and o.desired_segment_slugs is not distinct from v_segments
    and o.desired_topic_subscription is not distinct from v_topic
    and o.projection_version = 3
  returning o.revision into v_revision;
  if found then return v_revision; end if;

  insert into public.cloud_resend_audience_outbox (
    email, user_id, desired_unsubscribed, first_name,
    contact_properties, desired_segment_slugs, desired_topic_subscription,
    projection_version, projection_refreshed_at,
    revision, attempt_count, next_attempt_at, created_at, updated_at
  ) values (
    v_email, p_user_id, v_unsubscribed, v_first_name,
    v_properties, v_segments, v_topic,
    3, clock_timestamp(),
    1, 0, clock_timestamp(), clock_timestamp(), clock_timestamp()
  )
  on conflict (email) do update set
    user_id = excluded.user_id,
    desired_unsubscribed = excluded.desired_unsubscribed,
    first_name = excluded.first_name,
    contact_properties = excluded.contact_properties,
    desired_segment_slugs = excluded.desired_segment_slugs,
    desired_topic_subscription = excluded.desired_topic_subscription,
    projection_version = 3,
    projection_refreshed_at = clock_timestamp(),
    revision = public.cloud_resend_audience_outbox.revision + 1,
    attempt_count = 0,
    next_attempt_at = clock_timestamp(),
    last_http_status = null,
    last_result = null,
    last_error = null,
    updated_at = clock_timestamp()
  returning revision into v_revision;
  return v_revision;
end;
$function$;

revoke all on function public.norva_enqueue_resend_audience_contact(text, boolean, text, uuid)
  from public, anon, authenticated;
grant execute on function public.norva_enqueue_resend_audience_contact(text, boolean, text, uuid)
  to service_role;

-- A permanent bounce/provider suppression changes effective deliverability,
-- not historical consent.  Re-enqueue both activation and explicit resolution
-- so Resend's global unsubscribe/topic state cannot remain stale until the
-- 24-hour safety reconcile.
create or replace function public.norva_enqueue_resend_suppression_projection()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $function$
declare
  v_user record;
  v_allowed boolean;
begin
  select u.id, u.email, u.raw_user_meta_data into v_user
  from auth.users u
  where lower(btrim(coalesce(u.email, ''))) = new.email;
  if not found then return new; end if;

  select public.norva_marketing_email_allowed(v_user.id) into v_allowed;
  perform public.norva_enqueue_resend_audience_contact(
    v_user.email,
    not coalesce(v_allowed, false),
    coalesce(
      v_user.raw_user_meta_data->>'first_name',
      v_user.raw_user_meta_data->>'full_name',
      v_user.raw_user_meta_data->>'name'
    ),
    v_user.id
  );
  return new;
end;
$function$;

revoke all on function public.norva_enqueue_resend_suppression_projection()
  from public, anon, authenticated;
drop trigger if exists norva_resend_suppression_projection_trg
  on public.cloud_email_suppressions;
create trigger norva_resend_suppression_projection_trg
  after insert or update of active, resolved_at
  on public.cloud_email_suppressions
  for each row execute function public.norva_enqueue_resend_suppression_projection();

-- Re-project current and stale addresses before enforcing the v3 privacy shape.
select public.norva_backfill_resend_audience();
do $stale_projection$
declare
  o record;
begin
  for o in
    select q.email, q.user_id
    from public.cloud_resend_audience_outbox q
    where not exists (
      select 1 from auth.users u where lower(btrim(u.email)) = q.email
    )
  loop
    perform public.norva_enqueue_resend_audience_contact(o.email, true, null, o.user_id);
  end loop;
end
$stale_projection$;

alter table public.cloud_resend_audience_outbox
  drop constraint if exists cloud_resend_outbox_no_direct_identity,
  add constraint cloud_resend_outbox_no_direct_identity check (
    not (contact_properties ?| array['norva_user_id', 'signup_at', 'last_active_at'])
  );

comment on constraint cloud_resend_outbox_no_direct_identity
  on public.cloud_resend_audience_outbox is
  'Remote projection cannot contain a raw Norva user id or exact signup/activity timestamps.';

create table if not exists public.cloud_resend_contact_worker_state (
  singleton boolean primary key default true check (singleton),
  status text not null default 'never_started'
    check (status in ('never_started', 'disabled', 'ok', 'degraded', 'error')),
  last_started_at timestamptz,
  last_heartbeat_at timestamptz,
  last_completed_at timestamptz,
  last_success_at timestamptz,
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  summary jsonb not null default '{}'::jsonb check (
    jsonb_typeof(summary) = 'object' and octet_length(summary::text) <= 8192
  ),
  last_error text,
  updated_at timestamptz not null default now()
);

comment on table public.cloud_resend_contact_worker_state is
  'Singleton operational heartbeat for the private, non-HTTP Resend Contacts worker. Summary must contain counts only, never addresses or user ids.';
alter table public.cloud_resend_contact_worker_state enable row level security;
revoke all on table public.cloud_resend_contact_worker_state from public, anon, authenticated;
grant all on table public.cloud_resend_contact_worker_state to service_role;
insert into public.cloud_resend_contact_worker_state(singleton) values (true)
on conflict (singleton) do nothing;

create or replace function public.record_resend_contact_worker_heartbeat(
  p_status text,
  p_summary jsonb default '{}'::jsonb,
  p_error text default null,
  p_started_at timestamptz default null
) returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
begin
  if p_status not in ('disabled', 'ok', 'degraded', 'error') then
    raise exception 'invalid worker status';
  end if;
  if jsonb_typeof(coalesce(p_summary, '{}'::jsonb)) <> 'object'
     or octet_length(coalesce(p_summary, '{}'::jsonb)::text) > 8192 then
    raise exception 'invalid worker summary';
  end if;

  insert into public.cloud_resend_contact_worker_state(
    singleton, status, last_started_at, last_heartbeat_at, last_completed_at,
    last_success_at, consecutive_failures, summary, last_error, updated_at
  ) values (
    true, p_status, p_started_at, clock_timestamp(), clock_timestamp(),
    case when p_status = 'ok' then clock_timestamp() else null end,
    case when p_status in ('error', 'degraded') then 1 else 0 end,
    coalesce(p_summary, '{}'::jsonb), nullif(left(coalesce(p_error, ''), 1000), ''),
    clock_timestamp()
  )
  on conflict (singleton) do update set
    status = excluded.status,
    last_started_at = coalesce(excluded.last_started_at, public.cloud_resend_contact_worker_state.last_started_at),
    last_heartbeat_at = clock_timestamp(),
    last_completed_at = clock_timestamp(),
    last_success_at = case when excluded.status = 'ok' then clock_timestamp()
      else public.cloud_resend_contact_worker_state.last_success_at end,
    consecutive_failures = case when excluded.status in ('error', 'degraded')
      then public.cloud_resend_contact_worker_state.consecutive_failures + 1 else 0 end,
    summary = excluded.summary,
    last_error = excluded.last_error,
    updated_at = clock_timestamp();
end;
$function$;

revoke all on function public.record_resend_contact_worker_heartbeat(text, jsonb, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.record_resend_contact_worker_heartbeat(text, jsonb, text, timestamptz)
  to service_role;

-- Terminal failures stay visible for manual remediation but are never retried
-- forever. A later projection revision (consent/account/taxonomy change or an
-- explicit backfill after correcting configuration) resets next_attempt_at and
-- safely re-opens the row.
drop function if exists public.fail_resend_audience_outbox(text, bigint, uuid, integer, jsonb, text);
create function public.fail_resend_audience_outbox(
  p_email text,
  p_revision bigint,
  p_lease_token uuid,
  p_http_status integer,
  p_result jsonb,
  p_error text,
  p_retryable boolean
) returns boolean
language sql
volatile
security definer
set search_path = pg_catalog, public
as $function$
  with failed as (
    update public.cloud_resend_audience_outbox o
    set lease_token = null,
        lease_expires_at = null,
        next_attempt_at = case when coalesce(p_retryable, false) then
          clock_timestamp() + make_interval(secs => least(
            21600,
            (30 * power(2::numeric, least(9, greatest(0, o.attempt_count - 1))))::integer
              + mod(abs(hashtext(o.email || ':' || o.revision::text)), 31)
          ))
          else 'infinity'::timestamptz
        end,
        last_http_status = p_http_status,
        last_result = p_result,
        last_error = nullif(left(coalesce(p_error, 'unknown Resend error'), 4000), ''),
        updated_at = clock_timestamp()
    where o.email = lower(btrim(p_email))
      and o.revision = p_revision
      and o.lease_token = p_lease_token
    returning 1
  )
  select exists(select 1 from failed)
$function$;

revoke all on function public.fail_resend_audience_outbox(text, bigint, uuid, integer, jsonb, text, boolean)
  from public, anon, authenticated;
grant execute on function public.fail_resend_audience_outbox(text, bigint, uuid, integer, jsonb, text, boolean)
  to service_role;

create or replace function public.resend_contact_projection_health()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select jsonb_build_object(
    'backlog', count(*) filter (where o.synced_revision is distinct from o.revision),
    'opt_out_backlog', count(*) filter (
      where o.synced_revision is distinct from o.revision and o.desired_unsubscribed
    ),
    'failed_backlog', count(*) filter (
      where o.synced_revision is distinct from o.revision and o.last_error is not null
    ),
    'permanent_failure_count', count(*) filter (
      where o.synced_revision is distinct from o.revision
        and o.last_error is not null
        and o.next_attempt_at = 'infinity'::timestamptz
    ),
    'due_backlog', count(*) filter (
      where o.synced_revision is distinct from o.revision
        and o.next_attempt_at <> 'infinity'::timestamptz
    ),
    'oldest_due_at', min(o.next_attempt_at) filter (
      where o.synced_revision is distinct from o.revision
        and o.next_attempt_at <> 'infinity'::timestamptz
    ),
    'lag_p95_seconds', coalesce(percentile_cont(0.95) within group (
      order by extract(epoch from (clock_timestamp() - o.updated_at))
    ) filter (where o.synced_revision is distinct from o.revision), 0),
    'last_synced_at', max(o.synced_at),
    'worker', coalesce((
      select jsonb_build_object(
        'status', w.status,
        'last_heartbeat_at', w.last_heartbeat_at,
        'last_success_at', w.last_success_at,
        'consecutive_failures', w.consecutive_failures,
        'summary', w.summary,
        'last_error', w.last_error
      ) from public.cloud_resend_contact_worker_state w where w.singleton
    ), jsonb_build_object('status', 'never_started'))
  )
  from public.cloud_resend_audience_outbox o
$function$;

revoke all on function public.resend_contact_projection_health()
  from public, anon, authenticated;
grant execute on function public.resend_contact_projection_health()
  to service_role;

-- The management key must never cross the public Edge trust boundary.  Remove
-- the legacy pg_net wake-up; the always-on private worker polls PostgREST over
-- Docker's internal network instead.  The independent local prune cron remains.
do $retire_public_contact_cron$
declare
  v_job_id bigint;
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    for v_job_id in
      select j.jobid from cron.job j where j.jobname = 'norva-resend-contact-projection'
    loop
      perform cron.unschedule(v_job_id);
    end loop;
  end if;
exception when undefined_table or invalid_schema_name or insufficient_privilege then
  raise notice 'Could not retire old Resend contact projection cron; remove it manually';
end
$retire_public_contact_cron$;

notify pgrst, 'reload schema';
