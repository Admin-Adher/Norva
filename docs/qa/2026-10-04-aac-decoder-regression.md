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
declarations. No new spoken-language identification is claimed.

## Remaining verification

Integration, deployment, Android WebView replay and production seek replay
must be recorded below. Audible acceptance of the current copy remains
pending; the historical acceptance is not a substitute for today's test.
This correction does not resolve the separate MULTI-SUB input-corruption
investigation or complete the six featured-film language analyses.
