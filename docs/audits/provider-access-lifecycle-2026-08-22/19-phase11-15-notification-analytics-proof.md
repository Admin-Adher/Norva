# Norva Provider Access — Phases 11–15 proof report

Date: 2026-08-24

Scope: notification outbox, email, push, in-app/calendar UX and aggregate analytics.

Production state: **not enabled**. All Provider Access flags remain OFF; Phase 16 rollout gates remain pending.

## Result

| Phase | Result | Evidence |
|---|---|---|
| 11 — durable notification outbox | PROVED | PostgreSQL pgTap `39/39`; two-session `FOR UPDATE SKIP LOCKED` claim race: session A claimed one row, session B zero; cleanup returned zero pending rows and no active lease. |
| 12 — email delivery | PROVED LOCALLY | Dedicated Edge worker, bounded claim/ack/retry/dead-letter contract, idempotency key, provider timeout and generic user-facing error handling. Unconfigured email is skipped before claim and does not consume attempts. |
| 13 — push delivery | PROVED LOCALLY | Data-only FCM payload, Android notification routing and settings deep-link; unconfigured push is skipped before claim. Android unit task is green. |
| 14 — in-app and calendar UX | PROVED LOCALLY + DB | Notification route opens the relevant Provider Access UI. Activation date, duration and unit are durable; Duration and Unit share one compact row. The accessible calendar is Monday-first, keyboard/touch usable, and a clicked end date recalculates an exact day duration. PostgreSQL lifecycle suite `40/40`, including the exact `provider_access_cycle_extended` event. |
| 15 — aggregate analytics | PROVED ON CURRENT PROOF HEAD | Service-role-only aggregate RPC and admin-JWT route; no user/source/transition IDs, credentials, recipients or tokens returned. PostgreSQL pgTap `14/14`, replayed twice on the current proof-B database. A real rollback-scoped visibility violation produced severity `P0`, and the rollout assertion failed closed with SQLSTATE `P0001`. |

## Reproducible database evidence

Disposable host: Hetzner proof environment.

Current-head database: `norva-phase3-proof-b-db`.

### Notification outbox

- pgTap: `1..39`, all assertions `ok`.
- Concurrent claim harness: two real PostgreSQL sessions synchronized against the same eligible row.
- Winner: session A, one row claimed with processing lease.
- Loser: session B, zero rows claimed.
- Post-test cleanup: no pending notification row, no live lease, no residual fixture.

### Calendar terms and lifecycle event

- pgTap: `1..40`, all assertions `ok`.
- The extra assertion proves that moving a hidden source to a later end date emits exactly one durable `provider_access_cycle_extended` event.
- The suite runs inside a transaction and ends with `ROLLBACK`; no fixture persists.

### Analytics and P0 gate

- pgTap: `1..14`, all assertions `ok`.
- Deterministic replay on a clean transaction: `PHASE15_RUN_B_REPLAY_PASS`.
- A rollback-scoped visible replacement-candidate fixture was counted as a staging visibility violation.
- The aggregate dashboard returned `P0` and `norva_assert_provider_access_rollout_safe()` rejected rollout with SQLSTATE `P0001`.
- The older proof-A database correctly refused the dashboard because it predates the replacement-cleanup schema. This is an intentional fail-closed schema mismatch, not a green current-head run.

## Application and build evidence

- Full Node suite: `2618` tests, `2616` passed, `0` failed, `2` skipped.
- Android phone: `:app:testDebugUnitTest` — `BUILD SUCCESSFUL`.
- Edge functions: Deno type-check green.
- Edge bundles: esbuild green with Deno `npm:` imports externalized.
- Calendar behavior checked in a real local browser at mobile width:
  - `2 months` from `2026-08-24` resolves to `2026-10-24`;
  - selecting `2026-10-31` changes the form to `68 DAY`;
  - the selected end date exposes the pressed state.
- Admin aggregate dashboard rendered locally with four dense metric groups and a distinct rollout-gate/P0 surface.

Local visual artifacts (not committed):

- `output/playwright/provider-access-duration-calendar-clean-mobile.png`
- `output/playwright/provider-access-calendar-click-compact-mobile.png`
- `output/playwright/provider-access-phase15-dashboard.png`

## Integrity and privacy properties

1. A notification is durable before delivery is attempted.
2. Claiming is atomic, bounded and lease-based; a competing worker cannot claim the same row.
3. Provider/channel misconfiguration does not consume a delivery attempt.
4. User-facing delivery payloads contain product copy and routing data, never credentials or raw provider responses.
5. Provider Access dates do not mutate or refresh the catalogue by themselves.
6. Analytics are aggregate-only and service-role/admin gated.
7. Any staging visibility breach is a P0 rollout blocker, not a warning.
8. The production feature flags remain OFF until Phase 16 gates explicitly authorize a cohort.

## Remaining gate

Phases 11–15 are implementation-complete and proved at their stated boundary. They are **not production-enabled**. Phase 16 must still implement and prove the progressive rollout (`internal → 1% → 5% → 20% → 50% → 100%`), rollback/kill-switch behavior, production observability, and the legal/operational policy gate before real activation.
