-- Mailbox pre-verification for the unified passwordless onboarding.
--
-- A typo must not create an Auth user. The public browser first proves that it
-- controls the mailbox with a short-lived code stored here as HMACs only. The
-- Edge function may ask GoTrue for a signup/magic-link token only after this
-- table has atomically accepted that code.

create table if not exists abuse_private.auth_email_challenges (
  challenge_id  uuid        primary key,
  email_hash    text        not null,
  code_hash     text        not null,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  verified_at   timestamptz,
  invalidated_at timestamptz,
  attempt_count smallint    not null default 0,
  constraint auth_email_challenges_email_hash check (email_hash ~ '^[0-9a-f]{64}$'),
  constraint auth_email_challenges_code_hash check (code_hash ~ '^[0-9a-f]{64}$'),
  constraint auth_email_challenges_expiry check (expires_at > created_at),
  constraint auth_email_challenges_attempts check (attempt_count between 0 and 5)
);

comment on table abuse_private.auth_email_challenges is
  'Short-lived mailbox proof. Stores domain-separated HMACs only; never raw email addresses or OTPs.';

create index if not exists auth_email_challenges_email_idx
  on abuse_private.auth_email_challenges (email_hash, created_at desc);
create index if not exists auth_email_challenges_expiry_idx
  on abuse_private.auth_email_challenges (expires_at);

alter table abuse_private.auth_email_challenges enable row level security;
revoke all on table abuse_private.auth_email_challenges
  from public, anon, authenticated, service_role;

create or replace function abuse_private.auth_email_challenge_issue(
  p_challenge_id uuid,
  p_email_hash text,
  p_code_hash text,
  p_ttl_seconds integer default 900
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ttl integer := least(greatest(coalesce(p_ttl_seconds, 900), 300), 1200);
begin
  if p_email_hash !~ '^[0-9a-f]{64}$' or p_code_hash !~ '^[0-9a-f]{64}$' then
    return false;
  end if;

  -- Bounded opportunistic retention keeps the table small even if the explicit
  -- maintenance function is not scheduled yet.
  delete from abuse_private.auth_email_challenges
   where challenge_id in (
     select challenge_id
       from abuse_private.auth_email_challenges
      where expires_at < now() - interval '24 hours'
      order by expires_at
      limit 250
   );

  -- One live challenge per mailbox. Re-sending invalidates the prior code so a
  -- user never has to guess which email contains the current one.
  update abuse_private.auth_email_challenges
     set invalidated_at = coalesce(invalidated_at, now())
   where email_hash = p_email_hash
     and verified_at is null
     and invalidated_at is null
     and expires_at > now();

  insert into abuse_private.auth_email_challenges (
    challenge_id, email_hash, code_hash, expires_at
  ) values (
    p_challenge_id, p_email_hash, p_code_hash, now() + make_interval(secs => v_ttl)
  );
  return true;
exception when unique_violation then
  return false;
end;
$$;

create or replace function abuse_private.auth_email_challenge_invalidate(
  p_challenge_id uuid
)
returns boolean
language sql
security definer
set search_path = ''
as $$
  update abuse_private.auth_email_challenges
     set invalidated_at = coalesce(invalidated_at, now())
   where challenge_id = p_challenge_id
  returning true;
$$;

create or replace function abuse_private.auth_email_challenge_verify(
  p_challenge_id uuid,
  p_email_hash text,
  p_code_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row abuse_private.auth_email_challenges%rowtype;
  v_attempts smallint;
begin
  select * into v_row
    from abuse_private.auth_email_challenges
   where challenge_id = p_challenge_id
   for update;

  if not found or v_row.email_hash <> p_email_hash then
    return jsonb_build_object('status', 'invalid');
  end if;
  if v_row.invalidated_at is not null or v_row.expires_at <= now() then
    return jsonb_build_object('status', 'expired');
  end if;
  -- A network retry after the token response was lost stays recoverable. The
  -- caller still has to present the exact mailbox and code HMACs.
  if v_row.verified_at is not null then
    return jsonb_build_object('status', 'verified');
  end if;

  v_attempts := least(5, (v_row.attempt_count + 1)::integer)::smallint;
  if v_row.code_hash <> p_code_hash then
    update abuse_private.auth_email_challenges
       set attempt_count = v_attempts,
           invalidated_at = case when v_attempts >= 5 then now() else invalidated_at end
     where challenge_id = p_challenge_id;
    return jsonb_build_object('status', case when v_attempts >= 5 then 'locked' else 'invalid' end);
  end if;

  update abuse_private.auth_email_challenges
     set attempt_count = v_attempts,
         verified_at = now()
   where challenge_id = p_challenge_id;
  return jsonb_build_object('status', 'verified');
end;
$$;

create or replace function abuse_private.auth_email_challenge_prune()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  delete from abuse_private.auth_email_challenges
   where expires_at < now() - interval '24 hours';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function abuse_private.auth_email_challenge_issue(uuid, text, text, integer)
  from public, anon, authenticated, service_role;
revoke all on function abuse_private.auth_email_challenge_invalidate(uuid)
  from public, anon, authenticated, service_role;
revoke all on function abuse_private.auth_email_challenge_verify(uuid, text, text)
  from public, anon, authenticated, service_role;
revoke all on function abuse_private.auth_email_challenge_prune()
  from public, anon, authenticated, service_role;

create or replace function public.auth_email_challenge_issue(
  p_challenge_id uuid,
  p_email_hash text,
  p_code_hash text,
  p_ttl_seconds integer default 900
)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select abuse_private.auth_email_challenge_issue(
    p_challenge_id, p_email_hash, p_code_hash, p_ttl_seconds
  );
$$;

create or replace function public.auth_email_challenge_invalidate(p_challenge_id uuid)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select coalesce(abuse_private.auth_email_challenge_invalidate(p_challenge_id), false);
$$;

create or replace function public.auth_email_challenge_verify(
  p_challenge_id uuid,
  p_email_hash text,
  p_code_hash text
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select abuse_private.auth_email_challenge_verify(p_challenge_id, p_email_hash, p_code_hash);
$$;

create or replace function public.auth_email_challenge_prune()
returns integer
language sql
security definer
set search_path = ''
as $$
  select abuse_private.auth_email_challenge_prune();
$$;

-- Service-only account existence check. It is deliberately separate from the
-- challenge response so neither the browser nor the response shape can reveal
-- whether an address was already registered.
create or replace function public.norva_auth_email_exists(p_email text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from auth.users
     where lower(email) = lower(trim(p_email))
  );
$$;

revoke all on function public.auth_email_challenge_issue(uuid, text, text, integer)
  from public, anon, authenticated;
revoke all on function public.auth_email_challenge_invalidate(uuid)
  from public, anon, authenticated;
revoke all on function public.auth_email_challenge_verify(uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.auth_email_challenge_prune()
  from public, anon, authenticated;
revoke all on function public.norva_auth_email_exists(text)
  from public, anon, authenticated;

grant execute on function public.auth_email_challenge_issue(uuid, text, text, integer)
  to service_role;
grant execute on function public.auth_email_challenge_invalidate(uuid)
  to service_role;
grant execute on function public.auth_email_challenge_verify(uuid, text, text)
  to service_role;
grant execute on function public.auth_email_challenge_prune()
  to service_role;
grant execute on function public.norva_auth_email_exists(text)
  to service_role;
