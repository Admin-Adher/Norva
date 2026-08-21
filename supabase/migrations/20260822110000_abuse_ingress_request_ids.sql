-- One-shot request ids for the Cloudflare → edge boundary.
--
-- The signed envelope proves who minted a request. It does not, on its own, stop
-- the same valid envelope being sent twice: a captured one would work until its
-- timestamp went stale. Consuming the request id closes that, and it is consumed
-- the same way the signup nonce is — the insert IS the lock, so a burst of
-- identical replays produces exactly one winner and there is no select-then-
-- insert window to slip through.
--
-- Deliberately short-lived. This protects one transport hop, not a user session,
-- so the row only has to outlive the envelope's own validity window. Five
-- minutes covers the three-minute maximum age plus a minute of clock skew either
-- way, with room to spare.
--
-- Nothing here identifies anybody: a random request id, the audience it was
-- minted for, and two timestamps.

create table if not exists abuse_private.ingress_request_ids (
  request_id text        primary key,
  audience   text        not null,
  seen_at    timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint ingress_request_ids_id check (request_id ~ '^[0-9a-f]{32}$'),
  constraint ingress_request_ids_audience check (length(audience) between 1 and 64)
);

comment on table abuse_private.ingress_request_ids is
  'Spent request ids from signed Cloudflare ingress envelopes. Short retention: '
  'this guards one transport hop, not a session.';

create index if not exists ingress_request_ids_expiry_idx
  on abuse_private.ingress_request_ids (expires_at);

alter table abuse_private.ingress_request_ids enable row level security;

revoke all on table abuse_private.ingress_request_ids
  from public, anon, authenticated, service_role;

-- true on first use, false on every repeat. The audience is part of the row so a
-- id spent against one endpoint is visibly spent, whatever else adopts the
-- mechanism later.
create or replace function abuse_private.ingress_request_consume(
  p_request_id text,
  p_audience text,
  p_ttl_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ttl integer := least(greatest(coalesce(p_ttl_seconds, 300), 60), 3600);
begin
  insert into abuse_private.ingress_request_ids (request_id, audience, expires_at)
  values (p_request_id, p_audience, now() + make_interval(secs => v_ttl))
  on conflict (request_id) do nothing;
  return found;
end;
$$;

create or replace function abuse_private.ingress_request_prune()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  delete from abuse_private.ingress_request_ids where expires_at < now();
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function abuse_private.ingress_request_consume(text, text, integer)
  from public, anon, authenticated, service_role;
revoke all on function abuse_private.ingress_request_prune()
  from public, anon, authenticated, service_role;

create or replace function public.abuse_ingress_request_consume(
  p_request_id text,
  p_audience text,
  p_ttl_seconds integer
)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select abuse_private.ingress_request_consume(p_request_id, p_audience, p_ttl_seconds);
$$;

create or replace function public.abuse_ingress_request_prune()
returns integer
language sql
security definer
set search_path = ''
as $$
  select abuse_private.ingress_request_prune();
$$;

revoke all on function public.abuse_ingress_request_consume(text, text, integer)
  from public, anon, authenticated;
grant execute on function public.abuse_ingress_request_consume(text, text, integer)
  to service_role;

revoke all on function public.abuse_ingress_request_prune()
  from public, anon, authenticated;
grant execute on function public.abuse_ingress_request_prune() to service_role;
