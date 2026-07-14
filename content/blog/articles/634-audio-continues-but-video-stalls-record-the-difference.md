---
content_id: "NVB-634"
title: "Audio Continues but Video Stalls: Record the Difference"
seo_title: "Audio Continues but Video Stalls: Record It"
meta_description: "When audio continues while video stalls, record clocks, timecodes, motion, synchronization, tracks, source version, output context, recurrence, and recovery."
slug: "audio-continues-but-video-stalls-record-the-difference"
canonical_url: "https://norva.tv/blog/audio-continues-but-video-stalls-record-the-difference/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "av-divergence-diagnostic"
topic_cluster: "Buffering Diagnostics"
search_intent: "audio continues video stalls"
funnel_stage: "retention"
primary_question: "What should be recorded when audio continues but video stalls?"
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
excerpt: "Treat audio and video as separate observations. Record whether the picture freezes, turns black, skips, or resumes; whether audio advances normally, loops, drops, or drifts; exact source timecode; duration; tracks; version; device; output; and recovery. Continued audio narrows the pattern but does not prove a video decoder fault."
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
  type: "dual-clock audio-video event log"
  summary: "A log separately records picture frame and media time, audio continuity and content, synchronization drift, source timecode, track, version, output, decoder context, network state, recurrence, and recovery."
  methodology: "Follow the article's visible workflow, record observable results, and compare only the stated variables before drawing a conclusion."
  asset_urls: []
is_pillar: false
parent_pillar: "/blog/a-symptom-pattern-atlas-for-video-buffering/"
related_articles:
  - "/blog/black-screen-with-audio-build-a-layered-diagnosis/"
  - "/blog/picture-but-no-sound-identify-the-missing-layer/"
  - "/blog/short-repeating-pauses-or-one-long-stall-compare-the-pattern/"
cta:
  label: "Explore Norva's Playback Features"
  href: "https://norva.tv/#features"
  intent: "retention"
sources:
  - "https://www.w3.org/TR/media-source-2/"
  - "https://www.w3.org/TR/media-capabilities/"
  - "https://www.w3.org/TR/webaudio-1.1/"
---
# Audio Continues but Video Stalls: Record the Difference

> **In short:** Treat audio and video as separate observations. Record whether the picture freezes, turns black, skips, or resumes; whether audio advances normally, loops, drops, or drifts; exact source timecode; duration; tracks; version; device; output; and recovery. Continued audio narrows the pattern but does not prove a video decoder fault.

The same visible freeze can arise from media data, coded frames, rendering, output, synchronization, device state, or source behavior.

## Describe the picture event

Write whether one frame remains visible, the screen becomes black, motion stops while controls respond, captions advance, or the playhead continues. Record the last moving frame and first recovered frame by approximate title timecode.

Do not call every frozen frame “buffering” if no waiting indicator appears.

## Describe audio independently

Record whether speech or music advances through new content, repeats a short segment, continues briefly then stops, changes output, distorts, or loses synchronization. Use safe volume and do not replay loud events repeatedly.

Audio continuity must mean new advancing content, not a loop mistaken for progress.

## Verify tracks and version

Record source version, video selection, audio language and format, subtitles, quality mode, and output device. An alternate audio track or external receiver changes the path.

Do not assume the audio and video were packaged or delivered identically.

## Original evidence: dual-clock log

| Time | Picture/frame state | Audio content state | Playhead/captions | A/V offset | Device/output | Network/player evidence | Recovery |
|---|---|---|---|---|---|---|---|
| Before | Moving | Advancing | Advancing | Baseline | Context | Evidence | N/A |
| Event | Frozen/black | Advances/loops/stops | State | Drift | Context | Evidence | Method |
| Resume | Behavior | Behavior | Position | New offset | Context | Evidence | Result |
| Repeat | Behavior | Behavior | Position | Offset | Same | Evidence | Recurrence |

Manual observations do not provide frame-accurate synchronization; label precision honestly.

## Replay from before the event

Start sufficiently earlier and keep version, tracks, output, device, and path fixed. If the pattern recurs at the same title timecode, media or source specifics gain relevance. If it occurs after a similar elapsed time, device resource or state becomes more relevant.

[Compare repeating pauses with one long stall](/blog/short-repeating-pauses-or-one-long-stall-compare-the-pattern/) to preserve duration and cadence.

## Compare another version or device

Test an alternate authorised version with verified differences, then the same version on another supported device. If video stalls across devices at one point while audio advances, the version/source layer gains weight. If only one device shows it, capability or output becomes relevant.

W3C Media Capabilities provides contextual capability questions, not a universal diagnosis.

## Change the output layer once

If an external display, receiver, adapter, or remote playback path is active, test the device's supported local output at safe volume and default picture controls. Restore accessibility and calibration settings afterward.

[The black-screen-with-audio guide](/blog/black-screen-with-audio-build-a-layered-diagnosis/) covers cases where no image remains; [the picture-without-sound guide](/blog/picture-but-no-sound-identify-the-missing-layer/) covers the inverse.

## Include network evidence without overclaiming

Record throughput, variation, loss, route change, and household traffic around the event. Separate audio continuation does not clear the network: audio and video may have different data demands or recovery behavior. A normal speed test to another endpoint is only context.

W3C Media Source Extensions describes coded-frame and buffered-range processing for compatible web implementations, not every native player.

## Report the divergence

Include exact visual and audio behaviors, timecodes, duration, synchronization, version, tracks, device, app and OS, output, network path, comparisons, recovery, and unknowns. Avoid asserting dropped frames, decoder failure, or corrupt video without validated diagnostics.

Norva organises and plays compatible authorised sources. It cannot certify source media, decoding, display output, or network delivery, and current diagnostics require official confirmation.

## Frequently asked questions

### Does continued audio prove the network is fine?

No. Audio may need less data or recover differently; delivery and player layers can affect tracks unequally.

### Does a frozen frame prove the video decoder failed?

No. Media, rendering, output, synchronization, source, and device state can create the symptom.

### Should the audio track be changed first?

Capture the baseline first, then change one supported track and record every associated media difference.

## Your next step

[Explore Norva's playback features](https://norva.tv/#features)

## Sources

- [W3C Media Source Extensions](https://www.w3.org/TR/media-source-2/)
- [W3C Media Capabilities](https://www.w3.org/TR/media-capabilities/)
- [W3C Web Audio API](https://www.w3.org/TR/webaudio-1.1/)