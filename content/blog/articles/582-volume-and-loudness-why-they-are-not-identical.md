---
content_id: "NVB-582"
title: "Volume and Loudness: Why They Are Not Identical"
seo_title: "Volume vs Loudness: Why They Differ"
meta_description: "Learn why a volume control changes playback gain while perceived and measured loudness depend on content, duration, spectrum, dynamics, channels, output, and context."
slug: "volume-and-loudness-why-they-are-not-identical"
canonical_url: "https://norva.tv/blog/volume-and-loudness-why-they-are-not-identical/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "technical-explainer"
topic_cluster: "Audio Quality Literacy"
search_intent: "volume vs loudness audio"
funnel_stage: "consideration"
primary_question: "What is the difference between volume and loudness in audio playback?"
supporting_questions:
  - "How do gain, programme loudness, peaks, dynamics, spectrum, channels, output, and environment differ?"
  - "How can two tracks be compared without relying on slider position or brief peaks?"
audience:
  - "Viewers comparing audio levels"
  - "Households troubleshooting level jumps"
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
excerpt: "A viewer-first distinction between playback gain, perceived level, programme loudness, peaks, dynamic range, output sensitivity, room noise, and safe comparison."
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
  - "/blog/the-complete-guide-to-understanding-audio-quality/"
  - "/blog/what-audio-normalization-is-designed-to-do/"
  - "/blog/how-audio-dynamic-range-changes-quiet-and-loud-moments/"
cta:
  label: "Explore Norva's Playback Features"
  href: "https://norva.tv/#features"
  intent: "consideration"
sources:
  - "https://www.itu.int/rec/R-REC-BS.1770/en"
  - "https://tech.ebu.ch/publications/r128"
  - "https://norva.tv/#features"
proof_assets: []
original_evidence:
  required: true
  status: "present"
  type: "gain-loudness listening card"
  summary: "A matched-excerpt card records player and device gain, normalisation and dynamics state, measured programme loudness and peaks when valid, output route, room, perceived level, dialogue audibility, and safe level-match method."
  methodology: "The listener fixes route and room, uses matched authorised excerpts, compares at a safely matched perceived or measured level, records every gain stage, and avoids raising level to unsafe exposure."
  asset_urls: []
---
# Volume and Loudness: Why They Are Not Identical

> **In short:** A volume control changes gain at a point in the playback chain. Loudness describes how strong audio is perceived and can also be characterised through defined measurement algorithms for programmes. Content spectrum, duration, dynamics, channel layout, normalisation, output sensitivity, room noise, and listener context mean the same slider position does not guarantee the same loudness.

Peak level is another property. A brief high peak and a sustained programme can have different perceived loudness even if one meter value matches.

## Map every gain stage

Record player volume, operating-system level, television or receiver level, headphone control, application gain, and any per-track adjustment. A displayed "50" has no universal acoustic meaning across devices.

Keep one gain stage fixed while changing another, and never raise level beyond a safe, comfortable range for testing.

## Understand programme loudness

ITU-R BS.1770 defines algorithms for measuring audio programme loudness and true-peak level. EBU R 128 builds a normalisation workflow around loudness measurements for its context. These standards do not turn a consumer volume slider into a loudness meter.

Record the measurement method, full programme or excerpt scope, channels, and normalisation state.

## Separate peaks and dynamic range

Peak level describes high sample or reconstructed waveform excursions; loudness incorporates a different model over time. Dynamic range describes variation between quieter and louder material. Two programmes can share measured integrated loudness and still feel different moment to moment.

[The audio dynamic-range guide](/blog/how-audio-dynamic-range-changes-quiet-and-loud-moments/) explains that variation.

## Original evidence: gain-loudness card

| Track/excerpt | Player/device gain | Normalisation | Loudness/peak evidence | Route/output | Room/noise | Perceived result |
|---|---|---|---|---|---|---|
| A | Recorded values | State | Measured/unknown | Context | Context | Description |
| B | Recorded values | State | Measured/unknown | Context | Context | Description |
| Level-matched | Safe method | State | Evidence | Same | Same | Description |

Do not invent acoustic output from an on-screen number.

## Compare tracks at matched level

A louder version often seems clearer or more impressive. Reduce that bias by matching programme loudness with a valid method or carefully matching perceived level at a safe volume. Keep route, output device, processing, room, and excerpt fixed.

Alternate order and note whether preference remains after matching.

## Include normalisation

Normalisation is designed to adjust playback or programme gain toward a defined loudness relationship; exact targets, timing, track scope, and user controls depend on implementation. [The normalisation guide](/blog/what-audio-normalization-is-designed-to-do/) separates its goal from compression and volume limiting.

Verify current Norva behavior officially before claiming it applies a specific standard or target.

## Include output sensitivity and room

Headphones and speakers produce different acoustic levels from the same digital or slider setting. Fit, distance, room reflections, background noise, and device processing also affect perception. Do not compare two outputs from identical displayed numbers.

Protect hearing: if detail is audible only at uncomfortable levels, stop and investigate track, output, room noise, or accessibility alternatives.

## Report a level difference

Include track and version, excerpt, all gain stages, normalisation and dynamic processing, valid measurements and scope, output route and device, room, safe match method, perceived result, and unknowns. Current Norva volume and normalisation controls require official verification.

[The complete audio-quality guide](/blog/the-complete-guide-to-understanding-audio-quality/) maps the rest of the chain.

## Common mistakes and limitations

Avoid comparing slider numbers, matching peaks instead of programme context, using phone sound-level apps as calibrated proof, or increasing level until a preferred answer appears. Informal listening is not a formal loudness compliance test.

## Check level after a route change

When switching from speakers to headphones or a receiver, lower the control before playback and re-establish a comfortable safe level. Record the new gain stages rather than copying the previous number. This prevents an output-sensitivity difference from being mistaken for programme loudness and reduces the risk of an unexpectedly loud test.

## Frequently asked questions

### Is volume the same as programme loudness?

No. Volume is a playback gain control; programme loudness is perceived or measured under a defined method.

### Does the same slider value produce the same loudness on two devices?

No. Gain structure, amplifier, output sensitivity, speakers or headphones, room, and processing differ.

### Is peak normalisation the same as loudness normalisation?

No. Peak and loudness measurements describe different properties and support different workflows.

## Your next step

[Explore Norva's playback features](https://norva.tv/#features)

## Sources

- [ITU-R BS.1770: Programme Loudness and True Peak](https://www.itu.int/rec/R-REC-BS.1770/en)
- [EBU R 128: Loudness Normalisation](https://tech.ebu.ch/publications/r128)
- [Norva Features](https://norva.tv/#features)
