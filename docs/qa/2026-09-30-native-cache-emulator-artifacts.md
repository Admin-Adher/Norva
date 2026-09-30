# Native private-cache emulator proof artifacts

The Build workflow now assembles and publishes both the Android TV application
and its instrumentation APK from the same checkout. Artifact names are
`Norva-AndroidTV` and `Norva-AndroidTV-instrumentation`; the phone equivalents
already exist. Select all four artifacts from one successful Build run and
verify its `head_sha` before installing them on the server emulators. The test
artifacts have one-day retention and fail upload if absent.

The shared `NativeMediaCachePlaybackInstrumentedTest` previously skipped whenever
`files/native-cache-qa.json` was missing. No existing argument made that proof
mandatory. It now accepts the explicit instrumentation argument
`norvaRequireMediaCacheFixture=true`. In that mode, an absent fixture fails before
opening the player. An unrecognized value fails; omitting the argument preserves
the ordinary CI assumption skip. The argument carries no credential or URL.

Run the existing live method on each authorized emulator with arguments:

```
-e class tv.norva.playback.NativeMediaCachePlaybackInstrumentedTest#realPrivateCacheRendersSeeksRenewsAndPreservesPause
-e norvaRequireMediaCacheFixture true
```

The existing short-lived fixture must be supplied through the target app's
private storage by the authorized runtime operator. It must never enter an APK,
CI environment, log or uploaded artifact. This change does not create a fixture,
session, token or provider request. The existing playback, rendered-frame,
renewal, seek, 2× and pause assertions remain unchanged.

A test-only matrix exercises optional absent/present fixtures, required
absent/present fixtures, and invalid argument values. It does not represent a
real cache replay. Compiling the instrumentation and replaying with an actual
authorized fixture remain required before claiming runtime validation.

Local validation: 48 adjacent Android player/session/build contract tests passed,
0 skipped, and `git diff --check` passed. No local JDK/Gradle was available, so
the new Java matrix has not been reported as executed locally. The exact-head
Build must compile both instrumentation APKs before server emulator replay.
# Follow-up from the first automatic QA run

Build `36741810087` succeeded for `8b5d5337`, publishing all four application and
instrumentation APK artifacts. The separate six-configuration emulator run
`36741809603` passed both TV and both gesture configurations; it failed two
existing first-frame cases on phone three-button / 1.0 during a documented
Android network loss, and the first IME assertion in ContextualLanguage on
three-button / 1.3. The new fixture requirement matrix itself passed.

The first-frame precondition change is described separately in
`2026-09-30-first-frame-network-precondition.md`. The IME failure has no proven
root cause yet: the log shows a WebEditText InputConnection but no IME show
request. Failure-only native focus/input state and a screenshot are now recorded
after the original visibility deadline. No touch retry, forced keyboard display,
assertion relaxation or new playback attempt was added. Java compilation and
the next automatic QA execution remain pending for these follow-up changes.
