# Norva Provider Access — Phase 16 progressive rollout proof

Date: 2026-08-24

Status: `PHASE_16_CONTROL_PLANE_PROVED`, production activation still blocked by the cache observation window and real approval evidence.

## Implemented control plane

- Durable singleton with revision CAS and the exact ladder:
  `OFF → INTERNAL → 1% → 5% → 20% → 50% → 100%`.
- Upward stages cannot be skipped. Every upward transition requires both legal-policy and operational evidence plus a P0-safe analytics snapshot.
- Every stage transition is explicit and durably audited; there is no timer or automatic promotion.
- Cohort promotion enables only the six durable core/in-app capabilities.
  Automatic provider checks, email and push use an independent revision CAS,
  readiness evidence and audit event, and are reset OFF at every stage change.
- Any lower stage, including emergency `OFF`, remains directly reachable without a down-migration.
- Internal rollout uses a server-only allowlist. Percentage rollout uses a stable SHA-256 user cohort in basis points.
- Browser users can read only their own sanitized `{stage, revision, eligible}` status.
- New automatic-detection jobs and notification rows are rejected at the table boundary for users outside the current cohort.
- Edge user routes, access-check workers and email/push delivery re-check cohort eligibility before doing user/provider work.
- Provider Access expiry hiding is cohort-scoped; staging/replacement lifecycle isolation remains unconditional.

## Database proof

Disposable current-head database: `norva-phase3-proof-b-db`.

Original pgTap result:

```text
1..25
25 ok
0 failed
ROLLBACK
PROVIDER_ACCESS_ROLLOUT_25_PASS
```

The suite proves OFF installation, zero enabled flags, sanitized owner-only status, explicit gate evidence, revision CAS, internal membership, non-member job/notification suppression, member acceptance, no skipped stage, deterministic percentage assignment, stale concurrent rejection, immediate OFF rollback, complete flag shutdown and ordered audit history.

Real two-session promotion race:

```text
PASS provider access rollout promotion race
one session exit=0
one session exit=3 with stale rollout revision
final_state=internal:3:1
post-cleanup=off:1
```

Exactly one session created the `INTERNAL` event. The loser did not mutate the stage. The harness cleanup restored OFF and all capability flags to false.

The additive external-channel gate proof in
`22-phase16-external-channel-gates-proof.md` supersedes the aggregate flag
behavior while preserving the stage ladder. Its current PostgreSQL result is
`33/33`; a second real two-session race proves one channel CAS winner and one
`STALE` loser. Cleanup again restores OFF and zero enabled flags.

## Regression evidence

- Full Node suite: `2624` tests, `2622` passed, `0` failed, `2` expected skips.
- Phase 16 focused Node contracts: green.
- Notification Edge worker: Deno type-check green.
- Main Provider Access Edge: esbuild bundle green; this historical JS-style `.ts` file is not strict-Deno-clean as a whole, so the bundler plus contract/runtime suites remain its executable validation boundary.
- PostgreSQL calendar/lifecycle: `40/40`.
- PostgreSQL analytics/P0: `14/14`, replayed twice.
- PostgreSQL notification outbox: `39/39` plus a real two-session claim race.

## Production boundary

Installing this migration is safe and additive because it forces the new rollout singleton and every Provider Access capability to `OFF`. Installation is not activation.

Real activation remains blocked until all of the following are true:

1. the incompatible cache observation window documented in the Phase 1–3 production proof ends around 2026-08-31;
2. the production cache-epoch-v2 completion manifest is explicitly accepted;
3. real legal-policy and operational references are recorded (test references are rolled-back fixtures, never production evidence);
4. the exact internal user is explicitly allowlisted;
5. a fresh production P0 snapshot is green;
6. each later percentage stage receives a real observation window and explicit approval.

No phase may bypass these gates by directly changing feature-flag booleans.

## Production operator gate

`ops/hetzner/scripts/run_provider_access_rollout_gate.sh` makes the production
path explicit and read-only by default. It accepts only `norva-db` and exposes
separate, literal confirmations for gate approval, internal membership, cohort
stage and external-channel readiness. An upward cohort refuses an incomplete
cache epoch; channel changes refuse `OFF`; every action uses the database RPC
and revision CAS rather than editing feature flags directly.

The gate-approval action additionally requires the supplied legal reference to
match the exact configured `billing_ledger` retention-policy reference. This
prevents a free-form rollout note from masquerading as the versioned legal
policy. Production preflight remains non-mutating until the policy, cache and
explicit user/operator decisions are present.

The operator gate was exercised against the dormant production database on
2026-08-25. Read-only preflight returned `off`, revision `1`, zero internal
users, zero enabled flags, no external channels, cache `installed`, legal
policy `UNCONFIGURED` and `p0_safe=true`. A syntactically valid internal-user
request without the literal confirmation exited `64`; a second preflight
proved that membership, rollout revision and flags were unchanged.

```text
operator script SHA-256
a7836308ed016bfa098a9fb4c54635b0d9e3f40bd7a5aba1bb0478287f0ecb45

operator contract SHA-256
1bb0441bcc9edd495ed71c5a844b43c309e51300e1306f69a6166dbc46596cb5

repository regression
2643 tests / 2641 passed / 0 failed / 2 expected skips
```
