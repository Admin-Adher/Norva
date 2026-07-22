-- Audited operator recovery for a false-positive permanent bounce.
--
-- This is deliberately narrower than a generic "unsuppress" switch:
--   * only the current, confirmed Auth address can be resolved;
--   * only a Resend `email.bounced` event classified `Permanent` qualifies;
--   * a complaint or provider suppression is an irreversible hard block here;
--   * recent mailbox verification, an opaque evidence reference, a reason and
--     an attributable operator are mandatory;
--   * direct service-role writes to the suppression table are removed so the
--     audited RPC is the sole application-level resolution path.

alter table public.cloud_email_suppressions
  add column if not exists complaint_seen_at timestamptz,
  add column if not exists provider_suppression_seen_at timestamptz;

comment on column public.cloud_email_suppressions.complaint_seen_at is
  'Durable hard-block marker. Once set, the false-permanent-bounce resolution RPC cannot clear this address.';
comment on column public.cloud_email_suppressions.provider_suppression_seen_at is
  'Durable provider hard-block marker. Provider-level suppressions require a separate provider remediation workflow.';

-- Preserve hard-block provenance even after raw delivery events age out or a
-- later bounce becomes the row's most recent source event.
create or replace function public.norva_preserve_email_suppression_hard_blocks()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_event_type text;
  v_occurred_at timestamptz;
begin
  select e.event_type, e.occurred_at
    into v_event_type, v_occurred_at
  from public.cloud_email_delivery_events e
  where e.event_id = new.source_event_id;

  new.complaint_seen_at := greatest(
    case when tg_op = 'UPDATE' then old.complaint_seen_at end,
    new.complaint_seen_at,
    case when v_event_type = 'email.complained' then v_occurred_at end
  );
  new.provider_suppression_seen_at := greatest(
    case when tg_op = 'UPDATE' then old.provider_suppression_seen_at end,
    new.provider_suppression_seen_at,
    case when v_event_type = 'email.suppressed' then v_occurred_at end
  );
  return new;
end;
$function$;

revoke all on function public.norva_preserve_email_suppression_hard_blocks()
  from public, anon, authenticated;

drop trigger if exists norva_preserve_email_suppression_hard_blocks_trg
  on public.cloud_email_suppressions;
create trigger norva_preserve_email_suppression_hard_blocks_trg
  before insert or update on public.cloud_email_suppressions
  for each row execute function public.norva_preserve_email_suppression_hard_blocks();

-- Backfill the durable markers before exposing the recovery RPC.
with hard_blocks as (
  select
    s.email,
    max(e.occurred_at) filter (where e.event_type = 'email.complained') as complaint_seen_at,
    max(e.occurred_at) filter (where e.event_type = 'email.suppressed') as provider_suppression_seen_at
  from public.cloud_email_suppressions s
  join public.cloud_email_delivery_events e
    on s.email = any(e.to_emails)
  where e.event_type in ('email.complained', 'email.suppressed')
  group by s.email
)
update public.cloud_email_suppressions s
set complaint_seen_at = greatest(s.complaint_seen_at, h.complaint_seen_at),
    provider_suppression_seen_at = greatest(
      s.provider_suppression_seen_at,
      h.provider_suppression_seen_at
    ),
    updated_at = clock_timestamp()
from hard_blocks h
where h.email = s.email
  and (
    s.complaint_seen_at is distinct from greatest(s.complaint_seen_at, h.complaint_seen_at)
    or s.provider_suppression_seen_at is distinct from greatest(
      s.provider_suppression_seen_at,
      h.provider_suppression_seen_at
    )
  );

create table if not exists public.cloud_email_suppression_resolution_audit (
  id uuid primary key default gen_random_uuid(),
  user_fingerprint text not null,
  source_event_id text not null unique,
  source_email_id text not null,
  suppression_reason text not null,
  suppression_first_seen_at timestamptz not null,
  suppression_last_seen_at timestamptz not null,
  auth_email_confirmed_at timestamptz not null,
  verification_method text not null,
  verification_reference text not null unique,
  verified_at timestamptz not null,
  resolution_reason text not null,
  operator_actor text not null,
  resolved_at timestamptz not null default clock_timestamp(),
  constraint cloud_email_suppression_resolution_fingerprint check (
    user_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  constraint cloud_email_suppression_resolution_method check (
    verification_method in ('fresh_confirmation_link', 'verified_mailbox_reply')
  ),
  constraint cloud_email_suppression_resolution_reference check (
    verification_reference ~ '^(email_challenge|support_ticket):[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  constraint cloud_email_suppression_resolution_reason check (
    length(btrim(resolution_reason)) between 20 and 1000
  ),
  constraint cloud_email_suppression_resolution_actor check (
    length(operator_actor) between 3 and 200
    and operator_actor ~ '^[A-Za-z0-9._@:+/-]+$'
  )
);

comment on table public.cloud_email_suppression_resolution_audit is
  'Append-only, service-only evidence for false-positive permanent-bounce resolutions. Stores a high-entropy user pseudonym, never the user UUID or address.';

create index if not exists cloud_email_suppression_resolution_user_time_idx
  on public.cloud_email_suppression_resolution_audit (user_fingerprint, resolved_at desc);
create index if not exists cloud_email_suppression_resolution_time_idx
  on public.cloud_email_suppression_resolution_audit (resolved_at desc);

alter table public.cloud_email_suppression_resolution_audit enable row level security;
revoke all on table public.cloud_email_suppression_resolution_audit
  from public, anon, authenticated, service_role;
grant select on table public.cloud_email_suppression_resolution_audit
  to service_role;

create or replace function public.norva_reject_email_suppression_audit_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  raise exception 'email suppression resolution audit is append-only'
    using errcode = '55000';
end;
$function$;

revoke all on function public.norva_reject_email_suppression_audit_mutation()
  from public, anon, authenticated;

drop trigger if exists norva_reject_email_suppression_audit_mutation_trg
  on public.cloud_email_suppression_resolution_audit;
create trigger norva_reject_email_suppression_audit_mutation_trg
  before update or delete on public.cloud_email_suppression_resolution_audit
  for each row execute function public.norva_reject_email_suppression_audit_mutation();

create or replace function public.norva_resolve_false_permanent_email_suppression(
  p_user_id uuid,
  p_expected_email text,
  p_verification_method text,
  p_verification_reference text,
  p_verified_at timestamptz,
  p_resolution_reason text,
  p_operator_actor text
) returns uuid
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, auth, extensions
as $function$
declare
  v_email text := lower(btrim(coalesce(p_expected_email, '')));
  v_method text := lower(btrim(coalesce(p_verification_method, '')));
  v_reference text := lower(btrim(coalesce(p_verification_reference, '')));
  v_reason text := btrim(coalesce(p_resolution_reason, ''));
  v_actor text := btrim(coalesce(p_operator_actor, ''));
  v_user record;
  v_suppression record;
  v_source_event record;
  v_audit_id uuid := gen_random_uuid();
begin
  if p_user_id is null then
    raise exception 'user id is required' using errcode = '22023';
  end if;
  if length(v_email) not between 3 and 320 or position('@' in v_email) <= 1 then
    raise exception 'a normalized expected email is required' using errcode = '22023';
  end if;
  if v_method not in ('fresh_confirmation_link', 'verified_mailbox_reply') then
    raise exception 'unsupported mailbox verification method' using errcode = '22023';
  end if;
  if (v_method = 'fresh_confirmation_link'
      and v_reference !~ '^email_challenge:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
     or (v_method = 'verified_mailbox_reply'
      and v_reference !~ '^support_ticket:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') then
    raise exception 'verification reference does not match the verification method'
      using errcode = '22023';
  end if;
  if length(v_reason) not between 20 and 1000 then
    raise exception 'resolution reason must contain 20 to 1000 characters'
      using errcode = '22023';
  end if;
  if length(v_actor) not between 3 and 200
     or v_actor !~ '^[A-Za-z0-9._@:+/-]+$' then
    raise exception 'an attributable operator actor is required'
      using errcode = '22023';
  end if;
  if p_verified_at is null
     or p_verified_at < clock_timestamp() - interval '7 days'
     or p_verified_at > clock_timestamp() + interval '5 minutes' then
    raise exception 'mailbox verification must be recent and cannot be future-dated'
      using errcode = '22023';
  end if;

  select u.id, lower(btrim(coalesce(u.email, ''))) as email,
         u.email_confirmed_at, u.deleted_at, u.banned_until
    into v_user
  from auth.users u
  where u.id = p_user_id;

  if not found
     or v_user.email <> v_email
     or v_user.email_confirmed_at is null
     or v_user.deleted_at is not null
     or (v_user.banned_until is not null and v_user.banned_until > clock_timestamp()) then
    raise exception 'expected address is not the current usable confirmed Auth address'
      using errcode = '22023';
  end if;

  select s.* into v_suppression
  from public.cloud_email_suppressions s
  where s.email = v_email
  for update;

  if not found or not v_suppression.active then
    raise exception 'no active suppression exists for the current address'
      using errcode = 'P0002';
  end if;
  if v_suppression.complaint_seen_at is not null then
    raise exception 'complaint suppressions cannot be resolved by this recovery path'
      using errcode = '22023';
  end if;
  if v_suppression.provider_suppression_seen_at is not null then
    raise exception 'provider suppressions require provider-side remediation'
      using errcode = '22023';
  end if;
  if p_verified_at < v_suppression.last_seen_at then
    raise exception 'mailbox verification must be newer than the suppression'
      using errcode = '22023';
  end if;

  select e.event_type, e.diagnostic_data
    into v_source_event
  from public.cloud_email_delivery_events e
  where e.event_id = v_suppression.source_event_id
    and e.provider_email_id = v_suppression.source_email_id;

  if not found
     or v_source_event.event_type <> 'email.bounced'
     or lower(coalesce(v_source_event.diagnostic_data ->> 'type', '')) <> 'permanent' then
    raise exception 'suppression is not proven to be a permanent-bounce false positive'
      using errcode = '22023';
  end if;

  insert into public.cloud_email_suppression_resolution_audit (
    id, user_fingerprint,
    source_event_id, source_email_id, suppression_reason,
    suppression_first_seen_at, suppression_last_seen_at,
    auth_email_confirmed_at, verification_method, verification_reference,
    verified_at, resolution_reason, operator_actor, resolved_at
  ) values (
    v_audit_id,
    encode(extensions.digest('norva-user-resolution:v1:' || p_user_id::text, 'sha256'), 'hex'),
    v_suppression.source_event_id, v_suppression.source_email_id,
    left(v_suppression.reason, 200), v_suppression.first_seen_at,
    v_suppression.last_seen_at, v_user.email_confirmed_at,
    v_method, v_reference, p_verified_at, v_reason, v_actor,
    clock_timestamp()
  );

  update public.cloud_email_suppressions s
  set active = false,
      resolved_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where s.email = v_email
    and s.active;

  if not found then
    raise exception 'suppression changed concurrently; no resolution was applied'
      using errcode = '40001';
  end if;

  return v_audit_id;
end;
$function$;

revoke all on function public.norva_resolve_false_permanent_email_suppression(
  uuid, text, text, text, timestamptz, text, text
) from public, anon, authenticated;
grant execute on function public.norva_resolve_false_permanent_email_suppression(
  uuid, text, text, text, timestamptz, text, text
) to service_role;

-- The signed webhook and pruning functions are SECURITY DEFINER, so they keep
-- their write access. Application service-role clients can inspect suppressions
-- but must use the audited RPC to resolve one.
revoke all on table public.cloud_email_suppressions from service_role;
grant select on table public.cloud_email_suppressions to service_role;

comment on table public.cloud_email_suppressions is
  'Local safety mirror for permanent bounces, complaints and provider suppressions. Service-role reads only; false permanent bounces resolve through the audited RPC.';

notify pgrst, 'reload schema';
