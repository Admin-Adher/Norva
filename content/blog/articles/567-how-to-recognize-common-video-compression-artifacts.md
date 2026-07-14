---
content_id: "NVB-567"
title: "How to Recognize Common Video Compression Artifacts"
seo_title: "Recognize Common Video Compression Artifacts"
meta_description: "Identify blocking, ringing, mosquito noise, smearing, detail loss, banding, and texture instability while separating observations from codec or bitrate guesses."
slug: "how-to-recognize-common-video-compression-artifacts"
canonical_url: "https://norva.tv/blog/how-to-recognize-common-video-compression-artifacts/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "artifact-identification-guide"
topic_cluster: "Video Quality Literacy"
search_intent: "video compression artifact identification"
funnel_stage: "retention"
primary_question: "How can viewers recognize common video compression artifacts?"
supporting_questions:
  - "Which scenes reveal blocking, ringing, mosquito noise, smearing, banding, and detail loss?"
  - "How can an artifact be documented without guessing its codec, bitrate, or cause?"
audience:
  - "Viewers troubleshooting picture artifacts"
  - "Teams comparing encoded video versions"
author:
  name: ""
  profile_url: ""
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
  source_of_truth: "https://norva.tv/#features; https://norva.tv/#how-it-works; https://norva.tv/privacy; https://norva.tv/terms; https://norva.tv/support"
published_at: null
updated_at: null
last_fact_check: null
estimated_reading_minutes: 7
excerpt: "A scene-based vocabulary and comparison method for describing encoded artifacts without turning visual symptoms into unsupported technical diagnoses."
hero:
  src: ""
  alt: ""
  width: 1600
  height: 900
og_image: ""
schema_type: "BlogPosting"
faq_schema:
  enabled: false
is_pillar: false
parent_pillar: "/blog/the-complete-guide-to-understanding-video-quality/"
related_articles:
  - "/blog/resolution-and-bitrate-why-they-are-not-the-same/"
  - "/blog/how-color-depth-relates-to-visible-banding/"
  - "/blog/why-two-videos-at-the-same-resolution-can-look-different/"
cta:
  label: "Explore Norva's Playback Features"
  href: "https://norva.tv/#features"
  intent: "retention"
sources:
  - "https://www.itu.int/rec/T-REC-P.910-202310-I/en"
  - "https://www.itu.int/rec/R-REC-BT.500"
  - "https://aomedia.org/specifications/av1/"
  - "https://norva.tv/#features"
proof_assets: []
original_evidence:
  required: true
  status: "present"
  type: "artifact scene and persistence log"
  summary: "A log records exact timecode, scene feature, artifact vocabulary, spatial location, motion and persistence, version, verified encode data, delivery state, device and display, plus a matched comparison."
  methodology: "The reviewer inspects authorised stress scenes at normal speed and paused frames, repeats the segment, compares a verified alternative where available, and labels cause as unknown unless corroborated by metadata or diagnostics."
  asset_urls: []
---
# How to Recognize Common Video Compression Artifacts

> **In short:** Describe what the picture does before naming a cause. Look for block-shaped boundaries, ringing near sharp edges, mosquito-like activity around detail, smeared moving texture, disappearing fine detail, stepped gradients, or unstable patterns. Record the exact scene, location, motion, persistence, version, and playback path. These symptoms can suggest compression stress, but they do not reveal a codec or bitrate by themselves.

Compression artifacts are easiest to discuss with a shared vocabulary and matched scenes. A vague statement that the image looks "pixelated" can hide several different behaviors.

## Blocking

Blocking appears as visible rectangular regions or boundaries, often in smooth areas, dark scenes, or complex motion. Do not infer the block size or codec tool from ordinary viewing alone. Record whether the pattern remains fixed to the picture or changes between frames.

## Ringing and edge halos

Ringing can appear as light or dark ripples near high-contrast edges, text, or graphics. Display sharpening and scaling can also create halos, so compare the same encode with one authorised processing change before assigning the layer.

## Mosquito noise and unstable edges

Fine shimmering or moving noise can gather around text, lines, or textured boundaries. Observe at normal speed and pause to locate it. A still screenshot may not show temporal instability.

## Smearing and detail loss

Texture can become soft, waxy, or smeared during motion, then return when the scene settles. Noise reduction, source softness, motion blur, scaling, and compression can overlap visually. Keep the cause open until a controlled comparison supports it.

## Banding and posterisation

Smooth gradients can break into visible steps. Color depth, grading, conversion, dynamic-range mapping, compression, and display processing may contribute. Use [the color-depth and banding guide](/blog/how-color-depth-relates-to-visible-banding/) for a gradient-specific path map.

## Original evidence: artifact log

| Timecode/scene | Location | Observed pattern | Motion/persistence | Version/metadata | Delivery/device/display | Matched result |
|---|---|---|---|---|---|---|
| Dark gradient | Region | Vocabulary | Behavior | Verified/unknown | Context | Observation |
| Fine texture | Region | Vocabulary | Behavior | Verified/unknown | Context | Observation |
| Moving edge | Region | Vocabulary | Behavior | Verified/unknown | Context | Observation |

Keep one row per symptom; several artifacts may coexist in one frame.

## Choose stress scenes responsibly

Use authorised scenes with smoke, water, foliage, film grain, confetti, dark gradients, fast pans, detailed clothing, credits, and high-contrast graphics. Compare at the same timecodes after playback settles.

Do not judge an entire version from one intentionally stylised shot. Source grain and creative effects are not automatically defects.

## Run a matched comparison

Fix device, output, display mode, room, scene, and timecode. Compare another verified representation or file when available. Record resolution, bitrate context, codec, frame rate, and source lineage only when known.

[Resolution and bitrate are not equivalent](/blog/resolution-and-bitrate-why-they-are-not-the-same/), and one bitrate number does not diagnose the encoder.

## Separate delivery symptoms

Rebuffering pauses playback. Adaptive quality switches may change detail or artifacts over time. A persistent artifact in a local or fully buffered source is not explained by current network throughput. Record quality switches and buffer events separately.

## Check display processing

Sharpening can exaggerate ringing; noise reduction can smear texture; scaling can soften or halo edges. Change only one authorised setting and restore the baseline. Do not publish a universal picture-mode prescription.

[The same-resolution comparison guide](/blog/why-two-videos-at-the-same-resolution-can-look-different/) captures source, encode, and display variables together.

## Report without overdiagnosing

Include media version without private source information, exact timecode, scene feature, location, motion behavior, device, app or browser version, delivery state, output, display mode, verified metadata, matched comparison, and privacy-safe capture. Current Norva diagnostics must be verified officially.

Norva plays compatible authorised sources and cannot guarantee or reconstruct their upstream encode quality.

## Confirm recurrence before escalation

Replay the segment from before the timecode and seek back once. Record whether the pattern recurs at the same picture location and frame sequence. Then test one authorised alternate version. An intermittent screen or transport event should not be reported as a persistent encoded artifact without that recurrence evidence.

## Frequently asked questions

### Does blocking prove the bitrate is low?

No. It is an observation that requires source, codec, encoder, scene, bitrate context, and playback-path evidence.

### Can display sharpening resemble compression artifacts?

Yes. It can exaggerate edges or halos, which is why one-setting comparisons matter.

### Is film grain a compression artifact?

Not inherently. Grain may be part of the source or creative intent, though an encode can represent it poorly.

## Your next step

[Explore Norva's playback features](https://norva.tv/#features)

## Sources

- [ITU-T P.910: Subjective Video Quality Assessment](https://www.itu.int/rec/T-REC-P.910-202310-I/en)
- [ITU-R BT.500: Television Image Quality Assessment](https://www.itu.int/rec/R-REC-BT.500)
- [Alliance for Open Media: AV1 Specification](https://aomedia.org/specifications/av1/)
- [Norva Features](https://norva.tv/#features)
