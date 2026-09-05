# Selection: two-channel 720p input canary

This change is independent of the Selection publication gate. It does not filter
imports or delete existing items. The exact owned TV5 Monde Info / Free-TV and
FilmRise Free Movies / Roku catalogue coordinates can use a one-video HLS master
for automatic cloud web Gateway playback. Source/media identifiers and the
existing provider-account, entitlement, generation and session guards stay intact.

The Gateway currently maps its first video stream. The public masters ordered
TV5 at 480x270 and FilmRise at 384x216 first. The two new masters retain the
original global and EXT-X-MEDIA tags, and only the reviewed 1280x720 STREAM-INF.
TV5's separate French audio is essential; substituting its video playlist alone
would remove the audio. FilmRise retains its English CC1 declaration. All media
references are existing provider URLs, made absolute without changing parameters.
No audio/video playlist, segment, discontinuity or key declaration is rewritten.

## Runtime conditions

`selection-live-rendition.mjs` is called only from normal session creation via
the owned-row resolver. It requires the deterministic Selection source and exact
feed, website, external ID, media key and original target URL hash. It checks the
resolved master URL and complete master body hashes, then the published canary
asset body hash. A changed, missing or inaccessible master/asset retains the
original input. Checks use the existing bounded response reader: 4 seconds total,
at most 4 GETs, 64 KiB per response, manual redirects, and a 15-second shared cache
for each of the two entries. No retry loop or new playback session is created.

The new GETs allow only the exact reviewed HTTPS provider hosts; the asset GET
allows norva.tv. No credentials, custom authentication headers, private literal
addresses, arbitrary hosts or ports are accepted. This is a fixed-provider allowlist,
not a new general-purpose DNS/SSRF service. Provider DNS and normal TLS resolution
remain those of the existing runtime. The output remains Gateway playback: it
does not grant direct-browser CORS access or bypass encryption/territory controls.

Xumo, personal sources, VOD, native clients, explicit direct/relay/conversion modes
and explicit rendition/track choices are excluded. A changed master does not
silently choose another resolution; it requires renewed review and asset hashes.
The real audio/video/subtitle `StreamIndex` selectors and the `TrackIndex` aliases
are checked in camelCase and snake_case. Index zero is explicit; negative, null,
empty and `auto` values keep the automatic path.

## Exact assets

| Asset | SHA-256 |
| --- | --- |
| `public/catalog/quality-tv5-info-720.m3u8` | `d1db551a1f1c376ae139389da45e00e20336a22245603c5475ab8f6b3736183f` |
| `public/catalog/quality-filmrise-roku-720.m3u8` | `8941af5ebfda446b250c57326a945e23cd1dd14fa069e5dd55c168b14386bac8` |

Narrow `.gitattributes` rules keep these bytes LF on Windows checkouts. The
resource-subset proof is `.selection-proof/tv-premium-audit/quality-assets-proof.json`;
the tests independently check asset bytes, resource URL hashes, every global/audio/
caption tag, and the exact selected STREAM-INF against sanitized real masters.

## Evidence and release order

On 2026-09-05 the selected TV5 rendition decoded H.264 High 1280x720 (360 frames,
12.012 seconds), with its separate French AAC LC 48 kHz stereo audio (563 frames,
12.010667 seconds). FilmRise decoded H.264 High 1280x720 (360 frames, 12 seconds)
and muxed AAC LC 48 kHz stereo audio (563 frames, 12.010667 seconds). FilmRise's
ordinary AES-128 identity keys were public HTTP 200 responses, with no added auth.
These short upstream samples do not establish individual Norva playback or
long-duration, territorial or key-lifetime reliability. Evidence files:
`tv5-decoded-evidence.json` and `aes128-canary-evidence.jsonl` in that proof directory.

1. Publish and GET-verify only the two Pages assets, including the exact hashes.
2. Deploy the independent quality Edge overlay containing `norva-playback/index.ts`
   and `_shared/selection-live-rendition.mjs`. Keep the existing production
   `discovery-sources.mjs`; do not include the empty publication manifest/gate.
3. Through normal Norva UI, play the two existing Selection coordinates. Verify
   1280x720 output, audible audio, stability and the actual Gateway input. Do not
   treat the upstream 12-second decodes as this browser acceptance proof.

For rollback, restore the prior Edge overlay and keep the public assets available
until any already running inputs have ended. An unavailable asset triggers the
original-input fallback for new sessions after at most the 15-second cache;
removing assets is not required for rollback.
Neither route changes nor rollback require a catalogue sync or database mutation.

Local verification: 58 tests passed (12 dedicated quality tests plus Selection
import, public-direct and publication-gate regressions); `git diff --check` passed.
No deployment was performed by this subtask.
