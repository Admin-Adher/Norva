-- Norva Partners P0 phase 2: temporary Android TV relay, explicit Admin
-- capabilities and sanitized product/operations observability.

alter table affiliate_private.affiliate_service_idempotency
  drop constraint affiliate_service_idempotency_operation;
alter table affiliate_private.affiliate_service_idempotency
  add constraint affiliate_service_idempotency_operation
  check (
    operation in (
      'application',
      'terms_acceptance',
      'link_rotation',
      'kyc_prepare',
      'kyc_session_record',
      'referral_claim',
      'payout_profile',
      'tv_relay_consume'
    )
  );

alter table affiliate_private.affiliate_events
  drop constraint affiliate_events_aggregate_type;
alter table affiliate_private.affiliate_events
  add constraint affiliate_events_aggregate_type
  check (
    aggregate_type in (
      'release_gate',
      'feature_flag',
      'pilot_allowlist',
      'program_version',
      'country_policy',
      'account',
      'link',
      'kyc',
      'attribution',
      'financial_fact',
      'commission',
      'payout',
      'tv_relay',
      'admin_capability',
      'worker',
      'configuration'
    )
  );

create table affiliate_private.affiliate_tv_relay_sessions (
  id                    uuid primary key default gen_random_uuid(),
  session_key           text not null unique default (
    'tvr_' || left(encode(extensions.gen_random_bytes(16), 'hex'), 24)
  ),
  device_id             uuid not null
    references public.cloud_devices(id)
    on delete restrict,
  device_token_hash     text not null,
  relay_token_hash      text not null unique,
  request_nonce_hash    text not null unique,
  status                text not null default 'pending',
  destination           text,
  consumed_by_user_id   uuid
    references auth.users(id)
    on delete restrict,
  expires_at            timestamptz not null,
  consumed_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint affiliate_tv_relay_sessions_key
    check (session_key ~ '^tvr_[0-9a-f]{24}$'),
  constraint affiliate_tv_relay_sessions_hashes
    check (
      device_token_hash ~ '^[0-9a-f]{64}$'
      and relay_token_hash ~ '^[0-9a-f]{64}$'
      and request_nonce_hash ~ '^[0-9a-f]{64}$'
    ),
  constraint affiliate_tv_relay_sessions_status
    check (status in ('pending', 'consumed', 'expired', 'revoked')),
  constraint affiliate_tv_relay_sessions_destination
    check (destination is null or destination = 'partners'),
  constraint affiliate_tv_relay_sessions_expiry
    check (
      expires_at > created_at
      and expires_at <= created_at + interval '10 minutes'
    ),
  constraint affiliate_tv_relay_sessions_consumption
    check (
      (status = 'consumed') = (
        destination = 'partners'
        and consumed_by_user_id is not null
        and consumed_at is not null
      )
    )
);

create unique index affiliate_tv_relay_sessions_pending_device_idx
  on affiliate_private.affiliate_tv_relay_sessions (device_id)
  where status = 'pending';
create index affiliate_tv_relay_sessions_expiry_idx
  on affiliate_private.affiliate_tv_relay_sessions (expires_at)
  where status = 'pending';

create table affiliate_private.affiliate_admin_capabilities (
  user_id                uuid not null
    references auth.users(id)
    on delete restrict,
  capability             text not null,
  enabled                boolean not null default false,
  granted_by_pseudonym   text not null,
  justification          text not null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  primary key (user_id, capability),
  constraint affiliate_admin_capabilities_capability
    check (capability in ('support', 'risk', 'finance')),
  constraint affiliate_admin_capabilities_actor
    check (granted_by_pseudonym ~ '^[0-9a-f]{64}$'),
  constraint affiliate_admin_capabilities_justification
    check (length(btrim(justification)) between 12 and 1000)
);

create index affiliate_admin_capabilities_enabled_idx
  on affiliate_private.affiliate_admin_capabilities (
    capability,
    user_id
  )
  where enabled;

create table affiliate_private.affiliate_worker_heartbeats (
  worker_name        text primary key,
  status             text not null,
  last_seen_at       timestamptz not null default now(),
  details            jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint affiliate_worker_heartbeats_name
    check (
      worker_name in (
        'commission',
        'maturation',
        'reconciliation',
        'payout'
      )
    ),
  constraint affiliate_worker_heartbeats_status
    check (status in ('healthy', 'degraded', 'blocked')),
  constraint affiliate_worker_heartbeats_details
    check (
      jsonb_typeof(details) = 'object'
      and not (
        details ?| array[
          'email',
          'token',
          'secret',
          'payload',
          'user_id',
          'account_id'
        ]::text[]
      )
    )
);

alter table affiliate_private.affiliate_tv_relay_sessions
  enable row level security;
alter table affiliate_private.affiliate_admin_capabilities
  enable row level security;
alter table affiliate_private.affiliate_worker_heartbeats
  enable row level security;

revoke all on table
  affiliate_private.affiliate_tv_relay_sessions,
  affiliate_private.affiliate_admin_capabilities,
  affiliate_private.affiliate_worker_heartbeats
from public, anon, authenticated, service_role;

create or replace function
affiliate_private.guard_tv_relay_session_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'TV relay sessions are retained'
      using errcode = '55000';
  end if;
  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id
      or new.session_key is distinct from old.session_key
      or new.device_id is distinct from old.device_id
      or new.device_token_hash is distinct from old.device_token_hash
      or new.relay_token_hash is distinct from old.relay_token_hash
      or new.request_nonce_hash is distinct from old.request_nonce_hash
      or new.expires_at is distinct from old.expires_at
      or new.created_at is distinct from old.created_at
    then
      raise exception 'TV relay identity is immutable'
        using errcode = '55000';
    end if;
    if old.status <> 'pending'
      or new.status not in ('consumed', 'expired', 'revoked')
    then
      raise exception 'TV relay session is terminal'
        using errcode = '55000';
    end if;
  elsif new.status <> 'pending'
    or new.destination is not null
    or new.consumed_by_user_id is not null
    or new.consumed_at is not null
  then
    raise exception 'new TV relay must start pending'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger affiliate_tv_relay_sessions_validate
before insert or update or delete
on affiliate_private.affiliate_tv_relay_sessions
for each row execute function
  affiliate_private.guard_tv_relay_session_transition();

create or replace function affiliate_private.partners_admin_actor_pseudonym()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select encode(
    extensions.digest(
      'norva-partners-actor:v1:' || auth.uid()::text,
      'sha256'
    ),
    'hex'
  );
$$;

create or replace function affiliate_private.partners_has_capability(
  p_capability text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    public.is_admin()
    and exists (
      select 1
      from affiliate_private.affiliate_admin_capabilities c
      where c.user_id = auth.uid()
        and c.capability = p_capability
        and c.enabled
    );
$$;

-- Capability grants are a server-managed privilege, separate from the regular
-- Norva admin role. Only the JSON boolean in app_metadata is accepted so a
-- missing, malformed, or user_metadata claim fails closed.
create or replace function affiliate_private.partners_can_manage_capabilities()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    coalesce(public.is_admin(), false)
    and coalesce(
      (
        auth.jwt()
        -> 'app_metadata'
        -> 'partners_capability_admin'
      ) = 'true'::jsonb,
      false
    );
$$;

-- Release management is provisioned only through server-controlled
-- app_metadata. It is deliberately independent from delegated Admin
-- capabilities so an Admin cannot grant itself production-release authority.
create or replace function affiliate_private.partners_is_release_manager()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    coalesce(public.is_admin(), false)
    and coalesce(
      (
        auth.jwt()
        -> 'app_metadata'
        -> 'partners_release_manager'
      ) = 'true'::jsonb,
      false
    );
$$;

-- Exact control mapping:
--   set_allowlist: Risk to add; Support or Risk to revoke.
--   set_gate: Finance for money/tax/backup gates, Risk for privacy/KYC/
--             country/TV-security gates, release-manager for general release.
--   set_flag: Finance for shadow mode; Finance + release-manager for live
--             payouts; release-manager for programme/invite controls;
--             Risk + release-manager for TV relay activation. Support/Risk may
--             operate only the explicit incident kill switches.
create or replace function
affiliate_private.partners_require_control_access(
  p_action text,
  p_key text,
  p_enabled boolean
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_action text := lower(btrim(coalesce(p_action, '')));
  v_key text := lower(btrim(coalesce(p_key, '')));
  v_support boolean :=
    affiliate_private.partners_has_capability('support');
  v_risk boolean :=
    affiliate_private.partners_has_capability('risk');
  v_finance boolean :=
    affiliate_private.partners_has_capability('finance');
  v_release boolean :=
    affiliate_private.partners_is_release_manager();
  v_allowed boolean := false;
begin
  if v_action = 'set_allowlist' then
    v_allowed := case
      when p_enabled is true then v_risk
      when p_enabled is false then v_support or v_risk
      else v_risk
    end;
  elsif v_action = 'set_gate' then
    if v_key = any (
      array[
        'legal_and_tax_approved',
        'individual_payout_coverage_confirmed',
        'financial_data_contract_approved',
        'shadow_reconciliation_clean',
        'backup_restore_verified',
        'payout_execution_adapter_verified'
      ]::text[]
    ) then
      v_allowed := v_finance;
    elsif v_key = any (
      array[
        'privacy_approved',
        'individual_verification_coverage_confirmed',
        'country_policy_approved',
        'tv_relay_security_verified'
      ]::text[]
    ) then
      v_allowed := v_risk;
    elsif v_key = 'general_release_approved' then
      v_allowed := v_release;
    end if;
  elsif v_action = 'set_flag' then
    if v_key = 'partners_payouts_live' then
      v_allowed := v_finance and v_release;
    elsif v_key = 'partners_shadow_mode' then
      v_allowed := v_finance;
    elsif v_key = 'partners_enabled' then
      v_allowed := v_release
        or (p_enabled is false and v_support);
    elsif v_key = 'partners_invite_only' then
      v_allowed := v_release;
    elsif v_key = 'partners_tv_relay_enabled' then
      v_allowed := case
        when p_enabled is true then v_release and v_risk
        when p_enabled is false then v_release or v_risk or v_support
        else v_release and v_risk
      end;
    end if;
  end if;

  if not coalesce(v_allowed, false) then
    raise exception 'Partners control capability is required'
      using errcode = '42501';
  end if;
end;
$$;

create or replace function affiliate_private.partners_require_capability(
  p_capability text
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_capability not in ('support', 'risk', 'finance')
    or not affiliate_private.partners_has_capability(p_capability)
  then
    raise exception 'Partners Admin capability is required'
      using errcode = '42501';
  end if;
end;
$$;

-- Account deletion retains required attribution and financial history while
-- removing every direct auth-user/device UUID from retained Partners rows.
alter table affiliate_private.affiliate_link_claims
  add column consumed_by_pseudonym text;
alter table affiliate_private.affiliate_link_claims
  drop constraint affiliate_link_claims_consumption;
alter table affiliate_private.affiliate_link_claims
  add constraint affiliate_link_claims_consumption
  check (
    (
      status = 'consumed'
      and consumed_at is not null
      and (
        (consumed_by_user_id is not null)
        <> (consumed_by_pseudonym is not null)
      )
    )
    or (
      status <> 'consumed'
      and consumed_at is null
      and consumed_by_user_id is null
      and consumed_by_pseudonym is null
    )
  );
alter table affiliate_private.affiliate_link_claims
  add constraint affiliate_link_claims_consumed_pseudonym
  check (
    consumed_by_pseudonym is null
    or consumed_by_pseudonym ~ '^[0-9a-f]{64}$'
  );

alter table affiliate_private.affiliate_attributions
  alter column referred_user_id drop not null;
alter table affiliate_private.affiliate_attributions
  add column referred_user_pseudonym text;
alter table affiliate_private.affiliate_attributions
  add constraint affiliate_attributions_referred_identity
  check (
    (referred_user_id is not null)
    <> (referred_user_pseudonym is not null)
  );
alter table affiliate_private.affiliate_attributions
  add constraint affiliate_attributions_referred_pseudonym
  check (
    referred_user_pseudonym is null
    or referred_user_pseudonym ~ '^[0-9a-f]{64}$'
  );

alter table affiliate_private.affiliate_financial_facts
  alter column referred_user_id drop not null;
alter table affiliate_private.affiliate_financial_facts
  add column referred_user_pseudonym text;
alter table affiliate_private.affiliate_financial_facts
  add constraint affiliate_financial_facts_referred_identity
  check (
    (referred_user_id is not null)
    <> (referred_user_pseudonym is not null)
  );
alter table affiliate_private.affiliate_financial_facts
  add constraint affiliate_financial_facts_referred_pseudonym
  check (
    referred_user_pseudonym is null
    or referred_user_pseudonym ~ '^[0-9a-f]{64}$'
  );

alter table affiliate_private.affiliate_tv_relay_sessions
  alter column device_id drop not null;
alter table affiliate_private.affiliate_tv_relay_sessions
  add column device_pseudonym text;
alter table affiliate_private.affiliate_tv_relay_sessions
  add column consumed_by_pseudonym text;
alter table affiliate_private.affiliate_tv_relay_sessions
  drop constraint affiliate_tv_relay_sessions_consumption;
alter table affiliate_private.affiliate_tv_relay_sessions
  add constraint affiliate_tv_relay_sessions_device_identity
  check (
    (device_id is not null) <> (device_pseudonym is not null)
  );
alter table affiliate_private.affiliate_tv_relay_sessions
  add constraint affiliate_tv_relay_sessions_device_pseudonym
  check (
    device_pseudonym is null
    or device_pseudonym ~ '^[0-9a-f]{64}$'
  );
alter table affiliate_private.affiliate_tv_relay_sessions
  add constraint affiliate_tv_relay_sessions_consumed_pseudonym
  check (
    consumed_by_pseudonym is null
    or consumed_by_pseudonym ~ '^[0-9a-f]{64}$'
  );
alter table affiliate_private.affiliate_tv_relay_sessions
  add constraint affiliate_tv_relay_sessions_consumption
  check (
    (
      status = 'consumed'
      and destination = 'partners'
      and consumed_at is not null
      and (
        (consumed_by_user_id is not null)
        <> (consumed_by_pseudonym is not null)
      )
    )
    or (
      status <> 'consumed'
      and destination is null
      and consumed_at is null
      and consumed_by_user_id is null
      and consumed_by_pseudonym is null
    )
  );

create index affiliate_link_claims_consumed_pseudonym_idx
  on affiliate_private.affiliate_link_claims (consumed_by_pseudonym)
  where consumed_by_pseudonym is not null;
create index affiliate_attributions_referred_pseudonym_idx
  on affiliate_private.affiliate_attributions (referred_user_pseudonym)
  where referred_user_pseudonym is not null;
create index affiliate_financial_facts_referred_pseudonym_idx
  on affiliate_private.affiliate_financial_facts (
    referred_user_pseudonym,
    occurred_at desc
  )
  where referred_user_pseudonym is not null;

create or replace function
affiliate_private.partners_user_deletion_pseudonym(p_user_id uuid)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select encode(
    extensions.digest(
      'norva-partners-subject:v1:' || p_user_id::text,
      'sha256'
    ),
    'hex'
  );
$$;

create or replace function
affiliate_private.partners_device_deletion_pseudonym(p_device_id uuid)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select encode(
    extensions.digest(
      'norva-partners-device:v1:' || p_device_id::text,
      'sha256'
    ),
    'hex'
  );
$$;

-- Terminal claims accept exactly one server-only privacy transition. Every
-- business field remains byte-for-byte identical.
create or replace function affiliate_private.guard_link_claim_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'referral claims are retained'
      using errcode = '55000';
  end if;

  if tg_op = 'UPDATE'
    and current_setting('norva.partners_account_delete', true)
      = 'server_prepare_v1'
    and old.consumed_by_user_id is not null
    and new.consumed_by_user_id is null
    and old.consumed_by_pseudonym is null
    and new.consumed_by_pseudonym =
      affiliate_private.partners_user_deletion_pseudonym(
        old.consumed_by_user_id
      )
    and (
      to_jsonb(new)
        - 'consumed_by_user_id'
        - 'consumed_by_pseudonym'
    ) = (
      to_jsonb(old)
        - 'consumed_by_user_id'
        - 'consumed_by_pseudonym'
    )
  then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id
      or new.claim_hash is distinct from old.claim_hash
      or new.link_id is distinct from old.link_id
      or new.referrer_account_id is distinct from old.referrer_account_id
      or new.program_version_id is distinct from old.program_version_id
      or new.commission_rate_bps is distinct from old.commission_rate_bps
      or new.attribution_window_days
        is distinct from old.attribution_window_days
      or new.network_hash is distinct from old.network_hash
      or new.user_agent_hash is distinct from old.user_agent_hash
      or new.campaign_key is distinct from old.campaign_key
      or new.issued_at is distinct from old.issued_at
      or new.expires_at is distinct from old.expires_at
      or new.created_at is distinct from old.created_at
    then
      raise exception 'referral claim identity is immutable'
        using errcode = '55000';
    end if;

    if old.status <> 'pending'
      and (
        new.status is distinct from old.status
        or new.rejection_reason is distinct from old.rejection_reason
        or new.consumed_at is distinct from old.consumed_at
        or new.consumed_by_user_id is distinct from old.consumed_by_user_id
        or new.consumed_by_pseudonym
          is distinct from old.consumed_by_pseudonym
      )
    then
      raise exception 'terminal referral claim is immutable'
        using errcode = '55000';
    end if;
    if old.status = 'pending'
      and new.status not in (
        'pending',
        'consumed',
        'expired',
        'rejected'
      )
    then
      raise exception 'invalid referral claim transition'
        using errcode = '55000';
    end if;
  elsif new.status <> 'pending' then
    raise exception 'new referral claims must start pending'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create or replace function affiliate_private.guard_attribution_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_setting('norva.partners_account_delete', true)
      = 'server_prepare_v1'
    and old.referred_user_id is not null
    and new.referred_user_id is null
    and old.referred_user_pseudonym is null
    and new.referred_user_pseudonym =
      affiliate_private.partners_user_deletion_pseudonym(
        old.referred_user_id
      )
    and (
      to_jsonb(new)
        - 'referred_user_id'
        - 'referred_user_pseudonym'
    ) = (
      to_jsonb(old)
        - 'referred_user_id'
        - 'referred_user_pseudonym'
    )
  then
    return new;
  end if;

  if new.id is distinct from old.id
    or new.referred_user_id is distinct from old.referred_user_id
    or new.referred_user_pseudonym
      is distinct from old.referred_user_pseudonym
    or new.referrer_account_id is distinct from old.referrer_account_id
    or new.link_id is distinct from old.link_id
    or new.claim_id is distinct from old.claim_id
    or new.program_version_id is distinct from old.program_version_id
    or new.commission_rate_bps is distinct from old.commission_rate_bps
    or new.attribution_window_days
      is distinct from old.attribution_window_days
    or new.attributed_at is distinct from old.attributed_at
    or new.created_at is distinct from old.created_at
  then
    raise exception 'affiliate attribution identity is immutable'
      using errcode = '55000';
  end if;

  if old.status <> new.status
    and not (
      (old.status = 'attributed'
        and new.status in ('qualified', 'held', 'blocked', 'reversed'))
      or (old.status = 'qualified'
        and new.status in ('held', 'blocked', 'reversed'))
      or (old.status = 'held'
        and new.status in ('qualified', 'blocked', 'reversed'))
      or (old.status = 'blocked' and new.status = 'reversed')
    )
  then
    raise exception 'invalid attribution transition'
      using errcode = '55000';
  end if;

  return new;
end;
$$;

create or replace function affiliate_private.reject_partners_finance_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_table_name = 'affiliate_financial_facts'
    and tg_op = 'UPDATE'
    and current_setting('norva.partners_account_delete', true)
      = 'server_prepare_v1'
    and old.referred_user_id is not null
    and new.referred_user_id is null
    and old.referred_user_pseudonym is null
    and new.referred_user_pseudonym =
      affiliate_private.partners_user_deletion_pseudonym(
        old.referred_user_id
      )
    and (
      to_jsonb(new)
        - 'referred_user_id'
        - 'referred_user_pseudonym'
    ) = (
      to_jsonb(old)
        - 'referred_user_id'
        - 'referred_user_pseudonym'
    )
  then
    return new;
  end if;

  raise exception 'Partners financial records are append-only'
    using errcode = '55000';
end;
$$;

create or replace function
affiliate_private.guard_tv_relay_session_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_device_unlinked boolean := false;
  v_consumer_unlinked boolean := false;
  v_device_unchanged boolean := false;
  v_consumer_unchanged boolean := false;
begin
  if tg_op = 'DELETE' then
    raise exception 'TV relay sessions are retained'
      using errcode = '55000';
  end if;

  if tg_op = 'UPDATE'
    and current_setting('norva.partners_account_delete', true)
      = 'server_prepare_v1'
  then
    v_device_unlinked :=
      old.device_id is not null
      and new.device_id is null
      and old.device_pseudonym is null
      and new.device_pseudonym =
        affiliate_private.partners_device_deletion_pseudonym(old.device_id);
    v_consumer_unlinked :=
      old.consumed_by_user_id is not null
      and new.consumed_by_user_id is null
      and old.consumed_by_pseudonym is null
      and new.consumed_by_pseudonym =
        affiliate_private.partners_user_deletion_pseudonym(
          old.consumed_by_user_id
        );
    v_device_unchanged :=
      new.device_id is not distinct from old.device_id
      and new.device_pseudonym is not distinct from old.device_pseudonym;
    v_consumer_unchanged :=
      new.consumed_by_user_id is not distinct from old.consumed_by_user_id
      and new.consumed_by_pseudonym
        is not distinct from old.consumed_by_pseudonym;

    if (v_device_unlinked or v_consumer_unlinked)
      and (v_device_unlinked or v_device_unchanged)
      and (v_consumer_unlinked or v_consumer_unchanged)
      and (
        to_jsonb(new)
          - 'device_id'
          - 'device_pseudonym'
          - 'consumed_by_user_id'
          - 'consumed_by_pseudonym'
      ) = (
        to_jsonb(old)
          - 'device_id'
          - 'device_pseudonym'
          - 'consumed_by_user_id'
          - 'consumed_by_pseudonym'
      )
    then
      return new;
    end if;
  end if;

  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id
      or new.session_key is distinct from old.session_key
      or new.device_id is distinct from old.device_id
      or new.device_pseudonym is distinct from old.device_pseudonym
      or new.device_token_hash is distinct from old.device_token_hash
      or new.relay_token_hash is distinct from old.relay_token_hash
      or new.request_nonce_hash is distinct from old.request_nonce_hash
      or new.expires_at is distinct from old.expires_at
      or new.created_at is distinct from old.created_at
    then
      raise exception 'TV relay identity is immutable'
        using errcode = '55000';
    end if;
    if old.status <> 'pending'
      or new.status not in ('consumed', 'expired', 'revoked')
    then
      raise exception 'TV relay session is terminal'
        using errcode = '55000';
    end if;
  elsif new.status <> 'pending'
    or new.destination is not null
    or new.consumed_by_user_id is not null
    or new.consumed_by_pseudonym is not null
    or new.consumed_at is not null
  then
    raise exception 'new TV relay must start pending'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function affiliate_private.partners_tv_relay_enabled()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    coalesce((
      select f.enabled
      from public.admin_feature_flags f
      where f.key = 'partners_enabled'
    ), false)
    and coalesce((
      select f.enabled
      from public.admin_feature_flags f
      where f.key = 'partners_tv_relay_enabled'
    ), false)
    and affiliate_private.release_gates_satisfied(
      array['tv_relay_security_verified']::text[]
    );
$$;

create or replace function
affiliate_private.partners_service_tv_relay_availability(
  p_device_hash text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_device_hash text := lower(btrim(coalesce(p_device_hash, '')));
begin
  if v_device_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid TV device credential'
      using errcode = '22023';
  end if;
  if not exists (
    select 1
    from public.cloud_devices d
    where d.device_token_hash = v_device_hash
      and d.device_type = 'tv'
      and not d.revoked
  ) then
    raise exception 'TV device is unavailable'
      using errcode = 'P0006';
  end if;
  return jsonb_build_object(
    'schema_version', 1,
    'availability', jsonb_build_object(
      'enabled', affiliate_private.partners_tv_relay_enabled(),
      'reason', case
        when affiliate_private.partners_tv_relay_enabled()
          then 'available'
        else 'feature_disabled'
      end
    )
  );
end;
$$;

create or replace function affiliate_private.partners_service_tv_relay_create(
  p_device_hash text,
  p_relay_token_hash text,
  p_request_nonce_hash text,
  p_expires_at timestamptz
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_device_hash text := lower(btrim(coalesce(p_device_hash, '')));
  v_token_hash text := lower(btrim(coalesce(p_relay_token_hash, '')));
  v_nonce_hash text := lower(btrim(coalesce(p_request_nonce_hash, '')));
  v_device public.cloud_devices%rowtype;
  v_existing affiliate_private.affiliate_tv_relay_sessions%rowtype;
  v_session affiliate_private.affiliate_tv_relay_sessions%rowtype;
begin
  if v_device_hash !~ '^[0-9a-f]{64}$'
    or v_token_hash !~ '^[0-9a-f]{64}$'
    or v_nonce_hash !~ '^[0-9a-f]{64}$'
    or p_expires_at is null
    or p_expires_at < now() + interval '2 minutes'
    or p_expires_at > now() + interval '10 minutes'
  then
    raise exception 'invalid TV relay request'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('norva:partners:tv:' || v_device_hash, 0)
  );
  select d.*
  into v_device
  from public.cloud_devices d
  where d.device_token_hash = v_device_hash
    and d.device_type = 'tv'
    and not d.revoked
  for update;
  if not found then
    raise exception 'TV device is unavailable'
      using errcode = 'P0006';
  end if;
  if not affiliate_private.partners_tv_relay_enabled() then
    raise exception 'TV relay is disabled'
      using errcode = 'P0001';
  end if;

  select s.*
  into v_existing
  from affiliate_private.affiliate_tv_relay_sessions s
  where s.request_nonce_hash = v_nonce_hash;
  if found then
    if v_existing.device_id <> v_device.id
      or v_existing.device_token_hash <> v_device_hash
      or v_existing.relay_token_hash <> v_token_hash
      or v_existing.expires_at is distinct from p_expires_at
    then
      raise exception 'TV relay nonce payload conflict'
        using errcode = 'P0003';
    end if;
    return jsonb_build_object(
      'schema_version', 1,
      'action', 'tv_relay_created',
      'relay', jsonb_build_object(
        'status', case
          when v_existing.status = 'pending'
            and v_existing.expires_at <= now() then 'expired'
          else v_existing.status
        end,
        'expires_at', v_existing.expires_at,
        'poll_after_seconds', 3
      )
    );
  end if;

  update affiliate_private.affiliate_tv_relay_sessions
  set
    status = 'expired',
    updated_at = now()
  where device_id = v_device.id
    and status = 'pending'
    and expires_at <= now();

  if exists (
    select 1
    from affiliate_private.affiliate_tv_relay_sessions s
    where s.device_id = v_device.id
      and s.status = 'pending'
  ) then
    raise exception 'TV relay is already pending'
      using errcode = 'P0004';
  end if;
  if exists (
    select 1
    from affiliate_private.affiliate_tv_relay_sessions s
    where s.relay_token_hash = v_token_hash
  ) then
    raise exception 'TV relay token was already used'
      using errcode = 'P0003';
  end if;

  insert into affiliate_private.affiliate_tv_relay_sessions (
    device_id,
    device_token_hash,
    relay_token_hash,
    request_nonce_hash,
    expires_at
  )
  values (
    v_device.id,
    v_device_hash,
    v_token_hash,
    v_nonce_hash,
    p_expires_at
  )
  returning * into v_session;

  insert into affiliate_private.affiliate_events (
    aggregate_type,
    aggregate_key,
    action,
    actor_type,
    justification,
    after_state
  )
  values (
    'tv_relay',
    v_session.session_key,
    'tv_relay_created',
    'service',
    'Temporary TV-to-phone Partners relay was created.',
    jsonb_build_object(
      'status', 'pending',
      'expires_at', v_session.expires_at
    )
  );

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'tv_relay_created',
    'relay', jsonb_build_object(
      'status', 'pending',
      'expires_at', v_session.expires_at,
      'poll_after_seconds', 3
    )
  );
end;
$$;

create or replace function affiliate_private.partners_service_tv_relay_status(
  p_device_hash text,
  p_relay_token_hash text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_device_hash text := lower(btrim(coalesce(p_device_hash, '')));
  v_token_hash text := lower(btrim(coalesce(p_relay_token_hash, '')));
  v_session affiliate_private.affiliate_tv_relay_sessions%rowtype;
  v_status text;
  v_destination text;
begin
  if v_device_hash !~ '^[0-9a-f]{64}$'
    or v_token_hash !~ '^[0-9a-f]{64}$'
  then
    raise exception 'invalid TV relay status request'
      using errcode = '22023';
  end if;
  if not exists (
    select 1
    from public.cloud_devices d
    where d.device_token_hash = v_device_hash
      and d.device_type = 'tv'
      and not d.revoked
  ) then
    raise exception 'TV device is unavailable'
      using errcode = 'P0006';
  end if;

  select s.*
  into v_session
  from affiliate_private.affiliate_tv_relay_sessions s
  where s.device_token_hash = v_device_hash
    and s.relay_token_hash = v_token_hash
  for update;
  if not found then
    raise exception 'TV relay is unavailable'
      using errcode = 'P0006';
  end if;

  if v_session.status = 'pending' and v_session.expires_at <= now() then
    update affiliate_private.affiliate_tv_relay_sessions
    set status = 'expired', updated_at = now()
    where id = v_session.id
    returning * into v_session;
  end if;
  if not affiliate_private.partners_tv_relay_enabled() then
    v_status := 'expired';
    v_destination := null;
  else
    v_status := case
      when v_session.status = 'consumed' then 'consumed'
      when v_session.status = 'pending' then 'pending'
      else 'expired'
    end;
    v_destination := case
      when v_status = 'consumed' then 'partners'
      else null
    end;
  end if;

  return jsonb_build_object(
    'schema_version', 1,
    'relay', jsonb_build_object(
      'status', v_status,
      'destination', v_destination,
      'poll_after_seconds', 3
    )
  );
end;
$$;

create or replace function affiliate_private.partners_service_tv_relay_consume(
  p_user_id uuid,
  p_relay_token_hash text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_token_hash text := lower(btrim(coalesce(p_relay_token_hash, '')));
  v_request_hash text;
  v_replay jsonb;
  v_response jsonb;
  v_session affiliate_private.affiliate_tv_relay_sessions%rowtype;
begin
  if p_user_id is null
    or v_token_hash !~ '^[0-9a-f]{64}$'
    or p_idempotency_key is null
    or p_idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$'
  then
    raise exception 'invalid TV relay consumption request'
      using errcode = '22023';
  end if;
  if not exists (
    select 1 from auth.users u where u.id = p_user_id
  ) then
    raise exception 'authenticated user is unavailable'
      using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('norva:partners:tv-token:' || v_token_hash, 0)
  );
  v_request_hash := encode(
    extensions.digest(
      concat_ws(
        chr(31),
        'tv_relay_consume:v1',
        p_user_id::text,
        v_token_hash
      ),
      'sha256'
    ),
    'hex'
  );
  v_replay := affiliate_private.partners_replayed_response(
    'tv_relay_consume',
    p_user_id,
    p_idempotency_key,
    v_request_hash
  );
  if v_replay is not null then
    return v_replay;
  end if;
  if not affiliate_private.partners_tv_relay_enabled() then
    raise exception 'TV relay is disabled'
      using errcode = 'P0001';
  end if;

  select s.*
  into v_session
  from affiliate_private.affiliate_tv_relay_sessions s
  join public.cloud_devices d on d.id = s.device_id
  where s.relay_token_hash = v_token_hash
    and d.user_id = p_user_id
    and d.device_type = 'tv'
    and not d.revoked
  for update of s;
  if not found then
    raise exception 'TV relay is unavailable'
      using errcode = 'P0006';
  end if;
  if v_session.status <> 'pending' then
    raise exception 'TV relay is already terminal'
      using errcode = 'P0004';
  end if;
  if v_session.expires_at <= now() then
    raise exception 'TV relay is unavailable'
      using errcode = 'P0006';
  end if;

  update affiliate_private.affiliate_tv_relay_sessions
  set
    status = 'consumed',
    destination = 'partners',
    consumed_by_user_id = p_user_id,
    consumed_at = now(),
    updated_at = now()
  where id = v_session.id
  returning * into v_session;

  v_response := jsonb_build_object(
    'schema_version', 1,
    'action', 'tv_relay_consumed',
    'replayed', false,
    'relay', jsonb_build_object(
      'status', 'consumed',
      'destination', 'partners'
    )
  );
  perform affiliate_private.partners_store_response(
    'tv_relay_consume',
    p_user_id,
    p_idempotency_key,
    v_request_hash,
    v_response
  );
  return v_response;
end;
$$;

create or replace function affiliate_private.partners_worker_heartbeat(
  p_worker_name text,
  p_status text,
  p_details jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_worker text := lower(btrim(coalesce(p_worker_name, '')));
  v_status text := lower(btrim(coalesce(p_status, '')));
  v_details jsonb := coalesce(p_details, '{}'::jsonb);
begin
  if v_worker not in (
    'commission', 'maturation', 'reconciliation', 'payout'
  )
    or v_status not in ('healthy', 'degraded', 'blocked')
    or jsonb_typeof(v_details) <> 'object'
    or v_details ?| array[
      'email', 'token', 'secret', 'payload', 'user_id', 'account_id'
    ]::text[]
  then
    raise exception 'invalid worker heartbeat'
      using errcode = '22023';
  end if;
  insert into affiliate_private.affiliate_worker_heartbeats (
    worker_name,
    status,
    last_seen_at,
    details,
    updated_at
  )
  values (v_worker, v_status, now(), v_details, now())
  on conflict (worker_name) do update
  set
    status = excluded.status,
    last_seen_at = excluded.last_seen_at,
    details = excluded.details,
    updated_at = now();
  return jsonb_build_object(
    'schema_version', 1,
    'action', 'worker_heartbeat_recorded',
    'worker', v_worker,
    'status', v_status
  );
end;
$$;

create or replace function affiliate_private.admin_partners_capabilities()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'admin access required'
      using errcode = '42501';
  end if;
  return jsonb_build_object(
    'schema_version', 1,
    'can_manage',
      affiliate_private.partners_can_manage_capabilities(),
    'can_manage_release',
      affiliate_private.partners_is_release_manager(),
    'capabilities', jsonb_build_object(
      'support', affiliate_private.partners_has_capability('support'),
      'risk', affiliate_private.partners_has_capability('risk'),
      'finance', affiliate_private.partners_has_capability('finance')
    )
  );
end;
$$;

create or replace function affiliate_private.admin_partners_capability_set(
  p_user_id uuid,
  p_capability text,
  p_enabled boolean,
  p_justification text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_capability text := lower(btrim(coalesce(p_capability, '')));
  v_justification text := btrim(coalesce(p_justification, ''));
  v_actor text;
begin
  if not affiliate_private.partners_can_manage_capabilities() then
    raise exception 'Partners capability manager role is required'
      using errcode = '42501';
  end if;
  if p_user_id is null
    or v_capability not in ('support', 'risk', 'finance')
    or p_enabled is null
    or length(v_justification) not between 12 and 1000
  then
    raise exception 'invalid capability mutation'
      using errcode = '22023';
  end if;
  if not exists (select 1 from auth.users u where u.id = p_user_id) then
    raise exception 'capability subject is unavailable'
      using errcode = 'P0002';
  end if;
  v_actor := affiliate_private.partners_admin_actor_pseudonym();
  insert into affiliate_private.affiliate_admin_capabilities (
    user_id,
    capability,
    enabled,
    granted_by_pseudonym,
    justification,
    updated_at
  )
  values (
    p_user_id,
    v_capability,
    p_enabled,
    v_actor,
    v_justification,
    now()
  )
  on conflict (user_id, capability) do update
  set
    enabled = excluded.enabled,
    granted_by_pseudonym = excluded.granted_by_pseudonym,
    justification = excluded.justification,
    updated_at = now();

  insert into affiliate_private.affiliate_events (
    aggregate_type,
    aggregate_key,
    action,
    actor_type,
    actor_pseudonym,
    justification,
    after_state
  )
  values (
    'admin_capability',
    encode(
      extensions.digest(
        'norva:partners:admin-subject:v1:' || p_user_id::text,
        'sha256'
      ),
      'hex'
    ),
    'admin_capability_set',
    'admin',
    v_actor,
    v_justification,
    jsonb_build_object(
      'capability', v_capability,
      'enabled', p_enabled
    )
  );
  return jsonb_build_object(
    'schema_version', 1,
    'action', 'admin_capability_set',
    'capability', v_capability,
    'enabled', p_enabled
  );
end;
$$;

create or replace function
affiliate_private.partners_account_deletion_ready(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_user_id is not null
    and not exists (
      select 1
      from affiliate_private.affiliate_accounts a
      where a.user_id = p_user_id
    )
    and not exists (
      select 1
      from affiliate_private.affiliate_link_claims c
      where c.consumed_by_user_id = p_user_id
    )
    and not exists (
      select 1
      from affiliate_private.affiliate_attributions a
      where a.referred_user_id = p_user_id
    )
    and not exists (
      select 1
      from affiliate_private.affiliate_financial_facts f
      where f.referred_user_id = p_user_id
    )
    and not exists (
      select 1
      from affiliate_private.affiliate_tv_relay_sessions s
      where s.consumed_by_user_id = p_user_id
    )
    and not exists (
      select 1
      from affiliate_private.affiliate_tv_relay_sessions s
      join public.cloud_devices d on d.id = s.device_id
      where d.user_id = p_user_id
    )
    and not exists (
      select 1
      from affiliate_private.affiliate_admin_capabilities c
      where c.user_id = p_user_id
    )
    and not exists (
      select 1
      from affiliate_private.affiliate_pilot_allowlist a
      where a.user_id = p_user_id
    )
    and not exists (
      select 1
      from affiliate_private.affiliate_service_idempotency i
      where i.user_id = p_user_id
    );
$$;

create or replace function
affiliate_private.partners_service_prepare_account_deletion(p_user_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_pseudonym text;
  v_account affiliate_private.affiliate_accounts%rowtype;
  v_rows integer := 0;
  v_changes integer := 0;
  v_accounts_closed integer := 0;
  v_referred_records integer := 0;
  v_ready boolean := false;
begin
  if p_user_id is null then
    raise exception 'account deletion user is required'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:account-delete:' || p_user_id::text,
      0
    )
  );
  perform 1
  from auth.users u
  where u.id = p_user_id
  for update;
  if not found then
    raise exception 'account deletion user is unavailable'
      using errcode = 'P0002';
  end if;

  v_user_pseudonym :=
    affiliate_private.partners_user_deletion_pseudonym(p_user_id);
  perform set_config(
    'norva.partners_account_delete',
    'server_prepare_v1',
    true
  );

  for v_account in
    select a.*
    from affiliate_private.affiliate_accounts a
    where a.user_id = p_user_id
    order by a.created_at, a.id
    for update
  loop
    update affiliate_private.affiliate_links
    set
      status = 'revoked',
      revoked_at = coalesce(revoked_at, now())
    where account_id = v_account.id
      and status = 'active';
    get diagnostics v_rows = row_count;
    v_changes := v_changes + v_rows;

    update affiliate_private.affiliate_payout_profiles
    set
      beneficiary_token_ref =
        'deleted_' || left(v_account.user_pseudonym, 48),
      display_masked = 'Deleted account',
      status = 'disabled',
      updated_at = now()
    where account_id = v_account.id
      and (
        beneficiary_token_ref
          <> 'deleted_' || left(v_account.user_pseudonym, 48)
        or display_masked <> 'Deleted account'
        or status <> 'disabled'
      );
    get diagnostics v_rows = row_count;
    v_changes := v_changes + v_rows;

    update affiliate_private.affiliate_fiscal_profiles
    set
      status = 'expired',
      verification_provider = null,
      verification_reference_hash = null,
      tax_form_type = null,
      reviewed_at = null,
      updated_at = now()
    where account_id = v_account.id
      and (
        status <> 'expired'
        or verification_provider is not null
        or verification_reference_hash is not null
        or tax_form_type is not null
        or reviewed_at is not null
      );
    get diagnostics v_rows = row_count;
    v_changes := v_changes + v_rows;

    update affiliate_private.affiliate_accounts
    set
      user_id = null,
      status = 'closed',
      program_version_id = null,
      country_policy_id = null,
      country_code = null,
      subdivision_code = null,
      verification_status = 'expired',
      verification_provider = null,
      verification_reference = null,
      age_verified = false,
      capacity_verified = false,
      contract_status = 'expired',
      terms_version_accepted = null,
      contract_accepted_at = null,
      disclosure_version_accepted = null,
      disclosure_accepted_at = null,
      updated_at = now(),
      closed_at = coalesce(closed_at, now())
    where id = v_account.id;
    get diagnostics v_rows = row_count;
    v_changes := v_changes + v_rows;
    v_accounts_closed := v_accounts_closed + v_rows;
  end loop;

  delete from affiliate_private.affiliate_pilot_allowlist
  where user_id = p_user_id;
  get diagnostics v_rows = row_count;
  v_changes := v_changes + v_rows;

  delete from affiliate_private.affiliate_service_idempotency
  where user_id = p_user_id;
  get diagnostics v_rows = row_count;
  v_changes := v_changes + v_rows;

  delete from affiliate_private.affiliate_admin_capabilities
  where user_id = p_user_id;
  get diagnostics v_rows = row_count;
  v_changes := v_changes + v_rows;

  update affiliate_private.affiliate_link_claims
  set
    consumed_by_user_id = null,
    consumed_by_pseudonym = v_user_pseudonym
  where consumed_by_user_id = p_user_id;
  get diagnostics v_rows = row_count;
  v_changes := v_changes + v_rows;
  v_referred_records := v_referred_records + v_rows;

  update affiliate_private.affiliate_attributions
  set
    referred_user_id = null,
    referred_user_pseudonym = v_user_pseudonym
  where referred_user_id = p_user_id;
  get diagnostics v_rows = row_count;
  v_changes := v_changes + v_rows;
  v_referred_records := v_referred_records + v_rows;

  update affiliate_private.affiliate_financial_facts
  set
    referred_user_id = null,
    referred_user_pseudonym = v_user_pseudonym
  where referred_user_id = p_user_id;
  get diagnostics v_rows = row_count;
  v_changes := v_changes + v_rows;
  v_referred_records := v_referred_records + v_rows;

  -- Pending relays owned by one of the user's devices are revoked through the
  -- normal state machine before the retained device reference is pseudonymized.
  update affiliate_private.affiliate_tv_relay_sessions s
  set
    status = 'revoked',
    updated_at = now()
  where s.status = 'pending'
    and exists (
      select 1
      from public.cloud_devices d
      where d.id = s.device_id
        and d.user_id = p_user_id
    );
  get diagnostics v_rows = row_count;
  v_changes := v_changes + v_rows;

  update affiliate_private.affiliate_tv_relay_sessions s
  set
    device_id = null,
    device_pseudonym =
      affiliate_private.partners_device_deletion_pseudonym(s.device_id)
  where exists (
    select 1
    from public.cloud_devices d
    where d.id = s.device_id
      and d.user_id = p_user_id
  );
  get diagnostics v_rows = row_count;
  v_changes := v_changes + v_rows;

  update affiliate_private.affiliate_tv_relay_sessions
  set
    consumed_by_user_id = null,
    consumed_by_pseudonym = v_user_pseudonym
  where consumed_by_user_id = p_user_id;
  get diagnostics v_rows = row_count;
  v_changes := v_changes + v_rows;
  v_referred_records := v_referred_records + v_rows;

  v_ready :=
    affiliate_private.partners_account_deletion_ready(p_user_id);
  if not v_ready then
    raise exception 'Partners account deletion preparation is incomplete'
      using errcode = '55000';
  end if;

  if v_changes > 0 then
    insert into affiliate_private.affiliate_events (
      aggregate_type,
      aggregate_key,
      action,
      actor_type,
      actor_pseudonym,
      justification,
      after_state
    )
    values (
      'account',
      v_user_pseudonym,
      'account_deletion_prepared',
      'service',
      null,
      'Retained Partners records were minimized before auth deletion.',
      jsonb_build_object(
        'accounts_closed', v_accounts_closed,
        'referred_records_pseudonymized', v_referred_records
      )
    );
  end if;

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'partners_account_deletion_prepared',
    'ready', true,
    'changed', v_changes > 0,
    'accounts_closed', v_accounts_closed,
    'referred_records_pseudonymized', v_referred_records
  );
end;
$$;

create or replace function
affiliate_private.guard_affiliate_auth_user_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if not affiliate_private.partners_account_deletion_ready(old.id) then
      raise exception
        'prepare Partners records before deleting the user'
        using errcode = '55000';
    end if;
    return old;
  end if;

  if old.email_confirmed_at is not null
    and new.email_confirmed_at is null
    and exists (
      select 1
      from affiliate_private.affiliate_accounts a
      where a.user_id = old.id
        and a.status = 'active'
    )
  then
    raise exception 'active Partners accounts require a confirmed email'
      using errcode = '55000';
  end if;

  return new;
end;
$$;

create or replace function affiliate_private.admin_partners_program_create(
  p_version_key text,
  p_payout_thresholds jsonb,
  p_terms_version text,
  p_disclosure_version text,
  p_effective_from timestamptz,
  p_justification text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key text := lower(btrim(coalesce(p_version_key, '')));
  v_terms text := lower(btrim(coalesce(p_terms_version, '')));
  v_disclosure text := lower(btrim(coalesce(p_disclosure_version, '')));
  v_justification text := btrim(coalesce(p_justification, ''));
  v_actor text;
begin
  perform affiliate_private.partners_require_capability('support');
  perform affiliate_private.partners_require_capability('finance');
  if v_key !~ '^[a-z0-9][a-z0-9._-]{2,63}$'
    or v_terms !~ '^[a-z0-9][a-z0-9._-]{2,63}$'
    or v_disclosure !~ '^[a-z0-9][a-z0-9._-]{2,63}$'
    or not affiliate_private.valid_payout_thresholds(p_payout_thresholds)
    or p_effective_from is null
    or p_effective_from < now() - interval '5 minutes'
    or length(v_justification) not between 12 and 1000
  then
    raise exception 'invalid Partners program draft'
      using errcode = '22023';
  end if;
  v_actor := affiliate_private.partners_admin_actor_pseudonym();
  insert into affiliate_private.affiliate_program_versions (
    version_key,
    status,
    commission_rate_bps,
    attribution_window_days,
    maturation_days,
    payout_thresholds,
    terms_version,
    disclosure_version,
    effective_from
  )
  values (
    v_key,
    'draft',
    2000,
    30,
    45,
    p_payout_thresholds,
    v_terms,
    v_disclosure,
    p_effective_from
  );
  insert into affiliate_private.affiliate_events (
    aggregate_type, aggregate_key, action, actor_type,
    actor_pseudonym, justification, after_state
  )
  values (
    'program_version',
    v_key,
    'program_draft_created',
    'admin',
    v_actor,
    v_justification,
    jsonb_build_object(
      'status', 'draft',
      'commission_rate_bps', 2000,
      'attribution_window_days', 30,
      'maturation_days', 45
    )
  );
  return jsonb_build_object(
    'schema_version', 1,
    'action', 'program_draft_created',
    'program', jsonb_build_object(
      'version_key', v_key,
      'status', 'draft'
    )
  );
end;
$$;

create or replace function affiliate_private.admin_partners_program_activate(
  p_version_key text,
  p_confirmation text,
  p_justification text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key text := lower(btrim(coalesce(p_version_key, '')));
  v_confirmation text := btrim(coalesce(p_confirmation, ''));
  v_justification text := btrim(coalesce(p_justification, ''));
  v_actor text;
begin
  perform affiliate_private.partners_require_capability('support');
  perform affiliate_private.partners_require_capability('finance');
  if v_key !~ '^[a-z0-9][a-z0-9._-]{2,63}$'
    or v_confirmation <> 'ACTIVATE:' || v_key
    or length(v_justification) not between 12 and 1000
  then
    raise exception 'invalid program activation confirmation'
      using errcode = '22023';
  end if;
  if not affiliate_private.release_gates_satisfied(
    array['legal_and_tax_approved', 'privacy_approved']::text[]
  ) then
    raise exception 'program legal gates are incomplete'
      using errcode = 'P0001';
  end if;
  v_actor := affiliate_private.partners_admin_actor_pseudonym();
  update affiliate_private.affiliate_program_versions
  set status = 'active', updated_at = now()
  where version_key = v_key
    and status = 'draft';
  if not found then
    raise exception 'program draft is unavailable'
      using errcode = 'P0002';
  end if;
  insert into affiliate_private.affiliate_events (
    aggregate_type, aggregate_key, action, actor_type,
    actor_pseudonym, justification, after_state
  )
  values (
    'program_version',
    v_key,
    'program_activated',
    'admin',
    v_actor,
    v_justification,
    jsonb_build_object('status', 'active')
  );
  return jsonb_build_object(
    'schema_version', 1,
    'action', 'program_activated',
    'program', jsonb_build_object(
      'version_key', v_key,
      'status', 'active'
    )
  );
end;
$$;

create or replace function
affiliate_private.admin_partners_country_policy_create(
  p_program_version_key text,
  p_country_code text,
  p_subdivision_code text,
  p_minimum_age integer,
  p_payout_currencies text[],
  p_effective_from timestamptz,
  p_justification text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_program_key text := lower(
    btrim(coalesce(p_program_version_key, ''))
  );
  v_country text := upper(btrim(coalesce(p_country_code, '')));
  v_subdivision text := nullif(
    upper(btrim(coalesce(p_subdivision_code, ''))),
    ''
  );
  v_justification text := btrim(coalesce(p_justification, ''));
  v_program affiliate_private.affiliate_program_versions%rowtype;
  v_actor text;
begin
  perform affiliate_private.partners_require_capability('support');
  perform affiliate_private.partners_require_capability('risk');
  select p.*
  into v_program
  from affiliate_private.affiliate_program_versions p
  where p.version_key = v_program_key
    and p.status in ('draft', 'active');
  if not found then
    raise exception 'Partners program is unavailable'
      using errcode = 'P0002';
  end if;
  if v_country !~ '^[A-Z]{2}$'
    or (
      v_subdivision is not null
      and v_subdivision !~ '^[A-Z0-9]+(?:-[A-Z0-9]+)*$'
    )
    or p_minimum_age is null
    or p_minimum_age not between 18 and 99
    or not affiliate_private.valid_currency_codes(p_payout_currencies)
    or cardinality(p_payout_currencies) < 1
    or p_effective_from is null
    or p_effective_from < now() - interval '5 minutes'
    or length(v_justification) not between 12 and 1000
  then
    raise exception 'invalid country policy draft'
      using errcode = '22023';
  end if;
  v_actor := affiliate_private.partners_admin_actor_pseudonym();
  insert into affiliate_private.affiliate_country_policies (
    program_version_id,
    country_code,
    subdivision_code,
    individual_available,
    minimum_age,
    capacity_required,
    verification_level,
    verification_provider,
    payout_currencies,
    terms_version,
    disclosure_version,
    effective_from
  )
  values (
    v_program.id,
    v_country,
    v_subdivision,
    false,
    p_minimum_age,
    true,
    'identity_age_country_capacity',
    'didit',
    p_payout_currencies,
    v_program.terms_version,
    v_program.disclosure_version,
    p_effective_from
  );
  insert into affiliate_private.affiliate_events (
    aggregate_type, aggregate_key, action, actor_type,
    actor_pseudonym, justification, after_state
  )
  values (
    'country_policy',
    concat_ws(':', v_program_key, v_country, coalesce(v_subdivision, '*')),
    'country_policy_draft_created',
    'admin',
    v_actor,
    v_justification,
    jsonb_build_object(
      'individual_available', false,
      'country_code', v_country,
      'subdivision_code', v_subdivision
    )
  );
  return jsonb_build_object(
    'schema_version', 1,
    'action', 'country_policy_draft_created',
    'policy', jsonb_build_object(
      'program_version_key', v_program_key,
      'country_code', v_country,
      'subdivision_code', v_subdivision,
      'individual_available', false
    )
  );
end;
$$;

create or replace function
affiliate_private.admin_partners_kyc_attempt_policy_set(
  p_program_version_key text,
  p_country_code text,
  p_subdivision_code text,
  p_max_attempts integer,
  p_window_seconds integer,
  p_cooldown_seconds integer,
  p_status text,
  p_justification text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_program_key text := lower(
    btrim(coalesce(p_program_version_key, ''))
  );
  v_country text := upper(btrim(coalesce(p_country_code, '')));
  v_subdivision text := nullif(
    upper(btrim(coalesce(p_subdivision_code, ''))),
    ''
  );
  v_status text := lower(btrim(coalesce(p_status, '')));
  v_justification text := btrim(coalesce(p_justification, ''));
  v_policy affiliate_private.affiliate_country_policies%rowtype;
  v_actor text;
begin
  perform affiliate_private.partners_require_capability('risk');
  select cp.*
  into v_policy
  from affiliate_private.affiliate_country_policies cp
  join affiliate_private.affiliate_program_versions p
    on p.id = cp.program_version_id
  where p.version_key = v_program_key
    and cp.country_code = v_country
    and cp.subdivision_code is not distinct from v_subdivision;
  if not found then
    raise exception 'country policy is unavailable'
      using errcode = 'P0002';
  end if;
  if p_max_attempts is null
    or p_max_attempts not between 1 and 20
    or p_window_seconds is null
    or p_window_seconds not between 3600 and 2592000
    or p_cooldown_seconds is null
    or p_cooldown_seconds not between 60 and 604800
    or v_status not in ('active', 'disabled')
    or length(v_justification) not between 12 and 1000
  then
    raise exception 'invalid KYC attempt policy'
      using errcode = '22023';
  end if;
  v_actor := affiliate_private.partners_admin_actor_pseudonym();
  insert into affiliate_private.affiliate_kyc_attempt_policies (
    country_policy_id,
    max_attempts,
    window_seconds,
    cooldown_seconds,
    status,
    configured_by_pseudonym,
    justification,
    updated_at
  )
  values (
    v_policy.id,
    p_max_attempts,
    p_window_seconds,
    p_cooldown_seconds,
    v_status,
    v_actor,
    v_justification,
    now()
  )
  on conflict (country_policy_id) do update
  set
    max_attempts = excluded.max_attempts,
    window_seconds = excluded.window_seconds,
    cooldown_seconds = excluded.cooldown_seconds,
    status = excluded.status,
    configured_by_pseudonym = excluded.configured_by_pseudonym,
    justification = excluded.justification,
    updated_at = now();
  insert into affiliate_private.affiliate_events (
    aggregate_type, aggregate_key, action, actor_type,
    actor_pseudonym, justification, after_state
  )
  values (
    'configuration',
    concat_ws(':', 'kyc-attempt', v_program_key, v_country,
      coalesce(v_subdivision, '*')),
    'kyc_attempt_policy_set',
    'admin',
    v_actor,
    v_justification,
    jsonb_build_object(
      'status', v_status,
      'max_attempts', p_max_attempts,
      'window_seconds', p_window_seconds,
      'cooldown_seconds', p_cooldown_seconds
    )
  );
  return jsonb_build_object(
    'schema_version', 1,
    'action', 'kyc_attempt_policy_set',
    'status', v_status
  );
end;
$$;

create or replace function
affiliate_private.admin_partners_country_mapping_set(
  p_iso3 text,
  p_country_code text,
  p_status text,
  p_justification text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_iso3 text := upper(btrim(coalesce(p_iso3, '')));
  v_country text := upper(btrim(coalesce(p_country_code, '')));
  v_status text := lower(btrim(coalesce(p_status, '')));
  v_justification text := btrim(coalesce(p_justification, ''));
  v_actor text;
begin
  perform affiliate_private.partners_require_capability('risk');
  if v_iso3 !~ '^[A-Z]{3}$'
    or v_country !~ '^[A-Z]{2}$'
    or v_status not in ('active', 'disabled')
    or length(v_justification) not between 12 and 1000
  then
    raise exception 'invalid country-code mapping'
      using errcode = '22023';
  end if;
  v_actor := affiliate_private.partners_admin_actor_pseudonym();
  insert into affiliate_private.affiliate_country_code_mappings (
    iso3,
    country_code,
    status,
    configured_by_pseudonym,
    justification,
    updated_at
  )
  values (
    v_iso3,
    v_country,
    v_status,
    v_actor,
    v_justification,
    now()
  )
  on conflict (iso3) do update
  set
    country_code = excluded.country_code,
    status = excluded.status,
    configured_by_pseudonym = excluded.configured_by_pseudonym,
    justification = excluded.justification,
    updated_at = now();
  return jsonb_build_object(
    'schema_version', 1,
    'action', 'country_mapping_set',
    'status', v_status
  );
end;
$$;

create or replace function affiliate_private.admin_partners_currency_set(
  p_currency text,
  p_exponent integer,
  p_status text,
  p_justification text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_currency text := upper(btrim(coalesce(p_currency, '')));
  v_status text := lower(btrim(coalesce(p_status, '')));
  v_justification text := btrim(coalesce(p_justification, ''));
  v_actor text;
begin
  perform affiliate_private.partners_require_capability('finance');
  if v_currency !~ '^[A-Z]{3}$'
    or p_exponent is null
    or p_exponent not between 0 and 6
    or v_status not in ('active', 'disabled')
    or length(v_justification) not between 12 and 1000
  then
    raise exception 'invalid currency metadata'
      using errcode = '22023';
  end if;
  v_actor := affiliate_private.partners_admin_actor_pseudonym();
  insert into affiliate_private.affiliate_currency_metadata (
    currency_code,
    exponent,
    status,
    configured_by_pseudonym,
    justification,
    updated_at
  )
  values (
    v_currency,
    p_exponent,
    v_status,
    v_actor,
    v_justification,
    now()
  )
  on conflict (currency_code) do update
  set
    exponent = excluded.exponent,
    status = excluded.status,
    configured_by_pseudonym = excluded.configured_by_pseudonym,
    justification = excluded.justification,
    updated_at = now();
  return jsonb_build_object(
    'schema_version', 1,
    'action', 'currency_metadata_set',
    'status', v_status
  );
end;
$$;

create or replace function
affiliate_private.admin_partners_payout_provider_set(
  p_provider text,
  p_country_code text,
  p_currency text,
  p_status text,
  p_justification text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_provider text := lower(btrim(coalesce(p_provider, '')));
  v_country text := upper(btrim(coalesce(p_country_code, '')));
  v_currency text := upper(btrim(coalesce(p_currency, '')));
  v_status text := lower(btrim(coalesce(p_status, '')));
  v_justification text := btrim(coalesce(p_justification, ''));
  v_actor text;
begin
  perform affiliate_private.partners_require_capability('finance');
  if v_provider not in ('wise', 'revolut', 'stripe_connect')
    or v_country !~ '^[A-Z]{2}$'
    or v_currency !~ '^[A-Z]{3}$'
    or v_status not in ('active', 'disabled')
    or length(v_justification) not between 12 and 1000
  then
    raise exception 'invalid payout provider configuration'
      using errcode = '22023';
  end if;
  if v_status = 'active' and not exists (
    select 1
    from affiliate_private.affiliate_currency_metadata c
    where c.currency_code = v_currency
      and c.status = 'active'
  ) then
    raise exception 'active currency metadata is required'
      using errcode = 'P0001';
  end if;
  v_actor := affiliate_private.partners_admin_actor_pseudonym();
  insert into affiliate_private.affiliate_payout_provider_configs (
    provider,
    country_code,
    currency,
    status,
    configured_by_pseudonym,
    justification,
    updated_at
  )
  values (
    v_provider,
    v_country,
    v_currency,
    v_status,
    v_actor,
    v_justification,
    now()
  )
  on conflict (provider, country_code, currency) do update
  set
    status = excluded.status,
    configured_by_pseudonym = excluded.configured_by_pseudonym,
    justification = excluded.justification,
    updated_at = now();
  return jsonb_build_object(
    'schema_version', 1,
    'action', 'payout_provider_set',
    'status', v_status
  );
end;
$$;

create or replace function
affiliate_private.admin_partners_country_policy_set_available(
  p_program_version_key text,
  p_country_code text,
  p_subdivision_code text,
  p_enabled boolean,
  p_confirmation text,
  p_justification text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_program_key text := lower(
    btrim(coalesce(p_program_version_key, ''))
  );
  v_country text := upper(btrim(coalesce(p_country_code, '')));
  v_subdivision text := nullif(
    upper(btrim(coalesce(p_subdivision_code, ''))),
    ''
  );
  v_confirmation text := btrim(coalesce(p_confirmation, ''));
  v_justification text := btrim(coalesce(p_justification, ''));
  v_policy affiliate_private.affiliate_country_policies%rowtype;
  v_program affiliate_private.affiliate_program_versions%rowtype;
  v_actor text;
begin
  perform affiliate_private.partners_require_capability('support');
  perform affiliate_private.partners_require_capability('risk');
  if p_enabled is null
    or v_confirmation <> (
      case
        when p_enabled then 'ENABLE:'
        else 'DISABLE:'
      end
      || v_program_key
      || ':'
      || v_country
      || ':'
      || coalesce(v_subdivision, '*')
    )
    or length(v_justification) not between 12 and 1000
  then
    raise exception 'invalid country policy confirmation'
      using errcode = '22023';
  end if;

  select cp.*
  into v_policy
  from affiliate_private.affiliate_country_policies cp
  join affiliate_private.affiliate_program_versions p
    on p.id = cp.program_version_id
  where p.version_key = v_program_key
    and cp.country_code = v_country
    and cp.subdivision_code is not distinct from v_subdivision
  for update of cp;
  if not found then
    raise exception 'country policy is unavailable'
      using errcode = 'P0002';
  end if;
  select p.*
  into strict v_program
  from affiliate_private.affiliate_program_versions p
  where p.id = v_policy.program_version_id;

  if p_enabled and (
    v_program.status <> 'active'
    or v_program.effective_from > now()
    or v_policy.effective_from > now()
    or not exists (
      select 1
      from affiliate_private.affiliate_kyc_attempt_policies ap
      where ap.country_policy_id = v_policy.id
        and ap.status = 'active'
    )
    or not exists (
      select 1
      from affiliate_private.affiliate_country_code_mappings m
      where m.country_code = v_country
        and m.status = 'active'
    )
    or exists (
      select 1
      from unnest(v_policy.payout_currencies) c(currency)
      where not exists (
        select 1
        from affiliate_private.affiliate_currency_metadata metadata
        where metadata.currency_code = c.currency
          and metadata.status = 'active'
      )
      or not exists (
        select 1
        from affiliate_private.affiliate_payout_provider_configs provider
        where provider.country_code = v_country
          and provider.currency = c.currency
          and provider.status = 'active'
      )
    )
  ) then
    raise exception 'country policy dependencies are incomplete'
      using errcode = 'P0001';
  end if;

  v_actor := affiliate_private.partners_admin_actor_pseudonym();
  update affiliate_private.affiliate_country_policies
  set individual_available = p_enabled, updated_at = now()
  where id = v_policy.id;
  insert into affiliate_private.affiliate_events (
    aggregate_type, aggregate_key, action, actor_type,
    actor_pseudonym, justification, after_state
  )
  values (
    'country_policy',
    concat_ws(':', v_program_key, v_country, coalesce(v_subdivision, '*')),
    'country_policy_availability_set',
    'admin',
    v_actor,
    v_justification,
    jsonb_build_object('individual_available', p_enabled)
  );
  return jsonb_build_object(
    'schema_version', 1,
    'action', 'country_policy_availability_set',
    'status', case when p_enabled then 'active' else 'disabled' end
  );
end;
$$;

create or replace function affiliate_private.admin_partners_fiscal_review(
  p_account_id uuid,
  p_status text,
  p_residence_country_code text,
  p_provider text,
  p_reference_hash text,
  p_tax_form_type text,
  p_justification text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_status text := lower(btrim(coalesce(p_status, '')));
  v_country text := upper(
    btrim(coalesce(p_residence_country_code, ''))
  );
  v_provider text := nullif(lower(btrim(coalesce(p_provider, ''))), '');
  v_reference text := nullif(
    lower(btrim(coalesce(p_reference_hash, ''))),
    ''
  );
  v_form text := nullif(btrim(coalesce(p_tax_form_type, '')), '');
  v_justification text := btrim(coalesce(p_justification, ''));
  v_account affiliate_private.affiliate_accounts%rowtype;
  v_actor text;
begin
  perform affiliate_private.partners_require_capability('support');
  perform affiliate_private.partners_require_capability('finance');
  select a.*
  into v_account
  from affiliate_private.affiliate_accounts a
  where a.id = p_account_id
    and a.account_type = 'individual'
    and a.status <> 'closed'
  for update;
  if not found then
    raise exception 'Partner account is unavailable'
      using errcode = 'P0002';
  end if;
  if v_status not in ('pending', 'verified', 'rejected', 'expired')
    or v_country <> v_account.country_code
    or (
      v_provider is not null
      and v_provider !~ '^[a-z0-9][a-z0-9._-]{1,63}$'
    )
    or (
      v_reference is not null
      and v_reference !~ '^[0-9a-f]{64}$'
    )
    or (
      v_status = 'verified'
      and (v_provider is null or v_reference is null)
    )
    or length(v_justification) not between 12 and 1000
  then
    raise exception 'invalid fiscal review'
      using errcode = '22023';
  end if;
  v_actor := affiliate_private.partners_admin_actor_pseudonym();
  insert into affiliate_private.affiliate_fiscal_profiles (
    account_id,
    residence_country_code,
    status,
    verification_provider,
    verification_reference_hash,
    tax_form_type,
    reviewed_at,
    updated_at
  )
  values (
    v_account.id,
    v_country,
    v_status,
    v_provider,
    v_reference,
    v_form,
    case when v_status = 'verified' then now() else null end,
    now()
  )
  on conflict (account_id) do update
  set
    residence_country_code = excluded.residence_country_code,
    status = excluded.status,
    verification_provider = excluded.verification_provider,
    verification_reference_hash = excluded.verification_reference_hash,
    tax_form_type = excluded.tax_form_type,
    reviewed_at = excluded.reviewed_at,
    updated_at = now();
  insert into affiliate_private.affiliate_events (
    aggregate_type, aggregate_key, action, actor_type,
    actor_pseudonym, justification, after_state
  )
  values (
    'payout',
    v_account.id::text,
    'fiscal_profile_reviewed',
    'admin',
    v_actor,
    v_justification,
    jsonb_build_object('status', v_status)
  );
  return jsonb_build_object(
    'schema_version', 1,
    'action', 'fiscal_profile_reviewed',
    'status', v_status
  );
end;
$$;

create or replace function affiliate_private.admin_partners_account_action(
  p_account_public_id text,
  p_action text,
  p_confirmation text,
  p_justification text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_public_id text := lower(btrim(coalesce(p_account_public_id, '')));
  v_action text := lower(btrim(coalesce(p_action, '')));
  v_confirmation text := btrim(coalesce(p_confirmation, ''));
  v_justification text := btrim(coalesce(p_justification, ''));
  v_account affiliate_private.affiliate_accounts%rowtype;
  v_target_status text;
  v_actor text;
begin
  perform affiliate_private.partners_require_capability('risk');
  if v_public_id !~ '^prt_[0-9a-f]{24}$'
    or v_action not in ('hold', 'release', 'suspend', 'close')
    or v_confirmation <> upper(v_action) || ':' || v_public_id
    or length(v_justification) not between 12 and 1000
  then
    raise exception 'invalid account action'
      using errcode = '22023';
  end if;
  select a.*
  into v_account
  from affiliate_private.affiliate_accounts a
  where affiliate_private.partners_public_account_id(a) = v_public_id
  for update;
  if not found then
    raise exception 'Partner account is unavailable'
      using errcode = 'P0002';
  end if;

  v_target_status := case v_action
    when 'hold' then 'held'
    when 'suspend' then 'suspended'
    when 'close' then 'closed'
    when 'release' then case
      when v_account.verification_status = 'verified'
        and v_account.contract_status = 'accepted'
        then 'active'
      else 'pending_verification'
    end
  end;
  if v_account.status = v_target_status then
    return jsonb_build_object(
      'schema_version', 1,
      'action', 'account_' || v_action,
      'status', v_target_status,
      'changed', false
    );
  end if;
  if v_action = 'release' and v_account.status <> 'held'
    or v_action = 'hold'
      and v_account.status not in ('pending_verification', 'active', 'suspended')
    or v_action = 'suspend'
      and v_account.status not in ('pending_verification', 'active', 'held')
    or v_action = 'close' and v_account.status = 'closed'
  then
    raise exception 'account action is not allowed from current state'
      using errcode = 'P0001';
  end if;

  v_actor := affiliate_private.partners_admin_actor_pseudonym();
  if v_target_status <> 'active' then
    update affiliate_private.affiliate_links
    set
      status = 'revoked',
      revoked_at = now()
    where account_id = v_account.id
      and status = 'active';
  end if;
  update affiliate_private.affiliate_accounts
  set
    status = v_target_status,
    closed_at = case
      when v_target_status = 'closed' then now()
      else closed_at
    end,
    updated_at = now()
  where id = v_account.id;

  if v_action = 'hold' then
    update affiliate_private.affiliate_attributions
    set status = 'held', decision_reason = 'risk_review', updated_at = now()
    where referrer_account_id = v_account.id
      and status in ('attributed', 'qualified');
  elsif v_action = 'release' then
    update affiliate_private.affiliate_attributions
    set status = 'qualified',
        decision_reason = 'valid_pre_signup_last_click',
        updated_at = now()
    where referrer_account_id = v_account.id
      and status = 'held';
  elsif v_action in ('suspend', 'close') then
    update affiliate_private.affiliate_attributions
    set status = 'blocked', decision_reason = 'risk_review', updated_at = now()
    where referrer_account_id = v_account.id
      and status in ('attributed', 'qualified', 'held');
  end if;

  insert into affiliate_private.affiliate_events (
    aggregate_type, aggregate_key, action, actor_type,
    actor_pseudonym, justification, before_state, after_state
  )
  values (
    'account',
    v_account.id::text,
    'account_' || v_action,
    'admin',
    v_actor,
    v_justification,
    jsonb_build_object('status', v_account.status),
    jsonb_build_object('status', v_target_status)
  );
  return jsonb_build_object(
    'schema_version', 1,
    'action', 'account_' || v_action,
    'status', v_target_status,
    'changed', true
  );
end;
$$;

create or replace function affiliate_private.admin_partners_job_retry(
  p_job_key text,
  p_job_type text,
  p_confirmation text,
  p_justification text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_job_key text := lower(btrim(coalesce(p_job_key, '')));
  v_type text := lower(btrim(coalesce(p_job_type, '')));
  v_confirmation text := btrim(coalesce(p_confirmation, ''));
  v_justification text := btrim(coalesce(p_justification, ''));
  v_actor text;
begin
  perform affiliate_private.partners_require_capability('finance');
  if v_type not in ('commission', 'maturation')
    or (
      v_type = 'commission'
      and v_job_key !~ '^job_[0-9a-f]{24}$'
    )
    or (
      v_type = 'maturation'
      and v_job_key !~ '^mat_[0-9a-f]{24}$'
    )
    or v_confirmation <> 'RETRY:' || v_job_key
    or length(v_justification) not between 12 and 1000
  then
    raise exception 'invalid job retry'
      using errcode = '22023';
  end if;
  if v_type = 'commission' then
    update affiliate_private.affiliate_commission_jobs
    set
      status = 'retry',
      worker_id = null,
      lease_token_hash = null,
      leased_until = null,
      attempts = 0,
      next_attempt_at = now(),
      last_error_code = null,
      completed_at = null,
      updated_at = now()
    where job_key = v_job_key
      and status = 'dead_letter'
      and last_error_code is distinct from 'financial_fact_conflict';
  else
    update affiliate_private.affiliate_maturation_jobs
    set
      status = 'retry',
      worker_id = null,
      lease_token_hash = null,
      leased_until = null,
      attempts = 0,
      next_attempt_at = now(),
      last_error_code = null,
      completed_at = null,
      updated_at = now()
    where job_key = v_job_key
      and status = 'dead_letter';
  end if;
  if not found then
    raise exception 'retryable dead-letter job is unavailable'
      using errcode = 'P0001';
  end if;
  v_actor := affiliate_private.partners_admin_actor_pseudonym();
  insert into affiliate_private.affiliate_events (
    aggregate_type, aggregate_key, action, actor_type,
    actor_pseudonym, justification, after_state
  )
  values (
    'worker',
    v_job_key,
    'dead_letter_retried',
    'admin',
    v_actor,
    v_justification,
    jsonb_build_object('job_type', v_type, 'status', 'retry')
  );
  return jsonb_build_object(
    'schema_version', 1,
    'action', 'dead_letter_retried',
    'status', 'retry'
  );
end;
$$;

create or replace function
affiliate_private.admin_partners_commission_reverse(
  p_entry_key text,
  p_confirmation text,
  p_justification text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_entry_key text := lower(btrim(coalesce(p_entry_key, '')));
  v_confirmation text := btrim(coalesce(p_confirmation, ''));
  v_justification text := btrim(coalesce(p_justification, ''));
  v_accrual affiliate_private.affiliate_commission_entries%rowtype;
  v_reversal affiliate_private.affiliate_commission_entries%rowtype;
  v_reversed bigint := 0;
  v_amount bigint := 0;
  v_recovery_route jsonb;
  v_actor text;
begin
  perform affiliate_private.partners_require_capability('finance');
  perform affiliate_private.partners_require_capability('risk');
  if v_entry_key !~ '^led_[0-9a-f]{24}$'
    or v_confirmation <> 'REVERSE:' || v_entry_key
    or length(v_justification) not between 12 and 1000
  then
    raise exception 'invalid manual reversal'
      using errcode = '22023';
  end if;
  select e.*
  into v_accrual
  from affiliate_private.affiliate_commission_entries e
  where e.entry_key = v_entry_key
    and e.entry_kind = 'accrual'
  for update;
  if not found then
    raise exception 'accrual entry is unavailable'
      using errcode = 'P0002';
  end if;
  select coalesce(sum(e.amount_minor), 0)
  into v_reversed
  from affiliate_private.affiliate_commission_entries e
  where e.related_entry_id = v_accrual.id
    and e.entry_kind in ('reversal', 'manual_reversal');
  v_amount := greatest(v_accrual.amount_minor - v_reversed, 0);
  if v_amount = 0 then
    raise exception 'accrual has no reversible balance'
      using errcode = 'P0001';
  end if;

  insert into affiliate_private.affiliate_commission_entries (
    account_id,
    attribution_id,
    entry_kind,
    related_entry_id,
    currency,
    currency_exponent,
    amount_minor
  )
  values (
    v_accrual.account_id,
    v_accrual.attribution_id,
    'manual_reversal',
    v_accrual.id,
    v_accrual.currency,
    v_accrual.currency_exponent,
    v_amount
  )
  returning * into v_reversal;
  v_recovery_route :=
    affiliate_private.partners_route_commission_recovery(
      v_reversal.id,
      v_accrual.account_id,
      v_accrual.currency,
      v_amount,
      not exists (
        select 1
        from affiliate_private.affiliate_commission_entries release
        where release.related_entry_id = v_accrual.id
          and release.entry_kind = 'release'
      )
    );
  v_actor := affiliate_private.partners_admin_actor_pseudonym();
  insert into affiliate_private.affiliate_events (
    aggregate_type, aggregate_key, action, actor_type,
    actor_pseudonym, justification, after_state
  )
  values (
    'commission',
    v_reversal.entry_key,
    'manual_commission_reversal',
    'admin',
    v_actor,
    v_justification,
    jsonb_build_object(
      'origin_entry_key', v_accrual.entry_key,
      'amount_minor', v_amount,
      'currency', v_accrual.currency,
      'recovery_route', v_recovery_route
    )
  );
  return jsonb_build_object(
    'schema_version', 1,
    'action', 'manual_commission_reversal',
    'ledger_entry', jsonb_build_object(
      'key', v_reversal.entry_key,
      'status', 'reversed',
      'recovery_route', v_recovery_route
    )
  );
end;
$$;

create or replace function
affiliate_private.admin_partners_payout_cycle_create(
  p_period_start date,
  p_period_end date,
  p_currency text,
  p_live_execution boolean,
  p_confirmation text,
  p_justification text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_currency text := upper(btrim(coalesce(p_currency, '')));
  v_confirmation text := btrim(coalesce(p_confirmation, ''));
  v_justification text := btrim(coalesce(p_justification, ''));
  v_cycle affiliate_private.affiliate_payout_cycles%rowtype;
  v_actor text;
  v_exponent integer;
  v_previous_status text;
  v_promoted boolean := false;
  v_existing boolean := false;
begin
  perform affiliate_private.partners_require_capability('finance');
  if p_period_start is null
    or p_period_end is null
    or p_period_end < p_period_start
    or p_period_end > p_period_start + 35
    or p_period_end >= current_date
    or v_currency !~ '^[A-Z]{3}$'
    or p_live_execution is null
    or v_confirmation <> (
      'CREATE:'
      || p_period_start::text || ':' || p_period_end::text || ':'
      || v_currency || ':'
      || case when p_live_execution then 'LIVE' else 'DRY' end
    )
    or length(v_justification) not between 12 and 1000
  then
    raise exception 'invalid payout cycle request'
      using errcode = '22023';
  end if;
  select c.exponent
  into v_exponent
  from affiliate_private.affiliate_currency_metadata c
  where c.currency_code = v_currency
    and c.status = 'active';
  if not found then
    raise exception 'currency metadata is unavailable'
      using errcode = 'P0001';
  end if;

  v_actor := affiliate_private.partners_admin_actor_pseudonym();
  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:payout-cycle:'
      || p_period_start::text || ':'
      || p_period_end::text || ':'
      || v_currency,
      0
    )
  );

  select cycle.*
  into v_cycle
  from affiliate_private.affiliate_payout_cycles cycle
  where cycle.period_start = p_period_start
    and cycle.period_end = p_period_end
    and cycle.currency = v_currency
  for update;
  v_existing := found;

  if v_existing and v_cycle.live_execution = p_live_execution then
    return jsonb_build_object(
      'schema_version', 1,
      'action', 'payout_cycle_replayed',
      'replayed', true,
      'cycle', jsonb_build_object(
        'key', v_cycle.cycle_key,
        'status', v_cycle.status,
        'live_execution', v_cycle.live_execution,
        'currency', v_cycle.currency,
        'item_count', v_cycle.item_count,
        'total_minor', v_cycle.total_minor
      )
    );
  end if;

  if v_existing and v_cycle.live_execution and not p_live_execution then
    raise exception 'a live payout cycle cannot be demoted'
      using errcode = 'P0001';
  end if;

  if p_live_execution and (
    not coalesce((
      select f.enabled
      from public.admin_feature_flags f
      where f.key = 'partners_payouts_live'
    ), false)
    or not affiliate_private.release_gates_satisfied(
      array[
        'legal_and_tax_approved',
        'financial_data_contract_approved',
        'individual_payout_coverage_confirmed',
        'shadow_reconciliation_clean',
        'backup_restore_verified',
        'payout_execution_adapter_verified'
      ]::text[]
    )
  ) then
    raise exception 'live payouts are not released'
      using errcode = 'P0001';
  end if;

  if v_existing then
    if v_cycle.status not in ('draft', 'review', 'approved')
      or exists (
        select 1
        from affiliate_private.affiliate_payout_items item
        where item.cycle_id = v_cycle.id
          and (
            item.allocation_entry_id is not null
            or item.status <> 'pending'
          )
      )
    then
      raise exception 'dry payout cycle is not promotable'
        using errcode = 'P0001';
    end if;

    v_previous_status := v_cycle.status;
    delete from affiliate_private.affiliate_payout_items item
    where item.cycle_id = v_cycle.id;

    update affiliate_private.affiliate_payout_cycles cycle
    set
      currency_exponent = v_exponent,
      status = 'draft',
      live_execution = true,
      total_minor = 0,
      item_count = 0,
      live_promoted_by_pseudonym = v_actor,
      live_promoted_at = now(),
      approved_by_pseudonym = null,
      approved_at = null,
      submitted_at = null,
      settled_at = null,
      updated_at = now()
    where cycle.id = v_cycle.id
    returning cycle.* into v_cycle;
    v_promoted := true;
  else
    insert into affiliate_private.affiliate_payout_cycles (
      period_start,
      period_end,
      currency,
      currency_exponent,
      live_execution,
      created_by_pseudonym
    )
    values (
      p_period_start,
      p_period_end,
      v_currency,
      v_exponent,
      p_live_execution,
      v_actor
    )
    returning * into v_cycle;
  end if;

  insert into affiliate_private.affiliate_payout_items (
    cycle_id,
    account_id,
    currency,
    payout_profile_id,
    original_amount_minor,
    amount_minor,
    status
  )
  select
    v_cycle.id,
    balance.account_id,
    v_currency,
    profile.id,
    balance.available_minor,
    balance.available_minor,
    'pending'
  from (
    select
      entry.account_id,
      greatest(
        sum(case
          when posting.ledger_account = 'partner_commission_available'
            and posting.direction = 'credit'
            then posting.amount_minor
          when posting.ledger_account = 'partner_commission_available'
            and posting.direction = 'debit'
            then -posting.amount_minor
          else 0
        end)
        - greatest(sum(case
          when posting.ledger_account = 'partner_recovery_due'
            and posting.direction = 'debit'
            then posting.amount_minor
          when posting.ledger_account = 'partner_recovery_due'
            and posting.direction = 'credit'
            then -posting.amount_minor
          else 0
        end), 0),
        0
      )::bigint as available_minor
    from affiliate_private.affiliate_commission_postings posting
    join affiliate_private.affiliate_commission_entries entry
      on entry.id = posting.entry_id
    where posting.ledger_account in (
        'partner_commission_available',
        'partner_recovery_due'
      )
      and posting.currency = v_currency
    group by entry.account_id
  ) balance
  join affiliate_private.affiliate_accounts account
    on account.id = balance.account_id
    and account.status = 'active'
  join affiliate_private.affiliate_program_versions program
    on program.id = account.program_version_id
  join affiliate_private.affiliate_fiscal_profiles fiscal
    on fiscal.account_id = account.id
    and fiscal.status = 'verified'
  join affiliate_private.affiliate_payout_profiles profile
    on profile.account_id = account.id
    and profile.status = 'active'
    and profile.currency = v_currency
  join affiliate_private.affiliate_payout_provider_configs provider
    on provider.provider = profile.provider
    and provider.country_code = account.country_code
    and provider.currency = profile.currency
    and provider.status = 'active'
  where balance.available_minor >=
    (program.payout_thresholds ->> v_currency)::bigint
    and program.payout_thresholds ? v_currency;

  update affiliate_private.affiliate_payout_cycles cycle
  set
    item_count = summary.item_count,
    total_minor = summary.total_minor,
    updated_at = now()
  from (
    select
      count(*)::integer as item_count,
      coalesce(sum(item.amount_minor), 0)::bigint as total_minor
    from affiliate_private.affiliate_payout_items item
    where item.cycle_id = v_cycle.id
  ) summary
  where cycle.id = v_cycle.id
  returning cycle.* into v_cycle;

  insert into affiliate_private.affiliate_events (
    aggregate_type, aggregate_key, action, actor_type,
    actor_pseudonym, justification, before_state, after_state
  )
  values (
    'payout',
    v_cycle.cycle_key,
    case
      when v_promoted then 'payout_cycle_promoted_live'
      else 'payout_cycle_created'
    end,
    'admin',
    v_actor,
    v_justification,
    case
      when v_promoted then jsonb_build_object(
        'status', v_previous_status,
        'live_execution', false
      )
      else '{}'::jsonb
    end,
    jsonb_build_object(
      'status', 'draft',
      'live_execution', v_cycle.live_execution,
      'currency', v_cycle.currency,
      'item_count', v_cycle.item_count,
      'total_minor', v_cycle.total_minor
    )
  );
  return jsonb_build_object(
    'schema_version', 1,
    'action', case
      when v_promoted then 'payout_cycle_promoted_live'
      else 'payout_cycle_created'
    end,
    'replayed', false,
    'cycle', jsonb_build_object(
      'key', v_cycle.cycle_key,
      'status', v_cycle.status,
      'live_execution', v_cycle.live_execution,
      'currency', v_cycle.currency,
      'item_count', v_cycle.item_count,
      'total_minor', v_cycle.total_minor
    )
  );
end;
$$;

create or replace function
affiliate_private.admin_partners_payout_cycle_approve(
  p_cycle_key text,
  p_confirmation text,
  p_justification text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_cycle_key text := lower(btrim(coalesce(p_cycle_key, '')));
  v_confirmation text := btrim(coalesce(p_confirmation, ''));
  v_justification text := btrim(coalesce(p_justification, ''));
  v_cycle affiliate_private.affiliate_payout_cycles%rowtype;
  v_item affiliate_private.affiliate_payout_items%rowtype;
  v_entry affiliate_private.affiliate_commission_entries%rowtype;
  v_available bigint;
  v_item_payable bigint;
  v_account_id uuid;
  v_actor text;
  v_expected_live boolean;
begin
  perform affiliate_private.partners_require_capability('finance');
  if v_cycle_key !~ '^pay_[0-9a-f]{24}$'
    or v_confirmation <> 'APPROVE:' || v_cycle_key
    or length(v_justification) not between 12 and 1000
  then
    raise exception 'invalid payout approval'
      using errcode = '22023';
  end if;
  select c.*
  into v_cycle
  from affiliate_private.affiliate_payout_cycles c
  where c.cycle_key = v_cycle_key;
  if not found or v_cycle.status <> 'draft' then
    raise exception 'payout draft is unavailable'
      using errcode = 'P0002';
  end if;
  v_expected_live := v_cycle.live_execution;

  -- Locks are acquired in a deterministic order before the cycle/items. The
  -- refund path uses the same account+currency lock before touching an item,
  -- preventing allocation/recovery deadlocks and stale-balance payouts.
  if v_cycle.live_execution then
    for v_account_id in
      select distinct item.account_id
      from affiliate_private.affiliate_payout_items item
      where item.cycle_id = v_cycle.id
      order by item.account_id
    loop
      perform affiliate_private.partners_balance_lock(
        v_account_id,
        v_cycle.currency
      );
    end loop;
  end if;

  select c.*
  into v_cycle
  from affiliate_private.affiliate_payout_cycles c
  where c.id = v_cycle.id
  for update;
  if not found
    or v_cycle.status <> 'draft'
    or v_cycle.live_execution <> v_expected_live
  then
    raise exception 'payout draft is unavailable'
      using errcode = 'P0002';
  end if;

  v_actor := affiliate_private.partners_admin_actor_pseudonym();
  if v_cycle.live_execution and (
    v_actor = coalesce(
      v_cycle.live_promoted_by_pseudonym,
      v_cycle.created_by_pseudonym
    )
    or v_cycle.item_count = 0
    or not coalesce((
      select f.enabled
      from public.admin_feature_flags f
      where f.key = 'partners_payouts_live'
    ), false)
    or not affiliate_private.release_gates_satisfied(
      array[
        'legal_and_tax_approved',
        'financial_data_contract_approved',
        'individual_payout_coverage_confirmed',
        'shadow_reconciliation_clean',
        'backup_restore_verified',
        'payout_execution_adapter_verified'
      ]::text[]
    )
  ) then
    raise exception 'live payout approval controls are incomplete'
      using errcode = 'P0001';
  end if;

  if v_cycle.live_execution then
    for v_item in
      select item.*
      from affiliate_private.affiliate_payout_items item
      where item.cycle_id = v_cycle.id
        and item.status = 'pending'
      order by item.account_id
      for update
    loop
      if not affiliate_private.partners_payout_balance_authoritative(
        v_item.account_id,
        v_cycle.currency
      ) then
        raise exception 'payout balance is not authoritative'
          using errcode = 'P0004';
      end if;

      perform affiliate_private.partners_recovery_due_consume(
        v_item.account_id,
        v_cycle.currency
      );
      v_available := affiliate_private.partners_account_payable_balance(
        v_item.account_id,
        v_cycle.currency
      );
      v_item_payable := v_item.amount_minor;
      if v_item_payable <= 0
        or v_available < v_item_payable
      then
        raise exception 'payout balance changed during approval'
          using errcode = 'P0004';
      end if;

      insert into affiliate_private.affiliate_commission_entries (
        account_id,
        entry_kind,
        currency,
        currency_exponent,
        amount_minor
      )
      values (
        v_item.account_id,
        'payout_allocation',
        v_cycle.currency,
        v_cycle.currency_exponent,
        v_item_payable
      )
      returning * into v_entry;
      insert into affiliate_private.affiliate_commission_postings (
        entry_id, ledger_account, direction, amount_minor, currency
      )
      values
        (
          v_entry.id,
          'partner_commission_available',
          'debit',
          v_item_payable,
          v_cycle.currency
        ),
        (
          v_entry.id,
          'partner_payout_clearing',
          'credit',
          v_item_payable,
          v_cycle.currency
        );
      update affiliate_private.affiliate_payout_items
      set allocation_entry_id = v_entry.id, updated_at = now()
      where id = v_item.id;
    end loop;
  end if;

  update affiliate_private.affiliate_payout_cycles
  set
    status = 'approved',
    approved_by_pseudonym = v_actor,
    approved_at = now(),
    updated_at = now()
  where id = v_cycle.id
  returning * into v_cycle;
  insert into affiliate_private.affiliate_events (
    aggregate_type, aggregate_key, action, actor_type,
    actor_pseudonym, justification, after_state
  )
  values (
    'payout',
    v_cycle.cycle_key,
    'payout_cycle_approved',
    'admin',
    v_actor,
    v_justification,
    jsonb_build_object(
      'status', 'approved',
      'live_execution', v_cycle.live_execution,
      'item_count', v_cycle.item_count,
      'total_minor', v_cycle.total_minor
    )
  );
  return jsonb_build_object(
    'schema_version', 1,
    'action', 'payout_cycle_approved',
    'cycle', jsonb_build_object(
      'key', v_cycle.cycle_key,
      'status', v_cycle.status,
      'live_execution', v_cycle.live_execution
    )
  );
end;
$$;

create or replace function affiliate_private.admin_partners_risk_queue(
  p_limit integer,
  p_offset integer,
  p_status text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_status text := lower(btrim(coalesce(p_status, 'all')));
  v_total bigint;
  v_items jsonb;
begin
  perform affiliate_private.partners_require_capability('risk');
  if v_status not in (
    'all', 'held', 'suspended', 'dead_letter', 'conflict'
  ) then
    raise exception 'invalid risk queue filter'
      using errcode = '22023';
  end if;

  with queue as (
    select
      a.id,
      affiliate_private.partners_public_account_id(a) as public_id,
      a.status,
      a.verification_status,
      (
        select x.status
        from affiliate_private.affiliate_attributions x
        where x.referrer_account_id = a.id
        order by x.attributed_at desc
        limit 1
      ) as attribution_status,
      case
        when exists (
          select 1
          from affiliate_private.affiliate_financial_fact_conflicts c
          join affiliate_private.affiliate_financial_facts f
            on f.id = c.fact_id
          join affiliate_private.affiliate_attributions x
            on x.id = coalesce(
              f.attribution_id,
              (
                select l.attribution_id
                from affiliate_private.affiliate_financial_fact_lineage_links l
                where l.child_fact_id = f.id
              )
            )
          where x.referrer_account_id = a.id
        ) then 'financial_fact_conflict'
        when a.status = 'held' then 'risk_hold'
        when a.status = 'suspended' then 'suspended'
        when exists (
          select 1
          from affiliate_private.affiliate_commission_jobs j
          join affiliate_private.affiliate_financial_facts f
            on f.id = j.fact_id
          join affiliate_private.affiliate_attributions x
            on x.id = coalesce(
              f.attribution_id,
              (
                select l.attribution_id
                from affiliate_private.affiliate_financial_fact_lineage_links l
                where l.child_fact_id = f.id
              )
            )
          where x.referrer_account_id = a.id
            and j.status = 'dead_letter'
        ) then 'dead_letter'
        else 'review'
      end as reason,
      (
        select count(*)
        from affiliate_private.affiliate_commission_jobs j
        join affiliate_private.affiliate_financial_facts f
          on f.id = j.fact_id
        join affiliate_private.affiliate_attributions x
          on x.id = coalesce(
            f.attribution_id,
            (
              select l.attribution_id
              from affiliate_private.affiliate_financial_fact_lineage_links l
              where l.child_fact_id = f.id
            )
          )
        where x.referrer_account_id = a.id
          and j.status = 'dead_letter'
      ) as dead_letter_jobs,
      a.created_at
    from affiliate_private.affiliate_accounts a
    where a.status in ('held', 'suspended')
      or exists (
        select 1
        from affiliate_private.affiliate_attributions x
        where x.referrer_account_id = a.id
          and x.status in ('held', 'blocked', 'reversed')
      )
      or exists (
        select 1
        from affiliate_private.affiliate_financial_facts f
        join affiliate_private.affiliate_commission_jobs j
          on j.fact_id = f.id and j.status = 'dead_letter'
        where f.attribution_id in (
          select x.id
          from affiliate_private.affiliate_attributions x
          where x.referrer_account_id = a.id
        )
      )
  ),
  filtered as (
    select *
    from queue q
    where v_status = 'all'
      or (v_status = 'held' and q.status = 'held')
      or (v_status = 'suspended' and q.status = 'suspended')
      or (v_status = 'dead_letter' and q.dead_letter_jobs > 0)
      or (v_status = 'conflict' and q.reason = 'financial_fact_conflict')
  )
  select count(*)
  into v_total
  from filtered;

  with queue as (
    select
      a.id,
      affiliate_private.partners_public_account_id(a) as public_id,
      a.status,
      a.verification_status,
      (
        select x.status
        from affiliate_private.affiliate_attributions x
        where x.referrer_account_id = a.id
        order by x.attributed_at desc
        limit 1
      ) as attribution_status,
      case
        when exists (
          select 1
          from affiliate_private.affiliate_financial_fact_conflicts c
          join affiliate_private.affiliate_financial_facts f
            on f.id = c.fact_id
          where f.attribution_id in (
            select x.id
            from affiliate_private.affiliate_attributions x
            where x.referrer_account_id = a.id
          )
        ) then 'financial_fact_conflict'
        when a.status = 'held' then 'risk_hold'
        when a.status = 'suspended' then 'suspended'
        else 'dead_letter'
      end as reason,
      (
        select count(*)
        from affiliate_private.affiliate_commission_jobs j
        join affiliate_private.affiliate_financial_facts f
          on f.id = j.fact_id
        where j.status = 'dead_letter'
          and f.attribution_id in (
            select x.id
            from affiliate_private.affiliate_attributions x
            where x.referrer_account_id = a.id
          )
      ) as dead_letter_jobs,
      a.created_at
    from affiliate_private.affiliate_accounts a
    where a.status in ('held', 'suspended')
      or exists (
        select 1
        from affiliate_private.affiliate_attributions x
        where x.referrer_account_id = a.id
          and x.status in ('held', 'blocked', 'reversed')
      )
      or exists (
        select 1
        from affiliate_private.affiliate_financial_facts f
        join affiliate_private.affiliate_commission_jobs j
          on j.fact_id = f.id and j.status = 'dead_letter'
        where f.attribution_id in (
          select x.id
          from affiliate_private.affiliate_attributions x
          where x.referrer_account_id = a.id
        )
      )
  ),
  filtered as (
    select *
    from queue q
    where v_status = 'all'
      or (v_status = 'held' and q.status = 'held')
      or (v_status = 'suspended' and q.status = 'suspended')
      or (v_status = 'dead_letter' and q.dead_letter_jobs > 0)
      or (v_status = 'conflict' and q.reason = 'financial_fact_conflict')
    order by q.created_at desc, q.public_id
    limit v_limit offset v_offset
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'account_id', f.public_id,
        'status', f.status,
        'verification_status', f.verification_status,
        'attribution_status', f.attribution_status,
        'reason', f.reason,
        'dead_letter_jobs', f.dead_letter_jobs,
        'created_at', f.created_at
      )
      order by f.created_at desc, f.public_id
    ),
    '[]'::jsonb
  )
  into v_items
  from filtered f;
  return jsonb_build_object(
    'schema_version', 1,
    'total', v_total,
    'items', v_items
  );
end;
$$;

create or replace function affiliate_private.admin_partners_finance_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_currencies jsonb;
  v_last affiliate_private.affiliate_shadow_reconciliation_runs%rowtype;
begin
  perform affiliate_private.partners_require_capability('finance');
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'currency', balances.currency,
        'pending_minor', balances.pending_minor,
        'available_minor', balances.available_minor,
        'payout_clearing_minor', balances.clearing_minor,
        'recovery_due_minor', balances.recovery_due_minor
      )
      order by balances.currency
    ),
    '[]'::jsonb
  )
  into v_currencies
  from (
    select
      p.currency,
      coalesce(sum(case
        when p.ledger_account = 'partner_commission_pending'
          then case when p.direction = 'credit'
            then p.amount_minor else -p.amount_minor end
        else 0
      end), 0)::bigint as pending_minor,
      coalesce(sum(case
        when p.ledger_account = 'partner_commission_available'
          then case when p.direction = 'credit'
            then p.amount_minor else -p.amount_minor end
        else 0
      end), 0)::bigint as available_minor,
      coalesce(sum(case
        when p.ledger_account = 'partner_payout_clearing'
          then case when p.direction = 'credit'
            then p.amount_minor else -p.amount_minor end
        else 0
      end), 0)::bigint as clearing_minor,
      coalesce(sum(case
        when p.ledger_account = 'partner_recovery_due'
          then case when p.direction = 'debit'
            then p.amount_minor else -p.amount_minor end
        else 0
      end), 0)::bigint as recovery_due_minor
    from affiliate_private.affiliate_commission_postings p
    group by p.currency
  ) balances;
  select r.*
  into v_last
  from affiliate_private.affiliate_shadow_reconciliation_runs r
  order by r.created_at desc
  limit 1;
  return jsonb_build_object(
    'schema_version', 1,
    'currencies', v_currencies,
    'queues', jsonb_build_object(
      'commission_pending', (
        select count(*) from affiliate_private.affiliate_commission_jobs
        where status = 'pending'
      ),
      'commission_retry', (
        select count(*) from affiliate_private.affiliate_commission_jobs
        where status = 'retry'
      ),
      'commission_dead_letter', (
        select count(*) from affiliate_private.affiliate_commission_jobs
        where status = 'dead_letter'
      ),
      'maturation_due', (
        select count(*) from affiliate_private.affiliate_maturation_jobs
        where status in ('pending', 'retry') and available_at <= now()
      ),
      'maturation_dead_letter', (
        select count(*) from affiliate_private.affiliate_maturation_jobs
        where status = 'dead_letter'
      )
    ),
    'reconciliation', jsonb_build_object(
      'last_status', v_last.status,
      'last_run_at', v_last.created_at,
      'mismatches', v_last.mismatch_count
    )
  );
end;
$$;

create or replace function affiliate_private.admin_partners_payout_cycles(
  p_limit integer,
  p_offset integer,
  p_status text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_status text := lower(btrim(coalesce(p_status, 'all')));
  v_total bigint;
  v_items jsonb;
begin
  perform affiliate_private.partners_require_capability('finance');
  if v_status not in (
    'all', 'draft', 'review', 'approved', 'submitted',
    'settled', 'failed', 'cancelled'
  ) then
    raise exception 'invalid payout cycle filter'
      using errcode = '22023';
  end if;
  select count(*)
  into v_total
  from affiliate_private.affiliate_payout_cycles c
  where v_status = 'all' or c.status = v_status;
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'key', rows.cycle_key,
        'period_start', rows.period_start,
        'period_end', rows.period_end,
        'currency', rows.currency,
        'status', rows.status,
        'live_execution', rows.live_execution,
        'total_minor', rows.total_minor,
        'item_count', rows.item_count,
        'created_at', rows.created_at
      )
      order by rows.created_at desc, rows.cycle_key
    ),
    '[]'::jsonb
  )
  into v_items
  from (
    select c.*
    from affiliate_private.affiliate_payout_cycles c
    where v_status = 'all' or c.status = v_status
    order by c.created_at desc, c.cycle_key
    limit v_limit offset v_offset
  ) rows;
  return jsonb_build_object(
    'schema_version', 1,
    'total', v_total,
    'items', v_items
  );
end;
$$;

create or replace function affiliate_private.admin_partners_kyc_quota()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_used bigint;
  v_limit integer := 500;
begin
  if not (
    affiliate_private.partners_has_capability('support')
    or affiliate_private.partners_has_capability('risk')
  ) then
    raise exception 'Partners Admin capability is required'
      using errcode = '42501';
  end if;
  select count(*)
  into v_used
  from affiliate_private.affiliate_kyc_sessions s
  where s.created_at >= now() - interval '30 days';
  return jsonb_build_object(
    'schema_version', 1,
    'window_days', 30,
    'used', v_used,
    'informational_limit', v_limit,
    'remaining', greatest(v_limit - v_used, 0),
    'utilization_percent', round(v_used::numeric * 100 / v_limit, 1),
    'blocking', false
  );
end;
$$;

-- Bound the support, risk and finance analytics scans to the timestamp and
-- terminal-state predicates used below. Keep these indexes narrow: the
-- dashboard never needs raw provider payloads or extra identity/contact
-- columns via INCLUDE; the first-payment key is only the existing private
-- pseudonymous user identifier required for that cohort.
create index affiliate_link_claims_analytics_issued_idx
  on affiliate_private.affiliate_link_claims (issued_at);

create index affiliate_attributions_analytics_attributed_idx
  on affiliate_private.affiliate_attributions (attributed_at);

create index affiliate_kyc_sessions_analytics_verified_idx
  on affiliate_private.affiliate_kyc_sessions (verified_at)
  where verified_at is not null;

create index affiliate_kyc_sessions_analytics_terminal_idx
  on affiliate_private.affiliate_kyc_sessions (updated_at)
  where status in ('failed', 'expired');

create index affiliate_events_analytics_activation_idx
  on affiliate_private.affiliate_events (created_at, aggregate_key)
  where aggregate_type = 'account'
    and action = 'account_activated';

create index affiliate_commission_entries_analytics_accrual_idx
  on affiliate_private.affiliate_commission_entries (
    created_at,
    account_id
  )
  where entry_kind = 'accrual';

create index affiliate_financial_facts_analytics_complete_idx
  on affiliate_private.affiliate_financial_facts (occurred_at)
  where environment = 'production'
    and facts_status = 'complete'
    and attribution_id is not null
    and event_type in ('capture', 'renewal', 'refund', 'chargeback');

create index affiliate_financial_facts_analytics_first_paid_idx
  on affiliate_private.affiliate_financial_facts (
    referred_user_id,
    occurred_at,
    id
  )
  where environment = 'production'
    and facts_status = 'complete'
    and attribution_id is not null
    and event_type in ('capture', 'renewal');

create index affiliate_financial_facts_analytics_quarantined_idx
  on affiliate_private.affiliate_financial_facts (created_at)
  where facts_status = 'quarantined';

create index affiliate_financial_facts_transfer_quarantine_idx
  on affiliate_private.affiliate_financial_facts (created_at)
  where event_type = 'transfer'
    and facts_status = 'quarantined';

create index affiliate_payout_items_analytics_settled_idx
  on affiliate_private.affiliate_payout_items (
    account_id,
    cycle_id,
    id
  )
  where status = 'settled';

create index affiliate_payout_cycles_analytics_settled_idx
  on affiliate_private.affiliate_payout_cycles (settled_at, id)
  where status = 'settled'
    and settled_at is not null;

create or replace function affiliate_private.admin_partners_analytics(
  p_days integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_days integer := coalesce(p_days, 30);
  v_window_start timestamptz;
  v_window_end timestamptz;
  v_has_support boolean;
  v_has_risk boolean;
  v_has_finance boolean;
  v_payout_ready boolean;
  v_daily jsonb;
  v_funnel jsonb;
  v_activation jsonb;
  v_risk jsonb;
  v_financial jsonb;
  v_payout_timing jsonb;
  v_retention jsonb;
begin
  if v_days not between 1 and 365 then
    raise exception 'invalid analytics window'
      using errcode = '22023';
  end if;

  v_has_support :=
    affiliate_private.partners_has_capability('support');
  v_has_risk :=
    affiliate_private.partners_has_capability('risk');
  v_has_finance :=
    affiliate_private.partners_has_capability('finance');

  if not (v_has_support or v_has_risk or v_has_finance) then
    raise exception 'Partners Admin capability is required'
      using errcode = '42501';
  end if;

  -- Analytics windows are UTC half-open intervals. This avoids depending on
  -- the caller's session time zone and makes daily values deterministic.
  v_window_end := (
    date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'
  ) + interval '1 day';
  v_window_start := v_window_end - make_interval(days => v_days);

  if v_has_support then
    with days as (
      select generate_series(
        v_window_start,
        v_window_end - interval '1 day',
        interval '1 day'
      ) as day
    )
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'date', (d.day at time zone 'UTC')::date,
          'claims', (
            select count(*)
            from affiliate_private.affiliate_link_claims c
            where c.issued_at >= d.day
              and c.issued_at < d.day + interval '1 day'
          ),
          'attributions', (
            select count(*)
            from affiliate_private.affiliate_attributions a
            where a.attributed_at >= d.day
              and a.attributed_at < d.day + interval '1 day'
          ),
          'kyc_verified', (
            select count(*)
            from affiliate_private.affiliate_kyc_sessions s
            where s.verified_at >= d.day
              and s.verified_at < d.day + interval '1 day'
          ),
          'commission_entries', (
            select count(*)
            from affiliate_private.affiliate_commission_entries e
            where e.entry_kind = 'accrual'
              and e.created_at >= d.day
              and e.created_at < d.day + interval '1 day'
          )
        )
        order by d.day
      ),
      '[]'::jsonb
    )
    into v_daily
    from days d;

    with cohort_claims as (
      select c.id
      from affiliate_private.affiliate_link_claims c
      where c.issued_at >= v_window_start
        and c.issued_at < v_window_end
    ),
    cohort_attributions as (
      select a.id, a.referred_user_id
      from affiliate_private.affiliate_attributions a
      join cohort_claims c on c.id = a.claim_id
    ),
    first_paid as (
      select distinct on (f.referred_user_id)
        f.referred_user_id,
        f.attribution_id,
        f.occurred_at
      from affiliate_private.affiliate_financial_facts f
      where f.environment = 'production'
        and f.facts_status = 'complete'
        and f.event_type in ('capture', 'renewal')
        and f.attribution_id is not null
      order by f.referred_user_id, f.occurred_at, f.id
    ),
    counts as (
      select
        (select count(*) from cohort_claims) as claims,
        (select count(*) from cohort_attributions) as attributions,
        (
          select count(*)
          from cohort_attributions a
          join first_paid f
            on f.referred_user_id = a.referred_user_id
            and f.attribution_id = a.id
        ) as first_paid
    )
    select jsonb_build_object(
      'status', 'available',
      'cohort_basis', 'claim_issued_at',
      'observation_cutoff', now(),
      'clicks', jsonb_build_object(
        'status', 'unavailable',
        'reason', 'referral_click_events_not_recorded'
      ),
      'claims_issued', jsonb_build_object(
        'status', 'available',
        'value', c.claims
      ),
      'attributions_created', jsonb_build_object(
        'status', 'available',
        'value', c.attributions
      ),
      'first_paid_referrals', jsonb_build_object(
        'status', 'available',
        'value', c.first_paid,
        'definition',
          'first complete production capture or renewal for the referred user'
      ),
      'claim_to_attribution_percent', case
        when c.claims = 0 then jsonb_build_object(
          'status', 'unavailable',
          'reason', 'no_claims_in_window'
        )
        else jsonb_build_object(
          'status', 'available',
          'value', round(c.attributions::numeric * 100 / c.claims, 1)
        )
      end,
      'attribution_to_first_payment_percent', case
        when c.attributions = 0 then jsonb_build_object(
          'status', 'unavailable',
          'reason', 'no_attributions_in_window'
        )
        else jsonb_build_object(
          'status', 'available',
          'value', round(c.first_paid::numeric * 100 / c.attributions, 1)
        )
      end
    )
    into v_funnel
    from counts c;

    select jsonb_build_object(
      'status', 'available',
      'account_activation_events', jsonb_build_object(
        'status', 'available',
        'value', count(*) filter (
          where e.action = 'account_activated'
        )
      ),
      'distinct_accounts_activated', jsonb_build_object(
        'status', 'available',
        'value', count(distinct e.aggregate_key) filter (
          where e.action = 'account_activated'
        )
      ),
      'kyc_verified_sessions', jsonb_build_object(
        'status', 'available',
        'value', (
          select count(*)
          from affiliate_private.affiliate_kyc_sessions s
          where s.verified_at >= v_window_start
            and s.verified_at < v_window_end
        )
      )
    )
    into v_activation
    from affiliate_private.affiliate_events e
    where e.aggregate_type = 'account'
      and e.created_at >= v_window_start
      and e.created_at < v_window_end;
  else
    v_daily := '[]'::jsonb;
    v_funnel := jsonb_build_object(
      'status', 'unavailable',
      'reason', 'support_capability_required'
    );
    v_activation := jsonb_build_object(
      'status', 'unavailable',
      'reason', 'support_capability_required'
    );
  end if;

  if v_has_risk then
    v_risk := jsonb_build_object(
      'status', 'available',
      'kyc_terminal_sessions_in_window', jsonb_build_object(
        'status', 'available',
        'value', (
          select count(*)
          from affiliate_private.affiliate_kyc_sessions s
          where s.status in ('failed', 'expired')
            and s.updated_at >= v_window_start
            and s.updated_at < v_window_end
        )
      ),
      'blocked_activation_accounts_current', jsonb_build_object(
        'status', 'available',
        'value', (
          select count(*)
          from affiliate_private.affiliate_accounts a
          where a.status = 'pending_verification'
            and a.verification_status in ('failed', 'expired')
        )
      ),
      'account_holds_current', jsonb_build_object(
        'status', 'available',
        'value', (
          select count(*)
          from affiliate_private.affiliate_accounts a
          where a.status = 'held'
        )
      ),
      'account_suspensions_current', jsonb_build_object(
        'status', 'available',
        'value', (
          select count(*)
          from affiliate_private.affiliate_accounts a
          where a.status = 'suspended'
        )
      ),
      'attribution_holds_current', jsonb_build_object(
        'status', 'available',
        'value', (
          select count(*)
          from affiliate_private.affiliate_attributions a
          where a.status = 'held'
        )
      ),
      'attribution_blocks_current', jsonb_build_object(
        'status', 'available',
        'value', (
          select count(*)
          from affiliate_private.affiliate_attributions a
          where a.status = 'blocked'
        )
      ),
      'quarantined_financial_facts_in_window', jsonb_build_object(
        'status', 'available',
        'value', (
          select count(*)
          from affiliate_private.affiliate_financial_facts f
          where f.facts_status = 'quarantined'
            and f.created_at >= v_window_start
            and f.created_at < v_window_end
        )
      ),
      'quarantined_transfer_facts_total', jsonb_build_object(
        'status', 'available',
        'value', (
          select count(*)
          from affiliate_private.affiliate_financial_facts f
          where f.event_type = 'transfer'
            and f.facts_status = 'quarantined'
        )
      ),
      'transfer_entitlement', jsonb_build_object(
        'status', 'unavailable',
        'reason', 'authoritative_transfer_entitlement_contract_not_implemented'
      )
    );
  else
    v_risk := jsonb_build_object(
      'status', 'unavailable',
      'reason', 'risk_capability_required'
    );
  end if;

  if v_has_finance then
    with financial_facts as (
      select
        f.id,
        f.rail,
        f.event_type,
        f.currency,
        f.currency_exponent,
        f.gross_minor,
        f.tax_minor,
        f.eligible_minor
      from affiliate_private.affiliate_financial_facts f
      where f.environment = 'production'
        and f.facts_status = 'complete'
        and f.attribution_id is not null
        and f.event_type in (
          'capture',
          'renewal',
          'refund',
          'chargeback'
        )
        and f.occurred_at >= v_window_start
        and f.occurred_at < v_window_end
    ),
    commission_to_fact as (
      select
        e.entry_kind,
        e.amount_minor,
        case
          when e.entry_kind = 'manual_reversal' then origin.fact_id
          else e.fact_id
        end as fact_id
      from affiliate_private.affiliate_commission_entries e
      left join affiliate_private.affiliate_commission_entries origin
        on origin.id = e.related_entry_id
        and e.entry_kind = 'manual_reversal'
      where e.entry_kind in ('accrual', 'reversal', 'manual_reversal')
    ),
    per_fact as (
      select
        f.id,
        f.rail,
        f.event_type,
        f.currency,
        f.currency_exponent,
        f.gross_minor,
        f.tax_minor,
        f.eligible_minor,
        coalesce(sum(c.amount_minor) filter (
          where c.entry_kind = 'accrual'
        ), 0) as commission_accrued_minor,
        coalesce(sum(c.amount_minor) filter (
          where c.entry_kind = 'reversal'
        ), 0) as commission_reversed_minor,
        coalesce(sum(c.amount_minor) filter (
          where c.entry_kind = 'manual_reversal'
        ), 0) as commission_manual_reversed_minor,
        case
          when f.event_type in ('capture', 'renewal') then
            count(*) filter (where c.entry_kind = 'accrual') > 0
          else
            count(*) filter (where c.entry_kind = 'reversal') > 0
        end as commission_processed
      from financial_facts f
      left join commission_to_fact c on c.fact_id = f.id
      group by
        f.id,
        f.rail,
        f.event_type,
        f.currency,
        f.currency_exponent,
        f.gross_minor,
        f.tax_minor,
        f.eligible_minor
    ),
    grouped as (
      select
        p.rail,
        p.currency,
        p.currency_exponent,
        count(*) filter (
          where p.event_type in ('capture', 'renewal')
        ) as paid_event_count,
        count(*) filter (
          where p.event_type = 'refund'
        ) as refund_count,
        count(*) filter (
          where p.event_type = 'chargeback'
        ) as chargeback_count,
        sum(p.gross_minor) filter (
          where p.event_type in ('capture', 'renewal')
        ) as paid_gross_minor,
        coalesce(sum(p.eligible_minor) filter (
          where p.event_type = 'refund'
        ), 0) as refunded_eligible_minor,
        coalesce(sum(p.eligible_minor) filter (
          where p.event_type = 'chargeback'
        ), 0) as chargeback_eligible_minor,
        coalesce(sum(
          case
            when p.event_type in ('capture', 'renewal')
              then p.eligible_minor
            else -p.eligible_minor
          end
        ), 0) as net_eligible_revenue_minor,
        coalesce(sum(p.commission_accrued_minor), 0)
          as commission_accrued_minor,
        coalesce(sum(p.commission_reversed_minor), 0)
          as commission_reversed_minor,
        coalesce(sum(p.commission_manual_reversed_minor), 0)
          as commission_manual_reversed_minor,
        count(*) filter (where not p.commission_processed)
          as unprocessed_financial_fact_count
      from per_fact p
      group by p.rail, p.currency, p.currency_exponent
    )
    select jsonb_build_object(
      'status', 'available',
      'basis',
        'complete production attributed facts by occurred_at; '
        || 'commission entries observed at generation time',
      'rows', coalesce(jsonb_agg(
        jsonb_build_object(
          'rail', g.rail,
          'currency', g.currency,
          'currency_exponent', g.currency_exponent,
          'paid_event_count', g.paid_event_count,
          'refund_count', g.refund_count,
          'chargeback_count', g.chargeback_count,
          'paid_gross_minor', g.paid_gross_minor,
          'refunded_eligible_minor', g.refunded_eligible_minor,
          'chargeback_eligible_minor', g.chargeback_eligible_minor,
          'net_eligible_revenue_minor', g.net_eligible_revenue_minor,
          'commission_accrued_minor', g.commission_accrued_minor,
          'commission_reversed_minor', g.commission_reversed_minor,
          'commission_manual_reversed_minor',
            g.commission_manual_reversed_minor,
          'net_partner_commission_minor',
            g.commission_accrued_minor
            - g.commission_reversed_minor
            - g.commission_manual_reversed_minor,
          'unprocessed_financial_fact_count',
            g.unprocessed_financial_fact_count,
          'contribution_after_partner_commission_minor', case
            when g.unprocessed_financial_fact_count > 0
              then jsonb_build_object(
                'status', 'unavailable',
                'reason', 'commission_processing_incomplete'
              )
            else jsonb_build_object(
              'status', 'available',
              'value',
                g.net_eligible_revenue_minor
                - (
                  g.commission_accrued_minor
                  - g.commission_reversed_minor
                  - g.commission_manual_reversed_minor
                )
            )
          end
        )
        order by g.rail, g.currency, g.currency_exponent
      ), '[]'::jsonb),
      'gross_margin', jsonb_build_object(
        'status', 'unavailable',
        'reason',
          'provider_fees_fx_infrastructure_and_other_costs_not_modeled'
      ),
      'transfer_entitlement', jsonb_build_object(
        'status', 'unavailable',
        'reason', 'authoritative_transfer_entitlement_contract_not_implemented',
        'quarantined_fact_count', (
          select count(*)
          from affiliate_private.affiliate_financial_facts transfer
          where transfer.event_type = 'transfer'
            and transfer.facts_status = 'quarantined'
        )
      )
    )
    into v_financial
    from grouped g;

    select
      coalesce((select flag.enabled
        from public.admin_feature_flags flag
        where flag.key = 'partners_payouts_live'), false)
      and affiliate_private.release_gates_satisfied(
        array['payout_execution_adapter_verified']::text[]
      )
      and exists (
        select 1
        from affiliate_private.affiliate_payout_provider_configs provider
        where provider.status = 'active'
      )
    into v_payout_ready;

    if v_payout_ready then
      with first_settled as (
        select distinct on (item.account_id)
          item.account_id,
          item.amount_minor,
          cycle.currency,
          cycle.currency_exponent,
          cycle.settled_at
        from affiliate_private.affiliate_payout_items item
        join affiliate_private.affiliate_payout_cycles cycle
          on cycle.id = item.cycle_id
        where item.status = 'settled'
          and cycle.status = 'settled'
          and cycle.settled_at is not null
        order by item.account_id, cycle.settled_at, item.id
      ),
      first_activation as (
        select
          e.aggregate_key as account_key,
          min(e.created_at) as activated_at
        from affiliate_private.affiliate_events e
        where e.aggregate_type = 'account'
          and e.action = 'account_activated'
        group by e.aggregate_key
      ),
      first_accrual as (
        select
          e.account_id,
          min(e.created_at) as accrued_at
        from affiliate_private.affiliate_commission_entries e
        where e.entry_kind = 'accrual'
        group by e.account_id
      ),
      observed as (
        select
          settled.account_id,
          settled.amount_minor,
          settled.currency,
          settled.currency_exponent,
          settled.settled_at,
          activation.activated_at,
          accrual.accrued_at
        from first_settled settled
        left join first_activation activation
          on activation.account_key = settled.account_id::text
        left join first_accrual accrual
          on accrual.account_id = settled.account_id
        where settled.settled_at >= v_window_start
          and settled.settled_at < v_window_end
      ),
      summary as (
        select
          count(*) as first_payout_count,
          count(*) filter (
            where activated_at is not null
              and activated_at <= settled_at
          ) as activation_baseline_count,
          count(*) filter (
            where accrued_at is not null
              and accrued_at <= settled_at
          ) as accrual_baseline_count,
          percentile_cont(0.5) within group (
            order by extract(epoch from (settled_at - activated_at))
              / 86400.0
          ) filter (
            where activated_at is not null
              and activated_at <= settled_at
          ) as median_activation_days,
          percentile_cont(0.5) within group (
            order by extract(epoch from (settled_at - accrued_at))
              / 86400.0
          ) filter (
            where accrued_at is not null
              and accrued_at <= settled_at
          ) as median_accrual_days
        from observed
      ),
      currency_totals as (
        select
          o.currency,
          o.currency_exponent,
          count(*) as first_payout_count,
          sum(o.amount_minor) as first_payout_total_minor
        from observed o
        group by o.currency, o.currency_exponent
      )
      select jsonb_build_object(
        'status', 'available',
        'cohort_basis', 'first_settled_payout_at',
        'first_settled_payouts', jsonb_build_object(
          'status', 'available',
          'value', s.first_payout_count
        ),
        'by_currency', coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'currency', totals.currency,
              'currency_exponent', totals.currency_exponent,
              'first_payout_count', totals.first_payout_count,
              'first_payout_total_minor', totals.first_payout_total_minor
            )
            order by totals.currency, totals.currency_exponent
          )
          from currency_totals totals
        ), '[]'::jsonb),
        'median_days_activation_to_first_settled_payout', case
          when s.activation_baseline_count = 0 then jsonb_build_object(
            'status', 'unavailable',
            'reason', 'no_eligible_first_payout_observations'
          )
          else jsonb_build_object(
            'status', 'available',
            'value', round(s.median_activation_days::numeric, 2),
            'sample_size', s.activation_baseline_count
          )
        end,
        'median_days_first_accrual_to_first_settled_payout', case
          when s.accrual_baseline_count = 0 then jsonb_build_object(
            'status', 'unavailable',
            'reason', 'no_eligible_first_payout_observations'
          )
          else jsonb_build_object(
            'status', 'available',
            'value', round(s.median_accrual_days::numeric, 2),
            'sample_size', s.accrual_baseline_count
          )
        end
      )
      into v_payout_timing
      from summary s;
    else
      v_payout_timing := jsonb_build_object(
        'status', 'unavailable',
        'reason', 'payout_operations_not_ready'
      );
    end if;

    v_retention := jsonb_build_object(
      'status', 'unavailable',
      'reason',
        'authoritative_entitlement_and_billing_interval_history_not_modeled'
    );
  else
    v_financial := jsonb_build_object(
      'status', 'unavailable',
      'reason', 'finance_capability_required'
    );
    v_payout_timing := jsonb_build_object(
      'status', 'unavailable',
      'reason', 'finance_capability_required'
    );
    v_retention := jsonb_build_object(
      'status', 'unavailable',
      'reason', 'finance_capability_required'
    );
  end if;

  return jsonb_build_object(
    'schema_version', 1,
    'window_days', v_days,
    'window', jsonb_build_object(
      'timezone', 'UTC',
      'start', v_window_start,
      'end_exclusive', v_window_end
    ),
    'daily_status', case
      when v_has_support then jsonb_build_object('status', 'available')
      else jsonb_build_object(
        'status', 'unavailable',
        'reason', 'support_capability_required'
      )
    end,
    'daily', v_daily,
    'funnel', v_funnel,
    'activation', v_activation,
    'risk', v_risk,
    'financial', v_financial,
    'payout_timing', v_payout_timing,
    'retention', v_retention
  );
end;
$$;

create or replace function affiliate_private.partners_ops_alert_snapshot()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_workers jsonb;
  v_alerts jsonb;
  v_kyc_used bigint;
begin
  with expected(worker_name) as (
    values
      ('commission'::text),
      ('maturation'::text),
      ('reconciliation'::text)
  )
  select jsonb_agg(
    jsonb_build_object(
      'worker', e.worker_name,
      'status', case
        when h.worker_name is null then 'not_configured'
        when h.last_seen_at < now() - interval '15 minutes' then 'stale'
        else h.status
      end,
      'last_seen_at', h.last_seen_at
    )
    order by e.worker_name
  )
  into v_workers
  from expected e
  left join affiliate_private.affiliate_worker_heartbeats h
    on h.worker_name = e.worker_name;

  select count(*)
  into v_kyc_used
  from affiliate_private.affiliate_kyc_sessions
  where created_at >= now() - interval '30 days';

  with alerts as (
    select
      'commission_dead_letter'::text as code,
      'critical'::text as severity,
      count(*)::bigint as count
    from affiliate_private.affiliate_commission_jobs
    where status = 'dead_letter'
    having count(*) > 0
    union all
    select
      'maturation_dead_letter',
      'critical',
      count(*)::bigint
    from affiliate_private.affiliate_maturation_jobs
    where status = 'dead_letter'
    having count(*) > 0
    union all
    select
      'financial_fact_conflict',
      'critical',
      count(*)::bigint
    from affiliate_private.affiliate_financial_fact_conflicts
    having count(*) > 0
    union all
    select
      'financial_transfer_quarantined_recent',
      'warning',
      count(*)::bigint
    from affiliate_private.affiliate_financial_facts
    where event_type = 'transfer'
      and facts_status = 'quarantined'
      and created_at >= now() - interval '24 hours'
    having count(*) > 0
    union all
    select
      'shadow_reconciliation_mismatch',
      'critical',
      r.mismatch_count
    from affiliate_private.affiliate_shadow_reconciliation_runs r
    where r.id = (
      select latest.id
      from affiliate_private.affiliate_shadow_reconciliation_runs latest
      order by latest.created_at desc
      limit 1
    )
      and r.status = 'mismatch'
    union all
    select
      'kyc_quota_warning',
      case when v_kyc_used >= 500 then 'critical' else 'warning' end,
      v_kyc_used
    where v_kyc_used >= 400
    union all
    select
      'worker_heartbeat_missing',
      'critical',
      count(*)::bigint
    from (
      values
        ('commission'::text),
        ('maturation'::text),
        ('reconciliation'::text)
    ) expected(worker_name)
    left join affiliate_private.affiliate_worker_heartbeats h
      on h.worker_name = expected.worker_name
      and h.last_seen_at >= now() - interval '15 minutes'
    where h.worker_name is null
    having count(*) > 0
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'code', a.code,
        'severity', a.severity,
        'count', a.count
      )
      order by a.severity, a.code
    ),
    '[]'::jsonb
  )
  into v_alerts
  from alerts a;

  return jsonb_build_object(
    'schema_version', 1,
    'workers', v_workers,
    'alerts', v_alerts,
    'kyc_quota', jsonb_build_object(
      'used', v_kyc_used,
      'informational_limit', 500,
      'blocking', false
    )
  );
end;
$$;

create or replace function affiliate_private.admin_partners_monitoring()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (
    affiliate_private.partners_has_capability('support')
    or affiliate_private.partners_has_capability('risk')
    or affiliate_private.partners_has_capability('finance')
  ) then
    raise exception 'Partners Admin capability is required'
      using errcode = '42501';
  end if;
  return affiliate_private.partners_ops_alert_snapshot();
end;
$$;

-- Replace the phase-one readiness placeholders now that the financial,
-- fraud-review and payout control planes are installed. Capability checks,
-- not the legacy broad admin predicate, are authoritative for these reads.
create or replace function
affiliate_private.partners_payout_operations_ready()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    coalesce((
      select flag.enabled
      from public.admin_feature_flags flag
      where flag.key = 'partners_payouts_live'
    ), false)
    and affiliate_private.release_gates_satisfied(
      array['payout_execution_adapter_verified']::text[]
    )
    and exists (
      select 1
      from affiliate_private.affiliate_payout_provider_configs provider
      where provider.status = 'active'
    );
$$;

create or replace function
affiliate_private.partners_payout_operations_reason()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when not affiliate_private.release_gates_satisfied(
      array['payout_execution_adapter_verified']::text[]
    ) then 'payout_execution_adapter_not_verified'
    when not exists (
      select 1
      from affiliate_private.affiliate_payout_provider_configs provider
      where provider.status = 'active'
    ) then 'payout_provider_not_configured'
    when not coalesce((
      select flag.enabled
      from public.admin_feature_flags flag
      where flag.key = 'partners_payouts_live'
    ), false) then 'payouts_not_live'
    else 'available'
  end;
$$;

revoke all on function
  affiliate_private.partners_payout_operations_ready()
  from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.partners_payout_operations_reason()
  from public, anon, authenticated, service_role;

create or replace function affiliate_private.admin_partners_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_account_statuses jsonb;
  v_verification_statuses jsonb;
  v_link_statuses jsonb;
begin
  perform affiliate_private.partners_require_capability('support');
  select coalesce(
    jsonb_object_agg(statuses.status, statuses.total),
    '{}'::jsonb
  )
  into v_account_statuses
  from (
    select account.status, count(*) as total
    from affiliate_private.affiliate_accounts account
    group by account.status
    order by account.status
  ) statuses;
  select coalesce(
    jsonb_object_agg(statuses.verification_status, statuses.total),
    '{}'::jsonb
  )
  into v_verification_statuses
  from (
    select account.verification_status, count(*) as total
    from affiliate_private.affiliate_accounts account
    where account.status <> 'closed'
    group by account.verification_status
    order by account.verification_status
  ) statuses;
  select coalesce(
    jsonb_object_agg(statuses.status, statuses.total),
    '{}'::jsonb
  )
  into v_link_statuses
  from (
    select link.status, count(*) as total
    from affiliate_private.affiliate_links link
    group by link.status
    order by link.status
  ) statuses;
  return jsonb_build_object(
    'schema_version', 1,
    'accounts_total', (
      select count(*) from affiliate_private.affiliate_accounts
    ),
    'accounts_open', (
      select count(*)
      from affiliate_private.affiliate_accounts account
      where account.status <> 'closed'
    ),
    'account_statuses', v_account_statuses,
    'verification_statuses', v_verification_statuses,
    'link_statuses', v_link_statuses,
    'readiness', jsonb_build_object(
      'member_accounts', true,
      'member_links', true,
      'audit_history', true,
      'financial_ledger', true,
      'fraud_workbench', true,
      'payout_operations',
        affiliate_private.partners_payout_operations_ready(),
      'reason', affiliate_private.partners_payout_operations_reason()
    ),
    'generated_at', now()
  );
end;
$$;

create or replace function affiliate_private.admin_partners_detail(
  p_account_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_account affiliate_private.affiliate_accounts%rowtype;
  v_program affiliate_private.affiliate_program_versions%rowtype;
  v_policy affiliate_private.affiliate_country_policies%rowtype;
  v_link affiliate_private.affiliate_links%rowtype;
  v_activity jsonb := '[]'::jsonb;
begin
  perform affiliate_private.partners_require_capability('support');
  if p_account_id is null then
    raise exception 'account id is required' using errcode = '22023';
  end if;
  select account.*
  into v_account
  from affiliate_private.affiliate_accounts account
  where account.id = p_account_id;
  if not found then
    raise exception 'Partners account not found' using errcode = 'P0002';
  end if;
  select program.*
  into v_program
  from affiliate_private.affiliate_program_versions program
  where program.id = v_account.program_version_id;
  select policy.*
  into v_policy
  from affiliate_private.affiliate_country_policies policy
  where policy.id = v_account.country_policy_id;
  select link.*
  into v_link
  from affiliate_private.affiliate_links link
  where link.account_id = v_account.id
  order by
    case when link.status = 'active' then 0 else 1 end,
    link.created_at desc
  limit 1;
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'action', event.action,
        'actor_type', event.actor_type,
        'occurred_at', event.created_at
      )
      order by event.sequence_no desc
    ),
    '[]'::jsonb
  )
  into v_activity
  from (
    select source_event.*
    from affiliate_private.affiliate_events source_event
    where source_event.aggregate_type = 'account'
      and source_event.aggregate_key = v_account.id::text
    order by source_event.sequence_no desc
    limit 50
  ) event;
  return jsonb_build_object(
    'schema_version', 1,
    'account', jsonb_build_object(
      'account_id', v_account.id,
      'partner_key', left(v_account.user_pseudonym, 12),
      'account_type', v_account.account_type,
      'status', v_account.status,
      'country_code', v_account.country_code,
      'subdivision_code', v_account.subdivision_code,
      'verification_status', v_account.verification_status,
      'age_verified', v_account.age_verified,
      'capacity_verified', v_account.capacity_verified,
      'contract_status', v_account.contract_status,
      'terms_version_accepted', v_account.terms_version_accepted,
      'disclosure_version_accepted',
        v_account.disclosure_version_accepted,
      'created_at', v_account.created_at,
      'updated_at', v_account.updated_at,
      'closed_at', v_account.closed_at
    ),
    'program',
      case
        when v_program.id is null then null
        else jsonb_build_object(
          'version_key', v_program.version_key,
          'commission_rate_bps', v_program.commission_rate_bps,
          'attribution_window_days', v_program.attribution_window_days,
          'maturation_days', v_program.maturation_days,
          'status', v_program.status
        )
      end,
    'policy',
      case
        when v_policy.id is null then null
        else jsonb_build_object(
          'country_code', v_policy.country_code,
          'subdivision_code', v_policy.subdivision_code,
          'minimum_age', v_policy.minimum_age,
          'capacity_required', v_policy.capacity_required,
          'verification_level', v_policy.verification_level,
          'payout_currencies', v_policy.payout_currencies,
          'terms_version', v_policy.terms_version,
          'disclosure_version', v_policy.disclosure_version
        )
      end,
    'link',
      case
        when v_link.id is null then null
        else jsonb_build_object(
          'status', v_link.status,
          'code_preview',
            left(v_link.public_code, 4)
            || '...'
            || right(v_link.public_code, 4),
          'created_at', v_link.created_at,
          'revoked_at', v_link.revoked_at
        )
      end,
    'activity', v_activity,
    'readiness', jsonb_build_object(
      'financial_ledger', true,
      'fraud_workbench', true,
      'payout_operations',
        affiliate_private.partners_payout_operations_ready(),
      'reason', affiliate_private.partners_payout_operations_reason()
    )
  );
end;
$$;

create or replace function affiliate_private.admin_partners_configuration()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_programs jsonb;
  v_policies jsonb;
  v_release_flags jsonb;
  v_release_gates jsonb;
begin
  perform affiliate_private.partners_require_capability('support');
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'version_key', p.version_key,
        'status', p.status,
        'commission_rate_bps', p.commission_rate_bps,
        'attribution_window_days', p.attribution_window_days,
        'maturation_days', p.maturation_days,
        'terms_version', p.terms_version,
        'disclosure_version', p.disclosure_version,
        'effective_from', p.effective_from,
        'effective_until', p.effective_until
      )
      order by p.created_at desc
    ),
    '[]'::jsonb
  )
  into v_programs
  from affiliate_private.affiliate_program_versions p;
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'program_version_key', p.version_key,
        'country_code', cp.country_code,
        'subdivision_code', cp.subdivision_code,
        'individual_available', cp.individual_available,
        'minimum_age', cp.minimum_age,
        'payout_currencies', cp.payout_currencies,
        'kyc_attempt_policy', case
          when ap.country_policy_id is null then null
          else jsonb_build_object(
            'status', ap.status,
            'max_attempts', ap.max_attempts,
            'window_seconds', ap.window_seconds,
            'cooldown_seconds', ap.cooldown_seconds
          )
        end
      )
      order by p.version_key, cp.country_code, cp.subdivision_code
    ),
    '[]'::jsonb
  )
  into v_policies
  from affiliate_private.affiliate_country_policies cp
  join affiliate_private.affiliate_program_versions p
    on p.id = cp.program_version_id
  left join affiliate_private.affiliate_kyc_attempt_policies ap
    on ap.country_policy_id = cp.id;

  with managed_flags(flag_key, position) as (
    values
      ('partners_enabled'::text, 1),
      ('partners_invite_only'::text, 2),
      ('partners_shadow_mode'::text, 3),
      ('partners_payouts_live'::text, 4),
      ('partners_tv_relay_enabled'::text, 5)
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'key', managed.flag_key,
        'enabled', coalesce(flag.enabled, false)
      )
      order by managed.position
    ),
    '[]'::jsonb
  )
  into v_release_flags
  from managed_flags managed
  left join public.admin_feature_flags flag
    on flag.key = managed.flag_key;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'key', gate.gate_key,
        'satisfied', gate.satisfied,
        'updated_at', gate.updated_at
      )
      order by gate.gate_key
    ),
    '[]'::jsonb
  )
  into v_release_gates
  from affiliate_private.affiliate_release_gates gate;

  return jsonb_build_object(
    'schema_version', 1,
    'programs', v_programs,
    'policies', v_policies,
    'release_flags', v_release_flags,
    'release_gates', v_release_gates,
    'configuration_counts', jsonb_build_object(
      'active_country_mappings', (
        select count(*)
        from affiliate_private.affiliate_country_code_mappings
        where status = 'active'
      ),
      'active_currencies', (
        select count(*)
        from affiliate_private.affiliate_currency_metadata
        where status = 'active'
      ),
      'active_payout_providers', (
        select count(*)
        from affiliate_private.affiliate_payout_provider_configs
        where status = 'active'
      ),
      'active_allowlist_entries', (
        select count(*)
        from affiliate_private.affiliate_pilot_allowlist
        where status = 'active'
          and (expires_at is null or expires_at > now())
      )
    )
  );
end;
$$;

-- Replace the member dashboard placeholder once the immutable finance,
-- attribution and payout relations exist. The boundary deliberately exposes
-- neither ledger identifiers, referral codes nor financial event amounts in
-- history; aggregate balances remain the only monetary member output.
create or replace function affiliate_private.partners_service_dashboard(
  p_user_id uuid,
  p_history_limit integer,
  p_history_cursor text,
  p_history_status text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := coalesce(p_history_limit, 25);
  v_status text := lower(btrim(coalesce(p_history_status, 'all')));
  v_cursor bigint := null;
  v_account affiliate_private.affiliate_accounts%rowtype;
  v_link affiliate_private.affiliate_links%rowtype;
  v_clicks bigint := 0;
  v_referrals bigint := 0;
  v_currency_count integer := 0;
  v_currency text := null;
  v_pending_minor bigint := null;
  v_available_minor bigint := null;
  v_paid_minor bigint := null;
  v_currency_balances jsonb := '[]'::jsonb;
  v_reporting_available boolean := false;
  v_reporting_reason text := 'no_financial_activity';
  v_items jsonb := '[]'::jsonb;
  v_candidate_count integer := 0;
  v_last_sequence bigint := null;
  v_next_cursor text := null;
begin
  if p_user_id is null then
    raise exception 'user id is required' using errcode = '22023';
  end if;
  if v_limit not between 1 and 50 then
    raise exception 'history limit must be between 1 and 50'
      using errcode = '22023';
  end if;
  if v_status not in (
    'all',
    'pending',
    'available',
    'held',
    'paid',
    'reversed'
  ) then
    raise exception 'invalid history status' using errcode = '22023';
  end if;
  if p_history_cursor is not null then
    if p_history_cursor !~ '^history_[0-9]{20}$' then
      raise exception 'invalid history cursor' using errcode = '22023';
    end if;
    begin
      v_cursor := substring(p_history_cursor from 9)::bigint;
    exception
      when numeric_value_out_of_range then
        raise exception 'invalid history cursor' using errcode = '22023';
    end;
  end if;

  perform 1
  from auth.users u
  where u.id = p_user_id;
  if not found then
    raise exception 'user not found' using errcode = 'P0002';
  end if;

  select a.*
  into v_account
  from affiliate_private.affiliate_accounts a
  where a.user_id = p_user_id
    and a.status <> 'closed'
  order by a.created_at desc
  limit 1;

  if not found then
    return jsonb_build_object(
      'schema_version', 1,
      'account', jsonb_build_object(
        'exists', false,
        'status', null,
        'verification_status', null,
        'contract_status', null,
        'link_status', null,
        'country_code', null,
        'subdivision_code', null,
        'created_at', null,
        'updated_at', null
      ),
      'link', null,
      'reporting', jsonb_build_object(
        'available', false,
        'reason', 'no_financial_activity',
        'currency', null,
        'clicks', 0,
        'referrals', 0,
        'pending_minor', null,
        'available_minor', null,
        'paid_minor', null,
        'currencies', '[]'::jsonb
      ),
      'history', jsonb_build_object(
        'status', v_status,
        'items', '[]'::jsonb,
        'next_cursor', null
      )
    );
  end if;

  select l.*
  into v_link
  from affiliate_private.affiliate_links l
  where l.account_id = v_account.id
    and l.status = 'active'
  order by l.created_at desc
  limit 1;

  select count(*)::bigint
  into v_clicks
  from affiliate_private.affiliate_link_claims claim
  where claim.referrer_account_id = v_account.id;

  select count(*)::bigint
  into v_referrals
  from affiliate_private.affiliate_attributions attribution
  where attribution.referrer_account_id = v_account.id;

  with currency_balances as (
    select
      posting.currency,
      coalesce(sum(
        case
          when posting.ledger_account = 'partner_commission_pending'
            and posting.direction = 'credit'
            then posting.amount_minor
          when posting.ledger_account = 'partner_commission_pending'
            and posting.direction = 'debit'
            then -posting.amount_minor
          else 0
        end
      ), 0)::bigint as pending_minor,
      affiliate_private.partners_account_payable_balance(
        v_account.id,
        posting.currency
      ) as available_minor,
      coalesce(sum(
        case
          when posting.ledger_account = 'partner_cash_settled'
            and posting.direction = 'credit'
            then posting.amount_minor
          when posting.ledger_account = 'partner_cash_settled'
            and posting.direction = 'debit'
            then -posting.amount_minor
          else 0
        end
      ), 0)::bigint as paid_minor,
      exists (
        select 1
        from affiliate_private.affiliate_payout_profiles profile
        join affiliate_private.affiliate_payout_provider_configs provider
          on provider.provider = profile.provider
          and provider.country_code = v_account.country_code
          and provider.currency = profile.currency
          and provider.status = 'active'
        where profile.account_id = v_account.id
          and profile.currency = posting.currency
          and profile.status = 'active'
      ) as payout_destination_ready
    from affiliate_private.affiliate_commission_postings posting
    join affiliate_private.affiliate_commission_entries entry
      on entry.id = posting.entry_id
    where entry.account_id = v_account.id
    group by posting.currency
  )
  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'currency', balance.currency,
          'pending_minor', balance.pending_minor,
          'available_minor', balance.available_minor,
          'paid_minor', balance.paid_minor,
          'payout_destination_ready',
            balance.payout_destination_ready
        )
        order by balance.currency
      ),
      '[]'::jsonb
    ),
    count(*)::integer,
    min(balance.currency)
  into v_currency_balances, v_currency_count, v_currency
  from currency_balances balance;

  if v_currency_count = 1 then
    v_reporting_available := true;
    v_reporting_reason := 'available';
    v_pending_minor :=
      (v_currency_balances -> 0 ->> 'pending_minor')::bigint;
    v_available_minor :=
      (v_currency_balances -> 0 ->> 'available_minor')::bigint;
    v_paid_minor :=
      (v_currency_balances -> 0 ->> 'paid_minor')::bigint;
  elsif v_currency_count > 1 then
    v_reporting_available := true;
    v_currency := null;
    v_reporting_reason := 'multiple_currencies';
  end if;

  with normalized as (
    select
      entry.sequence_no,
      entry.created_at,
      case entry.entry_kind
        when 'accrual' then 'pending'
        when 'release' then 'available'
        when 'payout_allocation' then 'held'
        when 'payout_settlement' then 'paid'
        else 'reversed'
      end as activity_status,
      case entry.entry_kind
        when 'accrual' then 'commission_pending'
        when 'release' then 'commission_available'
        when 'payout_allocation' then 'commission_held'
        when 'payout_settlement' then 'commission_paid'
        else 'commission_reversed'
      end as activity_type
    from affiliate_private.affiliate_commission_entries entry
    where entry.account_id = v_account.id
      and (v_cursor is null or entry.sequence_no < v_cursor)
  ),
  candidates as (
    select n.*
    from normalized n
    where v_status = 'all' or n.activity_status = v_status
    order by n.sequence_no desc
    limit v_limit + 1
  ),
  page as (
    select c.*
    from candidates c
    order by c.sequence_no desc
    limit v_limit
  )
  select
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'type', p.activity_type,
          'occurred_at', p.created_at
        )
        order by p.sequence_no desc
      )
      from page p
    ), '[]'::jsonb),
    (select count(*) from candidates),
    (select min(p.sequence_no) from page p)
  into v_items, v_candidate_count, v_last_sequence;

  if v_candidate_count > v_limit and v_last_sequence is not null then
    v_next_cursor := 'history_'
      || lpad(v_last_sequence::text, 20, '0');
  end if;

  return jsonb_build_object(
    'schema_version', 1,
    'account',
      affiliate_private.partners_account_state(v_account)
      || jsonb_build_object(
        'country_code', v_account.country_code,
        'subdivision_code', v_account.subdivision_code,
        'created_at', v_account.created_at,
        'updated_at', v_account.updated_at
      ),
    'link',
      case
        when v_link.id is null then null
        else jsonb_build_object(
          'status', 'active',
          'share_url', 'https://norva.tv/r/' || v_link.public_code,
          'created_at', v_link.created_at
        )
      end,
    'reporting', jsonb_build_object(
      'available', v_reporting_available,
      'reason', v_reporting_reason,
      'currency', v_currency,
      'clicks', v_clicks,
      'referrals', v_referrals,
      'pending_minor', v_pending_minor,
      'available_minor', v_available_minor,
      'paid_minor', v_paid_minor,
      'currencies', v_currency_balances
    ),
    'history', jsonb_build_object(
      'status', v_status,
      'items', v_items,
      'next_cursor', v_next_cursor
    )
  );
end;
$$;

revoke all on function affiliate_private.partners_service_dashboard(
  uuid, integer, text, text
) from public, anon, authenticated;
grant execute on function affiliate_private.partners_service_dashboard(
  uuid, integer, text, text
) to service_role;

-- Public shims preserve PostgREST discoverability while all privileged
-- implementations and canonical data remain in the private schema.
create or replace function public.partners_service_tv_relay_availability(
  p_device_hash text
)
returns jsonb language sql stable security invoker set search_path = ''
as $$
  select affiliate_private.partners_service_tv_relay_availability(
    p_device_hash
  );
$$;

create or replace function public.partners_service_tv_relay_create(
  p_device_hash text,
  p_relay_token_hash text,
  p_request_nonce_hash text,
  p_expires_at timestamptz
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$
  select affiliate_private.partners_service_tv_relay_create(
    p_device_hash,
    p_relay_token_hash,
    p_request_nonce_hash,
    p_expires_at
  );
$$;

create or replace function public.partners_service_tv_relay_status(
  p_device_hash text,
  p_relay_token_hash text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$
  select affiliate_private.partners_service_tv_relay_status(
    p_device_hash,
    p_relay_token_hash
  );
$$;

create or replace function public.partners_service_tv_relay_consume(
  p_user_id uuid,
  p_relay_token_hash text,
  p_idempotency_key text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$
  select affiliate_private.partners_service_tv_relay_consume(
    p_user_id,
    p_relay_token_hash,
    p_idempotency_key
  );
$$;

create or replace function public.partners_worker_heartbeat(
  p_worker_name text,
  p_status text,
  p_details jsonb
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$
  select affiliate_private.partners_worker_heartbeat(
    p_worker_name,
    p_status,
    p_details
  );
$$;

create or replace function
public.partners_service_prepare_account_deletion(p_user_id uuid)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select
    affiliate_private.partners_service_prepare_account_deletion(p_user_id);
$$;

create or replace function public.partners_service_ops_alert_snapshot()
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if current_user <> 'service_role' then
    raise exception 'service role is required'
      using errcode = '42501';
  end if;
  return affiliate_private.partners_ops_alert_snapshot();
end;
$$;

create or replace function public.admin_partners_capabilities()
returns jsonb language sql stable security invoker set search_path = ''
as $$ select affiliate_private.admin_partners_capabilities(); $$;

create or replace function public.admin_partners_capability_set(
  p_user_id uuid,
  p_capability text,
  p_enabled boolean,
  p_justification text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$
  select affiliate_private.admin_partners_capability_set(
    p_user_id, p_capability, p_enabled, p_justification
  );
$$;

create or replace function public.admin_partners_program_create(
  p_version_key text,
  p_payout_thresholds jsonb,
  p_terms_version text,
  p_disclosure_version text,
  p_effective_from timestamptz,
  p_justification text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$
  select affiliate_private.admin_partners_program_create(
    p_version_key,
    p_payout_thresholds,
    p_terms_version,
    p_disclosure_version,
    p_effective_from,
    p_justification
  );
$$;

create or replace function public.admin_partners_program_activate(
  p_version_key text,
  p_confirmation text,
  p_justification text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$
  select affiliate_private.admin_partners_program_activate(
    p_version_key, p_confirmation, p_justification
  );
$$;

create or replace function public.admin_partners_country_policy_create(
  p_program_version_key text,
  p_country_code text,
  p_subdivision_code text,
  p_minimum_age integer,
  p_payout_currencies text[],
  p_effective_from timestamptz,
  p_justification text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$
  select affiliate_private.admin_partners_country_policy_create(
    p_program_version_key,
    p_country_code,
    p_subdivision_code,
    p_minimum_age,
    p_payout_currencies,
    p_effective_from,
    p_justification
  );
$$;

create or replace function public.admin_partners_kyc_attempt_policy_set(
  p_program_version_key text,
  p_country_code text,
  p_subdivision_code text,
  p_max_attempts integer,
  p_window_seconds integer,
  p_cooldown_seconds integer,
  p_status text,
  p_justification text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$
  select affiliate_private.admin_partners_kyc_attempt_policy_set(
    p_program_version_key,
    p_country_code,
    p_subdivision_code,
    p_max_attempts,
    p_window_seconds,
    p_cooldown_seconds,
    p_status,
    p_justification
  );
$$;

create or replace function public.admin_partners_country_mapping_set(
  p_iso3 text,
  p_country_code text,
  p_status text,
  p_justification text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$
  select affiliate_private.admin_partners_country_mapping_set(
    p_iso3, p_country_code, p_status, p_justification
  );
$$;

create or replace function public.admin_partners_currency_set(
  p_currency text,
  p_exponent integer,
  p_status text,
  p_justification text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$
  select affiliate_private.admin_partners_currency_set(
    p_currency, p_exponent, p_status, p_justification
  );
$$;

create or replace function public.admin_partners_payout_provider_set(
  p_provider text,
  p_country_code text,
  p_currency text,
  p_status text,
  p_justification text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$
  select affiliate_private.admin_partners_payout_provider_set(
    p_provider,
    p_country_code,
    p_currency,
    p_status,
    p_justification
  );
$$;

create or replace function
public.admin_partners_country_policy_set_available(
  p_program_version_key text,
  p_country_code text,
  p_subdivision_code text,
  p_enabled boolean,
  p_confirmation text,
  p_justification text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$
  select affiliate_private.admin_partners_country_policy_set_available(
    p_program_version_key,
    p_country_code,
    p_subdivision_code,
    p_enabled,
    p_confirmation,
    p_justification
  );
$$;

create or replace function public.admin_partners_fiscal_review(
  p_account_id uuid,
  p_status text,
  p_residence_country_code text,
  p_provider text,
  p_reference_hash text,
  p_tax_form_type text,
  p_justification text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$
  select affiliate_private.admin_partners_fiscal_review(
    p_account_id,
    p_status,
    p_residence_country_code,
    p_provider,
    p_reference_hash,
    p_tax_form_type,
    p_justification
  );
$$;

create or replace function public.admin_partners_account_action(
  p_account_public_id text,
  p_action text,
  p_confirmation text,
  p_justification text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$
  select affiliate_private.admin_partners_account_action(
    p_account_public_id, p_action, p_confirmation, p_justification
  );
$$;

create or replace function public.admin_partners_job_retry(
  p_job_key text,
  p_job_type text,
  p_confirmation text,
  p_justification text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$
  select affiliate_private.admin_partners_job_retry(
    p_job_key, p_job_type, p_confirmation, p_justification
  );
$$;

create or replace function public.admin_partners_commission_reverse(
  p_entry_key text,
  p_confirmation text,
  p_justification text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$
  select affiliate_private.admin_partners_commission_reverse(
    p_entry_key, p_confirmation, p_justification
  );
$$;

create or replace function public.admin_partners_payout_cycle_create(
  p_period_start date,
  p_period_end date,
  p_currency text,
  p_live_execution boolean,
  p_confirmation text,
  p_justification text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$
  select affiliate_private.admin_partners_payout_cycle_create(
    p_period_start,
    p_period_end,
    p_currency,
    p_live_execution,
    p_confirmation,
    p_justification
  );
$$;

create or replace function public.admin_partners_payout_cycle_approve(
  p_cycle_key text,
  p_confirmation text,
  p_justification text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$
  select affiliate_private.admin_partners_payout_cycle_approve(
    p_cycle_key, p_confirmation, p_justification
  );
$$;

create or replace function public.admin_partners_risk_queue(
  p_limit integer,
  p_offset integer,
  p_status text
)
returns jsonb language sql stable security invoker set search_path = ''
as $$
  select affiliate_private.admin_partners_risk_queue(
    p_limit, p_offset, p_status
  );
$$;

create or replace function public.admin_partners_finance_overview()
returns jsonb language sql stable security invoker set search_path = ''
as $$ select affiliate_private.admin_partners_finance_overview(); $$;

create or replace function public.admin_partners_payout_cycles(
  p_limit integer,
  p_offset integer,
  p_status text
)
returns jsonb language sql stable security invoker set search_path = ''
as $$
  select affiliate_private.admin_partners_payout_cycles(
    p_limit, p_offset, p_status
  );
$$;

create or replace function public.admin_partners_kyc_quota()
returns jsonb language sql stable security invoker set search_path = ''
as $$ select affiliate_private.admin_partners_kyc_quota(); $$;

create or replace function public.admin_partners_analytics(p_days integer)
returns jsonb language sql stable security invoker set search_path = ''
as $$ select affiliate_private.admin_partners_analytics(p_days); $$;

create or replace function public.admin_partners_monitoring()
returns jsonb language sql stable security invoker set search_path = ''
as $$ select affiliate_private.admin_partners_monitoring(); $$;

create or replace function public.admin_partners_configuration()
returns jsonb language sql stable security invoker set search_path = ''
as $$ select affiliate_private.admin_partners_configuration(); $$;

do $partners_permissions$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'affiliate_private.guard_tv_relay_session_transition()',
    'affiliate_private.guard_link_claim_transition()',
    'affiliate_private.guard_attribution_transition()',
    'affiliate_private.reject_partners_finance_mutation()',
    'affiliate_private.guard_affiliate_auth_user_transition()',
    'affiliate_private.partners_admin_actor_pseudonym()',
    'affiliate_private.partners_has_capability(text)',
    'affiliate_private.partners_can_manage_capabilities()',
    'affiliate_private.partners_is_release_manager()',
    'affiliate_private.partners_require_control_access(text,text,boolean)',
    'affiliate_private.partners_require_capability(text)',
    'affiliate_private.partners_user_deletion_pseudonym(uuid)',
    'affiliate_private.partners_device_deletion_pseudonym(uuid)',
    'affiliate_private.partners_account_deletion_ready(uuid)',
    'affiliate_private.partners_service_prepare_account_deletion(uuid)',
    'affiliate_private.partners_ops_alert_snapshot()',
    'affiliate_private.partners_tv_relay_enabled()',
    'affiliate_private.partners_service_tv_relay_availability(text)',
    'affiliate_private.partners_service_tv_relay_create(text,text,text,timestamptz)',
    'affiliate_private.partners_service_tv_relay_status(text,text)',
    'affiliate_private.partners_service_tv_relay_consume(uuid,text,text)',
    'affiliate_private.partners_worker_heartbeat(text,text,jsonb)',
    'affiliate_private.admin_partners_capabilities()',
    'affiliate_private.admin_partners_capability_set(uuid,text,boolean,text)',
    'affiliate_private.admin_partners_program_create(text,jsonb,text,text,timestamptz,text)',
    'affiliate_private.admin_partners_program_activate(text,text,text)',
    'affiliate_private.admin_partners_country_policy_create(text,text,text,integer,text[],timestamptz,text)',
    'affiliate_private.admin_partners_kyc_attempt_policy_set(text,text,text,integer,integer,integer,text,text)',
    'affiliate_private.admin_partners_country_mapping_set(text,text,text,text)',
    'affiliate_private.admin_partners_currency_set(text,integer,text,text)',
    'affiliate_private.admin_partners_payout_provider_set(text,text,text,text,text)',
    'affiliate_private.admin_partners_country_policy_set_available(text,text,text,boolean,text,text)',
    'affiliate_private.admin_partners_fiscal_review(uuid,text,text,text,text,text,text)',
    'affiliate_private.admin_partners_account_action(text,text,text,text)',
    'affiliate_private.admin_partners_job_retry(text,text,text,text)',
    'affiliate_private.admin_partners_commission_reverse(text,text,text)',
    'affiliate_private.admin_partners_payout_cycle_create(date,date,text,boolean,text,text)',
    'affiliate_private.admin_partners_payout_cycle_approve(text,text,text)',
    'affiliate_private.admin_partners_risk_queue(integer,integer,text)',
    'affiliate_private.admin_partners_finance_overview()',
    'affiliate_private.admin_partners_payout_cycles(integer,integer,text)',
    'affiliate_private.admin_partners_kyc_quota()',
    'affiliate_private.admin_partners_analytics(integer)',
    'affiliate_private.admin_partners_monitoring()',
    'affiliate_private.admin_partners_configuration()',
    'public.partners_service_tv_relay_availability(text)',
    'public.partners_service_tv_relay_create(text,text,text,timestamptz)',
    'public.partners_service_tv_relay_status(text,text)',
    'public.partners_service_tv_relay_consume(uuid,text,text)',
    'public.partners_worker_heartbeat(text,text,jsonb)',
    'public.partners_service_prepare_account_deletion(uuid)',
    'public.partners_service_ops_alert_snapshot()',
    'public.admin_partners_capabilities()',
    'public.admin_partners_capability_set(uuid,text,boolean,text)',
    'public.admin_partners_program_create(text,jsonb,text,text,timestamptz,text)',
    'public.admin_partners_program_activate(text,text,text)',
    'public.admin_partners_country_policy_create(text,text,text,integer,text[],timestamptz,text)',
    'public.admin_partners_kyc_attempt_policy_set(text,text,text,integer,integer,integer,text,text)',
    'public.admin_partners_country_mapping_set(text,text,text,text)',
    'public.admin_partners_currency_set(text,integer,text,text)',
    'public.admin_partners_payout_provider_set(text,text,text,text,text)',
    'public.admin_partners_country_policy_set_available(text,text,text,boolean,text,text)',
    'public.admin_partners_fiscal_review(uuid,text,text,text,text,text,text)',
    'public.admin_partners_account_action(text,text,text,text)',
    'public.admin_partners_job_retry(text,text,text,text)',
    'public.admin_partners_commission_reverse(text,text,text)',
    'public.admin_partners_payout_cycle_create(date,date,text,boolean,text,text)',
    'public.admin_partners_payout_cycle_approve(text,text,text)',
    'public.admin_partners_risk_queue(integer,integer,text)',
    'public.admin_partners_finance_overview()',
    'public.admin_partners_payout_cycles(integer,integer,text)',
    'public.admin_partners_kyc_quota()',
    'public.admin_partners_analytics(integer)',
    'public.admin_partners_monitoring()',
    'public.admin_partners_configuration()'
  ]
  loop
    execute
      'revoke all on function ' || v_signature
      || ' from public, anon, authenticated, service_role';
  end loop;

  foreach v_signature in array array[
    'affiliate_private.partners_service_tv_relay_availability(text)',
    'affiliate_private.partners_service_tv_relay_create(text,text,text,timestamptz)',
    'affiliate_private.partners_service_tv_relay_status(text,text)',
    'affiliate_private.partners_service_tv_relay_consume(uuid,text,text)',
    'affiliate_private.partners_worker_heartbeat(text,text,jsonb)',
    'affiliate_private.partners_service_prepare_account_deletion(uuid)',
    'affiliate_private.partners_ops_alert_snapshot()',
    'public.partners_service_tv_relay_availability(text)',
    'public.partners_service_tv_relay_create(text,text,text,timestamptz)',
    'public.partners_service_tv_relay_status(text,text)',
    'public.partners_service_tv_relay_consume(uuid,text,text)',
    'public.partners_worker_heartbeat(text,text,jsonb)',
    'public.partners_service_prepare_account_deletion(uuid)',
    'public.partners_service_ops_alert_snapshot()'
  ]
  loop
    execute 'grant execute on function ' || v_signature
      || ' to service_role';
  end loop;

  foreach v_signature in array array[
    'affiliate_private.admin_partners_capabilities()',
    'affiliate_private.admin_partners_capability_set(uuid,text,boolean,text)',
    'affiliate_private.admin_partners_program_create(text,jsonb,text,text,timestamptz,text)',
    'affiliate_private.admin_partners_program_activate(text,text,text)',
    'affiliate_private.admin_partners_country_policy_create(text,text,text,integer,text[],timestamptz,text)',
    'affiliate_private.admin_partners_kyc_attempt_policy_set(text,text,text,integer,integer,integer,text,text)',
    'affiliate_private.admin_partners_country_mapping_set(text,text,text,text)',
    'affiliate_private.admin_partners_currency_set(text,integer,text,text)',
    'affiliate_private.admin_partners_payout_provider_set(text,text,text,text,text)',
    'affiliate_private.admin_partners_country_policy_set_available(text,text,text,boolean,text,text)',
    'affiliate_private.admin_partners_fiscal_review(uuid,text,text,text,text,text,text)',
    'affiliate_private.admin_partners_account_action(text,text,text,text)',
    'affiliate_private.admin_partners_job_retry(text,text,text,text)',
    'affiliate_private.admin_partners_commission_reverse(text,text,text)',
    'affiliate_private.admin_partners_payout_cycle_create(date,date,text,boolean,text,text)',
    'affiliate_private.admin_partners_payout_cycle_approve(text,text,text)',
    'affiliate_private.admin_partners_risk_queue(integer,integer,text)',
    'affiliate_private.admin_partners_finance_overview()',
    'affiliate_private.admin_partners_payout_cycles(integer,integer,text)',
    'affiliate_private.admin_partners_kyc_quota()',
    'affiliate_private.admin_partners_analytics(integer)',
    'affiliate_private.admin_partners_monitoring()',
    'affiliate_private.admin_partners_configuration()',
    'public.admin_partners_capabilities()',
    'public.admin_partners_capability_set(uuid,text,boolean,text)',
    'public.admin_partners_program_create(text,jsonb,text,text,timestamptz,text)',
    'public.admin_partners_program_activate(text,text,text)',
    'public.admin_partners_country_policy_create(text,text,text,integer,text[],timestamptz,text)',
    'public.admin_partners_kyc_attempt_policy_set(text,text,text,integer,integer,integer,text,text)',
    'public.admin_partners_country_mapping_set(text,text,text,text)',
    'public.admin_partners_currency_set(text,integer,text,text)',
    'public.admin_partners_payout_provider_set(text,text,text,text,text)',
    'public.admin_partners_country_policy_set_available(text,text,text,boolean,text,text)',
    'public.admin_partners_fiscal_review(uuid,text,text,text,text,text,text)',
    'public.admin_partners_account_action(text,text,text,text)',
    'public.admin_partners_job_retry(text,text,text,text)',
    'public.admin_partners_commission_reverse(text,text,text)',
    'public.admin_partners_payout_cycle_create(date,date,text,boolean,text,text)',
    'public.admin_partners_payout_cycle_approve(text,text,text)',
    'public.admin_partners_risk_queue(integer,integer,text)',
    'public.admin_partners_finance_overview()',
    'public.admin_partners_payout_cycles(integer,integer,text)',
    'public.admin_partners_kyc_quota()',
    'public.admin_partners_analytics(integer)',
    'public.admin_partners_monitoring()',
    'public.admin_partners_configuration()'
  ]
  loop
    execute 'grant execute on function ' || v_signature
      || ' to authenticated';
  end loop;
end;
$partners_permissions$;
