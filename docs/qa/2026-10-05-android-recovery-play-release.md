# Android refused-version recovery — Play release

## Scope and state

Adrien explicitly requested completion of the Android publication after the Web
recovery flow was delivered. This release contains the native **Other versions**
action and preserves the prior playback and MPEG-4 decoder fixes. It does not
repair a remotely refused or corrupted media file.

At preparation, Play Console showed Mobile 1.3.31 (45) and TV 3.8.24-hybrid (37)
in production review, with no higher version codes. New releases are Mobile
**1.3.32 (46)** and TV **3.8.25-hybrid (38)**. Store submission/publication is
recorded separately below; a successful build is not a published release.

## Integrated code and verification

- Release commit: `8589944dca85e11f2600d71b680701a338d1a37b`, PR647.
- Integrated in main as `20699884da5b28be949da64ae473da31a15cf155` after
  all nineteen latest check-runs succeeded, including signed bundles, Android
  and Windows packages, contracts and the six emulator configurations.
- Only the two Gradle version pairs and their contract expectations changed.
- Nineteen focused release-contract tests passed with no failures or skips.
- Native/UI application sources match the final recovery emulator head
  `2813c7b9a6ffb964488759ad89b960b33c9b5eee`; six configurations passed in run
  `37234869687`. No provider media was opened during release preparation.
- Signed workflow `37240315836` completed successfully on the release commit at
  2026-10-04 22:32:41 UTC. Both jobs run JVM tests and `bundleRelease`.
- Downloaded GitHub artifact ZIP SHA-256 values match their API digests.

The version bump also triggered matrix `37240316615`. Its first attempt passed
five configurations. Phone three-button/font 1.0 failed one timing assertion in
`FirstFrameFixtureInstrumentedTest.ownedHttp460RecoversWithoutRepeatingTheRefusedRequest`:
1,719 ms observed against a 1,500 ms limit (XML: 76 tests, 70 passed, one failed,
five skipped; the Gradle progress counter is not used as a unique test count).
This is distinct from the previously successful recovery matrix and is not
silently erased. No threshold or product code was changed; a single targeted
rerun of the failed job was used to check recurrence. All nine
ProviderVersionCards/ResumeRecovery tests passed even in that first attempt.
The failing measurement spans the first loopback GET through the main-thread
fresh-stream broadcast receiver. Logcat shows substantial app/SystemUI frame
delays around the event; contention is a lead, not a proven root cause.

The single targeted rerun succeeded at 22:58:17 UTC (job `111550323318`) on the
same release commit. The other five successful configurations were not rerun.
The initial failure remains in `emulator-attempt1-failure.safe.json`; this result
does not establish a universal timing guarantee or remove the historical failure.

## Binary checks — 2026-10-04 22:34:52 UTC

| Bundle | Package | Version | SHA-256 |
|---|---|---|---|
| Phone | tv.norva.phone | 1.3.32 (46) | f9c3c33e09fe6d80a4c9dc0665da031353affbf5cd57fdba49f4566e4255b18c |
| TV | tv.norva.tv | 3.8.25-hybrid (38) | d84148c7278a7f1638a66e3740ab589909c296644bf3952ae967359827f8230e |

Cryptographic CMS signatures and all 1,711 phone / 995 TV payload digests were
verified. The upload certificate matches the prior signed bundles. The four
FFmpeg ABI libraries are byte-identical to the approved AAR and prior release.
`MovieVersionRecoveryPolicy` is a defined DEX class in both bundles; the debug
fixture is absent from DEX and manifest and neither bundle is debuggable.

The phone Firebase resources and RevenueCat configuration are nonempty and
identical to the previous signed release; no key values were printed. Both
complete semantic manifests are unchanged except version code/name. Phone has
the same fifteen permissions/two features; TV has seven permissions/two features.

The local verifier uses Python ZIP/SHA-256, AOSP manifest protobuf parsing and
Windows .NET SignedCms. No local JDK/bundletool was found. These targeted checks
are not a full `bundletool validate` replacement. Google Play's upload validation
is recorded with the submission below.

Local receipts and bundles are retained under
`.codex-artifacts/android-recovery-play-20261005/`. No signing credentials are
stored in the report. Production source configuration, provider leases and the
permanent language campaign are unchanged.

## Play submission

TV bundle 38 was accepted by Play. Its review page showed no blocking error,
unchanged support for 3,064 TV devices and only the existing missing mapping/native
debug-symbol warnings. Notes were entered for all nine configured store locales.
The release was saved for a full rollout in the existing countries. Submission
restarted the preceding review as explicitly indicated by Play. The publishing
page now lists only TV 3.8.25 (38) under changes in review, with automatic quick
checks still in progress. This is not store availability.

Mobile bundle 46 was likewise accepted with no blocking errors, the same two
mapping/native-symbol warnings and no removed supported devices (13,329 phone,
6,890 tablet, six TV, five car, 77 Chromebook and one XR entries in Play's device
catalogue). These are device-model compatibility counts, not active users or
runtime performance evidence. Its nine store locale notes were also saved.

At 2026-10-04 22:42:19 UTC (5 October 00:42 Paris), both new releases appeared
under **Modifications en cours d'examen**, with a full rollout requested.
Google's quick checks were still running; the page states the submissions are
forwarded to review when those checks finish. Each explicit submission restarted
the previous release's review, as Google warned. Versions 45/37 are superseded
by the release requests 46/38, which include their previous fixes.

Managed publishing was already disabled and has not been changed. There was no
change to countries, signing credentials, permissions, billing or Firebase.
Neither new version is claimed available to users yet. Continue following the
Google decision and actual production availability; do not re-upload/restart
the review without a demonstrated need. Keep the permanent language maintenance
active. Local screenshots: `mobile-submitted.png` and `tv-submitted.png`.

At 22:51:38 UTC, TV's quick-check progress panel had disappeared and the page
stated the changes were in review, with TV 3.8.25 (38) still listed. No store
publication was shown. The readable screenshot is `tv-review.jpg`.

At 22:53:20 UTC, Mobile's quick checks had also finished and the page stated
Mobile 1.3.32 (46) was in review. The readable screenshot is `mobile-review.jpg`.
The existing hourly maintenance heartbeat now includes follow-up of both
Google decisions and actual availability; it remains active for audio maintenance
after this publication follow-up completes.
