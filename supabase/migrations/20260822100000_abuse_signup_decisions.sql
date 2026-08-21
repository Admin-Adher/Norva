-- Signup risk decisions: the snapshot of what the engine knew, and why.
--
-- Its whole purpose is calibration. The thresholds and weights are meant to move
-- after the first cohorts, so a row has to stay interpretable after they have
-- moved fifty times. That is why the configuration actually used is recorded with
-- the decision rather than referenced by name: a policy_version alone is not
-- enough when configuration is changeable at runtime, because two rows stamped
-- "v1" could have been computed under different thresholds. policy_config_hash is
-- taken over a canonical rendering of the effective configuration, so any change
-- — announced or not — produces a different hash.
--
-- APPEND-ONLY. A row is a photograph of one instant and is never corrected
-- afterwards. Everything learned later — the address was confirmed, the person
-- became a subscriber, the account turned out to be farming — belongs to
-- signup_decision_outcomes, keyed by decision_id. Without that split the audit
-- log slowly becomes mutable state and stops being evidence.
--
-- PSEUDONYMISED, NOT ANONYMOUS. The subject columns hold keyed digests, which is
-- exactly what makes them useful: a stable device digest correlates across
-- events, which is the point of anti-abuse. Under the GDPR that is
-- pseudonymisation and nothing more. It is therefore handled as personal data:
-- the table is private, access runs through service-role functions, retention is
-- short, the key is rotatable, and no admin surface reads it unless it needs to.
--
-- What is deliberately absent: raw addresses, raw emails, passwords, tokens,
-- full headers, request bodies, upstream responses. This table answers "why did
-- this signup look suspicious", not "replay everything the user sent us".

create table if not exists abuse_private.signup_decisions (
  id                      uuid        primary key default gen_random_uuid(),

  -- Which engine, which policy, and the fingerprint of the configuration that
  -- was actually in force. The hash is what survives hot reconfiguration.
  risk_model_version      text        not null,
  policy_version          text        not null,
  policy_config_hash      text        not null,
  velocity_rules_version  text        not null,
  fingerprint_version     smallint    not null,
  hash_version            smallint    not null,

  -- The numbers in force, stored rather than referenced, so a historical
  -- decision can be recomputed without archaeology.
  thresholds_used         jsonb       not null,
  family_caps_used        jsonb       not null,

  -- The calculation, not merely its result. family_totals carries the raw and
  -- the capped figure per family: knowing a signal was clipped rather than
  -- absent is what makes a cap arguable later.
  observed_raw_score      integer     not null,
  observed_risk_score     integer     not null,
  observed_risk_level     text        not null,
  risk_floor              integer     not null default 0,
  signals                 jsonb       not null,
  family_totals           jsonb       not null,
  families_involved       text[]      not null default '{}',
  repeated_strong_evidence boolean    not null default false,

  -- The verdict, and what was actually done about it.
  would_have_decision     text        not null,
  enforcement_enabled     boolean     not null,
  actual_decision         text        not null,

  -- Pseudonymised subjects. Nullable: a signal that could not be computed is
  -- absent rather than faked.
  ip_subject_hmac         text,
  mailbox_subject_hmac    text,
  device_subject_hmac     text,
  attempt_fingerprint     text,

  -- Coarse context, kept because it is what anomaly detection reads. The ASN is
  -- here for reputation and for "this network suddenly tripled", never as a
  -- per-user signal.
  asn                     integer,
  country                 text,
  ua_family               text,

  -- Segmentation, and it is not optional. Every client older than the new signup
  -- endpoint will report TOKEN_MISSING, and reading the population in one block
  -- would move the whole distribution. Legacy and migrated clients have to be
  -- readable apart from the first day.
  auth_method             text        not null,
  platform                text        not null,
  app_version             text,
  signup_endpoint_version text        not null,

  created_at              timestamptz not null default now(),
  expires_at              timestamptz not null,

  -- The invariant that matters most right now, defended in the database as well
  -- as in TypeScript. A future bug in another function cannot record a refusal
  -- while enforcement is off.
  constraint signup_decisions_observe_allows check (
    enforcement_enabled = true or actual_decision = 'ALLOW'
  ),
  constraint signup_decisions_score_range check (observed_risk_score between 0 and 100),
  -- risk_score is exactly the clamp of raw_score. raw stays unclamped and may be
  -- negative, which is how a log shows trust outweighing risk.
  constraint signup_decisions_score_clamp check (
    observed_risk_score = least(100, greatest(0, observed_raw_score))
  ),
  constraint signup_decisions_level check (
    observed_risk_level in ('SAFE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL')
  ),
  -- Level boundaries are deliberately NOT constrained here: they are configurable
  -- and will be recalibrated, and a check constraint would make that a migration.
  constraint signup_decisions_decisions check (
    would_have_decision in ('ALLOW', 'RESTRICT', 'REJECT', 'BLOCK')
    and actual_decision in ('ALLOW', 'RESTRICT', 'REJECT', 'BLOCK')
  ),
  constraint signup_decisions_shapes check (
    jsonb_typeof(signals) = 'array'
    and jsonb_typeof(family_totals) = 'object'
    and jsonb_typeof(thresholds_used) = 'object'
    and jsonb_typeof(family_caps_used) = 'object'
  ),
  constraint signup_decisions_config_hash check (policy_config_hash ~ '^[0-9a-f]{64}$'),
  constraint signup_decisions_subject_hashes check (
    (ip_subject_hmac is null or ip_subject_hmac ~ '^[0-9a-f]{64}$')
    and (mailbox_subject_hmac is null or mailbox_subject_hmac ~ '^[0-9a-f]{64}$')
    and (device_subject_hmac is null or device_subject_hmac ~ '^[0-9a-f]{64}$')
    and (attempt_fingerprint is null or attempt_fingerprint ~ '^[0-9a-f]{64}$')
  ),
  constraint signup_decisions_country check (country is null or country ~ '^[A-Z]{2}$'),
  constraint signup_decisions_asn check (asn is null or asn between 0 and 4294967295)
);

comment on table abuse_private.signup_decisions is
  'Append-only snapshot of each signup risk evaluation, including the policy '
  'configuration in force. Pseudonymised personal data: private, short '
  'retention, rotatable key, service-role access only.';

create index if not exists signup_decisions_created_idx
  on abuse_private.signup_decisions (created_at desc);
create index if not exists signup_decisions_expiry_idx
  on abuse_private.signup_decisions (expires_at);
-- The two reads calibration actually performs: distribution by level over time,
-- and "show me everything this policy produced".
create index if not exists signup_decisions_level_idx
  on abuse_private.signup_decisions (observed_risk_level, created_at desc);
create index if not exists signup_decisions_policy_idx
  on abuse_private.signup_decisions (policy_config_hash, created_at desc);

alter table abuse_private.signup_decisions enable row level security;

revoke all on table abuse_private.signup_decisions
  from public, anon, authenticated, service_role;

-- Outcomes, learned afterwards, and therefore mutable — which is exactly why
-- they live apart from the snapshot. Verification rate alone is not truth: a bot
-- with a real Gmail inbox confirms its address, and plenty of humans abandon
-- before they do. What discriminates is what happened next.
create table if not exists abuse_private.signup_decision_outcomes (
  decision_id             uuid        primary key
    references abuse_private.signup_decisions(id) on delete cascade,
  email_verified_at       timestamptz,
  onboarding_completed_at timestamptz,
  source_imported_at      timestamptz,
  meaningful_usage_at     timestamptz,
  trial_started_at        timestamptz,
  subscription_started_at timestamptz,
  subscription_retained_at timestamptz,
  account_deleted_at      timestamptz,
  abuse_confirmed_at      timestamptz,
  chargeback_at           timestamptz,
  repeat_trial_pattern    boolean     not null default false,
  device_reuse            boolean     not null default false,
  -- Set by hand during sampling. A model calibrated only on automatic proxies
  -- inherits whatever those proxies get wrong.
  manual_review_verdict   text,
  updated_at              timestamptz not null default now(),
  constraint signup_decision_outcomes_review check (
    manual_review_verdict is null
    or manual_review_verdict in ('LEGITIMATE', 'ABUSIVE', 'UNCLEAR')
  )
);

comment on table abuse_private.signup_decision_outcomes is
  'What each scored signup turned into. Mutable on purpose, and kept out of the '
  'decision snapshot so the audit trail stays evidence rather than state.';

alter table abuse_private.signup_decision_outcomes enable row level security;

revoke all on table abuse_private.signup_decision_outcomes
  from public, anon, authenticated, service_role;

-- Append-only, enforced. Retention may remove a snapshot once it has expired;
-- nothing may edit one, ever.
create or replace function abuse_private.reject_signup_decision_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.expires_at < now() then return old; end if;
    raise exception 'A signup decision snapshot cannot be deleted before it expires';
  end if;
  raise exception 'A signup decision snapshot cannot be modified';
end;
$$;

drop trigger if exists signup_decisions_append_only on abuse_private.signup_decisions;
create trigger signup_decisions_append_only
  before update or delete on abuse_private.signup_decisions
  for each row execute function abuse_private.reject_signup_decision_mutation();

-- Recording is one insert of one payload: the engine has already decided, and
-- this function only refuses what the constraints refuse.
create or replace function abuse_private.signup_decision_record(
  p_decision jsonb,
  p_retention_days integer
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_days integer := least(greatest(coalesce(p_retention_days, 90), 1), 400);
  v_id   uuid;
begin
  insert into abuse_private.signup_decisions (
    risk_model_version, policy_version, policy_config_hash, velocity_rules_version,
    fingerprint_version, hash_version, thresholds_used, family_caps_used,
    observed_raw_score, observed_risk_score, observed_risk_level, risk_floor,
    signals, family_totals, families_involved, repeated_strong_evidence,
    would_have_decision, enforcement_enabled, actual_decision,
    ip_subject_hmac, mailbox_subject_hmac, device_subject_hmac, attempt_fingerprint,
    asn, country, ua_family,
    auth_method, platform, app_version, signup_endpoint_version,
    expires_at
  )
  values (
    p_decision->>'risk_model_version',
    p_decision->>'policy_version',
    p_decision->>'policy_config_hash',
    p_decision->>'velocity_rules_version',
    (p_decision->>'fingerprint_version')::smallint,
    (p_decision->>'hash_version')::smallint,
    p_decision->'thresholds_used',
    p_decision->'family_caps_used',
    (p_decision->>'observed_raw_score')::integer,
    (p_decision->>'observed_risk_score')::integer,
    p_decision->>'observed_risk_level',
    coalesce((p_decision->>'risk_floor')::integer, 0),
    p_decision->'signals',
    p_decision->'family_totals',
    coalesce(
      (select array_agg(value::text) from jsonb_array_elements_text(p_decision->'families_involved')),
      '{}'
    ),
    coalesce((p_decision->>'repeated_strong_evidence')::boolean, false),
    p_decision->>'would_have_decision',
    coalesce((p_decision->>'enforcement_enabled')::boolean, false),
    p_decision->>'actual_decision',
    p_decision->>'ip_subject_hmac',
    p_decision->>'mailbox_subject_hmac',
    p_decision->>'device_subject_hmac',
    p_decision->>'attempt_fingerprint',
    (p_decision->>'asn')::integer,
    p_decision->>'country',
    p_decision->>'ua_family',
    p_decision->>'auth_method',
    p_decision->>'platform',
    p_decision->>'app_version',
    p_decision->>'signup_endpoint_version',
    now() + make_interval(days => v_days)
  )
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function abuse_private.signup_decision_prune()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  delete from abuse_private.signup_decisions where expires_at < now();
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function abuse_private.reject_signup_decision_mutation()
  from public, anon, authenticated, service_role;
revoke all on function abuse_private.signup_decision_record(jsonb, integer)
  from public, anon, authenticated, service_role;
revoke all on function abuse_private.signup_decision_prune()
  from public, anon, authenticated, service_role;

create or replace function public.abuse_signup_decision_record(
  p_decision jsonb,
  p_retention_days integer
)
returns uuid
language sql
security definer
set search_path = ''
as $$
  select abuse_private.signup_decision_record(p_decision, p_retention_days);
$$;

create or replace function public.abuse_signup_decision_prune()
returns integer
language sql
security definer
set search_path = ''
as $$
  select abuse_private.signup_decision_prune();
$$;

revoke all on function public.abuse_signup_decision_record(jsonb, integer)
  from public, anon, authenticated;
grant execute on function public.abuse_signup_decision_record(jsonb, integer) to service_role;

revoke all on function public.abuse_signup_decision_prune()
  from public, anon, authenticated;
grant execute on function public.abuse_signup_decision_prune() to service_role;
