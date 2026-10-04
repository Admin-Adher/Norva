# Persistent robotic audio after a seek — 4 October 2026

## Recovered earlier correction

The user reported persistent underwater/robotic sound after seeking in the
exact Innocent Voices copy. At the time of inspection the browser was paused
at 24:47, playback rate 1, with one active media element. Its script DOM
confirmed `/js/vendor/hls-1.5.7.min.js?v=1`.

The previous correction is commit
`1f6b4fd6ae2d9cd4efd676fa79dec52fa09a7ba5` on
`codex/fix-aac-lc-20260917`, with its report
`docs/qa/audio-aac-lc-20260917.md`. That commit was not an ancestor of the
current reference `db90ab2a012180ffedf67ca08e6acfd69f3e41ae`.
The historical report records the same perceptual symptom, an actual Chromium
SourceBuffer configured as HE-AAC despite AAC-LC input, and user acceptance
after replacing hls.js 1.5.7 with 1.7.3. A defaultAudioCodec hint alone had
not corrected that older runtime.

This correction restores that exact licensed 1.7.3 bundle, local loader and CDN
fallback. It preserves the current WatchPage recovery and buffer policies.
The old bundle remains only as a regression fixture. Gateway encoder settings
already include AAC-LC, stereo 48 kHz and the earlier resampler correction;
no server codec, provider connection limit, language threshold or lease is
changed by this fix.

## Current evidence

- Four already generated HLS segments were copied at 16:26:58 UTC from the
  current seek window. This did not open a second provider connection.
- Offline inspection: 3,327,600 bytes, AAC-LC stereo 48 kHz, 610 audio packets,
  PTS 33.654–46.646 s; median interval 0.021333 s, maximum 0.021334 s;
  zero backward timestamps or gaps over 40 ms. Software decoding exited 0
  without AAC warnings. These checks alone do not certify perceived quality.
- Regression tests execute the parsers from the actual old and replacement
  bundles. For the Gateway 48 kHz stereo ADTS header, 1.5.7 announces
  `mp4a.40.5`; 1.7.3 announces `mp4a.40.2`, with config bytes `11 90`.
- 90 focused tests pass, covering the decoder profile, live synchronization,
  VOD recovery, back-buffer retention, seeking, and audio-language labels.
  The back-buffer test now uses the replacement runtime's actual controller
  fields and fragment event while preserving its original assertions.

## Independent language label correction

The exact source track is AAC 5.1 with language `und` and title `SoundHandler`.
English subtitles are independently known. The player incorrectly reparsed
`EN|` from the filename when curated audio metadata was absent; VO/VOSTFR could
also fall through to TMDB's original language. Those fallbacks are removed.
Exact track language and curated provider audio declarations remain supported.
Tests cover the unknown case in all ten locales and preserve explicit audio
declarations. The code change introduced no automatic spoken-language identification. The subsequent user listening confirmation below is separate human evidence.

## Integration and runtime verification

PR 633 is integrated as `e01afdd6fe7e497990eebcb7fe73d526d572f0c1`.
Application code is `9fefd7aeefff7c8dcb2b2446a8789df543a50784`;
`00d5a15c1a29c5ba81ff23c116088eac0702db48` only corrects an Android test
fixture to mark the explicitly tagged track as `probed`. The first matrix
failed that new assertion because the fixture omitted its required status;
this was not a production code change or a relaxed assertion.

An isolated Chromium replay consumed the same 13-second HLS output without
another provider request. Instrumented MediaSource creation recorded
`audio/mp4;codecs=mp4a.40.5` with 1.5.7 and
`audio/mp4;codecs=mp4a.40.2` with 1.7.3. Both loaded, sought to seven seconds
and finished without a fatal/media error; this demonstrates why lack of a
decoder error alone cannot certify perceived sound. The test tab and loopback
server are closed, and all five remote diagnostic TS files plus the local TS
copy were deleted after recording the aggregate proof.

The four phone WebView configurations passed on workflow 37217773623:
gesture/three-button, font 1.0/1.3. These exercise the shipped WatchPage's
audio-window recovery, startup recovery and audio label policy, not the native
Android decoder. TV consent focus at font 1.0 passed; font 1.3 failed a D-pad
left assertion (unchanged consent code, previously passed on 37217470135),
and its one targeted rerun passed. All six jobs ultimately passed. This is not
a TV audio acceptance test, and the initial focus failure remains recorded.
The ordinary cloud/Edge/database/journey checks and both Android tests/packages
passed before merge; Windows packaging subsequently passed as well.

Cloudflare publication 37218090252 succeeded at 16:49:45 UTC, after the full
web suite: 5,825 tests, 5,798 passed, 27 skipped, zero failures. The browser
was reloaded and its DOM confirmed `hls-1.7.3.min.js?v=1` and
`WatchPage.js?v=65f8e06835`. This WatchPage hash matches the integrated Git
blob. The same history entry resumed around 24:59. A real slider seek to
37:47 replaced the stream window normally; media progressed from 0.767926
to 129.227723 and then 231.716089 seconds relative to the new window,
paused=false, rate=1, readyState=4, media error=null. The menu opened in the
real app displays `Piste audio · AAC · 5.1`, without a guessed language.
The earlier unavailable placeholder observed while the menu was closed was
replaced when opening the menu; it was not used as an acceptance result.
On 4 October, after the corrected production replay and seek, the user explicitly
confirmed: "le son est normal" and "le son est de l'espagnol". This closes audible
acceptance of this exact Innocent Voices copy and records Spanish (`es`) as
human-confirmed spoken audio. It does not turn the earlier inconclusive machine
analyses into successful strict verification, nor change the source tag `und`.
English subtitles remain independently confirmed. The confirmation applies to
the selected file/track, not every version of the film or the other five films.
This correction does not resolve the separate MULTI-SUB input-corruption
investigation or complete the six featured-film language analyses.
