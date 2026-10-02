# Legacy Xvid MKV playback: native correction and production submission

Date: 2026-10-02. Follow-up to
[the real shared-conversion replay](2026-10-02-shared-conversion-app-proof.md).

## Confirmed failure and cause

`Guerreiros da Virtude` from Norva Selection failed before its first image on
the physical phone running **1.3.29 (43)**. The native log reports
`Unknown FourCC. Setting mimeType to video/x-unknown`; the audio decoder
receives AC-3 data. The bounded startup watchdog eventually closes playback.

The actual provider file was checked with bounded Range reads through its
credential-free public Selection URL,
without downloading or committing the film. It is a 1,799,399,344-byte MKV,
6,157.44 seconds long, with 1280x720 MPEG-4 Part 2 video, Portuguese AC-3
and English MP3 audio. Its Matroska video track declares
`V_MS/VFW/FOURCC`, with **XVID** inside a 40-byte BITMAPINFOHEADER.
CodecPrivate has no extra video initialization data; MPEG-4 VOL data occurs
in the video packets. Media3 1.5.1 recognizes other VFW aliases but maps this
XVID tag to VIDEO_UNKNOWN. The phone exposes an MPEG-4 Part 2 decoder.

This establishes the native format-recognition defect. It does not establish
the cause of the earlier web buffering interval.

## Integrated correction

PR [574](https://github.com/Admin-Adher/Norva/pull/574) merged as
`1b7f7ae1a526993013139bc3b41e96222e4da5bc`.

`MatroskaFourccExtractor` decorates the existing Matroska extractor in the
shared phone/TV extractor factory. A bounded, in-band header peek identifies
the exact video track and XVID/DX50 aliases, then maps only that track's
unknown format to `video/mp4v-es`. Unsupported or malformed declarations
remain untouched. Audio, video samples, byte offsets, timestamps, the seek
map and the direct network path remain under the normal extractor.

The lookup uses the existing stream and opens no auxiliary provider
connection. Transient header-read failures reset the peek position and allow
recognition on retry. Native playback does not acquire an HLS conversion for
this correction.

## Verification

- Focused JVM cases cover exact codec/track admission, truncated/malformed
  headers, duplicate tracks, preserved sample data and seek maps, and a
  transient read followed by retry. The signed phone/TV release workflow
  [37004879496](https://github.com/Admin-Adher/Norva/actions/runs/37004879496)
  ran the JVM suites and both release builds successfully.
- Build and cloud contracts on the final test revision passed in
  [37006064358](https://github.com/Admin-Adher/Norva/actions/runs/37006064358).
- Instrumentation
  [37006059235](https://github.com/Admin-Adher/Norva/actions/runs/37006059235)
  passed all **six matrix jobs**: phone API 35 with gestures and three-button
  navigation at font scales 1.0/1.3; TV API 34 at font scales 1.0/1.3.
  Phone runs focus on the two new Xvid tests; TV runs its full suite, including
  **three explicit fixture skips**. The checked TV report has 18 cases,
  0 failures, 0 errors and 3 skips.
- Both fixture layouts produce real video and audio in the actual native
  PlayerActivity: one with codec initialization data and one with the exact
  provider's 40-byte-only layout and in-band VOL. Tests verify cold resume
  beyond the first cluster, fresh rendered video after seeking, and closure
  through the platform Back key. These media are generated test patterns;
  they are not the provider's film.
- These results do not certify the unrelated full phone WebView suite.
  [37006064482](https://github.com/Admin-Adher/Norva/actions/runs/37006064482)
  passed both gesture jobs and both TV jobs, but its three-button jobs ended
  in the existing portrait/landscape catalogue test before completing the
  expected 69 cases. An earlier broad run also crashed there. A
  separate startup timing assertion also failed at 2,197 ms against its
  2,000 ms bound. Neither was hidden by weakening its assertion.

The final test-only commits change instrumentation, not production source.
The signed bundles built from `06cc48dd047dc299899b570643b22059ec2a81fa`
contain the same production code as the merged correction.

## Real web replay

The ordinary QA account used normal Norva UI controls and the actual film:

| Path | Measured result |
| --- | --- |
| Resume at 226 s, existing broker lane | Server startup 13,103 ms; first segment 11,657 ms; decoded 1280x720 picture and correct resume |
| Restart from zero, shared conversion producer | Server startup 10,311 ms; FFmpeg ready 5,029 ms; bounded MKV input pump and VAAPI output active |
| Second path after approximately 23 minutes | Video position 1,323.34 s, readyState 4, unpaused, decoded width 1280; buffered to 1,443.95 s |

No further buffering interval or console warning was observed in the sampled
checks of this second run. This is not a claim of continuously measured
stall-free playback under all conditions. Server startup timings are not
browser first-frame timings.

At 1,395,211 ms elapsed, the bounded producer had received 454,407,746 bytes.
It spent 34,806 ms in provider-read and 1,359,692 ms in downstream-write, with
zero reopens and zero planned range continuations. Consequently, average
bytes divided by total session duration would mostly measure downstream
backpressure, not provider download speed. The earlier web wait remains a
recorded event; these later observations do not prove its root cause.

Private sanitized progression receipts are retained under
`/home/adrien/.norva/vfw-mpeg4-fix-20261002/web-progress.jsonl`.

## Public provider route: measured bottleneck and global correction

A separate input-speed comparison used the same public file, user agent and
2 MiB range from the Gateway host:

| Route | Measured result |
| --- | --- |
| Direct | HTTP 206; all 2,097,152 bytes in 482 ms; content signature and XVID header checked |
| Configured proxy | HTTP 206; only 685,808 bytes before the 15,192 ms timeout |

An earlier input pump also spent 65,025 ms waiting on provider reads and only
28 ms writing downstream while receiving 14.52 MB. These results identify an
input bottleneck on this route. They do not attribute every historical web
stall to it.

PR [575](https://github.com/Admin-Adher/Norva/pull/575), merged as
`1801ebc4479d213e64f2e3082016afba5e054e2c`, extends the existing direct route
to MKV files on the exact public Selection host and `/content/filmes/` path.
The admission remains HTTPS only, with no query, fragment, credentials or
nondefault port. Private provider routes and operator overrides are preserved;
the separate Oracle public-bucket admission remains MP4 only.

The focused route tests passed 128 cases, with one explicit fixture skip.
Build [37008269768](https://github.com/Admin-Adher/Norva/actions/runs/37008269768)
passed all jobs. Gateway 173 was deployed to both routes, then superseded by
174 below, which includes this correction. The range receipt is private at
`/home/adrien/.norva/vfw-mpeg4-fix-20261002/route-speed.json`.

Normal UI playback after that change produced these separate measurements:

| Path | Result |
| --- | --- |
| Restart from zero | Server startup 1,080 ms; first segment 363 ms |
| Another cold start, ordinary QA profile | Server startup 803 ms; browser first-frame event 5,663 ms |
| Single-viewer follow-up | Picture still decoded at position 1,044.953 s (about 17 min 25 s); readyState 4; unpaused; buffered through 1,165.952 s |

The last result is a sampled observation, not a continuous frame/stall
certification. Private playlist progression checks every five seconds showed
the video/audio windows moving together; see
`/home/adrien/.norva/vfw-mpeg4-fix-20261002/web-window-progress.jsonl`.

## Real application sharing exposed an invalid cold join

Two profiles of the ordinary QA owner used the normal web interface. The
first created one conversion producer; the second attached to it, with a
1,009 ms first-frame event at position 37 s. Both later waited for data at
approximately 168-170 s. No captured console warning explained that interval.

The retained-output policy excludes this long, large film: it exceeds both
the 768 MiB input limit and the 3,600-second duration limit. The producer uses
a rolling HLS window. Inspection established that the cold-join admission
accepted a contiguous graph even after its beginning was gone. The application
coordinator's supported join is a zero-offset start, so this was an invalid
admission. The evidence does not establish every cause of the subsequent
two-profile wait.

PR [576](https://github.com/Admin-Adher/Norva/pull/576), merged as
`8e2679d4bf192cfb44c6e94aca6930730299e34b`, now requires media sequence zero
and the original segment-zero filename in every video/audio playlist. A graph
without that prefix receives HTTP 425 / `vod-prefix-not-retained` before any
viewer token is issued. The existing application rollback permits independent
playback. Graphs retaining their original beginning remain eligible. This
change does not add per-viewer pacing or enlarge the retention budget.

Verification for this correction:

- **149 focused tests passed, two explicit tool-fixture skips.** Cases cover
  independently rolled video/audio playlists and a forged zero media sequence
  whose first file is segment 17.
- An isolated actual-FFmpeg integration with a generated 120-second MKV,
  bounded output enabled and ten authorized API viewers passed. It used an
  isolated container and the production filesystem budget; it did not activate
  ten application sessions or modify production data.
- Build [37011722678](https://github.com/Admin-Adher/Norva/actions/runs/37011722678)
  passed cloud contracts and phone, TV and Windows builds.
- A production probe against the actual film at video sequence 38 received
  the expected HTTP 425, with no token or playlist URL issued. The original
  producer remained ready. The web player subsequently still displayed a
  1280x720 picture at 317.898 s, readyState 4, unpaused, with data buffered
  through 437.952 s. This proves the rejection did not stop that reader;
  it does not prove a successful second application viewer after this fix.

Private receipts:
`/home/adrien/.norva/hls-prefix-guard-20261002/integration-production-fs-budget.tap`
and `real-prefix-rejection.json` in the same directory. Local test receipt:
`.codex-artifacts/xvid-join-prefix-tests.tap`.

## Current production reference and real resume

Both Gateway routes run **174**, from source
`ac297db380a69e1947af2ca7ce1278a1f237e9f9`, with image
`sha256:a72e3803d4e0eb56fae9405f1b9c5f6d61052ed0611499fb7931e4951676427e`.
All **78 source files** on each route match the immutable Git archive.
Environment and mounts were preserved. The main Compose image reference was
updated and its effective configuration compared before/after; only the image
changed. Idle rollout guards preserved active work and retained the previous
containers for rollback. Edge remains 85.

Deployment receipts under the existing private `gateway-reference-rollout/`
directory: pilot `20261002T131948853200Z`, main `20261002T132005010224Z`.
The complete candidate source and rollout material are retained at
`/home/adrien/.norva/hls-prefix-guard-20261002/`.

After the 174 deployment, the ordinary QA account resumed the actual film
through normal UI controls at **1,045 s**. Server startup was **1,849 ms**,
first segment **1,207 ms**, and the application's browser first-frame event
was **8,113 ms**, with the correct position. The decoded picture was 1280x720;
no console warning/error was captured. Gateway receipt:
`adc521fb-ae57-4a8f-899a-2a8fa26eab63`; cloud playback session:
`acc01d24-6b05-4902-b6df-cb06cc3489e0`.

Local screenshots: `.codex-artifacts/xvid-direct-web-replay.jpg` and
`.codex-artifacts/xvid-prefix-guard-web-replay.jpg`. The QA reader was closed
through the normal Films navigation after verification.

## Distribution

Both releases were submitted in Google Play **Production**, with 100% rollout
and managed publishing disabled. Google still has to approve them; submission
is not confirmation that all customers have the update.

| Application | Version | SHA-256 of uploaded AAB | Play state at submission |
| --- | --- | --- | --- |
| Phone | 1.3.30 (44) | `4c382cb82d1d4627c554f5f4f9ae0ed03a0d1e2d7bbe226d6725194324694b2e` | Submitted for examination; 178 target countries |
| TV | 3.8.23-hybrid (36) | `48e397c2306bdc862a99617dbaf1a6caadfc4f6e336b668546843d99b4c7310e` | Submitted for examination; all target countries; 3,064 supported TVs, no device lost |

Local UI receipts: `.codex-artifacts/xvid-phone-production-submitted.jpg`
and `.codex-artifacts/xvid-tv-production-submitted.jpg`. The console's
deobfuscation/symbol warnings do not block submission. The native format fix
itself does not require Gateway/Edge changes. The separate web follow-up did
update both Gateways; the current reference is 174 above.

## Outstanding physical replay

The reconnected phone is still on **1.3.29 (43)**. The Play Store on the phone
shows **Open**, with no update button. The console still reports the phone
1.3.30 production release **under review**. Thus 1.3.29 is the newest public
version currently offered to this phone, not the corrected version.

Google provides an official
installation link for the exact submitted phone bundle:
`https://play.google.com/apps/test/tv.norva.phone/44`.
USB link-launch was again rejected by automatic approval, and the user reports
that the official link does not work. No alternative sideload, forged install
origin or security bypass was attempted. This is a concrete distribution
blocker, not a new payment requirement. The actual provider film,
resume, Back and concurrent web continuity must be checked on 1.3.30 before
claiming the physical-device failure closed. No purchase is required.

The broad commercial objective remains separate: neither a synthetic native
decode nor these web replays certify every provider or 20/100 real shared
conversions. A post-fix simultaneous application replay remains outstanding,
as does the physical film replay on the corrected native version. The
100-reader campaign stays excluded. The broad phone WebView-suite instability
described above also remains visible in the evidence.
