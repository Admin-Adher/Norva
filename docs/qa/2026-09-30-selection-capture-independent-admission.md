# Selection capture admission — 30 September 2026

## Change and scope

The Selection worker reads `selection_audio_capture_pipeline_enabled()`, which
previously required both `selection_capture_pipeline_enabled` and the legacy
generic `language_capture_pipeline_enabled`. Ordinary capture now uses its own
job-aware rollout; enabling Selection should not enable the legacy generic lane.

Migration `20260930160000_selection_capture_independent_admission.sql` removes
only that obsolete dependency. It preserves the installed function OID, owner,
ACL, security attributes and `search_path`. It requires exactly one occurrence
of the original expression and refuses drift or a second application (`55000`).
It is a one-time migration, not an idempotent operator command.

No flag is activated. The separate Selection parallel flag remains necessary
for two work leases; capture alone keeps one. Claim ownership, source identity,
catalogue generation, exact URL, work-token CAS, capture profile/window binding,
attempt ceilings and terminal history are unchanged. Gateway resource, host,
provider-drain and foreground-playback admission are unchanged.

## Executed verification

- 50 focused Node tests passed, 0 skipped, including the actual PostgreSQL/WASM
  fixture using `@electric-sql/pglite@0.5.8` from a separate scratch directory.
- The SQL fixture executes 40 assertions. It reproduces the old coupling, then
  accepts a real capture checkpoint with Selection enabled and legacy disabled.
  It also checks flag revocation, missing flags, private ACL/RLS, lease/profile/
  exact-URL mismatches, changed generations, unavailable/deleted sources,
  unchanged attempt budgets, terminal failures and the one/two-work-lease limit.
- The real worker processor uses capture receipts without calling legacy network
  analysis when its Selection RPC admits capture and parallel admission is off.
- The Build `Verify cloud contracts` job installs the pinned SQL runtime in
  `RUNNER_TEMP` and sets `NORVA_REQUIRE_SELECTION_SQL=1`; a missing dependency is
  a failure. This failure case was also executed locally. The general Node suite
  may skip this optional fixture, but the dedicated mandatory step cannot.
- `git diff --check` passed. No provider request was made by these tests.

The visibility dependency in the SQL fixture is a reduced view over synthetic
sources and current generations. This is not a replay of the full production
stack or a proof of real provider throughput. The existing historical SQL
fixture remains compatible with its simpler visibility wrapper.

## Natural replay candidate

Read-only production inspection at **2026-09-30 15:34:29 UTC** found **0 new
eligible exact files**. The query used the committed Selection manifest's files
with incomplete audio, current visible owners, valid Selection source identity,
matching media generation and exact URL digest, no complete per-file audio, and
no existing Selection job for that exact file. No credentials or media URLs
were emitted.

The existing terminal jobs must not be reset or renamed to manufacture a replay.
Activation and a real capture→checkpoint→inference→hydration replay remain
separate work after review and CI, when a naturally eligible new file exists.
This change is prepared locally; no production flag, job or function was changed.
