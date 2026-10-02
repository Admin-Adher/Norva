# Shared conversion — real application replay, 2 October 2026

## Scope and initial production evidence

This replay uses the published Norva application, its normal catalogue/search/
Play buttons, real provider media and existing entitlements. It does not inject
a playback response or substitute generated media. Timestamps below are UTC.
The ordinary October 1 QA account is not internal. Its second `QA partage`
profile was created through the normal profile interface within the Plus limit.

Initial runtime: Gateway 171 on both routes, image
`sha256:8c5ec2976d5de70d2060cf386d676e2105b844d2818c4915bb619e8bbdd361f3`;
Edge 84. Global cache/singleflight/live-join flags were true; admission enforced.
No producer or viewer attachment existed before this replay.

Real title: **Guerreiros da Virtude**, Norva Selection, exact MKV catalogue
profile with MPEG-4 video, Portuguese AC-3 and English MP3 audio, 6157.44 seconds.

| Observation | Evidence |
| --- | --- |
| First web Play at 10:29:05.924 | Normal provider conversion; first demand not admitted to shared cache |
| Restart from zero using player button | Second demand admitted (`repeated`), producer created 10:35:44.978 |
| Second profile Play at 10:38:59.892 | Application creates live-join session at 10:39:01.193, server marker `__norvaMediaCacheLiveJoinV1`; Gateway `liveJoinAccepted=1`, `activeViewers=1` |
| Both players at 10:39:27.961 | Producer position 216.880 s, follower 24.990 s; both unpaused, readyState 4, decoded dimensions 1280×720 |
| Primary player closed through Films at 10:39:51.438 | Follower continues; at 10:41:43.645 follower 160.670 s, unpaused/readyState 4; primary has no active video |

The persisted first-frame event is at 10:39:01.776883, with player-measured
TTFF **948 ms** (the click preceded this by 1.885 seconds). Two profiles of one
ordinary account prove the real UI path, not independent-owner sharing.

## Defect revealed by an additional real mobile launch

The user connected the physical phone, installed Norva **1.3.29 (43)**, then
signed into their internal account. At 10:42:26, normal search → detail → Play
launched the same title. At 10:42:27.564, the other owner's Gateway producer was
aborted; the web follower displayed a playback error. This was **not** an
automatic expiry after closing the first viewer: the stop coincides with the
new mobile session and the destructive affinity drain in its creation path.

`preemptProviderLanguageValidationTransports` called
`/sessions/stop-provider-affinities`, an endpoint intended to stop all matching
sessions/raw pumps for account deletion. Public M3U URLs can share a transport
affinity despite different owner-scoped playback identities. Thus a new viewer
could terminate another owner's active conversion, including joined viewers.

The correction introduces an authenticated **auxiliary-only** drain endpoint.
Viewer startup uses only this endpoint and requires its explicit scope and
drain attestation. Sessions/raw pumps are preserved; metadata probes and strict
language brokers still drain. Account deletion keeps the full stop endpoint.
Rollout order is Gateway 172 on both routes, then Edge 85. Older Gateways cannot
silently accept an overbroad drain response through the new endpoint.

Focused tests exercise the real helper with primary/joined/raw viewers,
successful and failed auxiliary drain, unrelated affinity and full account
deletion. Initial focused result: 50 passed, one integration fixture skipped.

## Deployed correction and replay

PR [572](https://github.com/Admin-Adher/Norva/pull/572) merged as
`518cfd9d46a87af7ad2f193887401fd3642d011e`. CI run `36998254897` passed
cloud contracts and phone, TV and Windows builds. The regression suite reports
**5,663 passed, 27 skipped, zero failed**; these are automated cases, not real
streams. Focused operator safety tests: 9 passed.

- Both Gateways run **172**, immutable image
  `sha256:51af8bd887840377b6c4459150e34d93079cebd6b116afcbbe2c35e6e45cc9bf`,
  runtime source `990d832b7a39dc5d146616f6bd457690e89caa36` (the later
  pre-merge commit only corrected test version expectations).
- All **78 source files** match the staged repository source on both routes.
- Pilot receipt: `gateway-reference-rollout/20261002T110014662038Z`.
  Main receipt: `gateway-reference-rollout/20261002T111016531551Z`.
  Receipts are private under `/home/adrien/.norva/`; environment and mounts
  were preserved. Main Compose now resolves to the same immutable image.
- Main deployment handed off one signed, deferred storyboard checkpoint on
  the unchanged persistent volume. No running extraction was interrupted.
  Its checkpoint digest was unchanged after replacement. The bounded provider
  quiesce lease ended with the old process; no cron was disabled.
- Both Edge replicas run **85**, with identical playback source SHA-256
  `5d7226bc9aa98211ac2ea4d7ec2efc9e5dd14a289835d2999d2245710346f225`.
  The prior file was preserved privately for rollback; container configuration
  and mounts were unchanged.

The post-fix replay again used normal UI buttons and the same real MKV:

| UTC | Result |
| --- | --- |
| 11:14:49.986890 | Producer created from the QA partage profile's Restart from beginning button |
| 11:15:10.694035 | Test client profile joins it, with persisted live-join marker |
| 11:15:11.338106 | Follower first-frame event, **1,820 ms** TTFF |
| 11:15:25.915 | Both videos advancing: 29.084 s and 15.112 s, readyState 4, decoded width 1280 |
| 11:15:49.183 | Original viewer closed through Films; follower kept open |
| 11:16:03.363318 | Different owner's Android direct session created from its normal Resume button |
| 11:16 onward | Producer remains alive and follower remains attached: the destructive cross-owner stop does not recur |
| 11:17:17.237 | Follower waiting at 121.941 s; this run was not stall-free |
| 11:18:54.912 | Follower resumed automatically, position 171.885 s |
| 11:20:12.839 | Follower still playing at 215.089 s, readyState 4, decoded width 1280 |
| Final UI close at 11:20:24.042, then server check | Both Gateways: zero viewer sessions, zero raw pumps, zero joined viewers; all six sessions from this replay expired |

The producer remained in provider-read with bytes advancing during the wait;
this is different from the pre-fix producer abort. It does not establish why
delivery was too slow. Cumulative producer attachment/abandon counters are not
active-viewer counts.

## Remaining limits and failures

Follow-up: the native XVID recognition cause has since been confirmed and a
correction integrated and submitted in phone 1.3.30 / TV 3.8.23. See
[the native fix and later web replay](2026-10-02-xvid-native-playback-fix.md).
The physical provider-film replay on that new phone version is still pending.
The observations below describe the earlier 1.3.29 run.

- **Android 1.3.29 (43) still fails on this MPEG-4/AC-3 MKV.** After the fix,
  the native player reported `playback_error / native_terminal` at
  11:18:06.232603, position zero, with no first frame. The UI showed the
  reconnect-failed message. The player was closed with Back. A ready direct
  grant is not successful playback or a shared-cache hit.
- The native startup-progress watchdog explicitly terminates after its bounded
  startup limit without entering the usual recovery ladder. That code path is
  consistent with the observations; this report does not claim a decoder or
  provider root cause, or that a native fix has been implemented.
- A nonzero resume on another profile uses the single-provider-slot replacement
  path and superseded the existing session at 11:12:38.600838. The successful
  join used zero-offset playback. Concurrent arbitrary-offset resume is not
  certified by this test.
- M3U in-progress work is deliberately scoped to owner/source. Completed R2
  objects and in-progress producer attachment are distinct mechanisms.
- Existing six native complete-cache replays and synthetic/API isolation tests
  remain supporting evidence, not substitutes for this application replay.
- No claim of 20/100 concurrent real shared conversions is made here.

**Conclusion:** the real ordinary-account web joining path, survival of the
original viewer's departure and protection against another owner's startup are
now demonstrated. The phone's actual playback of this title and stall-free
continuity remain open; the broad commercial objective is not marked complete.
