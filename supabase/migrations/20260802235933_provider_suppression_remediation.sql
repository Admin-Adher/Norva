-- Owner-only remediation for a provider-level Resend suppression after the
-- recipient explicitly requested mail again and a fresh, signed
-- `email.delivered` webhook proves the provider accepted a new message.
--
-- This path deliberately remains outside the Data API:
--   * no browser, authenticated client, service-role Edge function or Admin UI
--     can execute it;
--   * the current confirmed Auth address and the suppression row are locked and
--     revalidated in one short transaction;
--   * a complaint remains an irreversible hard block here;
--   * the delivered Resend message is recent, post-suppression and single-use;
--   * the existing append-only, address-minimized audit remains authoritative.

create schema if not exists email_private;
revoke all on schema email_private from public, anon, authenticated, service_role;
alter default privileges in schema email_private
  revoke execute on functions from public;

-- Reuse the existing audit ledger without retaining another address or raw Auth
-- UUID. The delivered provider message id is an opaque UUID and is stored in the
-- already-unique verification_reference field.
alter table public.cloud_email_suppression_resolution_audit
  drop constraint if exists cloud_email_suppression_resolution_method,
  drop constraint if exists cloud_email_suppression_resolution_reference;

alter table public.cloud_email_suppression_resolution_audit
  add constraint cloud_email_suppression_resolution_method check (
    verification_method in (
      'fresh_confirmation_link',
      'verified_mailbox_reply',
      'provider_post_remediation_delivery'
    )
  ),
  add constraint cloud_email_suppression_resolution_reference check (
    (
      verification_method = 'fresh_confirmation_link'
      and verification_reference ~ '^email_challenge:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    )
    or (
      verification_method = 'verified_mailbox_reply'
      and verification_reference ~ '^support_ticket:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    )
    or (
      verification_method = 'provider_post_remediation_delivery'
      and verification_reference ~ '^resend_delivery:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    )
  );

create or replace function email_private.norva_resolve_provider_email_suppression(
  p_user_id uuid,
  p_expected_email text,
  p_delivered_email_id text,
  p_resolution_reason text,
  p_operator_actor text
) returns uuid
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, auth, extensions
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_email text := lower(btrim(coalesce(p_expected_email, '')));
  v_delivered_email_id text := lower(btrim(coalesce(p_delivered_email_id, '')));
  v_reason text := btrim(coalesce(p_resolution_reason, ''));
  v_actor text := btrim(coalesce(p_operator_actor, ''));
  v_reference text;
  v_user record;
  v_suppression public.cloud_email_suppressions%rowtype;
  v_source_event record;
  v_delivery_event record;
  v_audit_id uuid := gen_random_uuid();
  v_updated integer := 0;
begin
  if p_user_id is null then
    raise exception 'user id is required' using errcode = '22023';
  end if;
  if length(v_email) not between 3 and 320 or position('@' in v_email) <= 1 then
    raise exception 'a normalized expected email is required' using errcode = '22023';
  end if;
  if v_delivered_email_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'a valid delivered Resend email id is required' using errcode = '22023';
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

  select u.id, lower(btrim(coalesce(u.email, ''))) as email,
         u.email_confirmed_at, u.deleted_at, u.banned_until
    into v_user
  from auth.users u
  where u.id = p_user_id
  for share;

  if not found
     or v_user.email <> v_email
     or v_user.email_confirmed_at is null
     or v_user.deleted_at is not null
     or (v_user.banned_until is not null and v_user.banned_until > v_now) then
    raise exception 'expected address is not the current usable confirmed Auth address'
      using errcode = '22023';
  end if;

  -- Lock the sole mutable row before inspecting its immutable source evidence.
  -- No external call occurs while the lock is held.
  select s.* into v_suppression
  from public.cloud_email_suppressions s
  where s.email = v_email
  for update;

  if not found or not v_suppression.active then
    raise exception 'no active suppression exists for the current address'
      using errcode = 'P0002';
  end if;
  if v_suppression.complaint_seen_at is not null then
    raise exception 'complaint suppressions cannot be resolved by provider remediation'
      using errcode = '22023';
  end if;
  if v_suppression.provider_suppression_seen_at is null then
    raise exception 'suppression is not a provider-level suppression'
      using errcode = '22023';
  end if;

  select e.event_id, e.event_type, e.provider_email_id, e.occurred_at
    into v_source_event
  from public.cloud_email_delivery_events e
  where e.event_id = v_suppression.source_event_id
    and e.provider_email_id = v_suppression.source_email_id;

  if not found
     or v_source_event.event_type <> 'email.suppressed'
     or v_source_event.occurred_at is distinct from v_suppression.provider_suppression_seen_at then
    raise exception 'active suppression is not backed by its current provider suppression event'
      using errcode = '22023';
  end if;

  select e.event_id, e.provider_email_id, e.occurred_at, e.received_at,
         e.from_email, e.to_emails, e.tags
    into v_delivery_event
  from public.cloud_email_delivery_events e
  where e.event_type = 'email.delivered'
    and lower(btrim(e.provider_email_id)) = v_delivered_email_id
    and v_email = any(e.to_emails)
    and lower(coalesce(e.from_email, '')) ~ '(^|<)[^<>@[:space:]]+@norva\.tv>?$'
    and jsonb_typeof(e.tags) = 'object'
    and (not (e.tags ? 'app') or coalesce(e.tags ->> 'app', '') = 'norva')
  order by e.occurred_at desc, e.received_at desc, e.event_id desc
  limit 1;

  if not found then
    raise exception 'fresh delivered Resend evidence was not found for the current address'
      using errcode = '22023';
  end if;
  if v_delivery_event.provider_email_id = v_suppression.source_email_id then
    raise exception 'delivery evidence must come from a new Resend message'
      using errcode = '22023';
  end if;
  if v_delivery_event.occurred_at <= greatest(
       v_suppression.provider_suppression_seen_at,
       v_suppression.last_seen_at
     )
     or v_delivery_event.received_at <= greatest(
       v_suppression.provider_suppression_seen_at,
       v_suppression.last_seen_at
     ) then
    raise exception 'delivery evidence must be newer than the active suppression'
      using errcode = '22023';
  end if;
  if v_delivery_event.occurred_at < v_now - interval '24 hours'
     or v_delivery_event.received_at < v_now - interval '24 hours'
     or v_delivery_event.occurred_at > v_now + interval '5 minutes'
     or v_delivery_event.received_at > v_now + interval '5 minutes' then
    raise exception 'delivery evidence must be fresh and cannot be future-dated'
      using errcode = '22023';
  end if;

  -- Fail closed if a newer hard event is already present. An out-of-order hard
  -- webhook arriving after commit will still reactivate the suppression through
  -- the existing idempotent upsert.
  if exists (
    select 1
    from public.cloud_email_delivery_events e
    where v_email = any(e.to_emails)
      and e.occurred_at > v_delivery_event.occurred_at
      and (
        e.event_type in ('email.complained', 'email.suppressed')
        or (
          e.event_type = 'email.bounced'
          and lower(coalesce(e.diagnostic_data ->> 'type', '')) = 'permanent'
        )
      )
  ) then
    raise exception 'a newer hard delivery event prevents provider remediation'
      using errcode = '22023';
  end if;

  v_reference := 'resend_delivery:' || v_delivered_email_id;

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
    'provider_post_remediation_delivery', v_reference,
    v_delivery_event.occurred_at, v_reason, v_actor, v_now
  );

  update public.cloud_email_suppressions s
  set active = false,
      resolved_at = v_now,
      updated_at = v_now
  where s.email = v_email
    and s.active
    and s.source_event_id is not distinct from v_suppression.source_event_id
    and s.source_email_id is not distinct from v_suppression.source_email_id
    and s.provider_suppression_seen_at is not distinct from
        v_suppression.provider_suppression_seen_at;

  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    raise exception 'suppression changed concurrently; no resolution was applied'
      using errcode = '40001';
  end if;

  return v_audit_id;
end;
$function$;

-- Retention is the only legitimate mutation of the append-only audit. Keep the
-- trigger fail-closed for every UPDATE and for every ordinary DELETE. The GUC is
-- transaction-local and useful only to the owner-only helper below; API roles
-- retain no DELETE privilege on the table and no EXECUTE privilege on the helper.
create or replace function public.norva_reject_email_suppression_audit_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  if tg_op = 'DELETE'
     and current_setting('norva.email_suppression_audit_retention', true) = 'v1'
     and old.resolved_at < clock_timestamp() - interval '400 days' then
    return old;
  end if;

  raise exception 'email suppression resolution audit is append-only'
    using errcode = '55000';
end;
$function$;

revoke all on function public.norva_reject_email_suppression_audit_mutation()
  from public, anon, authenticated, service_role;

create or replace function email_private.norva_prune_email_suppression_resolution_audit()
returns bigint
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_deleted bigint := 0;
begin
  perform set_config('norva.email_suppression_audit_retention', 'v1', true);

  delete from public.cloud_email_suppression_resolution_audit
  where resolved_at < clock_timestamp() - interval '400 days';
  get diagnostics v_deleted = row_count;

  -- Do not leave the capability marker available to another owner statement in
  -- the surrounding transaction.
  perform set_config('norva.email_suppression_audit_retention', '', true);
  return v_deleted;
exception
  when others then
    perform set_config('norva.email_suppression_audit_retention', '', true);
    raise;
end;
$function$;

revoke all on function email_private.norva_prune_email_suppression_resolution_audit()
  from public, anon, authenticated, service_role;

-- Preserve the established scrub/delete windows and delegate only the
-- append-only audit retention to the private helper.
create or replace function public.norva_prune_resend_delivery_events()
returns bigint
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_deleted bigint;
begin
  update public.cloud_email_delivery_events
  set from_email = null,
      to_emails = '{}'::text[],
      diagnostic_data = '{}'::jsonb
  where received_at < now() - interval '90 days'
    and (
      from_email is not null
      or cardinality(to_emails) > 0
      or diagnostic_data <> '{}'::jsonb
    );

  update public.cloud_email_delivery_status
  set from_email = null,
      to_emails = '{}'::text[],
      latest_diagnostic_data = '{}'::jsonb,
      updated_at = now()
  where latest_event_at < now() - interval '90 days'
    and (
      from_email is not null
      or cardinality(to_emails) > 0
      or latest_diagnostic_data <> '{}'::jsonb
    );

  delete from public.cloud_email_delivery_events
  where received_at < now() - interval '180 days';
  get diagnostics v_deleted = row_count;

  delete from public.cloud_email_delivery_status
  where latest_event_at < now() - interval '400 days';

  delete from public.cloud_email_suppressions
  where not active
    and resolved_at < now() - interval '180 days';

  perform email_private.norva_prune_email_suppression_resolution_audit();

  return v_deleted;
end;
$function$;

revoke all on function public.norva_prune_resend_delivery_events()
  from public, anon, authenticated;
grant execute on function public.norva_prune_resend_delivery_events()
  to service_role;

revoke insert, update, delete, truncate
  on table public.cloud_email_suppression_resolution_audit
  from service_role;
grant select on table public.cloud_email_suppression_resolution_audit
  to service_role;

revoke all on function email_private.norva_resolve_provider_email_suppression(
  uuid, text, text, text, text
) from public, anon, authenticated, service_role;

comment on schema email_private is
  'Owner-only email operations kept outside PostgREST exposed schemas.';
comment on function email_private.norva_resolve_provider_email_suppression(
  uuid, text, text, text, text
) is
  'Owner-only audited resolution of a Resend provider suppression after a fresh post-suppression delivery. Never expose through Edge, Admin or the Data API.';
comment on function email_private.norva_prune_email_suppression_resolution_audit() is
  'Owner-only retention helper. Deletes only audit decisions older than 400 days under a transaction-local trigger context.';
comment on table public.cloud_email_suppression_resolution_audit is
  'Append-only, service-readable evidence for false-bounce and provider-suppression resolutions. Stores a high-entropy user pseudonym, never the user UUID or address; provider remediation references only a delivered Resend message UUID.';
comment on table public.cloud_email_suppressions is
  'Local safety mirror for permanent bounces, complaints and provider suppressions. Service-role reads only; resolution is allowed only through audited, case-specific database functions.';
