# Provider Access — current production completion audit

Date: 2026-08-25

Repository head used by the current-state clone proof:
`bf130e4b2fdf7bfe2a918a6c26ef701e750a21bc`.

This document supersedes the implementation status in the original
23-August progress report. It does not redefine completion: production is not
100% complete until the time-bound cache gate, internal canary, external
channels and progressive cohort observations have all passed.

## Requirement-by-requirement status

| Phase | Current evidence | Remaining production boundary |
| --- | --- | --- |
| 0 — audit | Complete architecture, lifecycle, visibility and rollback audit in documents 01–07. | No implementation gate. |
| 1 — visibility | Runtime core proved; DB/Edge/Web installed production-dormant; global plus account cache epoch v2 installed. | Database-enforced observation window ends 2026-08-31 10:12:57 UTC, then explicit completion. |
| 2 — transitions | Candidate binding, durable transitions, CAS, generations and stale-worker fences proved and installed. | Shared production cohort activation only after cache completion. |
| 3 — same catalogue | Historical A/B migration, concurrency/crash matrix, swap, post-swap refresh and rollback formally closed; authenticated production smoke proved. | Shared cohort activation and observation only. |
| 4 — new provider | Staging, atomic promotion, replacement cleanup and account-deletion compatibility implemented and installed dormant. | Shared cohort activation and real internal observation. |
| 5 — A to B E2E | Synthetic cross-surface proof is `PHASE_5_PROVIDER_A_TO_B_CROSS_SURFACE_PROVED`. | Real internal canary remains deliberately unavailable while stage is OFF. |
| 6 — access cycles | Cycle model and calendar semantics proved on PostgreSQL. | Shared cohort activation. |
| 7 — Xtream detection | Conservative detection and contradiction handling proved; scheduler installer is explicit and dormant. | Enable separately only after internal readiness evidence. |
| 8 — access visibility | Hide/unhide policy and complete surface/cache contract proved. | Cache rollout completion is the hard activation prerequisite. |
| 9 — onboarding | Implemented, locally/runtime proved and deployed Web-dormant. | Observe authenticated internal user after activation. |
| 10 — Settings | Implemented and deployed Web-dormant, including compact Duration + Unit and interactive calendar. | Observe authenticated internal user after activation. |
| 11 — outbox | Durable notification outbox, leases, retry/dead-letter and cron lifecycle proved. | Install cron only after channel approval and active cohort. |
| 12 — email | Bounded Resend worker and independent flag are deployed; transport secret exists. | Real opt-in internal delivery smoke before channel approval. |
| 13 — push | Data-only FCM contract and fixed deep link proved. Signed Phone 1.3.9 AAB exists. | Upload/release through the authenticated Google Play Console, then real-device smoke. |
| 14 — in-app | Owner-scoped route and explanatory calendar UX proved and deployed dormant. | Internal authenticated runtime observation. |
| 15 — analytics | Aggregate-only analytics and P0 staging-visibility alarm proved. | Establish live internal baseline without P0 breach. |
| 16 — rollout | Control plane, CAS races, channel independence, rollback/OFF and operator scripts proved and production-installed. A revision-bound durable observation gate is DB/concurrency-proved and pending fresh-clone installation proof. | Install the observation gate dormant, then execute `internal -> 1% -> 5% -> 20% -> 50% -> 100%` with the server-owned observation window and explicit approval at each rung. |

## Production legal policy

The official French company directory identifies the active company as NORVA,
SIREN `108055237`, and its RNE data exposes accounting close `3112`. Production
policy v2 is now configured as:

```text
policy revision       1
policy reference      NORVA-LEGAL-BILLING-V2-SIREN108055237-20260825
retention years       10
fiscal close          12-31
calculation version   2
config hash           57d489ed69d33acbe90bd4d06b633e89a3132623106b9b6fd573950e3da6d3ce
policy events         1
archive rows          0
enabled readers       0
direct API grants     0
```

The basis is the French Commercial Code Article L123-22 accounting-record
retention rule plus CNIL active/intermediate archive separation and data
minimisation. The targeted pre-configuration dump is:

```text
/var/lib/norva-phase3-proof/legal-policy-production-20260825-v2/preconfigure.dump
SHA-256 f79b69ed0d13487eae490cb2edf6b08210b5c6517c90852af5a65981b56b6137
mode 0600
```

No archive reader was inferred or granted. Reader access remains a distinct,
audited AAL2 decision.

## Production rollout preparation

The immutable references and one owner/admin internal user are prepared while
the cohort remains OFF:

```text
rollout revision        2
stage                   off
legal reference         NORVA-LEGAL-BILLING-V2-SIREN108055237-20260825
operational reference   NORVA-PROVIDER-ACCESS-PHASES1-16-PROD-PROOF-B30F3F7E-20260825
internal users          1
enabled flags           0 of 9
external channels       none
Provider Access crons   none
P0 safe                 true
```

## Current-state production clone

The configured production state was dumped, restored into a fresh isolated
Supabase/PostgreSQL container with cron disabled, ACL-replayed and tested. The
first run exposed a hard-coded fixture rollout revision; the fixture was made
state-aware and the clean v2 run passed.

```text
result       PHASE123_PRODUCTION_CLONE_REHEARSAL_PASS
mode         current-state
commit       bf130e4b2fdf7bfe2a918a6c26ef701e750a21bc
report       /home/adrien/norva-phase3-proof/artifacts/prod-clone-current-policy-v2
dump bytes   910121251
dump SHA-256 400c10ebd112e06ad2d56c936f97a44f676b5614a88df419c2996525f7f37696
```

Exact API ACL comparison:

```text
production ACL SHA-256 726a008c166ccaa8e2e9dd259da16d7d1d36603a60cbc139bfe9e34e34446808
clone ACL SHA-256      726a008c166ccaa8e2e9dd259da16d7d1d36603a60cbc139bfe9e34e34446808
ACL diff bytes         0
ACL diff SHA-256       e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
final invariants SHA   43862813b84e32a6f045de74011081ebf004f56dcba211fbc71adb1699d887a2
notification test SHA  7021fc554f2e4e9f0f511e906ecccd47f3417e2a05292e06362acf81264f113a
```

The proof container was stopped after success; its volume and artifacts were
preserved. Production `norva-db` remained healthy.

## Android release evidence

GitHub Actions run `32795287248` built both signed AABs from commit
`b30f3f7e98afd45bfaec7f423d70ce3df069fbd1` with the release keystore and FCM
configuration:

```text
Phone 1.3.9 / versionCode 22
bytes   13785473
SHA-256 6ebe1721f4de63934a7b7fb277a43f6f6b7c31716185507ebd9cfb791e21db01

TV 3.8.14-hybrid / versionCode 27
bytes   41889758
SHA-256 6418dc4dd06aa369839a8a8ceeb2d48524cd1651f01c102de54e48bde698e7f2
```

The AABs are artifacts, not a claim of Play Store publication. The available
browser has no authenticated Play Console session.

## Remaining hard gates

1. Complete cache epoch v2 only after its database time boundary and another
   safe preflight.
2. Obtain explicit archive-reader designation before granting future access to
   sensitive legal records.
3. Authenticate the Google Play Console, upload Phone 1.3.9, release it through
   the selected track and verify a physical-device FCM deep link.
4. Activate the internal cohort, keep external channels independently OFF,
   perform the real functional/caching/rollback canary and record metrics.
5. Approve and observe every progressive rung before the next promotion.

The durable Phase 16 observation gate and notification analytics correction are
documented in `26-phase16-rollout-observation-gate-proof.md`. Their repository
and disposable-PostgreSQL proofs are green; they are not yet represented as
installed in the production state described above until a fresh clone, dormant
installer and post-install clone all pass.

Until all five are evidenced, implementation and dormant production
installation are proved, but the requested 100% production rollout is not.
