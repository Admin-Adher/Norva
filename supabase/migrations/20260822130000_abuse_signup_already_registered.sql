-- A gap found while wiring the real web client to this pipeline, not before.
--
-- GoTrue's own anti-enumeration behaviour: signing up an email that already has
-- an account returns 200 with an obfuscated user whose `identities` array is
-- empty, and sends no confirmation email. account.html's existing signup form
-- already depends on this — it reads `payload.user.identities.length === 0` to
-- show "This email already has a Norva account" instead of a dead-end "check
-- your email".
--
-- The edge handler discarded this distinction: it captured only `body.id` from
-- GoTrue's response and returned a flat `created: true` regardless. Wiring the
-- web client to this path without fixing it would have silently broken that
-- message for every canary user who tried to re-register an existing address —
-- a real product regression, found by tracing what the client actually needs
-- before shipping it real traffic rather than after.
--
-- One typed boolean, additive. The existing three-typed-column shape is kept:
-- this is one more field of the same kind, not a reason to loosen it back to a
-- jsonb blob.

alter table abuse_private.signup_attempts
  add column if not exists result_already_registered boolean;

alter table abuse_private.signup_attempts
  drop constraint if exists signup_attempts_result_state;
alter table abuse_private.signup_attempts
  add constraint signup_attempts_result_state check (
    state <> 'PROCESSING'
    or (result_user_id is null
        and result_email_confirmation_required is null
        and result_created is null
        and result_already_registered is null)
  );

-- The signature changes (one more parameter), so `create or replace` would add
-- an overload rather than replace the existing function. These are hours old
-- and not yet reachable by real traffic, so dropping and recreating cleanly is
-- simpler than carrying two signatures forward.
drop function if exists abuse_private.signup_attempt_settle(text, text, text, uuid, boolean, boolean, integer);
drop function if exists public.abuse_signup_attempt_settle(text, text, text, uuid, boolean, boolean, integer);

create or replace function abuse_private.signup_attempt_settle(
  p_nonce text,
  p_fingerprint text,
  p_state text,
  p_user_id uuid,
  p_email_confirmation_required boolean,
  p_created boolean,
  p_upstream_status integer,
  p_already_registered boolean default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated integer;
begin
  if p_state not in ('SUCCESS', 'FAILED_FINAL', 'UNKNOWN') then
    raise exception 'signup_attempt_settle refuses state %', p_state;
  end if;

  update abuse_private.signup_attempts
     set state = p_state,
         result_user_id = p_user_id,
         result_email_confirmation_required = p_email_confirmation_required,
         result_created = p_created,
         result_already_registered = p_already_registered,
         upstream_status = p_upstream_status,
         updated_at = now()
   where nonce = p_nonce
     and request_fingerprint = p_fingerprint
     and state in ('PROCESSING', 'UNKNOWN');
  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

-- Rebuilt to include the new field in the projection handed back on replay.
create or replace function abuse_private.signup_attempt_claim(
  p_nonce text,
  p_fingerprint text,
  p_fingerprint_version smallint,
  p_ttl_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ttl      integer := least(greatest(coalesce(p_ttl_seconds, 900), 60), 86400);
  v_inserted boolean := false;
  v_row      abuse_private.signup_attempts;
  v_result   jsonb;
begin
  insert into abuse_private.signup_attempts as a
    (nonce, request_fingerprint, fingerprint_version, state, expires_at)
  values (
    p_nonce, p_fingerprint, coalesce(p_fingerprint_version, 1), 'PROCESSING',
    now() + make_interval(secs => v_ttl)
  )
  on conflict (nonce) do nothing;

  v_inserted := found;
  if v_inserted then
    return jsonb_build_object('outcome', 'claimed');
  end if;

  select * into v_row
    from abuse_private.signup_attempts a
   where a.nonce = p_nonce;

  if not found then
    return jsonb_build_object('outcome', 'claimed');
  end if;

  if v_row.request_fingerprint <> p_fingerprint then
    update abuse_private.signup_attempts
       set attempt_count = least(attempt_count + 1, 1000000),
           updated_at = now()
     where nonce = p_nonce;
    return jsonb_build_object('outcome', 'intent_mismatch');
  end if;

  update abuse_private.signup_attempts
     set attempt_count = least(attempt_count + 1, 1000000),
         updated_at = now()
   where nonce = p_nonce
  returning attempt_count into v_row.attempt_count;

  v_result := jsonb_strip_nulls(jsonb_build_object(
    'user_id', v_row.result_user_id,
    'email_confirmation_required', v_row.result_email_confirmation_required,
    'created', v_row.result_created,
    'already_registered', v_row.result_already_registered
  ));
  if v_result = '{}'::jsonb then v_result := null; end if;

  return jsonb_build_object(
    'outcome', 'replay',
    'state', v_row.state,
    'result', v_result,
    'attempt_count', v_row.attempt_count
  );
end;
$$;

create or replace function public.abuse_signup_attempt_settle(
  p_nonce text,
  p_fingerprint text,
  p_state text,
  p_user_id uuid,
  p_email_confirmation_required boolean,
  p_created boolean,
  p_upstream_status integer,
  p_already_registered boolean default null
)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select abuse_private.signup_attempt_settle(
    p_nonce, p_fingerprint, p_state, p_user_id,
    p_email_confirmation_required, p_created, p_upstream_status, p_already_registered
  );
$$;

revoke all on function abuse_private.signup_attempt_settle(text, text, text, uuid, boolean, boolean, integer, boolean)
  from public, anon, authenticated, service_role;

revoke all on function public.abuse_signup_attempt_settle(text, text, text, uuid, boolean, boolean, integer, boolean)
  from public, anon, authenticated;
grant execute on function public.abuse_signup_attempt_settle(text, text, text, uuid, boolean, boolean, integer, boolean)
  to service_role;
