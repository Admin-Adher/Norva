# Recovery from an unavailable movie version

## Scope

Adrien approved a recovery path for a refused movie copy: identify the selected
version as unavailable, offer the other versions of the same film, retain manual
retry and return to its details. This change does not repair a remote refusal or
establish its internal cause. HIT and the separate MULTI-SUB input-corruption
investigations remain open.

## Behaviour

- The web error identifies the version rather than declaring the whole title
  unplayable. It offers **Other versions**, **Retry this version**, and **Back to
  details**. Provider status numbers, URLs and private identifiers remain absent.
- Other versions are resolved through the authenticated catalogue using the
  exact source/file identity. The existing detail selector keeps each file's own
  language, subtitles, format and source. No media probes run when listing copies.
- Selecting another copy requires an explicit start/resume choice. Resume is
  omitted if its position reaches or exceeds the known target duration. Track
  indices from the old file are not copied to a sibling. The selected file keeps
  its own saved preferences. An explicit recovery position, including zero,
  overrides server and local resume history for that invocation only; the
  transient flag is consumed before a playback snapshot can retain it. Recovery
  positions are bounded to 0–86,400 seconds and the UI explains that scene timing
  can differ between versions.
- Refusal hints exist only in memory, for ten minutes and at most 64 files. They
  are bounded by the authenticated owner/session, catalogue visibility epoch and
  source/file coordinates, including revision/generation when available. Missing
  authority means no hint. Sign-out, context changes, expiry and successful
  playback clear applicable hints. No global blacklist or provider configuration
  is written.
- Ordering can demote a refused copy only among equivalent language preferences;
  explicit selections remain intact. Other copies are not advertised as proven
  playable merely because the catalogue lists them.
- Recovery waits for old-session closure and preserves failed closure references
  for an explicit retry. Existing server admission, provider account leases,
  playback priority, circuits and limits remain authoritative and unchanged.
  Strict cloud closure requires the exact session identifier, `expired` status
  and an integer `gatewayErrors` equal to zero; an exact 404 is an idempotent
  closure. A resolved but incomplete response is not sufficient. The 800 ms
  client cooldown is a delay, not an acknowledgement or account reservation.
- Native phone/TV recovery returns to the same shared selector only after the
  existing exact-session close acknowledgement. The native action uses neutral
  wording for generic terminal errors and does not manufacture a refusal hint.

## Verification status

Evidence at the final emulator check on 4 October 2026, updated at 21:14:35 UTC:

- Application correction: `cfd9482520627fe8e7a62159c7f87062329ee717`.
- Complete contract CI: `ba1ec4ac3c7a0c5e9fda3cb74d728043fa35b7fb`.
- Final instrumented fixture head: `2813c7b9a`.
- Final Android matrix: `37234869687`, all six jobs successful.
- PR 643 merged as `35e76b0b3843d5be85686750d2547de1b9a308ab`.

The diff from the fully checked CI head to `2813c7b9a` is limited to the
instrumentation fixture, its debug-only visible Activity/manifest, and its
JavaScript frame wait. It does not change the release application code. Deployment
and Google Play publication are separate from these validation results.

### Local JavaScript verification — 4 October 2026

The following command completed with **124 tests passed, zero failed**:

```powershell
node --test tests/watch-version-recovery.test.js tests/watch-provider-file-refused.test.js tests/movie-watch-state.test.js tests/mkv-sequential-handoff.test.js tests/vod-playback-matrix.test.js tests/provider-playback-circuit-breaker.test.js tests/playback-refusals.test.js tests/watch-session-handoff-order.test.js
```

`node --check` passed for both edited page modules. The scoped
`git diff --check` reported no whitespace errors. Git's Windows line-ending
normalisation warnings were not test failures.

The regression evidence exercises:

- Exact source/file catalogue lookup, current sibling versions and no media
  resolution while listing them. A failed lookup stays on the error screen with
  an accessible status; a single-file result states that no other version is
  offered in the catalogue.
- Production `App.navigateTo` / `applyPage` ordering plus a conflicting fiche
  intent: an older restore cannot replace the explicit recovery destination.
- Double clicks, a newer playback attempt, navigation, a replaced account object
  and a mutated account identifier while asynchronous work is pending.
- TV version selection, explicit resume, start from zero, cancellation, a
  shorter target file, malicious text labels and rejection of unknown file
  coordinates. Selecting a sibling alone does not play it.
- A failed cleanup preventing a new media resolution, retained failed closure
  identifiers, partial cleanup success, incomplete HTTP 200 expiry receipts and
  idempotent 404 closure. Ordinary best-effort teardown behaviour remains covered.
- Real `WatchPage.play` invocations at zero and 123 seconds with conflicting
  server/local history: the user's recovery choice wins once, and ordinary
  server history applies again on the next invocation.
- Public Edge error sanitisation, ordinary VOD routing, provider circuit guards,
  sequential session handoff, watch-state behaviour and refusal-memory scope.

The coordinator separately reported **119 targeted tests passed**. That run
overlaps these suites; its result must not be added to 124 as a unique-test count.

A subsequent corner-case regression exercised an explicit start at zero, a
typed refusal of that copy and the real Web retry method. It resolved the same
source, file and container at zero, without reading server or local history.
No Web retry behaviour change was needed. The detail-return button identifier
was renamed to avoid colliding with the existing raw-diagnostic CSS security
guard; the security test remained unchanged. The following follow-up command
passed **32 tests**, overlapping the earlier run:

```powershell
node --test tests/consumer-error-sanitization.test.js tests/watch-session-handoff-order.test.js tests/watch-provider-file-refused.test.js tests/watch-version-recovery.test.js
```

### Browser fixture evidence

The coordinator's browser run completed **eight recovery fixture scenarios**
and **four initial native-refusal fixture scenarios**, at a measured viewport
width of **480 CSS px**. There were **zero provider calls and zero native media
launches**. The captured error and explicit-position-choice screens are synthetic
fixture states, not screenshots of a repaired remote film. This is evidence for
the interaction and synthetic closure/selection cases, not proof that any refused
remote file has become playable. The fixture and Android instrumentation are maintained in
`tests/fixtures/provider-version-cards.js` and the existing provider version card
instrumentation suite.

### Complete CI and correction history

The contract run for `ba1ec4ac3` completed at 21:04 UTC with **5,900 tests:
5,873 passed, 27 skipped and zero failed**. The JavaScript receipt is retained in
`.codex-artifacts/refused-version-recovery/ci-green-contracts.log`. The separate
disposable-database gate was also confirmed successful. No SQL assertion count
is claimed without its own detailed receipt.

Earlier checks were not all successful:

- The first broader JavaScript run found four failures: a contract still
  expected the old `openByItem` signature, one expected the old expiry call text,
  and two bulk-close tests detected a new cloned options object across the VM
  boundary. Ordinary close calls now forward the original options unchanged;
  only a local `strict` flag triggers a copy with that flag removed. Keepalive,
  the exact AbortSignal, JWT/device API selection and cancellation checks are
  retained. The signature contract was updated to the exact expanded signature,
  and a new test verifies that strict closure preserves options without mutating
  its caller. The follow-up lifecycle/navigation/closure run passed 61 tests.
- An older audio-label fixture expected a filename prefix to label an untagged
  audio stream. It now requires an unknown track label and, separately, the
  correct language when an exact-file language is supplied. No confidence rule
  was relaxed.
- Native recovery focus was corrected and verified using physical touch events,
  rather than `performClick()`, so one tap on Retry requests one resolution and
  one tap on Other versions closes the player. The visible/enabled, minimum
  target size, focus and exact file/position assertions remain in the test.
- Earlier emulator recovery fixtures were laid out without a visible Activity.
  The final fixture attaches its WebView to a **debug-only, non-exported visible
  Activity**, requires attachment, visibility, window focus and
  `document.visibilityState === 'visible'`, and waits for two animation frames
  with a bounded failure timeout. It no longer treats a fixed short sleep as
  evidence of rendering. The result must still equal `ok` for every requested
  viewport, text scale and locale; the assertions were not removed or weakened.

The debug Activity is excluded from release APKs. Previous failed or pending
emulator attempts are not counted as passes simply because later code passed.
The earlier local `evidence.safe.json` snapshot predates the final matrix and
must not be used as its completion receipt.

### Final Android emulator matrix

Run `37234869687` on head `2813c7b9a` completed successfully in all six jobs:

| Surface | Navigation | Font scale | Result |
| --- | --- | --- | --- |
| Phone | Gestures | 1.0 | Success |
| Phone | Gestures | 1.3 | Success |
| Phone | Three-button | 1.0 | Success |
| Phone | Three-button | 1.3 | Success |
| TV | D-pad | 1.0 | Success |
| TV | D-pad | 1.3 | Success |

The recovery fixture executes its requested locale loops and preserves the
existing assertions for labels, exact choices, cancellation, focus and viewport.
Each of the four phone configurations completed ten tests with zero skipped and
zero failed tests; this per-configuration count is not extrapolated to the TV jobs.
This is an offline interaction and state-transition check. It does not certify
the availability, language, decoder output or smoothness of any remote film.

### Styles and accessibility review

Read-only review of `public/css/main.css` found the recovery controls reuse the
canonical surface, text, accent, radius and spacing variables. Both error and
inline choice buttons have a 48 CSS px minimum height, explicit keyboard focus,
disabled and pressed states. The action grid becomes one column at 480 px;
button text can wrap. The error card scrolls vertically within a viewport and
safe-area bound, while the inline choices remain in the existing scrollable
fiche. The Web Watch/fiche path introduces no additional modal or focus trap;
the native handoff's separate dialog is outside this CSS-only review.

The initial error focuses **Other versions**. The recovery list focuses a
labelled alternative without selecting or playing it; the refusal label uses a
separate class from watch progress so it cannot attract the resume focus rule.
Changing or cancelling the explicit position choice restores the existing list
interaction. Lookup and closure failures are announced through a status region.

The static review and browser fixture are separate from the Android matrix
above; no general WCAG certification is claimed.

## Deployment and publication — to complete

Production Web publication and its post-deployment checks have not been recorded
in this report yet. Do not interpret successful CI or emulator jobs as production
deployment. The native changes have **not been published to Google Play**; the
currently installed Play version must not be presented as containing this work.

The merge commit is recorded above. Record the Web publication/run, served asset verification and
post-deployment interaction result here when they are available. Record a native
release/version and Play status only after that distinct publication occurs.

No production server code, media routes, language proofs or background campaign
configuration is changed by this feature.

### First production verification — 21:17–21:19 UTC

Cloudflare run `37235345278` deployed merge `35e76b0b3843d5be85686750d2547de1b9a308ab` successfully at 21:16:50 UTC. The reloaded production document served WatchPage `48dcb2b48d`, MoviesPage `9af876a24a`, standalone `153ccc9273` and playbackRefusals `29e3aad10e`, while retaining hls.js 1.7.3.

One ordinary UI launch of the exact HIT MULTI-SUB original produced the new refusal screen with all three actions and focus on Other versions. Its closure returned to the exact owned film details without starting another media request. However, the result incorrectly offered no alternatives: the original sits in a separate title group from the ten other catalogue copies. This is a real incomplete recovery path, not a passed end-to-end recovery. Its grouping/identity cause is being investigated; no speculative title match or automatic replacement was made.

### Canonical movie lookup correction

The first real test showed two independent catalogue gaps. Exact lookup stopped at one internal title identifier even when another current owned title had the same verified movie identity. Ten MAX OTT copies also lacked an accepted editorial match. A bounded server RPC now discovers only current owned projections of the same validated movie identity, hydrates through the existing visibility-epoch contract, and returns each projection with its own variants and evidence. A failed or over-limit lookup remains an error. Series lookups, client grouping and playback routing are unchanged.

The endpoint regression set passed 45 tests, including the real CloudAdapter normalization, MediaUtils grouping and MoviesPage exact opening. It preserves source aliases, selected file, container and per-file audio, with no media resolver invoked. The isolated PostgreSQL 17 fixture passed 30 assertions on modeled hydration and scope; no customer rows or network were used, and its container was removed. A real read-only production benchmark and canary remain required before deployment.

The ten MAX OTT associations passed the existing editorial matcher using exact poster evidence, confidence 0.923, movie identity 1060046 and year 2025. They are separate editorial corrections, not language identifications or proof of media availability. The differing-poster KU item was excluded.
