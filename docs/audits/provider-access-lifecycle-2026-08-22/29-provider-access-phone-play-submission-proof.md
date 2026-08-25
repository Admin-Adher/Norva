# Provider Access — Android Phone Play submission proof

Date: 2026-08-25

Status:

```text
PHONE_1_3_9_SIGNED_AAB_VERIFIED
PHONE_1_3_9_PLAY_SUBMISSION_ACCEPTED
PHONE_1_3_9_PLAY_QUICK_CHECKS_PASSED
PHONE_1_3_9_GOOGLE_REVIEW_PENDING
PHYSICAL_FCM_DEEP_LINK_SMOKE_PENDING
```

## Artifact identity

The signed Phone artifact was produced by GitHub Actions run `32795287248`
from release commit `b30f3f7e98afd45bfaec7f423d70ce3df069fbd1`:

```text
artifact name  Norva-AndroidPhone-release-aab
file           app-release.aab
package        tv.norva.phone
version name   1.3.9
version code   22
bytes          13785473
SHA-256        6ebe1721f4de63934a7b7fb277a43f6f6b7c31716185507ebd9cfb791e21db01
```

The downloaded artifact was hashed again immediately before upload and matched
the CI proof exactly.

## Google Play validation

Google Play accepted and parsed the uploaded bundle as:

```text
22 (1.3.9)
minimum SDK 23
target SDK 36
screen formats 4
ABIs 4
required features 5
```

Compatibility comparison against Phone `1.3.8 (21)` reported zero lost and
zero newly introduced devices for every listed form factor:

```text
phone       13323 compatible / 0 lost
tablet       6776 compatible / 0 lost
television      4 compatible / 0 lost
car             2 compatible / 0 lost
Chromebook      72 compatible / 0 lost
Android XR       1 compatible / 0 lost
```

Google estimated a 10.5 MB fresh installation and a 2.16 MB update.

## Validation messages

The review page contained no blocking error and two non-blocking warnings:

1. no R8/ProGuard deobfuscation file;
2. no native debug-symbol archive.

The first is expected for this build because the release contract explicitly
sets `minifyEnabled false`; no mapping file exists. The native FFmpeg audio
decoder is supplied as a prebuilt AAR and the release workflow does not produce
a separate symbol archive. Neither warning changes device compatibility or
prevents Play review.

## Release record

```text
release name  Norva Mobile 1.3.9 (22) — Access readiness
track         Production
rollout       complete rollout, 100%
countries     all currently targeted countries
managed pub   disabled
active installs targeted 7
```

The notes deliberately describe readiness rather than claiming server-side
Provider Access activation:

```text
Prepares the app for external catalog access reminders.
Adds a secure fixed route from reminder notifications to source settings.
Improves source settings, accessibility, and reliability.
```

## Submission acknowledgement

The owner explicitly approved the final review submission after the Console
showed that managed publishing is disabled and approval will therefore publish
the 100% rollout automatically.

Google Play recorded:

```text
submission ID  6
source         Play Console
saved at       2026-08-25 15:21 Europe/Paris
change count   1
track          Production
state          En cours d'examen
```

The post-submission quick checks then completed without introducing an error or
an additional warning. The publication overview replaced the progress meter
with the stable review message `Vos modifications sont en cours d'examen`.

The release is not yet claimed as published. Completion requires Google to
accept the submission and the Production release page to identify version 22 as
available on Google Play.

## Remaining runtime proof

The required data-only FCM smoke is intentionally not inferred from the Play
submission. Only an emulator was connected at submission time; no physical
Android device was available through ADB. After Play publication and internal
Provider Access activation, a real opt-in device must prove:

- receipt of a Provider Access notification;
- deduplication under retry;
- no credential-bearing payload;
- fixed navigation to `Settings -> Sources -> Provider access`;
- Back and foreground/background behavior on the shipped build.
