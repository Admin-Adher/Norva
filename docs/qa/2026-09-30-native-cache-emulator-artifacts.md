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
