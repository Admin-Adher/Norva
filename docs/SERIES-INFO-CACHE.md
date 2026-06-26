# Series-info cache + provider-collision hardening

_Last updated: 2026-06-26. Branch where this shipped: `claude/eager-carson-2zlqwy`._

This documents the fix for the recurring **`user_multi_ip` / HTTP 429** failures when
opening a series detail page ("fiche série"), the **root cause**, everything that was
changed, and — importantly — an **honest assessment of what scales worldwide and what does
not yet**, plus the cost/quota analysis so this can't quietly blow up Supabase or Cloudflare
usage.

---

## 1. The symptom and the root cause

**Symptom.** Opening a series fiche intermittently failed with `429 user_multi_ip` from the
IPTV provider — even when the user was streaming nothing ("je suis connecté nulle part").

**Root cause.** The provider (`apdxes.xyz`, a single-connection Xtream panel) answers any
**concurrent** access to the same account with `user_multi_ip`. The culprit holding a
concurrent connection was **Norva's own background enrichment crawls**: four pg_cron jobs
(`norva-audio-langs`, `-series`, `-untagged`, `norva-subtitle-backfill-movie`) that POST to
`norva-playback/audio-backfill`, which probes provider files through the relay with internal
`concurrency` 3–4. They fired every 5–10 min **all day**. When a tick overlapped a user
opening a fiche, the user-facing `series-info` (routed through the media-gateway) took the
429. Proof: an `audio-backfill` 200 sat in the middle of a cluster of `series-info` 429s in
the edge logs.

A secondary, ~once/day collision source is the catalogue auto-refresh
(`norva-source-sync/cron/refresh-due`, jobid 1) which triggers a heavy full provider re-sync
when due. It was **left as-is** (different subsystem; see §6 "Known limitations").

---

## 2. What was changed (three parts)

### 2a. Server-side series-info cache (the durable fix)

`series-info` is now read-through / write-through a cross-user DB cache so a given series
hits the provider **at most once per freshness window**, shared across every user.

- **Table** `public.cloud_series_info_cache` — migration
  `supabase/migrations/20260626160000_cloud_series_info_cache.sql`.
  - Key: **`(server_host, series_id)`** — `server_host` is `new URL(serverUrl).host`
    (includes port), matching `cloud_sources.config_hint->>'serverHost'`. Cross-user:
    both accounts on `apdxes.xyz` share one row.
  - Columns: `payload jsonb`, `fetched_at timestamptz`, `updated_at timestamptz`.
  - **RLS enabled, `revoke all from anon, authenticated`** → service-role only (the edge
    function bypasses RLS with the service key; the public can never read it).
- **Edge function** `supabase/functions/norva-series-info/index.ts` (deployed: **v15**,
  `verify_jwt: true` preserved):
  - **Read-through**: if a fresh row exists (`< SERIES_INFO_FRESH_MS`, **24h**), serve it —
    **zero provider calls**.
  - **Write-through**: a successful provider fetch is cached for everyone.
  - **Stale-while-error**: if the provider fails (429/etc.) but *any* cached copy exists —
    even stale — serve it instead of erroring. A fiche never breaks once it has loaded once.
  - **Anti-poison**: only a *real* payload (`episodes` or `info` present) is cached, never the
    `{}` returned on a soft block (`isCacheableSeriesInfo`).
  - **Credential safety** (`stripCredentials`): recursively drops every `direct_source` key
    before returning *or* caching. Some Xtream panels put the full
    `…/series/USER/PASS/123.mkv` URL there; the client builds playback from the episode id +
    each user's **own** source, so it is dead weight — and dropping it means a cross-user
    cache entry can never leak one account's credentials to another.

### 2b. Background crawls moved to an off-peak window

The four provider-probing crawls were consolidated from "every 5–10 min, all day" into a
**staggered 03:00–04:58 UTC window**, 2 min apart, so no tick overlaps a daytime user, and no
two crawls overlap each other at night. Source of truth + exact cadences:
`supabase/functions/ENRICHMENT_CRON_SETUP.md`. Applied live via `cron.alter_job` (jobids
5,7,10,11).

### 2c. Cache eviction cron

`norva-series-info-cache-prune` (jobid 24, `15 2 * * *`): pure SQL
`delete … where fetched_at < now() - interval '30 days'`. Bounds the table to "series opened
in the last 30 days". 30 days ≫ 24h freshness, so normal serving is unaffected and a
stale-while-error fallback copy survives a month. No edge/provider call.

---

## 3. Request flow after the change

```
client opens fiche
  → (client) API.proxy.xtream.seriesInfo  [10-min client cache + in-flight dedupe + retry]
  → norva-series-info edge fn  [verify_jwt]
       → read cloud_series_info_cache (PK lookup)
          ├─ fresh (<24h)? → return cached payload         ── NO provider call
          └─ miss/stale → fetchSeriesInfoFromProvider
                            → relay /series-info/<signed-token> → provider   [PRIMARY, Cloudflare egress]
                            → (relay infra fail 404/5xx only) → media-gateway → provider  [fallback]
                            → (gateway fail) → direct edge fetch → provider          [last resort]
                            ├─ success → stripCredentials → cache write → return
                            └─ failure → stale cache? serve it : throw
```

**Why the relay is primary (egress, not concurrency).** The provider `user_multi_ip`-blocks
**datacenter IPs**. Both the Railway media-gateway and the Supabase edge runtime are datacenter
IPs it rejects — so on 2026-06-26 the gateway's metadata path (series-info, catalogue sync)
started failing 100% of the time while the catalogue sync froze at 74%. The **relay
(Cloudflare)** is the egress the provider *accepts* — it's the same path that streams the video
(web `relay` mode had 0 failures while gateway `transcode` had 280). So series-info is fetched
from the relay via a short-lived HMAC-signed token whose `url` claim is the full
`get_series_info` player_api.php URL; `services/norva-relay` `/series-info/<token>` fetches it
(Cloudflare egress) and returns the JSON. Token shape is identical to `/relay/` and `/vod-info/`
(stateless HMAC, no `cloud_relay_tokens` row). The relay endpoint refuses any non-`player_api.php`
target, so it can never become a general fetcher. Gateway/direct remain as ordered fallbacks for
when the relay is unconfigured or its route isn't deployed yet (404 → fall through).

---

## 4. Cost / quota analysis (does this blow up Supabase or Cloudflare?)

**Net effect: usage goes DOWN, not up.** There is no amplification anywhere.

| Resource | Before | After | Why it's safe |
|---|---|---|---|
| **Provider calls** | 1 per fiche open (often 429 → client retried 3×) | ≤1 per series per 24h, shared across all users | The whole point. Repeat opens = 0 provider calls. |
| **Supabase edge invocations** | 1 per open, ×3 on the retry storm | 1 per open; **fewer** because stale-serve returns 200 on the first try (kills the 3× client retry) and the client cache serves repeats | No new invocation path; the cache lives *inside* the existing invocation. |
| **Supabase DB** | — | +1 PK-indexed read per open, +1 upsert per cold miss | Reads/writes are cheap and **replace** expensive provider round-trips. PK lookup, no scan. |
| **Supabase storage** | — | 1 row per distinct (host, series) opened, pruned after 30 days | Bounded by the prune cron. ~5k series/provider max; metadata JSON only. |
| **pg_cron / pg_net fires** | 144 provider-crawl fires/day | ~60/night + 1 prune | **Fewer** total fires. |
| **Cloudflare (relay)** | crawls probe via relay all day | crawls probe via relay **only at night** | series-info never touches the relay; daytime relay load **drops**. |

**Foot-guns explicitly removed**

- A `?refresh=1` cache-bypass was prototyped then **removed** before scale — a client looping
  it would have defeated the cache and re-hammered the provider. Force-refresh, if ever
  needed, should be a separate service-gated route, not an open query param.
- `stripCredentials` prevents the cross-user cache from becoming a credential-exfil vector.
- The prune cron prevents unbounded table growth.

---

## 5. Verification / operational queries

```sql
-- Cache fill + freshness
select count(*) total,
       count(*) filter (where fetched_at > now() - interval '24h') fresh,
       pg_size_pretty(sum(pg_column_size(payload))) payload_bytes
from public.cloud_series_info_cache;

-- Per-provider spread (sanity at multi-provider scale)
select server_host, count(*) from public.cloud_series_info_cache group by 1 order by 2 desc;

-- Confirm NO credentials ever landed in the cache (must return 0)
select count(*) from public.cloud_series_info_cache
where payload::text ilike '%direct_source%';

-- Crawl schedules (should be the 03:00-04:58 UTC window)
select jobid, jobname, schedule, active from cron.job order by jobid;
```

Edge logs: `mcp__Supabase__get_logs(service: "edge-function")` — a healthy series-info call is
`GET | 200`. A `429` there now only means a genuine cold-miss during a provider block with no
prior cached copy (rare, and the client retry usually rides it out).

---

## 6. Known limitations at worldwide multi-provider scale (read before scaling)

This fix is **correct and safe for the current scale** (1–2 users, one European provider) and
is **additive/reversible**. But three things must be addressed before true global scale:

1. **The off-peak window is single-region.** `03:00–04:58 UTC` is the dead of night in
   Europe but **prime time in the Americas** (≈19:00–21:00 US-Pacific). It works because this
   provider serves European users. At multi-provider/multi-region scale, each provider's crawl
   must run during **its own market's** off-peak — i.e. per-provider window scheduling. **The
   real, region-independent fix is a connection-priority mutex in the media-gateway**: only one
   provider connection at a time per account, with **user-facing requests prioritised over
   crawls** (crawls yield). That lives in `services/media-gateway` (Railway) and was not
   deployable from here — it is the recommended next step.

2. **The enrichment crawl is single-user / single-provider.** The cron jobs carry one
   hard-coded `userId`. The global per-provider crawl design (plan WS4 — dedupe by
   `(serverHost, external_id)` and fan out) exists but is behind a flag and not activated. At
   N providers, enrichment needs that branch; the off-peak window would also need to fan out
   across providers without self-collision.

3. **Throughput.** ~47k probes were pending when this shipped; the off-peak window drains them
   in ~6 weeks (the user accepted slower enrichment — the cache makes the slowness invisible
   to UX). The catalogue auto-refresh (jobid 1) was left on its daytime schedule; if daytime
   re-syncs cause 429 bursts, move it off-peak too (one `cron.alter_job`).

**Assumptions baked in** (revisit if a provider violates them):
- `series_id` is unique **per host** (standard Xtream — the panel owns the namespace). If a
  reseller runs multiple independent panels behind one hostname, the `(host, series_id)` key
  could collide across tenants. No clean non-secret signal distinguishes them today.
- `get_series_info` is identical for every user of the same panel (true — credentials only gate
  access, they don't change the metadata). The only per-user field, `direct_source`, is
  stripped.
- The 2-min crawl stagger assumes a probe batch finishes within 2 min (observed 3–10s; the
  pg_net timeout is 120s). A pathological >2-min batch could overlap the next slot — at night,
  crawl-vs-crawl only, self-healing.

---

## 7. Reversibility (how to undo each piece)

Everything is additive:

- **Relay metadata route**: revert `services/norva-relay/src/index.js` (drop the `/series-info/`
  route + `relaySeriesInfo`) and push to main; OR in `norva-series-info` set the relay branch
  off by clearing `NORVA_RELAY_BASE_URL` in `cloud_runtime_config` — the edge fn then falls back
  to gateway → direct automatically (no redeploy needed).
- **Cache table**: `drop table public.cloud_series_info_cache;` (then redeploy the edge fn from
  git history before commit `42ae172`, or leave it — a missing table just makes the cache
  read/write best-effort no-ops via their try/catch).
- **Edge function**: redeploy any earlier version, or set `SERIES_INFO_FRESH_MS = 0` to
  effectively disable the read-cache while keeping the table.
- **Off-peak crawls**: re-run the original cadences from git history of
  `ENRICHMENT_CRON_SETUP.md` (`cron.schedule` is idempotent by name), or `cron.alter_job` back
  to `0,30`, `10,40`, `20`, `25`.
- **Prune cron**: `select cron.unschedule('norva-series-info-cache-prune');`

---

## 8. Files & commits

- `supabase/migrations/20260626160000_cloud_series_info_cache.sql` — cache table.
- `supabase/functions/norva-series-info/index.ts` — read/write-through cache,
  stale-while-error, `stripCredentials`, `isCacheableSeriesInfo`, **relay-primary fetch**
  (`requestRelaySeriesInfo` + `signRelayToken` + HMAC helpers; relay → gateway → direct).
- `services/norva-relay/src/index.js` — **`/series-info/<token>` route + `relaySeriesInfo`**:
  fetches `get_series_info` from Cloudflare egress (the IP the provider accepts), mirrors
  `/vod-info/`. Deploys via `deploy-relay.yml` on push to `main`.
- `supabase/functions/ENRICHMENT_CRON_SETUP.md` — off-peak crawl cadences + prune cron
  (source of truth for schedules).
- Crons applied live: `cron.alter_job` on jobids 5/7/10/11; `cron.schedule` jobid 24 (prune).
- Client side (prior commit `9d16259`): `API.proxy.xtream.seriesInfo` 10-min cache +
  in-flight dedupe + retry — complements the server cache (cuts duplicate calls per browser).

## 9. The hard limit: provider single-IP lock + the pre-warm auto-heal

A decisive test (2026-06-26) settled where the wall is. `norva-series-prewarm` fetched
`get_series_info` for two series **server-side, from the gateway's single stable IP**, with no
crawls (off-peak), no active stream, sync paused, and **no user involved** — and the provider
**still** returned `{"reason":"user_multi_ip","version":"3.0.0-dragonfly"}`. A single clean call
from one IP getting "multi_ip" means the provider sees **another IP on the account** (a second
device / IPTV app using the same Xtream credentials) **or** a sticky multi-IP cooldown. **No
routing (relay, gateway, direct) can override a provider-side single-IP lock** — every metadata
fetch must reach the provider, and it rejects all of them while it sees ≥2 IPs. This is a
provider-account condition, not a Norva bug.

**The durable fix is to never make a live call.** `norva-series-prewarm` (service-gated by
`NORVA_BACKFILL_TOKEN`, `verify_jwt:false`) fills `cloud_series_info_cache` for every series from
the gateway's **single stable IP**, throttled (300 ms apart), aborting after 3 consecutive 429s
so it never hammers a locked provider. Cron `norva-series-info-prewarm` (jobid 25,
`*/10 1-5 * * *` UTC) runs it off-peak: the **moment** the account is clean (no 2nd device, any
cooldown expired) it fills 40 series/run, and from then on the web serves series-info entirely
from cache — **immune** to `user_multi_ip` regardless of how many devices later connect. It
self-heals with **zero user action** once the account is single-IP.

Manual one-shot (e.g. right after the user closes other devices) — fills fast:
```sql
select net.http_post(
  url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-series-prewarm',
  headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' ||
    (select decrypted_secret from vault.decrypted_secrets where name = 'norva_backfill_token')),
  body := jsonb_build_object('sourceId','<xtream source id>','userId','<owner id>','limit',60),
  timeout_milliseconds := 120000);
-- progress: select count(*) from cloud_series_info_cache where server_host='apdxes.xyz';
```
Files: `supabase/functions/norva-series-prewarm/index.ts`, `supabase/config.toml`
(`verify_jwt=false`). Reversible: `select cron.unschedule('norva-series-info-prewarm');` and
drop the function.
