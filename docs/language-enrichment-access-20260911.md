# Automatic language enrichment: separate access policy

## Scope and release state

Prepared locally on `codex/language-enrichment-access-20260911`, based on
`58ea2eb6c9496abb81eb3e2488f42e8c5611982e`. Publication and production deployment
were explicitly authorized on 2026-09-11. This document records pre-release
validation; a timestamped production receipt records the actual deployment.

This change removes the **Norva playback subscription** requirement only from
server-created automatic language jobs. It does not grant a subscription, start
a trial, consume an access credit, create a playback session, or return a media
capability to a browser. No migration is needed: the server-owned `request_origin`
column was introduced by `20260911123735_lid_adaptive_quota.sql`.

| Path | Authorization after this change |
| --- | --- |
| Automatic intake and automatic strict movie/episode jobs | Current account, visible owned source, no ban/deletion or hard billing block; playback subscription not required |
| Manual language request, public polling/scheduling, legacy jobs | Existing playback entitlement requirement |
| Ordinary playback | Unchanged playback entitlement and stream limits |

Missing subscriptions, expired trials/subscriptions and the existing soft billing
states can qualify for background enrichment. `revoked`, `refunded`, `fraud`,
missing/deleted/banned accounts and unknown response shapes fail closed. Temporary
Auth/database failures defer work, without being counted as a failed provider
probe. No decision is cached across worker checks.

The worker rereads origin from the durable job row, scoped by job, owner and
source; it never trusts an HTTP field or an origin hint in a claim. Historical
rows are not reclassified. A free caller's failed public poll cannot cancel its
otherwise authorized automatic job. A real revocation still blocks/cancels it.

## Preserved controls

- Source ownership, visibility, active generation, provider identity and exact
  observed-file profile checks remain in place.
- Provider circuits, account/file leases, foreground priority, drain attestations,
  server-capacity admission and concurrency ceilings are unchanged.
- Existing quarantine, retry and certificate rules are unchanged. No historical
  job, excerpt or outcome is reset or revived.
- No new cron, model, billing grant, provider credential or client feature.
- Current account checks use the server-only
  [Supabase Admin user lookup](https://supabase.com/docs/reference/javascript/auth-admin-getuserbyid),
  not client-editable metadata.

## Verification

Targeted Node tests: **178 passed, 0 failed, 0 skipped**, covering the actual Edge
helpers, automatic intake/cache behavior, strict worker contracts, quota/capacity
guards and manual import certificates. Included are three tests using the actual
Supabase client with an in-memory HTTP responder: browse-only, banned and Auth
unavailable. They assert GET-only requests and do not access a real account.

TypeScript-to-ESM transformation passed with zero warnings; this is syntax/build
validation, not a full Deno type-check. `git diff --check` passed.

Final full Windows suite: **4,388 tests, 4,383 passed, zero failed, five skipped**.
The unmodified Android evidence workflow was mechanically normalized to the LF
line endings used by CI in this isolated checkout. Its content has no Git diff;
no Android or billing code was changed. The complete suite was rerun afterward.

Eight isolated Python operator tests passed, covering idle/drift rejection,
exact cron restoration, sequential rollout and failure recovery. They execute
the operator functions with fakes and make no production or provider requests.

Test dependencies were resolved inside the isolated worktree. Gateway dependencies
were installed from its existing lockfile (`npm ci --ignore-scripts`), including
Undici 7.29.0. The main checkout's older installed dependencies were not modified.
The real local SOCKS5 fixture then passed, as did the complete targeted proxy suite
(four tests). Local Gateway fixtures use synthetic media and local servers, not
customer providers.

Production prerequisites checked **read-only on 2026-09-11 at 15:34:20 UTC** with
`ops/hetzner/sql/language-enrichment-access-preflight.sql`:

- Job origin column exists and is non-null; job RLS is enabled.
- The service role can read origin; `anon` and `authenticated` cannot insert or
  update that column.
- Only the service role among those roles can execute the automatic-job creation
  function; public clients cannot use that RPC to evade the manual access gate.
- 25 ready visible sources, 21 current owners, zero hard-blocked sources.
- 16 sources / 16 owners have no entitlement projection.
- All 25 sources qualify under the new **account-level** enrichment rule.

Those counts are an eligibility snapshot, not proof that a provider will accept a
connection or that every file can be analyzed. No production data or setting was
changed by this check; no provider was contacted.

## Remaining release verification

Publish the tested scoped commit, require green CI, then verify both Edge replicas have
the intended file hash and `/health` marker `languageEnrichmentAccessProtocol: 1`.
Observe an automatic file from a previously browse-only owner through intake and
the strict worker, only while its provider account is free. Confirm that playback
and manual requests are still denied without rights, provider/foreground gates
remain effective, and billing records and protected quarantines are unchanged.

Do not claim that newly eligible files are enriched before this end-to-end check.
The release operator stages an isolated copy of the existing function tree and
changes only `norva-playback/index.ts`. It temporarily pauses only the two existing
dynamic-enrichment / strict-language worker cron jobs, waits for active work and
playback to drain naturally, then rolls the replicas one at a time. Cron commands,
schedules and original active states are checked and restored exactly. The old
containers and trees are retained. `resume-original` safely abandons a paused
release before deployment; `resume` recovers a cron-resume interruption after both
new replicas have passed verification. Neither mode cancels jobs.

For a rollback, quiesce automatic LID with the existing operational controls first:
the prior code would again reject browse-only jobs when resumed. Preserve receipts
and never reset quarantines or reclassify legacy origins as a rollback shortcut.
