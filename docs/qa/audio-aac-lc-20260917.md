# Robotic VOD audio: HLS decoder correction

## Observed failure and correction

On 17 September, the user reported robotic, metallic, crackling audio on the
Royalteen ES / Promax MP4 (stream 1014841, source 900004). The Gateway emits
AAC-LC stereo at 48 kHz. The loaded hls.js 1.5.7 runtime nevertheless configured
the Chromium audio SourceBuffer as `mp4a.40.5` (HE-AAC).

The bundled 1.5.7 ADTS parser explicitly changes the audio object type to 5 on
the Chrome stereo path. Even `defaultAudioCodec: 'mp4a.40.2'` does not override
that heuristic for this 48 kHz stereo input. Restarting the decoder with that
option was insufficient; its actual SourceBuffer still reported `mp4a.40.5`.

The official hls.js 1.7.3 runtime uses the parsed ADTS object type. Substituting
that runtime in the same Norva page and reloading the **same Gateway session**
changed the actual audio SourceBuffer to `mp4a.40.2`. No Gateway audio encoding
arguments were changed. The user then confirmed: **“Le son est maintenant normal.”**

This release pins the local runtime and the CDN fallback to 1.7.3, includes its
upstream license, and updates the local playback proof tools. The old bundle
remains only as a regression fixture; the app loader no longer selects it.

## Evidence and limits

- New regression tests execute the audio-config parser from the actual shipped
  bundles: the former Chrome path produces HE-AAC, the replacement produces
  AAC-LC with AudioSpecificConfig `11 90` for 48 kHz stereo. Mono, stereo,
  surround and invalid sample-rate cases are covered.
- The live TV synchronization regression now calls the actual runtime method
  instead of relying on names chosen by a particular minifier.
- A same-demux diagnostic captured the source AAC and Gateway HLS without a
  second provider connection. An earlier 36-second aligned overlap had
  correlation 0.999415, gain 0.997318, residual SNR 29.31 dB and no clipping.
  These numerical checks alone did not establish perceptual quality; the
  decoder change and user confirmation provide the audible acceptance.
- A 25-segment trace contained 4656 continuous audio packets. No second audio
  element played concurrently; playback rate was 1. These observations apply
  to the measured sessions, not every format/device.
- The test controller restored services on a later health-read timeout. This
  is not evidence of an audio regression and is not a cache-reuse acceptance.

## Operational state

The separate Gateway metadata-admission gate correction is active on the main
Gateway (`provider-quiesce-http-20260917`); it was tested independently. The
temporary diagnostic pilot image was removed from service, restoring
`resume-ranges-introspection-20260917`. Final independent checks found no pilot
session, no quiesce lease, and all four secondary containers running/unpaused.
The six storyboard checkpoints remained intact: 156 / 24 / 120 / 30 / 126 / 30.

CodexCN settings and Oxylabs credentials were unchanged. Resume-cache reuse is
still a separate unfulfilled acceptance criterion; this release fixes audio.

The release branch starts from the last successful web deployment,
`8d15f8bed8b5fdec91203ba1f6d599c07dcbeddd`, preserving its playback changes.

The full local regression suite completed with 4,943 tests: 4,919 passed,
24 skipped, and 0 failed. Two time-dependent MKV proof fixtures were made
clock-relative so the suite remains valid after their original August test
date expires; no production proof or admission logic changed.
