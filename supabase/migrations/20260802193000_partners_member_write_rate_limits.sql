-- Norva Partners P0: durable pre-mutation reservations for member fiscal and
-- payout onboarding writes.
--
-- The reservation is a separate committed RPC called by the Edge boundary
-- after JWT verification and strict payload parsing. Consequently, a valid
-- request that is rejected by later account-state checks still consumes the
-- member quota. Exact retries keep the same row and do not consume it twice.

create table affiliate_private.affiliate_member_write_reservations (
  operation          text not null,
  user_id             uuid not null
    references auth.users(id)
    on delete cascade,
  idempotency_key     text not null,
  request_hash        text not null,
  reserved_at         timestamptz not null default now(),
  last_seen_at        timestamptz not null default now(),
  primary key (operation, user_id, idempotency_key),
  constraint affiliate_member_write_reservations_operation
    check (
      operation in (
        'fiscal_profile_self_attestation',
        'payout_onboarding'
      )
    ),
  constraint affiliate_member_write_reservations_key
    check (idempotency_key ~ '^[A-Za-z0-9._:-]{16,128}$'),
  constraint affiliate_member_write_reservations_hash
    check (request_hash ~ '^[0-9a-f]{64}$'),
  constraint affiliate_member_write_reservations_timestamps
    check (last_seen_at >= reserved_at)
);

create index affiliate_member_write_reservations_window_idx
  on affiliate_private.affiliate_member_write_reservations (
    operation,
    user_id,
    reserved_at desc
  );

create index affiliate_member_write_reservations_retention_idx
  on affiliate_private.affiliate_member_write_reservations (reserved_at);

alter table affiliate_private.affiliate_member_write_reservations
  enable row level security;

revoke all on table affiliate_private.affiliate_member_write_reservations
  from public, anon, authenticated, service_role;

create or replace function
affiliate_private.partners_service_member_write_reserve(
  p_user_id uuid,
  p_operation text,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_operation text := lower(btrim(coalesce(p_operation, '')));
  v_request_hash text := lower(btrim(coalesce(p_request_hash, '')));
  v_existing_hash text;
  v_used integer := 0;
  v_limit constant integer := 8;
  v_window_seconds constant integer := 86400;
begin
  if p_user_id is null
    or v_operation not in (
      'fiscal_profile_self_attestation',
      'payout_onboarding'
    )
    or p_idempotency_key is null
    or p_idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$'
    or v_request_hash !~ '^[0-9a-f]{64}$'
  then
    raise exception 'invalid Partners member write reservation'
      using errcode = '22023';
  end if;

  -- Serialize the rolling counter and exact-key decision for one member and
  -- operation. Fiscal and payout quotas remain independent.
  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:member-write:'
        || p_user_id::text
        || ':'
        || v_operation,
      0
    )
  );

  -- Retention is scoped to the locked member/operation. At the P0 quota this
  -- is bounded to at most 240 rows and cannot create a cross-account sweep.
  delete from affiliate_private.affiliate_member_write_reservations old_row
  where old_row.operation = v_operation
    and old_row.user_id = p_user_id
    and old_row.reserved_at < now() - interval '30 days';

  -- The previous in-mutation limiter also owned retention for completed
  -- idempotency responses. Preserve that bounded cleanup at the new durable
  -- reservation boundary.
  delete from affiliate_private.affiliate_service_idempotency old_response
  where old_response.operation = v_operation
    and old_response.user_id = p_user_id
    and old_response.created_at < now() - interval '30 days';

  select reservation.request_hash
  into v_existing_hash
  from affiliate_private.affiliate_member_write_reservations reservation
  where reservation.operation = v_operation
    and reservation.user_id = p_user_id
    and reservation.idempotency_key = p_idempotency_key
  for update;

  if found then
    if v_existing_hash is distinct from v_request_hash then
      raise exception 'idempotency key was reused with another request'
        using errcode = 'P0003';
    end if;

    update affiliate_private.affiliate_member_write_reservations reservation
    set last_seen_at = greatest(reservation.last_seen_at, now())
    where reservation.operation = v_operation
      and reservation.user_id = p_user_id
      and reservation.idempotency_key = p_idempotency_key;

    select count(*)::integer
    into v_used
    from affiliate_private.affiliate_member_write_reservations reservation
    where reservation.operation = v_operation
      and reservation.user_id = p_user_id
      and reservation.reserved_at >= now() - interval '24 hours';

    return jsonb_build_object(
      'schema_version', 1,
      'action', 'member_write_reserved',
      'operation', v_operation,
      'replayed', true,
      'limit', v_limit,
      'used', v_used,
      'remaining', greatest(v_limit - v_used, 0),
      'window_seconds', v_window_seconds
    );
  end if;

  select count(*)::integer
  into v_used
  from affiliate_private.affiliate_member_write_reservations reservation
  where reservation.operation = v_operation
    and reservation.user_id = p_user_id
    and reservation.reserved_at >= now() - interval '24 hours';

  if v_used >= v_limit then
    raise exception 'Partners fiscal or payout onboarding rate limit exceeded'
      using errcode = 'P0008';
  end if;

  insert into affiliate_private.affiliate_member_write_reservations (
    operation,
    user_id,
    idempotency_key,
    request_hash
  )
  values (
    v_operation,
    p_user_id,
    p_idempotency_key,
    v_request_hash
  );
  v_used := v_used + 1;

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'member_write_reserved',
    'operation', v_operation,
    'replayed', false,
    'limit', v_limit,
    'used', v_used,
    'remaining', v_limit - v_used,
    'window_seconds', v_window_seconds
  );
end;
$$;

create or replace function public.partners_service_member_write_reserve(
  p_user_id uuid,
  p_operation text,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.partners_service_member_write_reserve(
    p_user_id,
    p_operation,
    p_idempotency_key,
    p_request_hash
  );
$$;

revoke all on function
  affiliate_private.partners_service_member_write_reserve(
    uuid, text, text, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.partners_service_member_write_reserve(
    uuid, text, text, text
  )
to service_role;

revoke all on function public.partners_service_member_write_reserve(
  uuid, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.partners_service_member_write_reserve(
  uuid, text, text, text
) to service_role;

-- Superseded by the committed pre-mutation reservation above. Both member
-- mutation implementations no longer invoke this success-row-based helper.
drop function if exists
  affiliate_private.partners_enforce_fiscal_onboarding_write_limit(text, uuid);
