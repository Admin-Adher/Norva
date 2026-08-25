# Provider Access Phone — Google Play production publication proof

Date: 2026-08-25

Status:

```text
PHONE_1_3_9_GOOGLE_PLAY_PRODUCTION_PUBLISHED
PHYSICAL_DEVICE_FCM_DEEP_LINK_SMOKE_PENDING
```

## Published release

The authenticated Google Play Console reports the exact release submitted in
the preceding proof as published and available on the Production track:

```text
package             tv.norva.phone
submission          6
release             8
release name        Norva Mobile 1.3.9 (22) — Access readiness
version name        1.3.9
version code        22
status              Disponible sur Google Play
rollout             100%
available users     7
countries/regions   177 / 177
compatible devices  20,182
minimum Android     23
verified UTC        2026-08-25T14:04:07.4618333Z
```

The release artifact remains the signed AAB produced by GitHub Actions run
`32795287248` from commit `b30f3f7e98afd45bfaec7f423d70ce3df069fbd1`:

```text
bytes     13785473
SHA-256   6ebe1721f4de63934a7b7fb277a43f6f6b7c31716185507ebd9cfb791e21db01
```

## Console evidence

The Play submission detail changed from `En cours d'examen` to `Publiée` and
states that the update is published. The Production release detail independently
reports `Disponible sur Google Play`, `100 %`, version `22 (1.3.9)` and
availability in all 177 selected countries/regions.

The private local evidence bundle contains:

```text
GOOGLE-PLAY-SUBMISSION-6-PUBLISHED.png
bytes     16132
SHA-256   ba5d698992d7373b0dc888c167e48d2af1094bd7b2e3cfdde404af0760a0db66

GOOGLE-PLAY-PUBLICATION-PROOF.txt
bytes     1017
SHA-256   8bfe7372f81ffc2f5839310953ef33eb100896dc1140e5a488c91757284ff65a
```

These private artifacts are deliberately not committed because they capture an
authenticated Console surface. The immutable hashes preserve their linkage to
this public repository proof.

## Remaining channel gate

Publication closes the Play-distribution prerequisite only. Push remains OFF
until a physical phone installs the Play-distributed `1.3.9 (22)` build and a
real FCM data message proves the fixed route:

```text
Settings -> Sources -> Provider access
```

An emulator-only launch, an ADB intent injection or a locally signed APK does
not satisfy that acceptance gate. At the time of publication proof, ADB exposed
only `emulator-5554`; no physical device was connected.

Provider Access automatic detection, email and push remain independently OFF,
and this publication does not alter the cache-epoch observation boundary or the
production rollout stage.
