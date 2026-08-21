-- Signup idempotency.
--
-- Anti-replay and idempotency are two problems. The velocity store answers "has
-- this nonce been seen", which feeds the risk score. This table answers "what did
-- the first use of it actually do", which feeds the response. Without it a double
-- click reaches GoTrue twice and the person sees "user already exists" plus a
-- second confirmation email — a real defect on a path where the risk verdict is
-- ALLOW and therefore acted upon.
--
-- Four states, not three. FAILED_FINAL means it certainly did not succeed.
-- UNKNOWN means the upstream call left and its outcome is not known: a timeout
-- after GoTrue has already created the account is indistinguishable from a
-- failure at this layer, and calling it final would let the retry create a
-- second account. An UNKNOWN attempt is reconciled against the auth side and
-- only then settled.
--
-- The memoised result is allow-listed BY THE DATABASE, not merely by the calling
-- code. GoTrue delivers no session before confirmation today, but that is
-- configuration and configuration changes; a token, a magic link or a
-- confirmation secret must have no route into this table even then.

create table if not exists abuse_private.signup_attempts (
  nonce               text        primary key,
  request_fingerprint text        not null,
  fingerprint_version smallint    not null default 1,
  state               text        not null,
  -- Allow-listed projection only. See the constraint below.
  result              jsonb,
  upstream_status     integer,
  attempt_count       integer     not null default 1,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  expires_at          timestamptz not null,
  constraint signup_attempts_state check (
    state in ('PROCESSING', 'SUCCESS', 'FAILED_FINAL', 'UNKNOWN')
  ),
  constraint signup_attempts_nonce check (nonce ~ '^[0-9a-f]{32}$'),
  constraint signup_attempts_fingerprint check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint signup_attempts_fingerprint_version check (fingerprint_version between 1 and 32767),
  constraint signup_attempts_count check (attempt_count between 1 and 1000000),
  -- Subtracting the allowed keys must leave nothing. A check constraint cannot
  -- hold a subquery, so this is the expression that enforces the allow list:
  -- anything not named here makes the write fail rather than storing a secret.
  constraint signup_attempts_result_allowlist check (
    result is null
    or (result - array['user_id', 'email_confirmation_required', 'created']) = '{}'::jsonb
  )
);

comment on table abuse_private.signup_attempts is
  'Idempotency records for signup. Memoises an allow-listed projection of the '
  'first outcome so a retry of the same intent never reaches GoTrue twice.';

create index if not exists signup_attempts_expiry_idx
  on abuse_private.signup_attempts (expires_at);

alter table abuse_private.signup_attempts enable row level security;

revoke all on table abuse_private.signup_attempts
  from public, anon, authenticated, service_role;

-- Take the claim, or report what the first use of this nonce did.
--
-- The insert is the lock: whichever concurrent request wins the primary key owns
-- the attempt, and the others read its state. No advisory lock, no select-then-
-- insert window for two clicks to slip through.
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
    -- The row expired and was pruned between the insert and this read. Treat it
    -- as a fresh claim rather than inventing a replay.
    return jsonb_build_object('outcome', 'claimed');
  end if;

  -- Same nonce, different intent. This is not a retry: somebody is reusing a
  -- token for another signup, and handing back the first result would hand one
  -- person another person's account. No result is returned, ever.
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

  return jsonb_build_object(
    'outcome', 'replay',
    'state', v_row.state,
    'result', v_row.result,
    'attempt_count', v_row.attempt_count
  );
end;
$$;

-- Settle an attempt the caller owns. The fingerprint is required, so a request
-- for a different intent cannot overwrite somebody else's outcome, and only an
-- unsettled attempt moves: SUCCESS never silently becomes FAILED_FINAL.
create or replace function abuse_private.signup_attempt_settle(
  p_nonce text,
  p_fingerprint text,
  p_state text,
  p_result jsonb,
  p_upstream_status integer
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
         result = p_result,
         upstream_status = p_upstream_status,
         updated_at = now()
   where nonce = p_nonce
     and request_fingerprint = p_fingerprint
     -- UNKNOWN is settleable because reconciliation is exactly the act of
     -- resolving it. SUCCESS and FAILED_FINAL are terminal.
     and state in ('PROCESSING', 'UNKNOWN');
  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

create or replace function abuse_private.signup_attempt_prune()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  delete from abuse_private.signup_attempts where expires_at < now();
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function abuse_private.signup_attempt_claim(text, text, smallint, integer)
  from public, anon, authenticated, service_role;
revoke all on function abuse_private.signup_attempt_settle(text, text, text, jsonb, integer)
  from public, anon, authenticated, service_role;
revoke all on function abuse_private.signup_attempt_prune()
  from public, anon, authenticated, service_role;

create or replace function public.abuse_signup_attempt_claim(
  p_nonce text,
  p_fingerprint text,
  p_fingerprint_version smallint,
  p_ttl_seconds integer
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select abuse_private.signup_attempt_claim(
    p_nonce, p_fingerprint, p_fingerprint_version, p_ttl_seconds
  );
$$;

create or replace function public.abuse_signup_attempt_settle(
  p_nonce text,
  p_fingerprint text,
  p_state text,
  p_result jsonb,
  p_upstream_status integer
)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select abuse_private.signup_attempt_settle(
    p_nonce, p_fingerprint, p_state, p_result, p_upstream_status
  );
$$;

create or replace function public.abuse_signup_attempt_prune()
returns integer
language sql
security definer
set search_path = ''
as $$
  select abuse_private.signup_attempt_prune();
$$;

revoke all on function public.abuse_signup_attempt_claim(text, text, smallint, integer)
  from public, anon, authenticated;
grant execute on function public.abuse_signup_attempt_claim(text, text, smallint, integer)
  to service_role;

revoke all on function public.abuse_signup_attempt_settle(text, text, text, jsonb, integer)
  from public, anon, authenticated;
grant execute on function public.abuse_signup_attempt_settle(text, text, text, jsonb, integer)
  to service_role;

revoke all on function public.abuse_signup_attempt_prune()
  from public, anon, authenticated;
grant execute on function public.abuse_signup_attempt_prune() to service_role;
