# Native MPEG-4 / XVID software decoding — 4 October 2026

## Scope and initial fault

The Play-distributed phone 1.3.30 (44) starts Guerreiros da Virtude / Magic warriors
but produces severe block corruption on the POCO X7 Pro. The same source frame
is clean with FFmpeg. See `2026-10-04-android-1330-real-xvid-replay.md`.

This correction uses local FFmpeg for MPEG-4 Part 2 on phone and TV. Modern
video codecs continue through MediaCodec. Provider streams and offline files
remain native, without introducing a Gateway conversion. DRM content is not
claimed by the new renderer. Bounds, owned buffers, B-frame timestamps, EOS
draining and seek flushes are handled explicitly.

## Reproducible build

- Base: `2a00501985236bdec8196256927551e1ebe56d5f`.
- Media3: 1.5.1, `76088cd6af7f263aba238b7a48d64bd4f060cb8b`.
- FFmpeg: `b4a62c32549b8295691a8e0ff2c9b82188923159`.
- Four ABIs, NDK r26b, existing 16 KiB native alignment.
- JNI adapter SHA-256: `58cf7a44935b3fc5fc4ffd8b7c14b29b32966e54ec27e1864dedc32148a9ad21`.
- AAR SHA-256: `a011fdf3766da71d5077a4d8786ae1e73260a8a9ad05e97d5c0993b8ec8ea4c5`.
- Same AAR bundled in both apps; phone target 1.3.31 (45), TV 3.8.24-hybrid (37).
- [Native build](https://github.com/Admin-Adher/Norva/actions/runs/37184718273): success.
- [Final signed AAB build](https://github.com/Admin-Adher/Norva/actions/runs/37187260322): both JVM suites and bundles succeeded on `17374fdcc7a81c577382a333437feae783e5b921`.
- Phone AAB SHA-256: `a562e605bab41cb0926b05a5eaff372b5d49a7a9537506cb0ed8285741e97666` (15,468,895 bytes).
- TV AAB SHA-256: `a34e1632c1d1196b4ea98df239949a32f4bbac0bde4e5a0725d5e0f9796a91cf` (53,885,739 bytes).
- Both final AABs contain the local decoder classes and all four JNI libraries matching the tested AAR; receipt `release-binary-verification.json` in the private evidence directory.
- No Google Play publication is claimed by this build evidence.

## Emulator evidence and failures retained

[Run 37185058930](https://github.com/Admin-Adher/Norva/actions/runs/37185058930)
executed generated Advanced Simple/QPEL/4MV/B-frame coverage, native player
resume/seek/Back and a 300-frame exact YUV comparison. The MPEG-4 tests passed
in all six configurations (phone API 35: gestures and three buttons, font 1.0
and 1.3; TV API 34: font 1.0 and 1.3).

The wider phone fixture suite was **not entirely green**: gesture/font 1.0
stopped without finishing the HLS content-type test, without an established
cause. Gesture/font 1.3 exceeded the pre-existing 1500 ms refusal-to-recovery
assertion (1694 ms). These are not silently counted as passing.

[Focused follow-up 37185917725](https://github.com/Admin-Adher/Norva/actions/runs/37185917725):
HLS content-type passed on all four phone configurations; HTTP 460 recovery
passed on three configurations and measured 1684 ms on gesture/font 1.0,
exceeding that same threshold. No delay threshold was relaxed. Both TV
MPEG-4 suites passed; private media tests are skipped when no private clip is supplied.

73 targeted Node tests passed (native playback recovery, network recovery edge,
and movie profile recovery). They are not pixel-quality evidence.

## Physical test and correction verified

The isolated debug application is a distinct package; it does not replace the
Google Play app or share its account/download data. Android USB installation was
authorized by the user. Play Protect and the separate short-lived POCO USB
confirmation were both preserved. The initial installation cancellations were
not decoder failures.

A private 1280x720 excerpt of the exact failing file was copied without video
re-encoding; FFmpeg generated 502 YUV420P reference frames. No real film bytes,
provider URL or account identifier are committed or uploaded to public CI.

The first physical run decoded all 502 frames, but only 18 had identical hashes
to x86; the synthetic 300-frame clip matched 273 hashes. A bounded diagnostic
then compared 15 full real-file pictures: maximum component difference **1/255**,
maximum changed-component fraction **0.189%**, PSNR at least **75.36 dB**.
This establishes small arithmetic differences for these sampled pictures, not
pixel identity for the whole excerpt. Architecture-dependent FFmpeg IDCT
selection is visible in the pinned upstream source:
https://github.com/FFmpeg/FFmpeg/blob/b4a62c32549b8295691a8e0ff2c9b82188923159/libavcodec/aarch64/idctdsp_init_aarch64.c

The verification now compares **all components of all frames** against compressed
reference data, verifies those references against the original frame hashes,
and allows at most one rounding level on at most 1% of a frame's components.
The exact-hash mismatch is preserved above; arbitrary corruption cannot satisfy
this bound. The final whole-excerpt physical result **passes**: 502 frames,
693,964,800 components, maximum difference 1/255, 634,730 components differing
(0.09146% overall). Every individual frame meets the stricter 1% bound.
The synthetic clip also passes: 300 frames, 6,912,000 components, maximum
difference 1/255, only 42 components differing. Seek/flush compares exact
hashes against the same architecture's earlier decoded frames.

The real-file seek did not render a new frame within the initial fixed 1.2 s
snapshot. Position remained at the 7 s target and buffering was visible.
A bounded 5 s measurement then established **2536 ms** on the real excerpt.
The decoder was waiting for another player render tick for each discarded
pre-roll packet. It now pumps on input submission as well as output drain,
with four owned output buffers, a 32-packet batch bound, and explicit
backpressure. The final physical real-file seek measured **484 ms**; three
other measured seeks took 430–433 ms. These are local excerpt measurements,
not network startup guarantees or whole-catalogue figures.

Final physical instrumentation on POCO X7 Pro / API 36:

- Six MPEG-4 tests passed in 46.528 s, including all-frame comparison,
  real native playback/resume/seek, Back, background/foreground and surface recreation.
- Three recovery tests passed in 10.751 s: fresh route after HTTP 460,
  HTML terminal/refusal/retry, and playable bytes announced as HLS.
  The pre-existing HTTP 460 threshold remains 1500 ms.
- The native screenshot of the exact real excerpt is clean; visible corruption
  from the Play 1.3.30 decoder is absent in this replay.
- Final isolated APK build [37187494375](https://github.com/Admin-Adher/Norva/actions/runs/37187494375)
  is based on `cfe498ed2600692942eeed9d9f2fd38111162a2b`; differences after
  the final AAB build affect test fixtures/lifecycle assertions only.
- APK SHA-256: `b3f1bc55a7e0291b4e5f7d48595a9c4d50d05e32631bb7b54b36f8005a94b930`.
- Instrumentation APK SHA-256: `5757ab36aa9d0735317ce5e01397b058a1c13dd3ab10daed7b237a656c6539f8`.

Evidence: `.codex-artifacts/xvid-decoder-fix-20261004/poco-final.txt`,
`poco-final-metrics.txt`, `poco-recovery-final.txt`, and `poco-real-fixed.png`.
These remain local, with no film bytes or private URLs in repository/CI artifacts.

## Final automated verification

[Full emulator run 37187498135](https://github.com/Admin-Adher/Norva/actions/runs/37187498135)
on `cfe498ed2600692942eeed9d9f2fd38111162a2b` completed successfully in all
six configurations: phone API 35 gestures/three buttons at font 1.0/1.3,
and TV API 34 at font 1.0/1.3. The wider player/UI suite is green in this run;
earlier failures and timings are retained above, not recast as successful.
Physical private-film tests skip on CI when their private fixture is absent.

The cloud contract suite initially failed three release-number assertions
still expecting phone 44 / 1.3.30 and TV 36 / 3.8.23. Their expected versions
were updated to the actual release artifacts; 19 focused contract tests pass.
No production behavior or recovery threshold was changed for these assertions.

Cloud contracts [run 37188302778](https://github.com/Admin-Adher/Norva/actions/runs/37188302778)
then passed on `3062662f4`, as did phone/TV compilation and JVM tests, Edge
contracts, disposable database, notification policy, web/mobile journey and
phone/TV/Windows package builds.

The automatically repeated emulator matrix [37188302737](https://github.com/Admin-Adher/Norva/actions/runs/37188302737)
is **not counted as entirely passing**. Both TV jobs passed; phone three-button
1.0 and gesture 1.3 stopped during `attachedFiltersKeepScopeWithKeyboard`,
before the native player tests. The three-button log records WebView renderer
process crash code -1 immediately on entry to that test; UTP reports 10 of 73
tests received. The exact root cause is not established. The other two phone
jobs were still running at this observation. This recurrence is retained as
a wider emulator/WebView-suite limitation. No code in the app changed between
the successful six-configuration run and this repeat; only release contract
expectations, evidence and the temporary QA build trigger changed.

## Google Play submission and cleanup

On 4 October, both final signed bundles above were uploaded to **production**,
with full rollout configured and release notes in all nine console locales:

- Mobile **1.3.31 (45)**, release draft 30, submission requested and listed under
  changes in review; automated preliminary checks still running at capture.
- TV **3.8.24-hybrid (37)**, release draft 21, submission requested and listed
  under changes in review; this restarted the review previously containing TV 36.
- No devices were dropped from either console's supported-device comparison.
- Console warnings about absent obfuscation mapping and native debug symbols
  remain recorded. Neither is reported as a blocking error by the release UI.
- Screenshots `play-phone-submitted.jpg` and `play-tv-submitted.jpg` are retained
  in the private evidence directory.

The task-created QA application and instrumentation package were uninstalled
successfully after preserving evidence; their private media are removed with
that disposable app. Only the normal phone package remains. The user's actual
Play app was checked again: **1.3.30 (44)**, installed by Google Play. The new
release is not claimed as approved, distributed or installed on that app yet.

## Current status

Correction and final signed artifacts verified, **submitted to Google Play production**.
The exact failing real excerpt now has physical all-frame and clean surface proof.
This does not certify every title or a full-length viewing, human listening,
all device architectures in physical hardware, or the later Play-installed update.
The independent language campaign has not been stopped or reconfigured.
