-- Resend contact data model v2.
--
-- Norva remains the source of truth. Resend receives only a minimized,
-- reproducible projection: one consent topic, a small set of operational
-- segments and bounded contact properties. No provider credentials, catalog
-- titles or payment identifiers ever leave Norva.

create table if not exists public.cloud_resend_taxonomy (
  kind text not null check (kind in ('segment', 'topic')),
  slug text not null check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  display_name text not null,
  remote_id uuid,
  managed boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (kind, slug),
  unique (kind, remote_id)
);

comment on table public.cloud_resend_taxonomy is
  'Canonical Norva-owned Resend segments/topics and their environment-specific remote ids.';

insert into public.cloud_resend_taxonomy(kind, slug, display_name, active) values
  ('segment', 'internal-pilots', 'Norva · Internal & pilots', true),
  ('segment', 'onboarding', 'Norva · Onboarding', true),
  ('segment', 'trialing', 'Norva · Trialing', true),
  ('segment', 'active-subscribers', 'Norva · Active subscribers', true),
  ('segment', 'payment-recovery', 'Norva · Payment recovery', true),
  ('segment', 'churned', 'Norva · Churned', true),
  ('segment', 'blocked-suppressed', 'Norva · Blocked / suppressed', true),
  ('segment', 'catalog-ready', 'Norva · Catalog ready', true),
  ('topic', 'product-news-offers', 'Product news & offers', true)
on conflict (kind, slug) do update set
  display_name = excluded.display_name,
  active = excluded.active,
  updated_at = clock_timestamp();

alter table public.cloud_resend_taxonomy enable row level security;
revoke all on table public.cloud_resend_taxonomy from public, anon, authenticated;
grant all on table public.cloud_resend_taxonomy to service_role;

alter table public.cloud_resend_audience_outbox
  add column if not exists contact_properties jsonb not null default '{}'::jsonb,
  add column if not exists desired_segment_slugs text[] not null default '{}'::text[],
  add column if not exists desired_topic_subscription text not null default 'opt_out',
  add column if not exists projection_version integer not null default 2,
  add column if not exists projection_refreshed_at timestamptz not null default now();

alter table public.cloud_resend_audience_outbox
  drop constraint if exists cloud_resend_outbox_properties_object,
  add constraint cloud_resend_outbox_properties_object
    check (jsonb_typeof(contact_properties) = 'object'),
  drop constraint if exists cloud_resend_outbox_topic_subscription,
  add constraint cloud_resend_outbox_topic_subscription
    check (desired_topic_subscription in ('opt_in', 'opt_out')),
  drop constraint if exists cloud_resend_outbox_segment_slugs,
  add constraint cloud_resend_outbox_segment_slugs check (
    desired_segment_slugs <@ array[
      'internal-pilots', 'onboarding', 'trialing', 'active-subscribers',
      'payment-recovery', 'churned', 'blocked-suppressed', 'catalog-ready'
    ]::text[]
  );

create table if not exists public.cloud_marketing_consent_events (
  id bigint generated always as identity primary key,
  user_id uuid,
  event_type text not null check (event_type in ('baseline', 'granted', 'revoked')),
  source text not null check (length(btrim(source)) between 1 and 120),
  effective_opt_in boolean not null,
  occurred_at timestamptz not null default now(),
  preference_snapshot jsonb not null default '{}'::jsonb,
  constraint cloud_marketing_consent_events_snapshot_object
    check (jsonb_typeof(preference_snapshot) = 'object')
);

comment on table public.cloud_marketing_consent_events is
  'Append-only evidence of marketing email consent changes. Current eligibility remains in cloud_marketing_email_preferences.';

create index if not exists cloud_marketing_consent_events_user_time_idx
  on public.cloud_marketing_consent_events(user_id, occurred_at desc);
alter table public.cloud_marketing_consent_events enable row level security;
revoke all on table public.cloud_marketing_consent_events from public, anon, authenticated;
grant all on table public.cloud_marketing_consent_events to service_role;

create or replace function public.norva_log_marketing_consent_event()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_type text;
  v_source text;
begin
  if tg_op = 'INSERT' then
    v_type := case when new.marketing_email_opt_in then 'granted' else 'baseline' end;
  elsif new.marketing_email_opt_in is not distinct from old.marketing_email_opt_in
    and new.unsubscribed_at is not distinct from old.unsubscribed_at then
    return new;
  else
    v_type := case
      when new.marketing_email_opt_in and new.unsubscribed_at is null then 'granted'
      else 'revoked'
    end;
  end if;

  v_source := case
    when v_type = 'granted' then coalesce(nullif(btrim(new.opted_in_source), ''), 'unknown')
    when v_type = 'revoked' then coalesce(nullif(btrim(new.unsubscribed_source), ''), 'account_setting')
    else 'migration_baseline'
  end;

  insert into public.cloud_marketing_consent_events(
    user_id, event_type, source, effective_opt_in, occurred_at, preference_snapshot
  ) values (
    new.user_id,
    v_type,
    left(v_source, 120),
    new.marketing_email_opt_in and new.unsubscribed_at is null,
    clock_timestamp(),
    jsonb_build_object(
      'marketing_email_opt_in', new.marketing_email_opt_in,
      'opted_in_at', new.opted_in_at,
      'unsubscribed_at', new.unsubscribed_at
    )
  );
  return new;
end;
$function$;

revoke all on function public.norva_log_marketing_consent_event()
  from public, anon, authenticated;

drop trigger if exists norva_marketing_consent_event_trg
  on public.cloud_marketing_email_preferences;
create trigger norva_marketing_consent_event_trg
  after insert or update of marketing_email_opt_in, opted_in_at, opted_in_source,
    unsubscribed_at, unsubscribed_source
  on public.cloud_marketing_email_preferences
  for each row execute function public.norva_log_marketing_consent_event();

insert into public.cloud_marketing_consent_events(
  user_id, event_type, source, effective_opt_in, occurred_at, preference_snapshot
)
select p.user_id,
       case when p.marketing_email_opt_in and p.unsubscribed_at is null then 'granted' else 'baseline' end,
       'migration_baseline',
       p.marketing_email_opt_in and p.unsubscribed_at is null,
       clock_timestamp(),
       jsonb_build_object(
         'marketing_email_opt_in', p.marketing_email_opt_in,
         'opted_in_at', p.opted_in_at,
         'unsubscribed_at', p.unsubscribed_at
       )
from public.cloud_marketing_email_preferences p
where not exists (
  select 1 from public.cloud_marketing_consent_events e where e.user_id = p.user_id
);

-- Return the exact minimized projection for one address. An old/deleted address
-- is deliberately stripped from every managed segment and kept globally opted out.
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
set search_path = pg_catalog, public, auth
as $function$
declare
  v_user jsonb;
  v_entitlement jsonb;
  v_profile jsonb;
  v_internal boolean := false;
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
  v_segments text[] := '{}'::text[];
begin
  select to_jsonb(u) into v_user from auth.users u where u.id = p_user_id;
  is_current_address := v_user is not null
    and lower(btrim(coalesce(p_email, ''))) = lower(btrim(coalesce(v_user->>'email', '')));

  if not is_current_address then
    -- The Resend team is currently shared with another product, so deleting a
    -- global contact here could erase that product's contact too. Strip every
    -- Norva identifier/property, remove all Norva segments and force opt-out;
    -- the address itself can be deleted once Norva has a dedicated Resend team.
    contact_properties := jsonb_build_object(
      'norva_user_id', 'removed',
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
      'signup_at', 'unknown',
      'last_active_at', 'unknown',
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

  select max(coalesce(w.watched_at, w.updated_at))
    into v_first_play_at
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
  v_engagement_stage := case
    when v_last_active_at is null then 'never_played'
    when v_last_active_at >= clock_timestamp() - interval '7 days' then 'active_7d'
    when v_last_active_at >= clock_timestamp() - interval '30 days' then 'active_30d'
    when v_last_active_at >= clock_timestamp() - interval '90 days' then 'dormant_31_90d'
    else 'dormant_90d_plus'
  end;

  if v_internal then
    v_segments := array_append(v_segments, 'internal-pilots');
  else
    -- Onboarding is a usable acquisition/product cohort, never a synonym for
    -- "has no ready source". Disabled, recovery and churned identities are
    -- excluded so one campaign cannot accidentally mix incompatible journeys.
    if v_identity_state <> 'disabled'
       and v_entitlement_state in ('none', 'trialing', 'active', 'cancel_scheduled')
       and v_onboarding_stage in ('no_source', 'source_added', 'catalog_syncing') then
      v_segments := array_append(v_segments, 'onboarding');
    end if;
    if v_entitlement_state = 'trialing' then
      v_segments := array_append(v_segments, 'trialing');
    elsif v_entitlement_state in ('active', 'cancel_scheduled') then
      v_segments := array_append(v_segments, 'active-subscribers');
    elsif v_entitlement_state in ('grace', 'past_due') then
      v_segments := array_append(v_segments, 'payment-recovery');
    elsif v_entitlement_state = 'expired' then
      v_segments := array_append(v_segments, 'churned');
    elsif v_entitlement_state = 'blocked' then
      v_segments := array_append(v_segments, 'blocked-suppressed');
    end if;
    if v_ready_count > 0
       and v_identity_state <> 'disabled'
       and v_entitlement_state <> 'blocked' then
      v_segments := array_append(v_segments, 'catalog-ready');
    end if;
  end if;

  contact_properties := jsonb_build_object(
    'norva_user_id', p_user_id::text,
    'account_class', v_account_class,
    'identity_state', v_identity_state,
    'entitlement_state', v_entitlement_state,
    'plan', coalesce(nullif(v_entitlement->>'plan_code', ''), 'none'),
    'billing_provider', coalesce(nullif(v_entitlement->>'provider', ''), 'none'),
    'onboarding_stage', v_onboarding_stage,
    'catalog_health', v_catalog_health,
    'source_count', v_source_count,
    'ready_source_count', v_ready_count,
    'engagement_stage', v_engagement_stage,
    'signup_at', coalesce(v_user->>'created_at', 'unknown'),
    'last_active_at', coalesce(v_last_active_at::text, 'unknown'),
    'locale', coalesce(nullif(v_profile->>'locale', ''), 'unknown'),
    'country_code', coalesce(nullif(v_entitlement->>'country_code', ''), 'unknown')
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

-- Keep the existing signature so every auth/consent trigger stays compatible.
-- A no-op refresh updates projection_refreshed_at without producing a new external
-- revision. Only a material source-of-truth change wakes the worker.
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
begin
  if length(v_email) not between 3 and 320 or position('@' in v_email) <= 1 then
    return null;
  end if;

  select * into v_projection
  from public.norva_resend_contact_projection(p_user_id, v_email);
  v_unsubscribed := coalesce(p_unsubscribed, true)
    or not coalesce(v_projection.is_current_address, false);

  insert into public.cloud_resend_audience_outbox (
    email, user_id, desired_unsubscribed, first_name,
    contact_properties, desired_segment_slugs, desired_topic_subscription,
    projection_version, projection_refreshed_at,
    revision, attempt_count, next_attempt_at, created_at, updated_at
  ) values (
    v_email, p_user_id, v_unsubscribed,
    nullif(left(split_part(btrim(coalesce(p_first_name, '')), ' ', 1), 160), ''),
    coalesce(v_projection.contact_properties, '{}'::jsonb),
    coalesce(v_projection.desired_segment_slugs, '{}'::text[]),
    coalesce(v_projection.desired_topic_subscription, 'opt_out'),
    2, clock_timestamp(),
    1, 0, clock_timestamp(), clock_timestamp(), clock_timestamp()
  )
  on conflict (email) do update set
    user_id = excluded.user_id,
    desired_unsubscribed = excluded.desired_unsubscribed,
    first_name = excluded.first_name,
    contact_properties = excluded.contact_properties,
    desired_segment_slugs = excluded.desired_segment_slugs,
    desired_topic_subscription = excluded.desired_topic_subscription,
    projection_version = excluded.projection_version,
    projection_refreshed_at = clock_timestamp(),
    revision = case when
      public.cloud_resend_audience_outbox.user_id is distinct from excluded.user_id or
      public.cloud_resend_audience_outbox.desired_unsubscribed is distinct from excluded.desired_unsubscribed or
      public.cloud_resend_audience_outbox.first_name is distinct from excluded.first_name or
      public.cloud_resend_audience_outbox.contact_properties is distinct from excluded.contact_properties or
      public.cloud_resend_audience_outbox.desired_segment_slugs is distinct from excluded.desired_segment_slugs or
      public.cloud_resend_audience_outbox.desired_topic_subscription is distinct from excluded.desired_topic_subscription or
      public.cloud_resend_audience_outbox.projection_version is distinct from excluded.projection_version
      then public.cloud_resend_audience_outbox.revision + 1
      else public.cloud_resend_audience_outbox.revision
    end,
    attempt_count = case when
      public.cloud_resend_audience_outbox.user_id is distinct from excluded.user_id or
      public.cloud_resend_audience_outbox.desired_unsubscribed is distinct from excluded.desired_unsubscribed or
      public.cloud_resend_audience_outbox.first_name is distinct from excluded.first_name or
      public.cloud_resend_audience_outbox.contact_properties is distinct from excluded.contact_properties or
      public.cloud_resend_audience_outbox.desired_segment_slugs is distinct from excluded.desired_segment_slugs or
      public.cloud_resend_audience_outbox.desired_topic_subscription is distinct from excluded.desired_topic_subscription or
      public.cloud_resend_audience_outbox.projection_version is distinct from excluded.projection_version
      then 0 else public.cloud_resend_audience_outbox.attempt_count end,
    next_attempt_at = case when
      public.cloud_resend_audience_outbox.user_id is distinct from excluded.user_id or
      public.cloud_resend_audience_outbox.desired_unsubscribed is distinct from excluded.desired_unsubscribed or
      public.cloud_resend_audience_outbox.first_name is distinct from excluded.first_name or
      public.cloud_resend_audience_outbox.contact_properties is distinct from excluded.contact_properties or
      public.cloud_resend_audience_outbox.desired_segment_slugs is distinct from excluded.desired_segment_slugs or
      public.cloud_resend_audience_outbox.desired_topic_subscription is distinct from excluded.desired_topic_subscription or
      public.cloud_resend_audience_outbox.projection_version is distinct from excluded.projection_version
      then clock_timestamp() else public.cloud_resend_audience_outbox.next_attempt_at end,
    last_http_status = case when
      public.cloud_resend_audience_outbox.user_id is distinct from excluded.user_id or
      public.cloud_resend_audience_outbox.desired_unsubscribed is distinct from excluded.desired_unsubscribed or
      public.cloud_resend_audience_outbox.first_name is distinct from excluded.first_name or
      public.cloud_resend_audience_outbox.contact_properties is distinct from excluded.contact_properties or
      public.cloud_resend_audience_outbox.desired_segment_slugs is distinct from excluded.desired_segment_slugs or
      public.cloud_resend_audience_outbox.desired_topic_subscription is distinct from excluded.desired_topic_subscription or
      public.cloud_resend_audience_outbox.projection_version is distinct from excluded.projection_version
      then null else public.cloud_resend_audience_outbox.last_http_status end,
    last_result = case when
      public.cloud_resend_audience_outbox.user_id is distinct from excluded.user_id or
      public.cloud_resend_audience_outbox.desired_unsubscribed is distinct from excluded.desired_unsubscribed or
      public.cloud_resend_audience_outbox.first_name is distinct from excluded.first_name or
      public.cloud_resend_audience_outbox.contact_properties is distinct from excluded.contact_properties or
      public.cloud_resend_audience_outbox.desired_segment_slugs is distinct from excluded.desired_segment_slugs or
      public.cloud_resend_audience_outbox.desired_topic_subscription is distinct from excluded.desired_topic_subscription or
      public.cloud_resend_audience_outbox.projection_version is distinct from excluded.projection_version
      then null else public.cloud_resend_audience_outbox.last_result end,
    last_error = case when
      public.cloud_resend_audience_outbox.user_id is distinct from excluded.user_id or
      public.cloud_resend_audience_outbox.desired_unsubscribed is distinct from excluded.desired_unsubscribed or
      public.cloud_resend_audience_outbox.first_name is distinct from excluded.first_name or
      public.cloud_resend_audience_outbox.contact_properties is distinct from excluded.contact_properties or
      public.cloud_resend_audience_outbox.desired_segment_slugs is distinct from excluded.desired_segment_slugs or
      public.cloud_resend_audience_outbox.desired_topic_subscription is distinct from excluded.desired_topic_subscription or
      public.cloud_resend_audience_outbox.projection_version is distinct from excluded.projection_version
      then null else public.cloud_resend_audience_outbox.last_error end,
    updated_at = clock_timestamp()
  returning revision into v_revision;

  return v_revision;
end;
$function$;

revoke all on function public.norva_enqueue_resend_audience_contact(text, boolean, text, uuid)
  from public, anon, authenticated;
grant execute on function public.norva_enqueue_resend_audience_contact(text, boolean, text, uuid)
  to service_role;

drop function if exists public.claim_resend_audience_outbox(integer, integer);
create function public.claim_resend_audience_outbox(
  p_limit integer default 25,
  p_lease_seconds integer default 180
) returns table(
  email text,
  user_id uuid,
  desired_unsubscribed boolean,
  first_name text,
  contact_properties jsonb,
  desired_segment_slugs text[],
  desired_topic_subscription text,
  projection_version integer,
  revision bigint,
  attempt_count integer,
  lease_token uuid
)
language sql
volatile
security definer
set search_path = pg_catalog, public
as $function$
  with candidates as materialized (
    select o.email
    from public.cloud_resend_audience_outbox o
    where o.synced_revision is distinct from o.revision
      and o.next_attempt_at <= clock_timestamp()
      and (o.lease_expires_at is null or o.lease_expires_at <= clock_timestamp())
    -- Revocations/stale addresses outrank positive projection refreshes. This
    -- keeps the consent-propagation SLO below five minutes even during a large
    -- catalog/user backfill.
    order by o.desired_unsubscribed desc,
             ((o.contact_properties ->> 'account_class') = 'removed') desc,
             o.next_attempt_at, o.updated_at, o.email
    for update skip locked
    limit greatest(1, least(50, coalesce(p_limit, 25)))
  ), claimed as (
    update public.cloud_resend_audience_outbox o
    set lease_token = gen_random_uuid(),
        lease_expires_at = clock_timestamp()
          + make_interval(secs => greatest(60, least(900, coalesce(p_lease_seconds, 180)))),
        last_attempt_at = clock_timestamp(),
        attempt_count = o.attempt_count + 1,
        updated_at = clock_timestamp()
    from candidates c
    where o.email = c.email
    returning o.email, o.user_id, o.desired_unsubscribed, o.first_name,
              o.contact_properties, o.desired_segment_slugs,
              o.desired_topic_subscription, o.projection_version,
              o.revision, o.attempt_count, o.lease_token
  )
  select c.* from claimed c;
$function$;

revoke all on function public.claim_resend_audience_outbox(integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_resend_audience_outbox(integer, integer)
  to service_role;

create or replace function public.norva_reconcile_resend_contacts(
  p_limit integer default 25,
  p_stale_after interval default interval '24 hours'
) returns integer
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, auth
as $function$
declare
  u record;
  n integer := 0;
  v_opt_in boolean;
begin
  insert into public.cloud_marketing_email_preferences(user_id)
  select au.id from auth.users au
  on conflict (user_id) do nothing;

  for u in
    select au.id, au.email, au.raw_user_meta_data
    from auth.users au
    left join public.cloud_resend_audience_outbox o
      on o.email = lower(btrim(au.email))
    where au.email is not null
      and (o.email is null or o.projection_refreshed_at <= clock_timestamp() - p_stale_after)
    order by coalesce(o.projection_refreshed_at, '-infinity'::timestamptz), au.id
    limit greatest(1, least(250, coalesce(p_limit, 25)))
  loop
    select public.norva_marketing_email_allowed(u.id) into v_opt_in;
    perform public.norva_enqueue_resend_audience_contact(
      u.email,
      not coalesce(v_opt_in, false),
      coalesce(u.raw_user_meta_data->>'first_name', u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name'),
      u.id
    );
    n := n + 1;
  end loop;
  return n;
end;
$function$;

revoke all on function public.norva_reconcile_resend_contacts(integer, interval)
  from public, anon, authenticated;
grant execute on function public.norva_reconcile_resend_contacts(integer, interval)
  to service_role;

create or replace function public.norva_enqueue_user_resend_projection()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $function$
declare
  v_user_id uuid;
  v_email text;
  v_meta jsonb;
  v_opt_in boolean;
begin
  v_user_id := case when tg_op = 'DELETE' then old.user_id else new.user_id end;
  select u.email, u.raw_user_meta_data into v_email, v_meta
  from auth.users u where u.id = v_user_id;
  if v_email is null then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;
  select public.norva_marketing_email_allowed(v_user_id) into v_opt_in;
  perform public.norva_enqueue_resend_audience_contact(
    v_email,
    not coalesce(v_opt_in, false),
    coalesce(v_meta->>'first_name', v_meta->>'full_name', v_meta->>'name'),
    v_user_id
  );
  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$function$;

revoke all on function public.norva_enqueue_user_resend_projection()
  from public, anon, authenticated;

drop trigger if exists norva_resend_internal_account_projection_trg
  on public.admin_internal_accounts;
create trigger norva_resend_internal_account_projection_trg
  after insert or delete on public.admin_internal_accounts
  for each row execute function public.norva_enqueue_user_resend_projection();

drop trigger if exists norva_resend_entitlement_projection_trg
  on public.cloud_entitlement_projection;
create trigger norva_resend_entitlement_projection_trg
  after insert or update or delete on public.cloud_entitlement_projection
  for each row execute function public.norva_enqueue_user_resend_projection();

drop trigger if exists norva_resend_source_projection_trg on public.cloud_sources;
create trigger norva_resend_source_projection_trg
  after insert or update or delete on public.cloud_sources
  for each row execute function public.norva_enqueue_user_resend_projection();

-- Rebuild every current contact using the new minimized projection. This changes
-- no consent: all existing false preferences stay globally unsubscribed/opt_out.
select public.norva_backfill_resend_audience();

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
    'oldest_due_at', min(o.next_attempt_at) filter (
      where o.synced_revision is distinct from o.revision
    ),
    'lag_p95_seconds', coalesce(percentile_cont(0.95) within group (
      order by extract(epoch from (clock_timestamp() - o.updated_at))
    ) filter (where o.synced_revision is distinct from o.revision), 0),
    'last_synced_at', max(o.synced_at)
  )
  from public.cloud_resend_audience_outbox o
$function$;

create or replace function public.prune_resend_contact_projection_outbox()
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $function$
declare
  v_deleted integer;
begin
  -- Consent evidence lives in cloud_marketing_consent_events. Once a stale or
  -- deleted address has been reconciled, the operational outbox does not need
  -- to retain that address indefinitely.
  delete from public.cloud_resend_audience_outbox o
  where o.synced_revision = o.revision
    and o.synced_at < clock_timestamp() - interval '7 days'
    and not exists (
      select 1 from auth.users u
      where lower(btrim(u.email)) = o.email
    );
  get diagnostics v_deleted = row_count;
  return v_deleted;
end
$function$;

revoke all on function public.resend_contact_projection_health(),
  public.prune_resend_contact_projection_outbox()
  from public, anon, authenticated;
grant execute on function public.resend_contact_projection_health(),
  public.prune_resend_contact_projection_outbox()
  to service_role;

-- Dedicated minutely consent/contact worker. This is deliberately independent
-- from the 15-minute lifecycle marketing/billing sweep.
do $cron_setup$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron')
     and exists (select 1 from pg_namespace where nspname = 'net') then
    perform cron.schedule(
      'norva-resend-contact-projection',
      '* * * * *',
      $cron$
        select net.http_post(
          url := 'https://api.norva.tv/functions/v1/norva-lifecycle/cron/resend-contacts',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || (
              select decrypted_secret from vault.decrypted_secrets
              where name = 'norva_cron_shared_secret'
            )
          ),
          body := '{}'::jsonb,
          timeout_milliseconds := 50000
        )
        where exists (
          select 1 from public.cloud_resend_audience_outbox o
          where o.synced_revision is distinct from o.revision
            and o.next_attempt_at <= now()
            and (o.lease_expires_at is null or o.lease_expires_at <= now())
        );
      $cron$
    );
    perform cron.schedule(
      'norva-resend-contact-projection-prune',
      '35 3 * * *',
      'select public.prune_resend_contact_projection_outbox();'
    );
  end if;
exception when undefined_table or invalid_schema_name or insufficient_privilege then
  raise notice 'Resend contact projection crons unavailable; register externally';
end
$cron_setup$;

notify pgrst, 'reload schema';
