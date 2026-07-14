---
content_id: "NVB-568"
title: "What Upscaling Can and Cannot Change"
seo_title: "What Video Upscaling Can and Cannot Change"
meta_description: "Understand how upscaling changes output dimensions while source detail, compression damage, motion cadence, framing, and dynamic range remain separate limits."
slug: "what-upscaling-can-and-cannot-change"
canonical_url: "https://norva.tv/blog/what-upscaling-can-and-cannot-change/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "technical-explainer"
topic_cluster: "Video Quality Literacy"
search_intent: "video upscaling limitations"
funnel_stage: "retention"
primary_question: "What can video upscaling change, and what source limits remain?"
supporting_questions:
  - "How do player, device, receiver, and display scaling stages interact?"
  - "How can scaling be compared without claiming reconstructed detail is original detail?"
audience:
  - "Viewers comparing display and device scaling"
  - "Households troubleshooting soft or oversharpened pictures"
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
excerpt: "A controlled scaling-path guide for separating resized output from original detail, encoded artifacts, motion, framing, color, and display processing."
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
  - "/blog/source-quality-or-display-capability-which-is-the-limit/"
  - "/blog/resolution-and-bitrate-why-they-are-not-the-same/"
  - "/blog/why-aspect-ratio-changes-the-shape-of-the-picture/"
cta:
  label: "Explore Norva's Playback Features"
  href: "https://norva.tv/#features"
  intent: "retention"
sources:
  - "https://www.itu.int/rec/R-REC-BT.709/en"
  - "https://www.itu.int/rec/R-REC-BT.2020/en"
  - "https://www.itu.int/rec/R-REC-BT.500"
  - "https://norva.tv/#features"
proof_assets: []
original_evidence:
  required: true
  status: "present"
  type: "scaling-stage comparison map"
  summary: "A fixed-frame map records source dimensions, player and device output, receiver and display scaling states, fit mode, processing, edge and texture observations, artifacts, captions, and one-stage comparison."
  methodology: "The reviewer uses authorised scenes with fine detail, edges, text, faces, motion, and gradients, fixes the display and seat, changes one verified scaling stage, and reports reconstructed appearance without claiming recovered source data."
  asset_urls: []
---
# What Upscaling Can and Cannot Change

> **In short:** Upscaling converts a video to larger output dimensions by estimating new samples from available image information. It can improve how a lower-resolution source fits a higher-resolution output and can alter sharpness, edges, and apparent texture. It cannot reliably recover original detail, remove all compression damage, change source motion cadence, restore cropped framing, or recreate lost dynamic range.

More output pixels do not prove more captured information. The result depends on the source, scaling algorithm, processing, display, distance, and scene.

## Find where scaling occurs

Scaling can happen in the player, operating system or device output, receiver, switch, or display. More than one stage may resize the picture. Record source dimensions, output resolution, display native mode when known, and each relevant fit or scaling control.

Do not assume the display performs the only upscale because its panel is the final stage.

## Separate output dimensions from source detail

An upscaled frame contains more output samples, but those samples are computed from the input. Edge-directed or learned methods may create a more plausible appearance, yet that generated appearance is not proof of detail in the original source.

[Resolution and bitrate are separate](/blog/resolution-and-bitrate-why-they-are-not-the-same/), and scaling changes neither the historical source quality nor the original encoder decisions.

## Observe useful improvements and trade-offs

Scaling can reduce obvious stair-stepping, shape edges, or create a presentation better matched to the display. It can also soften fine detail, exaggerate noise, add halos, create ringing, or interact with sharpening and noise reduction.

Report both benefits and regressions at matched timecodes instead of ranking algorithms from one still image.

## Original evidence: scaling-stage map

| Layer | Input/output | Scaling or fit state | Scene feature | Benefit | Artifact/trade-off | Caption/framing result |
|---|---|---|---|---|---|---|
| Player/device | Verified values | State | Fine detail | Observation | Observation | Result |
| Receiver | Verified/unknown | State | Edge/motion | Observation | Observation | Result |
| Display | Verified/unknown | State | Text/gradient | Observation | Observation | Result |

Mark hidden processing as unknown rather than inferring it from marketing names.

## Use revealing scenes

Choose authorised scenes with hair or fabric, architecture, diagonal edges, small in-picture text, faces, film grain, dark gradients, and camera motion. Observe at normal speed, then pause to locate edge treatment. Include more than one content type.

Keep the same media version, timecode, device, output, display mode, seat, and lighting.

## Change one scaling stage

Where the path permits, compare device output modes or display scaling with all other processing fixed. Restore the baseline after each comparison. If changing output also changes refresh, color, or dynamic-range signalling, note that the test is no longer a pure scaling comparison.

Use [the source-versus-display guide](/blog/source-quality-or-display-capability-which-is-the-limit/) to identify coupled limits.

## Protect aspect ratio and framing

Upscaling should not be confused with zooming or filling. A fill mode can crop edges; stretching can distort geometry. [The aspect-ratio guide](/blog/why-aspect-ratio-changes-the-shape-of-the-picture/) separates shape from dimensions.

Check captions, credits, player overlays, and focus near the frame edges after any fit change.

## Keep other quality properties separate

Upscaling does not increase source frame rate, correct cadence, recreate clipped highlights, guarantee better color depth, or erase every encoded artifact. Display processing may mask or exaggerate those limitations, but the underlying chain remains relevant.

## Report an upscaling comparison

Include source dimensions and provenance when known, media version, scene, player mode, device output, receiver, display and picture mode, processing state, viewing distance, observed detail and artifacts, and privacy-safe evidence. Current Norva scaling and output controls require official verification.

Norva organises and plays compatible authorised sources; it should not be claimed to enhance every source or restore absent information.

## Retest at normal distance

A close inspection can exaggerate edge processing that is invisible from the regular seat, while a distant view can hide lost fine detail. Record both the diagnostic close view and the ordinary viewing result, but use the real household task as the decision context.

## Frequently asked questions

### Does upscaling turn lower-resolution source detail into native high-resolution detail?

No. It estimates additional samples; the appearance may improve, but original missing information is not guaranteed to be recovered.

### Can several devices upscale the same picture?

Yes. Player, device, receiver, and display stages may each process dimensions, which is why the path should be mapped.

### Is upscaling the same as zooming to fill?

No. Zoom or fill can crop framing, while scaling can preserve the full frame dimensions.

## Your next step

[Explore Norva's playback features](https://norva.tv/#features)

## Sources

- [ITU-R BT.709: HDTV System Parameters](https://www.itu.int/rec/R-REC-BT.709/en)
- [ITU-R BT.2020: UHDTV System Parameters](https://www.itu.int/rec/R-REC-BT.2020/en)
- [ITU-R BT.500: Television Image Quality Assessment](https://www.itu.int/rec/R-REC-BT.500)
- [Norva Features](https://norva.tv/#features)
