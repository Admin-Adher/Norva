---
content_id: "NVB-648"
title: "Picture but No Sound: Identify the Missing Layer"
seo_title: "Picture but No Sound: Find the Missing Layer"
meta_description: "Trace picture-without-sound through mute, safe volume, selected track, audio format, output route, receiver, device capability, source version, and recurrence."
slug: "picture-but-no-sound-identify-the-missing-layer"
canonical_url: "https://norva.tv/blog/picture-but-no-sound-identify-the-missing-layer/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "no-audio-diagnostic"
topic_cluster: "Playback Error Diagnostics"
search_intent: "picture without audio diagnostic"
funnel_stage: "retention"
primary_question: "How can the missing layer be identified when picture plays without sound?"
supporting_questions: []
audience: []
author:
  name: ""
human_review:
  required: true
  status: "pending"
  reviewer_name: ""
  reviewer_role: ""
  reviewed_at: null
  decision: ""
  notes: ""
product_claims:
  verified: false
  verified_by: ""
  verified_at: null
  source_of_truth: "https://norva.tv/; https://norva.tv/support; https://norva.tv/privacy; https://norva.tv/terms"
published_at: null
updated_at: null
last_fact_check: null
estimated_reading_minutes: 4
excerpt: "Start at a low safe level and trace audio from the selected track through app mute and gain, system volume, active output route, receiver or headphones, format capability, and physical connection. Compare another track, title, local output, and device one at a time. Never raise volume aggressively to “find” sound."
hero:
  src: ""
  alt: ""
  width: 1600
  height: 900
og_image: ""
schema_type: "BlogPosting"
faq_schema:
  enabled: false
proof_assets: []
original_evidence:
  required: true
  status: "present"
  type: "audio path and track isolation ladder"
  summary: "A ladder records picture and playhead, mute and safe level, track, audio format and channels, app and system gain, output route, receiver mode, device capability, source version, alternate title, recurrence, and recovery."
  methodology: "Follow the article's visible workflow, record observable results, and compare only the stated variables before drawing a conclusion."
  asset_urls: []
is_pillar: false
parent_pillar: "/blog/how-to-read-a-playback-error-before-trying-a-fix/"
related_articles:
  - "/blog/audio-continues-but-video-stalls-record-the-difference/"
  - "/blog/black-screen-with-audio-build-a-layered-diagnosis/"
  - "/blog/how-to-investigate-an-unsupported-media-message/"
cta:
  label: "Explore Norva's Playback Features"
  href: "https://norva.tv/#features"
  intent: "retention"
sources:
  - "https://www.w3.org/TR/audio-output/"
  - "https://www.w3.org/TR/media-capabilities/"
  - "https://www.w3.org/TR/webaudio-1.1/"
---
# Picture but No Sound: Identify the Missing Layer

> **In short:** Start at a low safe level and trace audio from the selected track through app mute and gain, system volume, active output route, receiver or headphones, format capability, and physical connection. Compare another track, title, local output, and device one at a time. Never raise volume aggressively to “find” sound.

Moving picture proves some media and rendering stages work, not that an audio track is present, selected, decoded, routed, or audible.

## Protect hearing and equipment

Lower every gain stage before changing outputs. Remove headphones before uncertain tests. Confirm mute visually and increase level gradually only to a normal safe baseline.

Stop with distortion, discomfort, or hardware warnings.

## Verify picture and timeline

Record whether picture and playhead advance, captions appear, and an error is displayed. Note exact title timecode, startup or midplay phase, duration of silence, and recovery.

Do not call it an audio dropout if sound never began; startup and midplay are separate cases.

## Verify the selected track

Record audio language, format and channels where verified, alternate commentary or descriptive tracks, and whether the selection persists after resume. Compare another authorised track while keeping device and output fixed.

Track availability and labels depend on source and version.

## Trace gain and mute stages

List app mute and volume, system media volume, television level, receiver level, headphone control, and accessibility audio controls. Change one stage, record the prior value, and restore it.

Do not assume a slider at maximum produces the expected route or a safe acoustic level.

## Original evidence: audio isolation ladder

| Stage | Baseline | One comparison | Result |
|---|---|---|---|
| Picture/playhead/error | Context | Another title | Outcome |
| Track/format/channels | Values | Alternate track | Outcome |
| App/system mute/gain | Values | Safe check | Outcome |
| Output route | Device/receiver | Local output | Outcome |
| Capability | Verified/unknown | Another device/version | Outcome |
| Recovery/recurrence | Action | Repeat | Outcome |

Keep volume values contextual; they are not calibrated acoustic measurements.

## Verify the active output

Audio may route to television speakers, receiver, soundbar, Bluetooth device, headphones, remote playback target, or another selected device. W3C Audio Output Devices API describes output selection in supported web contexts, not every platform.

Disconnect or switch only through official controls and lower volume first.

## Compare local output

If an external receiver, adapter, or wireless output is active, test supported local speakers at low level. If sound returns, output route or format compatibility gains relevance. If silence remains, track, app, capability, or source remains.

[Black screen with audio](/blog/black-screen-with-audio-build-a-layered-diagnosis/) applies the inverse output and media test.

## Check media capability

Record verified audio codec, sample rate, channels, and output support. W3C Media Capabilities exposes contextual decoding questions. [The unsupported-media guide](/blog/how-to-investigate-an-unsupported-media-message/) covers complete format combinations.

Do not infer unsupported audio from silence alone.

## Compare title and device

Test another authorised title on the same output and the affected title on another supported device. If one track alone is silent, source or track-specific context gains relevance. If every app is silent on one output, the shared output path gains relevance.

[Audio continuing while video stalls](/blog/audio-continues-but-video-stalls-record-the-difference/) helps document unequal tracks without merging them.

## Use safe recovery

Pause and resume once, reselect the track, switch to local output, then restart only the app after capturing evidence. Avoid factory reset, receiver auto-calibration reset, and random format overrides.

Norva organises and plays compatible authorised sources. It cannot guarantee tracks, audio formats, device decoding, or output compatibility; current controls require official verification.

## Recheck after changing one output boundary

If an official local-output comparison is safe, keep the same title version, timecode, audio track, volume setting, and app state. Record whether sound begins, remains absent, or produces a different error. Restore the original route before any second comparison.

Do not raise volume to compensate for silence, hot-plug active equipment without guidance, or conclude that the original receiver is faulty from one successful phone-speaker trial.

## Frequently asked questions

### Should volume be raised until sound appears?

No. Trace mute and route at a low safe baseline to protect hearing and equipment.

### Does another track working prove the first is defective?

No. Format, channels, language production, source state, and device support can differ.

### Can Bluetooth keep sound after it looks disconnected?

Output state can lag or differ by platform. Verify the active route through official controls before testing.

## Your next step

[Explore Norva's playback features](https://norva.tv/#features)

## Sources

- [W3C Audio Output Devices API](https://www.w3.org/TR/audio-output/)
- [W3C Media Capabilities](https://www.w3.org/TR/media-capabilities/)
- [W3C Web Audio API](https://www.w3.org/TR/webaudio-1.1/)