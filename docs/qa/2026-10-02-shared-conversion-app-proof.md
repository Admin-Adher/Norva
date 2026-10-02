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

The follower's approximately three-second start is inferred from click time,
observation time and played position; it is not an instrumented first-frame
measurement. Two profiles of one ordinary account prove the real UI path, not
independent-owner sharing.

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

## Acceptance still pending at this commit

- Deploy the correction and replay simultaneous UI playback, close-primary,
  additional-account mobile launch and close-last-viewer cleanup.
- Native playback of this real MPEG-4/AC-3 MKV failed in the initial attempt;
  do not relabel its `direct` session as successful playback or a shared-cache hit.
- M3U in-progress work is deliberately scoped to owner/source. Completed R2
  objects and in-progress producer attachment are distinct mechanisms.
- Existing six native complete-cache replays and synthetic/API isolation tests
  remain supporting evidence, not substitutes for this application replay.
- No claim of 20/100 concurrent real shared conversions is made here.
