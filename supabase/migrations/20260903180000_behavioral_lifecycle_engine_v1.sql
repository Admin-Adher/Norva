begin;
set local lock_timeout = '3s';
set local statement_timeout = '90s';

-- Behavioral lifecycle engine (prepare-only release).
--
-- Safety properties:
--   * every journey ships in draft with rollout_percent = 0;
--   * activation starts a new cohort at activated_at, so no historical blast;
--   * identity-bearing state/outbox tables are service-only;
--   * no provider URL, credential, catalogue item id or email is stored here;
--   * delivery is leased, idempotent and re-authorized immediately before I/O;
--   * FCM acceptance is distinct from device delivery/opening.

alter table public.cloud_push_tokens
  add column if not exists permission_state text not null default 'unknown',
  add column if not exists permission_updated_at timestamptz,
  add column if not exists timezone text not null default 'UTC',
  add column if not exists locale text,
  add column if not exists app_version text;

alter table public.cloud_push_tokens
  drop constraint if exists cloud_push_tokens_permission_state_check,
  drop constraint if exists cloud_push_tokens_timezone_check,
  drop constraint if exists cloud_push_tokens_locale_check,
  drop constraint if exists cloud_push_tokens_app_version_check;

alter table public.cloud_push_tokens
  add constraint cloud_push_tokens_permission_state_check
    check (permission_state in ('unknown', 'prompt', 'granted', 'denied')),
  add constraint cloud_push_tokens_timezone_check
    check (char_length(timezone) between 1 and 64 and timezone ~ '^[A-Za-z0-9_+./-]+$'),
  add constraint cloud_push_tokens_locale_check
    check (locale is null or (char_length(locale) between 2 and 35 and locale ~ '^[A-Za-z0-9_-]+$')),
  add constraint cloud_push_tokens_app_version_check
    check (app_version is null or (char_length(app_version) between 1 and 40 and app_version ~ '^[A-Za-z0-9][A-Za-z0-9._+-]*$'));

create index if not exists cloud_push_tokens_granted_user_idx
  on public.cloud_push_tokens (user_id, last_seen_at desc)
  where permission_state = 'granted';

comment on column public.cloud_push_tokens.permission_state is
  'Last permission state reported by the native app. Existing tokens remain unknown and are not eligible for behavioral push.';

create table if not exists public.behavioral_lifecycle_journeys (
  journey_key text primary key check (journey_key in (
    'no_source', 'import_unresolved', 'catalog_ready_no_first_play', 'continue_watching'
  )),
  name text not null check (char_length(name) between 2 and 80),
  description text not null check (char_length(description) between 2 and 400),
  status text not null default 'draft' check (status in ('draft', 'active', 'paused', 'archived')),
  version integer not null default 1 check (version > 0),
  rollout_percent smallint not null default 0 check (rollout_percent between 0 and 100),
  holdout_percent smallint not null default 10 check (holdout_percent between 0 and 50),
  country_allowlist text[] not null default array['IN','BD']::text[],
  experiment_variable text not null default 'baseline'
    check (experiment_variable in ('baseline', 'delay', 'channel', 'copy', 'cta')),
  experiment_hypothesis text not null
    default 'Establish a reliable treatment versus holdout baseline.'
    check (char_length(experiment_hypothesis) between 20 and 500),
  experiment_window_hours smallint not null default 72
    check (experiment_window_hours in (24, 72, 168)),
  target_relative_lift_pct numeric(7,2)
    check (target_relative_lift_pct is null or target_relative_lift_pct between 0.01 and 1000),
  unsubscribe_lift_guardrail_pp numeric(5,2) not null default 0.50
    check (unsubscribe_lift_guardrail_pp between 0 and 10),
  provider_rejection_guardrail_pp numeric(5,2) not null default 0.50
    check (provider_rejection_guardrail_pp between 0 and 10),
  entry_event text not null default 'behavioral_condition_met'
    check (char_length(entry_event) between 2 and 80),
  exit_event text not null default 'behavioral_conversion'
    check (char_length(exit_event) between 2 and 80),
  cooldown_days smallint not null default 7 check (cooldown_days between 7 and 14),
  max_push_per_day smallint not null default 1 check (max_push_per_day between 0 and 1),
  max_push_per_week smallint not null default 3 check (max_push_per_week between 0 and 3),
  max_email_per_week smallint not null default 2 check (max_email_per_week between 0 and 2),
  quiet_start_hour smallint not null default 21 check (quiet_start_hour between 0 and 23),
  quiet_end_hour smallint not null default 9 check (quiet_end_hour between 0 and 23),
  activated_at timestamptz,
  activated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status <> 'active' or activated_at is not null),
  check (quiet_start_hour > quiet_end_hour),
  check (cardinality(country_allowlist) between 1 and 30)
);

create table if not exists public.behavioral_lifecycle_runtime (
  singleton boolean primary key default true check (singleton),
  emergency_stop boolean not null default true,
  audience_mode text not null default 'internal_test'
    check (audience_mode in ('internal_test', 'pilot')),
  reason text check (reason is null or char_length(reason) between 8 and 500),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

insert into public.behavioral_lifecycle_runtime (
  singleton, emergency_stop, audience_mode, reason
) values (
  true, true, 'internal_test', 'Fail-closed initial state: no behavioral delivery is authorized.'
) on conflict (singleton) do nothing;

-- Copy is configuration, but it is still an outbound data boundary. Keep that
-- boundary fail-closed even for service-role writes and future admin edits:
-- only fixed Norva destinations are allowed; interpolation syntax, addresses,
-- private domains, credential-like assignments and payment data are rejected;
-- and any claim about changed/new content requires the server-side freshness
-- predicate that is rechecked immediately before delivery.
create or replace function public.norva_behavioral_step_copy_safe(
  p_journey_key text,
  p_title text,
  p_body text,
  p_cta_label text,
  p_deep_link text,
  p_requires_new_content boolean
) returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $function$
  select
    p_journey_key in (
      'no_source', 'import_unresolved', 'catalog_ready_no_first_play', 'continue_watching'
    )
    and char_length(btrim(p_title)) between 2 and 80
    and char_length(btrim(p_body)) between 2 and 500
    and char_length(btrim(p_cta_label)) between 2 and 50
    and copy_text !~ '[[:cntrl:]]'
    and copy_text !~* '(^|[^[:alnum:]_])(https?://|www[.])'
    and copy_text !~* '[[:alnum:]][[:alnum:]._%+-]*@[[:alnum:].-]+[.][[:alpha:]]{2,}'
    and copy_text !~* E'\\m[[:alnum:]][[:alnum:].-]*[.][[:alpha:]]{2,}\\M'
    and copy_text !~* E'\\m(username|password|passwd|token|secret|api[ _-]?key|authorization|cookie)\\M[[:space:]]*(is|=|:)'
    and copy_text !~* E'\\m(card[[:space:]]+number|cvv|cvc|iban|bank[[:space:]]+account|payment[[:space:]]+details|billing[[:space:]]+details)\\M'
    and copy_text !~ '[0-9][0-9[:space:]-]{10,}[0-9]'
    and position('{{' in copy_text) = 0
    and position('${' in copy_text) = 0
    and position('<%' in copy_text) = 0
    and (
      coalesce(p_requires_new_content, false)
      or copy_text !~* E'\\m(new|latest|updated|changed)\\M|recently[[:space:]]+added'
    )
    and case p_journey_key
      when 'no_source' then p_deep_link = '/app.html#settings/sources'
      when 'import_unresolved' then p_deep_link = '/app.html#settings/sources'
      when 'catalog_ready_no_first_play' then p_deep_link = '/app.html#home'
      when 'continue_watching' then p_deep_link = case
        when coalesce(p_requires_new_content, false) then '/app.html#home'
        else '/app.html#home/resume'
      end
      else false
    end
  from (
    select concat_ws(' ', btrim(p_title), btrim(p_body), btrim(p_cta_label)) as copy_text
  ) normalized;
$function$;

revoke all on function public.norva_behavioral_step_copy_safe(
  text, text, text, text, text, boolean
) from public, anon, authenticated;
grant execute on function public.norva_behavioral_step_copy_safe(
  text, text, text, text, text, boolean
) to service_role;

create table if not exists public.behavioral_lifecycle_steps (
  journey_key text not null references public.behavioral_lifecycle_journeys(journey_key) on delete cascade,
  step_key text not null check (step_key ~ '^[a-z0-9_]{2,40}$'),
  ordinal smallint not null check (ordinal between 1 and 20),
  channel text not null check (channel in ('in_app', 'push', 'email')),
  delay_minutes integer not null check (delay_minutes between 0 and 43200),
  title text not null check (char_length(title) between 2 and 80),
  body text not null check (char_length(body) between 2 and 500),
  cta_label text not null check (char_length(cta_label) between 2 and 50),
  deep_link text not null check (deep_link in (
    '/app.html#settings/sources', '/app.html#home', '/app.html#home/resume'
  )),
  ttl_seconds integer not null check (ttl_seconds between 300 and 1209600),
  collapse_key text not null check (collapse_key ~ '^[a-z0-9_-]{2,64}$'),
  is_marketing boolean not null default false,
  requires_new_content boolean not null default false,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (journey_key, step_key),
  unique (journey_key, ordinal),
  check (collapse_key = 'lifecycle-' || replace(journey_key, '_', '-')),
  check (not requires_new_content or journey_key = 'continue_watching'),
  check (deep_link <> '/app.html#home/resume' or journey_key = 'continue_watching'),
  constraint behavioral_lifecycle_steps_safe_copy_check check (
    public.norva_behavioral_step_copy_safe(
      journey_key, title, body, cta_label, deep_link, requires_new_content
    )
  )
);

create table if not exists public.behavioral_lifecycle_experiment_versions (
  journey_key text not null
    references public.behavioral_lifecycle_journeys(journey_key) on delete cascade,
  config_version integer not null check (config_version > 0),
  experiment_variable text not null
    check (experiment_variable in ('baseline', 'delay', 'channel', 'copy', 'cta')),
  hypothesis text not null check (char_length(hypothesis) between 20 and 500),
  primary_metric text not null check (char_length(primary_metric) between 2 and 80),
  window_hours smallint not null check (window_hours in (24, 72, 168)),
  target_relative_lift_pct numeric(7,2)
    check (target_relative_lift_pct is null or target_relative_lift_pct between 0.01 and 1000),
  unsubscribe_lift_guardrail_pp numeric(5,2) not null
    check (unsubscribe_lift_guardrail_pp between 0 and 10),
  provider_rejection_guardrail_pp numeric(5,2) not null
    check (provider_rejection_guardrail_pp between 0 and 10),
  step_snapshot jsonb not null check (jsonb_typeof(step_snapshot) = 'object'),
  activated_at timestamptz not null,
  activated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (journey_key, config_version)
);

create table if not exists public.behavioral_lifecycle_user_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  registered_at timestamptz not null,
  signup_platform text not null default 'unknown'
    check (signup_platform in ('web', 'mobile_android', 'android_tv', 'unknown')),
  country_code text check (country_code is null or country_code ~ '^[A-Z]{2}$'),
  locale text check (locale is null or (char_length(locale) between 2 and 35 and locale ~ '^[A-Za-z0-9_-]+$')),
  timezone text not null default 'UTC'
    check (char_length(timezone) between 1 and 64 and timezone ~ '^[A-Za-z0-9_+./-]+$'),
  app_version text check (app_version is null or (char_length(app_version) between 1 and 40 and app_version ~ '^[A-Za-z0-9][A-Za-z0-9._+-]*$')),
  first_source_attempt_at timestamptz,
  last_source_attempt_at timestamptz,
  source_attempt_count integer not null default 0 check (source_attempt_count >= 0),
  last_source_type text check (last_source_type is null or last_source_type in ('m3u', 'xtream')),
  last_source_outcome text check (last_source_outcome is null or last_source_outcome in ('accepted', 'failed')),
  last_failure_family text check (last_failure_family is null or last_failure_family in (
    'credentials', 'missing_credentials', 'endpoint_not_found', 'timeout', 'provider_busy',
    'rate_limited', 'playlist_format', 'invalid_input', 'payload_too_large',
    'provider_unreachable', 'infrastructure', 'unknown'
  )),
  import_issue_started_at timestamptz,
  import_issue_origin text check (import_issue_origin is null or import_issue_origin in ('attempt', 'source')),
  import_succeeded_at timestamptz,
  catalog_ready_at timestamptz,
  first_play_at timestamptz,
  last_play_at timestamptz,
  resume_available boolean not null default false,
  resume_anchor_at timestamptz,
  last_new_content_at timestamptz,
  email_marketing_opt_in boolean not null default false,
  subscription_state text not null default 'unknown'
    check (subscription_state in (
      'trialing', 'active', 'grace', 'past_due', 'cancelled_at_period_end',
      'expired', 'revoked', 'refunded', 'fraud', 'unknown'
    )),
  trial_started_at timestamptz,
  subscription_started_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists behavioral_lifecycle_user_country_idx
  on public.behavioral_lifecycle_user_state (country_code, registered_at desc);
create index if not exists behavioral_lifecycle_no_source_idx
  on public.behavioral_lifecycle_user_state (registered_at)
  where first_source_attempt_at is null;
create index if not exists behavioral_lifecycle_import_issue_idx
  on public.behavioral_lifecycle_user_state (import_issue_started_at)
  where import_issue_started_at is not null;
create index if not exists behavioral_lifecycle_catalog_ready_idx
  on public.behavioral_lifecycle_user_state (catalog_ready_at)
  where catalog_ready_at is not null and first_play_at is null;
create index if not exists behavioral_lifecycle_resume_idx
  on public.behavioral_lifecycle_user_state (resume_anchor_at)
  where resume_available;

create table if not exists public.behavioral_lifecycle_outbox (
  id uuid primary key default gen_random_uuid(),
  dedupe_key text not null unique check (char_length(dedupe_key) between 16 and 240),
  user_id uuid not null references auth.users(id) on delete cascade,
  journey_key text not null references public.behavioral_lifecycle_journeys(journey_key),
  step_key text not null,
  config_version integer not null check (config_version > 0),
  channel text not null check (channel in ('in_app', 'push', 'email')),
  status text not null default 'pending' check (status in (
    'pending', 'processing', 'email_queued', 'provider_accepted', 'delivered', 'opened',
    'canceled', 'holdout', 'suppressed', 'dead_letter'
  )),
  experiment_arm text not null check (experiment_arm in ('treatment', 'holdout', 'outside_rollout')),
  title text not null check (char_length(title) between 2 and 80),
  body text not null check (char_length(body) between 2 and 500),
  cta_label text not null check (char_length(cta_label) between 2 and 50),
  deep_link text not null check (deep_link in (
    '/app.html#settings/sources', '/app.html#home', '/app.html#home/resume'
  )),
  ttl_seconds integer not null check (ttl_seconds between 300 and 1209600),
  collapse_key text not null check (collapse_key ~ '^[a-z0-9_-]{2,64}$'),
  is_marketing boolean not null default false,
  requires_new_content boolean not null default false,
  triggered_at timestamptz not null,
  scheduled_for timestamptz not null,
  expires_at timestamptz not null,
  next_attempt_at timestamptz not null,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  lease_token uuid,
  lease_expires_at timestamptz,
  transport_started_at timestamptz,
  provider_accepted_at timestamptz,
  delivered_at timestamptz,
  opened_at timestamptz,
  canceled_at timestamptz,
  dead_lettered_at timestamptz,
  email_outbox_id uuid references public.cloud_branded_email_outbox(id) on delete set null,
  device_count integer not null default 0 check (device_count >= 0),
  accepted_count integer not null default 0 check (accepted_count >= 0),
  failure_count integer not null default 0 check (failure_count >= 0),
  dead_token_count integer not null default 0 check (dead_token_count >= 0),
  last_error_family text check (last_error_family is null or last_error_family in (
    'eligibility_revoked', 'permission_unavailable', 'recipient_unavailable', 'provider_rejected',
    'transport_error', 'lease_expired', 'ttl_expired', 'configuration_changed',
    'frequency_capped', 'quiet_hours', 'unknown'
  )),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (journey_key, step_key)
    references public.behavioral_lifecycle_steps(journey_key, step_key),
  check (expires_at > scheduled_for),
  check (collapse_key = 'lifecycle-' || replace(journey_key, '_', '-')),
  check (deep_link <> '/app.html#home/resume' or journey_key = 'continue_watching'),
  constraint behavioral_lifecycle_outbox_safe_copy_check check (
    public.norva_behavioral_step_copy_safe(
      journey_key, title, body, cta_label, deep_link, requires_new_content
    )
  ),
  check ((status = 'processing') = (lease_token is not null and lease_expires_at is not null))
);

create index if not exists behavioral_lifecycle_outbox_due_idx
  on public.behavioral_lifecycle_outbox (channel, next_attempt_at, scheduled_for)
  where status = 'pending';
create index if not exists behavioral_lifecycle_outbox_user_channel_idx
  on public.behavioral_lifecycle_outbox (user_id, channel, provider_accepted_at desc);
create index if not exists behavioral_lifecycle_outbox_journey_idx
  on public.behavioral_lifecycle_outbox (journey_key, created_at desc);
create index if not exists behavioral_lifecycle_outbox_dead_idx
  on public.behavioral_lifecycle_outbox (dead_lettered_at desc)
  where status = 'dead_letter';

create table if not exists public.behavioral_lifecycle_delivery_events (
  id bigint generated always as identity primary key,
  delivery_id uuid not null references public.behavioral_lifecycle_outbox(id) on delete cascade,
  event_kind text not null check (event_kind in (
    'queued', 'holdout', 'suppressed', 'processing', 'email_queued', 'provider_accepted',
    'delivered', 'opened', 'deep_link_opened', 'retry_scheduled', 'canceled', 'dead_letter'
  )),
  error_family text check (error_family is null or error_family in (
    'eligibility_revoked', 'permission_unavailable', 'recipient_unavailable', 'provider_rejected',
    'transport_error', 'lease_expired', 'ttl_expired', 'configuration_changed',
    'frequency_capped', 'quiet_hours', 'unknown'
  )),
  occurred_at timestamptz not null default now()
);

create table if not exists public.behavioral_lifecycle_funnel_events (
  id bigint generated always as identity primary key,
  event_key text not null unique check (char_length(event_key) between 8 and 240),
  user_id uuid not null references auth.users(id) on delete cascade,
  event_name text not null check (event_name in (
    'message_eligible', 'message_queued', 'message_sent', 'message_provider_accepted',
    'message_delivered', 'message_opened', 'deep_link_opened', 'source_form_opened',
    'source_attempted', 'import_success', 'first_play', 'playback_resumed',
    'trial_started', 'subscription_started', 'message_cancelled_after_conversion',
    'email_unsubscribed'
  )),
  journey_key text references public.behavioral_lifecycle_journeys(journey_key),
  delivery_id uuid references public.behavioral_lifecycle_outbox(id) on delete set null,
  experiment_arm text check (experiment_arm is null or experiment_arm in (
    'treatment', 'holdout', 'outside_rollout'
  )),
  country_code text check (country_code is null or country_code ~ '^[A-Z]{2}$'),
  platform text not null default 'unknown'
    check (platform in ('web', 'mobile_android', 'android_tv', 'unknown')),
  app_version text check (app_version is null or (char_length(app_version) between 1 and 40 and app_version ~ '^[A-Za-z0-9][A-Za-z0-9._+-]*$')),
  occurred_at timestamptz not null default now()
);

-- Opening a real pilot is impossible until a controlled staging run has
-- attested the exact import release. The immutable row contains only bounded
-- release coordinates, booleans and a content digest; no provider URL,
-- credential, account identity or raw diagnostic is accepted.
create table if not exists public.behavioral_lifecycle_import_readiness (
  id uuid primary key default gen_random_uuid(),
  release_label text not null
    check (char_length(release_label) between 1 and 80
      and release_label ~ '^[A-Za-z0-9][A-Za-z0-9._+-]*$'),
  source_commit text not null check (source_commit ~ '^[0-9a-f]{40}$'),
  android_version text not null
    check (char_length(android_version) between 1 and 40
      and android_version ~ '^[A-Za-z0-9][A-Za-z0-9._+-]*$'),
  evidence_sha256 text not null unique check (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  m3u_valid boolean not null,
  xtream_valid boolean not null,
  large_catalog_valid boolean not null,
  error_guidance_valid boolean not null,
  android_webview_valid boolean not null,
  status text not null check (status in ('passed', 'failed')),
  checked_by uuid references auth.users(id) on delete set null,
  checked_at timestamptz not null default now(),
  expires_at timestamptz not null,
  check (expires_at > checked_at and expires_at <= checked_at + interval '14 days'),
  check (
    (status = 'passed') = (
      m3u_valid and xtream_valid and large_catalog_valid
      and error_guidance_valid and android_webview_valid
    )
  )
);

create table if not exists public.behavioral_lifecycle_admin_audit (
  id bigint generated always as identity primary key,
  action text not null check (action in (
    'runtime_stopped', 'runtime_started_internal_test', 'runtime_started_pilot',
    'import_readiness_recorded',
    'journey_saved', 'journey_activated', 'journey_paused', 'journey_archived',
    'step_updated', 'delivery_retried'
  )),
  journey_key text references public.behavioral_lifecycle_journeys(journey_key),
  actor_id uuid references auth.users(id) on delete set null,
  reason text not null check (char_length(reason) between 8 and 500),
  before_state jsonb not null default '{}'::jsonb check (jsonb_typeof(before_state) = 'object'),
  after_state jsonb not null default '{}'::jsonb check (jsonb_typeof(after_state) = 'object'),
  created_at timestamptz not null default now()
);

create index if not exists behavioral_lifecycle_events_delivery_idx
  on public.behavioral_lifecycle_delivery_events (delivery_id, occurred_at);
create index if not exists behavioral_lifecycle_events_kind_idx
  on public.behavioral_lifecycle_delivery_events (event_kind, occurred_at desc);
create index if not exists behavioral_lifecycle_funnel_name_time_idx
  on public.behavioral_lifecycle_funnel_events (event_name, occurred_at desc);
create index if not exists behavioral_lifecycle_funnel_user_time_idx
  on public.behavioral_lifecycle_funnel_events (user_id, occurred_at desc);
create index if not exists behavioral_lifecycle_funnel_dimension_idx
  on public.behavioral_lifecycle_funnel_events (
    country_code, platform, app_version, journey_key, occurred_at desc
  );
create index if not exists behavioral_lifecycle_funnel_journey_event_idx
  on public.behavioral_lifecycle_funnel_events (
    journey_key, event_name, occurred_at desc, user_id
  ) where journey_key is not null;
create index if not exists behavioral_lifecycle_admin_audit_time_idx
  on public.behavioral_lifecycle_admin_audit (created_at desc);
create index if not exists behavioral_lifecycle_import_readiness_time_idx
  on public.behavioral_lifecycle_import_readiness (checked_at desc, id desc);

alter table public.behavioral_lifecycle_journeys enable row level security;
alter table public.behavioral_lifecycle_runtime enable row level security;
alter table public.behavioral_lifecycle_steps enable row level security;
alter table public.behavioral_lifecycle_experiment_versions enable row level security;
alter table public.behavioral_lifecycle_user_state enable row level security;
alter table public.behavioral_lifecycle_outbox enable row level security;
alter table public.behavioral_lifecycle_delivery_events enable row level security;
alter table public.behavioral_lifecycle_funnel_events enable row level security;
alter table public.behavioral_lifecycle_import_readiness enable row level security;
alter table public.behavioral_lifecycle_admin_audit enable row level security;

revoke all on table
  public.behavioral_lifecycle_journeys,
  public.behavioral_lifecycle_runtime,
  public.behavioral_lifecycle_steps,
  public.behavioral_lifecycle_experiment_versions,
  public.behavioral_lifecycle_user_state,
  public.behavioral_lifecycle_outbox,
  public.behavioral_lifecycle_delivery_events,
  public.behavioral_lifecycle_funnel_events,
  public.behavioral_lifecycle_import_readiness,
  public.behavioral_lifecycle_admin_audit
from public, anon, authenticated;

grant select, insert, update, delete on table
  public.behavioral_lifecycle_journeys,
  public.behavioral_lifecycle_runtime,
  public.behavioral_lifecycle_steps,
  public.behavioral_lifecycle_user_state,
  public.behavioral_lifecycle_outbox,
  public.behavioral_lifecycle_delivery_events,
  public.behavioral_lifecycle_funnel_events,
  public.behavioral_lifecycle_admin_audit
to service_role;
grant select, insert on table
  public.behavioral_lifecycle_import_readiness
to service_role;
grant select, insert on table
  public.behavioral_lifecycle_experiment_versions
to service_role;
grant usage, select on sequence public.behavioral_lifecycle_delivery_events_id_seq to service_role;
grant usage, select on sequence public.behavioral_lifecycle_funnel_events_id_seq to service_role;
grant usage, select on sequence public.behavioral_lifecycle_admin_audit_id_seq to service_role;

insert into public.behavioral_lifecycle_journeys (
  journey_key, name, description, status, rollout_percent, holdout_percent,
  country_allowlist, experiment_variable, experiment_hypothesis,
  experiment_window_hours, target_relative_lift_pct,
  entry_event, exit_event, cooldown_days
) values
  ('no_source', 'Inscrit sans source', 'Aide un nouveau compte à connecter une source sans relance après sa première tentative.', 'draft', 0, 10, array['IN','BD'], 'baseline', 'The baseline sequence increases source attempts within 72 hours versus no lifecycle message.', 72, 20.00, 'sign_up', 'source_attempted', 14),
  ('import_unresolved', 'Import non résolu', 'Ramène vers l’import après un échec borné et s’arrête dès que le catalogue est prêt.', 'draft', 0, 10, array['IN','BD'], 'baseline', 'The baseline recovery sequence increases successful imports within 72 hours versus no lifecycle message.', 72, null, 'source_attempted_failed', 'import_success', 7),
  ('catalog_ready_no_first_play', 'Catalogue prêt sans lecture', 'Ouvre le catalogue prêt et s’arrête au premier démarrage réel.', 'draft', 0, 10, array['IN','BD'], 'baseline', 'The baseline readiness sequence increases first plays within 72 hours versus no lifecycle message.', 72, 15.00, 'import_success', 'first_play', 14),
  ('continue_watching', 'Reprendre la lecture', 'Propose une reprise uniquement lorsqu’une position exploitable existe.', 'draft', 0, 10, array['IN','BD'], 'baseline', 'The baseline resume sequence increases playback resumptions within 72 hours versus no lifecycle message.', 72, null, 'playback_abandoned', 'playback_resumed', 7)
on conflict (journey_key) do nothing;

insert into public.behavioral_lifecycle_steps (
  journey_key, step_key, ordinal, channel, delay_minutes, title, body,
  cta_label, deep_link, ttl_seconds, collapse_key, is_marketing, requires_new_content
) values
  ('no_source', 'context_help', 1, 'in_app', 15, 'Connect your TV service', 'Add your M3U link or Xtream details to build your catalogue.', 'Connect a source', '/app.html#settings/sources', 259200, 'lifecycle-no-source', false, false),
  ('no_source', 'day_one_push', 2, 'push', 1440, 'Your Norva catalogue is one step away', 'Connect your M3U link or Xtream details to start watching.', 'Connect a source', '/app.html#settings/sources', 172800, 'lifecycle-no-source', false, false),
  ('no_source', 'day_three_email', 3, 'email', 4320, 'Need help connecting your TV service?', 'Open the source screen and use the M3U link or Xtream details supplied by your TV service.', 'Open source setup', '/app.html#settings/sources', 259200, 'lifecycle-no-source', false, false),
  ('import_unresolved', 'error_help', 1, 'in_app', 0, 'Let’s fix this connection', 'Review the source format and try again from the same import screen.', 'Review source', '/app.html#settings/sources', 86400, 'lifecycle-import-unresolved', false, false),
  ('import_unresolved', 'two_hour_push', 2, 'push', 120, 'Your source still needs attention', 'Return to Norva to review the M3U or Xtream details and retry safely.', 'Review source', '/app.html#settings/sources', 86400, 'lifecycle-import-unresolved', false, false),
  ('import_unresolved', 'day_one_email', 3, 'email', 1440, 'How to finish your Norva import', 'Choose M3U when you received a playlist link, or Xtream when you received a server address, username and password.', 'Finish the import', '/app.html#settings/sources', 172800, 'lifecycle-import-unresolved', false, false),
  ('catalog_ready_no_first_play', 'ready_in_app', 1, 'in_app', 0, 'Your catalogue is ready', 'Open Norva and choose something to watch.', 'Browse the catalogue', '/app.html#home', 86400, 'lifecycle-catalog-ready-no-first-play', false, false),
  ('catalog_ready_no_first_play', 'four_hour_push', 2, 'push', 240, 'Your catalogue is ready', 'Open Norva and choose something from your catalogue.', 'Start watching', '/app.html#home', 86400, 'lifecycle-catalog-ready-no-first-play', false, false),
  ('catalog_ready_no_first_play', 'day_two_push', 3, 'push', 2880, 'Ready for your first watch?', 'Open your Norva catalogue and start on any screen.', 'Start watching', '/app.html#home', 86400, 'lifecycle-catalog-ready-no-first-play', false, false),
  ('continue_watching', 'two_day_push', 1, 'push', 2880, 'Continue where you left off', 'Your progress is saved. Open Norva to keep watching.', 'Continue watching', '/app.html#home/resume', 86400, 'lifecycle-continue-watching', false, false),
  ('continue_watching', 'new_content_week_push', 2, 'push', 10080, 'New content is waiting', 'Your catalogue has changed since your last watch. See what is new.', 'Open Norva', '/app.html#home', 86400, 'lifecycle-continue-watching', false, true)
on conflict (journey_key, step_key) do nothing;

comment on table public.behavioral_lifecycle_user_state is
  'Service-only lifecycle projection. Contains timestamps and bounded classifications, never provider URLs, credentials, content ids, email addresses or free-form provider responses.';
comment on table public.behavioral_lifecycle_outbox is
  'Durable per-user/per-step delivery queue. Provider acceptance, device delivery and opening are separate states.';
comment on table public.behavioral_lifecycle_runtime is
  'Singleton global circuit breaker. The migration ships stopped and in internal-test audience mode.';
comment on table public.behavioral_lifecycle_experiment_versions is
  'Append-only version snapshots. Baseline versions allow no message-variable delta; later versions may change exactly one of delay, channel, copy or CTA.';
comment on table public.behavioral_lifecycle_funnel_events is
  'Service-only, identity-bearing lifecycle measurement. Admin surfaces aggregate dimensions only.';
comment on table public.behavioral_lifecycle_import_readiness is
  'Append-only, PII-free staging import attestation. The latest fresh passing row is mandatory for pilot delivery.';
comment on table public.behavioral_lifecycle_admin_audit is
  'Append-only audit evidence for lifecycle configuration, runtime and retry actions.';

create or replace function public.norva_insert_behavioral_funnel_event(
  p_event_key text,
  p_user_id uuid,
  p_event_name text,
  p_journey_key text default null,
  p_delivery_id uuid default null,
  p_occurred_at timestamptz default clock_timestamp()
) returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_inserted boolean := false;
  v_event_at timestamptz := coalesce(p_occurred_at, clock_timestamp());
  v_journey_key text := p_journey_key;
  v_delivery_id uuid := p_delivery_id;
begin
  if p_user_id is null
     or char_length(coalesce(p_event_key, '')) not between 8 and 240
     or p_event_name not in (
       'message_eligible', 'message_queued', 'message_sent', 'message_provider_accepted',
       'message_delivered', 'message_opened', 'deep_link_opened', 'source_form_opened',
       'source_attempted', 'import_success', 'first_play', 'playback_resumed',
       'trial_started', 'subscription_started', 'message_cancelled_after_conversion',
       'email_unsubscribed'
     ) then
    return false;
  end if;

  -- Trial and subscription transitions are authoritative global events. Attribute
  -- them to the latest bounded lifecycle assignment in the preceding seven days
  -- so treatment/holdout reporting remains useful without accepting attribution
  -- coordinates from a client.
  if v_journey_key is null
     and p_event_name in ('trial_started', 'subscription_started') then
    select o.journey_key, o.id
      into v_journey_key, v_delivery_id
    from public.behavioral_lifecycle_outbox o
    where o.user_id = p_user_id
      and o.experiment_arm in ('treatment', 'holdout')
      and o.triggered_at <= v_event_at
      and o.triggered_at >= v_event_at - interval '7 days'
    order by coalesce(
      o.opened_at, o.delivered_at, o.provider_accepted_at,
      o.transport_started_at, o.triggered_at
    ) desc, o.created_at desc
    limit 1;
  end if;

  insert into public.behavioral_lifecycle_funnel_events (
    event_key, user_id, event_name, journey_key, delivery_id, experiment_arm,
    country_code, platform, app_version, occurred_at
  )
  select
    p_event_key, p_user_id, p_event_name, v_journey_key, v_delivery_id,
    coalesce(
      (select o.experiment_arm
       from public.behavioral_lifecycle_outbox o
       where o.id = v_delivery_id and o.user_id = p_user_id),
      (select o.experiment_arm
       from public.behavioral_lifecycle_outbox o
       where o.user_id = p_user_id
         and o.journey_key = v_journey_key
         and o.triggered_at <= v_event_at
       order by o.triggered_at desc, o.created_at desc
       limit 1),
      case when v_journey_key is null then null else 'outside_rollout' end
    ),
    s.country_code, coalesce(s.signup_platform, 'unknown'), s.app_version,
    v_event_at
  from auth.users u
  left join public.behavioral_lifecycle_user_state s on s.user_id = u.id
  where u.id = p_user_id
  on conflict (event_key) do nothing;
  v_inserted := found;
  return v_inserted;
end;
$function$;

revoke all on function public.norva_insert_behavioral_funnel_event(
  text, uuid, text, text, uuid, timestamptz
) from public, anon, authenticated;
grant execute on function public.norva_insert_behavioral_funnel_event(
  text, uuid, text, text, uuid, timestamptz
) to service_role;

create or replace function public.behavioral_lifecycle_log_funnel_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if tg_op = 'INSERT' then
    perform public.norva_insert_behavioral_funnel_event(
      new.id::text || ':message_eligible', new.user_id, 'message_eligible',
      new.journey_key, new.id, new.created_at
    );
    if new.status = 'pending' then
      perform public.norva_insert_behavioral_funnel_event(
        new.id::text || ':message_queued', new.user_id, 'message_queued',
        new.journey_key, new.id, new.created_at
      );
    end if;
    return new;
  end if;

  if new.transport_started_at is not null and old.transport_started_at is null then
    perform public.norva_insert_behavioral_funnel_event(
      new.id::text || ':message_sent', new.user_id, 'message_sent',
      new.journey_key, new.id, new.transport_started_at
    );
  end if;
  if new.provider_accepted_at is not null and old.provider_accepted_at is null then
    perform public.norva_insert_behavioral_funnel_event(
      new.id::text || ':message_provider_accepted', new.user_id,
      'message_provider_accepted', new.journey_key, new.id, new.provider_accepted_at
    );
  end if;
  if new.delivered_at is not null and old.delivered_at is null then
    perform public.norva_insert_behavioral_funnel_event(
      new.id::text || ':message_delivered', new.user_id, 'message_delivered',
      new.journey_key, new.id, new.delivered_at
    );
  end if;
  if new.opened_at is not null and old.opened_at is null then
    perform public.norva_insert_behavioral_funnel_event(
      new.id::text || ':message_opened', new.user_id, 'message_opened',
      new.journey_key, new.id, new.opened_at
    );
  end if;
  return new;
end;
$function$;

revoke all on function public.behavioral_lifecycle_log_funnel_change()
from public, anon, authenticated;

drop trigger if exists behavioral_lifecycle_outbox_funnel_log
on public.behavioral_lifecycle_outbox;
create trigger behavioral_lifecycle_outbox_funnel_log
after insert or update of transport_started_at, provider_accepted_at, delivered_at, opened_at
on public.behavioral_lifecycle_outbox
for each row execute function public.behavioral_lifecycle_log_funnel_change();

create or replace function public.behavioral_lifecycle_log_state_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_kind text;
begin
  if tg_op = 'INSERT' then
    v_kind := case new.status
      when 'holdout' then 'holdout'
      when 'suppressed' then 'suppressed'
      else 'queued'
    end;
  elsif new.status is distinct from old.status then
    v_kind := case new.status
      when 'pending' then 'retry_scheduled'
      when 'processing' then 'processing'
      when 'email_queued' then 'email_queued'
      when 'provider_accepted' then 'provider_accepted'
      when 'delivered' then 'delivered'
      when 'opened' then 'opened'
      when 'canceled' then 'canceled'
      when 'dead_letter' then 'dead_letter'
      when 'holdout' then 'holdout'
      else 'suppressed'
    end;
  else
    return new;
  end if;

  insert into public.behavioral_lifecycle_delivery_events (
    delivery_id, event_kind, error_family, occurred_at
  ) values (
    new.id, v_kind, new.last_error_family, clock_timestamp()
  ) on conflict do nothing;
  return new;
end;
$function$;

revoke all on function public.behavioral_lifecycle_log_state_change() from public, anon, authenticated;

drop trigger if exists behavioral_lifecycle_outbox_state_log on public.behavioral_lifecycle_outbox;
create trigger behavioral_lifecycle_outbox_state_log
after insert or update of status on public.behavioral_lifecycle_outbox
for each row execute function public.behavioral_lifecycle_log_state_change();

create or replace function public.norva_capture_behavioral_signup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  insert into public.behavioral_lifecycle_user_state (user_id, registered_at)
  values (new.id, new.created_at)
  on conflict (user_id) do nothing;
  return new;
exception when others then
  -- Lifecycle observability must never block account creation.
  raise warning 'Behavioral lifecycle signup projection failed: %', sqlstate;
  return new;
end;
$function$;

revoke all on function public.norva_capture_behavioral_signup() from public, anon, authenticated;

drop trigger if exists norva_capture_behavioral_signup_after_insert on auth.users;
create trigger norva_capture_behavioral_signup_after_insert
after insert on auth.users
for each row execute function public.norva_capture_behavioral_signup();

create or replace function public.norva_sync_behavioral_signup_context()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  insert into public.behavioral_lifecycle_user_state (
    user_id, registered_at, signup_platform, country_code, updated_at
  ) values (
    new.user_id,
    new.signed_up_at,
    case when new.signup_platform in ('web', 'mobile_android') then new.signup_platform else 'unknown' end,
    case when new.country_code ~ '^[A-Z]{2}$' then new.country_code else null end,
    clock_timestamp()
  )
  on conflict (user_id) do update
    set registered_at = excluded.registered_at,
        signup_platform = case
          when excluded.signup_platform <> 'unknown' then excluded.signup_platform
          else public.behavioral_lifecycle_user_state.signup_platform
        end,
        country_code = coalesce(excluded.country_code, public.behavioral_lifecycle_user_state.country_code),
        updated_at = clock_timestamp();
  return new;
exception when others then
  raise warning 'Behavioral lifecycle signup context failed: %', sqlstate;
  return new;
end;
$function$;

revoke all on function public.norva_sync_behavioral_signup_context() from public, anon, authenticated;

drop trigger if exists norva_sync_behavioral_signup_context_change on public.cloud_signup_attribution;
create trigger norva_sync_behavioral_signup_context_change
after insert or update of signup_platform, country_code on public.cloud_signup_attribution
for each row execute function public.norva_sync_behavioral_signup_context();

create or replace function public.norva_sync_behavioral_profile_context()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_registered_at timestamptz;
  v_locale text;
begin
  select u.created_at into v_registered_at from auth.users u where u.id = new.id;
  if v_registered_at is null then return new; end if;
  v_locale := case
    when new.locale ~ '^[A-Za-z0-9_-]{2,35}$' then new.locale
    else null
  end;
  insert into public.behavioral_lifecycle_user_state (
    user_id, registered_at, locale, updated_at
  ) values (new.id, v_registered_at, v_locale, clock_timestamp())
  on conflict (user_id) do update
    set locale = coalesce(excluded.locale, public.behavioral_lifecycle_user_state.locale),
        updated_at = clock_timestamp();
  return new;
exception when others then
  raise warning 'Behavioral lifecycle profile context failed: %', sqlstate;
  return new;
end;
$function$;

revoke all on function public.norva_sync_behavioral_profile_context() from public, anon, authenticated;

drop trigger if exists norva_sync_behavioral_profile_context_change on public.cloud_profiles;
create trigger norva_sync_behavioral_profile_context_change
after insert or update of locale on public.cloud_profiles
for each row execute function public.norva_sync_behavioral_profile_context();

create or replace function public.norva_cancel_behavioral_lifecycle_jobs(
  p_user_id uuid,
  p_journey_key text,
  p_error_family text default 'eligibility_revoked',
  p_after_conversion boolean default false
) returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_count integer;
  v_delivery record;
  v_error text := case
    when p_error_family in ('eligibility_revoked', 'configuration_changed') then p_error_family
    else 'eligibility_revoked'
  end;
begin
  v_count := 0;

  -- A delivered in-app reminder is a row in the persistent notification inbox.
  -- Once the expected action succeeds, remove that user-facing surface so it
  -- cannot ask the user to repeat completed work. Delivery/audit evidence stays
  -- in the dedicated lifecycle tables.
  if coalesce(p_after_conversion, false) then
    for v_delivery in
      select o.id, o.user_id, o.journey_key, clock_timestamp() as canceled_at
      from public.behavioral_lifecycle_outbox o
      join public.cloud_content_events e
        on e.id = o.id and e.kind = 'behavioral_lifecycle'
      where o.user_id = p_user_id
        and o.journey_key = p_journey_key
        and o.channel = 'in_app'
        and o.status in ('delivered', 'opened')
      for update of o, e
    loop
      delete from public.cloud_content_events e
      where e.id = v_delivery.id and e.kind = 'behavioral_lifecycle';
      if found then
        perform public.norva_insert_behavioral_funnel_event(
          v_delivery.id::text || ':message_cancelled_after_conversion',
          v_delivery.user_id, 'message_cancelled_after_conversion',
          v_delivery.journey_key, v_delivery.id, v_delivery.canceled_at
        );
      end if;
    end loop;
  end if;

  update public.cloud_branded_email_outbox e
     set state = 'canceled',
         last_error = 'behavioral_eligibility_revoked_before_send',
         lease_token = null,
         lease_expires_at = null,
         recipient_email = null,
         request_reply_to = null,
         request_subject = null,
         request_html = null,
         request_text = null,
         request_headers = '{}'::jsonb,
         payload_scrubbed_at = clock_timestamp(),
         updated_at = clock_timestamp()
   where e.id in (
     select o.email_outbox_id
     from public.behavioral_lifecycle_outbox o
     where o.user_id = p_user_id
       and o.journey_key = p_journey_key
       and o.status = 'email_queued'
       and o.email_outbox_id is not null
   )
     and (
       e.state = 'pending'
       or (e.state = 'processing' and e.transport_started_at is null)
     );

  for v_delivery in
    update public.behavioral_lifecycle_outbox o
       set status = 'canceled',
           canceled_at = clock_timestamp(),
           last_error_family = v_error,
           lease_token = null,
           lease_expires_at = null,
           updated_at = clock_timestamp()
     where o.user_id = p_user_id
       and o.journey_key = p_journey_key
       and o.status in ('pending', 'processing', 'email_queued')
       and o.transport_started_at is null
     returning o.id, o.user_id, o.journey_key, o.canceled_at
  loop
    v_count := v_count + 1;
    if coalesce(p_after_conversion, false) then
      perform public.norva_insert_behavioral_funnel_event(
        v_delivery.id::text || ':message_cancelled_after_conversion',
        v_delivery.user_id, 'message_cancelled_after_conversion',
        v_delivery.journey_key, v_delivery.id, v_delivery.canceled_at
      );
    end if;
  end loop;
  return v_count;
end;
$function$;

revoke all on function public.norva_cancel_behavioral_lifecycle_jobs(uuid, text, text, boolean)
from public, anon, authenticated;
grant execute on function public.norva_cancel_behavioral_lifecycle_jobs(uuid, text, text, boolean)
to service_role;

create or replace function public.norva_capture_behavioral_source_attempt(
  p_user_id uuid,
  p_source_type text,
  p_outcome text,
  p_failure_family text,
  p_platform text,
  p_app_version text,
  p_event_id uuid default gen_random_uuid()
) returns boolean
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
  v_registered_at timestamptz;
  v_country text;
  v_source_type text := lower(btrim(coalesce(p_source_type, '')));
  v_outcome text := lower(btrim(coalesce(p_outcome, '')));
  v_failure text := nullif(lower(btrim(coalesce(p_failure_family, ''))), '');
  v_platform text := lower(btrim(coalesce(p_platform, 'unknown')));
  v_now timestamptz := clock_timestamp();
begin
  if v_role is distinct from 'service_role' then
    raise exception 'service_role required' using errcode = '42501';
  end if;
  if v_source_type not in ('m3u', 'xtream') or v_outcome not in ('accepted', 'failed') then
    raise exception 'invalid behavioral source attempt' using errcode = '22023';
  end if;
  if v_outcome = 'failed' and coalesce(v_failure, 'unknown') not in (
    'credentials', 'missing_credentials', 'endpoint_not_found', 'timeout', 'provider_busy',
    'rate_limited', 'playlist_format', 'invalid_input', 'payload_too_large',
    'provider_unreachable', 'infrastructure', 'unknown'
  ) then
    v_failure := 'unknown';
  end if;
  if v_platform not in ('web', 'mobile_android', 'android_tv', 'unknown') then
    v_platform := 'unknown';
  end if;
  select u.created_at into v_registered_at from auth.users u where u.id = p_user_id;
  if v_registered_at is null then return false; end if;
  select a.country_code into v_country
  from public.cloud_signup_attribution a where a.user_id = p_user_id;

  insert into public.behavioral_lifecycle_user_state (
    user_id, registered_at, signup_platform, country_code,
    first_source_attempt_at, last_source_attempt_at, source_attempt_count,
    last_source_type, last_source_outcome, last_failure_family,
    import_issue_started_at, import_issue_origin, app_version, updated_at
  ) values (
    p_user_id, v_registered_at, v_platform,
    case when v_country ~ '^[A-Z]{2}$' then v_country else null end,
    v_now, v_now, 1, v_source_type, v_outcome,
    case when v_outcome = 'failed' then coalesce(v_failure, 'unknown') else null end,
    case when v_outcome = 'failed' then v_now else null end,
    case when v_outcome = 'failed' then 'attempt' else null end,
    case when p_app_version ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$' then p_app_version else null end,
    v_now
  )
  on conflict (user_id) do update
    set signup_platform = case
          when excluded.signup_platform <> 'unknown' then excluded.signup_platform
          else public.behavioral_lifecycle_user_state.signup_platform
        end,
        country_code = coalesce(excluded.country_code, public.behavioral_lifecycle_user_state.country_code),
        first_source_attempt_at = coalesce(public.behavioral_lifecycle_user_state.first_source_attempt_at, v_now),
        last_source_attempt_at = v_now,
        source_attempt_count = public.behavioral_lifecycle_user_state.source_attempt_count + 1,
        last_source_type = v_source_type,
        last_source_outcome = v_outcome,
        last_failure_family = case when v_outcome = 'failed' then coalesce(v_failure, 'unknown') else null end,
        import_issue_started_at = case when v_outcome = 'failed' then v_now else null end,
        import_issue_origin = case when v_outcome = 'failed' then 'attempt' else null end,
        app_version = coalesce(excluded.app_version, public.behavioral_lifecycle_user_state.app_version),
        updated_at = v_now;

  perform public.norva_insert_behavioral_funnel_event(
    'source-attempt:' || coalesce(p_event_id, gen_random_uuid())::text,
    p_user_id, 'source_attempted', 'no_source',
    null, v_now
  );
  perform public.norva_cancel_behavioral_lifecycle_jobs(
    p_user_id, 'no_source', 'eligibility_revoked', true
  );
  perform public.norva_cancel_behavioral_lifecycle_jobs(p_user_id, 'import_unresolved');
  return true;
end;
$function$;

revoke all on function public.norva_capture_behavioral_source_attempt(uuid, text, text, text, text, text, uuid)
from public, anon, authenticated;
grant execute on function public.norva_capture_behavioral_source_attempt(uuid, text, text, text, text, text, uuid)
to service_role;

create or replace function public.norva_record_behavioral_product_event(
  p_user_id uuid,
  p_event_name text,
  p_platform text,
  p_app_version text,
  p_event_id uuid default gen_random_uuid()
) returns boolean
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
  v_event text := lower(btrim(coalesce(p_event_name, '')));
  v_platform text := lower(btrim(coalesce(p_platform, 'unknown')));
  v_version text := nullif(btrim(coalesce(p_app_version, '')), '');
  v_registered_at timestamptz;
  v_now timestamptz := clock_timestamp();
begin
  if v_role is distinct from 'service_role' then
    raise exception 'service_role required' using errcode = '42501';
  end if;
  -- Public clients may report only this non-conversion interaction. Conversion
  -- events come from authoritative database transitions and cannot be forged.
  if v_event <> 'source_form_opened' then
    raise exception 'unsupported behavioral product event' using errcode = '22023';
  end if;
  if v_platform not in ('web', 'mobile_android', 'android_tv', 'unknown') then
    v_platform := 'unknown';
  end if;
  if v_version !~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$' then v_version := null; end if;
  select u.created_at into v_registered_at from auth.users u where u.id = p_user_id;
  if v_registered_at is null then return false; end if;

  insert into public.behavioral_lifecycle_user_state (
    user_id, registered_at, signup_platform, app_version, updated_at
  ) values (p_user_id, v_registered_at, v_platform, v_version, v_now)
  on conflict (user_id) do update set
    signup_platform = case when excluded.signup_platform <> 'unknown'
      then excluded.signup_platform else public.behavioral_lifecycle_user_state.signup_platform end,
    app_version = coalesce(excluded.app_version, public.behavioral_lifecycle_user_state.app_version),
    updated_at = v_now;

  return public.norva_insert_behavioral_funnel_event(
    'product:' || coalesce(p_event_id, gen_random_uuid())::text || ':' || v_event,
    p_user_id, v_event, 'no_source', null, v_now
  );
end;
$function$;

revoke all on function public.norva_record_behavioral_product_event(
  uuid, text, text, text, uuid
) from public, anon, authenticated;
grant execute on function public.norva_record_behavioral_product_event(
  uuid, text, text, text, uuid
) to service_role;

create or replace function public.norva_register_push_token(
  p_user_id uuid,
  p_token text,
  p_platform text,
  p_permission_state text,
  p_timezone text,
  p_locale text,
  p_app_version text
) returns jsonb
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
  v_platform text := lower(btrim(coalesce(p_platform, 'android')));
  v_permission text := lower(btrim(coalesce(p_permission_state, 'unknown')));
  v_timezone text := btrim(coalesce(p_timezone, 'UTC'));
  v_locale text := nullif(btrim(coalesce(p_locale, '')), '');
  v_version text := nullif(btrim(coalesce(p_app_version, '')), '');
  v_registered_at timestamptz;
  v_now timestamptz := clock_timestamp();
begin
  if v_role is distinct from 'service_role' then
    raise exception 'service_role required' using errcode = '42501';
  end if;
  if p_user_id is null or nullif(btrim(coalesce(p_token, '')), '') is null
     or char_length(p_token) > 4096 then
    raise exception 'invalid push token' using errcode = '22023';
  end if;
  if v_platform not in ('android', 'ios', 'web') then v_platform := 'android'; end if;
  if v_permission not in ('unknown', 'prompt', 'granted', 'denied') then v_permission := 'unknown'; end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = v_timezone) then
    v_timezone := 'UTC';
  end if;
  if v_locale !~ '^[A-Za-z0-9_-]{2,35}$' then v_locale := null; end if;
  if v_version !~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$' then v_version := null; end if;
  select u.created_at into v_registered_at from auth.users u where u.id = p_user_id;
  if v_registered_at is null then
    raise exception 'push token owner missing' using errcode = '23503';
  end if;

  insert into public.cloud_push_tokens (
    token, user_id, platform, permission_state, permission_updated_at,
    timezone, locale, app_version, updated_at, last_seen_at
  ) values (
    p_token, p_user_id, v_platform, v_permission, v_now,
    v_timezone, v_locale, v_version, v_now, v_now
  )
  on conflict (token) do update
    set user_id = excluded.user_id,
        platform = excluded.platform,
        permission_state = excluded.permission_state,
        permission_updated_at = excluded.permission_updated_at,
        timezone = excluded.timezone,
        locale = excluded.locale,
        app_version = excluded.app_version,
        updated_at = v_now,
        last_seen_at = v_now;

  insert into public.behavioral_lifecycle_user_state (
    user_id, registered_at, signup_platform, locale, timezone, app_version, updated_at
  ) values (
    p_user_id, v_registered_at,
    case when v_platform = 'android' then 'mobile_android' else case when v_platform = 'web' then 'web' else 'unknown' end end,
    v_locale, v_timezone, v_version, v_now
  )
  on conflict (user_id) do update
    set signup_platform = case
          when excluded.signup_platform <> 'unknown' then excluded.signup_platform
          else public.behavioral_lifecycle_user_state.signup_platform
        end,
        locale = coalesce(excluded.locale, public.behavioral_lifecycle_user_state.locale),
        timezone = excluded.timezone,
        app_version = coalesce(excluded.app_version, public.behavioral_lifecycle_user_state.app_version),
        updated_at = v_now;

  return jsonb_build_object('ok', true, 'permission_state', v_permission);
end;
$function$;

revoke all on function public.norva_register_push_token(uuid, text, text, text, text, text, text)
from public, anon, authenticated;
grant execute on function public.norva_register_push_token(uuid, text, text, text, text, text, text)
to service_role;

create or replace function public.norva_sync_behavioral_source_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_registered_at timestamptz;
  v_now timestamptz := clock_timestamp();
  v_ready boolean := new.deleted_at is null
    and coalesce(new.enabled, true)
    and new.sync_status = 'ready';
  v_failed boolean := new.deleted_at is null
    and coalesce(new.enabled, true)
    and not v_ready
    and (new.sync_status = 'error' or new.sync_error is not null);
  v_has_active_ready boolean := false;
  v_has_active_failed boolean := false;
  v_active_failure_at timestamptz;
  v_failure_transition boolean;
  v_import_success_transition boolean;
  v_first_catalog_ready_transition boolean;
  v_catalog_ready_at timestamptz;
begin
  select u.created_at into v_registered_at from auth.users u where u.id = new.user_id;
  if v_registered_at is null then return new; end if;
  select
    coalesce(bool_or(
      s.deleted_at is null and coalesce(s.enabled, true) and s.sync_status = 'ready'
    ), false),
    coalesce(bool_or(
      s.deleted_at is null and coalesce(s.enabled, true)
      and s.sync_status <> 'ready'
      and (s.sync_status = 'error' or s.sync_error is not null)
    ), false),
    max(coalesce(s.updated_at, s.created_at)) filter (
      where s.deleted_at is null and coalesce(s.enabled, true)
        and s.sync_status <> 'ready'
        and (s.sync_status = 'error' or s.sync_error is not null)
    )
  into v_has_active_ready, v_has_active_failed, v_active_failure_at
  from public.cloud_sources s
  where s.user_id = new.user_id;
  if tg_op = 'INSERT' then
    v_import_success_transition := v_ready;
    v_first_catalog_ready_transition := v_ready;
    v_failure_transition := v_failed;
  else
    v_import_success_transition := v_ready and (
      old.sync_status is distinct from new.sync_status
      or old.last_synced_at is distinct from new.last_synced_at
    );
    -- A routine refresh of an already-ready source must not restart the
    -- "first watch" journey. The first readiness transition is the only
    -- catalogue-ready trigger; an existing last_synced_at proves this source
    -- has already completed at least one import.
    v_first_catalog_ready_transition := v_ready
      and old.sync_status is distinct from 'ready'
      and old.last_synced_at is null;
    v_failure_transition := v_failed and (
      old.sync_status is distinct from new.sync_status
      or old.sync_error is distinct from new.sync_error
    );
  end if;
  v_catalog_ready_at := coalesce(new.last_synced_at, new.created_at, v_now);

  insert into public.behavioral_lifecycle_user_state (
    user_id, registered_at, first_source_attempt_at, last_source_attempt_at,
    source_attempt_count, last_source_type, last_source_outcome,
    last_failure_family, import_issue_started_at, import_issue_origin, import_succeeded_at,
    catalog_ready_at, updated_at
  ) values (
    new.user_id, v_registered_at, new.created_at, new.created_at, 1,
    case when new.source_type in ('m3u', 'xtream') then new.source_type else null end,
    case when v_failed then 'failed' else 'accepted' end,
    case when v_failed then 'unknown' else null end,
    case when v_failure_transition then v_now else null end,
    case when v_failure_transition then 'source' else null end,
    case when v_import_success_transition then v_now else null end,
    case when v_first_catalog_ready_transition then v_catalog_ready_at else null end,
    v_now
  )
  on conflict (user_id) do update
    set first_source_attempt_at = coalesce(
          public.behavioral_lifecycle_user_state.first_source_attempt_at,
          new.created_at
        ),
        last_source_attempt_at = greatest(
          coalesce(public.behavioral_lifecycle_user_state.last_source_attempt_at, '-infinity'::timestamptz),
          new.created_at
        ),
        source_attempt_count = greatest(public.behavioral_lifecycle_user_state.source_attempt_count, 1),
        last_source_type = coalesce(
          case when new.source_type in ('m3u', 'xtream') then new.source_type else null end,
          public.behavioral_lifecycle_user_state.last_source_type
        ),
        last_source_outcome = case
          when v_failed then 'failed'
          when v_ready then 'accepted'
          else public.behavioral_lifecycle_user_state.last_source_outcome
        end,
        last_failure_family = case
          when v_failed then 'unknown'
          when v_ready or v_has_active_ready or (
            not v_has_active_failed
            and public.behavioral_lifecycle_user_state.import_issue_origin = 'source'
          ) then null
          else public.behavioral_lifecycle_user_state.last_failure_family
        end,
        import_issue_started_at = case
          when v_ready or v_has_active_ready then null
          when v_has_active_failed then coalesce(
            v_active_failure_at,
            public.behavioral_lifecycle_user_state.import_issue_started_at,
            v_now
          )
          when public.behavioral_lifecycle_user_state.import_issue_origin = 'source' then null
          else public.behavioral_lifecycle_user_state.import_issue_started_at
        end,
        import_issue_origin = case
          when v_ready or v_has_active_ready then null
          when v_has_active_failed then 'source'
          when public.behavioral_lifecycle_user_state.import_issue_origin = 'source' then null
          else public.behavioral_lifecycle_user_state.import_issue_origin
        end,
        import_succeeded_at = case
          when v_import_success_transition then v_now
          else public.behavioral_lifecycle_user_state.import_succeeded_at
        end,
        catalog_ready_at = case
          when v_first_catalog_ready_transition
            then coalesce(
              public.behavioral_lifecycle_user_state.catalog_ready_at,
              v_catalog_ready_at
            )
          else public.behavioral_lifecycle_user_state.catalog_ready_at
        end,
        updated_at = v_now;

  perform public.norva_cancel_behavioral_lifecycle_jobs(
    new.user_id, 'no_source', 'eligibility_revoked', true
  );
  if v_import_success_transition then
    perform public.norva_insert_behavioral_funnel_event(
      'import-success:' || new.id::text || ':' || extract(epoch from v_catalog_ready_at)::bigint::text,
      new.user_id, 'import_success', 'import_unresolved', null, v_now
    );
    perform public.norva_cancel_behavioral_lifecycle_jobs(
      new.user_id, 'import_unresolved', 'eligibility_revoked', true
    );
  elsif v_failure_transition or (
    (new.deleted_at is not null or not coalesce(new.enabled, true))
    and not v_has_active_failed
  ) then
    perform public.norva_cancel_behavioral_lifecycle_jobs(new.user_id, 'import_unresolved');
  end if;
  if v_first_catalog_ready_transition then
    perform public.norva_cancel_behavioral_lifecycle_jobs(new.user_id, 'catalog_ready_no_first_play');
  end if;
  return new;
exception when others then
  raise warning 'Behavioral lifecycle source projection failed: %', sqlstate;
  return new;
end;
$function$;

revoke all on function public.norva_sync_behavioral_source_state() from public, anon, authenticated;

drop trigger if exists norva_sync_behavioral_source_state_change on public.cloud_sources;
create trigger norva_sync_behavioral_source_state_change
after insert or update of sync_status, sync_error, last_synced_at, enabled, deleted_at
on public.cloud_sources
for each row execute function public.norva_sync_behavioral_source_state();

create or replace function public.norva_sync_behavioral_playback_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_registered_at timestamptz;
  v_now timestamptz := clock_timestamp();
  v_is_first_play boolean := false;
begin
  if new.event_type not in ('first_frame', 'resume', 'ended') then return new; end if;
  select u.created_at into v_registered_at from auth.users u where u.id = new.user_id;
  if v_registered_at is null then return new; end if;
  if new.event_type = 'first_frame' then
    select not exists (
      select 1 from public.behavioral_lifecycle_user_state s
      where s.user_id = new.user_id and s.first_play_at is not null
    ) into v_is_first_play;
  end if;

  insert into public.behavioral_lifecycle_user_state (
    user_id, registered_at, first_play_at, last_play_at, updated_at
  ) values (
    new.user_id, v_registered_at,
    case when new.event_type = 'first_frame' then new.created_at else null end,
    new.created_at, v_now
  )
  on conflict (user_id) do update
    set first_play_at = case
          when new.event_type = 'first_frame' then coalesce(
            public.behavioral_lifecycle_user_state.first_play_at,
            new.created_at
          )
          else public.behavioral_lifecycle_user_state.first_play_at
        end,
        last_play_at = greatest(
          coalesce(public.behavioral_lifecycle_user_state.last_play_at, '-infinity'::timestamptz),
          new.created_at
        ),
        updated_at = v_now;

  if new.event_type = 'first_frame' and v_is_first_play then
    perform public.norva_insert_behavioral_funnel_event(
      'user:' || new.user_id::text || ':first_play', new.user_id,
      'first_play', 'catalog_ready_no_first_play', null, new.created_at
    );
    perform public.norva_cancel_behavioral_lifecycle_jobs(
      new.user_id, 'catalog_ready_no_first_play', 'eligibility_revoked', true
    );
  end if;
  if new.event_type = 'resume' then
    perform public.norva_insert_behavioral_funnel_event(
      'playback:' || new.id::text || ':playback_resumed', new.user_id,
      'playback_resumed', 'continue_watching', null, new.created_at
    );
    perform public.norva_cancel_behavioral_lifecycle_jobs(
      new.user_id, 'continue_watching', 'eligibility_revoked', true
    );
  end if;
  return new;
exception when others then
  raise warning 'Behavioral lifecycle playback projection failed: %', sqlstate;
  return new;
end;
$function$;

revoke all on function public.norva_sync_behavioral_playback_state() from public, anon, authenticated;

drop trigger if exists norva_sync_behavioral_playback_state_insert on public.cloud_playback_events;
create trigger norva_sync_behavioral_playback_state_insert
after insert on public.cloud_playback_events
for each row execute function public.norva_sync_behavioral_playback_state();

create or replace function public.norva_sync_behavioral_resume_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_registered_at timestamptz;
  v_now timestamptz := clock_timestamp();
  v_anchor timestamptz;
  v_resumable boolean := false;
  v_user_id uuid := case when tg_op = 'DELETE' then old.user_id else new.user_id end;
begin
  select u.created_at into v_registered_at from auth.users u where u.id = v_user_id;
  if v_registered_at is null then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  -- One completed or recently edited title must not hide another resumable
  -- title. Recompute the newest safe anchor across the account without
  -- retaining a content identifier in lifecycle state.
  select coalesce(w.watched_at, w.updated_at, w.created_at)
    into v_anchor
  from public.cloud_watch_history w
  where w.user_id = v_user_id
    and not w.completed
    and w.progress_seconds >= 30
    and (
      w.duration_seconds = 0
      or w.progress_seconds < greatest(w.duration_seconds - 60, 30)
    )
  order by coalesce(w.watched_at, w.updated_at, w.created_at) desc
  limit 1;
  v_resumable := v_anchor is not null;

  insert into public.behavioral_lifecycle_user_state (
    user_id, registered_at, resume_available, resume_anchor_at, updated_at
  ) values (
    v_user_id, v_registered_at, v_resumable,
    case when v_resumable then v_anchor else null end, v_now
  )
  on conflict (user_id) do update
    set resume_available = v_resumable,
        resume_anchor_at = case when v_resumable then v_anchor else null end,
        updated_at = v_now;

  perform public.norva_cancel_behavioral_lifecycle_jobs(v_user_id, 'continue_watching');
  if tg_op = 'DELETE' then return old; end if;
  return new;
exception when others then
  raise warning 'Behavioral lifecycle resume projection failed: %', sqlstate;
  return new;
end;
$function$;

revoke all on function public.norva_sync_behavioral_resume_state() from public, anon, authenticated;

drop trigger if exists norva_sync_behavioral_resume_state_change on public.cloud_watch_history;
create trigger norva_sync_behavioral_resume_state_change
after insert or delete or update of progress_seconds, duration_seconds, completed, watched_at
on public.cloud_watch_history
for each row execute function public.norva_sync_behavioral_resume_state();

create or replace function public.norva_sync_behavioral_new_content_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_registered_at timestamptz;
begin
  if new.kind <> 'new_content' then return new; end if;
  select u.created_at into v_registered_at from auth.users u where u.id = new.user_id;
  if v_registered_at is null then return new; end if;
  insert into public.behavioral_lifecycle_user_state (
    user_id, registered_at, last_new_content_at, updated_at
  ) values (new.user_id, v_registered_at, new.created_at, clock_timestamp())
  on conflict (user_id) do update
    set last_new_content_at = greatest(
          coalesce(public.behavioral_lifecycle_user_state.last_new_content_at, '-infinity'::timestamptz),
          new.created_at
        ),
        updated_at = clock_timestamp();
  return new;
exception when others then
  raise warning 'Behavioral lifecycle content projection failed: %', sqlstate;
  return new;
end;
$function$;

revoke all on function public.norva_sync_behavioral_new_content_state() from public, anon, authenticated;

drop trigger if exists norva_sync_behavioral_new_content_state_insert on public.cloud_content_events;
create trigger norva_sync_behavioral_new_content_state_insert
after insert on public.cloud_content_events
for each row execute function public.norva_sync_behavioral_new_content_state();

create or replace function public.norva_sync_behavioral_entitlement_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_registered_at timestamptz;
  v_now timestamptz := clock_timestamp();
  v_event_at timestamptz := coalesce(new.last_event_at, new.updated_at, v_now);
begin
  select u.created_at into v_registered_at from auth.users u where u.id = new.user_id;
  if v_registered_at is null then return new; end if;

  insert into public.behavioral_lifecycle_user_state (
    user_id, registered_at, subscription_state, trial_started_at,
    subscription_started_at, updated_at
  ) values (
    new.user_id, v_registered_at, coalesce(new.status, 'unknown'),
    case when new.status = 'trialing' then v_event_at else null end,
    case when new.status = 'active' and coalesce(new.provider, '') <> 'system'
      then v_event_at else null end,
    v_now
  )
  on conflict (user_id) do update set
    subscription_state = coalesce(new.status, 'unknown'),
    trial_started_at = case
      when new.status = 'trialing' then coalesce(
        public.behavioral_lifecycle_user_state.trial_started_at, v_event_at
      ) else public.behavioral_lifecycle_user_state.trial_started_at end,
    subscription_started_at = case
      when new.status = 'active' and coalesce(new.provider, '') <> 'system' then coalesce(
        public.behavioral_lifecycle_user_state.subscription_started_at, v_event_at
      ) else public.behavioral_lifecycle_user_state.subscription_started_at end,
    updated_at = v_now;

  if new.status = 'trialing' and (tg_op = 'INSERT' or old.status is distinct from 'trialing') then
    perform public.norva_insert_behavioral_funnel_event(
      'entitlement:' || new.user_id::text || ':trial:' || extract(epoch from v_event_at)::bigint::text,
      new.user_id, 'trial_started', null, null, v_event_at
    );
  elsif new.status = 'active' and coalesce(new.provider, '') <> 'system'
    and (tg_op = 'INSERT' or old.status is distinct from 'active') then
    perform public.norva_insert_behavioral_funnel_event(
      'entitlement:' || new.user_id::text || ':subscription:' || extract(epoch from v_event_at)::bigint::text,
      new.user_id, 'subscription_started', null, null, v_event_at
    );
  end if;
  return new;
exception when others then
  raise warning 'Behavioral lifecycle entitlement projection failed: %', sqlstate;
  return new;
end;
$function$;

revoke all on function public.norva_sync_behavioral_entitlement_state()
from public, anon, authenticated;

drop trigger if exists norva_sync_behavioral_entitlement_state_change
on public.cloud_entitlement_projection;
create trigger norva_sync_behavioral_entitlement_state_change
after insert or update of status, provider, last_event_at
on public.cloud_entitlement_projection
for each row execute function public.norva_sync_behavioral_entitlement_state();

create or replace function public.norva_sync_behavioral_marketing_preference()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_registered_at timestamptz;
  v_allowed boolean := new.marketing_email_opt_in and new.unsubscribed_at is null;
  v_was_allowed boolean := case when tg_op = 'INSERT' then false
    else old.marketing_email_opt_in and old.unsubscribed_at is null end;
  v_now timestamptz := clock_timestamp();
  v_attributed_journey text;
  v_attributed_delivery uuid;
begin
  select u.created_at into v_registered_at from auth.users u where u.id = new.user_id;
  if v_registered_at is null then return new; end if;
  insert into public.behavioral_lifecycle_user_state (
    user_id, registered_at, email_marketing_opt_in, updated_at
  ) values (new.user_id, v_registered_at, v_allowed, v_now)
  on conflict (user_id) do update set
    email_marketing_opt_in = v_allowed,
    updated_at = v_now;

  if v_was_allowed and not v_allowed then
    -- Attribute an unsubscribe only to the most recent lifecycle marketing
    -- email whose transport actually started. Pending drafts cannot claim it.
    select o.journey_key, o.id
      into v_attributed_journey, v_attributed_delivery
    from public.behavioral_lifecycle_outbox o
    where o.user_id = new.user_id
      and o.channel = 'email'
      and o.is_marketing
      and o.transport_started_at is not null
      and o.transport_started_at <= v_now
      and o.transport_started_at >= v_now - interval '30 days'
    order by coalesce(o.opened_at, o.provider_accepted_at, o.transport_started_at) desc,
             o.created_at desc
    limit 1;

    update public.cloud_branded_email_outbox e
    set state = 'canceled',
        last_error = 'behavioral_marketing_consent_revoked',
        lease_token = null, lease_expires_at = null,
        recipient_email = null, request_reply_to = null,
        request_subject = null, request_html = null, request_text = null,
        request_headers = '{}'::jsonb,
        payload_scrubbed_at = v_now, updated_at = v_now
    where e.id in (
      select o.email_outbox_id
      from public.behavioral_lifecycle_outbox o
      where o.user_id = new.user_id and o.channel = 'email'
        and o.is_marketing and o.status = 'email_queued'
        and o.email_outbox_id is not null
    ) and (
      e.state = 'pending'
      or (e.state = 'processing' and e.transport_started_at is null)
    );

    update public.behavioral_lifecycle_outbox o
    set status = 'canceled', canceled_at = v_now,
        last_error_family = 'eligibility_revoked',
        lease_token = null, lease_expires_at = null, updated_at = v_now
    where o.user_id = new.user_id and o.channel = 'email' and o.is_marketing
      and o.status in ('pending', 'processing', 'email_queued')
      and o.transport_started_at is null;

    perform public.norva_insert_behavioral_funnel_event(
      'email-unsubscribed:' || new.user_id::text || ':' ||
        coalesce(v_attributed_journey, 'global') || ':' ||
        extract(epoch from v_now)::bigint::text,
      new.user_id, 'email_unsubscribed', v_attributed_journey,
      v_attributed_delivery, v_now
    );
  end if;
  return new;
exception when others then
  raise warning 'Behavioral lifecycle marketing preference projection failed: %', sqlstate;
  return new;
end;
$function$;

revoke all on function public.norva_sync_behavioral_marketing_preference()
from public, anon, authenticated;

drop trigger if exists norva_sync_behavioral_marketing_preference_change
on public.cloud_marketing_email_preferences;
create trigger norva_sync_behavioral_marketing_preference_change
after insert or update of marketing_email_opt_in, unsubscribed_at
on public.cloud_marketing_email_preferences
for each row execute function public.norva_sync_behavioral_marketing_preference();

-- Snapshot the pre-existing account population without manufacturing historical
-- message events. Runtime remains stopped and every later activation establishes
-- a fresh cohort boundary, so this observability backfill cannot trigger a blast.
insert into public.behavioral_lifecycle_user_state (
  user_id, registered_at, signup_platform, country_code, locale,
  email_marketing_opt_in, subscription_state, trial_started_at,
  subscription_started_at, updated_at
)
select
  u.id,
  u.created_at,
  case when a.signup_platform in ('web', 'mobile_android')
    then a.signup_platform else 'unknown' end,
  case when a.country_code ~ '^[A-Z]{2}$' then a.country_code else null end,
  case when p.locale ~ '^[A-Za-z0-9_-]{2,35}$' then p.locale else null end,
  coalesce(mp.marketing_email_opt_in, false),
  coalesce(ep.status, 'unknown'),
  case when ep.status = 'trialing'
    then coalesce(ep.last_event_at, ep.created_at) else null end,
  case when ep.status in ('active', 'grace', 'past_due', 'cancelled_at_period_end')
             and coalesce(ep.plan_code, 'trial') <> 'trial'
    then coalesce(ep.last_event_at, ep.created_at) else null end,
  clock_timestamp()
from auth.users u
left join public.cloud_signup_attribution a on a.user_id = u.id
left join public.cloud_profiles p on p.id = u.id
left join public.cloud_marketing_email_preferences mp on mp.user_id = u.id
left join public.cloud_entitlement_projection ep on ep.user_id = u.id
on conflict (user_id) do update set
  registered_at = least(
    public.behavioral_lifecycle_user_state.registered_at,
    excluded.registered_at
  ),
  signup_platform = case when excluded.signup_platform <> 'unknown'
    then excluded.signup_platform
    else public.behavioral_lifecycle_user_state.signup_platform end,
  country_code = coalesce(
    excluded.country_code,
    public.behavioral_lifecycle_user_state.country_code
  ),
  locale = coalesce(excluded.locale, public.behavioral_lifecycle_user_state.locale),
  email_marketing_opt_in = excluded.email_marketing_opt_in,
  subscription_state = excluded.subscription_state,
  trial_started_at = coalesce(
    public.behavioral_lifecycle_user_state.trial_started_at,
    excluded.trial_started_at
  ),
  subscription_started_at = coalesce(
    public.behavioral_lifecycle_user_state.subscription_started_at,
    excluded.subscription_started_at
  ),
  updated_at = clock_timestamp();

with source_rollup as (
  select
    u.id as user_id,
    min(src.created_at) as first_attempt_at,
    max(coalesce(src.updated_at, src.created_at)) as last_attempt_at,
    count(src.id)::integer as attempt_count,
    (select case when latest.source_type in ('m3u', 'xtream')
       then latest.source_type else null end
     from public.cloud_sources latest
     where latest.user_id = u.id
     order by coalesce(latest.updated_at, latest.created_at) desc, latest.id desc
     limit 1) as last_source_type,
    bool_or(
      src.deleted_at is null and coalesce(src.enabled, true)
      and src.sync_status = 'ready'
    ) as has_ready,
    bool_or(
      src.deleted_at is null and coalesce(src.enabled, true)
      and (src.sync_status = 'error' or src.sync_error is not null)
    ) as has_error,
    min(coalesce(src.last_synced_at, src.updated_at, src.created_at)) filter (
      where src.deleted_at is null and coalesce(src.enabled, true)
        and src.sync_status = 'ready'
    ) as ready_at,
    max(coalesce(src.updated_at, src.created_at)) filter (
      where src.deleted_at is null and coalesce(src.enabled, true)
        and (src.sync_status = 'error' or src.sync_error is not null)
    ) as error_at
  from auth.users u
  left join public.cloud_sources src on src.user_id = u.id
  group by u.id
)
update public.behavioral_lifecycle_user_state s
set first_source_attempt_at = coalesce(s.first_source_attempt_at, r.first_attempt_at),
    last_source_attempt_at = case
      when r.last_attempt_at is null then s.last_source_attempt_at
      else greatest(
        coalesce(s.last_source_attempt_at, '-infinity'::timestamptz),
        r.last_attempt_at
      ) end,
    source_attempt_count = greatest(s.source_attempt_count, r.attempt_count),
    last_source_type = coalesce(r.last_source_type, s.last_source_type),
    last_source_outcome = case
      when coalesce(r.has_ready, false) then 'accepted'
      when coalesce(r.has_error, false) then 'failed'
      else s.last_source_outcome end,
    last_failure_family = case
      when coalesce(r.has_ready, false) then null
      when coalesce(r.has_error, false) then coalesce(s.last_failure_family, 'unknown')
      else s.last_failure_family end,
    import_issue_started_at = case
      when coalesce(r.has_ready, false) then null
      when coalesce(r.has_error, false) then coalesce(s.import_issue_started_at, r.error_at)
      else s.import_issue_started_at end,
    import_issue_origin = case
      when coalesce(r.has_ready, false) then null
      when coalesce(r.has_error, false) then coalesce(s.import_issue_origin, 'source')
      else s.import_issue_origin end,
    import_succeeded_at = case when coalesce(r.has_ready, false)
      then coalesce(s.import_succeeded_at, r.ready_at)
      else s.import_succeeded_at end,
    catalog_ready_at = case when coalesce(r.has_ready, false)
      then coalesce(s.catalog_ready_at, r.ready_at)
      else s.catalog_ready_at end,
    updated_at = clock_timestamp()
from source_rollup r
where r.user_id = s.user_id;

with event_rollup as (
  select
    e.user_id,
    min(e.created_at) filter (where e.event_type = 'first_frame') as first_play_at,
    max(e.created_at) filter (
      where e.event_type in ('first_frame', 'resume', 'ended')
    ) as last_play_at
  from public.cloud_playback_events e
  group by e.user_id
), resume_rollup as (
  select
    w.user_id,
    max(coalesce(w.watched_at, w.updated_at, w.created_at)) filter (
      where not w.completed and w.progress_seconds >= 30
        and (
          w.duration_seconds = 0
          or w.progress_seconds < greatest(w.duration_seconds - 60, 30)
        )
    ) as resume_anchor_at
  from public.cloud_watch_history w
  group by w.user_id
), playback_rollup as (
  select
    s.user_id,
    e.first_play_at,
    e.last_play_at,
    r.resume_anchor_at
  from public.behavioral_lifecycle_user_state s
  left join event_rollup e on e.user_id = s.user_id
  left join resume_rollup r on r.user_id = s.user_id
), content_rollup as (
  select e.user_id, max(e.created_at) as last_new_content_at
  from public.cloud_content_events e
  where e.kind = 'new_content'
  group by e.user_id
)
update public.behavioral_lifecycle_user_state s
set first_play_at = coalesce(s.first_play_at, p.first_play_at),
    last_play_at = case when p.last_play_at is null then s.last_play_at else greatest(
      coalesce(s.last_play_at, '-infinity'::timestamptz), p.last_play_at
    ) end,
    resume_available = p.resume_anchor_at is not null,
    resume_anchor_at = p.resume_anchor_at,
    last_new_content_at = case when c.last_new_content_at is null
      then s.last_new_content_at else greatest(
        coalesce(s.last_new_content_at, '-infinity'::timestamptz),
        c.last_new_content_at
      ) end,
    updated_at = clock_timestamp()
from playback_rollup p
left join content_rollup c on c.user_id = p.user_id
where p.user_id = s.user_id;

create or replace function public.norva_behavioral_bucket(
  p_user_id uuid,
  p_salt text
) returns integer
language sql
immutable
strict
set search_path = pg_catalog
as $function$
  select ((('x' || substr(md5(p_user_id::text || ':' || p_salt), 1, 8))::bit(32)::bigint) % 10000)::integer
$function$;

revoke all on function public.norva_behavioral_bucket(uuid, text)
from public, anon, authenticated;
grant execute on function public.norva_behavioral_bucket(uuid, text) to service_role;

create or replace function public.norva_behavioral_trigger_at(
  p_user_id uuid,
  p_journey_key text
) returns timestamptz
language sql
stable
security definer
set search_path = ''
as $function$
  select case p_journey_key
    when 'no_source' then s.registered_at
    when 'import_unresolved' then s.import_issue_started_at
    when 'catalog_ready_no_first_play' then s.catalog_ready_at
    when 'continue_watching' then s.resume_anchor_at
    else null
  end
  from public.behavioral_lifecycle_user_state s
  where s.user_id = p_user_id
$function$;

revoke all on function public.norva_behavioral_trigger_at(uuid, text)
from public, anon, authenticated;
grant execute on function public.norva_behavioral_trigger_at(uuid, text) to service_role;

create or replace function public.norva_behavioral_state_relevant(
  p_user_id uuid,
  p_journey_key text,
  p_now timestamptz default clock_timestamp()
) returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce((
    select
      case p_journey_key
        when 'no_source' then
          s.first_source_attempt_at is null
          and not exists (
            select 1 from public.cloud_sources src
            where src.user_id = s.user_id and src.deleted_at is null
          )
        when 'import_unresolved' then
          s.import_issue_started_at is not null
          and (s.import_succeeded_at is null or s.import_succeeded_at < s.import_issue_started_at)
          and (s.catalog_ready_at is null or s.catalog_ready_at < s.import_issue_started_at)
          and not exists (
            select 1 from public.cloud_sources src
            where src.user_id = s.user_id and src.deleted_at is null
              and coalesce(src.enabled, true) and src.sync_status = 'ready'
          )
          and (
            s.import_issue_origin is distinct from 'source'
            or exists (
              select 1 from public.cloud_sources src
              where src.user_id = s.user_id and src.deleted_at is null
                and coalesce(src.enabled, true) and src.sync_status <> 'ready'
                and (src.sync_status = 'error' or src.sync_error is not null)
            )
          )
        when 'catalog_ready_no_first_play' then
          s.catalog_ready_at is not null
          and s.first_play_at is null
          and exists (
            select 1 from public.cloud_sources src
            where src.user_id = s.user_id and src.deleted_at is null
              and coalesce(src.enabled, true) and src.sync_status = 'ready'
          )
        when 'continue_watching' then
          s.resume_available
          and s.resume_anchor_at is not null
          and exists (
            select 1 from public.cloud_watch_history w
            where w.user_id = s.user_id and not w.completed
              and w.progress_seconds >= 30
              and (
                w.duration_seconds = 0
                or w.progress_seconds < greatest(w.duration_seconds - 60, 30)
              )
          )
        else false
      end
    from public.behavioral_lifecycle_user_state s
    where s.user_id = p_user_id
  ), false)
$function$;

revoke all on function public.norva_behavioral_state_relevant(uuid, text, timestamptz)
from public, anon, authenticated;
grant execute on function public.norva_behavioral_state_relevant(uuid, text, timestamptz)
to service_role;

create or replace function public.norva_behavioral_journey_relevant(
  p_user_id uuid,
  p_journey_key text,
  p_now timestamptz default clock_timestamp()
) returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce((
    select
      not r.emergency_stop
      and j.status = 'active'
      and j.rollout_percent > 0
      and j.activated_at is not null
      and case r.audience_mode
        when 'internal_test' then exists (
          select 1 from public.admin_internal_accounts a where a.user_id = s.user_id
        )
        when 'pilot' then
          s.country_code = any(j.country_allowlist)
          and not exists (
            select 1 from public.admin_internal_accounts a where a.user_id = s.user_id
          )
          and coalesce((
            select g.status = 'passed'
              and g.expires_at > coalesce(p_now, clock_timestamp())
            from public.behavioral_lifecycle_import_readiness g
            order by g.checked_at desc, g.id desc
            limit 1
          ), false)
        else false
      end
      and public.norva_behavioral_state_relevant(
        s.user_id, p_journey_key, coalesce(p_now, clock_timestamp())
      )
      and not exists (
        select 1
        from public.behavioral_lifecycle_journeys higher
        where higher.status = 'active'
          and higher.rollout_percent > 0
          and case higher.journey_key
            when 'no_source' then 1
            when 'import_unresolved' then 2
            when 'catalog_ready_no_first_play' then 3
            when 'continue_watching' then 4
            else 100
          end < case j.journey_key
            when 'no_source' then 1
            when 'import_unresolved' then 2
            when 'catalog_ready_no_first_play' then 3
            when 'continue_watching' then 4
            else 100
          end
          and public.norva_behavioral_state_relevant(
            s.user_id, higher.journey_key, coalesce(p_now, clock_timestamp())
          )
      )
      and public.norva_behavioral_trigger_at(s.user_id, p_journey_key) >= j.activated_at
      and coalesce(p_now, clock_timestamp()) >= public.norva_behavioral_trigger_at(
        s.user_id, p_journey_key
      )
    from public.behavioral_lifecycle_user_state s
    join public.behavioral_lifecycle_journeys j on j.journey_key = p_journey_key
    join public.behavioral_lifecycle_runtime r on r.singleton
    where s.user_id = p_user_id
  ), false)
$function$;

revoke all on function public.norva_behavioral_journey_relevant(uuid, text, timestamptz)
from public, anon, authenticated;
grant execute on function public.norva_behavioral_journey_relevant(uuid, text, timestamptz)
to service_role;

create or replace function public.norva_behavioral_next_allowed_at(
  p_at timestamptz,
  p_timezone text,
  p_quiet_start smallint,
  p_quiet_end smallint
) returns timestamptz
language plpgsql
stable
set search_path = pg_catalog
as $function$
declare
  v_timezone text := coalesce(nullif(btrim(p_timezone), ''), 'UTC');
  v_local timestamp;
  v_hour integer;
  v_allowed_local timestamp;
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = v_timezone) then
    v_timezone := 'UTC';
  end if;
  v_local := coalesce(p_at, clock_timestamp()) at time zone v_timezone;
  v_hour := extract(hour from v_local)::integer;
  if v_hour >= p_quiet_start then
    v_allowed_local := date_trunc('day', v_local) + interval '1 day'
      + make_interval(hours => p_quiet_end);
  elsif v_hour < p_quiet_end then
    v_allowed_local := date_trunc('day', v_local)
      + make_interval(hours => p_quiet_end);
  else
    return coalesce(p_at, clock_timestamp());
  end if;
  return v_allowed_local at time zone v_timezone;
end;
$function$;

revoke all on function public.norva_behavioral_next_allowed_at(timestamptz, text, smallint, smallint)
from public, anon, authenticated;
grant execute on function public.norva_behavioral_next_allowed_at(timestamptz, text, smallint, smallint)
to service_role;

create or replace function public.norva_behavioral_delivery_eligible(
  p_delivery_id uuid,
  p_now timestamptz default clock_timestamp()
) returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce((
    select
      o.experiment_arm = 'treatment'
      and o.config_version = j.version
      and st.enabled
      and o.scheduled_for <= coalesce(p_now, clock_timestamp())
      and o.expires_at > coalesce(p_now, clock_timestamp())
      and public.norva_behavioral_journey_relevant(
        o.user_id, o.journey_key, coalesce(p_now, clock_timestamp())
      )
      and (
        not o.requires_new_content
        or (s.last_new_content_at is not null and s.last_new_content_at > s.resume_anchor_at)
      )
      and (
        not o.is_marketing
        or o.channel <> 'email'
        or public.norva_marketing_email_allowed(o.user_id)
      )
    from public.behavioral_lifecycle_outbox o
    join public.behavioral_lifecycle_journeys j on j.journey_key = o.journey_key
    join public.behavioral_lifecycle_steps st
      on st.journey_key = o.journey_key and st.step_key = o.step_key
    join public.behavioral_lifecycle_user_state s on s.user_id = o.user_id
    where o.id = p_delivery_id
  ), false)
$function$;

revoke all on function public.norva_behavioral_delivery_eligible(uuid, timestamptz)
from public, anon, authenticated;
grant execute on function public.norva_behavioral_delivery_eligible(uuid, timestamptz)
to service_role;

create or replace function public.norva_seed_behavioral_lifecycle_jobs(
  p_batch integer default 500
) returns jsonb
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
  v_inserted integer := 0;
  v_holdout integer := 0;
begin
  if v_role is distinct from 'service_role' then
    raise exception 'service_role required' using errcode = '42501';
  end if;

  with eligible as (
    select
      s.user_id, j.journey_key, j.version, j.rollout_percent, j.holdout_percent,
      j.cooldown_days,
      j.quiet_start_hour, j.quiet_end_hour, st.step_key, st.ordinal, st.channel,
      st.delay_minutes, st.title, st.body, st.cta_label, st.deep_link,
      st.ttl_seconds, st.collapse_key, st.is_marketing, st.requires_new_content,
      s.timezone,
      public.norva_behavioral_trigger_at(s.user_id, j.journey_key) as triggered_at,
      public.norva_behavioral_bucket(
        s.user_id, j.journey_key || ':rollout:' || j.version::text
      ) as rollout_bucket,
      public.norva_behavioral_bucket(
        s.user_id, j.journey_key || ':holdout'
      ) as holdout_bucket
    from public.behavioral_lifecycle_user_state s
    join public.behavioral_lifecycle_journeys j
      on j.status = 'active' and j.rollout_percent > 0
    join public.behavioral_lifecycle_steps st
      on st.journey_key = j.journey_key and st.enabled
    where public.norva_behavioral_journey_relevant(
      s.user_id, j.journey_key, clock_timestamp()
    )
      and public.norva_behavioral_bucket(
        s.user_id, j.journey_key || ':rollout:' || j.version::text
      ) < j.rollout_percent * 100
  ), candidates as (
    select e.*
    from eligible e
    where e.triggered_at is not null
      and not exists (
        select 1
        from public.behavioral_lifecycle_outbox o
        where o.dedupe_key = e.journey_key || ':' || e.version::text || ':' ||
          e.user_id::text || ':' || e.step_key || ':' ||
          extract(epoch from e.triggered_at)::bigint::text
      )
    order by e.is_marketing, e.triggered_at, e.user_id, e.ordinal
    limit greatest(1, least(coalesce(p_batch, 500), 5000))
  ), timed as (
    select c.*,
      case
        when c.holdout_bucket < c.holdout_percent * 100 then 'holdout'
        else 'treatment'
      end as arm,
      case
        when c.channel = 'in_app' then c.triggered_at + make_interval(mins => c.delay_minutes)
        else public.norva_behavioral_next_allowed_at(
          c.triggered_at + make_interval(mins => c.delay_minutes),
          c.timezone, c.quiet_start_hour, c.quiet_end_hour
        )
      end as base_allowed_at
    from candidates c
  ), prepared as (
    select t.*,
      greatest(
        t.base_allowed_at,
        coalesce((
          select max(coalesce(o.delivered_at, o.provider_accepted_at))
            + make_interval(days => t.cooldown_days)
          from public.behavioral_lifecycle_outbox o
          where o.user_id = t.user_id
            and o.journey_key = t.journey_key
            and o.triggered_at < t.triggered_at
            and o.status in ('provider_accepted', 'delivered', 'opened')
        ), t.base_allowed_at)
      ) as allowed_at
    from timed t
  ), inserted as (
    insert into public.behavioral_lifecycle_outbox (
      dedupe_key, user_id, journey_key, step_key, config_version, channel,
      status, experiment_arm, title, body, cta_label, deep_link,
      ttl_seconds, collapse_key, is_marketing, requires_new_content,
      triggered_at, scheduled_for, expires_at, next_attempt_at
    )
    select
      p.journey_key || ':' || p.version::text || ':' || p.user_id::text || ':' ||
        p.step_key || ':' || extract(epoch from p.triggered_at)::bigint::text,
      p.user_id, p.journey_key, p.step_key, p.version, p.channel,
      case when p.arm = 'holdout' then 'holdout' else 'pending' end,
      p.arm, p.title, p.body, p.cta_label, p.deep_link,
      p.ttl_seconds, p.collapse_key, p.is_marketing, p.requires_new_content,
      p.triggered_at, p.allowed_at,
      p.allowed_at + make_interval(secs => p.ttl_seconds), p.allowed_at
    from prepared p
    on conflict (dedupe_key) do nothing
    returning status
  )
  select count(*), count(*) filter (where status = 'holdout')
  into v_inserted, v_holdout
  from inserted;

  return jsonb_build_object('inserted', v_inserted, 'holdout', v_holdout);
end;
$function$;

revoke all on function public.norva_seed_behavioral_lifecycle_jobs(integer)
from public, anon, authenticated;
grant execute on function public.norva_seed_behavioral_lifecycle_jobs(integer)
to service_role;

create or replace function public.norva_materialize_behavioral_in_app(
  p_batch integer default 100
) returns integer
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
  v_count integer := 0;
  r record;
begin
  if v_role is distinct from 'service_role' then
    raise exception 'service_role required' using errcode = '42501';
  end if;
  for r in
    select o.*,
      s.last_failure_family as context_failure_family,
      s.last_source_type as context_source_type
    from public.behavioral_lifecycle_outbox o
    left join public.behavioral_lifecycle_user_state s on s.user_id = o.user_id
    where o.channel = 'in_app' and o.status = 'pending'
      and o.next_attempt_at <= clock_timestamp()
    order by o.is_marketing, o.next_attempt_at, o.created_at
    limit greatest(1, least(coalesce(p_batch, 100), 500))
    for update of o skip locked
  loop
    if not public.norva_behavioral_delivery_eligible(r.id, clock_timestamp()) then
      update public.behavioral_lifecycle_outbox
      set status = 'canceled', canceled_at = clock_timestamp(),
          last_error_family = case when r.expires_at <= clock_timestamp()
            then 'ttl_expired' else 'eligibility_revoked' end,
          updated_at = clock_timestamp()
      where id = r.id and status = 'pending';
      continue;
    end if;
    insert into public.cloud_content_events (
      id, user_id, source_id, kind, summary, payload, created_at
    ) values (
      r.id, r.user_id, null, 'behavioral_lifecycle', r.body,
      jsonb_strip_nulls(jsonb_build_object(
        'delivery_id', r.id,
        'journey_key', r.journey_key,
        'title', r.title,
        'body', r.body,
        'cta_label', r.cta_label,
        'deep_link', r.deep_link,
        'failure_family', case when r.journey_key = 'import_unresolved'
          then r.context_failure_family else null end,
        'source_type', case when r.journey_key = 'import_unresolved'
          then r.context_source_type else null end
      )), clock_timestamp()
    ) on conflict (id) do nothing;
    update public.behavioral_lifecycle_outbox
    set status = 'delivered', provider_accepted_at = clock_timestamp(),
        delivered_at = clock_timestamp(), updated_at = clock_timestamp()
    where id = r.id and status = 'pending';
    if found then v_count := v_count + 1; end if;
  end loop;
  return v_count;
end;
$function$;

revoke all on function public.norva_materialize_behavioral_in_app(integer)
from public, anon, authenticated;
grant execute on function public.norva_materialize_behavioral_in_app(integer)
to service_role;

create or replace function public.norva_behavioral_lifecycle_tick(
  p_seed_batch integer default 500,
  p_in_app_batch integer default 100
) returns jsonb
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
  v_seed jsonb;
  v_in_app integer;
  v_reclaimed integer;
  v_canceled integer;
begin
  if v_role is distinct from 'service_role' then
    raise exception 'service_role required' using errcode = '42501';
  end if;

  update public.behavioral_lifecycle_outbox o
  set status = case when o.transport_started_at is not null
                          or o.attempt_count >= 8
                          or o.expires_at <= clock_timestamp()
        then 'dead_letter' else 'pending' end,
      dead_lettered_at = case when o.transport_started_at is not null
                                   or o.attempt_count >= 8
                                   or o.expires_at <= clock_timestamp()
        then clock_timestamp() else null end,
      last_error_family = case when o.expires_at <= clock_timestamp()
        then 'ttl_expired' else 'lease_expired' end,
      next_attempt_at = case when o.transport_started_at is not null
                                  or o.attempt_count >= 8
                                  or o.expires_at <= clock_timestamp()
        then o.next_attempt_at else clock_timestamp() end,
      lease_token = null, lease_expires_at = null, updated_at = clock_timestamp()
  where o.status = 'processing' and o.lease_expires_at <= clock_timestamp();
  get diagnostics v_reclaimed = row_count;

  update public.behavioral_lifecycle_outbox o
  set status = 'canceled', canceled_at = clock_timestamp(),
      last_error_family = case when o.expires_at <= clock_timestamp()
        then 'ttl_expired' else 'eligibility_revoked' end,
      lease_token = null, lease_expires_at = null, updated_at = clock_timestamp()
  where o.status in ('pending', 'processing')
    and o.transport_started_at is null
    and (
      o.expires_at <= clock_timestamp()
      or not public.norva_behavioral_journey_relevant(
        o.user_id, o.journey_key, clock_timestamp()
      )
      or not exists (
        select 1
        from public.behavioral_lifecycle_journeys j
        join public.behavioral_lifecycle_steps st
          on st.journey_key = j.journey_key
        where j.journey_key = o.journey_key
          and st.step_key = o.step_key
          and st.enabled
          and j.version = o.config_version
      )
    );
  get diagnostics v_canceled = row_count;

  v_seed := public.norva_seed_behavioral_lifecycle_jobs(p_seed_batch);
  v_in_app := public.norva_materialize_behavioral_in_app(p_in_app_batch);
  return jsonb_build_object(
    'seed', v_seed,
    'in_app_materialized', v_in_app,
    'leases_reclaimed', v_reclaimed,
    'canceled', v_canceled
  );
end;
$function$;

revoke all on function public.norva_behavioral_lifecycle_tick(integer, integer)
from public, anon, authenticated;
grant execute on function public.norva_behavioral_lifecycle_tick(integer, integer)
to service_role;

create or replace function public.norva_claim_behavioral_deliveries(
  p_channel text,
  p_batch integer default 25,
  p_lease_seconds integer default 90
) returns table (
  id uuid,
  lease_token uuid,
  user_id uuid,
  journey_key text,
  step_key text,
  channel text,
  title text,
  body text,
  cta_label text,
  deep_link text,
  ttl_seconds integer,
  collapse_key text,
  is_marketing boolean,
  attempt_count integer
)
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
begin
  if v_role is distinct from 'service_role' then
    raise exception 'service_role required' using errcode = '42501';
  end if;
  if p_channel not in ('push', 'email') then
    raise exception 'unsupported behavioral channel' using errcode = '22023';
  end if;

  return query
  with due as (
    select o.id
    from public.behavioral_lifecycle_outbox o
    where o.channel = p_channel and o.status = 'pending'
      and o.next_attempt_at <= clock_timestamp()
      and o.expires_at > clock_timestamp()
      and o.attempt_count < 8
    order by o.is_marketing, o.next_attempt_at, o.created_at
    limit greatest(1, least(coalesce(p_batch, 25), 100))
    for update skip locked
  ), claimed as (
    update public.behavioral_lifecycle_outbox o
    set status = 'processing', lease_token = gen_random_uuid(),
        lease_expires_at = clock_timestamp() + make_interval(
          secs => greatest(30, least(coalesce(p_lease_seconds, 90), 300))
        ),
        attempt_count = o.attempt_count + 1,
        updated_at = clock_timestamp()
    from due where o.id = due.id
    returning o.*
  )
  select c.id, c.lease_token, c.user_id, c.journey_key, c.step_key,
         c.channel, c.title, c.body, c.cta_label, c.deep_link,
         c.ttl_seconds, c.collapse_key, c.is_marketing, c.attempt_count
  from claimed c
  order by c.is_marketing, c.next_attempt_at, c.created_at;
end;
$function$;

revoke all on function public.norva_claim_behavioral_deliveries(text, integer, integer)
from public, anon, authenticated;
grant execute on function public.norva_claim_behavioral_deliveries(text, integer, integer)
to service_role;

create or replace function public.norva_behavioral_frequency_allowed_at(
  p_user_id uuid,
  p_channel text,
  p_journey_key text,
  p_now timestamptz default clock_timestamp(),
  p_exclude_delivery_id uuid default null
) returns timestamptz
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_journey record;
  v_daily_count integer;
  v_weekly_count integer;
  v_daily_release timestamptz;
  v_weekly_release timestamptz;
  v_allowed timestamptz := coalesce(p_now, clock_timestamp());
begin
  select * into v_journey
  from public.behavioral_lifecycle_journeys j
  where j.journey_key = p_journey_key;
  if not found then return v_allowed + interval '100 years'; end if;

  if p_channel = 'push' then
    select count(*), min(coalesce(o.provider_accepted_at, o.transport_started_at)) + interval '24 hours'
      into v_daily_count, v_daily_release
    from public.behavioral_lifecycle_outbox o
    where o.user_id = p_user_id and o.channel = 'push'
      and (p_exclude_delivery_id is null or o.id <> p_exclude_delivery_id)
      and (
        o.provider_accepted_at >= v_allowed - interval '24 hours'
        or (o.status = 'processing' and o.transport_started_at >= v_allowed - interval '24 hours')
      );
    select count(*), min(coalesce(o.provider_accepted_at, o.transport_started_at)) + interval '7 days'
      into v_weekly_count, v_weekly_release
    from public.behavioral_lifecycle_outbox o
    where o.user_id = p_user_id and o.channel = 'push'
      and (p_exclude_delivery_id is null or o.id <> p_exclude_delivery_id)
      and (
        o.provider_accepted_at >= v_allowed - interval '7 days'
        or (o.status = 'processing' and o.transport_started_at >= v_allowed - interval '7 days')
      );
    if v_journey.max_push_per_day = 0 or v_daily_count >= v_journey.max_push_per_day then
      v_allowed := greatest(v_allowed, coalesce(v_daily_release, v_allowed + interval '24 hours'));
    end if;
    if v_journey.max_push_per_week = 0 or v_weekly_count >= v_journey.max_push_per_week then
      v_allowed := greatest(v_allowed, coalesce(v_weekly_release, v_allowed + interval '7 days'));
    end if;
  elsif p_channel = 'email' then
    select count(*), min(coalesce(o.provider_accepted_at, o.transport_started_at, o.updated_at)) + interval '7 days'
      into v_weekly_count, v_weekly_release
    from public.behavioral_lifecycle_outbox o
    where o.user_id = p_user_id and o.channel = 'email'
      and (p_exclude_delivery_id is null or o.id <> p_exclude_delivery_id)
      and (
        o.provider_accepted_at >= v_allowed - interval '7 days'
        or (
          o.status = 'email_queued'
          and coalesce(o.transport_started_at, o.updated_at) >= v_allowed - interval '7 days'
        )
      );
    if v_journey.max_email_per_week = 0 or v_weekly_count >= v_journey.max_email_per_week then
      v_allowed := greatest(v_allowed, coalesce(v_weekly_release, v_allowed + interval '7 days'));
    end if;
  end if;
  return v_allowed;
end;
$function$;

revoke all on function public.norva_behavioral_frequency_allowed_at(uuid, text, text, timestamptz, uuid)
from public, anon, authenticated;
grant execute on function public.norva_behavioral_frequency_allowed_at(uuid, text, text, timestamptz, uuid)
to service_role;

create or replace function public.norva_authorize_behavioral_push(
  p_delivery_id uuid,
  p_lease_token uuid
) returns jsonb
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
  o record;
  j record;
  s record;
  v_now timestamptz := clock_timestamp();
  v_quiet_allowed timestamptz;
  v_frequency_allowed timestamptz;
  v_tokens jsonb;
  v_device_count integer;
begin
  if v_role is distinct from 'service_role' then
    raise exception 'service_role required' using errcode = '42501';
  end if;
  select * into o from public.behavioral_lifecycle_outbox x
  where x.id = p_delivery_id and x.channel = 'push'
    and x.status = 'processing' and x.lease_token = p_lease_token
  for update;
  if not found then return jsonb_build_object('authorized', false, 'reason', 'claim_missing'); end if;

  select * into j from public.behavioral_lifecycle_journeys x where x.journey_key = o.journey_key;
  select * into s from public.behavioral_lifecycle_user_state x where x.user_id = o.user_id for update;
  if not public.norva_behavioral_delivery_eligible(o.id, v_now) then
    update public.behavioral_lifecycle_outbox
    set status = 'canceled', canceled_at = v_now,
        last_error_family = case when o.expires_at <= v_now
          then 'ttl_expired' else 'eligibility_revoked' end,
        lease_token = null, lease_expires_at = null, updated_at = v_now
    where id = o.id and status = 'processing' and lease_token = p_lease_token;
    return jsonb_build_object('authorized', false, 'reason', 'eligibility_revoked');
  end if;

  v_quiet_allowed := public.norva_behavioral_next_allowed_at(
    v_now, s.timezone, j.quiet_start_hour, j.quiet_end_hour
  );
  v_frequency_allowed := public.norva_behavioral_frequency_allowed_at(
    o.user_id, 'push', o.journey_key, v_now
  );
  if greatest(v_quiet_allowed, v_frequency_allowed) > v_now + interval '1 second' then
    update public.behavioral_lifecycle_outbox
    set status = 'pending',
        next_attempt_at = greatest(v_quiet_allowed, v_frequency_allowed),
        last_error_family = case when v_quiet_allowed >= v_frequency_allowed
          then 'quiet_hours' else 'frequency_capped' end,
        lease_token = null, lease_expires_at = null, updated_at = v_now

    where id = o.id and status = 'processing' and lease_token = p_lease_token;
    return jsonb_build_object('authorized', false, 'reason', 'deferred');
  end if;

  select coalesce(jsonb_agg(t.token order by t.last_seen_at desc), '[]'::jsonb), count(*)
    into v_tokens, v_device_count
  from public.cloud_push_tokens t
  where t.user_id = o.user_id
    and t.permission_state = 'granted'
    and t.last_seen_at >= v_now - interval '45 days';
  if v_device_count = 0 then
    update public.behavioral_lifecycle_outbox
    set status = 'suppressed', last_error_family = 'permission_unavailable',
        lease_token = null, lease_expires_at = null, updated_at = v_now
    where id = o.id and status = 'processing' and lease_token = p_lease_token;
    return jsonb_build_object('authorized', false, 'reason', 'permission_unavailable');
  end if;

  update public.behavioral_lifecycle_outbox
  set transport_started_at = coalesce(transport_started_at, v_now),
      device_count = v_device_count, last_error_family = null, updated_at = v_now
  where id = o.id and status = 'processing' and lease_token = p_lease_token;
  return jsonb_strip_nulls(jsonb_build_object(
    'authorized', true,
    'delivery_id', o.id,
    'tokens', v_tokens,
    'title', o.title,
    'body', o.body,
    'deep_link', o.deep_link,
    'ttl_seconds', o.ttl_seconds,
    'collapse_key', o.collapse_key,
    'failure_family', case when o.journey_key = 'import_unresolved'
      then s.last_failure_family else null end,
    'source_type', case when o.journey_key = 'import_unresolved'
      then s.last_source_type else null end
  ));
end;
$function$;

revoke all on function public.norva_authorize_behavioral_push(uuid, uuid)
from public, anon, authenticated;
grant execute on function public.norva_authorize_behavioral_push(uuid, uuid)
to service_role;

create or replace function public.norva_complete_behavioral_push(
  p_delivery_id uuid,
  p_lease_token uuid,
  p_accepted integer,
  p_failed integer,
  p_dead integer,
  p_retryable boolean default true,
  p_error_family text default null
) returns text
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
  o record;
  v_now timestamptz := clock_timestamp();
  v_error text := case when p_error_family in (
    'provider_rejected', 'transport_error', 'recipient_unavailable', 'unknown'
  ) then p_error_family else 'unknown' end;
  v_state text;
begin
  if v_role is distinct from 'service_role' then
    raise exception 'service_role required' using errcode = '42501';
  end if;
  select * into o from public.behavioral_lifecycle_outbox x
  where x.id = p_delivery_id and x.status = 'processing' and x.lease_token = p_lease_token
  for update;
  if not found then return 'claim_missing'; end if;

  if greatest(coalesce(p_accepted, 0), 0) > 0
     or o.delivered_at is not null
     or o.opened_at is not null then
    v_state := case
      when o.opened_at is not null then 'opened'
      when o.delivered_at is not null then 'delivered'
      else 'provider_accepted'
    end;
    update public.behavioral_lifecycle_outbox
    set status = v_state, provider_accepted_at = v_now,
        accepted_count = greatest(
          coalesce(p_accepted, 0),
          case when o.delivered_at is not null or o.opened_at is not null then 1 else 0 end
        ),
        failure_count = greatest(coalesce(p_failed, 0), 0),
        dead_token_count = greatest(coalesce(p_dead, 0), 0),
        last_error_family = case when coalesce(p_failed, 0) > 0 then v_error else null end,
        lease_token = null, lease_expires_at = null, updated_at = v_now
    where id = o.id and status = 'processing' and lease_token = p_lease_token;
  elsif p_retryable and o.attempt_count < 8 and o.expires_at > v_now + interval '1 minute' then
    v_state := 'pending';
    update public.behavioral_lifecycle_outbox
    set status = v_state,
        next_attempt_at = least(
          o.expires_at - interval '1 minute',
          v_now + make_interval(secs => least(21600, 30 * power(2, least(o.attempt_count, 10))::integer))
        ),
        failure_count = greatest(coalesce(p_failed, 0), 0),
        dead_token_count = greatest(coalesce(p_dead, 0), 0),
        last_error_family = v_error,
        transport_started_at = null,
        lease_token = null, lease_expires_at = null, updated_at = v_now
    where id = o.id and status = 'processing' and lease_token = p_lease_token;
  else
    v_state := 'dead_letter';
    update public.behavioral_lifecycle_outbox
    set status = v_state, dead_lettered_at = v_now,
        failure_count = greatest(coalesce(p_failed, 0), 0),
        dead_token_count = greatest(coalesce(p_dead, 0), 0),
        last_error_family = v_error,
        lease_token = null, lease_expires_at = null, updated_at = v_now
    where id = o.id and status = 'processing' and lease_token = p_lease_token;
  end if;
  return v_state;
end;
$function$;

revoke all on function public.norva_complete_behavioral_push(uuid, uuid, integer, integer, integer, boolean, text)
from public, anon, authenticated;
grant execute on function public.norva_complete_behavioral_push(uuid, uuid, integer, integer, integer, boolean, text)
to service_role;

create or replace function public.norva_enqueue_behavioral_email(
  p_delivery_id uuid,
  p_lease_token uuid,
  p_recipient_email text,
  p_request_from text,
  p_request_reply_to text,
  p_request_subject text,
  p_request_html text,
  p_request_text text,
  p_request_tags jsonb,
  p_request_headers jsonb default '{}'::jsonb
) returns jsonb
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
  o record;
  j record;
  s record;
  v_auth_email text;
  v_flow text;
  v_queued jsonb;
  v_now timestamptz := clock_timestamp();
  v_quiet_allowed timestamptz;
  v_frequency_allowed timestamptz;
begin
  if v_role is distinct from 'service_role' then
    raise exception 'service_role required' using errcode = '42501';
  end if;
  select * into o
  from public.behavioral_lifecycle_outbox x
  where x.id = p_delivery_id and x.channel = 'email'
    and x.status = 'processing' and x.lease_token = p_lease_token
  for update;
  if not found then
    return jsonb_build_object('queued', false, 'reason', 'claim_missing');
  end if;
  if not public.norva_behavioral_delivery_eligible(o.id, v_now) then
    update public.behavioral_lifecycle_outbox
    set status = 'canceled', canceled_at = v_now,
        last_error_family = case when o.expires_at <= v_now
          then 'ttl_expired' else 'eligibility_revoked' end,
        lease_token = null, lease_expires_at = null, updated_at = v_now
    where id = o.id and status = 'processing' and lease_token = p_lease_token;
    return jsonb_build_object('queued', false, 'reason', 'eligibility_revoked');
  end if;

  -- Rendering happens outside PostgreSQL. Serialize the final enqueue per
  -- account and repeat both policy gates here so concurrent workers cannot
  -- reserve more emails than the weekly cap allows.
  select * into j
  from public.behavioral_lifecycle_journeys x
  where x.journey_key = o.journey_key;
  select * into s
  from public.behavioral_lifecycle_user_state x
  where x.user_id = o.user_id
  for update;
  v_quiet_allowed := public.norva_behavioral_next_allowed_at(
    v_now, s.timezone, j.quiet_start_hour, j.quiet_end_hour
  );
  v_frequency_allowed := public.norva_behavioral_frequency_allowed_at(
    o.user_id, 'email', o.journey_key, v_now
  );
  if greatest(v_quiet_allowed, v_frequency_allowed) > v_now + interval '1 second' then
    update public.behavioral_lifecycle_outbox
    set status = 'pending',
        next_attempt_at = greatest(v_quiet_allowed, v_frequency_allowed),
        last_error_family = case when v_quiet_allowed >= v_frequency_allowed
          then 'quiet_hours' else 'frequency_capped' end,
        lease_token = null, lease_expires_at = null, updated_at = v_now
    where id = o.id and status = 'processing' and lease_token = p_lease_token;
    return jsonb_build_object('queued', false, 'reason', 'deferred');
  end if;

  select lower(btrim(u.email)) into v_auth_email
  from auth.users u where u.id = o.user_id;
  if v_auth_email is null or lower(btrim(coalesce(p_recipient_email, ''))) <> v_auth_email then
    raise exception 'behavioral email recipient mismatch' using errcode = '22023';
  end if;
  v_flow := left('behavioral_' || o.journey_key, 50);
  v_queued := public.norva_enqueue_lifecycle_email(
    o.user_id,
    v_flow,
    'behavioral:' || o.id::text,
    v_auth_email,
    p_request_from,
    p_request_reply_to,
    p_request_subject,
    p_request_html,
    p_request_text,
    p_request_tags,
    coalesce(p_request_headers, '{}'::jsonb),
    o.is_marketing,
    null,
    null,
    null
  );

  update public.behavioral_lifecycle_outbox
  set status = 'email_queued', email_outbox_id = (v_queued ->> 'id')::uuid,
      lease_token = null, lease_expires_at = null, updated_at = clock_timestamp()
  where id = p_delivery_id and channel = 'email'
    and status = 'processing' and lease_token = p_lease_token;
  if not found then
    raise exception 'behavioral email lease lost' using errcode = 'PT409';
  end if;
  return v_queued || jsonb_build_object('queued', true, 'linked', true);
end;
$function$;

revoke all on function public.norva_enqueue_behavioral_email(
  uuid, uuid, text, text, text, text, text, text, jsonb, jsonb
)
from public, anon, authenticated;
grant execute on function public.norva_enqueue_behavioral_email(
  uuid, uuid, text, text, text, text, text, text, jsonb, jsonb
)
to service_role;

create or replace function public.norva_fail_behavioral_email_enqueue(
  p_delivery_id uuid,
  p_lease_token uuid,
  p_error_family text default 'transport_error'
) returns text
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
  o record;
  v_now timestamptz := clock_timestamp();
  v_state text;
begin
  if v_role is distinct from 'service_role' then
    raise exception 'service_role required' using errcode = '42501';
  end if;
  select * into o from public.behavioral_lifecycle_outbox x
  where x.id = p_delivery_id and x.status = 'processing' and x.lease_token = p_lease_token
  for update;
  if not found then return 'claim_missing'; end if;
  v_state := case when o.attempt_count >= 8 or o.expires_at <= v_now + interval '1 minute'
    then 'dead_letter' else 'pending' end;
  update public.behavioral_lifecycle_outbox
  set status = v_state,
      dead_lettered_at = case when v_state = 'dead_letter' then v_now else null end,
      next_attempt_at = case when v_state = 'pending'
        then least(o.expires_at - interval '1 minute', v_now + interval '5 minutes')
        else o.next_attempt_at end,
      last_error_family = case when p_error_family in ('transport_error', 'recipient_unavailable')
        then p_error_family else 'unknown' end,
      lease_token = null, lease_expires_at = null, updated_at = v_now
  where id = o.id and status = 'processing' and lease_token = p_lease_token;
  return v_state;
end;
$function$;

revoke all on function public.norva_fail_behavioral_email_enqueue(uuid, uuid, text)
from public, anon, authenticated;
grant execute on function public.norva_fail_behavioral_email_enqueue(uuid, uuid, text)
to service_role;

create or replace function public.norva_authorize_behavioral_email_enqueue(
  p_delivery_id uuid,
  p_lease_token uuid
) returns jsonb
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
  o record;
  j record;
  s record;
  v_email text;
  v_now timestamptz := clock_timestamp();
  v_quiet_allowed timestamptz;
  v_frequency_allowed timestamptz;
begin
  if v_role is distinct from 'service_role' then
    raise exception 'service_role required' using errcode = '42501';
  end if;
  select * into o from public.behavioral_lifecycle_outbox x
  where x.id = p_delivery_id and x.channel = 'email'
    and x.status = 'processing' and x.lease_token = p_lease_token
  for update;
  if not found then return jsonb_build_object('authorized', false, 'reason', 'claim_missing'); end if;
  select * into j from public.behavioral_lifecycle_journeys x where x.journey_key = o.journey_key;
  select * into s from public.behavioral_lifecycle_user_state x where x.user_id = o.user_id for update;

  if not public.norva_behavioral_delivery_eligible(o.id, v_now) then
    update public.behavioral_lifecycle_outbox
    set status = 'canceled', canceled_at = v_now,
        last_error_family = case when o.expires_at <= v_now
          then 'ttl_expired' else 'eligibility_revoked' end,
        lease_token = null, lease_expires_at = null, updated_at = v_now
    where id = o.id and status = 'processing' and lease_token = p_lease_token;
    return jsonb_build_object('authorized', false, 'reason', 'eligibility_revoked');
  end if;

  v_quiet_allowed := public.norva_behavioral_next_allowed_at(
    v_now, s.timezone, j.quiet_start_hour, j.quiet_end_hour
  );
  v_frequency_allowed := public.norva_behavioral_frequency_allowed_at(
    o.user_id, 'email', o.journey_key, v_now
  );
  if greatest(v_quiet_allowed, v_frequency_allowed) > v_now + interval '1 second' then
    update public.behavioral_lifecycle_outbox
    set status = 'pending',
        next_attempt_at = greatest(v_quiet_allowed, v_frequency_allowed),
        last_error_family = case when v_quiet_allowed >= v_frequency_allowed
          then 'quiet_hours' else 'frequency_capped' end,
        lease_token = null, lease_expires_at = null, updated_at = v_now
    where id = o.id and status = 'processing' and lease_token = p_lease_token;
    return jsonb_build_object('authorized', false, 'reason', 'deferred');
  end if;

  select lower(btrim(u.email)) into v_email from auth.users u where u.id = o.user_id;
  if v_email is null or v_email !~ '^[^@[:space:]<>]+@[^@[:space:]<>]+$' then
    update public.behavioral_lifecycle_outbox
    set status = 'suppressed', last_error_family = 'recipient_unavailable',
        lease_token = null, lease_expires_at = null, updated_at = v_now
    where id = o.id and status = 'processing' and lease_token = p_lease_token;
    return jsonb_build_object('authorized', false, 'reason', 'recipient_unavailable');
  end if;

  return jsonb_strip_nulls(jsonb_build_object(
    'authorized', true,
    'delivery_id', o.id,
    'user_id', o.user_id,
    'email', v_email,
    'title', o.title,
    'body', o.body,
    'cta_label', o.cta_label,
    'deep_link', o.deep_link,
    'is_marketing', o.is_marketing,
    'failure_family', case when o.journey_key = 'import_unresolved'
      then s.last_failure_family else null end,
    'source_type', case when o.journey_key = 'import_unresolved'
      then s.last_source_type else null end
  ));
end;
$function$;

revoke all on function public.norva_authorize_behavioral_email_enqueue(uuid, uuid)
from public, anon, authenticated;
grant execute on function public.norva_authorize_behavioral_email_enqueue(uuid, uuid)
to service_role;

-- Preserve the mature branded-email authorization rules and add a wrapper for
-- the linked behavioral rows. Existing billing/security flows remain untouched.
alter function public.authorize_branded_email_delivery(uuid, text, uuid)
  rename to authorize_branded_email_delivery_pre_behavioral;

revoke all on function public.authorize_branded_email_delivery_pre_behavioral(uuid, text, uuid)
from public, anon, authenticated;
grant execute on function public.authorize_branded_email_delivery_pre_behavioral(uuid, text, uuid)
to service_role;

create function public.authorize_branded_email_delivery(
  p_id uuid,
  p_delivery_key text,
  p_lease_token uuid
) returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  e record;
  o record;
  j record;
  s record;
  v_now timestamptz := clock_timestamp();
  v_allowed_at timestamptz;
begin
  select * into o
  from public.behavioral_lifecycle_outbox x
  where x.email_outbox_id = p_id;
  if not found then
    return public.authorize_branded_email_delivery_pre_behavioral(
      p_id, p_delivery_key, p_lease_token
    );
  end if;

  select * into e from public.cloud_branded_email_outbox x
  where x.id = p_id and x.delivery_key = p_delivery_key
    and x.state = 'processing' and x.lease_token = p_lease_token
  for update;
  if not found then return false; end if;
  select * into j from public.behavioral_lifecycle_journeys x where x.journey_key = o.journey_key;
  select * into s from public.behavioral_lifecycle_user_state x where x.user_id = o.user_id for update;

  if o.status <> 'email_queued'
     or not public.norva_behavioral_delivery_eligible(o.id, v_now) then
    update public.cloud_branded_email_outbox x
    set state = 'canceled', last_error = 'behavioral_eligibility_revoked_before_send',
        lease_token = null, lease_expires_at = null,
        recipient_email = null, request_reply_to = null, request_subject = null,
        request_html = null, request_text = null, request_headers = '{}'::jsonb,
        payload_scrubbed_at = v_now, updated_at = v_now
    where x.id = p_id and x.state = 'processing' and x.lease_token = p_lease_token;
    update public.behavioral_lifecycle_outbox x
    set status = 'canceled', canceled_at = v_now,
        last_error_family = 'eligibility_revoked', updated_at = v_now
    where x.id = o.id and x.status = 'email_queued';
    return false;
  end if;

  v_allowed_at := greatest(
    public.norva_behavioral_next_allowed_at(
      v_now, s.timezone, j.quiet_start_hour, j.quiet_end_hour
    ),
    public.norva_behavioral_frequency_allowed_at(
      o.user_id, 'email', o.journey_key, v_now, o.id
    )
  );
  if v_allowed_at > v_now + interval '1 second' then
    update public.cloud_branded_email_outbox x
    set state = 'pending', attempt_count = greatest(0, x.attempt_count - 1),
        next_attempt_at = v_allowed_at,
        transport_started_at = null,
        last_error = 'behavioral_quiet_hours_or_frequency_cap',
        lease_token = null, lease_expires_at = null, updated_at = v_now
    where x.id = p_id and x.state = 'processing' and x.lease_token = p_lease_token;
    return false;
  end if;

  update public.cloud_branded_email_outbox x
  set transport_started_at = coalesce(x.transport_started_at, v_now), updated_at = v_now
  where x.id = p_id and x.state = 'processing' and x.lease_token = p_lease_token;
  if found then
    update public.behavioral_lifecycle_outbox x
    set transport_started_at = coalesce(x.transport_started_at, v_now), updated_at = v_now
    where x.id = o.id and x.status = 'email_queued';
  end if;
  return found;
end;
$function$;

revoke all on function public.authorize_branded_email_delivery(uuid, text, uuid)
from public, anon, authenticated;
grant execute on function public.authorize_branded_email_delivery(uuid, text, uuid)
to service_role;

create or replace function public.norva_sync_behavioral_email_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
begin
  if new.state is not distinct from old.state then return new; end if;
  if new.state = 'sent' then
    update public.behavioral_lifecycle_outbox o
    set status = 'provider_accepted', provider_accepted_at = coalesce(new.sent_at, v_now),
        accepted_count = 1, last_error_family = null, updated_at = v_now
    where o.email_outbox_id = new.id and o.status = 'email_queued';
  elsif new.state = 'canceled' then
    update public.behavioral_lifecycle_outbox o
    set status = 'canceled', canceled_at = v_now,
        last_error_family = 'eligibility_revoked', updated_at = v_now
    where o.email_outbox_id = new.id and o.status = 'email_queued';
  elsif new.state = 'dead_letter' then
    update public.behavioral_lifecycle_outbox o
    set status = 'dead_letter', dead_lettered_at = coalesce(new.dead_lettered_at, v_now),
        last_error_family = 'transport_error', updated_at = v_now
    where o.email_outbox_id = new.id and o.status = 'email_queued';
  elsif new.state = 'pending' then
    update public.behavioral_lifecycle_outbox o
    set transport_started_at = null, updated_at = v_now
    where o.email_outbox_id = new.id and o.status = 'email_queued'
      and o.provider_accepted_at is null;
  end if;
  return new;
end;
$function$;

revoke all on function public.norva_sync_behavioral_email_state()
from public, anon, authenticated;

drop trigger if exists norva_sync_behavioral_email_state_change
on public.cloud_branded_email_outbox;
create trigger norva_sync_behavioral_email_state_change
after update of state on public.cloud_branded_email_outbox
for each row execute function public.norva_sync_behavioral_email_state();

create unique index if not exists behavioral_lifecycle_event_once_idx
  on public.behavioral_lifecycle_delivery_events (delivery_id, event_kind)
  where event_kind in ('delivered', 'opened', 'deep_link_opened');

create or replace function public.norva_record_behavioral_delivery_event(
  p_user_id uuid,
  p_delivery_id uuid,
  p_event_kind text
) returns boolean
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
  v_kind text := lower(btrim(coalesce(p_event_kind, '')));
  v_now timestamptz := clock_timestamp();
  v_journey_key text;
begin
  if v_role is distinct from 'service_role' then
    raise exception 'service_role required' using errcode = '42501';
  end if;
  if v_kind not in ('delivered', 'opened', 'deep_link_opened') then
    raise exception 'invalid lifecycle event' using errcode = '22023';
  end if;
  if v_kind = 'delivered' then
    update public.behavioral_lifecycle_outbox
    set status = case when status = 'provider_accepted' then 'delivered' else status end,
        delivered_at = coalesce(delivered_at, v_now), updated_at = v_now
    where id = p_delivery_id and user_id = p_user_id
      and status in ('processing', 'provider_accepted', 'delivered', 'opened');
  else
    update public.behavioral_lifecycle_outbox
    set status = case when status in ('provider_accepted', 'delivered') then 'opened' else status end,
        delivered_at = coalesce(delivered_at, v_now),
        opened_at = coalesce(opened_at, v_now), updated_at = v_now
    where id = p_delivery_id and user_id = p_user_id
      and status in ('processing', 'provider_accepted', 'delivered', 'opened');
  end if;
  if not found then return false; end if;

  -- A device can acknowledge a data-only message before the FCM response has
  -- completed in the worker. Persist the receipt independently while leaving a
  -- leased `processing` row claimable; completion folds the receipt into the
  -- final delivered/opened state. Replays and concurrent receipts are harmless.
  insert into public.behavioral_lifecycle_delivery_events (
    delivery_id, event_kind, occurred_at
  ) values (p_delivery_id, v_kind, v_now)
  on conflict do nothing;
  if v_kind = 'deep_link_opened' then
    select o.journey_key into v_journey_key
    from public.behavioral_lifecycle_outbox o
    where o.id = p_delivery_id and o.user_id = p_user_id;
    perform public.norva_insert_behavioral_funnel_event(
      p_delivery_id::text || ':deep_link_opened', p_user_id,
      'deep_link_opened', v_journey_key, p_delivery_id, v_now
    );
  end if;
  return true;
end;
$function$;

revoke all on function public.norva_record_behavioral_delivery_event(uuid, uuid, text)
from public, anon, authenticated;
grant execute on function public.norva_record_behavioral_delivery_event(uuid, uuid, text)
to service_role;

-- A registered token is not proof of Android notification permission. Manual
-- marketing and lifecycle audiences use only recently seen, permission-granted
-- tokens; the full registered inventory remains visible as a separate KPI.
create or replace function public.marketing_push_targets(p_audience text)
returns setof uuid
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if p_audience = 'trialing' then
    return query
      select distinct t.user_id from public.cloud_push_tokens t
      join public.cloud_entitlement_projection p on p.user_id = t.user_id
      where t.permission_state = 'granted'
        and t.last_seen_at >= clock_timestamp() - interval '45 days'
        and p.status = 'trialing'
        and not exists (select 1 from public.admin_internal_accounts a where a.user_id = t.user_id);
  elsif p_audience = 'paying' then
    return query
      select distinct t.user_id from public.cloud_push_tokens t
      join public.cloud_entitlement_projection p on p.user_id = t.user_id
      where t.permission_state = 'granted'
        and t.last_seen_at >= clock_timestamp() - interval '45 days'
        and p.status in ('active','grace','past_due','cancelled_at_period_end')
        and p.provider <> 'system'
        and not exists (select 1 from public.admin_internal_accounts a where a.user_id = t.user_id);
  elsif p_audience = 'monthly' then
    return query
      select distinct t.user_id from public.cloud_push_tokens t
      join public.cloud_entitlement_projection p on p.user_id = t.user_id
      left join public.cloud_revolut_customers rc on rc.user_id = p.user_id
      where t.permission_state = 'granted'
        and t.last_seen_at >= clock_timestamp() - interval '45 days'
        and p.status in ('active','grace','past_due','cancelled_at_period_end')
        and p.provider <> 'system'
        and coalesce(rc.period, p.bill_period) = 'monthly'
        and not exists (select 1 from public.admin_internal_accounts a where a.user_id = t.user_id);
  elsif p_audience = 'free' then
    return query
      select distinct t.user_id from public.cloud_push_tokens t
      where t.permission_state = 'granted'
        and t.last_seen_at >= clock_timestamp() - interval '45 days'
        and not exists (select 1 from public.admin_internal_accounts a where a.user_id = t.user_id)
        and not exists (
          select 1 from public.cloud_entitlement_projection p
          where p.user_id = t.user_id
            and (
              p.status = 'trialing'
              or (p.status in ('active','grace','past_due','cancelled_at_period_end')
                  and p.provider <> 'system')
            )
        );
  else
    return query
      select distinct t.user_id from public.cloud_push_tokens t
      where t.permission_state = 'granted'
        and t.last_seen_at >= clock_timestamp() - interval '45 days'
        and not exists (select 1 from public.admin_internal_accounts a where a.user_id = t.user_id);
  end if;
end;
$function$;

revoke all on function public.marketing_push_targets(text)
from public, anon, authenticated;
grant execute on function public.marketing_push_targets(text) to service_role;

create or replace function public.admin_marketing_audience_counts()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'all', (
      select count(*) from public.cloud_push_tokens t
      where t.permission_state = 'granted'
        and t.last_seen_at >= clock_timestamp() - interval '45 days'
        and t.user_id in (select public.marketing_push_targets('all'))
    ),
    'trialing', (
      select count(*) from public.cloud_push_tokens t
      where t.permission_state = 'granted'
        and t.last_seen_at >= clock_timestamp() - interval '45 days'
        and t.user_id in (select public.marketing_push_targets('trialing'))
    ),
    'paying', (
      select count(*) from public.cloud_push_tokens t
      where t.permission_state = 'granted'
        and t.last_seen_at >= clock_timestamp() - interval '45 days'
        and t.user_id in (select public.marketing_push_targets('paying'))
    ),
    'monthly', (
      select count(*) from public.cloud_push_tokens t
      where t.permission_state = 'granted'
        and t.last_seen_at >= clock_timestamp() - interval '45 days'
        and t.user_id in (select public.marketing_push_targets('monthly'))
    ),
    'free', (
      select count(*) from public.cloud_push_tokens t
      where t.permission_state = 'granted'
        and t.last_seen_at >= clock_timestamp() - interval '45 days'
        and t.user_id in (select public.marketing_push_targets('free'))
    ),
    'registered_tokens', (select count(*) from public.cloud_push_tokens),
    'registered_accounts', (select count(distinct user_id) from public.cloud_push_tokens),
    'permission_granted_tokens', (
      select count(*) from public.cloud_push_tokens where permission_state = 'granted'
    ),
    'permission_unknown_tokens', (
      select count(*) from public.cloud_push_tokens where permission_state = 'unknown'
    ),
    'permission_denied_tokens', (
      select count(*) from public.cloud_push_tokens where permission_state = 'denied'
    )
  );
end;
$function$;

revoke all on function public.admin_marketing_audience_counts()
from public, anon, authenticated;
grant execute on function public.admin_marketing_audience_counts()
to authenticated, service_role;

create or replace function public.admin_marketing_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'push_devices', (
      select count(*) from public.cloud_push_tokens t
      where t.permission_state = 'granted'
        and t.last_seen_at >= clock_timestamp() - interval '45 days'
        and t.user_id in (select public.marketing_push_targets('all'))
    ),
    'push_users', (
      select count(distinct t.user_id) from public.cloud_push_tokens t
      where t.permission_state = 'granted'
        and t.last_seen_at >= clock_timestamp() - interval '45 days'
        and t.user_id in (select public.marketing_push_targets('all'))
    ),
    'push_registered_devices', (select count(*) from public.cloud_push_tokens),
    'push_registered_users', (select count(distinct user_id) from public.cloud_push_tokens),
    'push_permission_granted_devices', (
      select count(*) from public.cloud_push_tokens where permission_state = 'granted'
    ),
    'notifs_30d', (
      select count(*) from public.marketing_push_log
      where created_at > clock_timestamp() - interval '30 days'
    ),
    'last_notif_at', (select max(created_at) from public.marketing_push_log)
  );
end;
$function$;

revoke all on function public.admin_marketing_overview()
from public, anon, authenticated;
grant execute on function public.admin_marketing_overview()
to authenticated, service_role;

create or replace function public.admin_record_behavioral_import_readiness(
  p_release_label text,
  p_source_commit text,
  p_android_version text,
  p_evidence_sha256 text,
  p_m3u_valid boolean,
  p_xtream_valid boolean,
  p_large_catalog_valid boolean,
  p_error_guidance_valid boolean,
  p_android_webview_valid boolean,
  p_confirmation text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_release_label text := btrim(coalesce(p_release_label, ''));
  v_source_commit text := lower(btrim(coalesce(p_source_commit, '')));
  v_android_version text := btrim(coalesce(p_android_version, ''));
  v_evidence_sha256 text := lower(btrim(coalesce(p_evidence_sha256, '')));
  v_passed boolean := coalesce(p_m3u_valid, false)
    and coalesce(p_xtream_valid, false)
    and coalesce(p_large_catalog_valid, false)
    and coalesce(p_error_guidance_valid, false)
    and coalesce(p_android_webview_valid, false);
  v_status text;
  v_expected text;
  v_now timestamptz := clock_timestamp();
  v_before jsonb := '{}'::jsonb;
  v_after jsonb;
  v_row public.behavioral_lifecycle_import_readiness%rowtype;
  v_inserted boolean := false;
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if char_length(v_release_label) not between 1 and 80
     or v_release_label !~ '^[A-Za-z0-9][A-Za-z0-9._+-]*$'
     or v_source_commit !~ '^[0-9a-f]{40}$'
     or char_length(v_android_version) not between 1 and 40
     or v_android_version !~ '^[A-Za-z0-9][A-Za-z0-9._+-]*$'
     or v_evidence_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid import readiness coordinates' using errcode = '22023';
  end if;

  v_status := case when v_passed then 'passed' else 'failed' end;
  v_expected := case
    when v_passed then 'VERIFY IMPORT READINESS'
    else 'RECORD IMPORT FAILURE'
  end;
  if p_confirmation is distinct from v_expected then
    raise exception 'typed import readiness confirmation required' using errcode = '22023';
  end if;

  select jsonb_build_object(
    'release_label', r.release_label,
    'source_commit', r.source_commit,
    'android_version', r.android_version,
    'evidence_sha256', r.evidence_sha256,
    'status', r.status,
    'checked_at', r.checked_at,
    'expires_at', r.expires_at
  ) into v_before
  from public.behavioral_lifecycle_import_readiness r
  order by r.checked_at desc, r.id desc
  limit 1;
  v_before := coalesce(v_before, '{}'::jsonb);

  insert into public.behavioral_lifecycle_import_readiness (
    release_label, source_commit, android_version, evidence_sha256,
    m3u_valid, xtream_valid, large_catalog_valid,
    error_guidance_valid, android_webview_valid, status,
    checked_by, checked_at, expires_at
  ) values (
    v_release_label, v_source_commit, v_android_version, v_evidence_sha256,
    coalesce(p_m3u_valid, false), coalesce(p_xtream_valid, false),
    coalesce(p_large_catalog_valid, false),
    coalesce(p_error_guidance_valid, false),
    coalesce(p_android_webview_valid, false), v_status,
    auth.uid(), v_now, v_now + interval '14 days'
  )
  on conflict (evidence_sha256) do nothing
  returning * into v_row;
  v_inserted := found;

  if not v_inserted then
    select * into strict v_row
    from public.behavioral_lifecycle_import_readiness r
    where r.evidence_sha256 = v_evidence_sha256;
    if v_row.release_label is distinct from v_release_label
       or v_row.source_commit is distinct from v_source_commit
       or v_row.android_version is distinct from v_android_version
       or v_row.m3u_valid is distinct from coalesce(p_m3u_valid, false)
       or v_row.xtream_valid is distinct from coalesce(p_xtream_valid, false)
       or v_row.large_catalog_valid is distinct from coalesce(p_large_catalog_valid, false)
       or v_row.error_guidance_valid is distinct from coalesce(p_error_guidance_valid, false)
       or v_row.android_webview_valid is distinct from coalesce(p_android_webview_valid, false)
       or v_row.status is distinct from v_status then
      raise exception 'import readiness evidence digest already belongs to different coordinates'
        using errcode = '23505';
    end if;
  end if;

  v_after := jsonb_build_object(
    'id', v_row.id,
    'release_label', v_row.release_label,
    'source_commit', v_row.source_commit,
    'android_version', v_row.android_version,
    'evidence_sha256', v_row.evidence_sha256,
    'status', v_row.status,
    'checked_at', v_row.checked_at,
    'expires_at', v_row.expires_at,
    'checks', jsonb_build_object(
      'm3u_valid', v_row.m3u_valid,
      'xtream_valid', v_row.xtream_valid,
      'large_catalog_valid', v_row.large_catalog_valid,
      'error_guidance_valid', v_row.error_guidance_valid,
      'android_webview_valid', v_row.android_webview_valid
    )
  );

  if v_inserted then
    insert into public.behavioral_lifecycle_admin_audit (
      action, actor_id, reason, before_state, after_state, created_at
    ) values (
      'import_readiness_recorded', auth.uid(),
      'Import readiness ' || v_status || ' for release ' || v_release_label || '.',
      v_before, v_after, v_now
    );
  end if;

  return v_after;
end;
$function$;

revoke all on function public.admin_record_behavioral_import_readiness(
  text, text, text, text, boolean, boolean, boolean, boolean, boolean, text
) from public, anon, authenticated;
grant execute on function public.admin_record_behavioral_import_readiness(
  text, text, text, text, boolean, boolean, boolean, boolean, boolean, text
) to authenticated, service_role;

create or replace function public.admin_update_behavioral_lifecycle_runtime(
  p_emergency_stop boolean,
  p_audience_mode text,
  p_confirmation text,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_current record;
  v_mode text := lower(btrim(coalesce(p_audience_mode, '')));
  v_reason text := btrim(coalesce(p_reason, ''));
  v_expected text;
  v_action text;
  v_now timestamptz := clock_timestamp();
  v_before jsonb;
  v_after jsonb;
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if v_mode not in ('internal_test', 'pilot')
     or char_length(v_reason) not between 8 and 500 then
    raise exception 'invalid lifecycle runtime configuration' using errcode = '22023';
  end if;
  v_expected := case
    when coalesce(p_emergency_stop, true) then 'EMERGENCY STOP'
    when v_mode = 'internal_test' then 'START INTERNAL TEST'
    else 'START PILOT'
  end;
  if p_confirmation is distinct from v_expected then
    raise exception 'typed runtime confirmation required' using errcode = '22023';
  end if;

  if not coalesce(p_emergency_stop, true) and v_mode = 'pilot'
     and not coalesce((
       select r.status = 'passed' and r.expires_at > v_now
       from public.behavioral_lifecycle_import_readiness r
       order by r.checked_at desc, r.id desc
       limit 1
     ), false) then
    raise exception 'fresh passing import readiness evidence required before pilot'
      using errcode = '55000';
  end if;

  select * into v_current
  from public.behavioral_lifecycle_runtime r
  where r.singleton
  for update;
  if not found then raise exception 'lifecycle runtime missing' using errcode = 'P0002'; end if;
  v_before := jsonb_build_object(
    'emergency_stop', v_current.emergency_stop,
    'audience_mode', v_current.audience_mode,
    'reason', v_current.reason,
    'updated_at', v_current.updated_at
  );

  if coalesce(p_emergency_stop, true)
     or v_current.audience_mode is distinct from v_mode
     or v_current.emergency_stop then
    update public.cloud_branded_email_outbox e
    set state = 'canceled',
        last_error = 'behavioral_runtime_changed_before_send',
        lease_token = null, lease_expires_at = null,
        recipient_email = null, request_reply_to = null,
        request_subject = null, request_html = null, request_text = null,
        request_headers = '{}'::jsonb,
        payload_scrubbed_at = v_now, updated_at = v_now
    where e.id in (
      select o.email_outbox_id
      from public.behavioral_lifecycle_outbox o
      where o.status = 'email_queued' and o.email_outbox_id is not null
    ) and (
      e.state = 'pending'
      or (e.state = 'processing' and e.transport_started_at is null)
    );

    update public.behavioral_lifecycle_outbox
    set status = 'canceled', canceled_at = v_now,
        last_error_family = 'configuration_changed',
        lease_token = null, lease_expires_at = null, updated_at = v_now
    where status in ('pending', 'processing', 'email_queued')
      and transport_started_at is null;
  end if;

  -- Starting or switching an audience always creates a fresh cohort boundary.
  -- Users who became eligible while stopped can never be blasted retroactively.
  if not coalesce(p_emergency_stop, true)
     and (v_current.emergency_stop or v_current.audience_mode is distinct from v_mode) then
    update public.behavioral_lifecycle_journeys
    set version = version + 1,
        activated_at = case when status = 'active' then v_now else activated_at end,
        activated_by = case when status = 'active' then auth.uid() else activated_by end,
        updated_at = v_now
    where status = 'active';
  end if;

  update public.behavioral_lifecycle_runtime
  set emergency_stop = coalesce(p_emergency_stop, true),
      audience_mode = v_mode,
      reason = v_reason,
      updated_by = auth.uid(),
      updated_at = v_now
  where singleton;

  v_action := case
    when coalesce(p_emergency_stop, true) then 'runtime_stopped'
    when v_mode = 'internal_test' then 'runtime_started_internal_test'
    else 'runtime_started_pilot'
  end;
  v_after := jsonb_build_object(
    'emergency_stop', coalesce(p_emergency_stop, true),
    'audience_mode', v_mode,
    'reason', v_reason,
    'updated_at', v_now
  );
  insert into public.behavioral_lifecycle_admin_audit (
    action, actor_id, reason, before_state, after_state, created_at
  ) values (v_action, auth.uid(), v_reason, v_before, v_after, v_now);

  return v_after;
end;
$function$;

revoke all on function public.admin_update_behavioral_lifecycle_runtime(
  boolean, text, text, text
) from public, anon, authenticated;
grant execute on function public.admin_update_behavioral_lifecycle_runtime(
  boolean, text, text, text
) to authenticated, service_role;

create or replace function public.norva_behavioral_step_experiment_snapshot(
  p_journey_key text
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_snapshot jsonb;
begin
  if p_journey_key not in (
       'no_source', 'import_unresolved',
       'catalog_ready_no_first_play', 'continue_watching'
     ) then
    raise exception 'invalid behavioral experiment snapshot request' using errcode = '22023';
  end if;

  select jsonb_build_object(
    'delay', coalesce(jsonb_agg(jsonb_build_object(
      'step_key', st.step_key,
      'delay_minutes', st.delay_minutes
    ) order by st.step_key), '[]'::jsonb),
    'channel', coalesce(jsonb_agg(jsonb_build_object(
      'step_key', st.step_key,
      'channel', st.channel
    ) order by st.step_key), '[]'::jsonb),
    'copy', coalesce(jsonb_agg(jsonb_build_object(
      'step_key', st.step_key,
      'title', st.title,
      'body', st.body
    ) order by st.step_key), '[]'::jsonb),
    'cta', coalesce(jsonb_agg(jsonb_build_object(
      'step_key', st.step_key,
      'cta_label', st.cta_label,
      'deep_link', st.deep_link
    ) order by st.step_key), '[]'::jsonb),
    'structure', coalesce(jsonb_agg(jsonb_build_object(
      'step_key', st.step_key,
      'ordinal', st.ordinal,
      'ttl_seconds', st.ttl_seconds,
      'collapse_key', st.collapse_key,
      'is_marketing', st.is_marketing,
      'requires_new_content', st.requires_new_content,
      'enabled', st.enabled
    ) order by st.step_key), '[]'::jsonb)
  ) into v_snapshot
  from public.behavioral_lifecycle_steps st
  where st.journey_key = p_journey_key;

  if jsonb_array_length(v_snapshot->'structure') = 0 then
    raise exception 'behavioral journey has no experiment steps' using errcode = '22023';
  end if;
  return v_snapshot;
end;
$function$;

revoke all on function public.norva_behavioral_step_experiment_snapshot(text)
from public, anon, authenticated;
grant execute on function public.norva_behavioral_step_experiment_snapshot(text)
to service_role;

create or replace function public.norva_behavioral_experiment_window(
  p_journey_key text,
  p_config_version integer,
  p_window_hours integer,
  p_start timestamptz,
  p_as_of timestamptz default clock_timestamp()
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_result jsonb;
begin
  if p_journey_key not in (
       'no_source', 'import_unresolved',
       'catalog_ready_no_first_play', 'continue_watching'
     )
     or p_config_version is null or p_config_version < 1
     or p_window_hours not in (24, 72, 168)
     or p_start is null or p_as_of is null or p_start >= p_as_of then
    raise exception 'invalid behavioral experiment window' using errcode = '22023';
  end if;

  with cohort as (
    select o.user_id, o.experiment_arm, min(o.triggered_at) as assigned_at
    from public.behavioral_lifecycle_outbox o
    where o.journey_key = p_journey_key
      and o.config_version = p_config_version
      and o.experiment_arm in ('treatment', 'holdout')
      and o.triggered_at >= p_start
      and o.triggered_at <= p_as_of - make_interval(hours => p_window_hours)
      and not exists (
        select 1 from public.admin_internal_accounts a where a.user_id = o.user_id
      )
    group by o.user_id, o.experiment_arm
  ), measured as (
    select c.*,
      exists (
        select 1
        from public.behavioral_lifecycle_funnel_events f
        join public.behavioral_lifecycle_journeys j
          on j.journey_key = p_journey_key
        where f.user_id = c.user_id
          and f.journey_key = p_journey_key
          and f.event_name = j.exit_event
          and f.occurred_at >= c.assigned_at
          and f.occurred_at <= c.assigned_at
            + make_interval(hours => p_window_hours)
      ) as converted,
      exists (
        select 1
        from public.behavioral_lifecycle_funnel_events f
        where f.user_id = c.user_id
          and f.journey_key = p_journey_key
          and f.event_name = 'email_unsubscribed'
          and f.occurred_at >= c.assigned_at
          and f.occurred_at <= c.assigned_at
            + make_interval(hours => p_window_hours)
      ) as unsubscribed
    from cohort c
  ), counts as (
    select
      count(*) filter (where experiment_arm = 'treatment')::integer
        as treatment_users,
      count(*) filter (where experiment_arm = 'treatment' and converted)::integer
        as treatment_conversions,
      count(*) filter (where experiment_arm = 'holdout')::integer
        as holdout_users,
      count(*) filter (where experiment_arm = 'holdout' and converted)::integer
        as holdout_conversions,
      count(*) filter (where experiment_arm = 'treatment' and unsubscribed)::integer
        as treatment_unsubscribed,
      count(*) filter (where experiment_arm = 'holdout' and unsubscribed)::integer
        as holdout_unsubscribed
    from measured
  )
  select jsonb_build_object(
    'window_hours', p_window_hours,
    'status', case
      when c.treatment_users = 0 or c.holdout_users = 0 then 'insufficient_sample'
      else 'measurable'
    end,
    'treatment_users', c.treatment_users,
    'treatment_conversions', c.treatment_conversions,
    'treatment_rate_pct', round(
      100.0 * c.treatment_conversions / nullif(c.treatment_users, 0), 2
    ),
    'holdout_users', c.holdout_users,
    'holdout_conversions', c.holdout_conversions,
    'holdout_rate_pct', round(
      100.0 * c.holdout_conversions / nullif(c.holdout_users, 0), 2
    ),
    'absolute_lift_pp', round(
      100.0 * c.treatment_conversions / nullif(c.treatment_users, 0)
      - 100.0 * c.holdout_conversions / nullif(c.holdout_users, 0), 2
    ),
    'relative_uplift_pct', case
      when c.treatment_users > 0 and c.holdout_users > 0
       and c.holdout_conversions > 0 then round(
        100.0 * (
          (c.treatment_conversions::numeric / c.treatment_users)
          / (c.holdout_conversions::numeric / c.holdout_users) - 1
        ), 2
      ) else null
    end,
    'treatment_unsubscribed', c.treatment_unsubscribed,
    'holdout_unsubscribed', c.holdout_unsubscribed,
    'unsubscribe_lift_pp', round(
      100.0 * c.treatment_unsubscribed / nullif(c.treatment_users, 0)
      - 100.0 * c.holdout_unsubscribed / nullif(c.holdout_users, 0), 2
    )
  ) into v_result
  from counts c;

  return v_result;
end;
$function$;

revoke all on function public.norva_behavioral_experiment_window(
  text, integer, integer, timestamptz, timestamptz
) from public, anon, authenticated;
grant execute on function public.norva_behavioral_experiment_window(
  text, integer, integer, timestamptz, timestamptz
) to service_role;

create or replace function public.norva_behavioral_experiment_safety(
  p_journey_key text,
  p_config_version integer,
  p_start timestamptz,
  p_as_of timestamptz default clock_timestamp()
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_result jsonb;
begin
  if p_journey_key not in (
       'no_source', 'import_unresolved',
       'catalog_ready_no_first_play', 'continue_watching'
     )
     or p_config_version is null or p_config_version < 1
     or p_start is null or p_as_of is null or p_start >= p_as_of then
    raise exception 'invalid behavioral experiment safety window' using errcode = '22023';
  end if;

  with deliveries as (
    select o.*
    from public.behavioral_lifecycle_outbox o
    where o.journey_key = p_journey_key
      and o.config_version = p_config_version
      and o.experiment_arm = 'treatment'
      and o.triggered_at >= p_start
      and o.triggered_at <= p_as_of
      and not exists (
        select 1 from public.admin_internal_accounts a where a.user_id = o.user_id
      )
  ), flagged as (
    select d.*,
      exists (
        select 1
        from public.behavioral_lifecycle_funnel_events f
        join public.behavioral_lifecycle_journeys j
          on j.journey_key = p_journey_key
        where f.user_id = d.user_id
          and f.journey_key = p_journey_key
          and f.event_name = j.exit_event
          and f.occurred_at >= d.triggered_at
          and f.occurred_at <= d.transport_started_at
      ) as sent_after_conversion
    from deliveries d
  ), duplicate_keys as (
    select coalesce(sum(x.n - 1), 0)::integer as duplicate_count
    from (
      select count(*)::integer as n
      from deliveries
      group by dedupe_key
      having count(*) > 1
    ) x
  ), totals as (
    select
      count(*) filter (where transport_started_at is not null)::integer
        as transport_started,
      count(*) filter (where last_error_family = 'provider_rejected')::integer
        as provider_rejected,
      count(*) filter (
        where transport_started_at is not null and sent_after_conversion
      )::integer as sent_after_conversion
    from flagged
  )
  select jsonb_build_object(
    'duplicate_dedupe_keys', d.duplicate_count,
    'transport_started', t.transport_started,
    'provider_rejected', t.provider_rejected,
    'provider_rejection_rate_pct', round(
      100.0 * t.provider_rejected / nullif(t.transport_started, 0), 2
    ),
    'sent_after_conversion', t.sent_after_conversion,
    'cancelled_after_conversion', (
      select count(*)
      from public.behavioral_lifecycle_funnel_events f
      join deliveries x on x.id = f.delivery_id
      where f.event_name = 'message_cancelled_after_conversion'
    )
  ) into v_result
  from duplicate_keys d cross join totals t;

  return v_result;
end;
$function$;

revoke all on function public.norva_behavioral_experiment_safety(
  text, integer, timestamptz, timestamptz
) from public, anon, authenticated;
grant execute on function public.norva_behavioral_experiment_safety(
  text, integer, timestamptz, timestamptz
) to service_role;

create or replace function public.norva_behavioral_experiment_milestones(
  p_journey_key text,
  p_config_version integer,
  p_as_of timestamptz default clock_timestamp()
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_started_at timestamptz;
begin
  if p_journey_key not in (
       'no_source', 'import_unresolved',
       'catalog_ready_no_first_play', 'continue_watching'
     )
     or p_config_version is null or p_config_version < 1 or p_as_of is null then
    raise exception 'invalid behavioral experiment milestone request' using errcode = '22023';
  end if;

  select min(o.triggered_at) into v_started_at
  from public.behavioral_lifecycle_outbox o
  where o.journey_key = p_journey_key
    and o.config_version = p_config_version
    and o.experiment_arm in ('treatment', 'holdout')
    and not exists (
      select 1 from public.admin_internal_accounts a where a.user_id = o.user_id
    );

  return jsonb_build_object(
    'cohort_started_at', v_started_at,
    'day_7_due_at', v_started_at + interval '7 days',
    'day_14_due_at', v_started_at + interval '14 days',
    'day_7_status', case
      when v_started_at is null then 'not_started'
      when p_as_of >= v_started_at + interval '7 days' then 'ready'
      else 'pending'
    end,
    'day_14_status', case
      when v_started_at is null then 'not_started'
      when p_as_of >= v_started_at + interval '14 days' then 'ready'
      else 'pending'
    end
  );
end;
$function$;

revoke all on function public.norva_behavioral_experiment_milestones(
  text, integer, timestamptz
) from public, anon, authenticated;
grant execute on function public.norva_behavioral_experiment_milestones(
  text, integer, timestamptz
) to service_role;

create or replace function public.norva_behavioral_experiment_decision(
  p_journey_key text,
  p_config_version integer,
  p_as_of timestamptz default clock_timestamp()
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_plan public.behavioral_lifecycle_experiment_versions%rowtype;
  v_previous public.behavioral_lifecycle_experiment_versions%rowtype;
  v_window jsonb;
  v_safety jsonb;
  v_previous_safety jsonb;
  v_milestones jsonb;
  v_relative_uplift numeric;
  v_unsubscribe_lift numeric;
  v_provider_delta numeric;
  v_provider_status text := 'establishing_baseline';
  v_status text;
begin
  if p_journey_key not in (
       'no_source', 'import_unresolved',
       'catalog_ready_no_first_play', 'continue_watching'
     )
     or p_config_version is null or p_config_version < 1
     or p_as_of is null then
    raise exception 'invalid behavioral experiment decision request' using errcode = '22023';
  end if;

  select * into v_plan
  from public.behavioral_lifecycle_experiment_versions x
  where x.journey_key = p_journey_key
    and x.config_version = p_config_version;
  if not found then
    return jsonb_build_object(
      'status', 'configuration_pending',
      'statistical_significance_assessed', false,
      'reason', 'No immutable activation snapshot exists for this version.'
    );
  end if;
  if p_as_of <= v_plan.activated_at then
    return jsonb_build_object(
      'status', 'not_started',
      'statistical_significance_assessed', false,
      'plan', jsonb_build_object(
        'variable', v_plan.experiment_variable,
        'hypothesis', v_plan.hypothesis,
        'primary_metric', v_plan.primary_metric,
        'window_hours', v_plan.window_hours,
        'target_relative_lift_pct', v_plan.target_relative_lift_pct,
        'unsubscribe_lift_guardrail_pp', v_plan.unsubscribe_lift_guardrail_pp,
        'provider_rejection_guardrail_pp', v_plan.provider_rejection_guardrail_pp
      )
    );
  end if;

  v_window := public.norva_behavioral_experiment_window(
    p_journey_key, p_config_version, v_plan.window_hours,
    v_plan.activated_at, p_as_of
  );
  v_safety := public.norva_behavioral_experiment_safety(
    p_journey_key, p_config_version, v_plan.activated_at, p_as_of
  );
  v_milestones := public.norva_behavioral_experiment_milestones(
    p_journey_key, p_config_version, p_as_of
  );
  v_relative_uplift := nullif(v_window->>'relative_uplift_pct', '')::numeric;
  v_unsubscribe_lift := nullif(v_window->>'unsubscribe_lift_pp', '')::numeric;

  select * into v_previous
  from public.behavioral_lifecycle_experiment_versions x
  where x.journey_key = p_journey_key
    and x.config_version < p_config_version
  order by x.config_version desc
  limit 1;
  if found then
    v_previous_safety := public.norva_behavioral_experiment_safety(
      p_journey_key, v_previous.config_version,
      v_previous.activated_at, v_plan.activated_at
    );
    if coalesce((v_previous_safety->>'transport_started')::integer, 0) > 0
       and v_previous_safety->>'provider_rejection_rate_pct' is not null
       and v_safety->>'provider_rejection_rate_pct' is not null then
      v_provider_delta := round(
        (v_safety->>'provider_rejection_rate_pct')::numeric
        - (v_previous_safety->>'provider_rejection_rate_pct')::numeric,
        2
      );
      v_provider_status := case
        when v_provider_delta > v_plan.provider_rejection_guardrail_pp
          then 'exceeded'
        else 'within_guardrail'
      end;
    else
      v_provider_status := 'baseline_required';
    end if;
  end if;

  v_status := case
    when v_milestones->>'day_14_status' = 'not_started' then 'not_started'
    when v_milestones->>'day_14_status' <> 'ready'
      and v_milestones->>'day_7_status' = 'ready' then 'observation_ready'
    when v_milestones->>'day_14_status' <> 'ready' then 'pending'
    when v_window->>'status' <> 'measurable' then 'insufficient_sample'
    when coalesce((v_safety->>'duplicate_dedupe_keys')::integer, 0) > 0
      or coalesce((v_safety->>'sent_after_conversion')::integer, 0) > 0
      or coalesce(v_unsubscribe_lift, 0) > v_plan.unsubscribe_lift_guardrail_pp
      or v_provider_status = 'exceeded' then 'blocked_safety'
    when v_provider_status = 'baseline_required' then 'baseline_required'
    when v_plan.target_relative_lift_pct is null then 'baseline_ready'
    when v_relative_uplift is null then 'holdout_conversion_zero'
    when v_relative_uplift >= v_plan.target_relative_lift_pct then 'target_met'
    else 'target_not_met'
  end;

  return jsonb_build_object(
    'status', v_status,
    'statistical_significance_assessed', false,
    'plan', jsonb_build_object(
      'variable', v_plan.experiment_variable,
      'hypothesis', v_plan.hypothesis,
      'primary_metric', v_plan.primary_metric,
      'window_hours', v_plan.window_hours,
      'target_relative_lift_pct', v_plan.target_relative_lift_pct,
      'unsubscribe_lift_guardrail_pp', v_plan.unsubscribe_lift_guardrail_pp,
      'provider_rejection_guardrail_pp', v_plan.provider_rejection_guardrail_pp
    ),
    'window', v_window,
    'safety', v_safety,
    'provider_comparison', jsonb_build_object(
      'status', v_provider_status,
      'previous_config_version', v_previous.config_version,
      'previous_rate_pct', v_previous_safety->'provider_rejection_rate_pct',
      'current_rate_pct', v_safety->'provider_rejection_rate_pct',
      'delta_pp', v_provider_delta
    ),
    'reporting', v_milestones
  );
end;
$function$;

revoke all on function public.norva_behavioral_experiment_decision(
  text, integer, timestamptz
) from public, anon, authenticated;
grant execute on function public.norva_behavioral_experiment_decision(
  text, integer, timestamptz
) to service_role;

create or replace function public.admin_behavioral_lifecycle_overview(
  p_window_days integer default 30
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_days integer := greatest(1, least(coalesce(p_window_days, 30), 90));
  v_now timestamptz := clock_timestamp();
  v_start timestamptz := v_now - make_interval(
    days => greatest(1, least(coalesce(p_window_days, 30), 90))
  );
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'generated_at', v_now,
    'window_days', v_days,
    'import_readiness', coalesce((
      select jsonb_build_object(
        'status', r.status,
        'release_label', r.release_label,
        'source_commit', r.source_commit,
        'android_version', r.android_version,
        'evidence_sha256', r.evidence_sha256,
        'checked_at', r.checked_at,
        'expires_at', r.expires_at,
        'expired', r.expires_at <= v_now,
        'pilot_gate_open', r.status = 'passed' and r.expires_at > v_now,
        'checks', jsonb_build_object(
          'm3u_valid', r.m3u_valid,
          'xtream_valid', r.xtream_valid,
          'large_catalog_valid', r.large_catalog_valid,
          'error_guidance_valid', r.error_guidance_valid,
          'android_webview_valid', r.android_webview_valid
        )
      )
      from public.behavioral_lifecycle_import_readiness r
      order by r.checked_at desc, r.id desc
      limit 1
    ), jsonb_build_object(
      'status', 'missing',
      'expired', true,
      'pilot_gate_open', false,
      'checks', jsonb_build_object(
        'm3u_valid', false,
        'xtream_valid', false,
        'large_catalog_valid', false,
        'error_guidance_valid', false,
        'android_webview_valid', false
      )
    )),
    'runtime', (
      select jsonb_build_object(
        'emergency_stop', r.emergency_stop,
        'audience_mode', r.audience_mode,
        'reason', r.reason,
        'updated_at', r.updated_at,
        'active_journeys', (
          select count(*) from public.behavioral_lifecycle_journeys j
          where j.status = 'active'
        ),
        'internal_test_accounts', (
          select count(*) from public.admin_internal_accounts
        )
      )
      from public.behavioral_lifecycle_runtime r
      where r.singleton
    ),
    'reachability', jsonb_build_object(
      'total_accounts', (select count(*) from auth.users),
      'registered_tokens', (select count(*) from public.cloud_push_tokens),
      'registered_accounts', (select count(distinct user_id) from public.cloud_push_tokens),
      'permission_granted_tokens', (
        select count(*) from public.cloud_push_tokens where permission_state = 'granted'
      ),
      'targetable_tokens', (
        select count(*) from public.cloud_push_tokens
        where permission_state = 'granted'
          and last_seen_at >= clock_timestamp() - interval '45 days'
          and user_id in (select public.marketing_push_targets('all'))
      ),
      'targetable_accounts', (
        select count(distinct user_id) from public.cloud_push_tokens
        where permission_state = 'granted'
          and last_seen_at >= clock_timestamp() - interval '45 days'
          and user_id in (select public.marketing_push_targets('all'))
      ),
      'unknown_permission_tokens', (
        select count(*) from public.cloud_push_tokens where permission_state = 'unknown'
      ),
      'denied_permission_tokens', (
        select count(*) from public.cloud_push_tokens where permission_state = 'denied'
      )
    ),
    'primary_72h', (
      select jsonb_build_object(
        'cohort', count(*),
        'matured_through', v_now - interval '72 hours',
        'import_success', count(*) filter (
          where s.import_succeeded_at >= s.registered_at
            and s.import_succeeded_at <= s.registered_at + interval '72 hours'
        ),
        'import_then_first_play', count(*) filter (
          where s.import_succeeded_at >= s.registered_at
            and s.import_succeeded_at <= s.registered_at + interval '72 hours'
            and s.first_play_at >= s.import_succeeded_at
            and s.first_play_at <= s.registered_at + interval '72 hours'
        ),
        'rate_pct', round(
          100.0 * count(*) filter (
            where s.import_succeeded_at >= s.registered_at
              and s.import_succeeded_at <= s.registered_at + interval '72 hours'
              and s.first_play_at >= s.import_succeeded_at
              and s.first_play_at <= s.registered_at + interval '72 hours'
          ) / nullif(count(*), 0), 2
        )
      )
      from public.behavioral_lifecycle_user_state s
      where s.registered_at >= v_start
        and s.registered_at <= v_now - interval '72 hours'
        and not exists (
          select 1 from public.admin_internal_accounts a where a.user_id = s.user_id
        )
    ),
    'dimensions', coalesce((
      select jsonb_agg(to_jsonb(d) order by d.cohort desc, d.country_code, d.platform, d.app_version)
      from (
        select
          coalesce(s.country_code, '??') as country_code,
          s.signup_platform as platform,
          coalesce(s.app_version, 'unknown') as app_version,
          count(*)::integer as cohort,
          count(*) filter (
            where s.import_succeeded_at >= s.registered_at
              and s.import_succeeded_at <= s.registered_at + interval '72 hours'
          )::integer as import_success,
          count(*) filter (
            where s.import_succeeded_at >= s.registered_at
              and s.import_succeeded_at <= s.registered_at + interval '72 hours'
              and s.first_play_at >= s.import_succeeded_at
              and s.first_play_at <= s.registered_at + interval '72 hours'
          )::integer as import_then_first_play,
          round(
            100.0 * count(*) filter (
              where s.import_succeeded_at >= s.registered_at
                and s.import_succeeded_at <= s.registered_at + interval '72 hours'
                and s.first_play_at >= s.import_succeeded_at
                and s.first_play_at <= s.registered_at + interval '72 hours'
            ) / nullif(count(*), 0), 2
          ) as rate_pct
        from public.behavioral_lifecycle_user_state s
        where s.registered_at >= v_start
          and s.registered_at <= v_now - interval '72 hours'
          and not exists (
            select 1 from public.admin_internal_accounts a where a.user_id = s.user_id
          )
        group by coalesce(s.country_code, '??'), s.signup_platform,
                 coalesce(s.app_version, 'unknown')
        order by count(*) desc
        limit 100
      ) d
    ), '[]'::jsonb),
    'journeys', coalesce((
      select jsonb_agg(jsonb_build_object(
        'key', j.journey_key,
        'name', j.name,
        'description', j.description,
        'entry_event', j.entry_event,
        'exit_event', j.exit_event,
        'status', j.status,
        'version', j.version,
        'rollout_percent', j.rollout_percent,
        'holdout_percent', j.holdout_percent,
        'countries', j.country_allowlist,
        'activated_at', j.activated_at,
        'experiment_plan', jsonb_build_object(
          'variable', j.experiment_variable,
          'hypothesis', j.experiment_hypothesis,
          'primary_metric', j.exit_event,
          'window_hours', j.experiment_window_hours,
          'target_relative_lift_pct', j.target_relative_lift_pct,
          'unsubscribe_lift_guardrail_pp', j.unsubscribe_lift_guardrail_pp,
          'provider_rejection_guardrail_pp', j.provider_rejection_guardrail_pp,
          'snapshot_status', case
            when exists (
              select 1
              from public.behavioral_lifecycle_experiment_versions x
              where x.journey_key = j.journey_key
                and x.config_version = j.version
            ) then 'immutable'
            else 'draft'
          end
        ),
        'eligibility', jsonb_build_object(
          'currently_eligible', (
            select count(*)
            from public.behavioral_lifecycle_user_state s
            where public.norva_behavioral_journey_relevant(
              s.user_id, j.journey_key, clock_timestamp()
            )
          ),
          'potential_internal_test', (
            select count(*)
            from public.behavioral_lifecycle_user_state s
            where public.norva_behavioral_state_relevant(
              s.user_id, j.journey_key, clock_timestamp()
            )
              and exists (
                select 1 from public.admin_internal_accounts a where a.user_id = s.user_id
              )
          ),
          'potential_pilot', (
            select count(*)
            from public.behavioral_lifecycle_user_state s
            where public.norva_behavioral_state_relevant(
              s.user_id, j.journey_key, clock_timestamp()
            )
              and s.country_code = any(j.country_allowlist)
              and not exists (
                select 1 from public.admin_internal_accounts a where a.user_id = s.user_id
              )
          ),
          'unknown_country', (
            select count(*)
            from public.behavioral_lifecycle_user_state s
            where public.norva_behavioral_state_relevant(
              s.user_id, j.journey_key, clock_timestamp()
            ) and s.country_code is null
          )
        ),
        'limits', jsonb_build_object(
          'cooldown_days', j.cooldown_days,
          'push_day', j.max_push_per_day,
          'push_week', j.max_push_per_week,
          'email_week', j.max_email_per_week,
          'quiet_start', j.quiet_start_hour,
          'quiet_end', j.quiet_end_hour
        ),
        'steps', (
          select coalesce(jsonb_agg(jsonb_build_object(
            'key', st.step_key,
            'ordinal', st.ordinal,
            'channel', st.channel,
            'delay_minutes', st.delay_minutes,
            'title', st.title,
             'body', st.body,
             'cta_label', st.cta_label,
             'deep_link', st.deep_link,
             'ttl_seconds', st.ttl_seconds,
             'collapse_key', st.collapse_key,
             'is_marketing', st.is_marketing,
             'requires_new_content', st.requires_new_content,
             'enabled', st.enabled
           ) order by st.ordinal), '[]'::jsonb)
          from public.behavioral_lifecycle_steps st
          where st.journey_key = j.journey_key
        ),
        'metrics', (
          select jsonb_build_object(
             'queued', count(*) filter (where o.status in ('pending','processing','email_queued')),
             'holdout', count(*) filter (where o.status = 'holdout'),
             'treatment_users', count(distinct o.user_id) filter (
               where o.experiment_arm = 'treatment'
             ),
             'holdout_users', count(distinct o.user_id) filter (
               where o.experiment_arm = 'holdout'
             ),
             'provider_accepted', count(*) filter (where o.provider_accepted_at is not null),
             'delivered', count(*) filter (where o.delivered_at is not null),
             'opened', count(*) filter (where o.opened_at is not null),
            'canceled', count(*) filter (where o.status = 'canceled'),
            'suppressed', count(*) filter (where o.status = 'suppressed'),
            'dead_letter', count(*) filter (where o.status = 'dead_letter')
          )
          from public.behavioral_lifecycle_outbox o
           where o.journey_key = j.journey_key
             and o.created_at >= clock_timestamp() - make_interval(days => v_days)
        ),
        'conversion', (
          select jsonb_build_object(
            'treatment_users', count(distinct f.user_id) filter (
              where f.event_name = j.exit_event and f.experiment_arm = 'treatment'
            ),
            'holdout_users', count(distinct f.user_id) filter (
              where f.event_name = j.exit_event and f.experiment_arm = 'holdout'
            ),
            'source_form_opened', count(*) filter (where f.event_name = 'source_form_opened'),
            'source_attempted', count(*) filter (where f.event_name = 'source_attempted'),
            'import_success', count(*) filter (where f.event_name = 'import_success'),
            'first_play', count(*) filter (where f.event_name = 'first_play'),
            'playback_resumed', count(*) filter (where f.event_name = 'playback_resumed'),
            'trial_started', count(*) filter (where f.event_name = 'trial_started'),
            'subscription_started', count(*) filter (where f.event_name = 'subscription_started'),
            'email_unsubscribed', count(*) filter (where f.event_name = 'email_unsubscribed')
          )
          from public.behavioral_lifecycle_funnel_events f
          where f.journey_key = j.journey_key
            and f.occurred_at >= v_start
        ),
        'experiment_windows', jsonb_build_object(
          '24h', public.norva_behavioral_experiment_window(
            j.journey_key, j.version, 24, v_start, v_now
          ),
          '72h', public.norva_behavioral_experiment_window(
            j.journey_key, j.version, 72, v_start, v_now
          ),
          '7d', public.norva_behavioral_experiment_window(
            j.journey_key, j.version, 168, v_start, v_now
          )
        ),
        'experiment_safety', public.norva_behavioral_experiment_safety(
          j.journey_key, j.version, v_start, v_now
        ),
        'reporting', public.norva_behavioral_experiment_milestones(
          j.journey_key, j.version, v_now
        ),
        'experiment_decision', public.norva_behavioral_experiment_decision(
          j.journey_key, j.version, v_now
        )
      ) order by j.journey_key)
      from public.behavioral_lifecycle_journeys j
    ), '[]'::jsonb),
    'dead_letters', coalesce((
      select jsonb_agg(to_jsonb(d) order by d.dead_lettered_at desc)
      from (
        select o.id, o.journey_key, o.step_key, o.channel, o.attempt_count,
               o.last_error_family, o.dead_lettered_at, o.expires_at
        from public.behavioral_lifecycle_outbox o
        where o.status = 'dead_letter'
        order by o.dead_lettered_at desc
        limit 50
      ) d
    ), '[]'::jsonb),
    'audit_history', coalesce((
      select jsonb_agg(to_jsonb(a) order by a.created_at desc)
      from (
        select x.id, x.action, x.journey_key,
               case when x.actor_id is null then 'service-role'
                 else left(encode(digest(x.actor_id::text, 'sha256'), 'hex'), 12) end as actor_ref,
               x.reason, x.before_state, x.after_state, x.created_at
        from public.behavioral_lifecycle_admin_audit x
        order by x.created_at desc
        limit 100
      ) a
    ), '[]'::jsonb)
  );
end;
$function$;

revoke all on function public.admin_behavioral_lifecycle_overview(integer)
from public, anon, authenticated;
grant execute on function public.admin_behavioral_lifecycle_overview(integer)
to authenticated, service_role;

create or replace function public.admin_update_behavioral_lifecycle_journey(
  p_journey_key text,
  p_status text,
  p_rollout_percent integer,
  p_holdout_percent integer,
  p_country_allowlist text[],
  p_confirmation text default null,
  p_cooldown_days integer default null,
  p_max_push_per_day integer default null,
  p_max_push_per_week integer default null,
  p_max_email_per_week integer default null,
  p_quiet_start_hour integer default null,
  p_quiet_end_hour integer default null,
  p_reason text default null,
  p_experiment_variable text default null,
  p_experiment_hypothesis text default null,
  p_experiment_window_hours integer default null,
  p_target_relative_lift_pct numeric default -1
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_current record;
  v_status text := lower(btrim(coalesce(p_status, '')));
  v_countries text[];
  v_config_changed boolean;
  v_cooldown integer;
  v_push_day integer;
  v_push_week integer;
  v_email_week integer;
  v_quiet_start integer;
  v_quiet_end integer;
  v_experiment_variable text;
  v_experiment_hypothesis text;
  v_experiment_window integer;
  v_target_relative_lift numeric;
  v_current_snapshot jsonb;
  v_previous_plan record;
  v_has_previous_plan boolean := false;
  v_changed_variables text[];
  v_starts_version boolean := false;
  v_new_version integer;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_action text;
  v_before jsonb;
  v_after jsonb;
  v_now timestamptz := clock_timestamp();
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if v_status not in ('draft', 'active', 'paused', 'archived')
     or p_rollout_percent not between 0 and 100
     or p_holdout_percent <> 10
     or char_length(v_reason) not between 8 and 500 then
    raise exception 'invalid lifecycle configuration' using errcode = '22023';
  end if;
  select array_agg(distinct upper(btrim(x)) order by upper(btrim(x)))
    into v_countries
  from unnest(coalesce(p_country_allowlist, array[]::text[])) x
  where upper(btrim(x)) ~ '^[A-Z]{2}$';
  if cardinality(coalesce(v_countries, array[]::text[])) = 0
     or cardinality(v_countries) > 30 then
    raise exception 'invalid country allowlist' using errcode = '22023';
  end if;

  select * into v_current
  from public.behavioral_lifecycle_journeys
  where journey_key = p_journey_key
  for update;
  if not found then raise exception 'journey not found' using errcode = 'P0002'; end if;

  v_cooldown := coalesce(p_cooldown_days, v_current.cooldown_days);
  v_push_day := coalesce(p_max_push_per_day, v_current.max_push_per_day);
  v_push_week := coalesce(p_max_push_per_week, v_current.max_push_per_week);
  v_email_week := coalesce(p_max_email_per_week, v_current.max_email_per_week);
  v_quiet_start := coalesce(p_quiet_start_hour, v_current.quiet_start_hour);
  v_quiet_end := coalesce(p_quiet_end_hour, v_current.quiet_end_hour);
  v_experiment_variable := lower(btrim(coalesce(
    p_experiment_variable, v_current.experiment_variable
  )));
  v_experiment_hypothesis := btrim(coalesce(
    p_experiment_hypothesis, v_current.experiment_hypothesis
  ));
  v_experiment_window := coalesce(
    p_experiment_window_hours, v_current.experiment_window_hours
  );
  v_target_relative_lift := case
    when p_target_relative_lift_pct = -1 then v_current.target_relative_lift_pct
    else p_target_relative_lift_pct
  end;
  if v_cooldown not between 7 and 14
     or v_push_day not between 0 and 1
     or v_push_week not between 0 and 3
     or v_push_week < v_push_day
     or v_email_week not between 0 and 2
     or v_quiet_start not between 0 and 23
     or v_quiet_end not between 0 and 23
     or v_quiet_start <= v_quiet_end then
    raise exception 'invalid lifecycle guardrails' using errcode = '22023';
  end if;
  if v_experiment_variable not in ('baseline', 'delay', 'channel', 'copy', 'cta')
     or char_length(v_experiment_hypothesis) not between 20 and 500
     or v_experiment_window not in (24, 72, 168)
     or (
       v_target_relative_lift is not null
       and v_target_relative_lift not between 0.01 and 1000
     )
     or (
       v_experiment_variable <> 'baseline'
       and v_target_relative_lift is null
     ) then
    raise exception 'invalid lifecycle experiment plan' using errcode = '22023';
  end if;

  v_before := jsonb_build_object(
    'status', v_current.status,
    'version', v_current.version,
    'rollout_percent', v_current.rollout_percent,
    'holdout_percent', v_current.holdout_percent,
    'countries', v_current.country_allowlist,
    'cooldown_days', v_current.cooldown_days,
    'max_push_per_day', v_current.max_push_per_day,
    'max_push_per_week', v_current.max_push_per_week,
    'max_email_per_week', v_current.max_email_per_week,
    'quiet_start_hour', v_current.quiet_start_hour,
    'quiet_end_hour', v_current.quiet_end_hour,
    'experiment_variable', v_current.experiment_variable,
    'experiment_hypothesis', v_current.experiment_hypothesis,
    'experiment_window_hours', v_current.experiment_window_hours,
    'target_relative_lift_pct', v_current.target_relative_lift_pct
  );
  v_config_changed := v_current.rollout_percent is distinct from p_rollout_percent
    or v_current.holdout_percent is distinct from p_holdout_percent
    or v_current.country_allowlist is distinct from v_countries
    or v_current.cooldown_days is distinct from v_cooldown
    or v_current.max_push_per_day is distinct from v_push_day
    or v_current.max_push_per_week is distinct from v_push_week
    or v_current.max_email_per_week is distinct from v_email_week
    or v_current.quiet_start_hour is distinct from v_quiet_start
    or v_current.quiet_end_hour is distinct from v_quiet_end
    or v_current.experiment_variable is distinct from v_experiment_variable
    or v_current.experiment_hypothesis is distinct from v_experiment_hypothesis
    or v_current.experiment_window_hours is distinct from v_experiment_window
    or v_current.target_relative_lift_pct is distinct from v_target_relative_lift;
  if v_status = 'active' and (
    p_rollout_percent = 0
    or p_confirmation is distinct from 'ACTIVATE ' || p_journey_key
  ) then
    raise exception 'typed activation confirmation required' using errcode = '22023';
  end if;

  v_new_version := v_current.version;
  if v_status = 'active' then
    v_current_snapshot := public.norva_behavioral_step_experiment_snapshot(
      p_journey_key
    );
    select x.* into v_previous_plan
    from public.behavioral_lifecycle_experiment_versions x
    where x.journey_key = p_journey_key
    order by x.config_version desc
    limit 1;
    v_has_previous_plan := found;
    v_starts_version := v_config_changed
      or not v_has_previous_plan
      or v_previous_plan.step_snapshot is distinct from v_current_snapshot;
    if v_starts_version then
      v_new_version := v_current.version + 1;
    end if;

    if v_starts_version and not v_has_previous_plan then
      if v_experiment_variable <> 'baseline' then
        raise exception 'first lifecycle version must establish a baseline' using errcode = '22023';
      end if;
    elsif v_starts_version then
      v_changed_variables := array_remove(array[
        case when v_previous_plan.step_snapshot->'delay'
          is distinct from v_current_snapshot->'delay' then 'delay' end,
        case when v_previous_plan.step_snapshot->'channel'
          is distinct from v_current_snapshot->'channel' then 'channel' end,
        case when v_previous_plan.step_snapshot->'copy'
          is distinct from v_current_snapshot->'copy' then 'copy' end,
        case when v_previous_plan.step_snapshot->'cta'
          is distinct from v_current_snapshot->'cta' then 'cta' end
      ], null);
      if cardinality(v_changed_variables) = 0 then
        if v_experiment_variable <> 'baseline' then
          raise exception 'declared experiment variable has no matching change' using errcode = '22023';
        end if;
      elsif cardinality(v_changed_variables) = 1 then
        if v_previous_plan.step_snapshot->'structure'
             is distinct from v_current_snapshot->'structure'
           or v_experiment_variable <>
             v_changed_variables[array_lower(v_changed_variables, 1)] then
          raise exception
            'experiment must change exactly the declared variable (declared %, changed %, structural %)',
            v_experiment_variable,
            v_changed_variables[array_lower(v_changed_variables, 1)],
            v_previous_plan.step_snapshot->'structure'
              is distinct from v_current_snapshot->'structure'
            using errcode = '22023';
        end if;
      else
        raise exception 'experiment changes more than one variable' using errcode = '22023';
      end if;
      if v_previous_plan.step_snapshot->'structure'
           is distinct from v_current_snapshot->'structure'
         and cardinality(v_changed_variables) > 0 then
        raise exception 'structural reset cannot be combined with an experiment variable' using errcode = '22023';
      end if;
    end if;
  end if;

  if v_status <> 'active' or v_config_changed or v_starts_version then
    update public.cloud_branded_email_outbox e
    set state = 'canceled',
        last_error = 'behavioral_configuration_changed_before_send',
        lease_token = null,
        lease_expires_at = null,
        recipient_email = null,
        request_reply_to = null,
        request_subject = null,
        request_html = null,
        request_text = null,
        request_headers = '{}'::jsonb,
        payload_scrubbed_at = clock_timestamp(),
        updated_at = clock_timestamp()
    where e.id in (
      select o.email_outbox_id
      from public.behavioral_lifecycle_outbox o
      where o.journey_key = p_journey_key
        and o.status = 'email_queued'
        and o.email_outbox_id is not null
    )
      and (
        e.state = 'pending'
        or (e.state = 'processing' and e.transport_started_at is null)
      );

    update public.behavioral_lifecycle_outbox
    set status = 'canceled', canceled_at = clock_timestamp(),
        last_error_family = 'configuration_changed',
        lease_token = null, lease_expires_at = null, updated_at = clock_timestamp()
    where journey_key = p_journey_key
      and status in ('pending','processing','email_queued')
      and transport_started_at is null;
  end if;

  update public.behavioral_lifecycle_journeys
  set status = v_status,
      rollout_percent = p_rollout_percent,
      holdout_percent = p_holdout_percent,
      country_allowlist = v_countries,
      cooldown_days = v_cooldown,
      max_push_per_day = v_push_day,
      max_push_per_week = v_push_week,
      max_email_per_week = v_email_week,
      quiet_start_hour = v_quiet_start,
      quiet_end_hour = v_quiet_end,
      experiment_variable = v_experiment_variable,
      experiment_hypothesis = v_experiment_hypothesis,
      experiment_window_hours = v_experiment_window,
      target_relative_lift_pct = v_target_relative_lift,
      version = v_new_version,
      activated_at = case when v_starts_version
        then v_now else activated_at end,
      activated_by = case when v_starts_version
        then auth.uid() else activated_by end,
      updated_at = v_now
  where journey_key = p_journey_key;

  if v_starts_version then
    insert into public.behavioral_lifecycle_experiment_versions (
      journey_key, config_version, experiment_variable, hypothesis,
      primary_metric, window_hours, target_relative_lift_pct,
      unsubscribe_lift_guardrail_pp, provider_rejection_guardrail_pp,
      step_snapshot, activated_at, activated_by
    ) values (
      p_journey_key, v_new_version, v_experiment_variable,
      v_experiment_hypothesis, v_current.exit_event, v_experiment_window,
      v_target_relative_lift, v_current.unsubscribe_lift_guardrail_pp,
      v_current.provider_rejection_guardrail_pp, v_current_snapshot,
      v_now, auth.uid()
    );
  end if;

  select jsonb_build_object(
       'key', journey_key, 'status', status, 'version', version,
       'rollout_percent', rollout_percent, 'holdout_percent', holdout_percent,
       'countries', country_allowlist, 'activated_at', activated_at,
       'cooldown_days', cooldown_days,
       'max_push_per_day', max_push_per_day,
       'max_push_per_week', max_push_per_week,
       'max_email_per_week', max_email_per_week,
       'quiet_start_hour', quiet_start_hour,
       'quiet_end_hour', quiet_end_hour,
       'experiment_variable', experiment_variable,
       'experiment_hypothesis', experiment_hypothesis,
       'experiment_window_hours', experiment_window_hours,
       'target_relative_lift_pct', target_relative_lift_pct
     )
    into v_after
    from public.behavioral_lifecycle_journeys
    where journey_key = p_journey_key;

  v_action := case v_status
    when 'active' then 'journey_activated'
    when 'paused' then 'journey_paused'
    when 'archived' then 'journey_archived'
    else 'journey_saved'
  end;
  insert into public.behavioral_lifecycle_admin_audit (
    action, journey_key, actor_id, reason, before_state, after_state, created_at
  ) values (
    v_action, p_journey_key, auth.uid(), v_reason, v_before, v_after, v_now
  );
  return v_after;
end;
$function$;

revoke all on function public.admin_update_behavioral_lifecycle_journey(
  text, text, integer, integer, text[], text, integer, integer, integer,
  integer, integer, integer, text, text, text, integer, numeric
)
from public, anon, authenticated;
grant execute on function public.admin_update_behavioral_lifecycle_journey(
  text, text, integer, integer, text[], text, integer, integer, integer,
  integer, integer, integer, text, text, text, integer, numeric
)
to authenticated, service_role;

create or replace function public.admin_update_behavioral_lifecycle_step(
  p_journey_key text,
  p_step_key text,
  p_channel text,
  p_delay_minutes integer,
  p_title text,
  p_body text,
  p_cta_label text,
  p_deep_link text,
  p_ttl_seconds integer,
  p_enabled boolean,
  p_is_marketing boolean,
  p_requires_new_content boolean,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_journey record;
  v_step record;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_now timestamptz := clock_timestamp();
  v_before jsonb;
  v_after jsonb;
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if lower(btrim(coalesce(p_channel, ''))) not in ('in_app', 'push', 'email')
     or p_delay_minutes not between 0 and 43200
     or char_length(btrim(coalesce(p_title, ''))) not between 2 and 80
     or char_length(btrim(coalesce(p_body, ''))) not between 2 and 500
     or char_length(btrim(coalesce(p_cta_label, ''))) not between 2 and 50
     or p_deep_link not in (
       '/app.html#settings/sources', '/app.html#home', '/app.html#home/resume'
     )
     or p_ttl_seconds not between 300 and 1209600
     or char_length(v_reason) not between 8 and 500
     or (p_deep_link = '/app.html#home/resume' and p_journey_key <> 'continue_watching')
     or (coalesce(p_requires_new_content, false) and p_journey_key <> 'continue_watching')
     or not public.norva_behavioral_step_copy_safe(
       p_journey_key, btrim(p_title), btrim(p_body), btrim(p_cta_label),
       p_deep_link, coalesce(p_requires_new_content, false)
     ) then
    raise exception 'invalid lifecycle step configuration' using errcode = '22023';
  end if;

  select * into v_journey
  from public.behavioral_lifecycle_journeys j
  where j.journey_key = p_journey_key
  for update;
  if not found then raise exception 'journey not found' using errcode = 'P0002'; end if;
  if v_journey.status = 'active' then
    raise exception 'pause journey before editing a step' using errcode = '55000';
  end if;

  select * into v_step
  from public.behavioral_lifecycle_steps st
  where st.journey_key = p_journey_key and st.step_key = p_step_key
  for update;
  if not found then raise exception 'journey step not found' using errcode = 'P0002'; end if;
  v_before := jsonb_build_object(
    'step_key', v_step.step_key, 'channel', v_step.channel,
    'delay_minutes', v_step.delay_minutes, 'title', v_step.title,
    'body', v_step.body, 'cta_label', v_step.cta_label,
    'deep_link', v_step.deep_link, 'ttl_seconds', v_step.ttl_seconds,
    'enabled', v_step.enabled, 'is_marketing', v_step.is_marketing,
    'requires_new_content', v_step.requires_new_content
  );

  update public.cloud_branded_email_outbox e
  set state = 'canceled',
      last_error = 'behavioral_step_changed_before_send',
      lease_token = null, lease_expires_at = null,
      recipient_email = null, request_reply_to = null,
      request_subject = null, request_html = null, request_text = null,
      request_headers = '{}'::jsonb,
      payload_scrubbed_at = v_now, updated_at = v_now
  where e.id in (
    select o.email_outbox_id
    from public.behavioral_lifecycle_outbox o
    where o.journey_key = p_journey_key and o.step_key = p_step_key
      and o.status = 'email_queued' and o.email_outbox_id is not null
  ) and (
    e.state = 'pending'
    or (e.state = 'processing' and e.transport_started_at is null)
  );

  update public.behavioral_lifecycle_outbox o
  set status = 'canceled', canceled_at = v_now,
      last_error_family = 'configuration_changed',
      lease_token = null, lease_expires_at = null, updated_at = v_now
  where o.journey_key = p_journey_key and o.step_key = p_step_key
    and o.status in ('pending', 'processing', 'email_queued')
    and o.transport_started_at is null;

  update public.behavioral_lifecycle_steps
  set channel = lower(btrim(p_channel)),
      delay_minutes = p_delay_minutes,
      title = btrim(p_title),
      body = btrim(p_body),
      cta_label = btrim(p_cta_label),
      deep_link = p_deep_link,
      ttl_seconds = p_ttl_seconds,
      enabled = coalesce(p_enabled, false),
      is_marketing = coalesce(p_is_marketing, false),
      requires_new_content = coalesce(p_requires_new_content, false),
      updated_at = v_now
  where journey_key = p_journey_key and step_key = p_step_key;
  update public.behavioral_lifecycle_journeys
  set updated_at = v_now where journey_key = p_journey_key;

  select jsonb_build_object(
    'step_key', st.step_key, 'channel', st.channel,
    'delay_minutes', st.delay_minutes, 'title', st.title,
    'body', st.body, 'cta_label', st.cta_label,
    'deep_link', st.deep_link, 'ttl_seconds', st.ttl_seconds,
    'enabled', st.enabled, 'is_marketing', st.is_marketing,
    'requires_new_content', st.requires_new_content
  ) into v_after
  from public.behavioral_lifecycle_steps st
  where st.journey_key = p_journey_key and st.step_key = p_step_key;

  insert into public.behavioral_lifecycle_admin_audit (
    action, journey_key, actor_id, reason, before_state, after_state, created_at
  ) values (
    'step_updated', p_journey_key, auth.uid(), v_reason, v_before, v_after, v_now
  );
  return v_after;
end;
$function$;

revoke all on function public.admin_update_behavioral_lifecycle_step(
  text, text, text, integer, text, text, text, text, integer,
  boolean, boolean, boolean, text
) from public, anon, authenticated;
grant execute on function public.admin_update_behavioral_lifecycle_step(
  text, text, text, integer, text, text, text, text, integer,
  boolean, boolean, boolean, text
) to authenticated, service_role;

create or replace function public.admin_retry_behavioral_lifecycle_delivery(
  p_delivery_id uuid,
  p_confirmation text,
  p_reason text default null
) returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_reason text := btrim(coalesce(p_reason, ''));
  v_before jsonb;
  v_after jsonb;
  v_journey_key text;
  v_now timestamptz := clock_timestamp();
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_confirmation is distinct from 'RETRY ' || p_delivery_id::text
     or char_length(v_reason) not between 8 and 500 then
    raise exception 'typed retry confirmation required' using errcode = '22023';
  end if;
  select o.journey_key, jsonb_build_object(
    'delivery_id', o.id, 'status', o.status, 'attempt_count', o.attempt_count,
    'last_error_family', o.last_error_family, 'expires_at', o.expires_at
  ) into v_journey_key, v_before
  from public.behavioral_lifecycle_outbox o
  where o.id = p_delivery_id
  for update;
  if not found then return false; end if;

  update public.behavioral_lifecycle_outbox o
  set status = 'pending', next_attempt_at = clock_timestamp(),
      dead_lettered_at = null, last_error_family = null,
      transport_started_at = null,
      lease_token = null, lease_expires_at = null, updated_at = clock_timestamp()
  where o.id = p_delivery_id and o.status = 'dead_letter'
    and o.expires_at > clock_timestamp()
    and public.norva_behavioral_journey_relevant(
      o.user_id, o.journey_key, clock_timestamp()
    )
    and exists (
      select 1
      from public.behavioral_lifecycle_journeys j
      join public.behavioral_lifecycle_steps st
        on st.journey_key = j.journey_key
       and st.step_key = o.step_key
      where j.journey_key = o.journey_key
        and j.version = o.config_version
         and st.enabled
     );
  if not found then return false; end if;
  select jsonb_build_object(
    'delivery_id', o.id, 'status', o.status, 'attempt_count', o.attempt_count,
    'last_error_family', o.last_error_family, 'next_attempt_at', o.next_attempt_at
  ) into v_after
  from public.behavioral_lifecycle_outbox o where o.id = p_delivery_id;
  insert into public.behavioral_lifecycle_admin_audit (
    action, journey_key, actor_id, reason, before_state, after_state, created_at
  ) values (
    'delivery_retried', v_journey_key, auth.uid(), v_reason, v_before, v_after, v_now
  );
  return true;
end;
$function$;

revoke all on function public.admin_retry_behavioral_lifecycle_delivery(uuid, text, text)
from public, anon, authenticated;
grant execute on function public.admin_retry_behavioral_lifecycle_delivery(uuid, text, text)
to authenticated, service_role;

comment on function public.admin_marketing_overview() is
  'Marketing push semantics: push_devices/push_users are fresh permission-granted targets; push_registered_* are raw FCM registrations and must not be called reachable.';

select pg_notify('pgrst', 'reload schema');
commit;
