# Current-window capacity inside the private audio budget

Base: `cfa20d583ed4a083309fce6e05b8068792a95a43`. The original working tree is
untouched. This patch changes only three private capture modules and their tests;
it does not change playback, Edge, SQL, flags, models or provider concurrency.

## Reproduced defect

The worker completes all temporal windows of one track before advancing to the
next. A multi-track acquisition also retains optional windows for later tracks.
Those speculative records previously used the same reservation budget as the
current windows. Two jobs with unequal provider/inference latency could fill it
enough to reject one job's next current window with `LID_CAPTURE_STORE_FULL`,
even though its next useful work was necessary to reach the retained companions.

A synthetic regression uses the production 32 MiB encrypted / 16-entry limits,
two jobs, four tracks and six windows per track. After staggered first windows,
the unmodified code rejects a current acquisition at track 1, window 3. This is
an admission/throughput defect, not proof of a provider refusal or an ASR error.

## Correction and unchanged boundaries

`reserve(binding, { opportunistic: true })` leaves two worst-case 3 MiB record
slots and two entries free **inside** the existing budget, in addition to all
outstanding reservations. Companion prefetch and passive collection use this
mode; a current capture and adoption of its existing passive excerpt do not.

The atomic writer lock protects both reservation dimensions. Existing cached
records can still be reused when speculative headroom is unavailable. A miss
defers only optional work before opening a provider or reading playback files.
There is no eviction, TTL extension, enlarged disk quota, extra inference slot,
new connection, new certificate or threshold change. Historical full stores
are not forcibly emptied; ordinary expiry/acknowledgement still applies.

## Evidence and rollout boundary

The corrected same-interleaving regression completes all 48 synthetic windows
with 32 simulated acquisitions and a peak of 28,170,067 encrypted bytes. Local
inference is asserted to occur only after both simulated connections are drained.
This measures the fixture, not real provider throughput or recovered variants.

Additional behavioral tests cover independent byte/entry pressure, simultaneous
reservations, retained records after restart, unchanged expiries, two current
reservations, and passive deferral before accessing the viewer's files.

Validation on 15 September (Paris):

- Full application suite after the post-VOD rebase: 4,845 passed, 18 skipped,
  zero failed (114.72 seconds). The earlier base passed 4,839 tests.
- Focused capture/handoff/Selection suite: 93 passed, three native-only skipped.
- Windows native FFmpeg suite: 48 passed, one Linux-only lock test skipped.
  Synthetic dual-track input: 1,413,785 bytes in one request versus 2,827,570
  bytes in two requests. These are localhost fixtures, with zero provider calls.
- Changed-module syntax, locale generation check, region model and diff checks
  passed. The existing Linux ownership implementation is unchanged; Windows
  native evidence is not a test in the production container image.

Publication is separate from deployment. Even a `main` push redeploys the relay
through `deploy-relay.yml`; no push/PR or server mutation was made during the
independently authorized Opplex/Promax measurement window. That task explicitly
closed the window after its final idle reading at 00:45:10 UTC on 15 September.
This patch was then rebased onto its relay, SQL lock-budget and owner-safe cron
fixes (PRs 355, 356 and 357), with the full suite and native fixtures rerun.

The independent read at 00:51:57 UTC confirmed the unchanged healthy Gateway and
two Edge images, cron 180 active under `supabase_admin`, duplicate 181 retained
inactive, and worker 182 active. It also observed media work still in progress:
closing the coordinated test window is not permission to bypass an idle guard.
This patch does not activate a dormant enrichment lane or complete the real
multi-track, passive/QoS and Selection acceptance gates.
