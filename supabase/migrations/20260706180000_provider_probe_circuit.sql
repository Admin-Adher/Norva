-- Probe circuit breaker: stop the audio/subtitle probe crawl from hammering a provider that is
-- actively refusing us (HTTP 401/403/429/5xx via the gateway or relay — the signature of a
-- ban-in-progress or a saturated single-connection account). Persistently retrying failed auth
-- only DEEPENS an IPTV ban, so once a provider identity's probe ticks come back all-rejections we
-- open the breaker, auto-pause probing for that identity, and back off with an escalating window.
-- Any single healthy provider response clears it. Keyed by the canonical provider identity
-- (resolveSourceIdentity -> catalog_provider_identities.identity_id), so it protects EVERY
-- provider, not just the low_footprint ones — and re-adding a banned provider under a new account
-- gets its own fresh breaker.

create table if not exists public.provider_probe_circuit (
  identity_key    text primary key,
  fail_ticks      int         not null default 0,  -- consecutive all-failed probe ticks
  open_count      int         not null default 0,  -- opens since the last clean success (escalation)
  open_until      timestamptz,                     -- probing is paused for this identity until here
  last_failure_at timestamptz,
  last_success_at timestamptz,
  updated_at      timestamptz not null default now()
);

alter table public.provider_probe_circuit enable row level security;
-- No policies: only the SECURITY DEFINER helpers below (and service_role, which bypasses RLS) touch it.

-- Is the breaker open right now? No row => empty result => caller treats it as closed (probe allowed).
create or replace function public.provider_probe_circuit_state(p_identity_key text)
returns table(open boolean, open_until timestamptz, fail_ticks int, open_count int)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select coalesce(c.open_until > now(), false), c.open_until,
         coalesce(c.fail_ticks, 0), coalesce(c.open_count, 0)
  from public.provider_probe_circuit c
  where c.identity_key = p_identity_key;
$function$;

-- Record ONE probe tick's aggregate outcome (one write per tick — no per-item row contention under
-- parallel concurrency). Any healthy response clears the breaker; an all-rejections tick advances it,
-- and once enough consecutive all-rejections ticks pile up the breaker opens with an escalating
-- back-off (30m, 60m, 120m … capped at 24h) that resets only on a clean success.
create or replace function public.provider_probe_circuit_record_tick(
  p_identity_key text,
  p_ok_count     int,
  p_fail_count   int
) returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_open_threshold int := 2;     -- consecutive all-failed ticks before opening
  v_base_min       int := 30;    -- first back-off window (minutes)
  v_cap_min        int := 1440;  -- cap (24h)
  v_fail_ticks     int;
  v_open_count     int;
  v_backoff_min    int;
begin
  if p_identity_key is null or p_identity_key = '' then return; end if;

  -- Any healthy provider response this tick => the provider is serving us => fully clear the breaker.
  if coalesce(p_ok_count, 0) > 0 then
    insert into public.provider_probe_circuit(identity_key, fail_ticks, open_count, open_until, last_success_at, updated_at)
    values (p_identity_key, 0, 0, null, now(), now())
    on conflict (identity_key) do update set
      fail_ticks = 0, open_count = 0, open_until = null,
      last_success_at = now(), updated_at = now();
    return;
  end if;

  -- Nothing healthy AND nothing ban-ish (e.g. only dead-item 404s) => breaker unchanged.
  if coalesce(p_fail_count, 0) <= 0 then return; end if;

  -- All-rejections tick: advance the consecutive-failure run.
  insert into public.provider_probe_circuit(identity_key, fail_ticks, last_failure_at, updated_at)
  values (p_identity_key, 1, now(), now())
  on conflict (identity_key) do update set
    fail_ticks = public.provider_probe_circuit.fail_ticks + 1,
    last_failure_at = now(), updated_at = now();

  select fail_ticks, open_count into v_fail_ticks, v_open_count
  from public.provider_probe_circuit where identity_key = p_identity_key;

  if v_fail_ticks >= v_open_threshold then
    v_backoff_min := least(v_cap_min, (v_base_min * power(2, v_open_count))::int);
    update public.provider_probe_circuit set
      open_until = now() + make_interval(mins => v_backoff_min),
      open_count = open_count + 1,
      fail_ticks = 0,              -- the open window is now the guard; start a fresh run after it
      updated_at = now()
    where identity_key = p_identity_key;
  end if;
end;
$function$;

revoke all on function public.provider_probe_circuit_state(text) from public, anon, authenticated;
revoke all on function public.provider_probe_circuit_record_tick(text, int, int) from public, anon, authenticated;
grant execute on function public.provider_probe_circuit_state(text) to service_role;
grant execute on function public.provider_probe_circuit_record_tick(text, int, int) to service_role;
