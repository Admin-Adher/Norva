---
content_id: "NVB-577"
title: "How to Recognize Crushed Shadows and Raised Blacks"
seo_title: "Recognize Crushed Shadows and Raised Blacks"
meta_description: "Use matched dark scenes and a source-to-display path map to distinguish lost shadow detail, elevated black levels, creative grading, range mismatch, and room effects."
slug: "how-to-recognize-crushed-shadows-and-raised-blacks"
canonical_url: "https://norva.tv/blog/how-to-recognize-crushed-shadows-and-raised-blacks/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "picture-diagnostic-guide"
topic_cluster: "Video Quality Literacy"
search_intent: "video black level problem identification"
funnel_stage: "retention"
primary_question: "How can viewers recognize crushed shadows and raised blacks?"
supporting_questions:
  - "How can lost detail and elevated dark levels be separated from creative grading?"
  - "Which source, range, output, display, tone-map, and room layers should be checked?"
audience:
  - "Viewers troubleshooting dark-scene quality"
  - "Households comparing video paths"
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
excerpt: "A dark-scene diagnostic for separating source grading, encoded range, output mismatch, tone mapping, display processing, reflections, and shadow-detail loss."
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
  - "/blog/dynamic-range-explained-for-everyday-viewers/"
  - "/blog/source-quality-or-display-capability-which-is-the-limit/"
  - "/blog/how-to-compare-two-video-versions-responsibly/"
cta:
  label: "Explore Norva's Playback Features"
  href: "https://norva.tv/#features"
  intent: "retention"
sources:
  - "https://www.itu.int/rec/R-REC-BT.709/en"
  - "https://www.itu.int/rec/R-REC-BT.2100/en"
  - "https://www.itu.int/rec/R-REC-BT.500"
  - "https://norva.tv/#features"
proof_assets: []
original_evidence:
  required: true
  status: "present"
  type: "dark-level step and path log"
  summary: "A fixed-scene log records visible near-black steps and texture, source format, range and dynamic-range signalling when known, output and display modes, room light, histogram or test-pattern evidence where authorised, and controlled substitution."
  methodology: "The reviewer uses authorised dark scenes and appropriate test material, fixes display and room, changes one verified range or mode layer, restores baseline, and does not infer creative intent from appearance alone."
  asset_urls: []
---
# How to Recognize Crushed Shadows and Raised Blacks

> **In short:** Crushed shadows merge distinct dark details into the same black region; raised blacks make the darkest intended areas look elevated or gray. Both can come from source grading, encode or range conversion, dynamic-range mapping, device output, display settings, or room reflections. Compare known dark steps and matched scenes through one controlled path before diagnosing the layer.

An intentionally dark scene is not automatically crushed. The key question is whether distinct information expected in the source remains distinguishable through the current path.

## Choose suitable evidence

Use authorised scenes with dark clothing, textured walls, hair, smoke, and gradual transitions near black. Add an appropriate legal test pattern when available. Do not use a random online image whose encoding, range, and player path are unknown.

Observe normal playback first, then pause to locate missing or elevated levels.

## Define the two symptoms

For crushing, record separate shadow features that collapse into one flat region or disappear after a path change. For raised blacks, record a dark region that no longer approaches the expected display black while brighter tones remain visible.

Compression, display glow, reflections, subtitles, and local dimming behavior can complicate the observation. Keep the description specific.

## Map the signal path

Record source dynamic-range format and range signalling when exposed, player or operating-system conversion, device output, receiver or adapter, display input, picture mode, brightness or black-level control, dynamic contrast, and tone mapping. Mark hidden stages unknown.

[The dynamic-range guide](/blog/dynamic-range-explained-for-everyday-viewers/) explains format and tone-mapping boundaries.

## Original evidence: dark-level log

| Scene/pattern | Source/range evidence | Output/display state | Room/reflection | Visible dark steps | Texture retained? | Comparison |
|---|---|---|---|---|---|---|
| Dark scene | Verified/unknown | Context | Context | Description | Yes/no | Result |
| Near-black pattern | Verified | Context | Context | Description | Yes/no | Result |
| Alternate path | Same | One change | Same | Description | Yes/no | Result |

Do not publish copyrighted test material or private source details.

## Check for range mismatch

A mismatch in how black and white code ranges are interpreted can alter dark and bright levels. Verify official output and display status rather than toggling range controls until the picture looks dramatic. Change one paired setting only when its meaning is understood, then restore baseline.

If the entire image changes, report highlights and midtones too.

## Include HDR-to-SDR mapping

Tone mapping or format conversion can change shadow placement. Compare the correct authorised versions and output modes without assuming the brighter one is more accurate. Source mastering and display capability both matter.

Use [the source-versus-display guide](/blog/source-quality-or-display-capability-which-is-the-limit/) to locate the first reproducible boundary.

## Control room light

Reflections and ambient light can make dark detail harder to see or raise apparent black levels. Keep the room fixed during technical comparisons, then record a separate ordinary-light observation. Do not prescribe unsafe darkness or override household preferences.

## Compare versions responsibly

Two releases may have different grades. [The responsible video-comparison guide](/blog/how-to-compare-two-video-versions-responsibly/) keeps source lineage, metadata, scene, path, and unknowns visible. A different grade does not prove one playback path is wrong.

## Report the dark-level issue

Include media version, exact scene, verified source format and range, device and software, output and intermediate path, display and picture mode, relevant controls, room light, visible steps or textures, controlled change, and privacy-safe evidence. Current Norva diagnostics require official verification.

Norva organises and plays compatible authorised sources; it cannot certify their creative grade or hidden range metadata.

## Common mistakes and limitations

Avoid raising brightness until detail appears, judging from one intentionally dark shot, changing range and picture mode together, or sampling a camera photo as signal data. This is not professional display calibration.

## Repeat after the image settles

Some displays and adaptive paths change behavior after a scene transition. Start before the dark sequence, let the shot play, and note whether shadow detail changes during the first seconds. Repeat once. A transient adjustment and a stable range mismatch need different evidence, even when both make the opening frame look wrong.

## Frequently asked questions

### Does a dark scene prove crushed blacks?

No. Look for expected distinct shadow information and compare a verified source or test pattern through a controlled path.

### Can room light resemble raised blacks?

Reflections and ambient light can reduce perceived black depth, so document environment separately from signal values.

### Is the brighter version always more correct?

No. Mastering, range, tone mapping, and creative intent can differ.

## Your next step

[Explore Norva's playback features](https://norva.tv/#features)

## Sources

- [ITU-R BT.709: HDTV System Parameters](https://www.itu.int/rec/R-REC-BT.709/en)
- [ITU-R BT.2100: HDR Television](https://www.itu.int/rec/R-REC-BT.2100/en)
- [ITU-R BT.500: Television Image Quality Assessment](https://www.itu.int/rec/R-REC-BT.500)
- [Norva Features](https://norva.tv/#features)
