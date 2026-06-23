# Background auto-refresh cron (premium)

The premium "keep my catalogue up to date" feature runs an **app-closed change
detector**: on a schedule, for each premium user's source, it fetches the
provider catalogue, compares its fingerprint against the last full import, and —
when something new landed — records a capped "what's new" event that the client
surfaces in-app on open. It deliberately does **not** import or rebuild anything
in the background (that overruns a single edge isolate on large catalogues); the
proven, client-driven batched import/finalize still runs on the next open.

This file documents the out-of-band wiring (Vault secret + pg_cron schedule).
It is **not** a migration: it must be applied with `execute_sql` against the
project, never committed as runnable SQL, because it establishes the cron and
relies on a Vault secret. No secret values appear here.

## Pieces

- **Edge routes** (`supabase/functions/norva-source-sync/index.ts`)
  - `POST /cron/refresh-due` — the scheduled entry point. Locks a small batch of
    DUE, entitled sources (compare-and-set, TTL self-freeing), runs a
    detection-only refresh per source in the background, returns immediately.
  - `POST /cron/finalize/:id` — best-effort, budget-bounded finalize loop in one
    isolate (ops recovery; fine for small sources).
  - `POST /cron/finalize-step/:id?phase=&offset=&limit=` — runs exactly ONE
    finalize batch and returns `{ nextPhase, nextOffset }`. Call in a loop (each
    call a fresh isolate, like the client) to reliably materialize a large
    source. All three are authorized by the Vault cron secret (or the service
    key as an admin fallback).

- **Auth** — a dedicated secret lives only in Vault under the name
  `norva_cron_shared_secret`. The edge function verifies a presented bearer via
  the `service_role`-only `SECURITY DEFINER` function
  `public.norva_verify_cron_secret(text)`, which returns just a boolean, so the
  secret never leaves the database.

- **Schedule** — pg_cron job `norva-auto-refresh-detect`, every 30 min, posts to
  `/cron/refresh-due` with `Authorization: Bearer <secret-from-vault>`. The
  per-source cadence is 6h (a tick only acts on sources whose window is due), so
  the 30-min schedule is just polling granularity.

## (Re)create — run via execute_sql, NOT as a migration

```sql
-- 1. Extensions
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 2. Cron secret (server-generated; only created if missing)
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'norva_cron_shared_secret') then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'norva_cron_shared_secret',
      'Bearer for norva-source-sync POST /cron/* (pg_cron -> edge)'
    );
  end if;
end $$;

-- 3. Verifier (service_role only; returns a boolean, never the secret)
create or replace function public.norva_verify_cron_secret(presented text)
returns boolean language sql security definer set search_path = '' as $$
  select exists (
    select 1 from vault.decrypted_secrets s
    where s.name = 'norva_cron_shared_secret' and s.decrypted_secret = presented
  );
$$;
revoke all on function public.norva_verify_cron_secret(text) from public, anon, authenticated;
grant execute on function public.norva_verify_cron_secret(text) to service_role;

-- 4. Schedule (command references the secret by NAME via subquery — no literal)
select cron.schedule(
  'norva-auto-refresh-detect',
  '*/30 * * * *',
  $cron$
  select net.http_post(
    url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-source-sync/cron/refresh-due',
    body := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'norva_cron_shared_secret')
    ),
    timeout_milliseconds := 20000
  );
  $cron$
);
```

## Rotate the secret

```sql
select vault.update_secret(
  (select id from vault.secrets where name = 'norva_cron_shared_secret'),
  encode(extensions.gen_random_bytes(32), 'hex')
);
```
Both pg_cron (reads Vault at call time) and the verifier pick up the new value
immediately — nothing else to redeploy.

## Pause / remove

```sql
select cron.unschedule('norva-auto-refresh-detect');
```

## Recover an interrupted finalize (ops)

If a source is stuck mid-materialization (`sync_status = syncing`, a
`building_*` stage), the client finishes it automatically on next open. To force
it server-side without a user session, drive `/cron/finalize-step` one batch at a
time from SQL (synchronous `http` extension; the secret stays in Vault):

```sql
-- requires: create extension if not exists http;
set statement_timeout = '300s';
select http_set_curlopt('CURLOPT_TIMEOUT_MS', '60000');
do $$
declare
  v_secret text; v_phase text := 'live'; v_offset int := 0; v_resp jsonb; v_status text; i int := 0;
  v_base text := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-source-sync/cron/finalize-step/<SOURCE_ID>';
begin
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'norva_cron_shared_secret';
  loop
    i := i + 1; exit when i > 80;
    select r.content::jsonb into v_resp from http((
      'POST', v_base || '?country=FR&phase=' || v_phase || '&offset=' || v_offset,
      array[http_header('Authorization','Bearer ' || v_secret)], 'application/json', '{}'
    )::http_request) as r;
    exit when v_resp ? 'error';
    v_status := v_resp->>'status'; exit when v_status = 'ready';
    v_phase := coalesce(v_resp->>'nextPhase','complete'); v_offset := coalesce((v_resp->>'nextOffset')::int, 0);
  end loop;
end $$;
```
