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
with **zero provider calls**. This is evidence for the implemented interaction
and synthetic closure/selection cases, not proof that any refused remote file
has become playable. The fixture and Android instrumentation are maintained in
`tests/fixtures/provider-version-cards.js` and the existing provider version card
instrumentation suite.

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

This static review and the browser fixture do not certify Android font-scale,
navigation-bar or TV D-pad behaviour. CI, emulator runs and deployment remain
pending in this draft and require their own recorded outcomes before closure.

No production server code, media routes, language proofs or background campaign
configuration is changed by this feature.
