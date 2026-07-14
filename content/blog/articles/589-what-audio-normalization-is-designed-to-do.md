---
content_id: "NVB-589"
title: "What Audio Normalization Is Designed to Do"
seo_title: "What Audio Normalization Is Designed to Do"
meta_description: "Understand how loudness normalization adjusts programme gain while peaks, dynamic range, dialogue balance, output volume, and device processing remain separate."
slug: "what-audio-normalization-is-designed-to-do"
canonical_url: "https://norva.tv/blog/what-audio-normalization-is-designed-to-do/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "technical-explainer"
topic_cluster: "Audio Quality Literacy"
search_intent: "audio normalization literacy"
funnel_stage: "awareness"
primary_question: "What is audio loudness normalization designed to do?"
supporting_questions:
  - "How does programme gain alignment differ from peak normalization and dynamic compression?"
  - "How can normalization behavior be compared without assuming a universal target or scope?"
audience:
  - "Viewers experiencing track-to-track level changes"
  - "Households interpreting audio settings"
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
excerpt: "A gain-stage explanation of programme loudness normalisation, metadata or measurement, peak handling, dynamic range, user volume, and implementation boundaries."
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
parent_pillar: "/blog/the-complete-guide-to-understanding-audio-quality/"
related_articles:
  - "/blog/volume-and-loudness-why-they-are-not-identical/"
  - "/blog/how-audio-dynamic-range-changes-quiet-and-loud-moments/"
  - "/blog/why-dialogue-can-sound-quiet-while-effects-sound-loud/"
cta:
  label: "Explore Norva's Playback Features"
  href: "https://norva.tv/#features"
  intent: "awareness"
sources:
  - "https://www.itu.int/rec/R-REC-BS.1770/en"
  - "https://tech.ebu.ch/publications/r128"
  - "https://tech.ebu.ch/publications/tech3344"
  - "https://norva.tv/#features"
proof_assets: []
original_evidence:
  required: true
  status: "present"
  type: "normalisation gain and outcome ledger"
  summary: "A ledger records track, valid programme-loudness and peak evidence, normalization state and scope, applied gain when exposed, dynamics processing, user volume, output route, excerpt, level jump, and one-state comparison."
  methodology: "The listener fixes route and safe volume, compares several authorised programmes before and after one verified normalisation state, records measurements only from valid tools, and separates gain alignment from within-programme dynamics."
  asset_urls: []
---
# What Audio Normalization Is Designed to Do

> **In short:** Loudness normalization is designed to adjust programme playback or production gain toward a defined loudness relationship, reducing unintended level jumps between items. It is not the same as peak normalization, volume control, or dynamic-range compression. It may leave quiet dialogue and loud effects within one mix far apart unless separate processing changes that balance.

Exact target, measurement, metadata, true-peak handling, timing, and track scope depend on the standard and implementation. Verify current product behavior before naming a number.

## Start with programme loudness

ITU-R BS.1770 defines algorithms for programme loudness and true-peak measurement. EBU R 128 specifies a normalisation approach for its workflows. A consumer product may use another target or method, so do not assume EBU values apply without documentation.

Measurement must cover the intended programme scope and channel configuration.

## Separate gain from compression

Applying one gain offset moves quieter and louder moments together. Dynamic-range compression changes level over time, reducing some contrasts. A limiter or true-peak control can constrain peaks. These functions can coexist but should be documented separately.

[The audio dynamic-range guide](/blog/how-audio-dynamic-range-changes-quiet-and-loud-moments/) maps the within-programme effect.

## Separate volume control

The user volume changes a playback gain stage and may alter acoustic level. Normalisation changes the relationship between programmes or tracks according to implementation. [The volume-versus-loudness guide](/blog/volume-and-loudness-why-they-are-not-identical/) explains why identical slider numbers are not measurements.

## Original evidence: normalisation ledger

| Programme/track | Loudness/peak evidence | Normalisation state | Applied gain | Dynamics state | Route/volume | Perceived transition |
|---|---|---|---|---|---|---|
| A | Valid/unknown | Off/on | Exposed/unknown | State | Fixed | Description |
| B | Valid/unknown | Off/on | Exposed/unknown | State | Fixed | Description |
| Transition | Difference | State | Values | Same | Same | Result |

Do not invent gain values from perceived change.

## Compare several programmes

Use authorised items with different programme loudness and dynamics. Keep route, output device, user volume, room, and excerpts fixed. Compare transitions with normalisation off and on only where the control is supported and clearly defined.

Protect hearing by lowering level before an unknown transition.

## Check track and session scope

Normalization may apply per item, track, app, device, session, or account; it may exclude some formats or routes. Switch language or channel tracks, restart playback, and return only when those tests are safe. Record actual persistence.

Current Norva normalisation features, if any, require official verification; do not imply a standard or scope without evidence.

## Check peaks and clipping

Positive gain can interact with headroom and peak handling. Record valid true-peak evidence when available and listen for distortion at a safe level. Do not infer clipping from loudness alone.

EBU distribution guidance discusses loudness and permitted level in defined workflows; consumer processing can differ.

## Keep dialogue balance separate

Normalising a complete programme does not necessarily raise dialogue relative to simultaneous music or effects. [The quiet-dialogue guide](/blog/why-dialogue-can-sound-quiet-while-effects-sound-loud/) examines mix, downmix, output, and room.

## Report normalization behavior

Include tracks and versions without private source data, valid loudness and peak evidence and scope, normalisation control and official definition, applied gain if exposed, dynamics state, user volume, route, output, room, programme transitions, within-programme result, and unknowns.

Norva organises and plays compatible authorised sources; it cannot guarantee source loudness metadata or mixing.

## Common mistakes and limitations

Avoid calling every level change normalization, assuming one universal target, comparing at different volume, or expecting programme gain to remix dialogue. An informal listen is not standards compliance testing.

## Test transitions in both directions

Play the end of programme A into the start of programme B, then reverse the order with the same safe user volume. Record whether the transition changes consistently and whether one programme's intro contains an intentionally quiet or loud passage. A single short excerpt may not represent programme loudness.

Restart the app or session only when persistence is part of the question. Confirm the control state afterward and note whether alternate tracks inherit it. If the product exposes neither measurement nor applied gain, report perceived transitions and unknowns rather than claiming a target or algorithm.

## Frequently asked questions

### Is normalization the same as compression?

No. Normalization can apply gain to align programmes; compression changes level over time.

### Does normalization prevent every loud effect?

No. It may preserve within-programme dynamic range unless another process changes it.

### Does every service use the same loudness target?

No. Verify the current official product definition, method, and scope.

## Your next step

[Explore Norva's playback features](https://norva.tv/#features)

## Sources

- [ITU-R BS.1770: Programme Loudness and True Peak](https://www.itu.int/rec/R-REC-BS.1770/en)
- [EBU R 128: Loudness Normalisation](https://tech.ebu.ch/publications/r128)
- [EBU Tech 3344: Loudness Distribution Guidelines](https://tech.ebu.ch/publications/tech3344)
- [Norva Features](https://norva.tv/#features)
